// Type declarations for DxKit IIFE globals loaded via <script> tags.
// These reference the vendored .d.ts files for type information.

// DxKit core — exposes createShell and all types
declare const DxKit: {
  createShell(config?: import('../vendor/dxkit/index').ShellConfig): import('../vendor/dxkit/index').Shell;
  createEventBus(target?: EventTarget): import('../vendor/dxkit/index').EventBus;
  createEventRegistry(bus: import('../vendor/dxkit/index').EventBus): import('../vendor/dxkit/index').EventRegistry;
  createPluginRegistry(): import('../vendor/dxkit/index').PluginRegistry;
  createRouter(config: import('../vendor/dxkit/index').RouterConfig): import('../vendor/dxkit/index').Router;
};

// DxTheme — exposes createCSSTheme
declare const DxTheme: {
  createCSSTheme(
    options?: import('../vendor/dxkit/theme/index').CSSThemeOptions,
  ): import('../vendor/dxkit/index').Theme;
};

// DxSettings — exposes createSettings
declare const DxSettings: {
  createSettings(
    options?: import('../vendor/dxkit/settings/index').SettingsPluginOptions,
  ): import('../vendor/dxkit/index').Plugin & {
    getSettingsAPI(): import('../vendor/dxkit/index').Settings;
  };
};

// Shell chrome init function (loaded via shell.js <script> tag before main.js)
declare function initShellChrome(): void;

// CIC module (loaded dynamically by cic dapp.js)
interface CICModule {
  init(container: HTMLElement, isReport: boolean): () => void;
}
declare interface Window {
  CIC?: CICModule;
}
