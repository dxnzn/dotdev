const shell = DxKit.createShell({
  plugins: {
    theme: DxTheme.createCSSTheme({
      themes: ["zorgz-2625", "zorgz-156", "zorgz-4065"]
    }),
    settings: DxSettings.createSettings()
  },
  dapps: [
    { manifest: "dapps/about/manifest.json" },
    { manifest: "dapps/projects/manifest.json" },
    { manifest: "dapps/support/manifest.json" },
    { manifest: "dapps/tpl/manifest.json" },
    { manifest: "dapps/cic/manifest.json" }
  ],
  mode: "hash"
});
shell.init().then(() => {
  initShellChrome();
});
