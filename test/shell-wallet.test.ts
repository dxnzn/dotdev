import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';

// Wave-0 scaffold for the wallet header, extended through 02-09. 02-07 split the module in two
// along its port/adapter seam, so the loader boots both compiled files and two surfaces are
// asserted exhaustively rather than one. 02-09 re-founded the port as live-only: it observes the
// injected provider's own answer instead of persisting one, so the seeding pattern throughout
// this file is "arrange window.ethereum's answer before mount", never "write to storage before
// mount".

const WALLET_MODULE_PATH = resolve(__dirname, '../src/shell-wallet.js');
const IDENTITY_MODULE_PATH = resolve(__dirname, '../src/wallet-identity.js');
const VENDORED_WALLET_PATH = resolve(__dirname, '../src/vendor/dxkit/wallet/index.global.js');
const hasVendoredWallet = existsSync(VENDORED_WALLET_PATH);

// Both files assign their own window namespace, so — unlike shell.js — neither needs an
// appended `window.x = x` trampoline to recover its exports.
//
// The order is production's: shell-wallet.js resolves window.DnznWalletIdentity once at load,
// so the port has to be assigned first. Loading both on every call is also what keeps each
// mount's module state fresh — the port's in-memory identity must not leak from one case into
// the next.
function loadWalletModule() {
  new Function('window', readFileSync(IDENTITY_MODULE_PATH, 'utf-8'))(window);
  new Function('window', readFileSync(WALLET_MODULE_PATH, 'utf-8'))(window);
  return (window as any).DnznWallet;
}

// The port surface as of the most recent loadWalletModule() — each load replaces it.
function identityPort() {
  return (window as any).DnznWalletIdentity;
}

// shell.js declares bare top-level functions, which stay local to a `new Function` body, so
// this loader does need the trampoline (see test/shell.test.ts's copy).
function loadShell() {
  const code = readFileSync(resolve(__dirname, '../src/shell.js'), 'utf-8');
  new Function('window', `${code}\nwindow.initShellChrome = initShellChrome;\n`)(window);
}

// This Node runtime exposes an experimental native `globalThis.localStorage` that shadows
// jsdom's simulated Storage and has no setItem/getItem/clear. A Map-backed, Storage-shaped
// stand-in restores a real surface. Copied from test/settings-render.test.ts. Kept even though
// neither wallet module reads or writes storage any more (02-09): other shell chrome loaded
// alongside it may still touch localStorage, and one test below still writes a stale identity
// blob deliberately, to prove nothing reads it.
function installFakeLocalStorage() {
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
}

// A fake EIP-1193 provider. `request` answers eth_accounts and eth_chainId from the arguments
// given — `accounts: []` (the default) is what a fresh, unauthorised load looks like — and is
// itself a spy, so a case can assert exactly which methods were called (T-02-02: eth_accounts,
// a silent read, is expected on every mount; eth_requestAccounts, which prompts, must never fire
// without a gesture).
function installFakeEthereum(options: { accounts?: string[]; chainIdHex?: string } = {}) {
  const { accounts = [], chainIdHex = '0x1' } = options;
  const request = vi.fn((args?: { method?: string }) => {
    if (args?.method === 'eth_accounts') return Promise.resolve(accounts);
    if (args?.method === 'eth_chainId') return Promise.resolve(chainIdHex);
    return Promise.resolve(undefined);
  });
  const provider = { request, on: vi.fn(), removeListener: vi.fn() };
  (window as any).ethereum = provider;
  return provider;
}

// The clipboard is a property on `navigator` that jsdom does not implement, so the happy path
// has to define it and the insecure-context path has to be able to take it away again —
// `configurable: true` on both counts. A plain-HTTP IPFS gateway is exactly the absent case.
function installClipboard(writeText: Mock) {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  return writeText;
}

function removeClipboard() {
  delete (navigator as unknown as { clipboard?: unknown }).clipboard;
}

function makeWalletStub(overrides: Record<string, unknown> = {}) {
  const unsubscribe = vi.fn();
  return {
    connect: vi.fn(),
    disconnect: vi.fn(),
    getState: vi.fn(() => ({ connected: false, address: null, chainId: null, provider: null })),
    onStateChange: vi.fn(() => unsubscribe),
    getProviders: vi.fn(() => [{ id: 'eip1193', name: 'Browser Wallet', available: () => !!(window as any).ethereum }]),
    _unsubscribe: unsubscribe,
    ...overrides,
  };
}

const SETTINGS_MANIFEST = { id: 'settings', route: '/settings', nav: { label: 'Settings', group: 'main', order: 1 } };

// test/shell.test.ts's makeShellDxStub, extended so getPlugin also answers 'wallet' and so
// every dx.events.on disposable hands back a countable off() spy. dx.settings is gone from this
// stub with 02-09: nothing in either wallet module reads it any more.
function makeDxStub(manifests: any[], wallet: any) {
  const eventHandlers: Record<string, Array<(payload?: any) => void>> = {};
  const offSpies: Mock[] = [];
  const theme = {
    getTheme: () => 'zorgz-2625',
    getResolvedMode: () => 'dark',
    getMode: () => 'system',
    setMode: vi.fn(),
    setTheme: vi.fn(),
  };
  return {
    getPlugin: (name: string) => (name === 'theme' ? theme : name === 'wallet' ? wallet : undefined),
    getEnabledManifests: () => manifests,
    router: { getCurrentPath: () => '/', navigate: vi.fn() },
    events: {
      on: (name: string, fn: (payload?: any) => void) => {
        if (!eventHandlers[name]) eventHandlers[name] = [];
        eventHandlers[name].push(fn);
        // The spy detaches as well as counting: the real bus stops delivering after off(), and a
        // stub that only counted made "cleanup released it" unassertable by behaviour.
        const off = vi.fn(() => {
          eventHandlers[name] = eventHandlers[name].filter((handler) => handler !== fn);
        });
        offSpies.push(off);
        return { off };
      },
    },
    _eventHandlers: eventHandlers,
    _offSpies: offSpies,
  };
}

function buildFixture() {
  document.head.innerHTML = '<meta name="theme-color" content=""><link rel="icon" href="">';
  document.body.innerHTML =
    '<header id="shell-header"></header><footer id="shell-footer"></footer><img class="title-icon">';
}

// Boots the real compiled shell + wallet modules against jsdom and returns the dx stub, so a
// case asserts against the markup renderHeader actually emits rather than a hand-written copy.
function bootHeader(manifests: any[] = [SETTINGS_MANIFEST], wallet: any = makeWalletStub()) {
  loadShell();
  const walletModule = loadWalletModule();
  buildFixture();
  const dx = makeDxStub(manifests, wallet);
  (window as any).__DXKIT__ = dx;
  (window as any).initShellChrome();
  return { dx, wallet, walletModule, port: identityPort() };
}

// The re-arm listener reads #wallet-panel's .open class after shell.ts's own toggle has run,
// so these cases arrange that class directly: a real trigger toggles, and therefore cannot
// produce two *open* gestures with no close between them.
function mountWalletOnly(wallet: any) {
  const walletModule = loadWalletModule();
  document.body.innerHTML =
    '<div class="wallet-panel" id="wallet-panel"><button type="button" id="wallet-btn" title="Wallet"></button><div class="wallet-menu" id="wallet-menu"></div></div>';
  const dx = makeDxStub([SETTINGS_MANIFEST], wallet);
  const cleanup = walletModule.init(dx);
  const trigger = document.getElementById('wallet-btn') as HTMLButtonElement;
  const panel = document.getElementById('wallet-panel') as HTMLElement;
  return {
    dx,
    wallet,
    walletModule,
    port: identityPort(),
    cleanup,
    trigger,
    panel,
    open: () => {
      panel.classList.add('open');
      trigger.click();
    },
    close: () => {
      panel.classList.remove('open');
      trigger.click();
    },
  };
}

// A connect() that never settles: the resolvers are discarded, so nothing can complete it.
// This is MetaMask #11280's shape — a dismissed unlock prompt leaves eth_requestAccounts
// pending forever, so the module's `finally` never runs.
function neverSettles() {
  return Promise.withResolvers().promise;
}

// The module's rejection handling is internal, so there is no signal to await. Drain the
// microtask queue rather than sleeping: deterministic, and no wall-clock latency. Also what
// every case that seeds an identity through installFakeEthereum() awaits: the query is started,
// never awaited, by init() itself (T-02-39), so a case that needs the seeded identity painted
// has to let that promise chain settle first.
async function flushMicrotasks() {
  for (let tick = 0; tick < 8; tick++) {
    await Promise.resolve();
  }
}

const VALID_ADDRESS = '0x1234567890AbCdEf1234567890aBcDeF12345678';
const IDENTITY_KEY = 'dnzn:dotdev:wallet:identity';

// Mixed case in both halves shortenAddress keeps, so a case change is visible in the
// rendered output — VALID_ADDRESS shortens to digits only and would hide one (D-18).
const MIXED_ADDRESS = '0xAbCdEf1234567890abcdef1234567890abcdEfAb';
const SHORT_MIXED = '0xAbCd…EfAb';
const SHORT_VALID = '0x1234…5678';

// Rows are found by their visible verb rather than by position: 02-06 puts Connect above the
// Settings row and Disconnect below it, so an index would encode the layout instead of the
// behaviour. Both patterns are anchored, because 'Disconnect' contains 'connect'.
function menuButton(verb: RegExp) {
  const rows = Array.from(document.querySelectorAll('#wallet-menu button')) as HTMLButtonElement[];
  return rows.find((row) => verb.test(row.textContent ?? ''));
}

const CONNECT_ROW = /^connect/i;
const DISCONNECT_ROW = /^disconnect/i;

// The live message region, told apart by .wallet-alert from the static no-provider sentence
// that shares its .wallet-message shape — clearing on open must not erase that sentence.
function messageText() {
  return document.querySelector('#wallet-menu .wallet-alert')?.textContent ?? '';
}

// CONNECT_GUARD_MS is module-internal by design (nothing outside decides the bound), so the
// cases that advance past it name the same 30s here.
const GUARD_MS = 30_000;

// The .copied window, module-internal for the same reason and matching shell.ts's share button
// and cic.ts's report copy — the settled convention rather than a third number (D-13).
const COPY_MS = 1500;

// The prohibition and no-re-render floors are evaluated over comment-stripped source, so a
// comment documenting either rule cannot turn its own gate red.
function stripLineComments(source: string) {
  return source
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
}

describe('shell-wallet — pure helpers (no vendored file needed)', () => {
  let DnznWallet: any;
  let DnznWalletIdentity: any;

  beforeEach(() => {
    installFakeLocalStorage();
    DnznWallet = loadWalletModule();
    DnznWalletIdentity = identityPort();
  });

  afterEach(() => {
    window.localStorage.clear();
    delete (window as any).ethereum;
  });

  // Four members, unchanged by 02-09.
  it('exposes exactly the four documented display members', () => {
    expect(Object.keys(DnznWallet).sort()).toEqual(['describeError', 'init', 'resolveState', 'shortenAddress']);
  });

  // Five now, not 02-01's seven: readIdentity, writeIdentity and cachedIdentity are gone with
  // the store — 02-09 re-founded this port as live-only, and liveIdentity replaces both reads.
  it('the identity port exposes exactly the five documented members', () => {
    expect(Object.keys(DnznWalletIdentity).sort()).toEqual([
      'acceptLiveIdentity',
      'clearIdentity',
      'init',
      'isAddress',
      'liveIdentity',
    ]);
  });

  it('shortenAddress keeps 0x plus four characters, an ellipsis, and the last four', () => {
    const shortened = DnznWallet.shortenAddress(VALID_ADDRESS);

    expect(shortened).toBe('0x1234…5678');
    expect(shortened.startsWith('0x')).toBe(true);
  });

  it('shortenAddress leaves a short value untouched, so a garbage payload cannot break it', () => {
    expect(DnznWallet.shortenAddress('0x1234')).toBe('0x1234');
  });

  it('shortenAddress does not change casing in either direction (an EIP-55 checksum survives)', () => {
    expect(DnznWallet.shortenAddress(VALID_ADDRESS)).toContain('0x1234');
    expect(DnznWallet.shortenAddress('0xABCDEF7890abcdef1234567890abcdef12345678')).toBe('0xABCD…5678');
  });

  it('describeError returns null for 4001 — a deliberate decline is not a reportable failure', () => {
    expect(DnznWallet.describeError({ code: 4001 })).toBeNull();
  });

  it('describeError returns null for -32002 as well — a pending request is a wait, not a failure', () => {
    expect(DnznWallet.describeError({ code: -32002 })).toBeNull();
  });

  it('describeError returns a distinct non-empty sentence for every other code', () => {
    const codes = [4100, 4200, 4900, 4901, 999999];
    const messages = codes.map((code) => DnznWallet.describeError({ code }));

    for (const message of messages) {
      expect(typeof message).toBe('string');
      expect(message.length).toBeGreaterThan(0);
    }
    expect(new Set(messages).size).toBe(codes.length);
  });

  it('describeError survives a non-object throw', () => {
    expect(DnznWallet.describeError(undefined)).toBe(DnznWallet.describeError({ code: 999999 }));
    expect(DnznWallet.describeError('boom')).not.toBeNull();
  });

  it('isAddress applies the same 40-hex rule the live branch applies to a provider payload', () => {
    expect(DnznWalletIdentity.isAddress(VALID_ADDRESS)).toBe(true);
    expect(DnznWalletIdentity.isAddress(MIXED_ADDRESS)).toBe(true);
    for (const bad of ['0x1234', `${VALID_ADDRESS}9`, VALID_ADDRESS.slice(2), `0x${'z'.repeat(40)}`, 12345, null]) {
      expect(DnznWalletIdentity.isAddress(bad)).toBe(false);
    }
  });

  it('liveIdentity returns null before init() has ever run', () => {
    expect(DnznWalletIdentity.liveIdentity()).toBeNull();
  });

  it('acceptLiveIdentity rejects a malformed address and leaves liveIdentity untouched', () => {
    DnznWalletIdentity.acceptLiveIdentity(undefined, VALID_ADDRESS, 1);
    const before = DnznWalletIdentity.liveIdentity();

    expect(DnznWalletIdentity.acceptLiveIdentity(undefined, '0x1234', 1)).toBe(false);

    expect(DnznWalletIdentity.liveIdentity()).toEqual(before);
  });

  it('clearIdentity forgets an accepted identity', () => {
    DnznWalletIdentity.acceptLiveIdentity(undefined, VALID_ADDRESS, 1);
    expect(DnznWalletIdentity.liveIdentity()).toEqual({ address: VALID_ADDRESS, chainId: 1 });

    DnznWalletIdentity.clearIdentity();

    expect(DnznWalletIdentity.liveIdentity()).toBeNull();
  });
});

describe('shell-wallet — resolveState asks the plugin, never window.ethereum directly', () => {
  let DnznWallet: any;
  let DnznWalletIdentity: any;

  beforeEach(() => {
    installFakeLocalStorage();
    DnznWallet = loadWalletModule();
    DnznWalletIdentity = identityPort();
  });

  afterEach(() => {
    window.localStorage.clear();
    delete (window as any).ethereum;
  });

  it("returns 'no-provider' when no registered provider reports itself available", () => {
    const dx = makeDxStub([], makeWalletStub());

    expect(DnznWallet.resolveState(dx)).toBe('no-provider');
  });

  it("returns 'disconnected' with a provider available but no live identity accepted yet", () => {
    installFakeEthereum();
    const dx = makeDxStub([], makeWalletStub());

    expect(DnznWallet.resolveState(dx)).toBe('disconnected');
  });

  // The plugin's own getState() is deliberately not consulted here any more (02-09): every
  // plugin signal converges on the port through acceptLive, so this is the one source now.
  it("returns 'connected' once the port's live identity has been accepted, with no round-trip of resolveState's own", () => {
    const ethereum = installFakeEthereum();
    const wallet = makeWalletStub();
    const dx = makeDxStub([], wallet);
    DnznWalletIdentity.acceptLiveIdentity(dx, VALID_ADDRESS, 1);

    expect(DnznWallet.resolveState(dx)).toBe('connected');
    expect(ethereum.request).not.toHaveBeenCalled();
    expect(wallet.connect).not.toHaveBeenCalled();
  });
});

describe('shell-wallet — the header control (jsdom, compiled shell.js + shell-wallet.js)', () => {
  beforeEach(() => {
    installFakeLocalStorage();
  });

  afterEach(() => {
    window.localStorage.clear();
    delete (window as any).ethereum;
    delete (window as any).__DXKIT__;
  });

  it('renders #wallet-btn with no disabled attribute — a disabled button dispatches no click', () => {
    bootHeader();

    const trigger = document.getElementById('wallet-btn')!;
    expect(trigger).not.toBeNull();
    expect(trigger.hasAttribute('disabled')).toBe(false);
  });

  it('wraps the trigger in #wallet-panel beside its own #wallet-menu', () => {
    bootHeader();

    const panel = document.getElementById('wallet-panel')!;
    expect(panel.querySelector('#wallet-btn')).not.toBeNull();
    expect(panel.querySelector('#wallet-menu')).not.toBeNull();
  });

  it('with no provider the menu holds one plain sentence, no Connect control, and the trigger is muted', () => {
    bootHeader();

    const menu = document.getElementById('wallet-menu')!;
    const message = menu.querySelector('.wallet-message')!;
    expect(message).not.toBeNull();
    expect(message.textContent).toMatch(/no ethereum wallet was detected/i);
    expect(menu.querySelectorAll('button')).toHaveLength(0);
    expect(menu.querySelectorAll('a')).toHaveLength(0);
    expect(document.getElementById('wallet-btn')!.classList.contains('muted')).toBe(true);
  });

  it('the no-provider sentence names no wallet vendor and offers no outbound link', () => {
    bootHeader();

    const menu = document.getElementById('wallet-menu')!;
    expect(menu.querySelectorAll('a')).toHaveLength(0);
    for (const vendor of ['metamask', 'coinbase', 'rainbow', 'brave', 'phantom', 'trust', 'ledger']) {
      expect(menu.textContent!.toLowerCase()).not.toContain(vendor);
    }
  });

  it('the trigger opens the dropdown in the no-provider state — the control is not decoration', () => {
    bootHeader();
    const trigger = document.getElementById('wallet-btn')!;

    trigger.click();

    expect(document.getElementById('wallet-panel')!.classList.contains('open')).toBe(true);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
  });

  it('a second click on the trigger closes its own panel again', () => {
    bootHeader();
    const trigger = document.getElementById('wallet-btn')!;

    trigger.click();
    trigger.click();

    expect(document.getElementById('wallet-panel')!.classList.contains('open')).toBe(false);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });

  it('renders the Settings row when the route is claimed, and it reaches /settings via the router', () => {
    installFakeEthereum();
    const { dx } = bootHeader();

    const rows = Array.from(document.querySelectorAll('#wallet-menu .wallet-menu-row')) as HTMLButtonElement[];
    const settingsRow = rows.find((row) => /settings/i.test(row.textContent ?? ''))!;
    expect(settingsRow).toBeDefined();

    settingsRow.click();

    expect(dx.router.navigate).toHaveBeenCalledWith('/settings');
  });

  it('the Settings row closes the dropdown on the way out', () => {
    installFakeEthereum();
    bootHeader();
    document.getElementById('wallet-btn')!.click();

    // By verb, not by position: 02-06 puts the Connect row above this one.
    menuButton(/^settings/i)!.click();

    expect(document.getElementById('wallet-panel')!.classList.contains('open')).toBe(false);
    expect(document.getElementById('wallet-btn')!.getAttribute('aria-expanded')).toBe('false');
  });

  it('hides the Settings row rather than rendering a dead link when no manifest claims the route', () => {
    installFakeEthereum();
    bootHeader([]);

    // Scoped to the verb: the disconnected branch legitimately carries 02-06's Connect row.
    expect(menuButton(/^settings/i)).toBeUndefined();
  });

  it('every header trigger carries aria-haspopup and an aria-expanded that tracks open state', () => {
    bootHeader();

    for (const id of ['app-trigger', 'theme-panel-trigger', 'wallet-btn']) {
      const trigger = document.getElementById(id)!;
      expect(trigger.getAttribute('aria-haspopup')).toBe('true');
      expect(trigger.getAttribute('aria-expanded')).toBe('false');
    }

    document.getElementById('theme-panel-trigger')!.click();

    expect(document.getElementById('theme-panel-trigger')!.getAttribute('aria-expanded')).toBe('true');
  });

  it('opening one dropdown closes the other two', () => {
    bootHeader();

    document.getElementById('theme-panel-trigger')!.click();
    expect(document.getElementById('theme-panel')!.classList.contains('open')).toBe(true);

    document.getElementById('wallet-btn')!.click();

    expect(document.getElementById('theme-panel')!.classList.contains('open')).toBe(false);
    expect(document.getElementById('app-dropdown')!.classList.contains('open')).toBe(false);
    expect(document.getElementById('wallet-panel')!.classList.contains('open')).toBe(true);
  });

  it('Escape closes the open dropdown, syncs aria-expanded, and returns focus to its trigger', () => {
    bootHeader();
    const trigger = document.getElementById('wallet-btn')!;
    trigger.click();

    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    expect(document.getElementById('wallet-panel')!.classList.contains('open')).toBe(false);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger);
  });

  it('wireDropdowns adds exactly one document-level keydown listener', () => {
    loadShell();
    loadWalletModule();
    buildFixture();
    (window as any).__DXKIT__ = makeDxStub([SETTINGS_MANIFEST], makeWalletStub());

    const addSpy = vi.spyOn(document, 'addEventListener');
    (window as any).initShellChrome();
    const keydownCalls = addSpy.mock.calls.filter((c) => c[0] === 'keydown').length;
    addSpy.mockRestore();

    expect(keydownCalls).toBe(1);
  });

  it('the gear button closes the wallet menu too, not just the other two panels', () => {
    bootHeader();
    document.getElementById('wallet-btn')!.click();

    document.getElementById('settings-btn')!.click();

    expect(document.getElementById('wallet-panel')!.classList.contains('open')).toBe(false);
  });

  it('init returns a cleanup closure that releases every subscription the stubs handed out', () => {
    installFakeEthereum();
    loadShell();
    const walletModule = loadWalletModule();
    buildFixture();
    const wallet = makeWalletStub();
    const dx = makeDxStub([SETTINGS_MANIFEST], wallet);

    const cleanup = walletModule.init(dx);
    expect(typeof cleanup).toBe('function');
    expect(wallet._unsubscribe).not.toHaveBeenCalled();

    cleanup();

    expect(wallet._unsubscribe).toHaveBeenCalledTimes(1);
    expect(dx._offSpies.length).toBeGreaterThan(0);
    for (const off of dx._offSpies) {
      expect(off).toHaveBeenCalledTimes(1);
    }
  });

  it('repaints from a wallet plugin event without re-rendering the header', () => {
    installFakeEthereum();
    const { dx } = bootHeader();
    const triggerBefore = document.getElementById('wallet-btn');

    dx._eventHandlers['dx:plugin:wallet:connected']![0]({ address: VALID_ADDRESS, chainId: 1 });

    expect(document.getElementById('wallet-btn')).toBe(triggerBefore);
    expect(document.getElementById('share-btn')).not.toBeNull();
  });
});

describe('shell.ts source — one shared dropdown closer (D-20)', () => {
  const shell = readFileSync(resolve(__dirname, '../src/shell.ts'), 'utf-8');

  it('declares closeAllDropdowns once at module scope and calls it from at least four sites', () => {
    expect(shell.match(/^function closeAllDropdowns\(/gm)).toHaveLength(1);
    expect(shell.split('\n').filter((line) => line.includes('closeAllDropdowns()')).length).toBeGreaterThanOrEqual(4);
  });

  it('derives the three id pairs from one place, so only dropdownEntries knows them', () => {
    expect(shell.match(/^function dropdownEntries\(/gm)).toHaveLength(1);
  });

  it('wireSettingsButton no longer closes panels by id', () => {
    const body = shell.match(/function wireSettingsButton\([\s\S]*?\n\}/)?.[0];
    expect(body).toBeDefined();
    expect(body).toContain('closeAllDropdowns()');
    expect(body).not.toContain("'app-dropdown'");
    expect(body).not.toContain("'theme-panel'");
  });
});

describe('shell-wallet.ts and wallet-identity.ts source — module boundaries', () => {
  const walletSource = readFileSync(resolve(__dirname, '../src/shell-wallet.ts'), 'utf-8');
  const identitySource = readFileSync(resolve(__dirname, '../src/wallet-identity.ts'), 'utf-8');
  // The prohibitions below governed one file before 02-07 split it in two. They are evaluated
  // over both texts, so no rule was escaped by moving the code it applied to.
  const bothSources = `${walletSource}\n${identitySource}`;

  it('never reaches across files for the shared closer', () => {
    expect(bothSources).not.toContain('closeAllDropdowns');
  });

  it('writes every value to the DOM through textContent, never innerHTML', () => {
    expect(bothSources).not.toContain('innerHTML');
    expect(walletSource).toContain('textContent');
  });

  it('declares no class in either file', () => {
    expect(bothSources).not.toMatch(/^\s*class /m);
  });

  // The other half of the seam: the adapter names no storage key and builds no store, so the
  // only way it reaches the identity is through the port. Still true after 02-09 — there is no
  // store left for either file to build.
  it('keeps the adapter free of the storage keys and the store factory', () => {
    expect(walletSource).not.toContain('createIdentityStore');
    expect(walletSource).not.toContain('dnzn:dotdev:wallet:identity');
    expect(walletSource).not.toContain('dnzn:dotdev:settings');
  });

  it('models provenance in an internal resolveIdentity that never joins either public surface', () => {
    expect(walletSource.match(/^\s*function resolveIdentity\(/gm)).toHaveLength(1);
    expect(identitySource).not.toContain('resolveIdentity');
    const surface = walletSource.match(/window\.DnznWallet = \{[^}]*\}/)![0];
    expect(surface).not.toContain('resolveIdentity');
    const portSurface = identitySource.match(/window\.DnznWalletIdentity = \{[^}]*\}/)![0];
    expect(portSurface).not.toContain('resolveIdentity');
  });

  it('never claims identity was proven — no login or authentication vocabulary (P2)', () => {
    expect(stripLineComments(bothSources)).not.toMatch(/signed in|sign in|logged in|log in|authenticated|verified/i);
  });

  it('never re-renders the header or re-wires the dropdowns from either module', () => {
    expect(stripLineComments(bothSources)).not.toMatch(/renderHeader|wireDropdowns/);
  });

  // The port owns no node. A DOM concern leaking back across the seam is what the split exists
  // to prevent, and it is what would put the compiled payload budget out of reach again.
  it('the port touches no DOM at all', () => {
    expect(stripLineComments(identitySource)).not.toMatch(/document\.|createElement|textContent|querySelector/);
  });

  // T-02-45 / the privacy notice's central claim: after 02-09 neither module touches Web
  // Storage at all. A values constraint, not a style rule — DEC-A's promise is that nothing
  // about the address is written to this browser, so the gate is over the Web Storage API
  // global itself (both of localStorage and sessionStorage), comment-stripped so a comment
  // documenting the rule cannot turn its own gate red, and so this sentence cannot certify
  // itself by mentioning the word it forbids.
  it('touches no Web Storage API global anywhere in either file (02-09: nothing is persisted)', () => {
    expect(stripLineComments(bothSources)).not.toMatch(/localStorage|sessionStorage/);
  });

  // D-01's one sanctioned exception, and its boundary: the seam lives in wallet-identity.ts
  // alone, so shell-wallet.ts keeps asking the plugin what "available" means rather than
  // reaching for the injected provider itself.
  it('reaches window.ethereum only from wallet-identity.ts, behind the one sanctioned seam', () => {
    expect(identitySource).toContain('eth_accounts');
    expect(stripLineComments(walletSource)).not.toMatch(/window\.ethereum/);
  });
});

describe("shell-wallet — D-08's reconciliation rules (a lock is not a disconnect)", () => {
  const UPPER_ADDRESS = `0x${MIXED_ADDRESS.slice(2).toUpperCase()}`;

  beforeEach(() => {
    installFakeLocalStorage();
    installFakeEthereum();
  });

  afterEach(() => {
    window.localStorage.clear();
    delete (window as any).ethereum;
    delete (window as any).__DXKIT__;
  });

  function fire(dx: any, event: string, payload?: unknown) {
    for (const handler of dx._eventHandlers[`dx:plugin:wallet:${event}`] ?? []) handler(payload);
  }

  function chipText() {
    return document.querySelector('#wallet-btn .wallet-address')?.textContent ?? null;
  }

  it('a connected event writes address and chainId into memory and paints the chip', () => {
    const { dx, port } = bootHeader();

    fire(dx, 'connected', { address: MIXED_ADDRESS, chainId: 1 });

    expect(port.liveIdentity()).toEqual({ address: MIXED_ADDRESS, chainId: 1 });
    expect(chipText()).toBe(SHORT_MIXED);
  });

  it('a changed event with a different address rewrites memory and repaints', async () => {
    installFakeEthereum({ accounts: [VALID_ADDRESS] });
    const { dx, port } = bootHeader();
    await flushMicrotasks();
    const rowBefore = document.querySelector('.wallet-address-row');

    fire(dx, 'changed', { address: MIXED_ADDRESS, chainId: 1 });

    expect(port.liveIdentity()!.address).toBe(MIXED_ADDRESS);
    expect(chipText()).toBe(SHORT_MIXED);
    expect(document.querySelector('.wallet-address-row')).not.toBe(rowBefore);
  });

  it('a changed event carrying the same address in another case rewrites nothing (D-18)', async () => {
    installFakeEthereum({ accounts: [MIXED_ADDRESS] });
    const { dx, port } = bootHeader();
    await flushMicrotasks();
    const before = port.liveIdentity();
    const rowBefore = document.querySelector('.wallet-address-row');

    fire(dx, 'changed', { address: UPPER_ADDRESS, chainId: 1 });

    expect(port.liveIdentity()).toEqual(before);
    expect(document.querySelector('.wallet-address-row')).toBe(rowBefore);
    expect(chipText()).toBe(SHORT_MIXED);
  });

  it('a disconnected event clears nothing and leaves the chip showing the address', async () => {
    installFakeEthereum({ accounts: [VALID_ADDRESS] });
    const { dx, port } = bootHeader();
    await flushMicrotasks();
    const before = port.liveIdentity();

    fire(dx, 'disconnected', {});

    expect(port.liveIdentity()).toEqual(before);
    expect(chipText()).toBe(SHORT_VALID);
  });

  it('an onStateChange callback reporting connected writes the pair and paints the chip', () => {
    const { wallet, port } = bootHeader();
    const onState = wallet.onStateChange.mock.calls[0][0];

    onState({ connected: true, address: VALID_ADDRESS, chainId: 1, provider: {} });

    expect(port.liveIdentity()).toEqual({ address: VALID_ADDRESS, chainId: 1 });
    expect(chipText()).toBe(SHORT_VALID);
  });

  it('an onStateChange callback reporting disconnected — the shape a lock produces — changes nothing', async () => {
    installFakeEthereum({ accounts: [VALID_ADDRESS] });
    const { wallet, port } = bootHeader();
    await flushMicrotasks();
    const before = port.liveIdentity();

    wallet.onStateChange.mock.calls[0][0]({ connected: false, address: null, chainId: null, provider: null });

    expect(port.liveIdentity()).toEqual(before);
    expect(chipText()).toBe(SHORT_VALID);
  });

  it('a chainId of 0 in an event payload is treated as null, not as chain zero', () => {
    const { dx, port } = bootHeader();

    fire(dx, 'connected', { address: VALID_ADDRESS, chainId: 0 });

    expect(port.liveIdentity()).toEqual({ address: VALID_ADDRESS, chainId: null });
  });

  it('init attempts no connect() and no eth_requestAccounts before any gesture (T-02-02)', () => {
    const ethereum = installFakeEthereum({ accounts: [VALID_ADDRESS] });

    const { wallet } = bootHeader();

    expect(wallet.connect.mock.calls.length).toBe(0);
    expect(ethereum.request.mock.calls.some((call: any) => call[0]?.method === 'eth_requestAccounts')).toBe(false);
  });

  it('two dropdown opens with no close between them make exactly one re-arm attempt', async () => {
    installFakeEthereum({ accounts: [VALID_ADDRESS] });
    const control = mountWalletOnly(makeWalletStub({ connect: vi.fn(neverSettles) }));
    await flushMicrotasks();

    control.open();
    control.open();

    expect(control.wallet.connect.mock.calls.length).toBe(1);
  });

  it('the single-flight flag does not latch: open, close, open re-arms twice (T-02-24)', async () => {
    installFakeEthereum({ accounts: [VALID_ADDRESS] });
    // MetaMask #11280: a dismissed unlock prompt leaves eth_requestAccounts pending forever, so
    // the finally never runs and a finally-only reset would make this control permanently inert.
    const control = mountWalletOnly(makeWalletStub({ connect: vi.fn(neverSettles) }));
    await flushMicrotasks();

    control.open();
    control.close();
    control.open();

    expect(control.wallet.connect.mock.calls.length).toBe(2);
  });

  it('a rejected re-arm is inert but recoverable — nothing cleared, nothing logged', async () => {
    installFakeEthereum({ accounts: [VALID_ADDRESS] });
    const control = mountWalletOnly(makeWalletStub({ connect: vi.fn(() => Promise.reject({ code: 4001 })) }));
    await flushMicrotasks();
    const before = control.port.liveIdentity();
    const chipBefore = chipText();
    const consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((key) =>
      vi.spyOn(console, key).mockImplementation(() => undefined),
    );

    expect(() => control.open()).not.toThrow();
    // Drain the rejection and the reset it schedules, with no close in between, so the second
    // attempt proves the catch released the flag rather than the dropdown-close path.
    await flushMicrotasks();
    control.open();

    expect(control.wallet.connect.mock.calls.length).toBe(2);
    expect(control.port.liveIdentity()).toEqual(before);
    expect(chipText()).toBe(chipBefore);
    for (const spy of consoleSpies) {
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    }
  });

  it('the cleanup closure releases every subscription, and a second call is a no-op', () => {
    const control = mountWalletOnly(makeWalletStub({ connect: vi.fn(neverSettles) }));

    control.cleanup();

    expect(control.wallet._unsubscribe).toHaveBeenCalledTimes(1);
    // Three dx.events.on disposables now: the three wallet events. 02-09 retired the
    // dx:plugin:settings:changed subscription and the cross-tab storage listener along with
    // the identity cache they governed — there is nothing left to opt out of.
    expect(control.dx._offSpies).toHaveLength(3);
    for (const off of control.dx._offSpies) expect(off).toHaveBeenCalledTimes(1);
    expect(() => control.cleanup()).not.toThrow();
    expect(control.wallet._unsubscribe).toHaveBeenCalledTimes(1);
    // The trigger listener went with it, so a re-mounted header cannot accumulate re-arms.
    control.open();
    expect(control.wallet.connect.mock.calls.length).toBe(0);
  });

  // T-02-42: both direct provider listeners join the port's own cleanup closure, so a re-init
  // cannot accumulate handlers writing into a header nothing owns.
  it('cleanup releases the two direct provider listeners the port registered (T-02-42)', () => {
    const ethereum = installFakeEthereum();
    const control = mountWalletOnly(makeWalletStub());

    control.cleanup();

    expect(ethereum.removeListener).toHaveBeenCalledWith('accountsChanged', expect.any(Function));
    expect(ethereum.removeListener).toHaveBeenCalledWith('chainChanged', expect.any(Function));
  });

  it('the cleanup closure drops the menu rows, leaving no control it built reachable', async () => {
    // The same argument the closure already makes for the pending watchdog handle. Every row
    // render() builds carries a listener closing over dx, so rows left in the document after
    // cleanup are clickable controls that reach startConnect, disconnectWallet and the router in
    // a menu this closure has stopped owning — and a Connect from one of them arms a timer whose
    // callback then writes into it.
    installFakeEthereum({ accounts: [VALID_ADDRESS] });
    const control = mountWalletOnly(makeWalletStub());
    await flushMicrotasks();
    expect(menuButton(DISCONNECT_ROW)).toBeDefined();

    control.cleanup();

    expect(document.querySelectorAll('#wallet-menu button')).toHaveLength(0);
    expect(document.getElementById('wallet-menu')!.children).toHaveLength(0);
  });

  it('a real trigger click drives the same open, close, open sequence through shell.ts', async () => {
    installFakeEthereum({ accounts: [VALID_ADDRESS] });
    const wallet = makeWalletStub({ connect: vi.fn(neverSettles) });
    bootHeader([SETTINGS_MANIFEST], wallet);
    await flushMicrotasks();
    const trigger = document.getElementById('wallet-btn')!;

    trigger.click();
    trigger.click();
    trigger.click();

    expect(wallet.connect.mock.calls.length).toBe(2);
  });

  it('opening the dropdown makes no re-arm attempt in the no-provider state (WAL-07, D-15)', () => {
    // No provider from the first paint, so render() takes the no-provider branch and appends no
    // .wallet-alert for setMessage to write into. A live identity already in memory — learned
    // earlier in the session, before the extension vanished — must not make the refusal any
    // less certain: reArm's no-provider check comes first, regardless of what the port
    // remembers.
    delete (window as unknown as { ethereum?: unknown }).ethereum;
    const control = mountWalletOnly(makeWalletStub({ connect: vi.fn(neverSettles) }));
    control.port.acceptLiveIdentity(control.dx, VALID_ADDRESS, 1);
    expect(control.walletModule.resolveState(control.dx)).toBe('no-provider');

    control.open();

    expect(control.wallet.connect.mock.calls.length).toBe(0);
    // The other half of why the attempt has to be refused rather than reported: this state has
    // nowhere to report it.
    expect(document.querySelector('#wallet-menu .wallet-alert')).toBeNull();
  });
});

describe("shell-wallet — the connected chip paints from the injected provider's own answer (WAL-05)", () => {
  beforeEach(() => {
    installFakeLocalStorage();
  });

  afterEach(() => {
    window.localStorage.clear();
    delete (window as any).ethereum;
    delete (window as any).__DXKIT__;
  });

  it('paints the address into the header chip once the query answers, with no eth_requestAccounts call', async () => {
    const ethereum = installFakeEthereum({ accounts: [VALID_ADDRESS] });

    const { wallet } = bootHeader();
    await flushMicrotasks();

    expect(document.querySelector('#wallet-btn .wallet-chip')).not.toBeNull();
    expect(document.querySelector('#wallet-btn .wallet-address')!.textContent).toBe(SHORT_VALID);
    expect(ethereum.request.mock.calls.some((call: any) => call[0]?.method === 'eth_requestAccounts')).toBe(false);
    expect(wallet.connect.mock.calls.length).toBe(0);
  });

  it("renders the disconnected state before the query answers — DEC-A's stated first-paint cost", () => {
    installFakeEthereum({ accounts: [VALID_ADDRESS] });

    bootHeader();

    // Synchronously, before any microtask has run: the header painted from nothing rather than a
    // cache. This is the flash the SUMMARY documents for UAT.
    expect(document.querySelector('.wallet-chip')).toBeNull();
  });

  it('renders the disconnected state once the query answers empty — the origin has no authorised account', async () => {
    installFakeEthereum({ accounts: [] });

    bootHeader();
    await flushMicrotasks();

    expect(document.querySelector('.wallet-chip')).toBeNull();
  });

  it('a query that never settles still leaves the header rendered rather than blank (T-02-39)', async () => {
    const ethereum = installFakeEthereum();
    ethereum.request.mockImplementation(() => neverSettles());

    bootHeader();
    await flushMicrotasks();

    const menu = document.getElementById('wallet-menu')!;
    expect(menu.querySelectorAll('button').length).toBeGreaterThan(0);
    expect(document.querySelector('.wallet-chip')).toBeNull();
  });

  it('a boot with a valid-looking identity blob left by a previous build paints nothing — nothing reads it any more', () => {
    window.localStorage.setItem(IDENTITY_KEY, JSON.stringify({ address: VALID_ADDRESS, chainId: 1 }));

    bootHeader();

    expect(document.querySelector('.wallet-chip')).toBeNull();
  });

  it("carries the full address on the trigger's title while the visible text stays shortened", async () => {
    installFakeEthereum({ accounts: [VALID_ADDRESS] });

    bootHeader();
    await flushMicrotasks();

    const trigger = document.getElementById('wallet-btn')!;
    expect(trigger.getAttribute('title')).toBe(VALID_ADDRESS);
    expect(trigger.getAttribute('title')).toHaveLength(42);
    // The trigger's only text node is the chip; the rest is the inline SVG's indentation.
    expect(trigger.textContent!.trim()).toBe(SHORT_VALID);
  });

  it('shows the same shortened address in the dropdown, in the casing the provider gave', async () => {
    installFakeEthereum({ accounts: [MIXED_ADDRESS] });

    bootHeader();
    await flushMicrotasks();

    expect(Array.from(document.querySelectorAll('.wallet-address')).map((n) => n.textContent)).toEqual([
      SHORT_MIXED,
      SHORT_MIXED,
    ]);
    expect(document.getElementById('wallet-menu')!.textContent).toContain(SHORT_MIXED);
  });

  it('with an empty query answer, no chip renders and the state is disconnected', async () => {
    installFakeEthereum({ accounts: [] });

    const { dx, walletModule } = bootHeader();
    await flushMicrotasks();

    expect(document.querySelector('.wallet-chip')).toBeNull();
    expect(document.querySelector('#wallet-menu .wallet-address')).toBeNull();
    expect(walletModule.resolveState(dx)).toBe('disconnected');
  });
});

// The query's failure modes: a rejection, a hostile or malformed answer, a chain-id read that
// fails on its own, and a stale blob left by a build that used to persist. Each proves a branch
// probeAccounts/acceptLiveIdentity takes when the provider is not cooperative or not trustworthy.
describe("shell-wallet — the query's edge cases: rejection, malformed payloads, chain-id failure, and the retired key (T-02-38, T-02-45)", () => {
  beforeEach(() => {
    installFakeLocalStorage();
  });

  afterEach(() => {
    window.localStorage.clear();
    delete (window as any).ethereum;
    delete (window as any).__DXKIT__;
  });

  it('a rejected eth_accounts call leaves the header rendered disconnected and throws nothing', async () => {
    const ethereum = installFakeEthereum();
    ethereum.request.mockImplementation((args?: { method?: string }) =>
      args?.method === 'eth_accounts' ? Promise.reject(new Error('User rejected')) : Promise.resolve(undefined),
    );

    expect(() => bootHeader()).not.toThrow();
    await flushMicrotasks();

    expect(document.querySelector('.wallet-chip')).toBeNull();
    expect(document.getElementById('wallet-menu')!.querySelectorAll('button').length).toBeGreaterThan(0);
  });

  it('a non-array eth_accounts answer is dropped whole — nothing accepted, nothing repainted (T-02-38)', async () => {
    const ethereum = installFakeEthereum();
    ethereum.request.mockImplementation((args?: { method?: string }) =>
      args?.method === 'eth_accounts' ? Promise.resolve({ address: VALID_ADDRESS }) : Promise.resolve('0x1'),
    );

    bootHeader();
    await flushMicrotasks();

    expect(document.querySelector('.wallet-chip')).toBeNull();
  });

  it('an array of non-string entries is dropped whole (T-02-38)', async () => {
    const ethereum = installFakeEthereum();
    ethereum.request.mockImplementation((args?: { method?: string }) =>
      args?.method === 'eth_accounts' ? Promise.resolve([12345]) : Promise.resolve('0x1'),
    );

    bootHeader();
    await flushMicrotasks();

    expect(document.querySelector('.wallet-chip')).toBeNull();
  });

  it('a wrong-length address is dropped whole (T-02-38)', async () => {
    installFakeEthereum({ accounts: [`${VALID_ADDRESS}9`] });

    bootHeader();
    await flushMicrotasks();

    expect(document.querySelector('.wallet-chip')).toBeNull();
  });

  it('a chain-id read that rejects still accepts the address, with chainId null', async () => {
    const ethereum = installFakeEthereum({ accounts: [VALID_ADDRESS] });
    ethereum.request.mockImplementation((args?: { method?: string }) => {
      if (args?.method === 'eth_accounts') return Promise.resolve([VALID_ADDRESS]);
      if (args?.method === 'eth_chainId') return Promise.reject(new Error('chain unavailable'));
      return Promise.resolve(undefined);
    });

    const { port } = bootHeader();
    await flushMicrotasks();

    expect(port.liveIdentity()).toEqual({ address: VALID_ADDRESS, chainId: null });
    expect(document.querySelector('#wallet-btn .wallet-chip')).not.toBeNull();
  });

  // The revoked-origin case (G-02-10) with a decoy: a stale blob under the retired key must not
  // be read as a fallback, and this plan's retirement must not have added a write anywhere in
  // either wallet module — main.ts's one-way migration is the only sanctioned remover, and it is
  // not loaded here at all (bootHeader boots shell.js + shell-wallet.js + wallet-identity.js
  // only), so any mutation observed below would have to come from one of the two files this
  // plan's matrix is about.
  it('an empty query answer with a stale identity blob under the retired key still renders disconnected, and neither wallet module touches that key', async () => {
    window.localStorage.setItem(IDENTITY_KEY, JSON.stringify({ address: VALID_ADDRESS, chainId: 1 }));
    installFakeEthereum({ accounts: [] });
    const setItemSpy = vi.spyOn(window.localStorage, 'setItem');
    const removeItemSpy = vi.spyOn(window.localStorage, 'removeItem');

    bootHeader();
    await flushMicrotasks();

    expect(document.querySelector('.wallet-chip')).toBeNull();
    expect(setItemSpy).not.toHaveBeenCalled();
    expect(removeItemSpy).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(IDENTITY_KEY)).not.toBeNull();
  });
});

// T-02-42's other half: the direct accountsChanged/chainChanged subscription wallet-identity.ts
// registers on window.ethereum itself, reached here through the fake provider's own `on` spy
// rather than through dx.events — the D-08 reconciliation describe above covers the vendored
// plugin's events, a materially different code path from this one.
describe('shell-wallet — the direct provider subscription (accountsChanged/chainChanged, T-02-42)', () => {
  beforeEach(() => {
    installFakeLocalStorage();
  });

  afterEach(() => {
    window.localStorage.clear();
    delete (window as any).ethereum;
    delete (window as any).__DXKIT__;
  });

  function providerHandler(ethereum: any, event: string) {
    const call = ethereum.on.mock.calls.find((c: any[]) => c[0] === event);
    return call?.[1];
  }

  it('a different account on accountsChanged repaints the chip and the dropdown row with no click — fails if the direct subscription is removed', async () => {
    const ethereum = installFakeEthereum({ accounts: [VALID_ADDRESS] });
    bootHeader();
    await flushMicrotasks();
    expect(document.querySelector('.wallet-address-row .wallet-address')!.textContent).toBe(SHORT_VALID);
    const handler = providerHandler(ethereum, 'accountsChanged');
    expect(handler).toBeDefined();

    handler([MIXED_ADDRESS]);

    expect(document.querySelector('#wallet-btn .wallet-address')!.textContent).toBe(SHORT_MIXED);
    expect(document.querySelector('.wallet-address-row .wallet-address')!.textContent).toBe(SHORT_MIXED);
  });

  it('an empty accountsChanged clears nothing and repaints nothing — locked is not disconnected (T-02-20, DEC-B)', async () => {
    const ethereum = installFakeEthereum({ accounts: [VALID_ADDRESS] });
    const { port } = bootHeader();
    await flushMicrotasks();
    const before = port.liveIdentity();

    providerHandler(ethereum, 'accountsChanged')([]);

    expect(port.liveIdentity()).toEqual(before);
    expect(document.querySelector('#wallet-btn .wallet-address')!.textContent).toBe(SHORT_VALID);
  });

  it('accountsChanged with the same account in different casing is not treated as a change (D-18)', async () => {
    const ethereum = installFakeEthereum({ accounts: [MIXED_ADDRESS] });
    const { port } = bootHeader();
    await flushMicrotasks();
    const rowBefore = document.querySelector('.wallet-address-row');
    const upper = `0x${MIXED_ADDRESS.slice(2).toUpperCase()}`;

    providerHandler(ethereum, 'accountsChanged')([upper]);

    // The stored casing stays the provider's original — accountsChanged carries no chain data of
    // its own, so this branch's only promise is the one D-18 makes: an account this module
    // already knows, arriving in another case, is not a change. It does not repaint.
    expect(port.liveIdentity()!.address).toBe(MIXED_ADDRESS);
    expect(document.querySelector('.wallet-address-row')).toBe(rowBefore);
  });

  it('chainChanged does not repaint the address', async () => {
    const ethereum = installFakeEthereum({ accounts: [VALID_ADDRESS] });
    bootHeader();
    await flushMicrotasks();
    const rowBefore = document.querySelector('.wallet-address-row');

    providerHandler(ethereum, 'chainChanged')('0x5');

    expect(document.querySelector('.wallet-address-row')).toBe(rowBefore);
    expect(document.querySelector('#wallet-btn .wallet-address')!.textContent).toBe(SHORT_VALID);
  });

  it('a re-init after cleanup registers exactly the same two direct listeners, not double', async () => {
    const ethereum = installFakeEthereum({ accounts: [VALID_ADDRESS] });
    const first = mountWalletOnly(makeWalletStub());
    await flushMicrotasks();
    expect(ethereum.on.mock.calls.filter((c: any[]) => c[0] === 'accountsChanged')).toHaveLength(1);
    expect(ethereum.on.mock.calls.filter((c: any[]) => c[0] === 'chainChanged')).toHaveLength(1);

    first.cleanup();
    ethereum.on.mockClear();

    const second = mountWalletOnly(makeWalletStub());
    await flushMicrotasks();

    expect(ethereum.on.mock.calls.filter((c: any[]) => c[0] === 'accountsChanged')).toHaveLength(1);
    expect(ethereum.on.mock.calls.filter((c: any[]) => c[0] === 'chainChanged')).toHaveLength(1);
    second.cleanup();
  });
});

describe('shell-wallet — Connect from the dropdown (WAL-02)', () => {
  beforeEach(() => {
    installFakeLocalStorage();
    installFakeEthereum();
  });

  afterEach(() => {
    vi.useRealTimers();
    window.localStorage.clear();
    delete (window as any).ethereum;
    delete (window as any).__DXKIT__;
  });

  it('clicking Connect calls the wallet plugin connect() exactly once', async () => {
    const control = mountWalletOnly(makeWalletStub({ connect: vi.fn(() => Promise.resolve()) }));

    menuButton(CONNECT_ROW)!.click();
    await flushMicrotasks();

    expect(control.wallet.connect.mock.calls.length).toBe(1);
  });

  it('disables the control while the request is pending, so a second click fires no second request', () => {
    const control = mountWalletOnly(makeWalletStub({ connect: vi.fn(neverSettles) }));
    const row = menuButton(CONNECT_ROW)!;

    row.click();
    expect(row.disabled).toBe(true);
    row.click();

    expect(control.wallet.connect.mock.calls.length).toBe(1);
  });

  it('re-enables the control once a resolved promise settles', async () => {
    mountWalletOnly(makeWalletStub({ connect: vi.fn(() => Promise.resolve()) }));
    const row = menuButton(CONNECT_ROW)!;

    row.click();
    expect(row.disabled).toBe(true);
    await flushMicrotasks();

    expect(row.disabled).toBe(false);
  });

  it('re-enables the control once a rejected promise settles, not only after a resolved one', async () => {
    mountWalletOnly(makeWalletStub({ connect: vi.fn(() => Promise.reject({ code: 4900 })) }));
    const row = menuButton(CONNECT_ROW)!;

    row.click();
    await flushMicrotasks();

    expect(row.disabled).toBe(false);
  });

  it('a connect() that never settles does not latch the guard — it re-arms and says so (T-02-24)', () => {
    vi.useFakeTimers();
    mountWalletOnly(makeWalletStub({ connect: vi.fn(neverSettles) }));
    const row = menuButton(CONNECT_ROW)!;

    row.click();
    expect(row.disabled).toBe(true);
    vi.advanceTimersByTime(GUARD_MS);

    expect(row.disabled).toBe(false);
    expect(messageText()).toMatch(/has not answered yet/i);
  });

  it('after the watchdog re-arm a second click reaches connect() again and still leaves a message', async () => {
    vi.useFakeTimers();
    // The first attempt is controllable rather than eternal, and that is the whole point.
    // MetaMask #11280's hang is what arms the watchdog, but the guard-ownership defect only
    // shows when that same request settles LATE, with a newer one already in flight. A
    // never-settling first attempt cannot reach that edge, which is why this case used to be
    // green against a release that had no notion of which attempt owned the guard.
    const first = Promise.withResolvers();
    const connect = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(neverSettles);
    mountWalletOnly(makeWalletStub({ connect }));
    const row = menuButton(CONNECT_ROW)!;

    row.click();
    vi.advanceTimersByTime(GUARD_MS);
    row.click();

    // Both halves of the original contract: a fresh request went out, and the person still has
    // a sentence to read while a request is outstanding.
    expect(connect.mock.calls.length).toBe(2);
    expect(messageText()).not.toBe('');

    // The first attempt answers now, after the second is already outstanding. Its finally must
    // release nothing: the guard it would clear belongs to a request still in flight, and
    // re-opening the control here lets a third connect() tear down the listener the second
    // one's approval arrives on (../dxkit/plugins/wallet/src/index.ts:300-305).
    first.resolve(undefined);
    await flushMicrotasks();

    expect(row.disabled).toBe(true);
    row.click();
    expect(connect.mock.calls.length).toBe(2);
  });

  it("a late first attempt does not cancel the second attempt's watchdog", async () => {
    vi.useFakeTimers();
    const first = Promise.withResolvers();
    const connect = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(neverSettles);
    mountWalletOnly(makeWalletStub({ connect }));
    const row = menuButton(CONNECT_ROW)!;

    row.click();
    vi.advanceTimersByTime(GUARD_MS);
    row.click();
    first.resolve(undefined);
    await flushMicrotasks();

    // The bound is the load-bearing part, not the flag. A second request left unbounded is a
    // control that stays inert for the rest of the session with -32002 deliberately silent and
    // nothing at all on screen.
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(GUARD_MS);

    expect(row.disabled).toBe(false);
    expect(messageText()).toMatch(/has not answered yet/i);
  });

  it('the cleanup closure releases the watchdog — no timer callback touches the DOM afterwards', () => {
    vi.useFakeTimers();
    const control = mountWalletOnly(makeWalletStub({ connect: vi.fn(neverSettles) }));
    menuButton(CONNECT_ROW)!.click();

    control.cleanup();
    const menuBefore = document.getElementById('wallet-menu')!.innerHTML;
    vi.advanceTimersByTime(GUARD_MS);

    expect(messageText()).toBe('');
    expect(document.getElementById('wallet-menu')!.innerHTML).toBe(menuBefore);
  });

  it('a 4001 rejection leaves the message region empty and changes no state', async () => {
    mountWalletOnly(makeWalletStub({ connect: vi.fn(() => Promise.reject({ code: 4001 })) }));

    menuButton(CONNECT_ROW)!.click();
    await flushMicrotasks();

    expect(messageText()).toBe('');
    expect(identityPort().liveIdentity()).toBeNull();
    expect(document.querySelector('.wallet-chip')).toBeNull();
  });

  it('a -32002 rejection leaves the message region empty too — it is a wait, not a failure', async () => {
    mountWalletOnly(makeWalletStub({ connect: vi.fn(() => Promise.reject({ code: -32002 })) }));

    menuButton(CONNECT_ROW)!.click();
    await flushMicrotasks();

    expect(messageText()).toBe('');
  });

  it('4100, 4200, 4900, 4901 and an unrecognised code each produce a distinct non-empty message', async () => {
    const seen: string[] = [];

    for (const code of [4100, 4200, 4900, 4901, 999999]) {
      const control = mountWalletOnly(makeWalletStub({ connect: vi.fn(() => Promise.reject({ code })) }));
      menuButton(CONNECT_ROW)!.click();
      await flushMicrotasks();
      seen.push(messageText());
      control.cleanup();
    }

    for (const message of seen) expect(message.length).toBeGreaterThan(0);
    expect(new Set(seen).size).toBe(5);
  });

  it("an error's own message string never reaches the DOM (T-02-23)", async () => {
    const marker = 'PROVIDER_MARKER_9f3a';
    mountWalletOnly(
      makeWalletStub({ connect: vi.fn(() => Promise.reject({ code: 4900, message: `<img src=x> ${marker}` })) }),
    );

    menuButton(CONNECT_ROW)!.click();
    await flushMicrotasks();

    expect(messageText().length).toBeGreaterThan(0);
    expect(document.getElementById('wallet-menu')!.textContent).not.toContain(marker);
    expect(document.body.textContent).not.toContain(marker);
  });

  it('a successful connect writes the address and chainId into memory and paints the chip', async () => {
    mountWalletOnly(
      makeWalletStub({
        connect: vi.fn(() => Promise.resolve({ connected: true, address: MIXED_ADDRESS, chainId: 1, provider: {} })),
      }),
    );

    menuButton(CONNECT_ROW)!.click();
    await flushMicrotasks();

    expect(identityPort().liveIdentity()).toEqual({ address: MIXED_ADDRESS, chainId: 1 });
    expect(document.querySelector('#wallet-btn .wallet-address')!.textContent).toBe(SHORT_MIXED);
  });

  it('opening the dropdown clears a message left by a previous attempt (D-16)', async () => {
    const control = mountWalletOnly(makeWalletStub({ connect: vi.fn(() => Promise.reject({ code: 4900 })) }));
    menuButton(CONNECT_ROW)!.click();
    await flushMicrotasks();
    expect(messageText()).not.toBe('');

    control.open();

    expect(messageText()).toBe('');
  });

  it('the no-provider render offers no Connect control at all (WAL-07, D-15)', () => {
    delete (window as any).ethereum;

    mountWalletOnly(makeWalletStub());

    expect(menuButton(CONNECT_ROW)).toBeUndefined();
    expect(document.querySelectorAll('#wallet-menu button')).toHaveLength(0);
  });
});

describe('shell-wallet — Disconnect from the dropdown (WAL-04)', () => {
  beforeEach(() => {
    installFakeLocalStorage();
    // Seeds a connected baseline through the query, the way a returning visit actually would.
    // Each test that needs it painted awaits flushMicrotasks() once, right after mounting.
    installFakeEthereum({ accounts: [VALID_ADDRESS] });
  });

  afterEach(() => {
    window.localStorage.clear();
    delete (window as any).ethereum;
    delete (window as any).__DXKIT__;
  });

  it('clicking Disconnect calls the wallet plugin disconnect() exactly once', async () => {
    const control = mountWalletOnly(makeWalletStub({ disconnect: vi.fn(() => Promise.resolve()) }));
    await flushMicrotasks();

    menuButton(DISCONNECT_ROW)!.click();

    expect(control.wallet.disconnect.mock.calls.length).toBe(1);
  });

  it('clicking Disconnect forgets the in-memory identity (D-08, T6)', async () => {
    const control = mountWalletOnly(makeWalletStub({ disconnect: vi.fn(() => Promise.resolve()) }));
    await flushMicrotasks();

    menuButton(DISCONNECT_ROW)!.click();

    expect(control.port.liveIdentity()).toBeNull();
  });

  it('after Disconnect the dropdown holds Connect and Settings, with no chip and no address', async () => {
    mountWalletOnly(makeWalletStub({ disconnect: vi.fn(() => Promise.resolve()) }));
    await flushMicrotasks();

    menuButton(DISCONNECT_ROW)!.click();

    const menu = document.getElementById('wallet-menu')!;
    expect(document.querySelector('.wallet-chip')).toBeNull();
    expect(menuButton(CONNECT_ROW)).toBeDefined();
    expect(menuButton(/^settings/i)).toBeDefined();
    expect(menuButton(DISCONNECT_ROW)).toBeUndefined();
    expect(menu.textContent).not.toContain(SHORT_VALID);
    expect(menu.textContent).not.toContain(VALID_ADDRESS);
  });

  it('a rejected disconnect() still forgets the identity and still renders disconnected', async () => {
    const control = mountWalletOnly(
      makeWalletStub({ disconnect: vi.fn(() => Promise.reject(new Error('popup closed'))) }),
    );
    await flushMicrotasks();

    menuButton(DISCONNECT_ROW)!.click();
    await flushMicrotasks();

    expect(control.port.liveIdentity()).toBeNull();
    expect(document.querySelector('.wallet-chip')).toBeNull();
    expect(menuButton(CONNECT_ROW)).toBeDefined();
  });

  it('repaints disconnected before the provider call — a pending disconnect() cannot hold the chip', async () => {
    const control = mountWalletOnly(makeWalletStub({ disconnect: vi.fn(neverSettles) }));
    await flushMicrotasks();

    // No further await and no timer advance: everything asserted below happened inside the
    // click itself, while the plugin's disconnect() is still unsettled (T-02-36).
    menuButton(DISCONNECT_ROW)!.click();

    expect(control.port.liveIdentity()).toBeNull();
    expect(document.querySelector('#wallet-btn .wallet-chip')).toBeNull();
    expect(document.getElementById('wallet-menu')!.textContent).not.toContain(SHORT_VALID);
    expect(menuButton(CONNECT_ROW)).toBeDefined();
  });

  it('a reload after Disconnect starts disconnected when the wallet actually revoked (P6)', async () => {
    const ethereum = installFakeEthereum({ accounts: [VALID_ADDRESS] });
    const first = mountWalletOnly(makeWalletStub({ disconnect: vi.fn(() => Promise.resolve()) }));
    await flushMicrotasks();
    menuButton(DISCONNECT_ROW)!.click();
    first.cleanup();
    // Simulates the wallet having honoured wallet_revokePermissions: this origin's authorisation
    // is gone, so the next load's silent query answers empty.
    ethereum.request.mockImplementation((args?: { method?: string }) =>
      args?.method === 'eth_accounts' ? Promise.resolve([]) : Promise.resolve(undefined),
    );

    const reloaded = mountWalletOnly(makeWalletStub());
    await flushMicrotasks();

    const menu = document.getElementById('wallet-menu')!;
    expect(document.querySelector('.wallet-chip')).toBeNull();
    expect(menu.textContent).not.toContain(VALID_ADDRESS);
    expect(menu.textContent).not.toContain(SHORT_VALID);
    expect(reloaded.wallet.connect.mock.calls.length).toBe(0);
    expect(reloaded.walletModule.resolveState(reloaded.dx)).toBe('disconnected');
  });

  // The residual DEC-A creates and does not hide (T-02-40): with nothing persisted, Disconnect
  // only survives a reload if the wallet itself let go. This fake never does, so the honest
  // outcome is a reload that shows connected again — not a defect, the documented cost of
  // retiring the cache.
  it('a reload after Disconnect still shows connected if the wallet did not revoke (T-02-40)', async () => {
    installFakeEthereum({ accounts: [VALID_ADDRESS] });
    const first = mountWalletOnly(makeWalletStub({ disconnect: vi.fn(() => Promise.resolve()) }));
    await flushMicrotasks();
    menuButton(DISCONNECT_ROW)!.click();
    first.cleanup();

    const reloaded = mountWalletOnly(makeWalletStub());
    await flushMicrotasks();

    expect(document.querySelector('#wallet-btn .wallet-address')!.textContent).toBe(SHORT_VALID);
    expect(reloaded.walletModule.resolveState(reloaded.dx)).toBe('connected');
  });

  it('a disconnected event with no click leaves the identity alone — the lock rule holds', async () => {
    const control = mountWalletOnly(makeWalletStub());
    await flushMicrotasks();
    const before = control.port.liveIdentity();

    for (const handler of control.dx._eventHandlers['dx:plugin:wallet:disconnected'] ?? []) handler({});

    expect(control.port.liveIdentity()).toEqual(before);
    expect(document.querySelector('#wallet-btn .wallet-chip')).not.toBeNull();
    expect(control.wallet.disconnect.mock.calls.length).toBe(0);
  });

  // The plugin's own getState() no longer feeds resolveIdentity at all (02-09), so the
  // mid-session race this used to isolate — a plugin that lags in reporting disconnected — has
  // no subject any more: liveSuppressed plus the synchronous clearIdentity() are the whole of
  // what makes a Disconnect click immediate, regardless of what the plugin reports afterwards.
  it('a Disconnect click clears memory and suppresses the chip even though the plugin has not finished disconnecting (P6)', async () => {
    const wallet = makeWalletStub({ disconnect: vi.fn(neverSettles) });
    const control = mountWalletOnly(wallet);
    await flushMicrotasks();
    expect(document.querySelector('#wallet-btn .wallet-chip')).not.toBeNull();

    menuButton(DISCONNECT_ROW)!.click();

    expect(document.querySelector('#wallet-btn .wallet-chip')).toBeNull();
    expect(menuButton(CONNECT_ROW)).toBeDefined();
    expect(control.walletModule.resolveState(control.dx)).toBe('disconnected');
  });

  it('a later Connect gesture lifts the suppression, so the chip is not stranded off', async () => {
    const wallet = makeWalletStub({
      disconnect: vi.fn(() => Promise.resolve()),
      connect: vi.fn(() => Promise.resolve({ connected: true, address: VALID_ADDRESS, chainId: 1, provider: {} })),
    });
    const control = mountWalletOnly(wallet);
    await flushMicrotasks();
    menuButton(DISCONNECT_ROW)!.click();

    menuButton(CONNECT_ROW)!.click();
    await flushMicrotasks();

    expect(document.querySelector('#wallet-btn .wallet-address')!.textContent).toBe(SHORT_VALID);
    expect(control.walletModule.resolveState(control.dx)).toBe('connected');
    expect(control.port.liveIdentity()).not.toBeNull();
  });

  // CR-01: disconnectWallet's liveSuppressed must outrank a provider signal that arrives after
  // the click. A wallet unlock or account switch is routine, not a Connect gesture, and reArm
  // used to read port.liveIdentity() directly instead of resolveIdentity(dx), so it never saw
  // the suppression — the next mere dropdown open then fired wallet.connect() with no gesture.
  it('a provider accountsChanged after Disconnect does not silently reconnect on the next open (CR-01)', async () => {
    const ethereum = installFakeEthereum({ accounts: [VALID_ADDRESS] });
    const control = mountWalletOnly(
      makeWalletStub({
        disconnect: vi.fn(() => Promise.resolve()),
        connect: vi.fn(() => Promise.resolve({ connected: true, address: VALID_ADDRESS, chainId: 1, provider: {} })),
      }),
    );
    await flushMicrotasks();
    menuButton(DISCONNECT_ROW)!.click();

    const accountsChangedHandler = ethereum.on.mock.calls.find((c: any[]) => c[0] === 'accountsChanged')?.[1];
    accountsChangedHandler!([VALID_ADDRESS]);

    control.open();

    expect(control.wallet.connect.mock.calls.length).toBe(0);
    expect(document.querySelector('#wallet-btn .wallet-chip')).toBeNull();
  });

  it('the Disconnect row renders only in the connected state', () => {
    // Synchronous check, before the query answers: mounting starts disconnected regardless of
    // what this describe's beforeEach seeded, matching DEC-A's first-paint cost.
    mountWalletOnly(makeWalletStub());
    expect(menuButton(DISCONNECT_ROW)).toBeUndefined();

    delete (window as any).ethereum;
    mountWalletOnly(makeWalletStub());
    expect(menuButton(DISCONNECT_ROW)).toBeUndefined();
  });
});

describe('shell-wallet — copying the address from the dropdown (WAL-03, D-13)', () => {
  function copyControl() {
    return document.querySelector('.wallet-address-row .wallet-copy') as HTMLButtonElement | null;
  }

  function fullField() {
    return document.querySelector('#wallet-menu .wallet-address-full') as HTMLInputElement | null;
  }

  // "Displayed" rather than "present": the field lives in the DOM from the first paint so a
  // repaint never has to create it, and only the reveal class makes it visible.
  function fullFieldShown() {
    const field = fullField();
    return !!field && field.classList.contains('revealed');
  }

  beforeEach(() => {
    installFakeLocalStorage();
  });

  afterEach(() => {
    vi.useRealTimers();
    removeClipboard();
    window.localStorage.clear();
    delete (window as unknown as { ethereum?: unknown }).ethereum;
    delete (window as unknown as { __DXKIT__?: unknown }).__DXKIT__;
  });

  it('renders the shortened address and a copy control beside it in the connected dropdown', async () => {
    installFakeEthereum({ accounts: [VALID_ADDRESS] });
    mountWalletOnly(makeWalletStub());
    await flushMicrotasks();

    expect(document.querySelector('.wallet-address-row .wallet-address')!.textContent).toBe(SHORT_VALID);
    expect(copyControl()).not.toBeNull();
    expect(copyControl()!.type).toBe('button');
  });

  it('the copy control renders only in the connected state', () => {
    installFakeEthereum();
    mountWalletOnly(makeWalletStub());
    expect(copyControl()).toBeNull();

    delete (window as unknown as { ethereum?: unknown }).ethereum;
    mountWalletOnly(makeWalletStub());
    expect(copyControl()).toBeNull();
  });

  it('clicking copy writes the full 42-character address, never the shortened display form', async () => {
    installFakeEthereum({ accounts: [VALID_ADDRESS] });
    const writeText = installClipboard(vi.fn(() => Promise.resolve()));
    mountWalletOnly(makeWalletStub());
    await flushMicrotasks();

    copyControl()!.click();
    await flushMicrotasks();

    const payload = writeText.mock.calls[0][0];
    expect(payload).toBe(VALID_ADDRESS);
    expect(payload).toHaveLength(42);
    expect(payload).not.toBe(SHORT_VALID);
  });

  it('confirms strictly after the write resolves, and drops the confirmation 1500ms later', async () => {
    vi.useFakeTimers();
    installFakeEthereum({ accounts: [VALID_ADDRESS] });
    const deferred = Promise.withResolvers<void>();
    installClipboard(vi.fn(() => deferred.promise));
    mountWalletOnly(makeWalletStub());
    await flushMicrotasks();
    const button = copyControl()!;

    button.click();
    // The write is still pending: a confirmation here would be the incumbent share button's bug.
    expect(button.classList.contains('copied')).toBe(false);

    deferred.resolve();
    await flushMicrotasks();
    expect(button.classList.contains('copied')).toBe(true);

    vi.advanceTimersByTime(COPY_MS);
    expect(button.classList.contains('copied')).toBe(false);
  });

  it('a second copy inside the window restarts the confirmation instead of ending it early', async () => {
    // Two copies less than COPY_MS apart used to leave two untracked timers, and the FIRST one
    // then removed the confirmation the second had just applied — the second flash disappears
    // early, which is a defect the person sees.
    vi.useFakeTimers();
    installFakeEthereum({ accounts: [VALID_ADDRESS] });
    installClipboard(vi.fn(() => Promise.resolve()));
    mountWalletOnly(makeWalletStub());
    await flushMicrotasks();
    const button = copyControl()!;

    button.click();
    await flushMicrotasks();
    vi.advanceTimersByTime(COPY_MS - 500);
    button.click();
    await flushMicrotasks();
    expect(button.classList.contains('copied')).toBe(true);

    // Where the first copy's timer would have landed.
    vi.advanceTimersByTime(500);
    expect(button.classList.contains('copied')).toBe(true);

    // The second copy gets its own full window, and no more than that.
    vi.advanceTimersByTime(COPY_MS - 500);
    expect(button.classList.contains('copied')).toBe(false);
  });

  it('the cleanup closure releases the pending confirmation timer, like the watchdog handle', async () => {
    // Same argument the closure already makes for the watchdog: left armed, its callback writes
    // into a menu this closure has stopped owning.
    vi.useFakeTimers();
    installFakeEthereum({ accounts: [VALID_ADDRESS] });
    installClipboard(vi.fn(() => Promise.resolve()));
    const control = mountWalletOnly(makeWalletStub());
    await flushMicrotasks();
    copyControl()!.click();
    await flushMicrotasks();

    control.cleanup();

    expect(vi.getTimerCount()).toBe(0);
  });

  it('a rejected write confirms nothing, says so inline, and reveals the full address to select', async () => {
    installFakeEthereum({ accounts: [VALID_ADDRESS] });
    installClipboard(vi.fn(() => Promise.reject(new Error('NotAllowedError'))));
    mountWalletOnly(makeWalletStub());
    await flushMicrotasks();

    copyControl()!.click();
    await flushMicrotasks();

    expect(copyControl()!.classList.contains('copied')).toBe(false);
    expect(messageText()).not.toBe('');
    expect(fullFieldShown()).toBe(true);
    expect(fullField()!.readOnly).toBe(true);
    expect(fullField()!.value).toBe(VALID_ADDRESS);
    expect(fullField()!.value).toHaveLength(42);
  });

  it('an absent clipboard throws nothing, confirms nothing, and reveals the same selectable field', async () => {
    installFakeEthereum({ accounts: [VALID_ADDRESS] });
    removeClipboard();
    mountWalletOnly(makeWalletStub());
    await flushMicrotasks();

    expect(() => copyControl()!.click()).not.toThrow();

    expect(copyControl()!.classList.contains('copied')).toBe(false);
    expect(messageText()).not.toBe('');
    expect(fullFieldShown()).toBe(true);
    expect(fullField()!.readOnly).toBe(true);
    expect(fullField()!.value).toBe(VALID_ADDRESS);
  });

  it('reopening the dropdown clears the message and hides the full-address field again (D-16)', async () => {
    installFakeEthereum({ accounts: [VALID_ADDRESS] });
    installClipboard(vi.fn(() => Promise.reject(new Error('NotAllowedError'))));
    const control = mountWalletOnly(makeWalletStub());
    await flushMicrotasks();
    copyControl()!.click();
    await flushMicrotasks();
    expect(fullFieldShown()).toBe(true);

    control.open();

    expect(messageText()).toBe('');
    expect(fullFieldShown()).toBe(false);
  });

  it('reads the address at click time, so an account switch cannot copy the previous one (T-02-27)', async () => {
    installFakeEthereum({ accounts: [VALID_ADDRESS] });
    const writeText = installClipboard(vi.fn(() => Promise.resolve()));
    const control = mountWalletOnly(makeWalletStub());
    await flushMicrotasks();
    // The row was built against VALID_ADDRESS. A handler holding a captured string would copy
    // it while the current account is something else entirely — accepted directly through the
    // port, the way a direct accountsChanged event this module observed would arrive.
    control.port.acceptLiveIdentity(control.dx, MIXED_ADDRESS, 1);

    copyControl()!.click();
    await flushMicrotasks();

    expect(writeText.mock.calls[0][0]).toBe(MIXED_ADDRESS);
  });

  it("the trigger's title still carries all 42 characters while the visible text stays shortened", async () => {
    installFakeEthereum({ accounts: [VALID_ADDRESS] });
    mountWalletOnly(makeWalletStub());
    await flushMicrotasks();

    const trigger = document.getElementById('wallet-btn')!;
    expect(trigger.getAttribute('title')).toBe(VALID_ADDRESS);
    expect(trigger.getAttribute('title')).toHaveLength(42);
    expect(document.querySelector('#wallet-btn .wallet-address')!.textContent).toBe(SHORT_VALID);
  });
});

describe.skipIf(!hasVendoredWallet)(
  'vendored DxKit wallet plugin (skipped — src/vendor/ absent, no ../dxkit checkout to vendor from in this environment/CI)',
  () => {
    // The vendored file is a browser-global IIFE (`var DxWallet = ...`) meant to run as a real
    // <script> tag; `new Function` keeps that `var` local, so the factory is recovered via an
    // explicit trailing return rather than off a window property.
    function loadVendoredWallet() {
      const code = readFileSync(VENDORED_WALLET_PATH, 'utf-8');
      return new Function(`${code}\nreturn DxWallet;`)();
    }

    afterEach(() => {
      delete (window as any).ethereum;
    });

    it('exposes the two factories src/main.ts registers', () => {
      const DxWallet = loadVendoredWallet();

      expect(typeof DxWallet.createWallet).toBe('function');
      expect(typeof DxWallet.createEIP1193Provider).toBe('function');
    });

    it("the EIP-1193 adapter's own available() is what resolveState defers to", () => {
      const DxWallet = loadVendoredWallet();
      const provider = DxWallet.createEIP1193Provider();

      expect(provider.available()).toBe(false);
      installFakeEthereum();
      expect(provider.available()).toBe(true);
    });
  },
);

// shell.ts closes all three header dropdowns from a document-level click listener, and every piece
// of feedback this menu paints lands inside the menu. These cases boot the REAL shell.js alongside
// the wallet module, because a fixture without that listener cannot show the failure at all.
describe('shell-wallet — the menu stays open while its own rows report back', () => {
  beforeEach(() => {
    installFakeLocalStorage();
  });

  afterEach(() => {
    removeClipboard();
    window.localStorage.clear();
    delete (window as any).ethereum;
    delete (window as any).__DXKIT__;
  });

  function isOpen() {
    return document.getElementById('wallet-panel')!.classList.contains('open');
  }

  it('a copy click leaves the dropdown open, so the COPIED flash is visible where it is painted', async () => {
    installFakeEthereum({ accounts: [VALID_ADDRESS] });
    installClipboard(vi.fn(() => Promise.resolve()));
    bootHeader();
    await flushMicrotasks();
    document.getElementById('wallet-btn')!.click();
    expect(isOpen()).toBe(true);

    const copy = document.querySelector('.wallet-address-row .wallet-copy') as HTMLButtonElement;
    copy.click();
    await flushMicrotasks();

    expect(isOpen()).toBe(true);
    expect(copy.classList.contains('copied')).toBe(true);
  });

  it('a rejected connect leaves the dropdown open, so its own error sentence can be read', async () => {
    installFakeEthereum();
    const wallet = makeWalletStub({ connect: vi.fn(() => Promise.reject({ code: 4100 })) });
    bootHeader([SETTINGS_MANIFEST], wallet);
    await flushMicrotasks();
    document.getElementById('wallet-btn')!.click();

    menuButton(CONNECT_ROW)!.click();
    await flushMicrotasks();

    expect(isOpen()).toBe(true);
    expect(messageText().length).toBeGreaterThan(0);
  });

  it('the Settings row still closes the dropdown — it does that itself, on its way to the route', () => {
    installFakeEthereum();
    const { dx } = bootHeader();
    document.getElementById('wallet-btn')!.click();

    menuButton(/^settings/i)!.click();

    expect(isOpen()).toBe(false);
    expect(dx.router.navigate).toHaveBeenCalledWith('/settings');
  });
});
