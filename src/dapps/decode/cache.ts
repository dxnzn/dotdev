// window.DxDecode.cache — NET-08's per-target verified-ABI cache: an in-memory tier backed by a
// browser-local persistent tier, with a time-to-live, a two-dimensional size cap and validated
// promotion. Loads immediately after signatures.js and before abi-source.js (manifest.json) —
// abi-source.ts is this module's one consumer, feature-detecting it the same way it feature-
// detects every other DxDecode sub-key.
//
// Task 0 (ratified): a third file-and-function-scoped exemption pair on the portability guard
// (test/decode-portability.test.ts), mirroring the transport/link exemptions this directory
// already carries. This file, and only this file, may name `localStorage` — and in exchange the
// guard now proves every occurrence sits inside ONE named function, `cchCreatePersistenceAccess`
// below, exactly as `netRequest` contains `fetch` and `uiCreateExternalLink` contains `href`. That
// is a narrower claim than "this directory never persists anything", not a broader one: the cache
// is what is being exempted, not moved out of the directory, because NET-08 names browser-local
// persistence as a requirement of THIS dapp, and keeping it inside the directory is what lets a
// lifted copy carry its cache intact. A future module that needs persistence routes through this
// file's own factory rather than adding a second call site of its own — the guard now asserts
// that too.
//
// Top-level names take the `cch` prefix (D-14) — the directory is one TypeScript program and a
// collision with an `asrc`, `net`, `sig`, `eth`, `abi`, `ann` or `ui` prefixed name will not
// compile. Never write this chain's full name anywhere in this file, including comments, and
// never use the bare persistence word as an identifier here — it is still forbidden for this file
// (only the single identifier `localStorage` is exempt).
window.DxDecode ??= {};

// ── The five named constants — every value fixed, none left to implementation-time judgment ──

// handoff §5.4's normative entry-key shape: `dxdecode:abi:<chainId>:<addr>`. A whole key is this
// prefix, the chain id, a colon, and the lowercased address — pinned by an equality assertion in
// the test suite, not a containment check.
const CCH_KEY_PREFIX = 'dxdecode:abi:';

// Deliberately OUTSIDE CCH_KEY_PREFIX — a hyphen, not a colon, after "abi" — so the entry prefix
// scan (cchRebuildIndex, below) can never mistake the index for one of the entries it is
// enumerating and try to promote it as an ABI on every rebuild.
const CCH_INDEX_KEY = 'dxdecode:abi-index';

// Seven days.
const CCH_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Five minutes — the memory-tier NEGATIVE answer's own, shorter lifetime. `createDecodeAdapters`
// (ui.ts) constructs this module's one cache instance ONCE PER MOUNT, not once per decode, so an
// unexpiring negative would report a contract verified mid-session as unverified for as long as
// the tab stays open. Five minutes is long enough that one decode and its name walk share a
// single lookup per address (the property the negative tier exists for) and short enough that
// nothing goes stale for the length of a mounted session.
const CCH_NEGATIVE_TTL_MS = 5 * 60 * 1000;

// A fixed entry count.
const CCH_MAX_ENTRIES = 200;

// 2 MiB — the SERIALIZED byte total across every persisted entry. An entry count alone does not
// bound storage: the transport's own per-request ceiling (abi-source.ts) allows one verified
// contract's response to approach 256 KB, so 200 entries could in principle mean tens of
// megabytes. Both caps are enforced together on every write.
const CCH_MAX_SERIALIZED_BYTES = 2 * 1024 * 1024;

// ── The one function permitted to name the exempted identifier ──────────────────────────────

// Every occurrence of `localStorage` in this file sits inside this function's body — the
// containment shape `uiCreateExternalLink` (ui.ts) already establishes for its own exemption.
// Every closure below degrades to a no-op or a null result on ANY thrown error: a browser
// configured to refuse persistence, or one whose store has gone missing mid-session, must cost
// the decode nothing beyond falling back to the memory tier.
function cchCreatePersistenceAccess() {
  function read(key: string): string | null {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  }

  function write(key: string, value: string): boolean {
    try {
      window.localStorage.setItem(key, value);
      return true;
    } catch {
      return false;
    }
  }

  function remove(key: string): void {
    try {
      window.localStorage.removeItem(key);
    } catch {
      // No-op — a refusal to remove costs nothing further than leaving a stale entry behind,
      // which the next read's own validation and the index's own eviction both already handle.
    }
  }

  // Every key currently in the store — the raw material for the index rebuild below. Not
  // filtered by prefix here; the caller decides what counts as one of its own entries.
  function keys(): string[] {
    try {
      const out: string[] = [];
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

// ── Age arithmetic — integer milliseconds only ───────────────────────────────────────────────

// An entry whose age is EXACTLY ttlMs is a miss; one millisecond younger is a hit. A stored
// timestamp that is absent, non-finite, or later than the current time is treated as expired —
// a clock moving backwards must not pin an entry forever.
function cchIsFreshTimestamp(ts: unknown, ttlMs: number): boolean {
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return false;
  const nowMs = Date.now();
  if (ts > nowMs) return false;
  return nowMs - ts < ttlMs;
}

// ── Structural validation — a trust boundary, not defensive noise ───────────────────────────

// The persisted document is third-party input to a later session: a hostile page on the same
// origin, or an older version of this dapp, may have written it. A timestamp check alone
// establishes only that an entry is recent, not that the decoder can use it — the verified-
// candidate walk (decoders-eth-calldata.ts) assumes the cached ABI is iterable and parses every
// item's inputs. This checks only the shape a decoder needs (name is a string, abi is an array);
// timestamp freshness is checked separately by cchIsFreshTimestamp above, because an absent/
// non-finite/future timestamp is EXPIRED (a miss) while a bad name/abi shape is CORRUPT (deleted)
// — two different failure modes with two different outcomes.
function cchIsStructurallyValidEntry(value: unknown): value is { ts: unknown; name: string; abi: AbiItem[] } {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.name !== 'string') return false;
  if (!Array.isArray(candidate.abi)) return false;
  return true;
}

interface CchPersistedEntry {
  ts: unknown;
  name: string;
  abi: AbiItem[];
}

// Never throws — an unparseable document degrades to `null` (a miss), matching the read path's
// own no-throw contract.
function cchParseEntry(raw: string): CchPersistedEntry | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return cchIsStructurallyValidEntry(parsed) ? parsed : null;
}

// ── The cache instance — one memory Map, the persistence closures behind it, and the index ───

type CchMemoryEntry = { ts: number; negative: true } | { ts: number; negative: false; name: string; abi: AbiItem[] };

type CchIndexTuple = [key: string, timestamp: number, bytes: number];

type CchReadResult =
  | { hit: false }
  | { hit: true; kind: 'verified'; name: string; abi: AbiItem[] }
  | { hit: true; kind: 'negative' };

// 'both' is the durable positive answer, 'memory' the same answer held only for this session (a
// proxy's merged ABI — see abi-source.ts's own comment at the write site), 'negative' a contract
// asked about and genuinely not verified.
type CchWriteValue = { tier: 'both' | 'memory'; name: string; abi: AbiItem[] } | { tier: 'negative' };

interface CchCacheInstance {
  read(chainId: string, address: string): CchReadResult;
  write(chainId: string, address: string, value: CchWriteValue): void;
}

function cchIsIndexTuple(value: unknown): value is CchIndexTuple {
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    typeof value[0] === 'string' &&
    typeof value[1] === 'number' &&
    typeof value[2] === 'number'
  );
}

// A factory taking no host handle, matching every other adapter factory in this directory. Each
// call returns a FRESH instance — `abi-source.ts` constructs exactly one, at adapter-construction
// time (once per mount, ui.ts's own `createDecodeAdapters` comment), so the memory tier and its
// negative answers live for the whole mounted session rather than being rebuilt per lookup.
function cchCreateCache(): CchCacheInstance {
  const memory = new Map<string, CchMemoryEntry>();
  const persistence = cchCreatePersistenceAccess();
  let indexCache: CchIndexTuple[] | null = null;

  function cchSaveIndex(idx: CchIndexTuple[]): void {
    indexCache = idx;
    persistence.write(CCH_INDEX_KEY, JSON.stringify(idx));
  }

  // A missing or unparseable index is REBUILT by one prefix scan rather than treated as an empty
  // cache — treating it as empty would orphan every existing entry, which would then never be
  // counted and never evicted, and the cap would quietly stop bounding anything.
  function cchRebuildIndex(): CchIndexTuple[] {
    const rebuilt: CchIndexTuple[] = [];
    for (const key of persistence.keys()) {
      if (key === CCH_INDEX_KEY) continue;
      if (!key.startsWith(CCH_KEY_PREFIX)) continue;
      const raw = persistence.read(key);
      if (raw === null) continue;
      const entry = cchParseEntry(raw);
      if (!entry) {
        // Corrupt/hostile — a single-entry loss, not a whole-cache one.
        persistence.remove(key);
        continue;
      }
      const ts = typeof entry.ts === 'number' && Number.isFinite(entry.ts) ? entry.ts : 0;
      rebuilt.push([key, ts, raw.length]);
    }
    return rebuilt;
  }

  function cchLoadIndex(): CchIndexTuple[] {
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
        // Fall through to rebuild.
      }
    }
    const rebuilt = cchRebuildIndex();
    cchSaveIndex(rebuilt);
    return rebuilt;
  }

  function cchRemoveFromIndex(key: string): void {
    cchSaveIndex(cchLoadIndex().filter(([k]) => k !== key));
  }

  // Evicts the globally oldest entry (by write timestamp) from BOTH tiers and the index,
  // mutating `idx` in place. Returns false when there is nothing left to evict — the caller's
  // own loop stops there rather than looping forever.
  function cchEvictOldest(idx: CchIndexTuple[]): boolean {
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

  function cchTotalBytes(idx: CchIndexTuple[]): number {
    let sum = 0;
    for (const [, , bytes] of idx) sum += bytes;
    return sum;
  }

  // PIN: one key per entry, plus the index key — never a single monolithic document (see the
  // file header). Both dimensions of the size cap are enforced on every write: entry count AND
  // serialized byte total, evicting oldest-first until both hold. An entry larger than the byte
  // cap on its own is REFUSED from persistence rather than evicting the whole store for it — the
  // memory tier (already written by `write`, below) still serves it for this session.
  function cchWritePersisted(key: string, entry: { ts: number; name: string; abi: AbiItem[] }): void {
    const serialized = JSON.stringify(entry);
    const bytes = serialized.length;
    if (bytes > CCH_MAX_SERIALIZED_BYTES) return;

    const idx = cchLoadIndex().filter(([k]) => k !== key);

    while (idx.length + 1 > CCH_MAX_ENTRIES || cchTotalBytes(idx) + bytes > CCH_MAX_SERIALIZED_BYTES) {
      if (!cchEvictOldest(idx)) break;
    }

    let ok = persistence.write(key, serialized);
    if (!ok) {
      // One refusal is not the same as no persistence: a store that throws because the ORIGIN is
      // near quota (the common case on a browser where the shell's settings document and theme
      // share the same origin) must not stop persisting permanently from this moment on. Evict
      // the oldest entry and retry ONCE — not in a loop, which would empty the cache to store one
      // oversized entry, the same pathology the byte-cap refusal above already forbids.
      if (cchEvictOldest(idx)) {
        ok = persistence.write(key, serialized);
      }
    }
    if (!ok) {
      // Degraded to memory-only for this entry. Persist whatever evictions already happened —
      // they are real regardless of whether the new entry itself made it in.
      cchSaveIndex(idx);
      return;
    }

    idx.push([key, entry.ts, bytes]);
    cchSaveIndex(idx);
  }

  function read(chainId: string, address: string): CchReadResult {
    const key = `${CCH_KEY_PREFIX}${chainId}:${address}`;

    const memEntry = memory.get(key);
    if (memEntry) {
      if (memEntry.negative) {
        if (cchIsFreshTimestamp(memEntry.ts, CCH_NEGATIVE_TTL_MS)) return { hit: true, kind: 'negative' };
        memory.delete(key);
      } else if (cchIsFreshTimestamp(memEntry.ts, CCH_TTL_MS)) {
        return { hit: true, kind: 'verified', name: memEntry.name, abi: memEntry.abi };
      } else {
        memory.delete(key);
      }
    }

    const raw = persistence.read(key);
    if (raw === null) return { hit: false };

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { hit: false };
    }

    if (!cchIsStructurallyValidEntry(parsed)) {
      // Corrupt or hostile — deleted and reported as a miss, never handed to a decoder that will
      // iterate it.
      persistence.remove(key);
      cchRemoveFromIndex(key);
      return { hit: false };
    }

    if (!cchIsFreshTimestamp(parsed.ts, CCH_TTL_MS)) return { hit: false };

    // Promoted into memory — a later lookup in the same mount serves from memory with no further
    // persistence access.
    memory.set(key, { ts: parsed.ts as number, negative: false, name: parsed.name, abi: parsed.abi });
    return { hit: true, kind: 'verified', name: parsed.name, abi: parsed.abi };
  }

  function write(chainId: string, address: string, value: CchWriteValue): void {
    const key = `${CCH_KEY_PREFIX}${chainId}:${address}`;
    const ts = Date.now();

    if (value.tier === 'negative') {
      // Memory tier only — a contract that was asked about and is genuinely not verified. Never
      // written to persistence: a contract can become verified between sessions, and a persisted
      // "no" would outlive the fact.
      memory.set(key, { ts, negative: true });
      return;
    }

    memory.set(key, { ts, negative: false, name: value.name, abi: value.abi });
    // 'memory' stops here: an answer that is true now and need not be true next session. It still
    // serves every later lookup in this mount, which is what the memory tier is for.
    if (value.tier === 'memory') return;
    cchWritePersisted(key, { ts, name: value.name, abi: value.abi });
  }

  return { read, write };
}

// Attached via a named variable, not a fresh object literal typed against DxDecodeCacheModule —
// abi-source.ts's own established excess-property-check sidestep. `createCache` is the frozen
// contract's one member; the rest are exposed so the test suite can exercise them directly.
const cacheModule = {
  createCache: cchCreateCache,
  CCH_KEY_PREFIX,
  CCH_INDEX_KEY,
  CCH_TTL_MS,
  CCH_NEGATIVE_TTL_MS,
  CCH_MAX_ENTRIES,
  CCH_MAX_SERIALIZED_BYTES,
};

window.DxDecode.cache = cacheModule;
