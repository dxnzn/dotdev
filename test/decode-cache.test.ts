import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 06-04 Task 2 — cache.ts's two-tier cache, entirely offline, driven by an installed Storage
// stand-in and a controlled clock. No test in this file performs a real request or waits on a
// real timer. Loads the compiled module directly, matching test/decode-keccak.test.ts's own
// single-module idiom (cache.ts has no dependency on any other compiled module in this
// directory).
function loadCompiled(relPath: string): void {
  const code = readFileSync(resolve(__dirname, relPath), 'utf-8');
  new Function('window', code)(window);
}

// Copied from test/decode-url.test.ts's own installFakeStorage (itself copied from
// test/shell-wallet.test.ts's installFakeLocalStorage) — this Node runtime exposes an
// experimental native globalThis.localStorage that shadows jsdom's simulated Storage and has no
// setItem/getItem/clear. A Map-backed, Storage-shaped stand-in restores a real (and spy-able)
// surface, installed fresh via Object.defineProperty in beforeEach so every test gets an
// isolated store.
function installFakeStorage(): Storage {
  const map = new Map<string, string>();
  const storage = {
    getItem: (k: string) => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k: string, v: string) => {
      map.set(k, String(v));
    },
    removeItem: (k: string) => {
      map.delete(k);
    },
    clear: () => {
      map.clear();
    },
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    get length() {
      return map.size;
    },
  };
  Object.defineProperty(window, 'localStorage', { configurable: true, value: storage });
  return storage as unknown as Storage;
}

const BASE_TIME = new Date('2026-01-01T00:00:00Z').getTime();

beforeEach(() => {
  installFakeStorage();
  vi.useFakeTimers();
  vi.setSystemTime(BASE_TIME);
  loadCompiled('../src/dapps/decode/cache.js');
});

afterEach(() => {
  vi.useRealTimers();
});

type CchReadResult =
  | { hit: false }
  | { hit: true; kind: 'verified'; name: string; abi: AbiItem[] }
  | { hit: true; kind: 'negative' };

type CchWriteValue = { tier: 'both'; name: string; abi: AbiItem[] } | { tier: 'negative' };

interface CchCacheInstance {
  read(chainId: string, address: string): CchReadResult;
  write(chainId: string, address: string, value: CchWriteValue): void;
}

interface CacheModule {
  createCache(): CchCacheInstance;
  CCH_KEY_PREFIX: string;
  CCH_INDEX_KEY: string;
  CCH_TTL_MS: number;
  CCH_NEGATIVE_TTL_MS: number;
  CCH_MAX_ENTRIES: number;
  CCH_MAX_SERIALIZED_BYTES: number;
}

function cacheModule(): CacheModule {
  return window.DxDecode!.cache as unknown as CacheModule;
}

const ABI_ITEM: AbiItem = { name: 'transfer', type: 'function', inputs: [] };
const ADDR1 = '0x0000000000000000000000000000000000000a';
const ADDR2 = '0x0000000000000000000000000000000000000b';

function addrN(i: number): string {
  return `0x${(i + 1000).toString(16).padStart(40, '0')}`;
}

function entryKey(chainId: string, address: string): string {
  return `${cacheModule().CCH_KEY_PREFIX}${chainId}:${address}`;
}

describe('a miss then a memory hit with no persistence read; a persisted document promotes into memory', () => {
  it('a lookup for a target and chain not yet seen misses; the same lookup again is a memory hit with no persistence access', () => {
    const cache = cacheModule().createCache();
    expect(cache.read('1', ADDR1)).toEqual({ hit: false });

    cache.write('1', ADDR1, { tier: 'both', name: 'Test', abi: [ABI_ITEM] });

    const spy = vi.spyOn(window.localStorage, 'getItem');
    expect(cache.read('1', ADDR1)).toEqual({ hit: true, kind: 'verified', name: 'Test', abi: [ABI_ITEM] });
    expect(spy).not.toHaveBeenCalled();
  });

  it('a fresh cache instance with a populated persistent document serves the lookup from persistence and promotes it into memory', () => {
    const cacheA = cacheModule().createCache();
    cacheA.write('1', ADDR1, { tier: 'both', name: 'Test', abi: [ABI_ITEM] });

    const cacheB = cacheModule().createCache();
    expect(cacheB.read('1', ADDR1)).toEqual({ hit: true, kind: 'verified', name: 'Test', abi: [ABI_ITEM] });

    // Promoted — a second read on cacheB hits memory with no further persistence read.
    const spy = vi.spyOn(window.localStorage, 'getItem');
    cacheB.read('1', ADDR1);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('the time-to-live boundary', () => {
  it('an entry aged exactly the time-to-live is a miss; one millisecond younger is a hit', () => {
    const cache = cacheModule().createCache();
    cache.write('1', ADDR1, { tier: 'both', name: 'Test', abi: [ABI_ITEM] });

    vi.setSystemTime(BASE_TIME + cacheModule().CCH_TTL_MS - 1);
    expect(cache.read('1', ADDR1).hit).toBe(true);

    vi.setSystemTime(BASE_TIME + cacheModule().CCH_TTL_MS);
    expect(cache.read('1', ADDR1).hit).toBe(false);
  });

  it('an absent, non-finite, or future stored timestamp is treated as expired', () => {
    const key = entryKey('1', ADDR1);
    const cache = cacheModule().createCache();

    window.localStorage.setItem(key, JSON.stringify({ name: 'ok', abi: [ABI_ITEM] }));
    expect(cache.read('1', ADDR1).hit).toBe(false);

    window.localStorage.setItem(key, JSON.stringify({ ts: Number.NaN, name: 'ok', abi: [ABI_ITEM] }));
    expect(cache.read('1', ADDR1).hit).toBe(false);

    window.localStorage.setItem(key, JSON.stringify({ ts: Date.now() + 1_000_000, name: 'ok', abi: [ABI_ITEM] }));
    expect(cache.read('1', ADDR1).hit).toBe(false);
  });
});

describe('structural validation of a persisted entry — a trust boundary', () => {
  it('a persisted entry whose name is not a string, or whose ABI is not an array, is deleted and reported as a miss rather than promoted', () => {
    const key = entryKey('1', ADDR1);
    const cache = cacheModule().createCache();

    window.localStorage.setItem(key, JSON.stringify({ ts: Date.now(), name: 123, abi: [ABI_ITEM] }));
    expect(cache.read('1', ADDR1).hit).toBe(false);
    expect(window.localStorage.getItem(key)).toBeNull();

    window.localStorage.setItem(key, JSON.stringify({ ts: Date.now(), name: 'ok', abi: 'not-an-array' }));
    expect(cache.read('1', ADDR1).hit).toBe(false);
    expect(window.localStorage.getItem(key)).toBeNull();
  });

  it('an unparseable persisted document, a read that throws, and a write that throws all degrade to the memory tier and never propagate an error', () => {
    const key = entryKey('1', ADDR1);
    const cache = cacheModule().createCache();

    window.localStorage.setItem(key, 'not json{{{');
    expect(() => cache.read('1', ADDR1)).not.toThrow();
    expect(cache.read('1', ADDR1).hit).toBe(false);

    vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => {
      throw new Error('boom');
    });
    expect(() => cache.read('1', ADDR2)).not.toThrow();
    expect(cache.read('1', ADDR2).hit).toBe(false);
    vi.restoreAllMocks();

    vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new Error('boom');
    });
    expect(() => cache.write('1', ADDR1, { tier: 'both', name: 'x', abi: [ABI_ITEM] })).not.toThrow();
    // Memory tier still correct — a write throwing on persistence never propagates.
    expect(cache.read('1', ADDR1)).toEqual({ hit: true, kind: 'verified', name: 'x', abi: [ABI_ITEM] });
  });
});

describe('the memory-tier negative — a distinct answer with its own, shorter time-to-live', () => {
  it('a negative write reads back as kind: negative, distinct from a verified hit', () => {
    const cache = cacheModule().createCache();
    cache.write('1', ADDR1, { tier: 'negative' });
    expect(cache.read('1', ADDR1)).toEqual({ hit: true, kind: 'negative' });
  });

  it('a negative entry never reaches persistence — a fresh cache instance sees no entry at all', () => {
    const cache = cacheModule().createCache();
    cache.write('1', ADDR1, { tier: 'negative' });

    expect(window.localStorage.getItem(entryKey('1', ADDR1))).toBeNull();

    const fresh = cacheModule().createCache();
    expect(fresh.read('1', ADDR1)).toEqual({ hit: false });
  });

  it('a memory-tier negative older than CCH_NEGATIVE_TTL_MS is a miss and is re-fetchable, while a verified entry of the same age is still a hit', () => {
    const cache = cacheModule().createCache();
    cache.write('1', ADDR1, { tier: 'negative' });
    cache.write('1', ADDR2, { tier: 'both', name: 'verified', abi: [ABI_ITEM] });

    vi.setSystemTime(BASE_TIME + cacheModule().CCH_NEGATIVE_TTL_MS - 1);
    expect(cache.read('1', ADDR1)).toEqual({ hit: true, kind: 'negative' });

    vi.setSystemTime(BASE_TIME + cacheModule().CCH_NEGATIVE_TTL_MS + 1);
    expect(cache.read('1', ADDR1).hit).toBe(false); // negative expired
    expect(cache.read('1', ADDR2).hit).toBe(true); // verified, same age, still within the 7-day ttl
  });
});

describe('a verified contract is written to both tiers', () => {
  it('persists under the composed key, and a fresh cache instance serves it from persistence', () => {
    const cache = cacheModule().createCache();
    cache.write('1', ADDR1, { tier: 'both', name: 'ok', abi: [ABI_ITEM] });

    expect(window.localStorage.getItem(entryKey('1', ADDR1))).not.toBeNull();

    const fresh = cacheModule().createCache();
    expect(fresh.read('1', ADDR1)).toEqual({ hit: true, kind: 'verified', name: 'ok', abi: [ABI_ITEM] });
  });
});

describe('the entry-count cap', () => {
  it('writing the entry that would exceed CCH_MAX_ENTRIES evicts the oldest first; writing one below the cap evicts nothing', () => {
    const cache = cacheModule().createCache();
    const MAX = cacheModule().CCH_MAX_ENTRIES;

    for (let i = 0; i < MAX - 1; i++) {
      cache.write('1', addrN(i), { tier: 'both', name: `n${i}`, abi: [ABI_ITEM] });
      vi.setSystemTime(Date.now() + 1);
    }
    // One below the cap (MAX - 1 entries) — nothing evicted yet.
    expect(cache.read('1', addrN(0)).hit).toBe(true);

    // AT the cap (MAX entries) — still nothing evicted.
    cache.write('1', addrN(MAX - 1), { tier: 'both', name: 'atCap', abi: [ABI_ITEM] });
    expect(cache.read('1', addrN(0)).hit).toBe(true);

    // One OVER the cap — the globally oldest entry (addrN(0)) is evicted.
    vi.setSystemTime(Date.now() + 1);
    cache.write('1', addrN(MAX), { tier: 'both', name: 'overCap', abi: [ABI_ITEM] });
    expect(cache.read('1', addrN(0)).hit).toBe(false);
    expect(cache.read('1', addrN(MAX)).hit).toBe(true);
  });
});

describe('the serialized byte cap', () => {
  it('an entry larger than the cap on its own is refused from persistence — the document is not flushed — but is still served from memory', () => {
    const cache = cacheModule().createCache();
    const BIG_NAME = 'x'.repeat(cacheModule().CCH_MAX_SERIALIZED_BYTES);
    cache.write('1', ADDR1, { tier: 'both', name: BIG_NAME, abi: [] });

    expect(cache.read('1', ADDR1).hit).toBe(true); // served from memory
    expect(window.localStorage.getItem(entryKey('1', ADDR1))).toBeNull(); // refused from persistence
  });

  it('writing an entry that would exceed the byte cap evicts oldest-first, from both tiers, until it fits', () => {
    const cache = cacheModule().createCache();
    const HALF = 'y'.repeat(Math.floor(cacheModule().CCH_MAX_SERIALIZED_BYTES * 0.6));

    cache.write('1', ADDR1, { tier: 'both', name: HALF, abi: [] });
    vi.setSystemTime(Date.now() + 1);
    cache.write('1', ADDR2, { tier: 'both', name: HALF, abi: [] });

    expect(cache.read('1', ADDR1).hit).toBe(false); // evicted from both tiers
    expect(cache.read('1', ADDR2).hit).toBe(true);
  });
});

describe('a write the store refuses (quota)', () => {
  it('a write refused once evicts the oldest entry and retries once, and the retry persists', () => {
    const cache = cacheModule().createCache();
    cache.write('1', ADDR1, { tier: 'both', name: 'one', abi: [ABI_ITEM] });
    vi.setSystemTime(Date.now() + 1);

    let calls = 0;
    const real = window.localStorage.setItem.bind(window.localStorage);
    vi.spyOn(window.localStorage, 'setItem').mockImplementation((k: string, v: string) => {
      calls++;
      if (calls === 1) throw new Error('QuotaExceededError');
      return real(k, v);
    });

    expect(() => cache.write('1', ADDR2, { tier: 'both', name: 'two', abi: [ABI_ITEM] })).not.toThrow();

    expect(cache.read('1', ADDR1).hit).toBe(false); // evicted to make room for the retry
    vi.restoreAllMocks();
    expect(window.localStorage.getItem(entryKey('1', ADDR2))).not.toBeNull();
  });

  it('a write refused twice degrades to memory-only for that entry and raises nothing', () => {
    const cache = cacheModule().createCache();
    vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });

    expect(() => cache.write('1', ADDR1, { tier: 'both', name: 'one', abi: [ABI_ITEM] })).not.toThrow();
    vi.restoreAllMocks();

    expect(cache.read('1', ADDR1)).toEqual({ hit: true, kind: 'verified', name: 'one', abi: [ABI_ITEM] });
    expect(window.localStorage.getItem(entryKey('1', ADDR1))).toBeNull();
  });
});

describe('the index — rebuild-by-prefix-scan, never treated as empty', () => {
  it('a deleted or corrupt index is rebuilt from a prefix scan, and the rediscovered entries are then evicted normally rather than orphaned', () => {
    const cache = cacheModule().createCache();
    cache.write('1', ADDR1, { tier: 'both', name: 'one', abi: [ABI_ITEM] });
    vi.setSystemTime(Date.now() + 1);
    cache.write('1', ADDR2, { tier: 'both', name: 'two', abi: [ABI_ITEM] });

    // Simulate a lost index.
    window.localStorage.setItem(cacheModule().CCH_INDEX_KEY, 'not json');

    const fresh = cacheModule().createCache();
    expect(fresh.read('1', ADDR1)).toEqual({ hit: true, kind: 'verified', name: 'one', abi: [ABI_ITEM] });
    expect(fresh.read('1', ADDR2)).toEqual({ hit: true, kind: 'verified', name: 'two', abi: [ABI_ITEM] });

    // Fill up to the cap with NEW entries — this forces loadIndex() to rebuild (the first write
    // on this fresh instance) — and prove the rediscovered ADDR1 (the globally oldest entry) is
    // evicted like any other, not silently orphaned by a corrupt index treated as empty.
    const MAX = cacheModule().CCH_MAX_ENTRIES;
    for (let i = 0; i < MAX - 1; i++) {
      vi.setSystemTime(Date.now() + 1);
      fresh.write('1', addrN(i), { tier: 'both', name: `n${i}`, abi: [ABI_ITEM] });
    }
    vi.setSystemTime(Date.now() + 1);
    fresh.write('1', addrN(MAX), { tier: 'both', name: 'trigger', abi: [ABI_ITEM] });

    expect(fresh.read('1', ADDR1).hit).toBe(false); // evicted, proven not orphaned
  });

  it('the index key is not itself returned by the entry prefix scan and is never promoted as an ABI', () => {
    const cache = cacheModule().createCache();
    cache.write('1', ADDR1, { tier: 'both', name: 'one', abi: [ABI_ITEM] });
    window.localStorage.setItem(cacheModule().CCH_INDEX_KEY, 'not json'); // force a rebuild
    cache.write('1', ADDR2, { tier: 'both', name: 'two', abi: [ABI_ITEM] }); // triggers loadIndex()

    const idxRaw = window.localStorage.getItem(cacheModule().CCH_INDEX_KEY);
    const idx = JSON.parse(idxRaw as string) as Array<[string, number, number]>;
    expect(idx.some(([k]) => k === cacheModule().CCH_INDEX_KEY)).toBe(false);
  });
});

describe('the persisted key shape (handoff §5.4)', () => {
  it('CCH_KEY_PREFIX is exactly dxdecode:abi:, and a composed entry key is exactly that prefix, the chain id, a colon, and the address', () => {
    expect(cacheModule().CCH_KEY_PREFIX).toBe('dxdecode:abi:');

    const cache = cacheModule().createCache();
    cache.write('1', ADDR1, { tier: 'both', name: 'x', abi: [] });
    expect(window.localStorage.getItem(`dxdecode:abi:1:${ADDR1}`)).not.toBeNull();
  });

  it('CCH_INDEX_KEY does not start with CCH_KEY_PREFIX, so the entry prefix scan cannot enumerate it', () => {
    expect(cacheModule().CCH_INDEX_KEY).toBe('dxdecode:abi-index');
    expect(cacheModule().CCH_INDEX_KEY.startsWith(cacheModule().CCH_KEY_PREFIX)).toBe(false);
  });
});

describe('the persisted representation is one key per entry plus the index key, never a single monolithic document', () => {
  it('two written entries and the index occupy exactly three keys', () => {
    const cache = cacheModule().createCache();
    cache.write('1', ADDR1, { tier: 'both', name: 'one', abi: [ABI_ITEM] });
    cache.write('1', ADDR2, { tier: 'both', name: 'two', abi: [ABI_ITEM] });

    const keys: string[] = [];
    for (let i = 0; i < window.localStorage.length; i++) keys.push(window.localStorage.key(i) as string);

    expect(keys).toContain(entryKey('1', ADDR1));
    expect(keys).toContain(entryKey('1', ADDR2));
    expect(keys).toContain(cacheModule().CCH_INDEX_KEY);
    expect(keys.length).toBe(3);
  });
});

describe('a browser that refuses persistence entirely degrades to the in-memory tier', () => {
  it('every persistence call throwing still serves reads and writes from memory, with no thrown error', () => {
    vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => {
      throw new Error('refused');
    });
    vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new Error('refused');
    });
    vi.spyOn(window.localStorage, 'removeItem').mockImplementation(() => {
      throw new Error('refused');
    });

    const cache = cacheModule().createCache();
    expect(() => cache.write('1', ADDR1, { tier: 'both', name: 'ok', abi: [ABI_ITEM] })).not.toThrow();
    expect(cache.read('1', ADDR1)).toEqual({ hit: true, kind: 'verified', name: 'ok', abi: [ABI_ITEM] });
  });
});
