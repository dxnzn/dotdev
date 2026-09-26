window.DxDecode ??= {};
const annCodecs = window.DxDecode.codecs;
const annAbi = window.DxDecode.abi;
const annCreationCode = () => window.DxDecode?.creationCode;
const ANN_MAX_DEPTH = 16;
const ANN_MAX_NODES = 5e3;
const ANN_MAX_BYTES = 2 * 1024 * 1024;
const ANN_SELECTOR_BYTES = 4;
const ANN_WORD_BYTES = 32;
const ANN_ADDRESS_HEX_RE = /^0x[0-9a-f]{40}$/;
function annCountNodes(node) {
  let count = 1;
  if (node.children) {
    for (const child of node.children) count += annCountNodes(child);
  }
  return count;
}
function annCountNodeList(nodes) {
  let total = 0;
  for (const node of nodes) total += annCountNodes(node);
  return total;
}
function annBoundMessage(kind, depth, nodesUsed, bytesUsed) {
  return `nested decode stopped \u2014 ${kind} bound reached (depth ${depth} of max ${ANN_MAX_DEPTH}, ${nodesUsed} of max ${ANN_MAX_NODES} nodes, ${bytesUsed} of max ${ANN_MAX_BYTES} bytes) \u2014 the candidate was NOT EXAMINED`;
}
function annBudgetUsed(budget) {
  return {
    nodesUsed: ANN_MAX_NODES - budget.nodesRemaining,
    bytesUsed: ANN_MAX_BYTES - budget.bytesRemaining
  };
}
function annSeedBudget(root) {
  const rootCount = annCountNodes(root);
  if (rootCount >= ANN_MAX_NODES) {
    root.warning = annBoundMessage("nodes", 0, rootCount, 0);
    return { nodesRemaining: 0, bytesRemaining: ANN_MAX_BYTES };
  }
  return { nodesRemaining: ANN_MAX_NODES - rootCount, bytesRemaining: ANN_MAX_BYTES };
}
function annNearestPrecedingAddress(siblings, bytesIndex) {
  for (let i = bytesIndex - 1; i >= 0; i--) {
    const candidate = siblings[i];
    if (candidate.type === "address" && typeof candidate.raw === "string" && ANN_ADDRESS_HEX_RE.test(candidate.raw)) {
      return candidate.raw;
    }
  }
  return void 0;
}
async function annTryGraft(node, target, depth, resolve, budget) {
  if (typeof node.raw !== "string") return;
  const decoded = annCodecs.Hex.decode(node.raw);
  if (!decoded.ok) return;
  const byteLength = decoded.bytes.length;
  const creationCode = annCreationCode();
  const isCreationCode = creationCode?.looksLikeCreationCode(decoded.bytes) === true;
  if (!isCreationCode && (byteLength < ANN_SELECTOR_BYTES || (byteLength - ANN_SELECTOR_BYTES) % ANN_WORD_BYTES !== 0)) {
    return;
  }
  if (depth >= ANN_MAX_DEPTH) {
    const used = annBudgetUsed(budget);
    node.warning = annBoundMessage("depth", depth, used.nodesUsed, used.bytesUsed);
    return;
  }
  if (byteLength > budget.bytesRemaining) {
    const used = annBudgetUsed(budget);
    node.warning = annBoundMessage("bytes", depth, used.nodesUsed, used.bytesUsed);
    return;
  }
  if (budget.nodesRemaining <= 0) {
    const used = annBudgetUsed(budget);
    node.warning = annBoundMessage("nodes", depth, used.nodesUsed, used.bytesUsed);
    return;
  }
  if (isCreationCode && creationCode?.expand(node, decoded.bytes) === true) {
    const added = annCountNodeList(node.children ?? []);
    if (added > budget.nodesRemaining) {
      delete node.children;
      const used = annBudgetUsed(budget);
      node.warning = annBoundMessage("nodes", depth, used.nodesUsed, used.bytesUsed);
      return;
    }
    budget.nodesRemaining -= added;
    budget.bytesRemaining -= byteLength;
    return;
  }
  const selectorHex = `0x${annCodecs.Hex.encode(decoded.bytes.slice(0, ANN_SELECTOR_BYTES), { prefix: false })}`;
  const outcome = await resolve(selectorHex, target);
  if (!outcome.ok) {
    if (outcome.unavailable) {
      node.annotations = [
        ...node.annotations ?? [],
        `selector ${selectorHex} did not resolve \u2014 the label is unavailable because a lookup could not be completed${outcome.reason ? ` (${outcome.reason})` : ""}`
      ];
    }
    return;
  }
  const payload = decoded.bytes.slice(ANN_SELECTOR_BYTES);
  const children = annAbi.decodeParameters(outcome.types, payload, 0, 0);
  const graftedCount = annCountNodeList(children);
  if (graftedCount > budget.nodesRemaining) {
    const used = annBudgetUsed(budget);
    node.warning = annBoundMessage("nodes", depth, used.nodesUsed, used.bytesUsed);
    return;
  }
  const formerLabel = node.label;
  const formerType = node.type;
  node.label = outcome.name;
  node.type = "function";
  node.value = null;
  if (children.length > 0) {
    node.children = children;
  } else {
    delete node.children;
  }
  node.provenance = outcome.provenance;
  node.annotations = [
    ...node.annotations ?? [],
    `formerly \`${formerLabel}\` (${formerType ?? "unknown"}) \u2014 re-identified as a nested call`
  ];
  budget.nodesRemaining -= graftedCount;
  budget.bytesRemaining -= byteLength;
  await annWalkNode(node, target, depth + 1, resolve, budget);
}
async function annWalkNode(node, target, depth, resolve, budget) {
  if (node.children) {
    const siblings = node.children;
    for (let i = 0; i < siblings.length; i++) {
      const childTarget = annNearestPrecedingAddress(siblings, i) ?? target;
      await annWalkNode(siblings[i], childTarget, depth, resolve, budget);
    }
  }
  if (node.type === "bytes" && node.error === void 0) {
    await annTryGraft(node, target, depth, resolve, budget);
  }
}
async function annRecurse(root, target, resolve, budget = annSeedBudget(root)) {
  if (budget.nodesRemaining <= 0) return;
  await annWalkNode(root, target, 0, resolve, budget);
}
const ANN_OP_ARGUMENT_INDEX = {
  executeByVotes: 0,
  setPermit: 0,
  spendPermit: 0,
  execTransaction: 3
};
const ANN_OP_CALL_ANNOTATION = "(call)";
function annOpDelegatecallWarning() {
  return "DELEGATECALL \u2014 runs target code using the caller's own state";
}
function annOpUnrecognisedWarning(raw) {
  return `unrecognised operation (raw value ${raw.toString()}) \u2014 not modelled by this decoder`;
}
function annAnnotateOp(node) {
  if (node.type !== "function" || !node.children) return;
  const annotated = /* @__PURE__ */ new Set();
  const positionalIndex = ANN_OP_ARGUMENT_INDEX[node.label];
  if (positionalIndex !== void 0) {
    const candidate = node.children[positionalIndex];
    if (candidate && candidate.type === "uint8") {
      annOpAnnotateArgument(candidate);
      annotated.add(candidate);
    }
  }
  for (const child of node.children) {
    if (annotated.has(child)) continue;
    if ((child.label === "op" || child.label === "operation") && child.type === "uint8") {
      annOpAnnotateArgument(child);
    }
  }
}
function annOpAnnotateArgument(node) {
  if (typeof node.value !== "bigint") return;
  if (node.value === 0n) {
    node.annotations = [...node.annotations ?? [], ANN_OP_CALL_ANNOTATION];
  } else if (node.value === 1n) {
    node.warning = annOpDelegatecallWarning();
  } else {
    node.warning = annOpUnrecognisedWarning(node.value);
  }
}
function annAnnotateTree(root) {
  if (root.children) {
    for (const child of root.children) annAnnotateTree(child);
  }
  annAnnotateOp(root);
}
const ANN_ZERO_ADDRESS = `0x${"0".repeat(40)}`;
function annCollectAddressNodes(root) {
  const byAddress = /* @__PURE__ */ new Map();
  function walk(node) {
    if (node.children) {
      for (const child of node.children) walk(child);
    }
    if (node.display !== "address" || typeof node.raw !== "string") return;
    if (node.raw === ANN_ZERO_ADDRESS) return;
    const existing = byAddress.get(node.raw);
    if (existing) {
      existing.push(node);
    } else {
      byAddress.set(node.raw, [node]);
    }
  }
  walk(root);
  return byAddress;
}
async function annPatchContractNames(nodesByAddress, lookup, notify, signal) {
  await Promise.all(
    Array.from(nodesByAddress.entries()).map(async ([address, nodes]) => {
      if (signal.aborted) return;
      let name;
      try {
        name = await lookup(address);
      } catch {
        return;
      }
      if (signal.aborted) return;
      if (typeof name !== "string" || name.trim().length === 0) return;
      const annotation = `(${name})`;
      for (const node of nodes) {
        node.annotations = [...node.annotations ?? [], annotation];
        notify(node, annotation);
      }
    })
  );
}
const annotatorsModule = {
  recurse: annRecurse,
  annotateTree: annAnnotateTree,
  annotateOp: annAnnotateOp,
  collectAddressNodes: annCollectAddressNodes,
  patchContractNames: annPatchContractNames,
  ANN_MAX_DEPTH,
  ANN_MAX_NODES,
  ANN_MAX_BYTES
};
window.DxDecode.annotators = annotatorsModule;
