const STORAGE_NS = "dnzn:dotdev";
try {
  localStorage.removeItem(`${STORAGE_NS}:wallet`);
} catch {
}
try {
  localStorage.removeItem(`${STORAGE_NS}:wallet:identity`);
} catch {
}
function canonicalizeHashQuery() {
  const hash = window.location.hash;
  const path = hash.slice(1);
  const qIdx = path.indexOf("?");
  if (qIdx <= 0) return;
  if (path[qIdx - 1] === "/") return;
  window.history.replaceState(null, "", `#${path.slice(0, qIdx)}/${path.slice(qIdx)}`);
}
canonicalizeHashQuery();
window.addEventListener("popstate", canonicalizeHashQuery);
window.addEventListener("hashchange", canonicalizeHashQuery);
let releaseDecodeShareTarget = null;
window.addEventListener("dx:mount", (rawEvent) => {
  const e = rawEvent;
  if (e.detail.id !== "decode") return;
  releaseDecodeShareTarget = window.DnznShareTarget?.register(() => window.DxDecode?.activeUi?.pressPlainShare() ?? null, {
    onCopyFailed: (url) => window.DxDecode?.activeUi?.revealShareFailure(url)
  }) ?? null;
});
window.addEventListener("dx:unmount", (rawEvent) => {
  const e = rawEvent;
  if (e.detail.id !== "decode") return;
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
      themes: ["zorgz-2625", "zorgz-156", "zorgz-4065"],
      onApply: ({ theme, resolved }) => updateThemeExtras(theme, resolved),
      storageKey: `${STORAGE_NS}:theme`
    }),
    // Schema-only — owns no storage of its own. Its values live inside the settings
    // plugin's blob, under the `ethereum` section this object key creates.
    ethereum: DnznEthereum.createEthereumPlugin(),
    // Schema-only, same shape as `ethereum` above — its own section (not folded into
    // `ethereum`'s) because 'autoRunSharedLinks' governs decode's auto-run behavior for every
    // decoder, not just Ethereum ones (G-06-6/06-10, DEC-05 amendment).
    links: DnznLinks.createLinksPlugin(),
    // The only plugin here doing real async work in init(), hence last: DxKit awaits each
    // init() serially, so a slow one delays everything behind it. Only the EIP-1193 provider
    // is registered (D-02) — the upstream dev provider reports itself available
    // unconditionally with a fake address, which would make the no-provider state
    // unreachable and untestable.
    wallet: DxWallet.createWallet({
      providers: [DxWallet.createEIP1193Provider()],
      storageKey: `${STORAGE_NS}:wallet`
    })
  },
  dapps: [
    { manifest: "dapps/about/manifest.json" },
    { manifest: "dapps/projects/manifest.json" },
    { manifest: "dapps/support/manifest.json" },
    { manifest: "dapps/tpl/manifest.json" },
    { manifest: "dapps/cic/manifest.json" },
    { manifest: "dapps/decode/manifest.json" },
    { manifest: "dapps/settings/manifest.json" }
  ],
  mode: "hash"
});
shell.init().then(() => {
  initShellChrome();
});
