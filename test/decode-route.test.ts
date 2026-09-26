// Proves the exact routing gap this plan's Task 1 exists to close, and reverse — see
// .planning/phases/03-decode-dapp-shell-the-decodenode-contract/03-06-PLAN.md's
// <route_canonicalization_decision>.
//
// Two independent things are tested here, deliberately in one file rather than two:
// 1. The FRAMEWORK's own router, loaded from the real vendored build, does not resolve a hash
//    route carrying a query string unless a slash separates the route from the '?' — asserted
//    against `../dxkit`'s real `createRouter`/`resolve`, never a re-implementation of its
//    matching rule, which would agree with whatever this task assumed and prove nothing.
// 2. The SHELL-level canonicalizer in src/main.ts (not part of the decode dapp — see the plan's
//    route_canonicalization_decision for why) rewrites the non-routable form into the routable
//    one, idempotently, via a history replacement rather than a push.
//
// The canonicalizer is executed in isolation — its own source extracted from src/main.ts by
// brace-matching and run against a small fake `window` — rather than by loading the whole
// compiled main.js, because main.ts's top-level code also constructs the real DxKit shell
// (DxKit.createShell(...), immediately, at module scope) and would need every plugin factory
// (DxSettings, DxTheme, DnznEthereum, DxWallet) live just to load without throwing. The
// function under test has no dependency on any of that; isolating it keeps this suite about
// the canonicalizer, not about booting the whole shell.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';

const MAIN_PATH = resolve(__dirname, '../src/main.ts');
const VENDOR_ROUTER_PATH = resolve(__dirname, '../src/vendor/dxkit/index.global.js');
const DECODE_MANIFEST_PATH = resolve(__dirname, '../src/dapps/decode/manifest.json');
const DECODE_DIR = resolve(__dirname, '../src/dapps/decode');

type FakeRouter = { resolve(path: string): { id: string } | null };
type FakeDxKit = { createRouter(config: { mode: string; basePath: string; manifests: unknown[] }): FakeRouter };

function loadDxKit(): FakeDxKit {
  const code = readFileSync(VENDOR_ROUTER_PATH, 'utf-8');
  // `var DxKit = (() => {...})()` is a top-level `var` in the vendored bundle — `new Function`
  // keeps that local to its own body, so it is recovered the same way test/shell-wallet.test.ts
  // recovers DxWallet: append a `return` of the name the bundle assigns.
  return new Function(`${code}\nreturn DxKit;`)() as FakeDxKit;
}

// ── The framework router — the gap itself ──────────────────────────────────────────────────

// src/vendor/ is gitignored and produced by `make vendor` from the ../dxkit sibling checkout, so
// CI, a fork, and a fresh clone all legitimately lack it. Gate on presence the same way
// test/shell-wallet.test.ts:1848 does — and keep the load INSIDE makeRouter(), because a skipped
// describe still has its body evaluated during collection: a `const DxKit = loadDxKit()` at body
// top level throws ENOENT before skipIf can spare it, which is exactly how this file used to fail.
const hasVendoredRouter = existsSync(VENDOR_ROUTER_PATH);

describe.skipIf(!hasVendoredRouter)(
  'the framework router — the exact routing gap this task exists to close (skipped — src/vendor/ ' +
    'absent, no ../dxkit checkout to vendor from in this environment/CI)',
  () => {
    const decodeManifest = JSON.parse(readFileSync(DECODE_MANIFEST_PATH, 'utf-8'));

    function makeRouter(): FakeRouter {
      return loadDxKit().createRouter({ mode: 'hash', basePath: '/', manifests: [decodeManifest] });
    }

    it('resolves the canonical slash form (route, then slash, then the query) to the decode manifest', () => {
      const router = makeRouter();
      const resolved = router.resolve('/tools/decode/?decoder=hex&data=0x68656c6c6f');
      expect(resolved?.id).toBe('decode');
    });

    it(
      'does NOT resolve the non-canonical form (no slash before the query) — this is the ' +
        'framework gap, not a repo bug. If this case ever starts passing, the framework has been ' +
        'fixed upstream and this whole task (and tmp/dxkit-bug-router-hash-query.md) can be deleted',
      () => {
        const router = makeRouter();
        const resolved = router.resolve('/tools/decode?decoder=hex&data=0x68656c6c6f');
        expect(resolved).toBeNull();
      },
    );

    it('resolves the canonical form with no query string at all, same as any other route', () => {
      const router = makeRouter();
      expect(router.resolve('/tools/decode')?.id).toBe('decode');
    });
  },
);

// ── The canonicalizer in src/main.ts ────────────────────────────────────────────────────────

function extractFunctionSource(source: string, name: string): string {
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  if (start === -1) throw new Error(`function ${name} not found in ${MAIN_PATH}`);
  const braceStart = source.indexOf('{', start);
  let depth = 0;
  let end = braceStart;
  for (; end < source.length; end++) {
    if (source[end] === '{') depth++;
    else if (source[end] === '}') {
      depth--;
      if (depth === 0) {
        end++;
        break;
      }
    }
  }
  return source.slice(start, end);
}

type FakeWindow = {
  location: { hash: string };
  history: { replaceState: ReturnType<typeof vi.fn>; pushState: ReturnType<typeof vi.fn> };
};

function makeFakeWindow(hash: string): FakeWindow {
  return {
    location: { hash },
    history: { replaceState: vi.fn(), pushState: vi.fn() },
  };
}

// `new Function` parses plain JS only — the extracted source is still TypeScript, so its one
// type annotation (the `: void` return type) has to go before it can run. A targeted strip
// (not a general TS-stripping tool) is enough: this function's own signature is the only thing
// extracted, and it has exactly one annotation to remove.
function stripReturnTypeAnnotation(source: string): string {
  return source.replace(/\)\s*:\s*void\s*\{/, ') {');
}

function runCanonicalizer(hash: string): FakeWindow {
  const mainSource = readFileSync(MAIN_PATH, 'utf-8');
  const fnSource = stripReturnTypeAnnotation(extractFunctionSource(mainSource, 'canonicalizeHashQuery'));
  const fakeWindow = makeFakeWindow(hash);
  const factory = new Function('window', `${fnSource}\nreturn canonicalizeHashQuery;`);
  const canonicalize = factory(fakeWindow) as () => void;
  canonicalize();
  return fakeWindow;
}

describe('the canonicalizer in src/main.ts', () => {
  it('inserts a separating slash before the query string, via a history replacement', () => {
    const fw = runCanonicalizer('#/tools/decode?decoder=hex&data=abc');
    expect(fw.history.replaceState).toHaveBeenCalledTimes(1);
    expect(fw.history.pushState).not.toHaveBeenCalled();
    const [, , url] = fw.history.replaceState.mock.calls[0];
    expect(url).toBe('#/tools/decode/?decoder=hex&data=abc');
  });

  it('is idempotent — running it again on its own output changes nothing', () => {
    const fw = runCanonicalizer('#/tools/decode/?decoder=hex&data=abc');
    expect(fw.history.replaceState).not.toHaveBeenCalled();
    expect(fw.history.pushState).not.toHaveBeenCalled();
  });

  it('leaves a hash with no query string untouched', () => {
    const fw = runCanonicalizer('#/tools/decode');
    expect(fw.history.replaceState).not.toHaveBeenCalled();
  });

  it('leaves the bare root hash untouched', () => {
    expect(runCanonicalizer('').history.replaceState).not.toHaveBeenCalled();
    expect(runCanonicalizer('#').history.replaceState).not.toHaveBeenCalled();
  });

  it('leaves a hash whose question mark has no route segment before it untouched', () => {
    const fw = runCanonicalizer('#?data=abc');
    expect(fw.history.replaceState).not.toHaveBeenCalled();
  });
});

describe('main.ts wiring — the canonicalizer runs before the shell is constructed', () => {
  const mainSource = readFileSync(MAIN_PATH, 'utf-8');

  it('calls canonicalizeHashQuery() once at module scope before createShell', () => {
    const callAt = mainSource.indexOf('canonicalizeHashQuery();');
    const shellAt = mainSource.indexOf('DxKit.createShell(');
    expect(callAt).toBeGreaterThan(-1);
    expect(shellAt).toBeGreaterThan(-1);
    expect(callAt).toBeLessThan(shellAt);
  });

  it('registers canonicalizeHashQuery as a hashchange listener before createShell', () => {
    const listenAt = mainSource.indexOf("addEventListener('hashchange', canonicalizeHashQuery)");
    const shellAt = mainSource.indexOf('DxKit.createShell(');
    expect(listenAt).toBeGreaterThan(-1);
    expect(listenAt).toBeLessThan(shellAt);
  });
});

describe('portability — the canonicalization never lives inside the decode dapp directory', () => {
  it('no .ts file under src/dapps/decode/ references canonicalizeHashQuery', () => {
    expect(existsSync(DECODE_DIR)).toBe(true);
    const files = readdirSync(DECODE_DIR).filter((f) => f.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const content = readFileSync(resolve(DECODE_DIR, f), 'utf-8');
      expect(content).not.toContain('canonicalizeHashQuery');
    }
  });
});

// ── The dapp's own query parser tolerates both link forms ──────────────────────────────────

type CoreWithParse = { parseDecodeQuery(path: string): { decoder?: string; data?: string; z?: string } };

function loadCompiledCore(): CoreWithParse {
  const code = readFileSync(resolve(__dirname, '../src/dapps/decode/core.js'), 'utf-8');
  new Function('window', code)(window);
  return (window as unknown as { DxDecode: { core: CoreWithParse } }).DxDecode.core;
}

describe("decode's own query parser — tolerant of both link forms", () => {
  it('returns identical results for the routed path with and without the separating slash', () => {
    const core = loadCompiledCore();
    const withSlash = core.parseDecodeQuery('/tools/decode/?decoder=hex&data=abc');
    const withoutSlash = core.parseDecodeQuery('/tools/decode?decoder=hex&data=abc');
    expect(withSlash).toEqual(withoutSlash);
    expect(withSlash).toEqual({ decoder: 'hex', data: 'abc' });
  });

  it('returns an empty object for a routed path with no query string, without throwing', () => {
    const core = loadCompiledCore();
    expect(() => core.parseDecodeQuery('/tools/decode')).not.toThrow();
    expect(core.parseDecodeQuery('/tools/decode')).toEqual({});
  });
});

// ── DEC-04: the `calldata=` alias ────────────────────────────────────────────────────────────

describe('the calldata query alias (DEC-04)', () => {
  it('a bare calldata parameter implies decoder eth-calldata and supplies data', () => {
    const core = loadCompiledCore();
    expect(core.parseDecodeQuery('/tools/decode/?calldata=0xabcd')).toEqual({
      decoder: 'eth-calldata',
      data: '0xabcd',
    });
  });

  it('an explicit decoder wins over the alias implication', () => {
    const core = loadCompiledCore();
    const result = core.parseDecodeQuery('/tools/decode/?calldata=0xabcd&decoder=hex');
    expect(result.decoder).toBe('hex');
    expect(result.data).toBe('0xabcd');
  });

  it('an explicit data parameter wins over calldata as the payload source, while the decoder implication still stands', () => {
    const core = loadCompiledCore();
    const result = core.parseDecodeQuery('/tools/decode/?calldata=0xabcd&data=0xffff');
    expect(result.data).toBe('0xffff');
    expect(result.decoder).toBe('eth-calldata');
  });

  it('an empty calldata= still supplies data: "" and still implies the decoder', () => {
    const core = loadCompiledCore();
    expect(core.parseDecodeQuery('/tools/decode/?calldata=')).toEqual({
      decoder: 'eth-calldata',
      data: '',
    });
  });

  it('a path with no query string is unaffected — still an empty object', () => {
    const core = loadCompiledCore();
    expect(core.parseDecodeQuery('/tools/decode')).toEqual({});
  });

  it('the pre-existing router and canonicalizer suites above are untouched by this alias', () => {
    // Both halves — the framework router's own non-slash-form gap, and the src/main.ts
    // canonicalizer that closes it — are asserted in their own describe blocks above and are
    // not re-asserted here; this test exists only to document that this alias adds a THIRD,
    // independent parsing rule rather than replacing either of the first two.
    const core = loadCompiledCore();
    expect(core.parseDecodeQuery('/tools/decode/?decoder=hex&data=0x68656c6c6f')).toEqual({
      decoder: 'hex',
      data: '0x68656c6c6f',
    });
  });
});

// ── DEC-04: the alias reaches the mounted UI, not just the parser ──────────────────────────

function loadManifestDependencies(): string[] {
  const manifest = JSON.parse(readFileSync(DECODE_MANIFEST_PATH, 'utf-8')) as { dependencies: string[] };
  return manifest.dependencies.map((dep) => `../src/${dep}`);
}

function loadCompiledModule(relPath: string): void {
  const code = readFileSync(resolve(__dirname, relPath), 'utf-8');
  new Function('window', code)(window);
}

function loadDecodeTemplate(): string {
  return readFileSync(resolve(DECODE_DIR, 'template.html'), 'utf-8');
}

describe('DEC-04 driven through the mounted dapp — the calldata alias selects the decoder and fills the textarea', () => {
  beforeAll(() => {
    for (const dep of loadManifestDependencies()) loadCompiledModule(dep);
  });

  it('mounting with a calldata query selects eth-calldata in the selector and fills the textarea with the payload', () => {
    const core = (window as unknown as { DxDecode: { core: CoreWithParse } }).DxDecode.core;
    const ui = (
      window as unknown as {
        DxDecode: { ui: { init(c: HTMLElement, dx: unknown, q?: unknown): () => void } };
      }
    ).DxDecode.ui;

    const container = document.createElement('div');
    container.innerHTML = loadDecodeTemplate();
    document.body.append(container);

    const query = core.parseDecodeQuery('/tools/decode/?calldata=0xabcd');
    const cleanup = ui.init(container, {}, query);

    const selector = container.querySelector<HTMLSelectElement>('#decode-selector');
    const textarea = container.querySelector<HTMLTextAreaElement>('#decode-textarea');
    expect(selector?.value).toBe('eth-calldata');
    expect(textarea?.value).toBe('0xabcd');

    cleanup();
    container.remove();
  });
});
