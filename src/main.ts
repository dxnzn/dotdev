// Namespace for every plugin storage key. Composed with a template literal, never
// written as three independent literals — Phase 2 adds `${STORAGE_NS}:wallet` from
// this same const, so it cannot silently land back on the shared default.
const STORAGE_NS = 'dnzn:dotdev';

const shell = DxKit.createShell({
  // Plugin registration completes before any plugin's own init() runs (DxKit registers
  // all plugins, then initialises them in this object's key order). `settings` must be
  // declared before `theme` so the theme plugin's own settings-sync finds dx.settings
  // already assigned by the time it seeds its values — with the reverse order the seed
  // is silently dropped and the Theme settings section can render stale defaults while
  // the page visibly wears a restored non-default theme. `ethereum` stays last; it is
  // schema-only and initialises nothing.
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
