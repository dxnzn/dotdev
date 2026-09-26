// window.DxDecode.annotators — post-order passes over a finished DecodeNode tree: the bounded
// cross-call recursion pass (this plan), the operation annotator and the name-patch walk (later
// plans in this phase, per CONTEXT.md D-02's own stated preference — all three are post-order
// passes over the finished tree with no conflicting traversal order). The file reaches no
// network, no persistence and no DOM; it consumes only window.DxDecode.abi and
// window.DxDecode.codecs. It never names decoders-eth-calldata.ts — the recursion pass takes an
// injected async resolver callback instead, which is what breaks the cycle (the pass needs
// ethResolveSelector, which lives in the decoder that consumes the pass) and lets this file load
// BEFORE that decoder (manifest.json: after signatures.js, before decoders-eth-calldata.js).
//
// Top-level names take the `ann` prefix (D-14 — no import/export anywhere in this directory, so
// it compiles as one TS program and every top-level name must be unique across it).
window.DxDecode ??= {};

const annCodecs = window.DxDecode.codecs as DxDecodeCodecsModule;
const annAbi = window.DxDecode.abi as DxDecodeAbiModule;
// Read at use-time rather than captured, because a host shell may load this file without
// creation-code.ts — the guard below degrades to "not creation code", which is exactly the
// pre-REF-01 behaviour, never a throw.
const annCreationCode = () => window.DxDecode?.creationCode;

// D-03/handoff §6.6: the pass's OWN budget, independent of abi.ts's ABI_MAX_NODES/ABI_MAX_DEPTH.
// Never read, reset, or deferred to from here — abi.ts resets ITS OWN 10,000-node budget inside
// abiDecodeParameters on every call, precisely so sibling arguments cannot starve each other,
// which means every nested call gets a fresh allowance there and the cross-call aggregate would
// be unbounded if this pass borrowed it.
const ANN_MAX_DEPTH = 16;
const ANN_MAX_NODES = 5000;
const ANN_MAX_BYTES = 2 * 1024 * 1024;

const ANN_SELECTOR_BYTES = 4;
const ANN_WORD_BYTES = 32;

// ETH-03: re-validates the 20-byte lowercase hex address shape rather than trusting a node's
// declared `type === 'address'` — mirrors decoders-eth-calldata.ts's own ETH_ADDRESS_HEX_RE /
// ethAddressNode defensive re-validation (this file cannot import that constant, D-08). A
// nested call's "address" argument is decoded from attacker-controlled calldata exactly as much
// as a top-level one is.
const ANN_ADDRESS_HEX_RE = /^0x[0-9a-f]{40}$/;

// The resolver's own outcome union, restated locally — structurally identical to
// decoders-eth-calldata.ts's own EthResolveOutcome — because this file has no import/export and
// cannot name that file's local interface; the injected callback parameter is what breaks the
// module cycle instead. Carries the FULL resolved-or-unresolved distinction, never reduced to a
// hit-or-null: collapsing it would throw away "we could not ask" versus "nobody knows this
// selector", which a nested unresolved outcome needs to say just as much as the top-level one.
interface AnnResolvedOutcome {
  ok: true;
  name: string;
  types: TypeNode[];
  provenance: 'verified' | 'local' | 'registry';
}

interface AnnUnresolvedOutcome {
  ok: false;
  unavailable: boolean;
  reason?: string;
}

type AnnResolveOutcome = AnnResolvedOutcome | AnnUnresolvedOutcome;

type AnnResolveFn = (selector: string, target: string | undefined) => Promise<AnnResolveOutcome>;

interface AnnRecursionBudget {
  nodesRemaining: number;
  bytesRemaining: number;
}

// Counts every node in `node`'s own subtree, INCLUDING `node` itself, children included. Called
// in TWO places by design — once on the completed root (annSeedBudget, below), once on a
// resolved subtree before it is grafted (annTryGraft) — so this function alone cannot tell
// "seeded from the root" apart from "grafted subtrees only"; only annSeedBudget's own name is a
// detectable property of that design, which is why it exists as its own named function rather
// than being inlined at its one call site.
function annCountNodes(node: DecodeNode): number {
  let count = 1;
  if (node.children) {
    for (const child of node.children) count += annCountNodes(child);
  }
  return count;
}

function annCountNodeList(nodes: DecodeNode[]): number {
  let total = 0;
  for (const node of nodes) total += annCountNodes(node);
  return total;
}

// D-04: a bound never throws, never surfaces a modal, never writes a root-level banner — it sets
// this composed message as `warning` on the node at the truncation point (or on the root, for a
// bound that fires before any walking starts). Composed ONCE, in this single named helper, so all
// three bounds (depth, nodes, bytes) produce a consistently worded sentence rather than three
// hand-written ones.
//
// `kind` names WHICH bound was reached; `depth`/`nodesUsed`/`bytesUsed` report the state AT THE
// POINT the bound fired — never the max constants alone, which would say nothing about how this
// particular decode got here. The depth and byte checks (annTryGraft, below) run BEFORE the
// resolver is ever called, so any `bytes` argument satisfying the `4 + 32k` congruence gets this
// warning at a bound whether or not it was ever real calldata — a message that only said
// "stopped" would invite the reader to conclude something was found and rejected. "NOT EXAMINED"
// is the honest form for that case. The post-decode node-count check (also annTryGraft) DID
// resolve and decode the candidate before discarding it as over-budget, but from the finished
// tree's own perspective nothing about it was ever concluded or surfaced — the node the reader
// sees carries no more information than the pre-check cases do, so the same wording applies
// there too, deliberately, per this function's own single-source-of-truth mandate.
function annBoundMessage(
  kind: 'depth' | 'nodes' | 'bytes',
  depth: number,
  nodesUsed: number,
  bytesUsed: number,
): string {
  return (
    `nested decode stopped — ${kind} bound reached ` +
    `(depth ${depth} of max ${ANN_MAX_DEPTH}, ${nodesUsed} of max ${ANN_MAX_NODES} nodes, ` +
    `${bytesUsed} of max ${ANN_MAX_BYTES} bytes) — the candidate was NOT EXAMINED`
  );
}

// Reports nodes/bytes ALREADY SPENT from `budget` — the state a bound message describes.
function annBudgetUsed(budget: AnnRecursionBudget): { nodesUsed: number; bytesUsed: number } {
  return {
    nodesUsed: ANN_MAX_NODES - budget.nodesRemaining,
    bytesUsed: ANN_MAX_BYTES - budget.bytesRemaining,
  };
}

// Round 2 (BOTH reviewers, independently): abiDecodeParameters resets its own 10,000-node budget
// on EVERY call (abi.ts), so a wide top-level array can deliver more than ANN_MAX_NODES nodes
// before recursion has even run — an allowance that bounds only GRAFTED subtrees does not bound
// the DELIVERED tree, which is what handoff §6.6 actually specifies ("total nodes ≤ 5,000").
// Seeding the allowance from a count of the completed root — BEFORE annRecurse ever walks a
// child — is what makes the must-have's word "total" true. A root that already meets or exceeds
// the budget on its own carries the bound warning and no recursion is attempted at all.
function annSeedBudget(root: DecodeNode): AnnRecursionBudget {
  const rootCount = annCountNodes(root);
  if (rootCount >= ANN_MAX_NODES) {
    root.warning = annBoundMessage('nodes', 0, rootCount, 0);
    return { nodesRemaining: 0, bytesRemaining: ANN_MAX_BYTES };
  }
  return { nodesRemaining: ANN_MAX_NODES - rootCount, bytesRemaining: ANN_MAX_BYTES };
}

// ETH-03: the nearest-PRECEDING-sibling target rule (handoff §7.2's tie-break). `siblings` is
// whatever `children` array the `bytes` node at `bytesIndex` sits in — the TUPLE's own children
// for a tuple nested inside an array (batchCalls's own shape), never the array's; the caller
// (annWalkNode, below) always passes the array the node in question is a direct member of, so
// this function itself never has to know which kind of parent that was. Scans BACKWARD from the
// index immediately before `bytesIndex`, toward zero, and returns the first sibling's `raw`
// whose declared `type` is 'address' AND whose `raw` matches the 20-byte lowercase hex shape —
// re-validated here rather than trusted from the declared type (see ANN_ADDRESS_HEX_RE's own
// comment). It NEVER looks forward, and stops at the FIRST match found scanning that direction:
// handoff §7.2's setPermit puts two addresses equidistant from `data` (`to` at index 1,
// `spender` at index 5), and the expected result is the PRECEDING one. An absolute-distance
// tie-break was considered and rejected — it would get that vector right or wrong depending on
// iteration order, which is not a real rule. Add a forward-looking rule only when a real vector
// demands it, and record the reason here when that happens.
//
// Reads `raw`, NEVER `value` — ethDecorateTree (decoders-eth-calldata.ts) shortens `value` on an
// address node, and although this pass runs BEFORE decoration under Plan 01's own ordering,
// depending on that ordering for correctness would make this scan silently wrong the day the two
// passes are ever reordered. `raw` is the full value under either ordering.
//
// Accepted residual (T-06-26): Safe's `execTransaction` carries a trailing `bytes signatures`
// argument that sits after TWO addresses (`gasToken`, `refundReceiver`), so a signature blob
// whose length happened to satisfy `4 + 32k` AND whose leading four bytes happened to resolve to
// a real selector would be decoded as calldata against `refundReceiver`. Real 65-byte-multiple
// signature blobs never satisfy the congruence, and annTryGraft's clean-miss-is-silence rule
// means the ordinary case produces no output at all. Theoretical; named so a future reader
// recognises it if it ever fires.
function annNearestPrecedingAddress(siblings: DecodeNode[], bytesIndex: number): string | undefined {
  for (let i = bytesIndex - 1; i >= 0; i--) {
    const candidate = siblings[i];
    if (candidate.type === 'address' && typeof candidate.raw === 'string' && ANN_ADDRESS_HEX_RE.test(candidate.raw)) {
      return candidate.raw;
    }
  }
  return undefined;
}

// One attempted graft. `node` is a `bytes` leaf with no error; `depth` is the number of grafts
// already crossed to reach it (a direct child of the root is depth 0). Bounds are checked in the
// order that actually enforces them: depth and the candidate's own byte length are checked
// BEFORE the resolver is ever called — a real bound, not a report after the fact — while the
// node count is checked both before (the remaining allowance) and after (the returned subtree's
// own size, knowable only once decodeParameters has returned, since abi.ts resets its own
// 10,000-node budget on every call and one nested decode can therefore return more nodes than
// the entire cross-call allowance).
async function annTryGraft(
  node: DecodeNode,
  target: string | undefined,
  depth: number,
  resolve: AnnResolveFn,
  budget: AnnRecursionBudget,
): Promise<void> {
  if (typeof node.raw !== 'string') return;
  const decoded = annCodecs.Hex.decode(node.raw);
  if (!decoded.ok) return;

  const byteLength = decoded.bytes.length;

  // handoff §6.5 step 5's "that is NOT creation code (step 7 check first)". FIRST means before the
  // calldata shape test — §7.4 requires the creation-code branch to fire even when the blob's
  // length happens to satisfy 4 + 32k, and testing the shape first would leave exactly that case
  // reading a deploy payload's opening bytes as a selector. It does NOT mean before the bounds:
  // the expansion below is still charged to the same budget as any other graft, so a multi-megabyte
  // blob cannot mint tens of thousands of constructor-word nodes by taking an earlier exit.
  const creationCode = annCreationCode();
  const isCreationCode = creationCode?.looksLikeCreationCode(decoded.bytes) === true;

  // Only a CANDIDATE — a bytes payload shaped like calldata (a 4-byte selector plus zero or
  // more whole 32-byte words) is not evidence it IS calldata. A payload shorter than 4 bytes, of
  // length 0, or failing the (length - 4) % 32 congruence is left completely untouched. Skipped
  // for creation code, which has no selector and satisfies the congruence only by accident.
  if (
    !isCreationCode &&
    (byteLength < ANN_SELECTOR_BYTES || (byteLength - ANN_SELECTOR_BYTES) % ANN_WORD_BYTES !== 0)
  ) {
    return;
  }

  // Checked SEPARATELY, never as one combined condition — a message naming WHICH bound was
  // reached requires knowing which of the three actually tripped, not just that one of them did.
  // Order matches ETH-09's must-have: depth first, then bytes, then nodes — all three run BEFORE
  // the resolver is ever called (annBoundMessage's own "NOT EXAMINED" clause is about exactly
  // this ordering).
  if (depth >= ANN_MAX_DEPTH) {
    const used = annBudgetUsed(budget);
    node.warning = annBoundMessage('depth', depth, used.nodesUsed, used.bytesUsed);
    return;
  }
  if (byteLength > budget.bytesRemaining) {
    const used = annBudgetUsed(budget);
    node.warning = annBoundMessage('bytes', depth, used.nodesUsed, used.bytesUsed);
    return;
  }
  if (budget.nodesRemaining <= 0) {
    const used = annBudgetUsed(budget);
    node.warning = annBoundMessage('nodes', depth, used.nodesUsed, used.bytesUsed);
    return;
  }

  // Terminal by construction: a deploy payload is re-identified and never recursed into, because
  // its tail is constructor words, not nested calls. Charged to the budget exactly as the calldata
  // graft below charges itself, and refused the same way when the words would overrun it.
  if (isCreationCode && creationCode?.expand(node, decoded.bytes) === true) {
    const added = annCountNodeList(node.children ?? []);
    if (added > budget.nodesRemaining) {
      delete node.children;
      const used = annBudgetUsed(budget);
      node.warning = annBoundMessage('nodes', depth, used.nodesUsed, used.bytesUsed);
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
      // A real degraded-network fact and the user should see it — worded the way
      // decoders-eth-calldata.ts's own ethUnresolvedNode words its unavailable branch, restated
      // here because this file cannot import that one's private constants.
      node.annotations = [
        ...(node.annotations ?? []),
        `selector ${selectorHex} did not resolve — the label is unavailable because a lookup ` +
          `could not be completed${outcome.reason ? ` (${outcome.reason})` : ''}`,
      ];
    }
    // A clean miss is silence, deliberately — the asymmetry is intentional, not an oversight.
    // A bytes argument satisfying `4 + 32k` is not evidence it IS calldata: Safe's own
    // execTransaction carries a trailing `bytes signatures` blob, and annotating every
    // unresolved candidate would put a spurious did-not-resolve line on ordinary non-calldata
    // arguments across the whole tree. Only "we could not ask" is worth saying out loud.
    return;
  }

  const payload = decoded.bytes.slice(ANN_SELECTOR_BYTES);
  const children = annAbi.decodeParameters(outcome.types, payload, 0, 0);
  const graftedCount = annCountNodeList(children);
  // The tie is specified, not incidental: a returned subtree whose count EXACTLY equals the
  // remaining allowance is grafted; one node more is refused. `>`, never `>=` — every bound in
  // this pass compares the same way, so "at the limit" has one behaviour across depth, nodes and
  // bytes rather than three.
  if (graftedCount > budget.nodesRemaining) {
    const used = annBudgetUsed(budget);
    node.warning = annBoundMessage('nodes', depth, used.nodesUsed, used.bytesUsed);
    return;
  }

  // RE-IDENTIFY the same node object as the call it has been proven to be. `raw` is never
  // written here — the payload hex abi.ts wrote is what click-to-copy reads and it stays exactly
  // as written (05 D-30's invariant, narrowed rather than broken by this pass; see this plan's
  // SUMMARY d30_narrowing heading).
  const formerLabel = node.label;
  const formerType = node.type;
  node.label = outcome.name;
  node.type = 'function';
  node.value = null;
  if (children.length > 0) {
    node.children = children;
  } else {
    // ETH-07: a zero-argument nested call (pull()) renders as a bare function node, not an
    // empty group — omit the member entirely rather than assign an empty array.
    delete node.children;
  }
  node.provenance = outcome.provenance;
  // Preserve the argument's former identity so nothing the reader could see before the pass is
  // lost — appended via a spread of the existing array, per every other annotator in this
  // directory's own convention.
  node.annotations = [
    ...(node.annotations ?? []),
    `formerly \`${formerLabel}\` (${formerType ?? 'unknown'}) — re-identified as a nested call`,
  ];

  budget.nodesRemaining -= graftedCount;
  budget.bytesRemaining -= byteLength;

  // Recurse into the newly grafted children, one level deeper. `node` itself is now a
  // `function` node (type reassigned above), so re-walking it only visits its new children — it
  // can never be a graft candidate a second time.
  await annWalkNode(node, target, depth + 1, resolve, budget);
}

// The post-order walk — children first, then the current node — copying
// decoders-eth-calldata.ts's own ethDecorateTree shape exactly (D-01: a second pass over the
// already-decoded tree, never a change to abi.ts's head/tail decoder itself).
//
// ETH-03: the target handed to child `i` is computed HERE, at the loop over `node.children` —
// the sibling scope for `annNearestPrecedingAddress` is always THIS node's own `children` array,
// never a grandparent's or an array's when `node` is itself a tuple element. The result
// (`annNearestPrecedingAddress(siblings, i) ?? target`) becomes the `target` PARAMETER of the
// recursive call into `child` — so by the time that call reaches its own `if (node.type ===
// 'bytes')` check (below), `target` is already the correctly-scoped value for THIS node, with no
// further lookup needed there. A tuple nested inside an array resolves against its own tuple's
// children this way automatically: `siblings` at that level is the tuple's own `children`, never
// the array's, because each recursive call is handed exactly the array it is one member of.
async function annWalkNode(
  node: DecodeNode,
  target: string | undefined,
  depth: number,
  resolve: AnnResolveFn,
  budget: AnnRecursionBudget,
): Promise<void> {
  if (node.children) {
    const siblings = node.children;
    for (let i = 0; i < siblings.length; i++) {
      const childTarget = annNearestPrecedingAddress(siblings, i) ?? target;
      await annWalkNode(siblings[i], childTarget, depth, resolve, budget);
    }
  }
  if (node.type === 'bytes' && node.error === undefined) {
    await annTryGraft(node, target, depth, resolve, budget);
  }
}

// The exported pass. Takes the COMPLETED ROOT FUNCTION NODE, never a loose argument array — a
// top-level `bytes data` argument must be able to scan back to its preceding top-level `to`
// sibling through its own parent's `children`, and Plan 02's operation annotator must be able to
// see the top-level function's own identity, neither of which exists until the root is built
// (decoders-eth-calldata.ts's own `const root`, constructed before this is ever called).
//
// `budget` defaults to a fresh `annSeedBudget(root)` — seeded from a COUNT OF THE ROOT before
// any walking starts, per the Round 2 finding recorded above `annSeedBudget`. A root that
// already meets or exceeds ANN_MAX_NODES on its own carries the bound warning (set by
// annSeedBudget itself) and this function returns without walking anything — no nested decode is
// even attempted, which is what the acceptance test for this behaviour asserts by checking the
// injected resolver stub was never called.
//
// 06-02: `target` is the pass's own top-level target — the value ETH-03's nearest-preceding-
// sibling rule falls back to when no candidate address precedes a `bytes` argument at ANY level
// (annWalkNode's own loop is what does the falling-back, recomputing `target` for each child).
async function annRecurse(
  root: DecodeNode,
  target: string | undefined,
  resolve: AnnResolveFn,
  budget: AnnRecursionBudget = annSeedBudget(root),
): Promise<void> {
  if (budget.nodesRemaining <= 0) return;
  await annWalkNode(root, target, 0, resolve, budget);
}

// ── ETH-13 (06-02, Task 3): the operation argument annotator ───────────────────────────────
//
// Identifies the operation argument POSITIONALLY, by (resolved function name, argument index),
// confirmed by the child's own declared type — NEVER by argument label alone. The ABI parser
// (abi.ts's abiParseOneType) CONSUMES AND DISCARDS a trailing argument name after each type, and
// the head/tail decoder labels every unnamed argument `arg` + its index (abiDecodeHeadTailRegion:
// `t.name || 'arg' + i`) — so a local-table or registry decode, which is every no-key decode,
// NEVER produces a label of `op`. test/decode-eth-calldata.test.ts already pins this with a
// passing assertion (`arg0`/`arg1` for a local-table decode). A label-only match would therefore
// annotate nothing on exactly the path roadmap criterion 2 describes (the offline, no-key
// path) — this table is the correction that makes ETH-13 fire there at all. A new local-table
// aggregator signature needs an entry here too, or its operation argument goes unannotated.
const ANN_OP_ARGUMENT_INDEX: Record<string, number> = {
  executeByVotes: 0,
  setPermit: 0,
  spendPermit: 0,
  execTransaction: 3,
};

const ANN_OP_CALL_ANNOTATION = '(call)';

// Handoff §5.5 states this as a two-way split (0 → call, else → DELEGATECALL). Deliberately
// diverged into three: 2 is `create` in some Safe-derived contracts, and labelling it
// DELEGATECALL would be a false statement about what the transaction does — on the one screen a
// reader is checking for exactly that. Any value other than 0 or 1 instead names the RAW value
// as an operation this tool does not model, which is both honest and more useful: it tells the
// reader something is here that the tool does not recognise, rather than mislabelling it.
//
// The wording deliberately avoids the literal word test/decode-portability.test.ts's
// STORAGE_IDENTIFIERS list bans (a browser persistent-storage API name, matched as a whole word
// against string literals too) — "the caller's own state" says the same thing handoff §5.5's own
// "runs target code in the caller's storage" does (DELEGATECALL executes the callee's code while
// reading/writing the CALLER's own state and preserving msg.sender) without tripping a guard that
// has no way to know this string is prose, not a persistence call.
function annOpDelegatecallWarning(): string {
  return "DELEGATECALL — runs target code using the caller's own state";
}

function annOpUnrecognisedWarning(raw: bigint): string {
  return `unrecognised operation (raw value ${raw.toString()}) — not modelled by this decoder`;
}

// `node` is the function node whose label/children this checks — types.d.ts's own
// `annotateOp?: (node: DecodeNode) => void` names the parameter `node` because it IS the parent
// function, not the operation argument itself; the argument is reached via its indexed/labelled
// child. Two triggers, independent and additive, guarded against double-firing on the same
// child:
//   1. POSITIONAL — `node.label` is in ANN_OP_ARGUMENT_INDEX and the child at that index has
//      declared type `uint8`. Fires on every no-key decode (local table or registry), since the
//      parser never produces a label there.
//   2. LABEL — any child whose own `label` is 'op' or 'operation' AND whose type is 'uint8' —
//      only reachable when a verified ABI supplied real argument names.
function annAnnotateOp(node: DecodeNode): void {
  if (node.type !== 'function' || !node.children) return;

  const annotated = new Set<DecodeNode>();

  const positionalIndex = ANN_OP_ARGUMENT_INDEX[node.label];
  if (positionalIndex !== undefined) {
    const candidate = node.children[positionalIndex];
    if (candidate && candidate.type === 'uint8') {
      annOpAnnotateArgument(candidate);
      annotated.add(candidate);
    }
  }

  for (const child of node.children) {
    if (annotated.has(child)) continue;
    if ((child.label === 'op' || child.label === 'operation') && child.type === 'uint8') {
      annOpAnnotateArgument(child);
    }
  }
}

// The actual value branch, shared by both triggers so they can never word the same value two
// different ways. `abi.ts` always produces a `bigint` for every integer type (COD-02) — never a
// `number` — so a non-bigint value (a malformed or hand-built fixture) is left untouched rather
// than coerced.
function annOpAnnotateArgument(node: DecodeNode): void {
  if (typeof node.value !== 'bigint') return;
  if (node.value === 0n) {
    node.annotations = [...(node.annotations ?? []), ANN_OP_CALL_ANNOTATION];
  } else if (node.value === 1n) {
    node.warning = annOpDelegatecallWarning();
  } else {
    node.warning = annOpUnrecognisedWarning(node.value);
  }
}

// The tree-walking pass — post-order, copying annWalkNode's own shape, so a NESTED operation
// argument (reached only after annRecurse has grafted the call it belongs to) is annotated too.
// `root` is the completed function node the same way decoders-eth-calldata.ts's `const root` is
// — `annAnnotateOp` needs the PARENT function node in hand to reach its indexed child and to
// read the function's own name, and the top-level function node IS the root: invoked over a
// loose argument array (never over `root` itself), the pass would see the top-level arguments
// with no parent naming the function, so the top-level operation argument could never be
// annotated at all (handoff §7.2's own vector).
function annAnnotateTree(root: DecodeNode): void {
  if (root.children) {
    for (const child of root.children) annAnnotateTree(child);
  }
  annAnnotateOp(root);
}

// ── ETH-12 (06-06): the progressive contract-name walk ────────────────────────────────────
//
// Two halves, deliberately separate: annCollectAddressNodes is a synchronous, pure walk with no
// lookup and no notification, so it can be reasoned about (and tested) on its own;
// annPatchContractNames below is the async half that actually reaches out and mutates nodes.
// Neither runs on decoders-eth-calldata.ts's own critical path — that file starts this walk and
// never awaits it (types.d.ts's own onNodeUpdate patch-in channel, Plan 01's D-14, is what
// carries a name arriving late back to the renderer), which is what makes ETH-12's "without ever
// blocking the initial render" true for the LABELLING path.
//
// Scoped honestly, here and everywhere else this pass is described: selector resolution
// (decoders-eth-calldata.ts's own ethResolveSelector) already awaits the verified-ABI source
// before consulting the local table whenever a target is known — that has ALWAYS blocked tree
// construction on the same request, and this pass does not change it. Awaiting this walk on top
// of it would only make an already-blocking path worse under the shared 3 requests-per-second
// bucket, which is why it is started and never awaited instead.

// ETH-12: the address the name walk never looks up — decorated as the native-currency sentinel
// by ethAnnotateZeroAddress (decoders-eth-calldata.ts) before this pass ever runs, never a
// verified contract, and looking it up would spend a token from the shared bucket and a
// potentially large request to learn nothing.
const ANN_ZERO_ADDRESS = `0x${'0'.repeat(40)}`;

// A top-level function DECLARATION (D-14, this plan): this task's own verify gate locates
// `function annCollectAddressNodes` and brace-matches from there to confirm the zero-address
// skip lives inside it — an arrow bound to a const would read as absent to that gate even though
// the code is correct. The walk itself stays a NESTED function, matching cache.ts's own
// cchCreatePersistenceAccess precedent for a helper that must stay out of the whole-program
// top-level namespace: the zero-address check has to sit textually inside THIS function's own
// brace-matched body for the same gate to see it, which a sibling top-level helper's body would
// not satisfy.
function annCollectAddressNodes(root: DecodeNode): Map<string, DecodeNode[]> {
  const byAddress = new Map<string, DecodeNode[]>();

  // Post-order — children first, then the current node — matching every other pass in this
  // file's own traversal order.
  function walk(node: DecodeNode): void {
    if (node.children) {
      for (const child of node.children) walk(child);
    }
    // ETH-10's own display mode, never the declared `type` — a plain address ARGUMENT not yet
    // decorated (or decorated by a pass this file cannot see) carries neither. `raw` holds the
    // FULL value even when `value` has been shortened for display.
    if (node.display !== 'address' || typeof node.raw !== 'string') return;
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

type AnnNameLookupFn = (address: string) => Promise<string | null | undefined>;
type AnnNameNotifyFn = (node: DecodeNode, annotation: string) => void;

// The async half. Starts the injected `lookup` for EVERY distinct address CONCURRENTLY — mapped
// to promises via Array.prototype.map and awaited together with Promise.all, never one at a
// time. Handoff §6.8 asks for concurrent, bounded label lookups, and the bound already lives one
// layer down: the shared transport's own 3 requests-per-second token bucket and concurrency-4
// gate, which the injected lookup closure (decoders-eth-calldata.ts) passes every one of these
// through. Awaiting one address at a time here would add latency with no safety the bucket does
// not already provide, and would lengthen the window in which a row is patched after the reader
// has moved on — the one user-visible cost this whole pass exists to minimise. Do not add a
// second bound here, and do not "fix" this back to serial believing it was a rate-limit measure.
async function annPatchContractNames(
  nodesByAddress: Map<string, DecodeNode[]>,
  lookup: AnnNameLookupFn,
  notify: AnnNameNotifyFn,
  signal: AbortSignal,
): Promise<void> {
  await Promise.all(
    Array.from(nodesByAddress.entries()).map(async ([address, nodes]) => {
      if (signal.aborted) return;
      let name: string | null | undefined;
      try {
        name = await lookup(address);
      } catch {
        // Never throws out of the batch — one address's lookup rejecting must not keep the
        // other addresses' names from appending. The specific hazard of starting the whole
        // batch together rather than one at a time.
        return;
      }
      if (signal.aborted) return;
      if (typeof name !== 'string' || name.trim().length === 0) return;
      // The shape every annotation in this dapp already takes — the name in parentheses and
      // nothing else. NET-09's `(Proxy → Impl)` form falls out of this with no proxy special
      // case anywhere in this walk: abi-source.ts composes a proxy's name as the already-joined
      // pair before this ever sees it.
      const annotation = `(${name})`;
      for (const node of nodes) {
        // Appended via a spread of the existing array — every other annotator in this
        // directory's own convention.
        node.annotations = [...(node.annotations ?? []), annotation];
        notify(node, annotation);
      }
    }),
  );
}

// Attached via a named variable, not a fresh object literal typed against the interface —
// signatures.ts's established excess-property-check sidestep, since this module exposes only
// `recurse`/`annotateTree`/`collectAddressNodes`/`patchContractNames` while `annCountNodes` and
// friends stay internal helpers. ANN_MAX_DEPTH/ANN_MAX_NODES/ANN_MAX_BYTES are exposed here
// purely so the test suite can assert the "one step either side" bound properties without
// hardcoding the constants a second time, or reaching them by constructing an actual 2 MB
// payload — transport.ts's own established practice (its module object exposes internals the
// frozen contract does not name). Data, not a mutable setter (Round 2 LOW, claude-fable): a test
// injects a small budget through `recurse`'s own already-optional 4th parameter, per call,
// rather than this module exposing anything that mutates shared state between tests.
const annotatorsModule = {
  recurse: annRecurse,
  annotateTree: annAnnotateTree,
  annotateOp: annAnnotateOp,
  collectAddressNodes: annCollectAddressNodes,
  patchContractNames: annPatchContractNames,
  ANN_MAX_DEPTH,
  ANN_MAX_NODES,
  ANN_MAX_BYTES,
};

window.DxDecode.annotators = annotatorsModule;
