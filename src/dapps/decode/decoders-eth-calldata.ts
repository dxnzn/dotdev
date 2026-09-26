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

function ethCanDecode(input: string): number {
  if (!ethCodecs.Hex.isHexLike(input)) return 0;
  const normalized = ethCodecs.Hex.normalize(input);
  if (normalized.length === 0 || normalized.length % 2 !== 0) return 0;

  const byteLength = normalized.length / 2;
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

// D-06's stub-only verified rung: this phase has no production supplier for ctx.target (a
// single pasted calldata blob has no target address), so this constant only matters when a
// test's stubbed AbiSourcePort is exercised. Phase 6's ETH-08 transaction input replaces it.
const ETH_PLACEHOLDER_CHAIN_ID = 1;

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
async function ethResolveSelector(selector: string, ctx: DecodeContext): Promise<EthResolveOutcome> {
  if (ctx.abis && ctx.target) {
    try {
      const resolved = await ctx.abis.getAbi(ctx.target, ETH_PLACEHOLDER_CHAIN_ID);
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
  } else if (typeof node.value === 'bigint') {
    ethAnnotateMagnitude(node);
  }
}

// ── DEC-13: the degraded-credentials sentence (D-29, ETH-05) ───────────────────────────────
//
// See this plan's own <assumption_delta_decision>: the ceiling this build can reach is derived
// from the PORTS actually present on ctx, never from the settings snapshot — neither credential
// this decoder declares unlocks anything THIS phase ships (etherscanApiKey needs a Phase 6
// Etherscan ABI adapter AND a known target; rpcUrl needs ETH-08), so a settings-derived sentence
// claiming either "raises the rung" would be false for a first-time visitor.
const ETH_SETTINGS: SettingSpec[] = [
  {
    key: 'etherscanApiKey',
    required: false,
    why: 'would let this decoder resolve a verified ABI once a target contract is known',
  },
  {
    key: 'rpcUrl',
    required: false,
    why: 'would let this decoder read on-chain state directly',
  },
];

function ethSettingPresent(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

// The best provenance rung THIS build can reach, from the ports on ctx — never from settings.
// `verified` only when BOTH ctx.abis AND ctx.target are present (a verified ABI needs a known
// target to ask about); `registry` when ctx.signatures is present (both OpenChain and 4byte are
// unauthenticated — no credential required); otherwise `local`.
function ethProvenanceCeiling(
  _snapshot: Record<string, unknown>,
  ctx: DecodeContext,
): 'verified' | 'registry' | 'local' {
  if (ctx.abis && ctx.target) return 'verified';
  if (ctx.signatures) return 'registry';
  return 'local';
}

// A setting "raises the rung" only when the port it would feed is already the thing separating
// the current ceiling from a higher one. In THIS phase that is never true for either declared
// setting (see the module comment above) — this still checks the port, rather than hardcoding
// false, so the claim corrects itself the moment a later phase wires a real consumer instead of
// silently going stale the way a hardcoded phrase would.
function ethSettingRaisesRung(key: string, snapshot: Record<string, unknown>, ctx: DecodeContext): boolean {
  if (key !== 'etherscanApiKey') return false;
  return ethProvenanceCeiling(snapshot, ctx) === 'verified';
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

async function ethDecodeCore(input: string, ctx: DecodeContext): Promise<DecodeOutput> {
  const result = ethCodecs.Hex.decode(input);
  if (!result.ok) {
    // DEC-12's concrete instance: malformed input becomes a returned error node, never a thrown
    // exception or a rejected promise.
    return { node: { label: 'eth-calldata', error: result.error, raw: input }, rawBytes: null };
  }

  const { bytes } = result;
  const raw = `0x${ethCodecs.Hex.encode(bytes, { prefix: false })}`;

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

  const outcome = await ethResolveSelector(selectorHex, ctx);

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
  // D-30: shortening/annotation/linking happens here, on the tree abi.ts handed back — abi.ts
  // itself never sets display/annotations/link/linkKind (its own header comment).
  for (const child of decoded) ethDecorateTree(child, ctx);

  return {
    node: {
      label: outcome.name,
      type: 'function',
      value: null,
      raw,
      provenance: outcome.provenance,
      children: decoded.length > 0 ? decoded : undefined,
    },
    rawBytes: bytes,
    rawView: 'word-table',
  };
}

// DEC-13/D-29: the missing-settings sentence is composed and assigned here, wrapping every
// return path ethDecodeCore has — following decoders-jwt.ts's own not-verified caution, which
// is assigned before any segment of the input is examined so no return path can skip it. A
// decode that errors early (malformed hex, too short, unresolved selector) still carries it.
async function ethDecode(input: string, ctx: DecodeContext): Promise<DecodeOutput> {
  const settingsNote = ethMissingSettingsNote(ctx.settings, ctx);
  const output = await ethDecodeCore(input, ctx);
  if (settingsNote) {
    output.node.warning = settingsNote;
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
