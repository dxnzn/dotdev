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
  const { registry, settings, log, links } = options;

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
  LOG_CAPACITY,
  parseDecodeQuery,
  buildShareUrl,
  SHARE_SIZE_WARNING_BYTES,
  supportsCompression,
  compressForShare,
  decompressFromShare,
};

window.DxDecode.core = coreModule;
