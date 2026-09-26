// Namespace for every plugin storage key. Composed with a template literal, never
// written as three independent literals — Phase 2 adds `${STORAGE_NS}:wallet` from
// this same const, so it cannot silently land back on the shared default.
const STORAGE_NS = 'dnzn:dotdev';

// Clearing the plugin's persisted provider id is load-bearing, not tidying — the plugin's
// restore path reaches a live account-request RPC inside shell.init()'s serial
// `await plugin.init()` loop (dxkit/src/shell.ts:412-423), and a locked wallet leaves that
// promise pending forever, which would leave the whole shell unrendered on every route.
// Constructing the wallet outside createShell() instead would cost its settings section (D-04),
// and dotdev does not control the await inside DxKit's loop, so no timeout is reachable from
// here. See tmp/dxkit-fr-wallet-identity-cache.md.
try {
  localStorage.removeItem(`${STORAGE_NS}:wallet`);
} catch {
  /* storage unavailable — nothing to clear */
}

// A one-way migration, not a cache mechanism: it reads nothing, it is conditional on nothing,
// and it exists solely to delete what earlier builds of this site wrote. D-05 through D-11
// (the identity store, its gate and its cross-tab opt-out) are superseded — 02-09 re-founded
// src/wallet-identity.ts as a live-only port that persists nothing, so nothing in this codebase
// writes this key any more. Every returning visitor who ever connected before this plan still
// has a real Ethereum address sitting in their browser; this removal is the one-time cleanup so
// it does not stay there forever. Do not delete this as dead code — the key it names is real,
// even though nothing writes it going forward.
try {
  localStorage.removeItem(`${STORAGE_NS}:wallet:identity`);
} catch {
  /* storage unavailable — nothing to clear */
}

const shell = DxKit.createShell({
  // Plugin registration completes before any plugin's own init() runs (DxKit registers
  // all plugins, then initialises them in this object's key order). `settings` must be
  // declared before `theme` so the theme plugin's own settings-sync finds dx.settings
  // already assigned by the time it seeds its values — with the reverse order the seed
  // is silently dropped and the Theme settings section can render stale defaults while
  // the page visibly wears a restored non-default theme. Declaration order reaches
  // `settings, theme, ethereum, wallet` — schema-only plugins grouped first, the
  // one plugin that does async work in init() last.
  plugins: {
    settings: DxSettings.createSettings({ storageKey: `${STORAGE_NS}:settings` }),
    theme: DxTheme.createCSSTheme({
      themes: ['zorgz-2625', 'zorgz-156', 'zorgz-4065'],
      onApply: ({ theme, resolved }) => updateThemeExtras(theme, resolved),
      storageKey: `${STORAGE_NS}:theme`,
    }),
    // Schema-only — owns no storage of its own. Its values live inside the settings
    // plugin's blob, under the `ethereum` section this object key creates.
    ethereum: DnznEthereum.createEthereumPlugin(),
    // The only plugin here doing real async work in init(), hence last: DxKit awaits each
    // init() serially, so a slow one delays everything behind it. Only the EIP-1193 provider
    // is registered (D-02) — the upstream dev provider reports itself available
    // unconditionally with a fake address, which would make the no-provider state
    // unreachable and untestable.
    wallet: DxWallet.createWallet({
      providers: [DxWallet.createEIP1193Provider()],
      storageKey: `${STORAGE_NS}:wallet`,
    }),
  },
  dapps: [
    { manifest: 'dapps/about/manifest.json' },
    { manifest: 'dapps/projects/manifest.json' },
    { manifest: 'dapps/support/manifest.json' },
    { manifest: 'dapps/tpl/manifest.json' },
    { manifest: 'dapps/cic/manifest.json' },
    { manifest: 'dapps/settings/manifest.json' },
  ],
  mode: 'hash',
});

shell.init().then(() => {
  initShellChrome();
});
