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
    };
    expect(before.share).not.toBeNull();
    expect(before.theme).not.toBeNull();
    expect(before.settings).not.toBeNull();
    expect(before.wallet).not.toBeNull();

    dx._eventHandlers['dx:dapp:disabled']![0]({ id: 'tpl' });

    expect(document.getElementById('share-btn')).toBe(before.share);
    expect(document.getElementById('theme-panel-trigger')).toBe(before.theme);
    expect(document.getElementById('settings-btn')).toBe(before.settings);
    expect(document.getElementById('wallet-btn')).toBe(before.wallet);
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
});
