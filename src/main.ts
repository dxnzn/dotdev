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

// Framework routing gap (tmp/dxkit-bug-router-hash-query.md): the vendored router strips a
// base path and a trailing slash from a hash route's path but never a query string, so
// '#/tools/decode?decoder=hex&data=…' — the exact form DEC-03 and this dapp's own README name —
// resolves to nothing; only '#/tools/decode/?…' (the query separated by a slash) is routable.
// This rewrite inserts that slash before the router ever reads the path: once here,
// synchronously, before the shell (and its router) is constructed, and once more on every
// subsequent hashchange, registered before createShell so it runs ahead of the router's own
// hashchange listener (listeners fire in registration order). A history REPLACEMENT, never a
// push and never a `location.hash =` assignment — the former does not fire hashchange (no loop,
// no double-handling), the latter would. Route-agnostic and deliberately NOT inside
// src/dapps/decode/: this is a fix for any hash route carrying a query, and DEC-14 forbids a
// portable dapp from carrying a workaround for one host's framework version — CIC only escapes
// the gap because it happens to emit the slash itself (src/dapps/cic/cic.ts:422).
function canonicalizeHashQuery(): void {
  const hash = window.location.hash;
  const path = hash.slice(1);
  const qIdx = path.indexOf('?');
  // No query string at all (this also covers the bare root hash, which has no '?' either), or a
  // '?' with no route segment before it to canonicalize — both left untouched rather than
  // rewritten.
  if (qIdx <= 0) return;
  // Already canonical — idempotent, so the hashchange listener below cannot loop or double a
  // slash it already inserted.
  if (path[qIdx - 1] === '/') return;
  window.history.replaceState(null, '', `#${path.slice(0, qIdx)}/${path.slice(qIdx)}`);
}

canonicalizeHashQuery();
window.addEventListener('hashchange', canonicalizeHashQuery);

// SHARE-04: routes the header share button through decode's plain-link press while decode is
// mounted. Deliberately NOT inside src/dapps/decode/ — DEC-14's portability guard
// (test/decode-portability.test.ts) forbids any `Dnzn*`-prefixed identifier in that directory,
// so decode itself can never name window.DnznShareTarget. This listens for the SAME dx:mount/
// dx:unmount window events dapp.ts already does, and reaches decode's own generic
// pressPlainShare/revealShareFailure hooks (types.d.ts's DxDecodeUiHandle) via
// window.DxDecode.activeUi — the single-live-instance seam dapp.ts sets, mirroring `log`'s own
// shape. The builder is only INVOKED at press time, well after both listeners have run for this
// mount, so it does not matter which of the two registers first.
type DxDappLifecycleEvent = CustomEvent<{ id: string }>;

let releaseDecodeShareTarget: (() => void) | null = null;

window.addEventListener('dx:mount', (rawEvent) => {
  const e = rawEvent as DxDappLifecycleEvent;
  if (e.detail.id !== 'decode') return;
  releaseDecodeShareTarget =
    window.DnznShareTarget?.register(() => window.DxDecode?.activeUi?.pressPlainShare() ?? null, {
      onCopyFailed: (url) => window.DxDecode?.activeUi?.revealShareFailure(url),
    }) ?? null;
});

window.addEventListener('dx:unmount', (rawEvent) => {
  const e = rawEvent as DxDappLifecycleEvent;
  if (e.detail.id !== 'decode') return;
  releaseDecodeShareTarget?.();
  releaseDecodeShareTarget = null;
});

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
    { manifest: 'dapps/decode/manifest.json' },
    { manifest: 'dapps/settings/manifest.json' },
  ],
  mode: 'hash',
});

shell.init().then(() => {
  initShellChrome();
});
