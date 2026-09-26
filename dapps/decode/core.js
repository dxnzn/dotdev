window.DxDecode ??= {};
const AUTO_DETECT_THRESHOLD = 0.5;
const LOG_CAPACITY = 500;
const CHAIN_EXPLORERS = [
  { chainId: 1, explorer: "https://etherscan.io" },
  { chainId: 11155111, explorer: "https://sepolia.etherscan.io" }
];
function createDecoderRegistry() {
  const decoders = /* @__PURE__ */ new Map();
  const order = [];
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
      return order.map((id) => decoders.get(id));
    },
    size() {
      return decoders.size;
    }
  };
}
function createNullSettingsPort() {
  return { get: () => void 0 };
}
function createLiveLogStore() {
  let entries = [];
  const subscribers = /* @__PURE__ */ new Set();
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
    }
  };
}
function createExplorerLinks(chainId) {
  const normalized = typeof chainId === "string" ? Number(chainId) : chainId;
  const chain = CHAIN_EXPLORERS.find((c) => c.chainId === normalized);
  return {
    address(addr) {
      return chain ? `${chain.explorer}/address/${addr}` : null;
    },
    tx(hash) {
      return chain ? `${chain.explorer}/tx/${hash}` : null;
    }
  };
}
function findSettingsRoute(dx) {
  const shell = dx;
  if (!shell || typeof shell.getManifests !== "function") return null;
  const manifest = shell.getManifests().find((m) => m.id === "settings");
  return manifest?.route ?? null;
}
function findOwnRoute(dx) {
  const shell = dx;
  if (!shell || typeof shell.getManifests !== "function") return null;
  const manifest = shell.getManifests().find((m) => m.id === "decode");
  return manifest?.route ?? null;
}
function createDecodeService(options) {
  const { registry, settings, log, links, transport, abis, signatures, txSource, target, settingsRoute } = options;
  return {
    async decode(decoderId, input, runOptions) {
      const signal = runOptions?.signal;
      const decoder = decoderId ? registry.get(decoderId) : void 0;
      if (!decoder) {
        return {
          node: { label: "decode", error: `no decoder selected for "${decoderId ?? "auto"}"` },
          rawBytes: null,
          rawView: "hex-dump",
          stale: signal?.aborted ?? false
        };
      }
      if (signal?.aborted) {
        return {
          node: { label: decoder.label },
          rawBytes: null,
          rawView: "hex-dump",
          stale: true
        };
      }
      const snapshot = {};
      for (const spec of decoder.settings) {
        snapshot[spec.key] = settings.get(spec.key);
      }
      const ctx = {
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
        settingsRoute
      };
      let output;
      try {
        output = await decoder.decode(input, ctx);
      } catch (err) {
        output = { node: { label: decoder.label, error: err instanceof Error ? err.message : String(err) } };
      }
      return {
        node: output.node,
        rawBytes: output.rawBytes ?? null,
        rawView: output.rawView ?? "hex-dump",
        stale: signal?.aborted ?? false,
        // Phase 6 Task 0: passthrough only — the ETH-12 patch-in channel (DecodeOutput's own
        // comment). undefined until a decoder actually supplies one.
        onNodeUpdate: output.onNodeUpdate
      };
    }
  };
}
function resolve(input) {
  const activeRegistry = window.DxDecode?.registry;
  const candidates = activeRegistry ? activeRegistry.list() : [];
  let bestId = null;
  let bestScore = -1;
  for (const decoder of candidates) {
    let raw;
    try {
      raw = decoder.canDecode(input);
    } catch {
      raw = 0;
    }
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
function formatUtcDate(epochSeconds) {
  const d = new Date(epochSeconds * 1e3);
  if (Number.isNaN(d.getTime())) return null;
  const pad = (n) => String(n).padStart(2, "0");
  const year = d.getUTCFullYear();
  const month = pad(d.getUTCMonth() + 1);
  const day = pad(d.getUTCDate());
  const hours = pad(d.getUTCHours());
  const minutes = pad(d.getUTCMinutes());
  const seconds = pad(d.getUTCSeconds());
  return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}Z`;
}
const JSON_WALK_MAX_DEPTH = 32;
function jsonToNodeWalk(label, value, depth) {
  if (depth >= JSON_WALK_MAX_DEPTH) {
    return { label, warning: `nested deeper than ${JSON_WALK_MAX_DEPTH} levels \u2014 not expanded` };
  }
  if (Array.isArray(value)) {
    return { label, children: value.map((v, i) => jsonToNodeWalk(`[${i}]`, v, depth + 1)) };
  }
  if (value !== null && typeof value === "object") {
    return { label, children: Object.entries(value).map(([k, v]) => jsonToNodeWalk(k, v, depth + 1)) };
  }
  if (typeof value === "boolean") {
    return { label, value: String(value), display: "bool", raw: String(value) };
  }
  if (typeof value === "number" && Number.isInteger(value) && !Number.isSafeInteger(value)) {
    return {
      label,
      value,
      raw: String(value),
      warning: "integer exceeds 2^53 \u2014 digits were lost when the JSON was parsed"
    };
  }
  return { label, value, raw: String(value) };
}
function jsonToNode(label, value) {
  return jsonToNodeWalk(label, value, 0);
}
function jsonToRaw(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return void 0;
  }
}
function parseDecodeQuery(path) {
  const qIdx = path.indexOf("?");
  if (qIdx === -1) return {};
  const params = new URLSearchParams(path.slice(qIdx + 1));
  const result = {};
  const decoder = params.get("decoder");
  if (decoder !== null) result.decoder = decoder;
  const data = params.get("data");
  if (data !== null) result.data = data;
  const z = params.get("z");
  if (z !== null) result.z = z;
  const calldata = params.get("calldata");
  if (calldata !== null) {
    if (result.decoder === void 0) result.decoder = "eth-calldata";
    if (result.data === void 0) result.data = calldata;
  }
  const submit = params.get("submit");
  if (submit === "1") result.submit = submit;
  return result;
}
const SHARE_SIZE_WARNING_BYTES = 32 * 1024;
function buildShareUrl(route, decoderId, dataParam, compressed) {
  const params = new URLSearchParams();
  if (decoderId) params.set("decoder", decoderId);
  params.set(compressed ? "z" : "data", dataParam);
  return `${window.location.origin}${window.location.pathname}#${route}/?${params.toString()}`;
}
function supportsCompression() {
  if (typeof globalThis.CompressionStream !== "function" || typeof globalThis.DecompressionStream !== "function") {
    return false;
  }
  try {
    new CompressionStream("deflate-raw");
    new DecompressionStream("deflate-raw");
    return true;
  } catch {
    return false;
  }
}
async function compressForShare(input) {
  const codecs = window.DxDecode.codecs;
  const bytes = new TextEncoder().encode(input);
  const stream = new Response(bytes).body.pipeThrough(new CompressionStream("deflate-raw"));
  const compressed = new Uint8Array(await new Response(stream).arrayBuffer());
  return codecs.Base64.encodeUrl(compressed);
}
const INFLATE_CEILING_BYTES = 8 * 1024 * 1024;
async function decompressFromShare(z) {
  if (typeof DecompressionStream !== "function") {
    return { ok: false, error: "this browser cannot expand a compressed share link" };
  }
  const codecs = window.DxDecode.codecs;
  const decoded = codecs.Base64.decode(z);
  if (!decoded.ok) {
    return { ok: false, error: `compressed payload is not valid base64url \u2014 ${decoded.error}` };
  }
  let reader;
  try {
    const bytes = decoded.bytes;
    reader = new Response(bytes).body.pipeThrough(new DecompressionStream("deflate-raw")).getReader();
  } catch {
    return { ok: false, error: "compressed payload will not inflate" };
  }
  const chunks = [];
  let total = 0;
  try {
    for (; ; ) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > INFLATE_CEILING_BYTES) {
        await reader.cancel();
        return { ok: false, error: "compressed payload exceeds the inflate size ceiling" };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, error: "compressed payload will not inflate" };
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.length;
  }
  const text = codecs.Utf8.decode(combined);
  if (text === null) {
    return { ok: false, error: "inflated payload is not valid UTF-8" };
  }
  return { ok: true, value: text };
}
window.DxDecode.registry = createDecoderRegistry();
window.DxDecode.log = createLiveLogStore();
const coreModule = {
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
  decompressFromShare
};
window.DxDecode.core = coreModule;
