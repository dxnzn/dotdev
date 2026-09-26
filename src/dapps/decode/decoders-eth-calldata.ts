// window.DxDecode's eth-calldata decoder — the phase's headline feature: selector -> signature
// -> type tree -> head/tail decode -> named DecodeNode tree, with a provenance badge. Loads
// after decoders-jwt.js and immediately before decoders-abi-words.js (manifest.json) — the more
// specific of the two competitors registers first, so a tie breaks toward it (04 D-03).
//
// Top-level names take the `eth` prefix (D-14).
window.DxDecode ??= {};

const ethCodecs = window.DxDecode.codecs as DxDecodeCodecsModule;
const ethKeccak = window.DxDecode.keccak as DxDecodeKeccakModule;
const ethAbi = window.DxDecode.abi as DxDecodeAbiModule;
const ethRegistry = window.DxDecode.registry as DecoderRegistry;

// WR-02-style local extension (matching decoders.ts's own HexCodecWithNormalize precedent):
// hasLocalSelector is a real runtime member signatures.ts attaches, deliberately NOT part of
// the frozen SignatureLookupPort/DxDecodeSignaturesModule contract (see signatures.ts's own
// comment) — declared here, in the one file that needs it.
interface EthSignaturesModuleWithLocalPeek extends DxDecodeSignaturesModule {
  hasLocalSelector(selector: string): boolean;
}
const ethSignatures = window.DxDecode.signatures as EthSignaturesModuleWithLocalPeek;

// Created once at module scope — the local table's own contents never change at runtime, and
// every decode call reuses the same instance rather than re-seeding a fresh Record each time.
const ethLocalTable: SignatureLookupPort = ethSignatures.createLocalSignatureTable();

const ETH_SELECTOR_BYTES = 4;
const ETH_WORD_BYTES = 32;

// <autodetect_curve_decision> (Task 0, option A — ratified): canDecode is synchronous and
// forbidden from reaching the network (DecoderPort's own contract), so "the selector resolves"
// can only mean "resolves WITHOUT a request" — i.e. against the local table. 0.97 is strictly
// above abi-words's published 0.95 (decoders-abi-words.ts:27-38); 0.91 is strictly below 0.95
// and strictly above hex's 0.9 (decoders.ts:34). The 0.91 figure — not 0.9 — exists so no
// competitor is decided by registration order: at 0.9 a bare 4-byte payload (where abi-words
// scores 0, since its own n>=1 selector-shape bound requires >=36 bytes) would tie with hex and
// be decided only by which file the manifest loaded first, which is not a decision anyone made.
// Consequence, ratified knowingly at Task 0: calldata whose selector is NOT in the local table
// still auto-detects to abi-words, not eth-calldata (D-27's own second clause) — the REGISTRY
// badge is reached by manually selecting this decoder from the dropdown, not by auto-detect,
// until a later phase's registry adapters change the shape of what "resolves" can mean here.
const ETH_SCORE_RESOLVED = 0.97;
const ETH_SCORE_SHAPED = 0.91;

const ETH_TX_HASH_BYTES = 32;

// Plan 05 Task 2: a 32-byte hex input scores 0.93. The published ladder, in full and in order:
// `hex 0.9 < shaped calldata 0.91 (ETH_SCORE_SHAPED) < tx hash 0.93 (this) < resolved calldata
// 0.97 (ETH_SCORE_RESOLVED) < creation code 0.98 (ETH_SCORE_CREATION_CODE)`. Sitting between
// the two calldata rungs decides NOTHING — neither
// can fire on a 32-byte input at all, because both require `(byteLength - 4) % 32 === 0`, and
// 32 fails that congruence (28 % 32 !== 0). The word-table decoder's own 0.95
// (decoders-abi-words.ts) is NOT a competitor here either — at exactly 32 bytes it scores ZERO
// by its own deliberate rule (its bare-words shape needs >= 64 bytes), so comparing 0.93 against
// it would be a comparison on a different input entirely. The ONE real competitor at this length
// is the plain-hex decoder's 0.9 (decoders.ts), and 0.93 beats it — that is the whole
// justification for the number. The alternative — leaving 32 bytes to the plain-hex decoder,
// which keeps a pasted storage slot away from a network-reaching path — was weighed and not taken: nothing
// HERE reaches the network. Detection stays synchronous either way, scoring a fixed value from
// the input's byte length alone; the decode itself refuses to request anything until Decode is
// pressed and a credential exists.
const ETH_SCORE_TX_HASH = 0.93;

// Creation code sits at the TOP of the ladder — above resolved calldata's 0.97 — because the solc
// metadata marker is an identification, not an inference: no other rung answers from a signal this
// specific. The detection is synchronous and reaches nothing but the bytes in hand, so it honours
// DEC-05's prohibition on a network-reaching canDecode exactly as the rest of this curve does.
// Without this rung a pasted deploy payload auto-detects to abi-words (D-27's second clause), which
// is what makes the tree unreadable for §7.4's own vector.
const ETH_SCORE_CREATION_CODE = 0.98;

function ethCanDecode(input: string): number {
  if (!ethCodecs.Hex.isHexLike(input)) return 0;
  const normalized = ethCodecs.Hex.normalize(input);
  if (normalized.length === 0 || normalized.length % 2 !== 0) return 0;

  const byteLength = normalized.length / 2;
  if (byteLength === ETH_TX_HASH_BYTES) return ETH_SCORE_TX_HASH;

  // Before the selector-shape tests, for the same reason the decode path checks it first: a deploy
  // payload has no selector, and its length satisfies 4 + 32k only by accident (§7.4's real vector
  // does not).
  const decoded = ethCodecs.Hex.decode(input);
  if (decoded.ok && window.DxDecode?.creationCode?.looksLikeCreationCode(decoded.bytes) === true) {
    return ETH_SCORE_CREATION_CODE;
  }

  if (byteLength < ETH_SELECTOR_BYTES) return 0;
  if ((byteLength - ETH_SELECTOR_BYTES) % ETH_WORD_BYTES !== 0) return 0;

  const selector = `0x${normalized.slice(0, ETH_SELECTOR_BYTES * 2)}`;
  return ethSignatures.hasLocalSelector(selector) ? ETH_SCORE_RESOLVED : ETH_SCORE_SHAPED;
}

// A resolved rung: exactly one provenance value, never absent, never two (ETH-05 empty edge).
interface EthResolved {
  ok: true;
  name: string;
  types: TypeNode[];
  provenance: 'verified' | 'local' | 'registry';
}

// The unresolved outcome carries enough of SignatureLookupResult's own distinction to let
// ethDecode compose a message that differs between "nobody knows this selector" and "we could
// not ask" (NET-04) — collapsing them here would be the same mistake a bare `[]` return makes.
interface EthUnresolved {
  ok: false;
  unavailable: boolean;
  reason?: string;
}

type EthResolveOutcome = EthResolved | EthUnresolved;

// NET-04, kept as named constants (not inlined) so 05-06's degraded-credentials sentence can
// compose with either wording instead of duplicating it.
const ETH_LOOKUP_MISS = 'no source knows this selector';
const ETH_LOOKUP_UNAVAILABLE = 'the label is unavailable because a lookup could not be completed';

// D-21: every candidate from every source is keccak-verified before acceptance — a registry (or
// even the local table, in principle) can name a signature that does not actually hash to the
// selector being resolved, and this check is the only thing that makes the provenance badge
// mean anything. The candidate's own `source` travels with the match so the caller can badge
// correctly without re-deriving which rung answered.
function ethFindVerifiedCandidate(
  candidates: SignatureCandidate[],
  selector: string,
): { name: string; types: TypeNode[]; source: SignatureCandidate['source'] } | null {
  for (const candidate of candidates) {
    const parsed = ethAbi.parseTypeString(candidate.signature);
    if ('error' in parsed) continue;
    if (ethKeccak.selector(ethAbi.canonicalSignature(parsed.name, parsed.types)) === selector) {
      return { name: parsed.name, types: parsed.types, source: candidate.source };
    }
  }
  return null;
}

// D-21: a registry candidate — whichever host answered, OpenChain or 4byte — is never
// presented as authoritative on its own; only the local table's own 'local' source earns that
// provenance. The local table is not one of the resolver's sources (it is consulted directly,
// above), so this mapping is safe regardless of which rung's match it is applied to.
function ethProvenanceFor(source: SignatureCandidate['source']): 'local' | 'registry' {
  return source === 'local' ? 'local' : 'registry';
}

// Selector resolution order — Task 0's own comment beside SignatureLookupPort (types.d.ts) is
// the one place that order is stated; this function implements it and does not restate it.
//
// 06-01: grows a third parameter, `target`, that SHADOWS the context's own target — used for
// BOTH the ABI-source presence test and the verified-ABI lookup call. The top-level call
// (ethDecodeCore) passes the context's own target, unchanged; the recursion pass (annotators.ts,
// via the adapter closure below) passes a NESTED target instead, without ever mutating ctx —
// ctx.target stays fixed for the whole top-level decode by construction (D-01's own prohibition).
async function ethResolveSelector(selector: string, ctx: DecodeContext, target?: string): Promise<EthResolveOutcome> {
  const effectiveTarget = target ?? ctx.target;
  if (ctx.abis && effectiveTarget) {
    try {
      // Task 0 (D-08, Round 2 HIGH): options object, never a positional chain id — the adapter
      // resolves its own chain id from its settings closure, so no caller here passes one.
      // 06-03: the rung now has a production supplier (abi-source.ts, wired into the shipped
      // app via ui.ts's createDecodeAdapters) — the chain id is the adapter's own to resolve,
      // and the signal is this decode's own to supply, so a superseded or unmounted decode
      // detaches its verified-ABI lookups rather than letting them run to settlement.
      const resolved = await ctx.abis.getAbi(effectiveTarget, { signal: ctx.signal });
      if (resolved) {
        for (const item of resolved.abi) {
          if (!item.name) continue;
          const types = ethAbi.parseAbiInputs(item.inputs);
          if (ethKeccak.selector(ethAbi.canonicalSignature(item.name, types)) === selector) {
            return { ok: true, name: item.name, types, provenance: 'verified' };
          }
        }
      }
    } catch {
      // AbiSourcePort must never reject (types.d.ts) — a defensive no-op if it somehow does,
      // matching DEC-12's never-throw invariant rather than letting a rejection escape decode().
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
          provenance: ethProvenanceFor(registryHit.source),
        };
      }
      // A clean miss (unavailable: false) and "we could not ask" (unavailable: true, reason
      // set) are different facts — SignatureLookupResult's whole reason for existing over a
      // bare array — and ethDecode composes a different sentence for each.
      return { ok: false, unavailable: registryResult.unavailable, reason: registryResult.reason };
    } catch {
      // Never rejects per its own contract; defensive no-op if it somehow does.
      return { ok: false, unavailable: false };
    }
  }

  // ctx.signatures absent entirely — nothing was asked, so from the user's position nothing is
  // wrong either; the same ETH_LOOKUP_MISS wording as a clean miss. The composition root always
  // supplies ctx.signatures in the shipped app (05-05 Task 3).
  return { ok: false, unavailable: false };
}

// ETH-06: the node saying the selector could not be resolved and how many bytes are undecoded —
// both rawBytes (the normalized payload's own bytes, never null) and rawView ('word-table', the
// key 04 D-08 already registered) travel on the OUTPUT, not this node; renderRaw (ui.ts) short-
// circuits to empty when rawBytes is absent, before it ever reads the view name, so returning
// only the view name would render nothing in the Raw tab (see ethDecode's own call site).
function ethUnresolvedNode(
  selectorHex: string,
  raw: string,
  undecodedBytes: number,
  outcome: EthUnresolved,
): DecodeNode {
  const reasonMessage = outcome.unavailable
    ? `${ETH_LOOKUP_UNAVAILABLE}${outcome.reason ? ` (${outcome.reason})` : ''}`
    : ETH_LOOKUP_MISS;
  return {
    label: 'eth-calldata',
    type: 'function',
    value: null,
    raw,
    provenance: 'unresolved',
    annotations: [
      `selector ${selectorHex} did not resolve — ${reasonMessage}`,
      `${undecodedBytes} undecoded byte${undecodedBytes === 1 ? '' : 's'}`,
    ],
  };
}

// ── Rendering: shortening, annotations and links (D-30, ETH-10/ETH-11/ETH-14) ──────────────
//
// abi.ts's own header comment states ONE OWNER PER NODE FIELD: it sets only label/type/value/
// raw/children/error/warning, never display/annotations/link/linkKind. Those four are this
// file's to add — the decoder decides what a value looks like, the renderer draws whatever it
// is given (03's contract). Everything below walks the tree ethAbi.decodeParameters hands back
// and decorates address/bytes32/uintN/intN leaves in place, recursively, since a tuple or array
// argument can nest one of these arbitrarily deep.

// The `0x12345678...abcdef` form — named constants rather than bare numerals, so the head/tail
// lengths are a single, unambiguous statement rather than something a reader has to count out
// of a slice expression. `raw` is left untouched by this file — abi.ts already put the FULL
// value there, and `raw` is the single source both 03 D-14's click-to-copy and ui.ts's
// applyFullValueTitle read, which is why shortening never touches it.
const ETH_SHORTEN_HEAD = 8;
const ETH_SHORTEN_TAIL = 6;

function ethShortenValue(full: string): string {
  const minLength = 2 + ETH_SHORTEN_HEAD + ETH_SHORTEN_TAIL;
  if (full.length <= minLength) return full;
  return `${full.slice(0, 2 + ETH_SHORTEN_HEAD)}...${full.slice(-ETH_SHORTEN_TAIL)}`;
}

// ETH-14: an integer at or above this magnitude gets an approximate-magnitude hint. Computed
// from the bigint's own string form — never by converting to a `number` first, which a
// uint256 does not survive.
const ETH_MAGNITUDE_THRESHOLD = 1_000_000_000_000_000n; // 1e15

function ethAnnotateMagnitude(node: DecodeNode): void {
  if (typeof node.value !== 'bigint') return;
  const negative = node.value < 0n;
  const magnitude = negative ? -node.value : node.value;
  if (magnitude < ETH_MAGNITUDE_THRESHOLD) return;
  const digits = magnitude.toString();
  const exponent = digits.length - 1;
  const hint = `≈ ${negative ? '-' : ''}${digits[0]}e${exponent}`;
  node.annotations = [...(node.annotations ?? []), hint];
}

// ETH-10: address(0) is annotated IN ADDITION to being shortened and linked, never instead of
// either.
const ETH_ZERO_ADDRESS = `0x${'0'.repeat(40)}`;

function ethAnnotateZeroAddress(node: DecodeNode, full: string): void {
  if (full !== ETH_ZERO_ADDRESS) return;
  node.annotations = [...(node.annotations ?? []), 'address(0) — the zero address / native ETH sentinel'];
}

// D-30: the ONE validation that matters — a target is composed only from a value that has
// already been shape-validated as 20-byte or 32-byte hex, so decoded (attacker-controlled)
// bytes can never supply a scheme via ctx.links. `full` is abi.ts's own address/bytes32
// rendering (lowercase 0x-hex of the exact byte width), so this is really just a defensive
// re-statement of a shape abi.ts already guarantees — cheap insurance against a future caller
// reaching these functions with something else.
const ETH_ADDRESS_HEX_RE = /^0x[0-9a-f]{40}$/;
const ETH_WORD_HEX_RE = /^0x[0-9a-f]{64}$/;

function ethAddressNode(node: DecodeNode, ctx: DecodeContext): void {
  const full = node.raw;
  if (typeof full !== 'string' || !ETH_ADDRESS_HEX_RE.test(full)) return;
  node.display = 'address';
  node.value = ethShortenValue(full);
  ethAnnotateZeroAddress(node, full);
  const link = ctx.links.address(full);
  // Never an empty string — that would render an anchor pointing at the current page. An
  // unknown chain (or no chain configured at all) means no link at all, not a broken one.
  if (link !== null) {
    node.link = link;
    node.linkKind = 'external';
  }
}

// ETH-11: a 32-byte word that is NOT an address — the label stays neutral ('txhash' is an
// AFFORDANCE, not a claim; handoff §6 says a bare 32-byte word may or may not be a transaction
// hash). Only `bytes32` triggers this — bytes31/bytes33 (a malformed or unusual signature) get
// neither the display mode nor the link.
function ethWordNode(node: DecodeNode, ctx: DecodeContext): void {
  const full = node.raw;
  if (typeof full !== 'string' || !ETH_WORD_HEX_RE.test(full)) return;
  node.display = 'txhash';
  node.value = ethShortenValue(full);
  const link = ctx.links.tx(full);
  if (link !== null) {
    node.link = link;
    node.linkKind = 'external';
  }
}

function ethDecorateTree(node: DecodeNode, ctx: DecodeContext): void {
  if (node.children) {
    for (const child of node.children) ethDecorateTree(child, ctx);
  }
  // An error node has no decoded value to shorten, annotate or link.
  if (node.error !== undefined) return;
  if (node.type === 'address') {
    ethAddressNode(node, ctx);
  } else if (node.type === 'bytes32') {
    ethWordNode(node, ctx);
  } else if (node.type === 'string') {
    // D-30 keeps abi.ts out of the display business, so the mode is claimed here — without it a
    // decoded string falls through the renderer's dispatch table to its raw-wins default and
    // shows the hex of its own bytes. Nothing else is touched: `value` already holds the text
    // (or, for invalid UTF-8, the hex abi.ts substituted) and `raw` stays the payload hex that
    // click-to-copy reads.
    node.display = 'text';
  } else if (typeof node.value === 'bigint') {
    ethAnnotateMagnitude(node);
  }
}

// ── DEC-13: the degraded-credentials sentence (D-29, ETH-05) ───────────────────────────────
//
// Plan 05 Task 3 rewrite: this sentence went stale twice, at two different plans, for the same
// reason each time — 06-03 wired a real verified-ABI source (invalidating the API-key clause's
// old "not wired yet" default the moment ctx.abis existed) and 06-05 wires a real transaction
// source the same way (invalidating the endpoint-URL clause identically). Both are closed here,
// in one pass, so this function is edited once for the underlying cause rather than twice for
// the same reason at two different plans. The ceiling this build can reach is STILL derived
// from the PORTS actually present on ctx, never from the settings snapshot — that discipline is
// what makes the sentence correct itself rather than going stale a third time; what changes is
// only which ports each key's verdict is answered against.
const ETH_SETTINGS: SettingSpec[] = [
  {
    key: 'etherscanApiKey',
    required: false,
    why: "would let this decoder resolve a verified ABI for a nested call's sibling target, or for a looked-up transaction's own recipient",
  },
  {
    key: 'rpcUrl',
    required: false,
    why: 'would let this decoder look up a pasted transaction hash directly from your own node',
  },
];

function ethSettingPresent(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

// The best provenance rung THIS build can reach, from the ports on ctx — never from settings.
// `verified` when ctx.abis is present ALONE — the top-level-target conjunct this function used
// to require is DROPPED here: a nested call's own sibling target (Plan 06-02's rule) and, since
// this plan, a looked-up transaction's own recipient are both real top-level targets this phase
// supplies, so requiring ctx.target here as well described a build that no longer exists.
// `registry` when ctx.signatures is present (both OpenChain and 4byte are unauthenticated — no
// credential required); otherwise `local`.
function ethProvenanceCeiling(
  _snapshot: Record<string, unknown>,
  ctx: DecodeContext,
): 'verified' | 'registry' | 'local' {
  if (ctx.abis) return 'verified';
  if (ctx.signatures) return 'registry';
  return 'local';
}

// A setting "raises the rung" only when the port it would feed is already the thing separating
// the current ceiling from a higher one — answered PER KEY against the ports actually present on
// ctx, never against the settings snapshot, so each verdict corrects itself the moment a real
// consumer is wired rather than going stale the way a hardcoded phrase would. The API key's
// verdict is DELEGATED to ethProvenanceCeiling (above) rather than re-checking ctx.abis here, so
// the two never drift apart; the endpoint URL's verdict checks ctx.txSource directly, since
// ethProvenanceCeiling has no rung of its own for it.
function ethSettingRaisesRung(key: string, snapshot: Record<string, unknown>, ctx: DecodeContext): boolean {
  if (key === 'etherscanApiKey') return ethProvenanceCeiling(snapshot, ctx) === 'verified';
  if (key === 'rpcUrl') return ctx.txSource !== undefined;
  return false;
}

// D-29: names each absent setting and says plainly what it is for. Takes the CONTEXT, never a
// host shell handle — DecoderPort.decode(input, ctx) is the only entry point and DecodeContext
// carries no such handle, so a decoder reaching into the host's own manifest list here would be
// uncallable from anywhere this decoder actually runs. `ctx.settingsRoute` (resolved once by
// the composition root from core.findSettingsRoute) is how the sentence gets a route without
// this file ever seeing a host.
function ethMissingSettingsNote(snapshot: Record<string, unknown>, ctx: DecodeContext): string | undefined {
  const missing = ETH_SETTINGS.filter((spec) => !ethSettingPresent(snapshot[spec.key]));
  if (missing.length === 0) return undefined;
  const parts = missing.map((spec) =>
    ethSettingRaisesRung(spec.key, snapshot, ctx)
      ? `${spec.key} is not set — ${spec.why}.`
      : `${spec.key} is not set — the value is stored for a feature that is not wired yet (${spec.why}).`,
  );
  return parts.join(' ');
}

// Plan 05 Task 2: the transaction-hash pre-step's own could-not-ask node — names BOTH declared
// settings by their user-facing purpose, matching ETH-08's clear-error clause, regardless of
// which one (or neither) is actually configured; the per-key DEC-13 sentence below this function
// (ethMissingSettingsNote) separately says which one is missing, and the wrapper (ethDecode)
// attaches the settings-route link to THAT note automatically whenever one is missing — this
// node's own `error` text needs no separate link of its own.
function ethTxUnavailableNode(raw: string, reason: string | undefined): DecodeNode {
  const detail = reason ? ` (${reason})` : '';
  return {
    label: 'eth-calldata',
    error: `this transaction cannot be looked up${detail} — configure an RPC endpoint URL or an Etherscan API key to enable it`,
    raw,
  };
}

// Plan 05 Task 2: a 32-byte input IS a transaction hash — a pre-step inside this SAME decoder
// (D-16), never a new decoder id (which would pre-empt the second-wave transaction decoder) and
// never logic in the renderer (forbidden decoder-specific knowledge, and a test pins that).
// Feature-detects ctx.txSource — a context without one is the same user-facing outcome as one
// that could not ask, never a throw and never a different sentence.
async function ethDecodeTransaction(raw: string, hashBytes: Uint8Array, ctx: DecodeContext): Promise<DecodeOutput> {
  const wordTableOutput = (node: DecodeNode): DecodeOutput => ({ node, rawBytes: hashBytes, rawView: 'word-table' });

  if (!ctx.txSource) {
    return wordTableOutput(ethTxUnavailableNode(raw, undefined));
  }

  let result: TxLookupResult;
  try {
    // The context's own abort signal — a second Decode press must detach an in-flight
    // transaction lookup, not merely discard its result.
    result = await ctx.txSource.getTransaction(raw, { signal: ctx.signal });
  } catch {
    // TxSourcePort must never reject (types.d.ts) — a defensive no-op if it somehow does,
    // matching DEC-12's never-throw invariant.
    result = { unavailable: true };
  }

  // The pass-in above detaches the request; this check-after prevents a late resolution from
  // writing a full tree into an already-abandoned decode.
  if (ctx.signal.aborted) {
    return wordTableOutput({ label: 'eth-calldata', raw });
  }

  if (result.unavailable) {
    // A `reason` distinguishes could-not-ask (this node) from a clean miss (below) — an
    // undefined reason is the port's own signal that it genuinely asked and found nothing.
    if (result.reason === undefined) {
      return wordTableOutput({
        label: 'eth-calldata',
        error: 'this transaction was not found — the hash does not exist on-chain, or is still pending',
        raw,
      });
    }
    return wordTableOutput(ethTxUnavailableNode(raw, result.reason));
  }

  const transaction = result.transaction;
  if (!transaction) {
    // Defensive — a port reporting unavailable: false must carry a transaction; this is DEC-12's
    // own promise regardless of what a future or foreign adapter does.
    return wordTableOutput({ label: 'eth-calldata', error: 'the transaction source returned no transaction', raw });
  }

  if (transaction.to === null) {
    return wordTableOutput({
      label: 'eth-calldata',
      error: 'this transaction created a contract — decoding a deploy payload is not something this decoder does',
      raw,
    });
  }

  const innerResult = ethCodecs.Hex.decode(transaction.input);
  if (!innerResult.ok) {
    return wordTableOutput({ label: 'eth-calldata', error: innerResult.error, raw });
  }

  // Continue the existing pipeline with the transaction's own input in place of the pasted hash,
  // and its recipient as the effective top-level target — threaded into both the selector
  // resolution call and the recursion pass's starting target, so the outer call resolves against
  // the transaction's own recipient.
  return ethDecodeCalldataBytes(
    `0x${ethCodecs.Hex.encode(innerResult.bytes, { prefix: false })}`,
    innerResult.bytes,
    ctx,
    transaction.to,
  );
}

// The body of the original ethDecodeCore, unchanged in behaviour, now parameterized on the
// EFFECTIVE top-level target rather than reading `ctx.target` directly — the top-level calldata
// path below passes `ctx.target` (unchanged from before this task) and ethDecodeTransaction above
// passes the transaction's own recipient instead. Neither caller mutates `ctx` itself (D-01's own
// prohibition) — the target travels only as this explicit parameter.
async function ethDecodeCalldataBytes(
  raw: string,
  bytes: Uint8Array,
  ctx: DecodeContext,
  effectiveTarget: string | undefined,
): Promise<DecodeOutput> {
  if (bytes.length < ETH_SELECTOR_BYTES) {
    return {
      node: {
        label: 'eth-calldata',
        error: `too short to carry a 4-byte selector — ${bytes.length} byte${bytes.length === 1 ? '' : 's'}`,
        raw,
      },
      rawBytes: bytes,
      rawView: 'word-table',
    };
  }

  const selectorHex = `0x${ethCodecs.Hex.encode(bytes.slice(0, ETH_SELECTOR_BYTES), { prefix: false })}`;
  const payload = bytes.slice(ETH_SELECTOR_BYTES);

  // 06-01: the top-level call passes the EFFECTIVE target explicitly — the recursion pass below
  // is what passes a NESTED one.
  const outcome = await ethResolveSelector(selectorHex, ctx, effectiveTarget);

  if (!outcome.ok) {
    // ETH-06: an unresolved decode carries BOTH rawBytes (the payload's own bytes, never null)
    // and rawView 'word-table' on this path too — renderRaw (ui.ts:380-383) short-circuits to
    // an empty result when rawBytes is absent, before it ever reads the view name, so setting
    // only the view name would render nothing in the Raw tab.
    return {
      node: ethUnresolvedNode(selectorHex, raw, payload.length, outcome),
      rawBytes: bytes,
      rawView: 'word-table',
    };
  }

  // ETH-07: a zero-length type list (e.g. pull()) produces a bare function node with no
  // children and no error — abiDecodeParameters returns [] for an empty types array, and an
  // empty children array is normalized away here rather than rendered as an empty group.
  const decoded = ethAbi.decodeParameters(outcome.types, payload, 0, 0);

  // 06-01: the root function node is constructed FIRST, before either pass runs — Round 2's
  // review (both reviewers, independently) found that decorating the loose `decoded` array and
  // building the root only afterwards leaves two things structurally unreachable: a top-level
  // `bytes data` argument cannot scan back to its preceding top-level `to` sibling (there is no
  // parent whose `children` holds both), and Plan 02's operation annotator cannot see the
  // top-level function's own identity at all, because the node carrying `label: outcome.name`
  // did not exist yet. The name `root` is load-bearing, like `annSeedBudget` — the source-order
  // gate locates it and requires it to precede the recursion invocation below.
  const root: DecodeNode = {
    label: outcome.name,
    type: 'function',
    value: null,
    raw,
    provenance: outcome.provenance,
    children: decoded.length > 0 ? decoded : undefined,
  };

  // Three ordered passes over the same `root`, all feature-detected (a host shell could load
  // this decoder with no annotators.ts loaded; a missing module means the pass is skipped,
  // never a throw): RECURSE, then DECORATE, then ANNOTATE. Order is the point at every step:
  //
  // 1. RECURSE — grafts every nested call BEFORE decoration or annotation ever run, so neither
  //    later pass has to special-case a node that might still turn into a function. The adapter
  //    closure calls ethResolveSelector with the NESTED target and returns its outcome through
  //    unchanged; ctx itself is never mutated — a nested call's target travels only as an
  //    explicit parameter (D-01's own prohibition).
  await window.DxDecode?.annotators?.recurse?.(root, effectiveTarget, (nestedSelector, nestedTarget) =>
    ethResolveSelector(nestedSelector, ctx, nestedTarget),
  );

  // 2. DECORATE — D-30: shortening/annotation/linking happens here, on the ROOT — abi.ts itself
  //    never sets display/annotations/link/linkKind (its own header comment). Running it ONCE,
  //    over the root, AFTER recursion, is what covers original and grafted nodes alike:
  //    decorating first would leave every nested address undecorated, silently regressing
  //    ETH-10/ETH-11/ETH-14 inside every nested call and starving Plan 06's name walk (which
  //    filters on the display mode this sets); decorating twice would double every top-level
  //    integer's magnitude annotation (ethAnnotateMagnitude appends on every call).
  //    ethDecorateTree recurses into node.children itself and only then dispatches on the
  //    current node's own type/value — the root's type is 'function' and its value is null, so
  //    none of its three branches (address/bytes32/bigint) match it, and every child is visited
  //    exactly as the old per-argument loop visited it: behaviour-identical, only the loop is
  //    gone.
  ethDecorateTree(root, ctx);

  // 3. ANNOTATE — ETH-13's operation argument annotator, run LAST and over the SAME root:
  //    running it before recursion would leave every operation argument inside a nested call
  //    unannotated (handoff §7.2's own shape — setPermit's DELEGATECALL op sits INSIDE the
  //    nested call recursion grafts); running it before decoration would be harmless but would
  //    put the three passes in an order that no longer reads as recurse-then-decorate-then-
  //    annotate. `annAnnotateOp` needs the PARENT function node in hand to reach its indexed
  //    child and to read the function's own name — the top-level function node IS the root, so
  //    passing anything other than `root` here would leave the top-level operation argument
  //    (handoff §7.2's own vector) permanently unreachable.
  window.DxDecode?.annotators?.annotateTree?.(root);

  // 4. NAME WALK (ETH-12, 06-06) — only when the context carries an ABI source. Builds the
  //    per-node update channel and STARTS the walk WITHOUT AWAITING it, so the labelling
  //    lookups never delay the return below. Scoped honestly, stated once and meant literally:
  //    this makes the LABELLING walk non-blocking. It does NOT make selector resolution
  //    non-blocking — step 1's RECURSE pass, and the top-level resolution above it, already
  //    awaited ctx.abis.getAbi for every known target before this function ever reached this
  //    line, and that has always been true. Awaiting this walk too would only make an
  //    already-blocking path worse under the shared token bucket, which is why it is started
  //    and not awaited instead.
  return {
    node: root,
    rawBytes: bytes,
    rawView: 'word-table',
    onNodeUpdate: ethStartNameWalk(root, ctx),
  };
}

// 4. NAME WALK (ETH-12, 06-06), extracted so the deploy-payload branch below reaches it too:
// §7.4's fourteen constructor words are addresses, and an address the walk never sees is an
// address that never gets a contract name. Returns the subscribe channel, or undefined when the
// context carries no ABI source and there is nothing to walk.
//
// Starts the walk WITHOUT AWAITING it, so the labelling lookups never delay the caller's return.
// Scoped honestly, stated once and meant literally: this makes the LABELLING walk non-blocking. It
// does NOT make selector resolution non-blocking — the recursion pass, and the top-level
// resolution before it, already awaited ctx.abis.getAbi for every known target. Awaiting this walk
// too would only make an already-blocking path worse under the shared token bucket, which is why
// it is started and not awaited instead.
function ethStartNameWalk(root: DecodeNode, ctx: DecodeContext): DecodeOutput['onNodeUpdate'] {
  const annotators = window.DxDecode?.annotators;
  if (!ctx.abis || !annotators?.collectAddressNodes || !annotators?.patchContractNames) return undefined;

  const abis = ctx.abis;
  // A small subscriber list, never a replay buffer (types.d.ts's own comment on
  // DecodeOutput.onNodeUpdate) — a name that resolves before the renderer subscribes is
  // already in the node's own `annotations` array, drawn by the first render pass.
  const subscribers = new Set<(node: DecodeNode, annotation: string) => void>();
  void annotators.patchContractNames(
    annotators.collectAddressNodes(root),
    async (address) => {
      // The options-object form Plan 01 froze — never a positional signal, never a chain id.
      // Carries the decode's own abort signal so an unmounted or superseded run detaches its
      // in-flight lookups rather than letting them run to settlement.
      const result = await abis.getAbi(address, { signal: ctx.signal });
      return result?.name;
    },
    (node, annotation) => {
      for (const listener of subscribers) listener(node, annotation);
    },
    ctx.signal,
  );

  return (listener) => {
    subscribers.add(listener);
    return () => subscribers.delete(listener);
  };
}

async function ethDecodeCore(input: string, ctx: DecodeContext): Promise<DecodeOutput> {
  const result = ethCodecs.Hex.decode(input);
  if (!result.ok) {
    // DEC-12's concrete instance: malformed input becomes a returned error node, never a thrown
    // exception or a rejected promise.
    return { node: { label: 'eth-calldata', error: result.error, raw: input }, rawBytes: null };
  }

  const { bytes } = result;
  const raw = `0x${ethCodecs.Hex.encode(bytes, { prefix: false })}`;

  // Plan 05 Task 2: BEFORE the selector is ever read — an exact 32-byte input is a transaction
  // hash, not calldata.
  if (bytes.length === ETH_TX_HASH_BYTES) {
    return ethDecodeTransaction(raw, bytes, ctx);
  }

  // handoff §6.5 step 7, at the top level: a pasted deploy payload is not calldata and has no
  // selector to resolve. Without this the blob's first four bytes read as one and the whole thing
  // comes back as an unresolved selector over thousands of undecoded bytes. The nested case — the
  // `bytes` argument inside deployNext(bytes,bytes32) — is handled by the same module from the
  // recursion pass (annotators.ts), which is why the analysis lives in neither file.
  const creationCode = window.DxDecode?.creationCode;
  if (creationCode?.looksLikeCreationCode(bytes) === true) {
    const node: DecodeNode = { label: 'deploy payload', type: 'bytes', raw };
    creationCode.expand(node, bytes);
    // Decorated for the same reason every other path is: the constructor words come out typed
    // `address`, and it is ethDecorateTree that turns those into shortened, linked, nameable
    // nodes. Skipping it would leave §7.4's fourteen addresses as bare lowercase hex.
    ethDecorateTree(node, ctx);
    return { node, rawBytes: bytes, rawView: 'hex-dump', onNodeUpdate: ethStartNameWalk(node, ctx) };
  }

  return ethDecodeCalldataBytes(raw, bytes, ctx, ctx.target);
}

// DEC-13/D-29: the missing-settings sentence is composed and assigned here, wrapping every
// return path ethDecodeCore has — following decoders-jwt.ts's own not-verified caution, which
// is assigned before any segment of the input is examined so no return path can skip it. A
// decode that errors early (malformed hex, too short, unresolved selector) still carries it.
async function ethDecode(input: string, ctx: DecodeContext): Promise<DecodeOutput> {
  const settingsNote = ethMissingSettingsNote(ctx.settings, ctx);
  const output = await ethDecodeCore(input, ctx);
  if (settingsNote) {
    // APPENDED, never assigned over: annSeedBudget already writes the root's bounded-decoding
    // warning ("this tree exceeded the recursion budget"), and an RPC-only or explorer-only
    // configuration — a normal way to run this dapp — is exactly when both warnings are true at
    // once. Overwriting left a 5,000-call payload with every nested call undecoded and nothing left
    // on the tree saying that recursion had been skipped.
    output.node.warning = output.node.warning ? `${output.node.warning} ${settingsNote}` : settingsNote;
    // ROADMAP success criterion 5 says the UI "links to /settings" — putting the route inside
    // `warning` would render as inert text (ui.ts draws it via textContent). `link`/`linkKind`
    // are the two members 05-01 Task 0 added for exactly this; renderNode draws the anchor.
    // Absent ctx.settingsRoute (a host with no settings dapp) means no link at all, never a
    // broken one.
    if (ctx.settingsRoute) {
      output.node.link = ctx.settingsRoute;
      output.node.linkKind = 'route';
    }
  }
  return output;
}

const ethCalldataDecoder: DecoderPort = {
  id: 'eth-calldata',
  // test/decode-registry.test.ts's own portability check scans every .ts source file in this
  // directory for a longer spelling of this chain's name (case-insensitive), guarding against
  // this dapp naming the shell's specific credentials plugin/settings-section — so the label
  // below deliberately uses the shorter, ticker-style form instead.
  label: 'ETH calldata',
  // D-29: both required: false — 01 D-29 established that no credential is required, which is
  // exactly why the degraded local-table-only path is the common path for a first-time visitor.
  settings: ETH_SETTINGS,
  canDecode: ethCanDecode,
  decode: ethDecode,
};

// D-05's self-registration — the final statement.
ethRegistry.register(ethCalldataDecoder);
