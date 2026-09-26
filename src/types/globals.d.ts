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

// DnznEthereum — dotdev-local schema-only plugin (loaded via plugins/ethereum.js
// <script> tag before shell.js/main.js; src/main.ts references the bare identifier).
declare const DnznEthereum: {
  createEthereumPlugin(): import('../vendor/dxkit/index').Plugin;
  CHAINS: { chainId: number; name: string; explorer: string }[];
};

// Settings dapp domain modules (loaded dynamically via manifest dependencies)
interface DnznSettingsFieldsModule {
  renderField(
    def: import('../vendor/dxkit/index').SettingDefinition,
    value: unknown,
    ctx: { sectionId: string; commit: (value: unknown) => void; markDirty: () => void },
  ): {
    element: HTMLElement;
    sectionId: string;
    key: string;
    def: import('../vendor/dxkit/index').SettingDefinition;
    setValue(value: unknown): void;
    setDisabled(flag: boolean): void;
    getSemanticValue(): unknown;
    isDirty(): boolean;
    destroy(): void;
  };
  coerceForCommit(def: import('../vendor/dxkit/index').SettingDefinition, rawValue: unknown): unknown;
  validate(def: import('../vendor/dxkit/index').SettingDefinition, value: unknown): { ok: boolean };
  isSecret(sectionId: string, key: string): boolean;
  resetRevealState(): void;
}

interface DnznSettingsSyncRecord {
  sectionId: string;
  key: string;
  value: unknown;
  repaint: boolean;
}

interface DnznSettingsSyncOpts {
  isDirty(sectionId: string, key: string): boolean;
  repaintField(sectionId: string, key: string, value: unknown): void;
  getSemanticValue(sectionId: string, key: string): unknown;
}

interface DnznSettingsSyncModule {
  diffAndReplay(
    readCurrent: (sectionId: string, key: string) => unknown,
    incoming: unknown,
    isDirty: (sectionId: string, key: string) => boolean,
  ): DnznSettingsSyncRecord[];
  attachExternalSync(dx: unknown, opts: DnznSettingsSyncOpts): () => void;
}

interface DnznSettingsDappModule {
  init(container: HTMLElement): () => void;
  orderSections(
    sections: import('../vendor/dxkit/index').SettingsSection[],
  ): import('../vendor/dxkit/index').SettingsSection[];
  getField(sectionId: string, key: string): ReturnType<DnznSettingsFieldsModule['renderField']> | undefined;
  isDirty(sectionId: string, key: string): boolean;
  repaintField(sectionId: string, key: string, value: unknown): void;
  getSemanticValue(sectionId: string, key: string): unknown;
}

// Shell functions (loaded via shell.js <script> tag before main.js)
declare function initShellChrome(): void;
declare function updateThemeExtras(theme: string, resolved: 'light' | 'dark'): void;

// CIC module (loaded dynamically by cic dapp.js)
interface CICModule {
  init(container: HTMLElement, isReport: boolean): () => void;
}
declare interface Window {
  CIC?: CICModule;
  DnznEthereum?: typeof DnznEthereum;
  DnznSettingsFields?: DnznSettingsFieldsModule;
  DnznSettingsSync?: DnznSettingsSyncModule;
  DnznSettingsDapp?: DnznSettingsDappModule;
}
