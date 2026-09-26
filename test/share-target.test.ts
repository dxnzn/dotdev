// SHARE-01/02/05: the shared header share-button override port. This suite exercises the REAL
// compiled src/share-target.js against the REAL compiled src/shell.js — SHARE-05's claim is that
// the shell's own default (window.location.href, wireShareButton) is untouched by this helper's
// existence, so a stand-in header would not prove it. Loader pattern matches
// test/shell.test.ts's own jsdom-executing describe block and test/shell-wallet.test.ts's
// multi-module loader.

import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// src/share-target.js assigns its own namespace (window.DnznShareTarget), so — like
// src/shell-wallet.js — it needs no `window.x = x` trampoline appended.
function loadShareTarget() {
  const code = readFileSync(resolve(__dirname, '../src/share-target.js'), 'utf-8');
  new Function('window', code)(window);
}

// Copied from test/shell.test.ts's own loader/fixture/stub trio — there is no shared test
// helper module in this repo, and inventing one is out of scope for this plan.
function loadShell() {
  const code = readFileSync(resolve(__dirname, '../src/shell.js'), 'utf-8');
  const exposed = `${code}\nwindow.initShellChrome = initShellChrome;\n`;
  new Function('window', exposed)(window);
}

function buildFixture() {
  document.head.innerHTML = '<meta name="theme-color" content=""><link rel="icon" href="">';
  document.body.innerHTML =
    '<header id="shell-header"></header><footer id="shell-footer"></footer><img class="title-icon">';
}

function makeThemeStub() {
  return {
    getTheme: () => 'zorgz-2625',
    getResolvedMode: () => 'dark',
    getMode: () => 'system',
    setMode: vi.fn(),
    setTheme: vi.fn(),
  };
}

function makeShellDxStub(manifests: any[]) {
  const routeState = { path: '/' };
  const eventHandlers: Record<string, Array<(payload?: any) => void>> = {};
  const theme = makeThemeStub();
  return {
    getPlugin: (name: string) => (name === 'theme' ? theme : undefined),
    getEnabledManifests: () => manifests,
    router: {
      getCurrentPath: () => routeState.path,
      navigate: vi.fn((path: string) => {
        routeState.path = path;
      }),
    },
    events: {
      on: (name: string, fn: (payload?: any) => void) => {
        if (!eventHandlers[name]) eventHandlers[name] = [];
        eventHandlers[name].push(fn);
        return { off() {} };
      },
    },
    _eventHandlers: eventHandlers,
    _theme: theme,
  };
}

// Mirrors test/decode-url.test.ts's own clipboard-stub shape.
function installClipboard(writeText: ReturnType<typeof vi.fn>) {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
}
function removeClipboard() {
  delete (navigator as unknown as { clipboard?: unknown }).clipboard;
}

// A `flush` helper already exists in test/decode-url.test.ts; copied here for the same reason —
// the helper's own work is async even when the registered builder is synchronous.
function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

function shareBtn(): HTMLElement {
  return document.getElementById('share-btn')!;
}

function port() {
  return window.DnznShareTarget!;
}

// Every register() call in a test pushes its unregister here so afterEach can guarantee no
// listener survives into the next test — unregister is idempotent, so a test that already
// unregistered explicitly is unaffected by a second, redundant call.
let releases: Array<() => void> = [];

beforeEach(() => {
  releases = [];
  buildFixture();
  // Order matters: production loads share-target.js before shell.js, and this suite's fixture
  // does the same — both modules are loaded fresh (module-scoped state cannot leak between
  // cases) before the real header is built.
  loadShareTarget();
  loadShell();
  (window as any).__DXKIT__ = makeShellDxStub([]);
  (window as any).initShellChrome();
});

afterEach(() => {
  for (const release of releases) release();
  removeClipboard();
  delete (window as any).__DXKIT__;
  vi.restoreAllMocks();
});

describe('share-target — the untouched shell default (SHARE-05)', () => {
  it('with no registration, clicking #share-btn copies window.location.href via the shell handler', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    installClipboard(writeText);

    shareBtn().click();
    await flush();

    expect(writeText).toHaveBeenCalledWith(window.location.href);
  });
});

describe('share-target — registration', () => {
  it('a registered builder wins: clicking copies its URL, and window.location.href is never written', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    installClipboard(writeText);
    const build = vi.fn().mockReturnValue('https://example.test/custom');
    releases.push(port().register(build));

    shareBtn().click();
    await flush();

    expect(build).toHaveBeenCalled();
    expect(writeText).toHaveBeenCalledWith('https://example.test/custom');
    expect(writeText).not.toHaveBeenCalledWith(window.location.href);
  });

  it('a builder returning null falls through to window.location.href', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    installClipboard(writeText);
    releases.push(port().register(() => null));

    shareBtn().click();
    await flush();

    expect(writeText).toHaveBeenCalledWith(window.location.href);
  });

  it('a builder that throws falls through to window.location.href, with no unhandled rejection', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    installClipboard(writeText);
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    releases.push(
      port().register(() => {
        throw new Error('boom');
      }),
    );

    shareBtn().click();
    await flush();

    expect(writeText).toHaveBeenCalledWith(window.location.href);
    expect(unhandled).not.toHaveBeenCalled();
    process.off('unhandledRejection', unhandled);
  });
});

describe('share-target — exclusivity and teardown (SHARE-02)', () => {
  it('after unregister, clicking copies window.location.href again — genuinely gone, not merely inert', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    installClipboard(writeText);
    const unregister = port().register(() => 'https://example.test/gone-soon');

    unregister();

    shareBtn().click();
    await flush();

    expect(writeText).toHaveBeenCalledWith(window.location.href);
  });

  it('after unregister, no capture-phase click listener is left on document (functionally, and by spy)', () => {
    const removeSpy = vi.spyOn(document, 'removeEventListener');
    const unregister = port().register(() => 'https://example.test/x');

    unregister();

    // The functional claim: registering a NEW builder must attach a fresh listener, which would
    // be impossible if the prior one silently remained (register() only attaches when there is
    // no active builder — a leaked listener would make this stay a no-op forever).
    expect(removeSpy).toHaveBeenCalledWith('click', expect.any(Function), true);
  });

  it('a second unregister call is a no-op', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    installClipboard(writeText);
    const unregister = port().register(() => 'https://example.test/once');

    unregister();
    unregister();

    shareBtn().click();
    await flush();

    expect(writeText).toHaveBeenCalledWith(window.location.href);
  });

  it('registering B while A is active runs B, never A', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    installClipboard(writeText);
    const buildA = vi.fn().mockReturnValue('https://example.test/a');
    const buildB = vi.fn().mockReturnValue('https://example.test/b');
    const releaseA = port().register(buildA);
    const releaseB = port().register(buildB);
    releases.push(releaseA, releaseB);

    shareBtn().click();
    await flush();

    expect(buildB).toHaveBeenCalled();
    expect(buildA).not.toHaveBeenCalled();
    expect(writeText).toHaveBeenCalledWith('https://example.test/b');
  });

  it("A's late unregister after B registered is a no-op — B still works", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    installClipboard(writeText);
    const releaseA = port().register(() => 'https://example.test/a');
    const releaseB = port().register(() => 'https://example.test/b');
    releases.push(releaseB);

    releaseA();

    shareBtn().click();
    await flush();

    expect(writeText).toHaveBeenCalledWith('https://example.test/b');
  });
});

describe('share-target — confirmation flash', () => {
  it('a successful copy adds `copied` to the button, then removes it after the timer', async () => {
    vi.useFakeTimers();
    try {
      const writeText = vi.fn().mockResolvedValue(undefined);
      installClipboard(writeText);
      releases.push(port().register(() => 'https://example.test/confirm'));

      shareBtn().click();
      await vi.advanceTimersByTimeAsync(0);

      expect(shareBtn().classList.contains('copied')).toBe(true);

      await vi.advanceTimersByTimeAsync(1500);

      expect(shareBtn().classList.contains('copied')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('unregistering while a confirmation is pending stops the timer from firing', async () => {
    vi.useFakeTimers();
    try {
      const writeText = vi.fn().mockResolvedValue(undefined);
      installClipboard(writeText);
      const unregister = port().register(() => 'https://example.test/pending');

      shareBtn().click();
      await vi.advanceTimersByTimeAsync(0);
      expect(shareBtn().classList.contains('copied')).toBe(true);

      unregister();
      // clearPendingConfirm removes the class immediately, synchronously with unregister.
      expect(shareBtn().classList.contains('copied')).toBe(false);

      await vi.advanceTimersByTimeAsync(2000);
      expect(shareBtn().classList.contains('copied')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('share-target — clipboard absent (insecure context)', () => {
  it('does not throw, and calls onCopyFailed with the URL', async () => {
    removeClipboard();
    const onCopyFailed = vi.fn();
    releases.push(port().register(() => 'https://example.test/fallback', { onCopyFailed }));

    expect(() => shareBtn().click()).not.toThrow();
    await flush();

    expect(onCopyFailed).toHaveBeenCalledWith('https://example.test/fallback');
  });
});

describe('index.html — script order (share-target before main)', () => {
  it('loads share-target.js before main.js', () => {
    const html = readFileSync(resolve(__dirname, '../src/index.html'), 'utf-8');
    const shareIdx = html.indexOf('<script src="share-target.js">');
    // Matched on the script TAG, not the bare filename — a comment earlier in this file
    // mentions "main.js" in prose and would otherwise make this assertion pass for the wrong
    // reason.
    const mainIdx = html.indexOf('<script src="main.js">');
    // Order matters: the namespace must exist before any dapp module can resolve it, and dapp
    // modules load from a manifest's dependencies — strictly after main.js runs. A future reader
    // must not "simplify" this pair of indices away as redundant with the entry list.
    expect(shareIdx).toBeGreaterThan(-1);
    expect(mainIdx).toBeGreaterThan(-1);
    expect(shareIdx).toBeLessThan(mainIdx);
  });
});

// Recursively lists .ts files under `dir`, excluding any `vendor` directory (src/vendor/dxkit
// is generated by `make vendor` from a sibling checkout and is out of scope for a source-string
// single-owner claim about this repo's own code).
function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'vendor') continue;
      out.push(...listTsFiles(full));
    } else if (entry.name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

// Source-string assertions, matching the convention already used in this file and in
// test/dapps.test.ts:103-118 — no suite mounts CIC at runtime, because jsdom has no canvas and
// CIC draws a chart on mount.
describe('cic — single owner of the share override (Task 3)', () => {
  const cicSrc = readFileSync(resolve(__dirname, '../src/dapps/cic/cic.ts'), 'utf-8');

  it('registers through DnznShareTarget and releases it from the cleanup closure', () => {
    expect(cicSrc).toContain('DnznShareTarget');
    expect(cicSrc).toContain('releaseShareTarget?.()');
  });

  it('reaches document.addEventListener nowhere in executable code', () => {
    // Comment lines are filtered out BEFORE counting: a future explanatory comment naming this
    // API (e.g. pointing at src/share-target.ts) must not fail a gate about executable code.
    const executableLines = cicSrc.split('\n').filter((line) => !line.trim().startsWith('//'));
    const occurrences = executableLines.join('\n').match(/document\.addEventListener/g) ?? [];
    expect(occurrences).toHaveLength(0);
  });

  it('is the one non-vendor src/ file naming onShareCapture, and it is src/share-target.ts', () => {
    const srcRoot = resolve(__dirname, '../src');
    const owners = listTsFiles(srcRoot).filter((file) => readFileSync(file, 'utf-8').includes('onShareCapture'));
    expect(owners).toEqual([resolve(srcRoot, 'share-target.ts')]);
  });
});
