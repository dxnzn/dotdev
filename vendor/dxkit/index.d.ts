/** Defines a single configurable setting for a dapp. */
interface SettingDefinition {
    /** Unique key within the dapp, e.g. 'defaultCategory'. */
    key: string;
    /** Human-readable label. */
    label: string;
    /** Input type for form generation. */
    type: 'text' | 'number' | 'boolean' | 'select' | 'multiselect';
    /** Default value. */
    default: unknown;
    /** Help text shown below the input. */
    description?: string;
    /** Options for select/multiselect types. */
    options?: {
        label: string;
        value: string;
    }[];
    /** Validation constraints. */
    validation?: {
        required?: boolean;
        min?: number;
        max?: number;
        pattern?: string;
    };
    /** Key of a boolean setting in the same section that this field depends on. When the referenced setting is falsy, this field is disabled/grayed out. */
    dependsOn?: string;
}
/** A group of setting definitions with identity and display label. */
interface SettingsSection {
    /** Section identifier (dapp ID, plugin name, or reserved namespace like '_shell'). */
    id: string;
    /** Human-readable section heading. */
    label: string;
    /** Setting definitions in this section. */
    definitions: SettingDefinition[];
}
/** Settings API exposed on DxKit context. */
interface Settings {
    /** Get a setting value. Returns the default from the manifest if not explicitly set. */
    get<T = unknown>(dappId: string, key: string): T | undefined;
    /** Set a setting value. */
    set(dappId: string, key: string, value: unknown): void;
    /** Get all settings for a dapp as a key-value map. */
    getAll(dappId: string): Record<string, unknown>;
    /** Get all setting sections (dapps, plugins, shell-level). */
    getSections(): SettingsSection[];
    /** Subscribe to changes for a specific setting. Returns unsubscribe. */
    onChange(dappId: string, key: string, handler: (value: unknown) => void): () => void;
    /** Subscribe to any setting change for a dapp. Returns unsubscribe. */
    onAnyChange(dappId: string, handler: (key: string, value: unknown) => void): () => void;
}

/** Declares a dapp's identity, routing, and navigation metadata. */
interface DappManifest {
    /** Unique slug, e.g. 'token-sender'. */
    id: string;
    /** Human-readable display name. */
    name: string;
    /** Short description of what this dapp does. */
    description?: string;
    /** Semver version string. */
    version: string;
    /** Path prefix this dapp owns, e.g. '/tools/token-sender'. */
    route: string;
    /** Compiled JS entry point, relative to dapp root. */
    entry: string;
    /** HTML template path, relative to dapp root. Injected into container before scripts load. */
    template?: string;
    /** Additional scripts loaded before the entry point (e.g. domain logic modules). */
    dependencies?: string[];
    /** CSS stylesheet path, relative to dapp root. Lazy-loaded on first mount. */
    styles?: string;
    nav: {
        /** Menu text. */
        label: string;
        /** Icon identifier (SVG name, URL, or inline SVG). */
        icon?: string;
        /** Nav grouping, e.g. 'tools', 'defi', 'admin'. */
        group?: string;
        /** Sort order within group. */
        order?: number;
        /** Registered but not shown in nav. */
        hidden?: boolean;
    };
    /** Declare what this dapp needs from the shell. */
    requires?: {
        /** Plugin names that must be registered before mount, e.g. ['wallet', 'auth']. */
        plugins?: string[];
    };
    /** Configurable settings declared by this dapp. */
    settings?: SettingDefinition[];
    /** Whether the end-user can toggle this dapp on or off (default: false = always on). */
    optional?: boolean;
    /** Initial enabled state (default: true). Only meaningful when `optional` is true. */
    enabled?: boolean;
    /** Whether this dapp can run outside the shell (default: true). */
    standalone?: boolean;
}

/**
 * Built-in shell event names mapped to their payload types.
 *
 * Plugin events use the `dx:plugin:<name>:<action>` convention and are
 * registered at runtime via `EventRegistry.registerEvent()`. Developer/dapp
 * events use any name that does not start with `dx:`.
 */
interface EventMap {
    'dx:ready': Record<string, never>;
    'dx:route:changed': {
        path: string;
        manifest?: DappManifest;
    };
    'dx:dapp:mounted': {
        id: string;
    };
    'dx:dapp:unmounted': {
        id: string;
    };
    'dx:dapp:enabled': {
        id: string;
    };
    'dx:dapp:disabled': {
        id: string;
    };
    'dx:mount': {
        id: string;
        container: HTMLElement;
        path: string;
    };
    'dx:unmount': {
        id: string;
    };
    'dx:route:subpath': {
        id: string;
        path: string;
        previousPath: string;
    };
    'dx:error': {
        source: string;
        error: Error;
    };
    'dx:plugin:registered': {
        name: string;
    };
    'dx:event:registered': {
        source: string;
        events: string[];
    };
    /** Index signature — allows custom events registered at runtime. */
    [event: string]: unknown;
}
/** Input descriptor for `EventRegistry.registerEvent()`. */
interface EventRegistration {
    /** Event name, e.g. `'dx:plugin:wallet:connected'` or `'myapp:loaded'`. */
    name: string;
    /** Optional human-readable description for introspection. */
    description?: string;
}
/** Describes a registered custom event (returned by `getRegisteredEvents()`). */
interface RegisteredEvent {
    /** Full event name. */
    name: string;
    /** Which plugin or dapp registered this event. */
    source: string;
    /** Optional description. */
    description?: string;
}
/** Handle returned by EventBus.on() for managing a listener. */
interface Listener {
    /** Remove the listener permanently. */
    off(): void;
    /** Whether the listener is currently paused. */
    readonly paused: boolean;
    /** Temporarily stop delivering events to this listener. */
    pause(): void;
    /** Resume delivering events after a pause. */
    resume(): void;
}
/** Typed event bus for DxKit communication. */
interface EventBus {
    emit<K extends keyof EventMap>(event: K, detail: EventMap[K]): void;
    on<K extends keyof EventMap>(event: K, handler: (detail: EventMap[K]) => void): Listener;
    once<K extends keyof EventMap>(event: K, handler: (detail: EventMap[K]) => void): void;
    off<K extends keyof EventMap>(event: K, handler: (detail: EventMap[K]) => void): void;
}
/** Registry for runtime event registration and introspection. */
interface EventRegistry {
    /**
     * Register one or more custom events.
     *
     * - Plugins: event names MUST match `dx:plugin:<source>:<action>`.
     * - Dapps/devs: event names MUST NOT start with `dx:`.
     * - Duplicate from same source is a no-op.
     * - Different source for same event name throws.
     * - Built-in shell events cannot be registered.
     */
    registerEvent(source: string, events: EventRegistration[]): void;
    /** Get all registered custom events (excludes static shell events). */
    getRegisteredEvents(): RegisteredEvent[];
    /** Check whether an event name has been registered. */
    isRegistered(event: string): boolean;
}

/** Base interface that all DxKit plugins implement. */
interface Plugin {
    /** Unique name identifying this plugin in the registry. */
    readonly name: string;
    /** Called once during shell init with the DxKit context. */
    init?(context: Context): Promise<void>;
    /** Called on shell teardown for cleanup. */
    destroy?(): Promise<void>;
    /** Optional settings definitions — exposed via the settings plugin. */
    settings?: SettingDefinition[];
}
interface WalletState {
    connected: boolean;
    address: string | null;
    chainId: number | null;
    /** Raw provider reference — intentionally loose, plugin decides the type. */
    provider: unknown;
}
interface Wallet extends Plugin {
    /** Connect a wallet. Optionally specify a provider by ID. */
    connect(providerId?: string): Promise<WalletState>;
    disconnect(): Promise<void>;
    getState(): WalletState;
    sign(message: string): Promise<string>;
    onStateChange(handler: (state: WalletState) => void): () => void;
    /** Get all registered wallet providers. */
    getProviders(): WalletProvider[];
    /** Get the currently active provider (null if disconnected). */
    getActiveProvider(): WalletProvider | null;
}
/** Pluggable wallet backend. Implementations: EIP-1193, local dev, WalletConnect, etc. */
interface WalletProvider {
    /** Unique provider ID, e.g. 'eip1193', 'local', 'walletconnect'. */
    readonly id: string;
    /** Human-readable name, e.g. 'Browser Wallet', 'Local (Dev)'. */
    readonly name: string;
    /** Whether this provider can work in the current environment. */
    available(): boolean;
    /** Connect and return the resulting wallet state. */
    connect(): Promise<WalletState>;
    /** Disconnect and clear state. */
    disconnect(): Promise<void>;
    /** Sign a message with the connected account. */
    sign(message: string): Promise<string>;
    /** Subscribe to state changes. Returns unsubscribe function. */
    onStateChange(handler: (state: WalletState) => void): () => void;
}
interface AuthState {
    authenticated: boolean;
    address: string | null;
    /** SIWE token, JWT, or null. */
    token: string | null;
    /** Unix timestamp, or null if no expiry. */
    expiresAt: number | null;
}
interface Auth extends Plugin {
    authenticate(): Promise<AuthState>;
    deauthenticate(): Promise<void>;
    getState(): AuthState;
    isAuthenticated(): boolean;
    onStateChange(handler: (state: AuthState) => void): () => void;
}
type ThemeMode = 'light' | 'dark' | 'system';
interface Theme extends Plugin {
    /** Current mode setting (may be 'system'). */
    getMode(): ThemeMode;
    /** Set mode to light, dark, or system. */
    setMode(mode: ThemeMode): void;
    /** Cycle: system → light → dark → system. */
    toggleMode(): void;
    /** The resolved mode actually applied to the DOM ('light' or 'dark'). */
    getResolvedMode(): 'light' | 'dark';
    onModeChange(handler: (mode: ThemeMode, resolved: 'light' | 'dark') => void): () => void;
    /** Current theme name (e.g. 'default', 'cyberpunk'). */
    getTheme(): string;
    setTheme(theme: string): void;
    getAvailableThemes(): string[];
    onThemeChange(handler: (theme: string) => void): () => void;
}

/** The public surface area dapps interact with via window.__DXKIT__. */
interface Context {
    /** DxKit event bus for typed pub/sub. */
    events: EventBus;
    /** Event registration for plugins and dapps. */
    eventRegistry: EventRegistry;
    /** Router — navigate and read current path. */
    router: {
        navigate: (path: string) => void;
        getCurrentPath: () => string;
    };
    /** Retrieve a registered plugin by name. */
    getPlugin: <T extends Plugin>(name: string) => T | undefined;
    /** Get all registered plugins as a name→plugin map. */
    getPlugins: () => Record<string, Plugin>;
    /** Get all loaded dapp manifests. */
    getManifests: () => DappManifest[];
    /** Get only enabled dapp manifests (respects optional/enabled state). */
    getEnabledManifests: () => DappManifest[];
    /** Enable an optional dapp by ID. No-op if already enabled or not optional. */
    enableDapp: (id: string) => void;
    /** Disable an optional dapp by ID. No-op if already disabled or not optional. */
    disableDapp: (id: string) => void;
    /** Check whether a dapp is currently enabled. Non-optional dapps always return true. */
    isDappEnabled: (id: string) => boolean;
    /** Injected at runtime by settings plugin if registered. */
    settings?: Settings;
}
declare global {
    interface Window {
        __DXKIT__?: Context;
    }
}

/** A dapp entry in the shell config — path to manifest.json plus optional overrides. */
interface DappEntry {
    /** Path to the dapp's manifest.json (fetched at init). */
    manifest: string;
    /** Partial overrides deep-merged on top of the fetched manifest. */
    overrides?: Partial<DappManifest>;
}
/** Configuration passed to createShell(). */
interface ShellConfig {
    /** Named plugin instances. */
    plugins?: Record<string, Plugin>;
    /** Dapp entries — each points to a manifest.json with optional overrides. */
    dapps?: DappEntry[];
    /** Inline manifests (fully specified, no fetch). Takes precedence over registry.json. */
    manifests?: DappManifest[];
    /** URL to fetch registry.json from. Default: '/registry.json'. */
    registryUrl?: string;
    /** Base path for routing. Default: '/'. */
    basePath?: string;
    /** Routing mode. Default: 'history'. */
    mode?: 'history' | 'hash';
    /** Override the script loader (useful for testing). */
    scriptLoader?: (src: string) => Promise<void>;
    /** Override the style loader (useful for testing). */
    styleLoader?: (href: string) => Promise<void>;
    /** Override the template loader (useful for testing). */
    templateLoader?: (src: string) => Promise<string>;
}
/** The shell instance returned by createShell(). */
interface Shell {
    /** Initialize plugins, load manifests, resolve initial route. */
    init(): Promise<void>;
    /** Retrieve a registered plugin by name. */
    getPlugin<T extends Plugin>(name: string): T | undefined;
    /** Get all loaded dapp manifests. */
    getManifests(): DappManifest[];
    /** Get only enabled dapp manifests. */
    getEnabledManifests(): DappManifest[];
    /** Enable an optional dapp by ID. */
    enableDapp(id: string): void;
    /** Disable an optional dapp by ID. */
    disableDapp(id: string): void;
    /** Check whether a dapp is currently enabled. */
    isDappEnabled(id: string): boolean;
    /** Navigate to a path. */
    navigate(path: string): void;
    /** Get the current resolved route path. */
    getCurrentRoute(): string;
    /** Tear down the shell — destroy plugins, remove listeners. */
    destroy(): void;
}

/**
 * Creates a typed event bus backed by window.CustomEvent.
 *
 * All events are dispatched on the provided target (defaults to window)
 * using the `dx:*` namespace. Handlers receive the typed `detail` payload.
 */
declare function createEventBus(target?: EventTarget): EventBus;
/**
 * Creates an event registry for runtime event registration and introspection.
 *
 * Namespace rules:
 * - `dx:plugin:<name>:<action>` — plugin events, name must match source
 * - No `dx:` prefix — dapp/developer events, any source
 * - `dx:*` without `dx:plugin:` prefix — reserved, rejected
 */
declare function createEventRegistry(bus: EventBus): EventRegistry;

interface LifecycleManager {
    mount(manifest: DappManifest, container: HTMLElement, path?: string): Promise<void>;
    unmount(): void;
    getCurrentDapp(): string | null;
    destroy(): void;
}
type ScriptLoader = (src: string) => Promise<void>;
type StyleLoader = (href: string) => Promise<void>;
type TemplateLoader = (src: string) => Promise<string>;
interface LifecycleManagerOptions {
    /** Override the script loader (useful for testing). */
    scriptLoader?: ScriptLoader;
    /** Override the style loader (useful for testing). */
    styleLoader?: StyleLoader;
    /** Override the template loader (useful for testing). */
    templateLoader?: TemplateLoader;
    /** Check if a named plugin is registered. Used for permission enforcement. */
    hasPlugin?: (name: string) => boolean;
}
declare function createLifecycleManager(events: EventBus, options?: LifecycleManagerOptions): LifecycleManager;

interface PluginRegistry {
    register(name: string, plugin: Plugin): void;
    get<T extends Plugin>(name: string): T | undefined;
    has(name: string): boolean;
    getAll(): Record<string, Plugin>;
}
declare function createPluginRegistry(): PluginRegistry;

interface Router {
    resolve(path: string): DappManifest | null;
    navigate(path: string): void;
    getCurrentPath(): string;
    onRouteChange(handler: (manifest: DappManifest | null) => void): () => void;
    destroy(): void;
}
interface RouterConfig {
    mode: 'history' | 'hash';
    basePath: string;
    manifests: DappManifest[];
}
declare function createRouter(config: RouterConfig): Router;

/**
 * Creates a shell instance for composable dapp development.
 *
 * The shell manages routing, plugin lifecycle, event bus, and dapp
 * mount/unmount orchestration. It owns zero DOM — the developer provides
 * the layout and mount container.
 */
declare function createShell(config?: ShellConfig): Shell;

export { type Auth, type AuthState, type Context, type DappEntry, type DappManifest, type EventBus, type EventMap, type EventRegistration, type EventRegistry, type LifecycleManagerOptions, type Listener, type Plugin, type RegisteredEvent, type ScriptLoader, type SettingDefinition, type Settings, type SettingsSection, type Shell, type ShellConfig, type StyleLoader, type TemplateLoader, type Theme, type ThemeMode, type Wallet, type WalletProvider, type WalletState, createEventBus, createEventRegistry, createLifecycleManager, createPluginRegistry, createRouter, createShell };
