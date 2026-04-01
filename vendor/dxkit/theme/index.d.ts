import { ThemeMode, Theme } from '@dnzn/dxkit';

declare module '@dnzn/dxkit' {
    interface EventMap {
        'dx:plugin:theme:changed': {
            theme: string;
            mode: ThemeMode;
            resolved: 'light' | 'dark';
        };
    }
}
interface CSSThemeOptions {
    /** Available theme names. First is the default. */
    themes?: string[];
    /** Initial mode. Default: 'system'. */
    defaultMode?: ThemeMode;
    /** localStorage key prefix. Default: 'dxkit:theme'. */
    storageKey?: string;
    /** Called after DOM attributes are set — use for side-effects like favicon/meta-color updates. */
    onApply?: (state: {
        theme: string;
        mode: ThemeMode;
        resolved: 'light' | 'dark';
    }) => void;
}
/**
 * Creates a CSS theme plugin.
 *
 * Sets `data-theme` and `data-mode` attributes on `<html>`.
 * Persists selection to localStorage. Respects `prefers-color-scheme`
 * when mode is 'system'.
 *
 * Declares settings so the settings plugin can render theme/mode controls.
 */
declare function createCSSTheme(options?: CSSThemeOptions): Theme;

export { type CSSThemeOptions, createCSSTheme };
