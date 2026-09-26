import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Source-string assertion style, matching test/main.test.ts — this describe block does
// not execute shell code. A second, jsdom-executing describe block (01-04 Task 3) follows
// below and exercises the real compiled src/shell.js.
describe('shell — settings button', () => {
  const shell = readFileSync(resolve(__dirname, '../src/shell.ts'), 'utf-8');

  it('adds a gear button with id="settings-btn" inside .header-actions', () => {
    expect(shell).toContain('id="settings-btn"');
    const headerActions = shell.match(/<div class="header-actions">([\s\S]*?)<\/div>`;/)?.[1];
    expect(headerActions).toBeDefined();
    expect(headerActions).toContain('id="settings-btn"');
  });

  it('adds a settings entry to DAPP_TITLES starting with "DNZN // "', () => {
    const dappTitlesBlock = shell.match(/const DAPP_TITLES:[^{]*\{([\s\S]*?)\};/)?.[1];
    expect(dappTitlesBlock).toBeDefined();
    const settingsEntry = dappTitlesBlock!.match(/settings:\s*'([^']+)'/)?.[1];
    expect(settingsEntry).toBeDefined();
    expect(settingsEntry!.startsWith('DNZN // ')).toBe(true);
  });

  it("navigates to '/settings' on click", () => {
    expect(shell).toMatch(/navigate\('\/settings'\)/);
  });

  it('defines wireSettingsButton and calls it from initShellChrome', () => {
    expect(shell).toMatch(/function wireSettingsButton\(/);
    const initBlock = shell.match(/function initShellChrome\(\) \{([\s\S]*?)\n\}/)?.[1];
    expect(initBlock).toBeDefined();
    expect(initBlock).toContain('wireSettingsButton(');
  });

  it('subscribes to both dx:dapp:enabled and dx:dapp:disabled, and defines buildNavHTML, wireNavLinks and refreshNavMenu (01-04 / SET-09 / review A1)', () => {
    expect(shell).toContain("'dx:dapp:enabled'");
    expect(shell).toContain("'dx:dapp:disabled'");
    expect(shell).toMatch(/function buildNavHTML\(/);
    expect(shell).toMatch(/function wireNavLinks\(/);
    expect(shell).toMatch(/function refreshNavMenu\(/);
  });

  it('renders the wallet menu with id="wallet-menu" inside .header-actions', () => {
    expect(shell).toContain('id="wallet-menu"');
    const headerActions = shell.match(/<div class="header-actions">([\s\S]*?)<\/div>`;/)?.[1];
    expect(headerActions).toBeDefined();
    expect(headerActions).toContain('id="wallet-menu"');
  });

  it('renders the wallet trigger with no disabled attribute (D-15)', () => {
    // Narrowed to the button's own opening tag: `disabled` appears legitimately elsewhere in
    // the tree and could legitimately reappear in this file for an unrelated control.
    const walletBtnTag = shell.match(/<button[^>]*id="wallet-btn"[^>]*>/)?.[0];
    expect(walletBtnTag).toBeDefined();
    expect(walletBtnTag).not.toContain('disabled');
  });

  it('hands the shell context to DnznWallet from initShellChrome', () => {
    const initBlock = shell.match(/function initShellChrome\(\) \{([\s\S]*?)\n\}/)?.[1];
    expect(initBlock).toBeDefined();
    expect(initBlock).toContain('DnznWallet');
  });
});

// This block executes the COMPILED src/shell.js against the jsdom `window`, via
// `new Function('window', code)(window)` — matching test/settings-render.test.ts's pattern.
// Top-level function declarations inside a `Function` constructor body are local to that
// call, not attached to `window` automatically, so the loader appends explicit
// `window.x = x;` assignments to the source text before executing it — those assignments
// resolve correctly because they are textually in the same top-level scope.
describe('shell — nav refresh on dapp enable/disable (01-04, SET-09, review finding A1)', () => {
  function loadShell() {
    const code = readFileSync(resolve(__dirname, '../src/shell.js'), 'utf-8');
    const exposed =
      `${code}\n` +
      'window.initShellChrome = initShellChrome;\n' +
      'window.buildNavHTML = buildNavHTML;\n' +
      'window.wireNavLinks = wireNavLinks;\n' +
      'window.refreshNavMenu = refreshNavMenu;\n';
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

  const tplManifest = { id: 'tpl', route: '/tools/tpl', nav: { label: 'TPL', group: 'tools', order: 2 } };

  beforeEach(() => {
    loadShell();
    buildFixture();
  });

  afterEach(() => {
    delete (window as any).__DXKIT__;
  });

  it('an already-rendered menu loses a link when the matching manifest is removed and dx:dapp:disabled fires, with no second initShellChrome() call and no reload', () => {
    const manifests = [tplManifest];
    const dx = makeShellDxStub(manifests);
    (window as any).__DXKIT__ = dx;

    (window as any).initShellChrome();
    expect(document.querySelectorAll('#app-menu a[data-route]')).toHaveLength(1);

    manifests.splice(0, manifests.length);
    dx._eventHandlers['dx:dapp:disabled']![0]({ id: 'tpl' });

    expect(document.querySelectorAll('#app-menu a[data-route]')).toHaveLength(0);
  });

  it('the reverse: re-adding the manifest and firing dx:dapp:enabled brings the link back', () => {
    const manifests: any[] = [];
    const dx = makeShellDxStub(manifests);
    (window as any).__DXKIT__ = dx;

    (window as any).initShellChrome();
    expect(document.querySelectorAll('#app-menu a[data-route]')).toHaveLength(0);

    manifests.push(tplManifest);
    dx._eventHandlers['dx:dapp:enabled']![0]({ id: 'tpl' });

    expect(document.querySelectorAll('#app-menu a[data-route]')).toHaveLength(1);
  });

  it('repeated refreshes add no document click listener and no extra dx:route:changed subscription', () => {
    const manifests = [tplManifest];
    const dx = makeShellDxStub(manifests);
    (window as any).__DXKIT__ = dx;

    const addSpy = vi.spyOn(document, 'addEventListener');
    (window as any).initShellChrome();
    const clickCountAfterInit = addSpy.mock.calls.filter((c) => c[0] === 'click').length;

    for (let i = 0; i < 3; i++) {
      dx._eventHandlers['dx:dapp:disabled']![0]({ id: 'tpl' });
    }

    const clickCountAfterRefreshes = addSpy.mock.calls.filter((c) => c[0] === 'click').length;
    expect(clickCountAfterRefreshes).toBe(clickCountAfterInit);
    expect(dx._eventHandlers['dx:route:changed']).toHaveLength(1);

    addSpy.mockRestore();
  });

  it('header action buttons survive a refresh — same element objects, renderHeader was not re-run', () => {
    const manifests = [tplManifest];
    const dx = makeShellDxStub(manifests);
    (window as any).__DXKIT__ = dx;

    (window as any).initShellChrome();
    const before = {
      share: document.getElementById('share-btn'),
      theme: document.getElementById('theme-panel-trigger'),
      settings: document.getElementById('settings-btn'),
      wallet: document.getElementById('wallet-btn'),
      walletPanel: document.getElementById('wallet-panel'),
      walletMenu: document.getElementById('wallet-menu'),
    };
    expect(before.share).not.toBeNull();
    expect(before.theme).not.toBeNull();
    expect(before.settings).not.toBeNull();
    expect(before.wallet).not.toBeNull();
    expect(before.walletPanel).not.toBeNull();
    expect(before.walletMenu).not.toBeNull();

    dx._eventHandlers['dx:dapp:disabled']![0]({ id: 'tpl' });

    expect(document.getElementById('share-btn')).toBe(before.share);
    expect(document.getElementById('theme-panel-trigger')).toBe(before.theme);
    expect(document.getElementById('settings-btn')).toBe(before.settings);
    expect(document.getElementById('wallet-btn')).toBe(before.wallet);
    expect(document.getElementById('wallet-panel')).toBe(before.walletPanel);
    expect(document.getElementById('wallet-menu')).toBe(before.walletMenu);
  });

  it('a nav link rendered by refreshNavMenu is wired: clicking it navigates via the router stub', () => {
    const manifests: any[] = [];
    const dx = makeShellDxStub(manifests);
    (window as any).__DXKIT__ = dx;

    (window as any).initShellChrome();
    manifests.push(tplManifest);
    dx._eventHandlers['dx:dapp:enabled']![0]({ id: 'tpl' });

    const link = document.querySelector('#app-menu a[data-route]') as HTMLAnchorElement;
    expect(link).not.toBeNull();
    link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    expect(dx.router.navigate).toHaveBeenCalledWith(link.dataset.route);
  });

  // WAL-01 / D-20 / D-21: the three header dropdowns are driven by one shared handler set,
  // so every invariant is asserted for all three rather than only for the two that shipped
  // first. The wallet panel is the one with no shipped history, and a regression in it would
  // otherwise surface as a dead button rather than as a red test.
  describe('header dropdowns', () => {
    // loadShell attaches the compiled shell's top-level functions to `window`, a shape no
    // ambient type describes.
    const shellWindow = window as unknown as { __DXKIT__?: unknown; initShellChrome(): void };

    function bootChrome() {
      const dx = makeShellDxStub([tplManifest]);
      shellWindow.__DXKIT__ = dx;
      shellWindow.initShellChrome();
      return dx;
    }

    function click(id: string) {
      document.getElementById(id)!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    }

    function pressEscape() {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    }

    function isOpen(wrapperId: string) {
      return document.getElementById(wrapperId)!.classList.contains('open');
    }

    function ariaExpanded(triggerId: string) {
      return document.getElementById(triggerId)!.getAttribute('aria-expanded');
    }

    it('clicking the wallet trigger opens its panel and flips aria-expanded, clicking again closes it', () => {
      bootChrome();

      click('wallet-btn');
      expect(isOpen('wallet-panel')).toBe(true);
      expect(ariaExpanded('wallet-btn')).toBe('true');

      click('wallet-btn');
      expect(isOpen('wallet-panel')).toBe(false);
      expect(ariaExpanded('wallet-btn')).toBe('false');
    });

    it('renders the wallet trigger enabled, so the first click is not swallowed', () => {
      bootChrome();

      expect(document.getElementById('wallet-btn')!.hasAttribute('disabled')).toBe(false);
    });

    it('opening the wallet panel closes an open theme panel', () => {
      bootChrome();
      click('theme-panel-trigger');
      // Guards the arrange step: without it, the closed-after assertion below would pass
      // vacuously if the first click had never opened anything.
      expect(isOpen('theme-panel')).toBe(true);

      click('wallet-btn');

      expect(isOpen('theme-panel')).toBe(false);
      expect(ariaExpanded('theme-panel-trigger')).toBe('false');
      expect(isOpen('wallet-panel')).toBe(true);
    });

    it('opening the app dropdown closes an open wallet panel', () => {
      bootChrome();
      click('wallet-btn');
      expect(isOpen('wallet-panel')).toBe(true);

      click('app-trigger');

      expect(isOpen('wallet-panel')).toBe(false);
      expect(ariaExpanded('wallet-btn')).toBe('false');
      expect(isOpen('app-dropdown')).toBe(true);
    });

    it('opening the wallet panel closes an open app dropdown', () => {
      bootChrome();
      click('app-trigger');
      expect(isOpen('app-dropdown')).toBe(true);

      click('wallet-btn');

      expect(isOpen('app-dropdown')).toBe(false);
      expect(ariaExpanded('app-trigger')).toBe('false');
      expect(isOpen('wallet-panel')).toBe(true);
    });

    it('a click outside closes the open wallet panel', () => {
      bootChrome();
      click('wallet-btn');

      document.body.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

      expect(isOpen('wallet-panel')).toBe(false);
      expect(ariaExpanded('wallet-btn')).toBe('false');
    });

    it('clicking the app trigger opens its dropdown and flips aria-expanded, clicking again closes it', () => {
      bootChrome();

      click('app-trigger');
      expect(isOpen('app-dropdown')).toBe(true);
      expect(ariaExpanded('app-trigger')).toBe('true');

      click('app-trigger');
      expect(isOpen('app-dropdown')).toBe(false);
      expect(ariaExpanded('app-trigger')).toBe('false');
    });

    it('clicking the theme trigger opens its panel and flips aria-expanded, clicking again closes it', () => {
      bootChrome();

      click('theme-panel-trigger');
      expect(isOpen('theme-panel')).toBe(true);
      expect(ariaExpanded('theme-panel-trigger')).toBe('true');

      click('theme-panel-trigger');
      expect(isOpen('theme-panel')).toBe(false);
      expect(ariaExpanded('theme-panel-trigger')).toBe('false');
    });

    it('a click outside closes the open app dropdown', () => {
      bootChrome();
      click('app-trigger');

      document.body.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

      expect(isOpen('app-dropdown')).toBe(false);
      expect(ariaExpanded('app-trigger')).toBe('false');
    });

    it('a click outside closes the open theme panel', () => {
      bootChrome();
      click('theme-panel-trigger');

      document.body.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

      expect(isOpen('theme-panel')).toBe(false);
      expect(ariaExpanded('theme-panel-trigger')).toBe('false');
    });

    it('Escape closes the app dropdown and returns focus to its trigger', () => {
      bootChrome();
      click('app-trigger');

      pressEscape();

      expect(isOpen('app-dropdown')).toBe(false);
      expect(ariaExpanded('app-trigger')).toBe('false');
      expect(document.activeElement).toBe(document.getElementById('app-trigger'));
    });

    it('Escape closes the theme panel and returns focus to its trigger', () => {
      bootChrome();
      click('theme-panel-trigger');

      pressEscape();

      expect(isOpen('theme-panel')).toBe(false);
      expect(ariaExpanded('theme-panel-trigger')).toBe('false');
      expect(document.activeElement).toBe(document.getElementById('theme-panel-trigger'));
    });

    it('Escape closes the wallet panel and returns focus to its trigger', () => {
      bootChrome();
      click('wallet-btn');

      pressEscape();

      expect(isOpen('wallet-panel')).toBe(false);
      expect(ariaExpanded('wallet-btn')).toBe('false');
      expect(document.activeElement).toBe(document.getElementById('wallet-btn'));
    });

    it('Escape with nothing open opens nothing and leaves focus where it was', () => {
      bootChrome();
      const focusedBefore = document.activeElement;

      pressEscape();

      expect(document.querySelectorAll('.open')).toHaveLength(0);
      expect(document.activeElement).toBe(focusedBefore);
    });

    it('wires aria-haspopup and a false aria-expanded on all three triggers at init', () => {
      bootChrome();

      for (const id of ['app-trigger', 'theme-panel-trigger', 'wallet-btn']) {
        expect(document.getElementById(id)!.getAttribute('aria-haspopup')).toBe('true');
        expect(ariaExpanded(id)).toBe('false');
      }
    });

    it('adds exactly one document keydown listener at init — one shared handler, not one per panel', () => {
      const addSpy = vi.spyOn(document, 'addEventListener');

      bootChrome();

      expect(addSpy.mock.calls.filter((c) => c[0] === 'keydown')).toHaveLength(1);
      addSpy.mockRestore();
    });

    it('repeated refreshes add no document keydown listener', () => {
      const addSpy = vi.spyOn(document, 'addEventListener');
      const dx = bootChrome();
      const keydownAfterInit = addSpy.mock.calls.filter((c) => c[0] === 'keydown').length;

      for (let i = 0; i < 3; i++) {
        dx._eventHandlers['dx:dapp:disabled']![0]({ id: 'tpl' });
        dx._eventHandlers['dx:dapp:enabled']![0]({ id: 'tpl' });
      }

      expect(addSpy.mock.calls.filter((c) => c[0] === 'keydown')).toHaveLength(keydownAfterInit);
      addSpy.mockRestore();
    });
  });
});

// Returns the string entries of tsup's `entry: [...]` block. Takes text rather than a
// path so the negative cases below can drive it with an in-memory mutated copy.
function parseTsupEntries(configText: string): string[] {
  const block = configText.match(/entry:\s*\[([\s\S]*?)\]/)?.[1] ?? '';
  return [...block.matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

// Returns every <script src> value in document order — order is the contract, not
// mere presence.
function parseScriptSrcs(htmlText: string): string[] {
  return [...htmlText.matchAll(/<script\s+src="([^"]+)"/g)].map((m) => m[1]);
}

// Both sides are DERIVED from the file texts rather than hard-coded, which is what makes the
// equality catch the next module added to the tree and not only the ones named here.
function deriveWiringSets(configText: string, htmlText: string) {
  const entries = parseTsupEntries(configText).filter((entry) => !entry.startsWith('src/dapps/'));
  const scripts = parseScriptSrcs(htmlText)
    .filter((src) => !src.startsWith('vendor/'))
    .map((src) => `src/${src.replace(/\.js$/, '.ts')}`);
  return { entries: entries.sort(), scripts: scripts.sort() };
}

// Position of each named src in document order, -1 for any that is absent, so a case can tell
// "moved" apart from "missing".
function scriptPositions(htmlText: string, order: string[]): number[] {
  const srcs = parseScriptSrcs(htmlText);
  return order.map((src) => srcs.indexOf(src));
}

// Defends the build wiring of the whole non-dapp script tree. tsup's `entry` is an explicit
// list rather than a glob and src/*.js is gitignored, so a stale local build masks an
// omission: the observable symptom of a dropped entry or script tag is a dead header control,
// with no build failure and nothing in the console.
//
// The set equality is scoped to non-dapp entries because a dapp module reaches the browser
// through its own manifest `entry`/`dependencies` and is deliberately never a script tag.
// Including them would assert a wiring shape this repo has never had, and script-tagging one
// would be a double-load bug — so do not simplify the derivation back into two literals, and
// do not strengthen it into a claim over every entry.
//
// parseTsupEntries and parseScriptSrcs are deliberately the same two readers
// test/cache-plugin.test.ts uses for its single-plugin version of this guard: test/ has no
// shared fixture module, and one convention read twice beats two conventions.
describe('build wiring — non-vendor script tags against non-dapp tsup entries', () => {
  const configText = readFileSync(resolve(__dirname, '../tsup.config.ts'), 'utf-8');
  const htmlText = readFileSync(resolve(__dirname, '../src/index.html'), 'utf-8');
  const gitignoreText = readFileSync(resolve(__dirname, '../.gitignore'), 'utf-8');

  // Relative ascending order only: a plugin script may legitimately be inserted between any
  // two of these, so nothing here claims contiguity or a total tag count.
  const SCRIPT_ORDER = [
    'vendor/dxkit/index.global.js',
    'vendor/dxkit/theme/index.global.js',
    'vendor/dxkit/settings/index.global.js',
    'vendor/dxkit/wallet/index.global.js',
    'plugins/ethereum.js',
    'wallet-identity.js',
    'shell-wallet.js',
    'shell.js',
    'main.js',
  ];

  it('names src/shell-wallet.ts and src/wallet-identity.ts in the tsup entry list', () => {
    expect(parseTsupEntries(configText)).toContain('src/shell-wallet.ts');
    expect(parseTsupEntries(configText)).toContain('src/wallet-identity.ts');
  });

  // Once each matters for the identity port beyond mere wiring: a second tag re-runs its IIFE,
  // which replaces window.DnznWalletIdentity with a fresh store while shell-wallet.js still
  // holds the alias it resolved at load.
  it('carries the wallet vendor, wallet-identity and shell-wallet tags exactly once each', () => {
    const srcs = parseScriptSrcs(htmlText);

    expect(srcs.filter((src) => src === 'vendor/dxkit/wallet/index.global.js')).toHaveLength(1);
    expect(srcs.filter((src) => src === 'wallet-identity.js')).toHaveLength(1);
    expect(srcs.filter((src) => src === 'shell-wallet.js')).toHaveLength(1);
  });

  it('loads vendors, then the plugin, then the identity port, shell-wallet, shell and main', () => {
    const positions = scriptPositions(htmlText, SCRIPT_ORDER);

    expect(positions).not.toContain(-1);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it('derives one equal set from the non-vendor script tags and the non-dapp entries', () => {
    const { entries, scripts } = deriveWiringSets(configText, htmlText);

    expect(scripts).toEqual(entries);
  });

  it('ignores both compiled wallet outputs via anchored .gitignore lines', () => {
    expect(gitignoreText.split('\n')).toContain('src/shell-wallet.js');
    expect(gitignoreText.split('\n')).toContain('src/wallet-identity.js');
  });

  // The three cases below prove the guard discriminates, on every run rather than once in an
  // executor's terminal. Each mutates a local copy of the file text; nothing on disk is
  // written, because other plans build against these same two shared files.
  it('reports the sets unequal when a non-dapp entry is dropped from the config text', () => {
    const mutated = configText
      .split('\n')
      .filter((line) => !line.includes("'src/shell-wallet.ts'"))
      .join('\n');

    const { entries, scripts } = deriveWiringSets(mutated, htmlText);

    expect(scripts).not.toEqual(entries);
  });

  it('reports the sets unequal when a non-vendor script tag is dropped from the html text', () => {
    const mutated = htmlText
      .split('\n')
      .filter((line) => !line.includes('src="shell-wallet.js"'))
      .join('\n');

    const { entries, scripts } = deriveWiringSets(configText, mutated);

    expect(scripts).not.toEqual(entries);
  });

  it('reports the order broken when a module is moved after main.js', () => {
    const lines = htmlText.split('\n');
    const walletTagAt = lines.findIndex((line) => line.includes('src="shell-wallet.js"'));
    const mainTagAt = lines.findIndex((line) => line.includes('src="main.js"'));
    const [walletTag] = lines.splice(walletTagAt, 1);
    // main.js shifted up by one when the wallet tag was removed, so its old index is now the
    // insertion point that lands the tag immediately after it.
    lines.splice(mainTagAt, 0, walletTag);

    const positions = scriptPositions(lines.join('\n'), SCRIPT_ORDER);

    expect(positions).not.toContain(-1);
    expect(positions).not.toEqual([...positions].sort((a, b) => a - b));
  });
});

// A brace-depth CSS-rule scanner good enough for this file's own small assertions — mirrors
// test/decode-ui.test.ts's extractCssRules/readCssDeclaration (comments stripped, selector
// whitespace normalised, `@media` preludes skipped since the buffer only ever holds "the text
// since the last brace"). Kept local rather than shared: test/ has no shared fixture module, so
// one convention read twice beats inventing a third.
function extractCssRules(css: string): Array<{ selector: string; block: string }> {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules: Array<{ selector: string; block: string }> = [];
  let buffer = '';
  let currentSelector = '';
  for (const ch of withoutComments) {
    if (ch === '{') {
      currentSelector = buffer.trim().replace(/\s+/g, ' ');
      buffer = '';
    } else if (ch === '}') {
      if (currentSelector && !currentSelector.startsWith('@')) {
        for (const sel of currentSelector.split(',')) {
          const trimmed = sel.trim();
          if (trimmed) rules.push({ selector: trimmed, block: buffer });
        }
      }
      buffer = '';
      currentSelector = '';
    } else {
      buffer += ch;
    }
  }
  return rules;
}

function readCssDeclaration(block: string, property: string): string | undefined {
  const match = new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`).exec(block);
  return match ? match[1].trim() : undefined;
}

// G-06-8: the shell's first pressed state, and the base .btn-group size correction that makes
// #decode-actions (the only bare .btn-group in the tree) usable without a --sm modifier. Rules
// are asserted by relationship and structure, never by literal rem values or a literal selector
// string — the exact size and the exact pressed-selector spelling are the executor's to choose.
describe("components.css — btn-group sizing and the site's first pressed state (G-06-8)", () => {
  const css = readFileSync(resolve(__dirname, '../src/styles/components.css'), 'utf-8');
  const rules = extractCssRules(css);

  it('the base .btn-group button rule declares both padding and font-size, since an unmodified .btn-group is otherwise unsized', () => {
    const base = rules.findLast((r) => r.selector === '.btn-group button');
    expect(base).toBeDefined();
    expect(readCssDeclaration(base!.block, 'padding')).toBeDefined();
    expect(readCssDeclaration(base!.block, 'font-size')).toBeDefined();
  });

  it("the base rule's vertical padding is strictly greater than .btn-group--sm button's, and --sm still exists", () => {
    const base = rules.findLast((r) => r.selector === '.btn-group button');
    const sm = rules.find((r) => r.selector === '.btn-group--sm button');
    expect(sm).toBeDefined();
    const basePad = Number.parseFloat(String(readCssDeclaration(base!.block, 'padding')).split(' ')[0]);
    const smPad = Number.parseFloat(String(readCssDeclaration(sm!.block, 'padding')).split(' ')[0]);
    expect(basePad).toBeGreaterThan(smPad);
  });

  it('at least one rule in the file contains :active, since this file had no pressed state at all before', () => {
    const pressed = rules.filter((r) => r.selector.includes(':active'));
    expect(pressed.length).toBeGreaterThan(0);
  });

  it('the pressed .btn-group rule appears after .btn-group button:hover:not(.active) and is at least as specific, so a press beats a hover', () => {
    const hoverIndex = rules.findIndex((r) => r.selector === '.btn-group button:hover:not(.active)');
    const pressedIndex = rules.findIndex(
      (r) => r.selector.startsWith('.btn-group button') && r.selector.includes(':active'),
    );
    expect(hoverIndex).toBeGreaterThanOrEqual(0);
    expect(pressedIndex).toBeGreaterThanOrEqual(0);
    expect(pressedIndex).toBeGreaterThan(hoverIndex);

    const conditionCount = (selector: string) => (selector.match(/:/g) ?? []).length;
    expect(conditionCount(rules[pressedIndex].selector)).toBeGreaterThanOrEqual(
      conditionCount(rules[hoverIndex].selector),
    );
  });

  it('.btn-group--sm button still declares a smaller padding than the base — the CIC and tpl no-regression guard', () => {
    const base = rules.findLast((r) => r.selector === '.btn-group button');
    const sm = rules.find((r) => r.selector === '.btn-group--sm button');
    const basePad = Number.parseFloat(String(readCssDeclaration(base!.block, 'padding')).split(' ')[0]);
    const smPad = Number.parseFloat(String(readCssDeclaration(sm!.block, 'padding')).split(' ')[0]);
    expect(smPad).toBeLessThan(basePad);
  });

  it('.copy-btn has a pressed state too', () => {
    const copyPressed = rules.find((r) => r.selector.startsWith('.copy-btn') && r.selector.includes(':active'));
    expect(copyPressed).toBeDefined();
  });
});
