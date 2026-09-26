window.DxDecode ??= {};
const CCH_KEY_PREFIX = "dxdecode:abi:";
const CCH_INDEX_KEY = "dxdecode:abi-index";
const CCH_TTL_MS = 7 * 24 * 60 * 60 * 1e3;
const CCH_NEGATIVE_TTL_MS = 5 * 60 * 1e3;
const CCH_MAX_ENTRIES = 200;
const CCH_MAX_SERIALIZED_BYTES = 2 * 1024 * 1024;
function cchCreatePersistenceAccess() {
  function read(key) {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  }
  function write(key, value) {
    try {
      window.localStorage.setItem(key, value);
      return true;
    } catch {
      return false;
    }
  }
  function remove(key) {
    try {
      window.localStorage.removeItem(key);
    } catch {
    }
  }
  function keys() {
    try {
      const out = [];
      for (let i = 0; i < window.localStorage.length; i++) {
        const k = window.localStorage.key(i);
        if (k !== null) out.push(k);
      }
      return out;
    } catch {
      return [];
    }
  }
  return { read, write, remove, keys };
}
function cchIsFreshTimestamp(ts, ttlMs) {
  if (typeof ts !== "number" || !Number.isFinite(ts)) return false;
  const nowMs = Date.now();
  if (ts > nowMs) return false;
  return nowMs - ts < ttlMs;
}
function cchIsStructurallyValidEntry(value) {
  if (!value || typeof value !== "object") return false;
  const candidate = value;
  if (typeof candidate.name !== "string") return false;
  if (!Array.isArray(candidate.abi)) return false;
  return true;
}
function cchParseEntry(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return cchIsStructurallyValidEntry(parsed) ? parsed : null;
}
function cchIsIndexTuple(value) {
  return Array.isArray(value) && value.length === 3 && typeof value[0] === "string" && typeof value[1] === "number" && typeof value[2] === "number";
}
function cchCreateCache() {
  const memory = /* @__PURE__ */ new Map();
  const persistence = cchCreatePersistenceAccess();
  let indexCache = null;
  function cchSaveIndex(idx) {
    indexCache = idx;
    persistence.write(CCH_INDEX_KEY, JSON.stringify(idx));
  }
  function cchRebuildIndex() {
    const rebuilt = [];
    for (const key of persistence.keys()) {
      if (key === CCH_INDEX_KEY) continue;
      if (!key.startsWith(CCH_KEY_PREFIX)) continue;
      const raw = persistence.read(key);
      if (raw === null) continue;
      const entry = cchParseEntry(raw);
      if (!entry) {
        persistence.remove(key);
        continue;
      }
      const ts = typeof entry.ts === "number" && Number.isFinite(entry.ts) ? entry.ts : 0;
      rebuilt.push([key, ts, raw.length]);
    }
    return rebuilt;
  }
  function cchLoadIndex() {
    if (indexCache) return indexCache;
    const raw = persistence.read(CCH_INDEX_KEY);
    if (raw !== null) {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.every(cchIsIndexTuple)) {
          indexCache = parsed;
          return indexCache;
        }
      } catch {
      }
    }
    const rebuilt = cchRebuildIndex();
    cchSaveIndex(rebuilt);
    return rebuilt;
  }
  function cchRemoveFromIndex(key) {
    cchSaveIndex(cchLoadIndex().filter(([k]) => k !== key));
  }
  function cchEvictOldest(idx) {
    if (idx.length === 0) return false;
    let oldestPos = 0;
    for (let i = 1; i < idx.length; i++) {
      if (idx[i][1] < idx[oldestPos][1]) oldestPos = i;
    }
    const [oldestKey] = idx[oldestPos];
    idx.splice(oldestPos, 1);
    persistence.remove(oldestKey);
    memory.delete(oldestKey);
    return true;
  }
  function cchTotalBytes(idx) {
    let sum = 0;
    for (const [, , bytes] of idx) sum += bytes;
    return sum;
  }
  function cchWritePersisted(key, entry) {
    const serialized = JSON.stringify(entry);
    const bytes = serialized.length;
    if (bytes > CCH_MAX_SERIALIZED_BYTES) return;
    const idx = cchLoadIndex().filter(([k]) => k !== key);
    while (idx.length + 1 > CCH_MAX_ENTRIES || cchTotalBytes(idx) + bytes > CCH_MAX_SERIALIZED_BYTES) {
      if (!cchEvictOldest(idx)) break;
    }
    let ok = persistence.write(key, serialized);
    if (!ok) {
      if (cchEvictOldest(idx)) {
        ok = persistence.write(key, serialized);
      }
    }
    if (!ok) {
      cchSaveIndex(idx);
      return;
    }
    idx.push([key, entry.ts, bytes]);
    cchSaveIndex(idx);
  }
  function read(chainId, address) {
    const key = `${CCH_KEY_PREFIX}${chainId}:${address}`;
    const memEntry = memory.get(key);
    if (memEntry) {
      if (memEntry.negative) {
        if (cchIsFreshTimestamp(memEntry.ts, CCH_NEGATIVE_TTL_MS)) return { hit: true, kind: "negative" };
        memory.delete(key);
      } else if (cchIsFreshTimestamp(memEntry.ts, CCH_TTL_MS)) {
        return { hit: true, kind: "verified", name: memEntry.name, abi: memEntry.abi };
      } else {
        memory.delete(key);
      }
    }
    const raw = persistence.read(key);
    if (raw === null) return { hit: false };
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { hit: false };
    }
    if (!cchIsStructurallyValidEntry(parsed)) {
      persistence.remove(key);
      cchRemoveFromIndex(key);
      return { hit: false };
    }
    if (!cchIsFreshTimestamp(parsed.ts, CCH_TTL_MS)) return { hit: false };
    memory.set(key, { ts: parsed.ts, negative: false, name: parsed.name, abi: parsed.abi });
    return { hit: true, kind: "verified", name: parsed.name, abi: parsed.abi };
  }
  function write(chainId, address, value) {
    const key = `${CCH_KEY_PREFIX}${chainId}:${address}`;
    const ts = Date.now();
    if (value.tier === "negative") {
      memory.set(key, { ts, negative: true });
      return;
    }
    memory.set(key, { ts, negative: false, name: value.name, abi: value.abi });
    if (value.tier === "memory") return;
    cchWritePersisted(key, { ts, name: value.name, abi: value.abi });
  }
  return { read, write };
}
const cacheModule = {
  createCache: cchCreateCache,
  CCH_KEY_PREFIX,
  CCH_INDEX_KEY,
  CCH_TTL_MS,
  CCH_NEGATIVE_TTL_MS,
  CCH_MAX_ENTRIES,
  CCH_MAX_SERIALIZED_BYTES
};
window.DxDecode.cache = cacheModule;
