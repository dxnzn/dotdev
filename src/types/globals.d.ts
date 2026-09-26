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

// DxWallet — vendored DxKit wallet plugin (loaded via vendor/dxkit/wallet/index.global.js;
// src/main.ts references the bare identifier). Typed STRUCTURALLY rather than by importing the
// vendored .d.ts: that file re-exports from '@dnzn/dxkit', which is not a dependency of this
// repo, so such an import would resolve to nothing (gap DX-06).
declare const DxWallet: {
  createWallet(options: { providers: unknown[]; storageKey?: string }): unknown;
  createEIP1193Provider(): unknown;
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

// Wallet identity port (loaded via wallet-identity.js <script> tag before shell-wallet.js).
// Observes the injected provider's own answer and holds it in memory only — it owns no node, so
// a query's answer or a direct provider event reaches the screen through the onChange the header
// adapter hands to init().
interface DnznWalletIdentityModule {
  init(dx: unknown, onChange: () => void): () => void;
  isAddress(value: unknown): boolean;
  liveIdentity(): { address: string; chainId: number | null } | null;
  acceptLiveIdentity(dx: unknown, address: unknown, chainId: unknown): boolean;
  clearIdentity(): void;
}

// Wallet header adapter (loaded via shell-wallet.js <script> tag after wallet-identity.js and
// before shell.js). The pure helpers ride beside init deliberately — they are the unit-test
// seam for a module whose init() needs a live shell.
interface DnznWalletModule {
  init(dx: unknown): () => void;
  resolveState(dx: unknown): 'no-provider' | 'disconnected' | 'connected';
  shortenAddress(addr: string): string;
  describeError(err: unknown): string | null;
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
  DnznWalletIdentity?: DnznWalletIdentityModule;
  DnznWallet?: DnznWalletModule;
}
