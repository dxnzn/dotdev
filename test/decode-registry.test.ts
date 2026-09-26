import { readdirSync, readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

// Pure state/logic coverage of core.ts's registry and decode service — no DOM fixture,
// following test/settings-diff.test.ts's DOM-free shape while loading the COMPILED core.js
// into the jsdom `window` the way test/decode-ui.test.ts does. core.js's own top-level code
// unconditionally recreates window.DxDecode.registry/.log/.core on every load (there is no
// reset()/clear() on the registry port), so reloading it fresh in beforeEach is what gives
// every test in this file full isolation without any manual teardown.
function loadCompiled(relPath: string) {
  const code = readFileSync(resolvePath(__dirname, relPath), 'utf-8');
  new Function('window', code)(window);
}

beforeEach(() => {
  loadCompiled('../src/dapps/decode/core.js');
});

function registry(): DecoderRegistry {
  return window.DxDecode!.registry as DecoderRegistry;
}

function makeStubDecoder(overrides: { id: string } & Partial<DecoderPort>): DecoderPort {
  return {
    id: overrides.id,
    label: overrides.label ?? overrides.id,
    settings: overrides.settings ?? [],
    canDecode: overrides.canDecode ?? (() => 0),
    decode: overrides.decode ?? (async () => ({ node: { label: overrides.id } })),
  };
}

const NULL_LINKS: LinkPort = { address: () => null, tx: () => null };

describe('DecoderRegistry (via window.DxDecode.registry)', () => {
  it('returns registrations in registration order, and a duplicate id leaves the list unchanged', () => {
    registry().register(makeStubDecoder({ id: 'a' }));
    registry().register(makeStubDecoder({ id: 'b' }));
    registry().register(makeStubDecoder({ id: 'a', label: 'ignored-duplicate' }));

    expect(
      registry()
        .list()
        .map((d) => d.id),
    ).toEqual(['a', 'b']);
    expect(registry().size()).toBe(2);
    expect(registry().get('a')!.label).toBe('a');
  });

  it('reports zero size when nothing is registered, and get(unknown) returns undefined without throwing', () => {
    expect(registry().size()).toBe(0);
    expect(registry().list()).toEqual([]);
    expect(() => registry().get('missing')).not.toThrow();
    expect(registry().get('missing')).toBeUndefined();
  });

  it('a decoders module loaded twice still registers exactly one hex decoder', () => {
    loadCompiled('../src/dapps/decode/codecs.js');
    loadCompiled('../src/dapps/decode/decoders.js');
    loadCompiled('../src/dapps/decode/decoders.js');

    expect(registry().size()).toBe(1);
    expect(registry().get('hex')).toBeDefined();
  });
});

describe('createDecodeService', () => {
  function core(): DxDecodeCoreModule {
    return window.DxDecode!.core as DxDecodeCoreModule;
  }

  function makeService(overrideRegistry?: DecoderRegistry) {
    return core().createDecodeService({
      registry: overrideRegistry ?? registry(),
      settings: core().createNullSettingsPort(),
      log: window.DxDecode!.log!,
      links: NULL_LINKS,
    });
  }

  it('passes a decoder exactly the settings keys it declared, as a flat snapshot', async () => {
    let received: Record<string, unknown> | undefined;
    registry().register(
      makeStubDecoder({
        id: 'needs-settings',
        settings: [
          { key: 'a', required: false, why: 'test' },
          { key: 'b', required: false, why: 'test' },
        ],
        decode: async (_input, ctx) => {
          received = ctx.settings;
          return { node: { label: 'ok' } };
        },
      }),
    );

    const store: Record<string, unknown> = { a: 1, b: 2, c: 3 };
    const service = core().createDecodeService({
      registry: registry(),
      settings: { get: (key) => store[key] },
      log: window.DxDecode!.log!,
      links: NULL_LINKS,
    });

    await service.decode('needs-settings', 'x');
    expect(received).toEqual({ a: 1, b: 2 });
  });

  it('a decoder declaring no settings receives an empty record', async () => {
    let received: Record<string, unknown> | undefined;
    registry().register(
      makeStubDecoder({
        id: 'no-settings',
        decode: async (_input, ctx) => {
          received = ctx.settings;
          return { node: { label: 'ok' } };
        },
      }),
    );

    await makeService().decode('no-settings', 'x');
    expect(received).toEqual({});
  });

  it('an unknown decoder id resolves to an error node rather than rejecting', async () => {
    await expect(makeService().decode('missing', 'x')).resolves.toMatchObject({
      node: { error: expect.any(String) },
    });
  });

  it('a decoder that throws resolves to an error node, not a rejection', async () => {
    registry().register(
      makeStubDecoder({
        id: 'throws',
        decode: async () => {
          throw new Error('boom');
        },
      }),
    );

    const result = await makeService().decode('throws', 'x');
    expect(result.node.error).toContain('boom');
  });

  it('a decoder that rejects also resolves to an error node, not a rejection', async () => {
    registry().register(makeStubDecoder({ id: 'rejects', decode: () => Promise.reject(new Error('nope')) }));

    const result = await makeService().decode('rejects', 'x');
    expect(result.node.error).toContain('nope');
  });

  it('an already-aborted signal resolves without the decoder body having run, and stale is true', async () => {
    let calls = 0;
    registry().register(
      makeStubDecoder({
        id: 'counted',
        decode: async () => {
          calls++;
          return { node: { label: 'counted' } };
        },
      }),
    );

    const controller = new AbortController();
    controller.abort();
    const result = await makeService().decode('counted', 'x', { signal: controller.signal });

    expect(calls).toBe(0);
    expect(result.stale).toBe(true);
  });

  it('a signal that aborts while the decoder is in flight resolves with stale true', async () => {
    const controller = new AbortController();
    registry().register(
      makeStubDecoder({
        id: 'slow',
        decode: async () => {
          controller.abort();
          return { node: { label: 'slow' } };
        },
      }),
    );

    const result = await makeService().decode('slow', 'x', { signal: controller.signal });
    expect(result.stale).toBe(true);
  });

  it('a normally-completed decode resolves with stale false', async () => {
    registry().register(makeStubDecoder({ id: 'normal' }));
    const result = await makeService().decode('normal', 'x');
    expect(result.stale).toBe(false);
  });

  it('every resolved result carries node/rawBytes/rawView/stale, defaulting rawView and rawBytes', async () => {
    registry().register(makeStubDecoder({ id: 'bare', decode: async () => ({ node: { label: 'bare' } }) }));
    const result = await makeService().decode('bare', 'x');
    expect(result).toEqual({ node: { label: 'bare' }, rawBytes: null, rawView: 'hex-dump', stale: false });
  });
});

// types.d.ts's DxDecodeCoreModule (frozen, read-only per plan 03-01's Task 0 checkpoint) does
// not declare createLiveLogStore/createExplorerLinks/resolve/LOG_CAPACITY — core.ts's own new
// members this plan attaches. Surfaced here with the same local-extension pattern decoders.ts
// uses for HexCodecWithNormalize, rather than editing the shared, single-owner contract file.
interface AutoDetectResolution {
  decoderId: string | null;
  score: number;
  reason: string;
}

interface CoreModuleWithHelpers extends DxDecodeCoreModule {
  createLiveLogStore(): LogPort;
  createExplorerLinks(chainId: number | string): LinkPort;
  resolve(input: string): AutoDetectResolution;
  LOG_CAPACITY: number;
}

function coreWithResolver(): CoreModuleWithHelpers {
  return window.DxDecode!.core as CoreModuleWithHelpers;
}

describe('resolve — auto-detect resolution (D-22/D-23)', () => {
  it('returns the higher-scoring decoder when it clears the threshold and the other does not', () => {
    registry().register(makeStubDecoder({ id: 'low', canDecode: () => 0.3 }));
    registry().register(makeStubDecoder({ id: 'high', canDecode: () => 0.8 }));

    const result = coreWithResolver().resolve('input');
    expect(result.decoderId).toBe('high');
    expect(result.score).toBe(0.8);
  });

  it('declines with a non-empty reason, not a least-bad option, when every score is below the threshold', () => {
    registry().register(makeStubDecoder({ id: 'a', canDecode: () => 0.1 }));
    registry().register(makeStubDecoder({ id: 'b', canDecode: () => 0.2 }));

    const result = coreWithResolver().resolve('input');
    expect(result.decoderId).toBeNull();
    expect(result.reason.length).toBeGreaterThan(0);
  });

  it('breaks an exact tie by registration order', () => {
    registry().register(makeStubDecoder({ id: 'first', canDecode: () => 0.7 }));
    registry().register(makeStubDecoder({ id: 'second', canDecode: () => 0.7 }));

    expect(coreWithResolver().resolve('input').decoderId).toBe('first');
  });

  it('reverses the tie-break answer when registration order is reversed', () => {
    registry().register(makeStubDecoder({ id: 'second', canDecode: () => 0.7 }));
    registry().register(makeStubDecoder({ id: 'first', canDecode: () => 0.7 }));

    expect(coreWithResolver().resolve('input').decoderId).toBe('second');
  });

  it('an out-of-range or non-finite score scores zero and loses to a legitimate 0.4 (below threshold)', () => {
    // 0.4 is deliberately BELOW AUTO_DETECT_THRESHOLD (0.5): a correct zero-sanitizing
    // resolver sees every candidate score at or below 0.4 and declines (nothing clears the
    // threshold). A clamping implementation instead clamps 1.4 down to 1.0, which DOES clear
    // the threshold and wins outright — resolving to the broken decoder. This pairing is what
    // catches that difference; asserting only that 0.4 "wins" a same-scores-cleared comparison
    // would pass a clamping implementation too.
    registry().register(makeStubDecoder({ id: 'too-high', canDecode: () => 1.4 }));
    registry().register(makeStubDecoder({ id: 'too-low', canDecode: () => -0.5 }));
    registry().register(makeStubDecoder({ id: 'not-finite', canDecode: () => Number.NaN }));
    registry().register(makeStubDecoder({ id: 'legit', canDecode: () => 0.4 }));

    expect(coreWithResolver().resolve('input').decoderId).toBeNull();
  });

  it('a canDecode that throws scores zero and does not stop the rest from being scored', () => {
    registry().register(
      makeStubDecoder({
        id: 'throws',
        canDecode: () => {
          throw new Error('boom');
        },
      }),
    );
    registry().register(makeStubDecoder({ id: 'fine', canDecode: () => 0.9 }));

    expect(coreWithResolver().resolve('input').decoderId).toBe('fine');
  });

  it('is synchronous — returns a plain value, not a promise', () => {
    registry().register(makeStubDecoder({ id: 'x', canDecode: () => 0.9 }));
    const result = coreWithResolver().resolve('input');
    expect(typeof (result as { then?: unknown }).then).not.toBe('function');
  });

  it('a score just above the shared threshold resolves', () => {
    registry().register(
      makeStubDecoder({ id: 'above', canDecode: () => coreWithResolver().AUTO_DETECT_THRESHOLD + 0.01 }),
    );
    expect(coreWithResolver().resolve('input').decoderId).toBe('above');
  });

  it('a score just below the shared threshold does not resolve', () => {
    registry().register(
      makeStubDecoder({ id: 'below', canDecode: () => coreWithResolver().AUTO_DETECT_THRESHOLD - 0.01 }),
    );
    expect(coreWithResolver().resolve('input').decoderId).toBeNull();
  });
});

function makeLogEntry(n: number): LogEntry {
  return { timestamp: n, method: 'GET', host: 'example.test', path: `/${n}`, status: 200, duration: 1, attempt: 1 };
}

describe('createLiveLogStore', () => {
  it('caps at LOG_CAPACITY, evicting only the oldest entry on overflow', () => {
    const store = coreWithResolver().createLiveLogStore();
    const cap = coreWithResolver().LOG_CAPACITY;

    for (let i = 0; i < cap; i++) store.record(makeLogEntry(i));

    let latest: LogEntry[] = [];
    store.subscribe((entries) => {
      latest = entries;
    });
    expect(latest).toHaveLength(cap);
    expect(latest[0].path).toBe('/0');

    store.record(makeLogEntry(cap));
    expect(latest).toHaveLength(cap);
    expect(latest[0].path).toBe('/1');
    expect(latest[latest.length - 1].path).toBe(`/${cap}`);
  });

  it('delivers the entries already in the buffer immediately on subscribe', () => {
    const store = coreWithResolver().createLiveLogStore();
    store.record(makeLogEntry(1));

    let received: LogEntry[] | undefined;
    store.subscribe((entries) => {
      received = entries;
    });
    expect(received).toHaveLength(1);
  });

  it('notifies on record and on clear; the returned unsubscribe stops further notification', () => {
    const store = coreWithResolver().createLiveLogStore();
    const sizes: number[] = [];
    const unsubscribe = store.subscribe((entries) => sizes.push(entries.length));

    store.record(makeLogEntry(1));
    store.clear();
    unsubscribe();
    store.record(makeLogEntry(2));

    expect(sizes).toEqual([0, 1, 0]);
  });

  it('entries recorded before and after an unrelated record are both still readable — only clear empties it', () => {
    const store = coreWithResolver().createLiveLogStore();
    store.record(makeLogEntry(1));
    store.record(makeLogEntry(2));

    let latest: LogEntry[] = [];
    store.subscribe((entries) => {
      latest = entries;
    });
    expect(latest.map((e) => e.path)).toEqual(['/1', '/2']);
  });
});

describe('createExplorerLinks', () => {
  it('returns non-null address and tx URLs for a known chain, and null for both on an unknown one', () => {
    const links = coreWithResolver().createExplorerLinks(1);
    expect(links.address('0xabc')).toMatch(/^https:\/\//);
    expect(links.tx('0xdef')).toMatch(/^https:\/\//);

    const unknown = coreWithResolver().createExplorerLinks(999999);
    expect(unknown.address('0xabc')).toBeNull();
    expect(unknown.tx('0xdef')).toBeNull();
  });

  it('answers identically for the chain id as the number 1 and as the string "1"', () => {
    const numeric = coreWithResolver().createExplorerLinks(1);
    const stringForm = coreWithResolver().createExplorerLinks('1');
    expect(stringForm.address('0xabc')).toBe(numeric.address('0xabc'));
    expect(stringForm.tx('0xdef')).toBe(numeric.tx('0xdef'));
  });

  it("the dapp's local chain table matches the shell plugin's exported table (test-only read — see D-11/03-04)", () => {
    loadCompiled('../src/plugins/ethereum.js');
    const pluginChains = (window as unknown as { DnznEthereum: { CHAINS: { chainId: number; explorer: string }[] } })
      .DnznEthereum.CHAINS;

    expect(pluginChains.length).toBeGreaterThan(0);
    for (const chain of pluginChains) {
      const links = coreWithResolver().createExplorerLinks(chain.chainId);
      expect(links.address('0xabc')).toBe(`${chain.explorer}/address/0xabc`);
    }
  });
});

describe('findSettingsRoute', () => {
  it("returns the settings dapp's own declared route from a stub shell", () => {
    const stubShell = { getManifests: () => [{ id: 'settings', route: '/config/prefs' }] };
    expect(coreWithResolver().findSettingsRoute!(stubShell)).toBe('/config/prefs');
  });

  it('returns null when the shell reports no settings manifest', () => {
    const stubShell = { getManifests: () => [{ id: 'about', route: '/' }] };
    expect(coreWithResolver().findSettingsRoute!(stubShell)).toBeNull();
  });

  it('returns null when the shell exposes no manifest accessor at all', () => {
    expect(coreWithResolver().findSettingsRoute!({})).toBeNull();
    expect(coreWithResolver().findSettingsRoute!(undefined)).toBeNull();
  });
});

// WR-03: same shape as findSettingsRoute, mirrored for decode's OWN route.
describe('findOwnRoute', () => {
  it("returns decode's own declared route from a stub shell", () => {
    const stubShell = { getManifests: () => [{ id: 'decode', route: '/tools/decode' }] };
    expect(coreWithResolver().findOwnRoute!(stubShell)).toBe('/tools/decode');
  });

  it('returns null when the shell reports no decode manifest', () => {
    const stubShell = { getManifests: () => [{ id: 'about', route: '/' }] };
    expect(coreWithResolver().findOwnRoute!(stubShell)).toBeNull();
  });

  it('returns null when the shell exposes no manifest accessor at all', () => {
    expect(coreWithResolver().findOwnRoute!({})).toBeNull();
    expect(coreWithResolver().findOwnRoute!(undefined)).toBeNull();
  });
});

describe('portability — no coupling to this shell introduced by core.ts', () => {
  it('no .ts source file under src/dapps/decode names this shell’s plugin settings section or global', () => {
    const dir = resolvePath(__dirname, '../src/dapps/decode');
    const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const text = readFileSync(resolvePath(dir, file), 'utf-8');
      expect(text).not.toMatch(/ethereum/i);
      expect(text).not.toMatch(/DnznEthereum/);
    }
  });
});
