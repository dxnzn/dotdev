import type { Plugin, Settings } from '@dnzn/dxkit';
declare module '@dnzn/dxkit' {
    interface EventMap {
        'dx:plugin:settings:changed': {
            dappId: string;
            key: string;
            value: unknown;
        };
    }
}
export interface SettingsPluginOptions {
    /** localStorage key prefix. Default: 'dxkit:settings'. */
    storageKey?: string;
}
/**
 * Creates a settings plugin that provides the Settings API on dx.settings.
 *
 * Stores values in memory with localStorage persistence. Reads defaults from
 * dapp manifests. Emits 'dx:plugin:settings:changed' on every write.
 */
export declare function createSettings(options?: SettingsPluginOptions): Plugin & {
    getSettingsAPI(): Settings;
};
export type { SettingDefinition, Settings, SettingsSection } from '@dnzn/dxkit';
