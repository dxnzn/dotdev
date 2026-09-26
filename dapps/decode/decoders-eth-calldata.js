window.DxDecode ??= {};
const ethCodecs = window.DxDecode.codecs;
const ethKeccak = window.DxDecode.keccak;
const ethAbi = window.DxDecode.abi;
const ethRegistry = window.DxDecode.registry;
const ethSignatures = window.DxDecode.signatures;
const ethLocalTable = ethSignatures.createLocalSignatureTable();
const ETH_SELECTOR_BYTES = 4;
const ETH_WORD_BYTES = 32;
const ETH_SCORE_RESOLVED = 0.97;
const ETH_SCORE_SHAPED = 0.91;
const ETH_TX_HASH_BYTES = 32;
const ETH_SCORE_TX_HASH = 0.93;
const ETH_SCORE_CREATION_CODE = 0.98;
function ethCanDecode(input) {
  if (!ethCodecs.Hex.isHexLike(input)) return 0;
  const normalized = ethCodecs.Hex.normalize(input);
  if (normalized.length === 0 || normalized.length % 2 !== 0) return 0;
  const byteLength = normalized.length / 2;
  if (byteLength === ETH_TX_HASH_BYTES) return ETH_SCORE_TX_HASH;
  const decoded = ethCodecs.Hex.decode(input);
  if (decoded.ok && window.DxDecode?.creationCode?.looksLikeCreationCode(decoded.bytes) === true) {
    return ETH_SCORE_CREATION_CODE;
  }
  if (byteLength < ETH_SELECTOR_BYTES) return 0;
  if ((byteLength - ETH_SELECTOR_BYTES) % ETH_WORD_BYTES !== 0) return 0;
  const selector = `0x${normalized.slice(0, ETH_SELECTOR_BYTES * 2)}`;
  return ethSignatures.hasLocalSelector(selector) ? ETH_SCORE_RESOLVED : ETH_SCORE_SHAPED;
}
const ETH_LOOKUP_MISS = "no source knows this selector";
const ETH_LOOKUP_UNAVAILABLE = "the label is unavailable because a lookup could not be completed";
function ethFindVerifiedCandidate(candidates, selector) {
  for (const candidate of candidates) {
    const parsed = ethAbi.parseTypeString(candidate.signature);
    if ("error" in parsed) continue;
    if (ethKeccak.selector(ethAbi.canonicalSignature(parsed.name, parsed.types)) === selector) {
      return { name: parsed.name, types: parsed.types, source: candidate.source };
    }
  }
  return null;
}
function ethProvenanceFor(source) {
  return source === "local" ? "local" : "registry";
}
async function ethResolveSelector(selector, ctx, target) {
  const effectiveTarget = target ?? ctx.target;
  if (ctx.abis && effectiveTarget) {
    try {
      const resolved = await ctx.abis.getAbi(effectiveTarget, { signal: ctx.signal });
      if (resolved) {
        for (const item of resolved.abi) {
          if (!item.name) continue;
          const types = ethAbi.parseAbiInputs(item.inputs);
          if (ethKeccak.selector(ethAbi.canonicalSignature(item.name, types)) === selector) {
            return { ok: true, name: item.name, types, provenance: "verified" };
          }
        }
      }
    } catch {
    }
  }
  const localResult = await ethLocalTable.lookup(selector);
  const localHit = ethFindVerifiedCandidate(localResult.candidates, selector);
  if (localHit)
    return { ok: true, name: localHit.name, types: localHit.types, provenance: ethProvenanceFor(localHit.source) };
  if (ctx.signatures) {
    try {
      const registryResult = await ctx.signatures.lookup(selector);
      const registryHit = ethFindVerifiedCandidate(registryResult.candidates, selector);
      if (registryHit) {
        return {
          ok: true,
          name: registryHit.name,
          types: registryHit.types,
          provenance: ethProvenanceFor(registryHit.source)
        };
      }
      return { ok: false, unavailable: registryResult.unavailable, reason: registryResult.reason };
    } catch {
      return { ok: false, unavailable: false };
    }
  }
  return { ok: false, unavailable: false };
}
function ethUnresolvedNode(selectorHex, raw, undecodedBytes, outcome) {
  const reasonMessage = outcome.unavailable ? `${ETH_LOOKUP_UNAVAILABLE}${outcome.reason ? ` (${outcome.reason})` : ""}` : ETH_LOOKUP_MISS;
  return {
    label: "eth-calldata",
    type: "function",
    value: null,
    raw,
    provenance: "unresolved",
    annotations: [
      `selector ${selectorHex} did not resolve \u2014 ${reasonMessage}`,
      `${undecodedBytes} undecoded byte${undecodedBytes === 1 ? "" : "s"}`
    ]
  };
}
const ETH_SHORTEN_HEAD = 8;
const ETH_SHORTEN_TAIL = 6;
function ethShortenValue(full) {
  const minLength = 2 + ETH_SHORTEN_HEAD + ETH_SHORTEN_TAIL;
  if (full.length <= minLength) return full;
  return `${full.slice(0, 2 + ETH_SHORTEN_HEAD)}...${full.slice(-ETH_SHORTEN_TAIL)}`;
}
const ETH_MAGNITUDE_THRESHOLD = 1000000000000000n;
function ethAnnotateMagnitude(node) {
  if (typeof node.value !== "bigint") return;
  const negative = node.value < 0n;
  const magnitude = negative ? -node.value : node.value;
  if (magnitude < ETH_MAGNITUDE_THRESHOLD) return;
  const digits = magnitude.toString();
  const exponent = digits.length - 1;
  const hint = `\u2248 ${negative ? "-" : ""}${digits[0]}e${exponent}`;
  node.annotations = [...node.annotations ?? [], hint];
}
const ETH_ZERO_ADDRESS = `0x${"0".repeat(40)}`;
function ethAnnotateZeroAddress(node, full) {
  if (full !== ETH_ZERO_ADDRESS) return;
  node.annotations = [...node.annotations ?? [], "address(0) \u2014 the zero address / native ETH sentinel"];
}
const ETH_ADDRESS_HEX_RE = /^0x[0-9a-f]{40}$/;
const ETH_WORD_HEX_RE = /^0x[0-9a-f]{64}$/;
function ethAddressNode(node, ctx) {
  const full = node.raw;
  if (typeof full !== "string" || !ETH_ADDRESS_HEX_RE.test(full)) return;
  node.display = "address";
  node.value = ethShortenValue(full);
  ethAnnotateZeroAddress(node, full);
  const link = ctx.links.address(full);
  if (link !== null) {
    node.link = link;
    node.linkKind = "external";
  }
}
function ethWordNode(node, ctx) {
  const full = node.raw;
  if (typeof full !== "string" || !ETH_WORD_HEX_RE.test(full)) return;
  node.display = "txhash";
  node.value = ethShortenValue(full);
  const link = ctx.links.tx(full);
  if (link !== null) {
    node.link = link;
    node.linkKind = "external";
  }
}
function ethDecorateTree(node, ctx) {
  if (node.children) {
    for (const child of node.children) ethDecorateTree(child, ctx);
  }
  if (node.error !== void 0) return;
  if (node.type === "address") {
    ethAddressNode(node, ctx);
  } else if (node.type === "bytes32") {
    ethWordNode(node, ctx);
  } else if (node.type === "string") {
    node.display = "text";
  } else if (typeof node.value === "bigint") {
    ethAnnotateMagnitude(node);
  }
}
const ETH_SETTINGS = [
  {
    key: "etherscanApiKey",
    required: false,
    why: "would let this decoder resolve a verified ABI for a nested call's sibling target, or for a looked-up transaction's own recipient"
  },
  {
    key: "rpcUrl",
    required: false,
    why: "would let this decoder look up a pasted transaction hash directly from your own node"
  }
];
function ethSettingPresent(value) {
  return typeof value === "string" && value.trim().length > 0;
}
function ethProvenanceCeiling(_snapshot, ctx) {
  if (ctx.abis) return "verified";
  if (ctx.signatures) return "registry";
  return "local";
}
function ethSettingRaisesRung(key, snapshot, ctx) {
  if (key === "etherscanApiKey") return ethProvenanceCeiling(snapshot, ctx) === "verified";
  if (key === "rpcUrl") return ctx.txSource !== void 0;
  return false;
}
function ethMissingSettingsNote(snapshot, ctx) {
  const missing = ETH_SETTINGS.filter((spec) => !ethSettingPresent(snapshot[spec.key]));
  if (missing.length === 0) return void 0;
  const parts = missing.map(
    (spec) => ethSettingRaisesRung(spec.key, snapshot, ctx) ? `${spec.key} is not set \u2014 ${spec.why}.` : `${spec.key} is not set \u2014 the value is stored for a feature that is not wired yet (${spec.why}).`
  );
  return parts.join(" ");
}
function ethTxUnavailableNode(raw, reason) {
  const detail = reason ? ` (${reason})` : "";
  return {
    label: "eth-calldata",
    error: `this transaction cannot be looked up${detail} \u2014 configure an RPC endpoint URL or an Etherscan API key to enable it`,
    raw
  };
}
async function ethDecodeTransaction(raw, hashBytes, ctx) {
  const wordTableOutput = (node) => ({ node, rawBytes: hashBytes, rawView: "word-table" });
  if (!ctx.txSource) {
    return wordTableOutput(ethTxUnavailableNode(raw, void 0));
  }
  let result;
  try {
    result = await ctx.txSource.getTransaction(raw, { signal: ctx.signal });
  } catch {
    result = { unavailable: true };
  }
  if (ctx.signal.aborted) {
    return wordTableOutput({ label: "eth-calldata", raw });
  }
  if (result.unavailable) {
    if (result.reason === void 0) {
      return wordTableOutput({
        label: "eth-calldata",
        error: "this transaction was not found \u2014 the hash does not exist on-chain, or is still pending",
        raw
      });
    }
    return wordTableOutput(ethTxUnavailableNode(raw, result.reason));
  }
  const transaction = result.transaction;
  if (!transaction) {
    return wordTableOutput({ label: "eth-calldata", error: "the transaction source returned no transaction", raw });
  }
  if (transaction.to === null) {
    return wordTableOutput({
      label: "eth-calldata",
      error: "this transaction created a contract \u2014 decoding a deploy payload is not something this decoder does",
      raw
    });
  }
  const innerResult = ethCodecs.Hex.decode(transaction.input);
  if (!innerResult.ok) {
    return wordTableOutput({ label: "eth-calldata", error: innerResult.error, raw });
  }
  return ethDecodeCalldataBytes(
    `0x${ethCodecs.Hex.encode(innerResult.bytes, { prefix: false })}`,
    innerResult.bytes,
    ctx,
    transaction.to
  );
}
async function ethDecodeCalldataBytes(raw, bytes, ctx, effectiveTarget) {
  if (bytes.length < ETH_SELECTOR_BYTES) {
    return {
      node: {
        label: "eth-calldata",
        error: `too short to carry a 4-byte selector \u2014 ${bytes.length} byte${bytes.length === 1 ? "" : "s"}`,
        raw
      },
      rawBytes: bytes,
      rawView: "word-table"
    };
  }
  const selectorHex = `0x${ethCodecs.Hex.encode(bytes.slice(0, ETH_SELECTOR_BYTES), { prefix: false })}`;
  const payload = bytes.slice(ETH_SELECTOR_BYTES);
  const outcome = await ethResolveSelector(selectorHex, ctx, effectiveTarget);
  if (!outcome.ok) {
    return {
      node: ethUnresolvedNode(selectorHex, raw, payload.length, outcome),
      rawBytes: bytes,
      rawView: "word-table"
    };
  }
  const decoded = ethAbi.decodeParameters(outcome.types, payload, 0, 0);
  const root = {
    label: outcome.name,
    type: "function",
    value: null,
    raw,
    provenance: outcome.provenance,
    children: decoded.length > 0 ? decoded : void 0
  };
  await window.DxDecode?.annotators?.recurse?.(
    root,
    effectiveTarget,
    (nestedSelector, nestedTarget) => ethResolveSelector(nestedSelector, ctx, nestedTarget)
  );
  ethDecorateTree(root, ctx);
  window.DxDecode?.annotators?.annotateTree?.(root);
  return {
    node: root,
    rawBytes: bytes,
    rawView: "word-table",
    onNodeUpdate: ethStartNameWalk(root, ctx)
  };
}
function ethStartNameWalk(root, ctx) {
  const annotators = window.DxDecode?.annotators;
  if (!ctx.abis || !annotators?.collectAddressNodes || !annotators?.patchContractNames) return void 0;
  const abis = ctx.abis;
  const subscribers = /* @__PURE__ */ new Set();
  void annotators.patchContractNames(
    annotators.collectAddressNodes(root),
    async (address) => {
      const result = await abis.getAbi(address, { signal: ctx.signal });
      return result?.name;
    },
    (node, annotation) => {
      for (const listener of subscribers) listener(node, annotation);
    },
    ctx.signal
  );
  return (listener) => {
    subscribers.add(listener);
    return () => subscribers.delete(listener);
  };
}
async function ethDecodeCore(input, ctx) {
  const result = ethCodecs.Hex.decode(input);
  if (!result.ok) {
    return { node: { label: "eth-calldata", error: result.error, raw: input }, rawBytes: null };
  }
  const { bytes } = result;
  const raw = `0x${ethCodecs.Hex.encode(bytes, { prefix: false })}`;
  if (bytes.length === ETH_TX_HASH_BYTES) {
    return ethDecodeTransaction(raw, bytes, ctx);
  }
  const creationCode = window.DxDecode?.creationCode;
  if (creationCode?.looksLikeCreationCode(bytes) === true) {
    const node = { label: "deploy payload", type: "bytes", raw };
    creationCode.expand(node, bytes);
    ethDecorateTree(node, ctx);
    return { node, rawBytes: bytes, rawView: "hex-dump", onNodeUpdate: ethStartNameWalk(node, ctx) };
  }
  return ethDecodeCalldataBytes(raw, bytes, ctx, ctx.target);
}
async function ethDecode(input, ctx) {
  const settingsNote = ethMissingSettingsNote(ctx.settings, ctx);
  const output = await ethDecodeCore(input, ctx);
  if (settingsNote) {
    output.node.warning = output.node.warning ? `${output.node.warning} ${settingsNote}` : settingsNote;
    if (ctx.settingsRoute) {
      output.node.link = ctx.settingsRoute;
      output.node.linkKind = "route";
    }
  }
  return output;
}
const ethCalldataDecoder = {
  id: "eth-calldata",
  // test/decode-registry.test.ts's own portability check scans every .ts source file in this
  // directory for a longer spelling of this chain's name (case-insensitive), guarding against
  // this dapp naming the shell's specific credentials plugin/settings-section — so the label
  // below deliberately uses the shorter, ticker-style form instead.
  label: "ETH calldata",
  // D-29: both required: false — 01 D-29 established that no credential is required, which is
  // exactly why the degraded local-table-only path is the common path for a first-time visitor.
  settings: ETH_SETTINGS,
  canDecode: ethCanDecode,
  decode: ethDecode
};
ethRegistry.register(ethCalldataDecoder);
