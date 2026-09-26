// window.DxDecode.core / window.DxDecode.registry / window.DxDecode.log — the registry, the
// decode service, the auto-detect resolver, the phase's single live log store instance, the
// explorer link adapter, and the settings-route helper. Loads second (after codecs.ts, before
// decoders.ts) per manifest dependencies: decoders.ts's final statement calls into the
// registry this file creates.
window.DxDecode ??= {};

// D-23: the auto-detect confidence threshold. 0.5 is high enough that Phase 4's four
// competing text decoders do not all clear it on noise, and low enough that a plausible
// input still resolves. Plan 03-02 scored hex's own canDecode curve against it; plan 03-03's
// resolver (added later in this same plan) is the one thing that actually applies it.
const AUTO_DETECT_THRESHOLD = 0.5;

// D-18: the live log's ring-buffer capacity, named so a test reads it from the module rather
// than restating 500.
const LOG_CAPACITY = 500;

// D-04/RESEARCH assumption A3: decode's own small chain-explorer table. Duplicated
// deliberately — reaching for the site's global chain-credentials plugin namespace would be
// exactly the dotdev-specific coupling DEC-14's guard test forbids, and this phase's single
// decoder produces no address to link anyway — and pinned against drift by a test asserting
// equality against that plugin's own exported table.
const CHAIN_EXPLORERS: { chainId: number; explorer: string }[] = [
  { chainId: 1, explorer: 'https://etherscan.io' },
  { chainId: 11155111, explorer: 'https://sepolia.etherscan.io' },
];

// D-05: a Map-backed registry. A duplicate id is ignored so the first registration wins and
// load order stays deterministic; list() preserves registration order, which D-23's tie-break
// rule depends on.
function createDecoderRegistry(): DecoderRegistry {
  const decoders = new Map<string, DecoderPort>();
  const order: string[] = [];

  return {
    register(decoder) {
      if (decoders.has(decoder.id)) return;
      decoders.set(decoder.id, decoder);
      order.push(decoder.id);
    },
    get(id) {
      return decoders.get(id);
    },
    list() {
      return order.map((id) => decoders.get(id) as DecoderPort);
    },
    size() {
      return decoders.size;
    },
  };
}

// All hex needs: it declares no settings, so every get() resolving to undefined is correct
// rather than a stub standing in for something unbuilt.
function createNullSettingsPort(): SettingsPort {
  return { get: () => undefined };
}

// D-04/D-18: the live log's ring buffer, capped at LOG_CAPACITY and emptied only by clear().
// At capacity, the oldest entry is dropped and the newest kept — the newest is never refused.
// subscribe(cb) delivers the current entries immediately, before returning, and on every
// subsequent record/clear — without that, remounting the route would render an empty Log tab
// over a buffer that still has entries in it, making D-18's "emptied only by Clear" visibly
// false to the person looking at it.
function createLiveLogStore(): LogPort {
  let entries: LogEntry[] = [];
  const subscribers = new Set<(entries: LogEntry[]) => void>();

  function notify() {
    for (const cb of subscribers) cb(entries);
  }

  return {
    record(entry) {
      const next = [...entries, entry];
      entries = next.length > LOG_CAPACITY ? next.slice(next.length - LOG_CAPACITY) : next;
      notify();
    },
    subscribe(cb) {
      subscribers.add(cb);
      cb(entries);
      return () => subscribers.delete(cb);
    },
    clear() {
      entries = [];
      notify();
    },
  };
}

// D-04/RESEARCH A3: the explorer LinkPort. Carries its own small chain table rather than
// reaching for this shell's global chain-credentials plugin — a dotdev-specific coupling
// DEC-14's guard test forbids. Accepts a chain id as either a number or the string form a real
// settings read actually stores (that plugin's own chainId setting is a select whose option
// values are built by stringifying the numeric id), and normalizes at the boundary so neither
// form loses the lookup.
function createExplorerLinks(chainId: number | string): LinkPort {
  const normalized = typeof chainId === 'string' ? Number(chainId) : chainId;
  const chain = CHAIN_EXPLORERS.find((c) => c.chainId === normalized);

  return {
    address(addr) {
      return chain ? `${chain.explorer}/address/${addr}` : null;
    },
    tx(hash) {
      return chain ? `${chain.explorer}/tx/${hash}` : null;
    },
  };
}

// D-12: resolves the settings dapp's route from the host shell's own manifest list rather
// than hardcoding '/settings' — a literal would put a dotdev-specific route inside the
// directory D-11's portability guard polices. A shell exposing no getManifests() (not obliged
// to have one) or no settings manifest both resolve to null so a caller renders the sentence
// with no link.
function findSettingsRoute(dx: unknown): string | null {
  const shell = dx as { getManifests?: () => { id: string; route: string }[] } | null | undefined;
  if (!shell || typeof shell.getManifests !== 'function') return null;
  const manifest = shell.getManifests().find((m) => m.id === 'settings');
  return manifest?.route ?? null;
}

// WR-03: same reasoning as findSettingsRoute, for decode's OWN route — resolves it from the
// host shell's own manifest list rather than hardcoding '/tools/decode' inside buildShareUrl,
// which is exactly the dotdev-specific coupling D-11's portability guard exists to forbid. A
// shell exposing no getManifests(), or one whose manifest list has no 'decode' entry (should
// never happen for THIS mounted dapp, but nothing here assumes it), resolves to null so the
// caller falls back to deriving the route from the current mount instead.
function findOwnRoute(dx: unknown): string | null {
  const shell = dx as { getManifests?: () => { id: string; route: string }[] } | null | undefined;
  if (!shell || typeof shell.getManifests !== 'function') return null;
  const manifest = shell.getManifests().find((m) => m.id === 'decode');
  return manifest?.route ?? null;
}

// D-06: resolves a decoder's bare setting keys into a flat snapshot before calling decode(),
// so a decoder never learns which plugin namespace (if any) backs a value. Any throw from a
// decoder becomes a returned error node rather than a rejected promise — DecodeService itself
// never rejects.
function createDecodeService(options: DecodeServiceOptions): DecodeService {
  const { registry, settings, log, links, transport, abis, signatures, txSource, target, settingsRoute } = options;

  return {
    async decode(decoderId, input, runOptions) {
      const signal = runOptions?.signal;
      const decoder = decoderId ? registry.get(decoderId) : undefined;

      if (!decoder) {
        return {
          node: { label: 'decode', error: `no decoder selected for "${decoderId ?? 'auto'}"` },
          rawBytes: null,
          rawView: 'hex-dump',
          stale: signal?.aborted ?? false,
        };
      }

      // D-04: an already-superseded decode never even runs its decoder — the second Decode
      // press is the concrete case, and the ui module's own controller (plan 03-05) aborts
      // the first before starting the second.
      if (signal?.aborted) {
        return {
          node: { label: decoder.label },
          rawBytes: null,
          rawView: 'hex-dump',
          stale: true,
        };
      }

      const snapshot: Record<string, unknown> = {};
      for (const spec of decoder.settings) {
        snapshot[spec.key] = settings.get(spec.key);
      }

      const ctx: DecodeContext = {
        settings: snapshot,
        log,
        signal: signal ?? new AbortController().signal,
        links,
        // Phase 5 Task 0 (CONTEXT.md D-06): passthrough only — no type change here. All five
        // are optional on both DecodeServiceOptions and DecodeContext, so every caller that
        // builds a bare options object (every Phase 3/4 test, and this file's own createNull-
        // SettingsPort-backed wiring today) stays exactly as it was.
        transport,
        abis,
        signatures,
        // Phase 6 Task 0: the ONE further optional passthrough — stays undefined until a later
        // plan supplies a real adapter, exactly like the five above.
        txSource,
        target,
        settingsRoute,
      };

      let output: DecodeOutput;
      try {
        output = await decoder.decode(input, ctx);
      } catch (err) {
        output = { node: { label: decoder.label, error: err instanceof Error ? err.message : String(err) } };
      }

      return {
        node: output.node,
        rawBytes: output.rawBytes ?? null,
        rawView: output.rawView ?? 'hex-dump',
        stale: signal?.aborted ?? false,
        // Phase 6 Task 0: passthrough only — the ETH-12 patch-in channel (DecodeOutput's own
        // comment). undefined until a decoder actually supplies one.
        onNodeUpdate: output.onNodeUpdate,
      };
    },
  };
}

// D-22/D-23: the auto-detect resolver. Synchronous by construction — canDecode is declared
// synchronous precisely so detection cannot reach the network (DEC-05) — and it only answers a
// question; it never applies its own answer. Acting on it (only while Auto is selected, D-22)
// is the ui module's job. Reads window.DxDecode.registry dynamically rather than closing over
// a captured reference, matching how ui.ts already reads the registry at use-time (a test can
// swap or repopulate it before calling resolve, exactly as the tracer's own empty-registry
// test already does for the ui module).
function resolve(input: string): AutoDetectResolution {
  const activeRegistry = window.DxDecode?.registry;
  const candidates = activeRegistry ? activeRegistry.list() : [];

  let bestId: string | null = null;
  let bestScore = -1;

  for (const decoder of candidates) {
    let raw: number;
    try {
      raw = decoder.canDecode(input);
    } catch {
      // A decoder that throws during detection cannot take the whole path down with it —
      // caught per decoder, scored zero, the rest still get scored.
      raw = 0;
    }
    // Sanitizing an out-of-range or non-finite score is rejection, not clamping: a returned
    // 1.4 becomes 0, never 1 — clamping would let a broken decoder outrank a legitimate 0.9,
    // which is precisely the outranking this rule forbids.
    const score = Number.isFinite(raw) && raw >= 0 && raw <= 1 ? raw : 0;
    if (score > bestScore) {
      bestScore = score;
      bestId = decoder.id;
    }
  }

  if (bestId === null || bestScore < AUTO_DETECT_THRESHOLD) {
    return { decoderId: null, score: 0, reason: "couldn't identify this input" };
  }

  return { decoderId: bestId, score: bestScore, reason: `resolved to ${bestId}` };
}

// D-07: the rendered form of exp/iat/nbf — YYYY-MM-DDTHH:MM:SSZ, seconds precision, hand-
// assembled from UTC getters rather than Date.prototype.toISOString(). The platform serializer
// always appends a fractional-seconds suffix (`.000Z`) with no option to omit it, and Intl is
// off test/decode-portability.test.ts's allowlist and not reached for anyway (04-03-PLAN.md's
// <date_format_decision>) — a locale-aware formatter would need a guard edit this phase does
// not otherwise need, for a fixed UTC format the handoff vector already specifies. Lives in
// core.ts per D-04, a shared pure helper: plan 04-03's jwt decoder is the first caller, and the
// next decoder that renders a timestamp should find this rather than write a second one.
function formatUtcDate(epochSeconds: number): string | null {
  const d = new Date(epochSeconds * 1000);
  // Number.isFinite(1e20) is true, but the Date it produces is invalid and every UTC getter
  // returns NaN — guarding on the CONSTRUCTED Date, not the input, is what makes this total:
  // it covers NaN and Infinity inputs too, with no second branch, and it is what stops an
  // out-of-range claim from rendering as a string of NaN components beside a value someone is
  // actually trying to reason about.
  if (Number.isNaN(d.getTime())) return null;
  const pad = (n: number) => String(n).padStart(2, '0');
  const year = d.getUTCFullYear();
  const month = pad(d.getUTCMonth() + 1);
  const day = pad(d.getUTCDate());
  const hours = pad(d.getUTCHours());
  const minutes = pad(d.getUTCMinutes());
  const seconds = pad(d.getUTCSeconds());
  return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}Z`;
}

// ── Shared JSON walker (D-04, 04-01) ───────────────────────────────────────────────────────

// D-04: home is core.ts, not a decoder file — a function returning DecodeNodes is not a codec,
// and both this plan's base64 decoder and plan 04-03's jwt decoder need it. Attaching it to one
// decoder file and reading it from another would create a load-order dependency BETWEEN
// decoder files, breaking D-05's "one new file, no central list" story.
//
// Bounded at JSON_WALK_MAX_DEPTH (T-04-26, raised independently by both cross-AI reviewers):
// JSON.parse accepts nesting a recursive walker overflows on, and while the decode service's
// own catch above saves the page from that RangeError, the decoder's own stated never-rejects
// guarantee would be false without a bound at the source. Both consumers inherit the bound for
// free.
const JSON_WALK_MAX_DEPTH = 32;

function jsonToNodeWalk(label: string, value: unknown, depth: number): DecodeNode {
  if (depth >= JSON_WALK_MAX_DEPTH) {
    // No `raw` — JSON.stringify on the same value is recursive too and would reintroduce the
    // failure this cap exists to remove.
    return { label, warning: `nested deeper than ${JSON_WALK_MAX_DEPTH} levels — not expanded` };
  }

  if (Array.isArray(value)) {
    // Bracketed indices are a discretion call, recorded here so this walker and plan 04-03's
    // jwt decoder agree on one answer.
    return { label, children: value.map((v, i) => jsonToNodeWalk(`[${i}]`, v, depth + 1)) };
  }

  if (value !== null && typeof value === 'object') {
    return { label, children: Object.entries(value).map(([k, v]) => jsonToNodeWalk(k, v, depth + 1)) };
  }

  if (typeof value === 'boolean') {
    // DecodeNode.value (types.d.ts) is declared string | number | bigint | null — boolean is
    // deliberately absent, even though display: 'bool' exists. Casting a boolean into that
    // union does not compile, and widening the union is exactly the change this phase's
    // must_haves prohibition forbids. Carrying it as its string form under display: 'bool'
    // renders identically and costs the render contract nothing.
    return { label, value: String(value), display: 'bool', raw: String(value) };
  }

  // WR-01: JSON.parse yields a lossy `number` for an integer literal beyond
  // Number.MAX_SAFE_INTEGER — the digits are already gone by the time this walker sees the
  // value, so this cannot recover them. D-02's rule for the result tree is "a uint256 is a
  // bigint, not a lossy number"; the honest minimum here is flagging the loss rather than
  // rendering (and letting a reader copy) corrupted digits with no indication anything went
  // wrong. Checked before the general scalar branch so both `value` and `raw` below carry the
  // warning.
  if (typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value)) {
    return {
      label,
      value,
      raw: String(value),
      warning: 'integer exceeds 2^53 — digits were lost when the JSON was parsed',
    };
  }

  // Anything else — string, number, bigint, or null — is a scalar leaf. null is a scalar here
  // and produces a leaf with value: null and raw the string 'null', not a childless object node.
  return { label, value: value as string | number | null, raw: String(value) };
}

function jsonToNode(label: string, value: unknown): DecodeNode {
  return jsonToNodeWalk(label, value, 0);
}

// CR-01: jsonToNodeWalk's own depth cap exists so a pathologically nested value degrades to a
// warning rather than a stack overflow, but both JSON-bearing decoders then ran the SAME
// unbounded recursion again via a sibling `JSON.stringify(parsed, null, 2)` for `raw` — the
// walker's cap protected the tree, not the pretty-printed copy text sitting next to it. This
// mirrors the walker's own choice at the cap: catch the RangeError and emit no `raw` rather
// than let it propagate, which is what made the decoders' "never rejects" claim false.
function jsonToRaw(value: unknown): string | undefined {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return undefined;
  }
}

// ── Query parsing (D-19, D-20, D-21, DEC-03) ───────────────────────────────────────────────

// D-19/D-20/D-21: the share-link's own parameter names, 'z' the compressed variant — declared in
// types.d.ts's DecodeQueryParams (WR-02 folded this in from the local interface that used to
// live here).

// DEC-03: reads the query out of the ROUTED PATH DxKit hands dx:mount (handoff §4.3), never out
// of document.location.search — this site routes on the hash, so the query string lives inside
// the path instead and location.search is always empty. A plain split on the first '?' does not
// care what precedes it, so a routed path arriving with or without the separating slash the
// shell-level canonicalizer (src/main.ts) inserts parses identically — no slash-specific branch
// needed at all, and a hand-edited or pre-canonicalization link still opens even if that rewrite
// were ever removed.
function parseDecodeQuery(path: string): DecodeQueryParams {
  const qIdx = path.indexOf('?');
  if (qIdx === -1) return {};
  const params = new URLSearchParams(path.slice(qIdx + 1));
  const result: DecodeQueryParams = {};
  const decoder = params.get('decoder');
  if (decoder !== null) result.decoder = decoder;
  const data = params.get('data');
  if (data !== null) result.data = data;
  const z = params.get('z');
  if (z !== null) result.z = z;

  // DEC-04: `calldata=<payload>` is an alias implying decoder 'eth-calldata', resolved before
  // auto-detect ever runs. One principle, stated once, gives both precedence rules below: an
  // EXPLICIT parameter always beats an IMPLIED one.
  //   1. `decoder` beats the alias's implication — `?calldata=..&decoder=hex` still yields hex.
  //   2. `data` beats `calldata` as the payload source — `data` is the parameter buildShareUrl
  //      itself writes and every existing share link carries, so a link carrying both is far
  //      more likely to be a share link with a hand-appended alias than the reverse.
  // An empty `calldata=` still supplies `data: ''` and still implies the decoder — the user
  // asked for eth-calldata, and an empty payload does not retract that.
  //
  // 'eth-calldata' is the ONE decoder id this framework file ever names as a literal (DEC-04
  // requires it — the alias implies that specific decoder and nothing else can express the
  // implication). Every other branch in this file is decoder-agnostic by design; this is a
  // deliberate, singular exception, not licence for a second one.
  const calldata = params.get('calldata');
  if (calldata !== null) {
    if (result.decoder === undefined) result.decoder = 'eth-calldata';
    if (result.data === undefined) result.data = calldata;
  }

  // G-06-6: the share-link auto-run request. The affirmative form is the LITERAL string '1' —
  // one spelling, so every link that ever asks for it asks the same way. An empty value, any
  // other string ('true', 'yes', a stray duplicate key's second value) and a missing key are all
  // absent — result.submit stays unset, exactly as if the link had never carried the parameter.
  // This function only reports what the link SAYS; whether the request is actually honoured is
  // decided in ui.ts's applyQuery, against the recipient's own opt-in setting (DEC-05 amendment,
  // ratified 06-10) — never here, and never by running anything in this file.
  const submit = params.get('submit');
  if (submit === '1') result.submit = submit;

  return result;
}

// D-06/D-20: the share-link size warning threshold, ~32 KB per DEC-06's own wording. Named so
// ui.ts's warning UI and this file's own test read the same value rather than each restating it.
const SHARE_SIZE_WARNING_BYTES = 32 * 1024;

// D-19/D-06: composed explicitly — origin, then pathname, then the route ENDING IN A SLASH (the
// canonical form the route_canonicalization_decision establishes), then '?', then the encoded
// parameters — never through a URL object's own search-parameter setter, which would place the
// parameters BEFORE the hash, where neither this dapp's own parser (reading the query out of the
// routed path) nor the framework's router can see them at all
// (src/dapps/cic/cic.ts:409-423 is the working precedent for a hash route's query living after
// the hash, in both directions). decoderId is omitted from the link entirely when null — an
// Auto-resolved link still opens and re-resolves on the far end. The compressed-vs-plain choice
// (the `compressed` flag) is declared here so the size-warning UI and a later plan's compressed
// variant share one builder rather than two.
//
// WR-03: `route` is a REQUIRED parameter, never a literal — the caller (ui.ts's init(), which
// has `dx`) resolves it once via core.findOwnRoute(dx), falling back to the current mount's own
// hash when the host exposes no getManifests(). A host that mounts this manifest at a different
// route, or serves history mode instead of hash mode, gets a link that still opens.
function buildShareUrl(route: string, decoderId: string | null, dataParam: string, compressed: boolean): string {
  const params = new URLSearchParams();
  if (decoderId) params.set('decoder', decoderId);
  params.set(compressed ? 'z' : 'data', dataParam);
  return `${window.location.origin}${window.location.pathname}#${route}/?${params.toString()}`;
}

// D-21: feature-detect rather than try-and-catch — an action that appears and then fails is
// worse than one never offered (RESEARCH.md Pattern 6's own guard shape). Checks BOTH
// constructors even though creating a link only needs CompressionStream, because a browser with
// a real deflate-raw compressor but no matching decompressor could otherwise offer a link that
// nobody — including itself, later — could ever open.
//
// WR-06: checking the CONSTRUCTORS exist is a different question from whether they support the
// 'deflate-raw' FORMAT this file actually asks for — Chrome 80-102 and Safari 16.4 ship the
// constructors without 'deflate-raw' (Chrome added it in 103), and `new CompressionStream(...)`
// throws a TypeError for an unsupported format string. Constructing (and immediately discarding)
// one of each with the real format name is what actually answers the question the button's
// visibility depends on.
function supportsCompression(): boolean {
  if (typeof globalThis.CompressionStream !== 'function' || typeof globalThis.DecompressionStream !== 'function') {
    return false;
  }
  try {
    new CompressionStream('deflate-raw');
    new DecompressionStream('deflate-raw');
    return true;
  } catch {
    return false;
  }
}

// D-07/DEC-07: the compressed variant, built from the platform's own raw-deflate stream and plan
// 03-02's URL-alphabet base64 encoder — no dependency added, no alphabet hand-rolled. Only ever
// called after supportsCompression() has already gated it, so a one-shot drain is safe here: the
// input is the person's own textarea, already bounded by the size the share control reports
// (never the inflate side, below, which is untrusted and bounded instead). Bytes go in and come
// out through Response's own body stream (`new Response(bytes).body`) rather than
// `Blob(...).stream()` — the two are equivalent per spec, but this project's own Vitest+jsdom
// test environment implements Response's stream and not Blob's, so this is the one of the two
// that is actually exercisable offline, in this repo, by this phase's own test suite.
async function compressForShare(input: string): Promise<string> {
  const codecs = window.DxDecode!.codecs as DxDecodeCodecsModule;
  const bytes = new TextEncoder().encode(input);
  const stream = new Response(bytes).body!.pipeThrough(new CompressionStream('deflate-raw'));
  const compressed = new Uint8Array(await new Response(stream).arrayBuffer());
  return codecs.Base64.encodeUrl(compressed);
}

// T-3-02: the inflate ceiling. A compressed payload arrives from whoever sent the link, and a
// small one can expand without limit — well above SHARE_SIZE_WARNING_BYTES but bounded, so a
// crafted payload is abandoned partway rather than exhausting the tab.
const INFLATE_CEILING_BYTES = 8 * 1024 * 1024;

// D-21/T-3-02/T-3-24: the receiving side of the compressed variant. Feature-detects
// DecompressionStream on its own — never supportsCompression(), which also requires the
// CREATION side's CompressionStream; hiding the create button does nothing for a link somebody
// was already sent. Reads the inflate stream through a manual reader loop rather than draining
// it in one shot: RESEARCH.md Pattern 6's `new Response(stream).arrayBuffer()` has no way to
// stop early — by the time it resolves, the whole thing is already inflated in memory, and a
// length check afterwards is a report, not a bound. The moment the running total crosses the
// ceiling the reader is cancelled and the accumulated chunks are discarded, never concatenated.
// Every failure mode returns the ok:false branch rather than throwing — the caller renders it as
// an error node with the undecodable value left visible (DEC-12, D-21), never a blank page.
async function decompressFromShare(z: string): Promise<{ ok: true; value: string } | { ok: false; error: string }> {
  if (typeof DecompressionStream !== 'function') {
    return { ok: false, error: 'this browser cannot expand a compressed share link' };
  }

  const codecs = window.DxDecode!.codecs as DxDecodeCodecsModule;
  const decoded = codecs.Base64.decode(z);
  if (!decoded.ok) {
    return { ok: false, error: `compressed payload is not valid base64url — ${decoded.error}` };
  }

  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    // WR-02: Base64Codec.decode's contract states the plain Uint8Array codecs.ts's
    // base64Decode actually returns; this narrower cast (never a SharedArrayBuffer — the real
    // allocation is always `new Uint8Array(length)`) lives at the one call site that needs it,
    // rather than a global interface member declaring a return type narrower than reality.
    const bytes = decoded.bytes as Uint8Array<ArrayBuffer>;
    reader = new Response(bytes).body!.pipeThrough(new DecompressionStream('deflate-raw')).getReader();
  } catch {
    return { ok: false, error: 'compressed payload will not inflate' };
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > INFLATE_CEILING_BYTES) {
        await reader.cancel();
        return { ok: false, error: 'compressed payload exceeds the inflate size ceiling' };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, error: 'compressed payload will not inflate' };
  }

  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.length;
  }

  const text = codecs.Utf8.decode(combined);
  if (text === null) {
    return { ok: false, error: 'inflated payload is not valid UTF-8' };
  }
  return { ok: true, value: text };
}

// D-05's empty-registry state is first-class: a zero size() is what ui.ts branches on for
// the "no decoders loaded" guard, rather than an accidental empty <select>. Created
// unconditionally on every load of this module, per D-18/D-04's "exactly one instance for the
// module's lifetime" — this file is the only place that runs createLiveLogStore() outside a
// test's own isolated instances.
window.DxDecode.registry = createDecoderRegistry();
window.DxDecode.log = createLiveLogStore();

// WR-02: types.d.ts's DxDecodeCoreModule now declares every member below directly — the
// local extension (DxDecodeCoreModuleWithHelpers) that used to bridge the gap between the
// frozen Task-0 contract and this plan's real additions has been folded into the single-owner
// contract instead. Assembling the module object via a named variable — not a fresh literal
// typed directly against window.DxDecode.core — still sidesteps the excess-property check a
// literal would trigger if a member here were ever misspelled relative to the interface.
const coreModule: DxDecodeCoreModule = {
  createDecodeService,
  createNullSettingsPort,
  AUTO_DETECT_THRESHOLD,
  findSettingsRoute,
  findOwnRoute,
  createLiveLogStore,
  createExplorerLinks,
  resolve,
  jsonToNode,
  jsonToRaw,
  formatUtcDate,
  LOG_CAPACITY,
  parseDecodeQuery,
  buildShareUrl,
  SHARE_SIZE_WARNING_BYTES,
  supportsCompression,
  compressForShare,
  decompressFromShare,
};

window.DxDecode.core = coreModule;
