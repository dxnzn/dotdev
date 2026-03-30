"use strict";
var DxKit = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // src/index.ts
  var index_exports = {};
  __export(index_exports, {
    createEventBus: () => createEventBus,
    createEventRegistry: () => createEventRegistry,
    createLifecycleManager: () => createLifecycleManager,
    createPluginRegistry: () => createPluginRegistry,
    createRouter: () => createRouter,
    createShell: () => createShell
  });

  // src/events.ts
  var SHELL_EVENTS = /* @__PURE__ */ new Set([
    "dx:ready",
    "dx:route:changed",
    "dx:dapp:mounted",
    "dx:dapp:unmounted",
    "dx:dapp:enabled",
    "dx:dapp:disabled",
    "dx:mount",
    "dx:unmount",
    "dx:error",
    "dx:plugin:registered",
    "dx:event:registered"
  ]);
  function createEventBus(target = window) {
    const handlers = {};
    function emit(event, detail) {
      target.dispatchEvent(new CustomEvent(event, { detail }));
    }
    function on(event, handler) {
      let paused = false;
      const wrapper = (e) => {
        if (!paused) handler(e.detail);
      };
      const key = event;
      if (!handlers[key]) {
        handlers[key] = /* @__PURE__ */ new Map();
      }
      handlers[key].set(handler, wrapper);
      target.addEventListener(key, wrapper);
      return {
        off: () => off(event, handler),
        get paused() {
          return paused;
        },
        pause() {
          paused = true;
        },
        resume() {
          paused = false;
        }
      };
    }
    function once(event, handler) {
      const listener = on(event, (detail) => {
        listener.off();
        handler(detail);
      });
    }
    function off(event, handler) {
      const map = handlers[event];
      if (!map) return;
      const wrapper = map.get(handler);
      if (wrapper) {
        target.removeEventListener(event, wrapper);
        map.delete(handler);
      }
    }
    return { emit, on, once, off };
  }
  function createEventRegistry(bus) {
    const registered = /* @__PURE__ */ new Map();
    function registerEvent(source, events) {
      if (!events.length) return;
      const newlyRegistered = [];
      for (const { name, description } of events) {
        if (SHELL_EVENTS.has(name)) {
          throw new Error(`Cannot register built-in shell event: '${name}'`);
        }
        if (name.startsWith("dx:plugin:")) {
          const segments = name.split(":");
          if (segments.length !== 4 || !segments[3]) {
            throw new Error(`Invalid plugin event format: '${name}' \u2014 expected 'dx:plugin:<name>:<action>'`);
          }
          if (segments[2] !== source) {
            throw new Error(`Plugin '${source}' cannot register event '${name}' \u2014 namespace mismatch`);
          }
        } else if (name.startsWith("dx:")) {
          throw new Error(`Event '${name}' uses reserved dx: prefix \u2014 plugins must use 'dx:plugin:${source}:<action>'`);
        }
        const existing = registered.get(name);
        if (existing) {
          if (existing.source === source) continue;
          throw new Error(`Event '${name}' already registered by '${existing.source}'`);
        }
        registered.set(name, { name, source, description });
        newlyRegistered.push(name);
      }
      if (newlyRegistered.length) {
        bus.emit("dx:event:registered", { source, events: newlyRegistered });
      }
    }
    function getRegisteredEvents() {
      return Array.from(registered.values());
    }
    function isRegistered(event) {
      return registered.has(event);
    }
    return { registerEvent, getRegisteredEvents, isRegistered };
  }

  // src/lifecycle.ts
  function defaultScriptLoader() {
    const loaded = /* @__PURE__ */ new Set();
    return (src) => {
      if (loaded.has(src)) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.type = "module";
        script.src = src;
        script.onload = () => {
          loaded.add(src);
          resolve();
        };
        script.onerror = () => {
          reject(new Error(`Failed to load dapp script: ${src}`));
        };
        document.head.appendChild(script);
      });
    };
  }
  function defaultStyleLoader() {
    const loaded = /* @__PURE__ */ new Set();
    return (href) => {
      if (loaded.has(href)) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const link = document.createElement("link");
        link.rel = "stylesheet";
        link.href = href;
        link.onload = () => {
          loaded.add(href);
          resolve();
        };
        link.onerror = () => {
          reject(new Error(`Failed to load dapp styles: ${href}`));
        };
        document.head.appendChild(link);
      });
    };
  }
  function createLifecycleManager(events, options = {}) {
    const loadScript = options.scriptLoader ?? defaultScriptLoader();
    const loadStyle = options.styleLoader ?? defaultStyleLoader();
    const hasPlugin = options.hasPlugin ?? (() => true);
    let currentDappId = null;
    async function mount(manifest, container, path) {
      if (currentDappId) {
        unmount();
      }
      if (manifest.requires?.plugins?.length) {
        const missing = manifest.requires.plugins.filter((p) => !hasPlugin(p));
        if (missing.length > 0) {
          events.emit("dx:error", {
            source: `lifecycle:${manifest.id}`,
            error: new Error(`Missing required plugin(s): ${missing.join(", ")}`)
          });
          return;
        }
      }
      if (manifest.styles) {
        try {
          await loadStyle(manifest.styles);
        } catch (err) {
          events.emit("dx:error", {
            source: `lifecycle:${manifest.id}:styles`,
            error: err instanceof Error ? err : new Error(String(err))
          });
        }
      }
      try {
        await loadScript(manifest.entry);
      } catch (err) {
        events.emit("dx:error", {
          source: `lifecycle:${manifest.id}`,
          error: err instanceof Error ? err : new Error(String(err))
        });
        return;
      }
      currentDappId = manifest.id;
      events.emit("dx:mount", { id: manifest.id, container, path: path ?? manifest.route });
      events.emit("dx:dapp:mounted", { id: manifest.id });
    }
    function unmount() {
      if (!currentDappId) return;
      const id = currentDappId;
      events.emit("dx:unmount", { id });
      events.emit("dx:dapp:unmounted", { id });
      currentDappId = null;
    }
    function getCurrentDapp() {
      return currentDappId;
    }
    function destroy() {
      if (currentDappId) unmount();
    }
    return { mount, unmount, getCurrentDapp, destroy };
  }

  // src/registry.ts
  function createPluginRegistry() {
    const plugins = /* @__PURE__ */ new Map();
    function register(name, plugin) {
      plugins.set(name, plugin);
    }
    function get(name) {
      return plugins.get(name);
    }
    function has(name) {
      return plugins.has(name);
    }
    function getAll() {
      const result = {};
      for (const [name, plugin] of plugins) {
        result[name] = plugin;
      }
      return result;
    }
    return { register, get, has, getAll };
  }

  // src/router.ts
  function createRouter(config) {
    const { mode, basePath, manifests } = config;
    const listeners = /* @__PURE__ */ new Set();
    function normalizePath(path) {
      let normalized = path;
      if (basePath !== "/" && normalized.startsWith(basePath)) {
        normalized = normalized.slice(basePath.length) || "/";
      }
      if (!normalized.startsWith("/")) normalized = `/${normalized}`;
      if (normalized.length > 1 && normalized.endsWith("/")) {
        normalized = normalized.slice(0, -1);
      }
      return normalized;
    }
    function resolve(path) {
      const normalized = normalizePath(path);
      const sorted = [...manifests].sort((a, b) => b.route.length - a.route.length);
      for (const manifest of sorted) {
        if (normalized === manifest.route || normalized.startsWith(`${manifest.route}/`)) {
          return manifest;
        }
      }
      return null;
    }
    function readCurrentPath() {
      if (mode === "hash") {
        const hash = window.location.hash.slice(1);
        return hash || "/";
      }
      return window.location.pathname;
    }
    function getCurrentPath() {
      return normalizePath(readCurrentPath());
    }
    function navigate(path) {
      const fullPath = basePath === "/" ? path : basePath + path;
      if (mode === "hash") {
        window.location.hash = `#${fullPath}`;
      } else {
        window.history.pushState(null, "", fullPath);
      }
      notifyListeners();
    }
    function notifyListeners() {
      const manifest = resolve(readCurrentPath());
      for (const handler of listeners) {
        handler(manifest);
      }
    }
    function onRouteChange(handler) {
      listeners.add(handler);
      return () => listeners.delete(handler);
    }
    const onPopState = () => notifyListeners();
    window.addEventListener("popstate", onPopState);
    const onHashChange = mode === "hash" ? () => notifyListeners() : null;
    if (onHashChange) {
      window.addEventListener("hashchange", onHashChange);
    }
    function destroy() {
      window.removeEventListener("popstate", onPopState);
      if (onHashChange) {
        window.removeEventListener("hashchange", onHashChange);
      }
      listeners.clear();
    }
    return { resolve, navigate, getCurrentPath, onRouteChange, destroy };
  }

  // src/utils.ts
  function deepMerge(a, b) {
    const result = { ...a };
    for (const key of Object.keys(b)) {
      if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
      const val = b[key];
      if (val !== void 0 && val !== null && typeof val === "object" && !Array.isArray(val) && typeof result[key] === "object" && result[key] !== null && !Array.isArray(result[key])) {
        result[key] = deepMerge(result[key], val);
      } else if (val !== void 0) {
        result[key] = val;
      }
    }
    return result;
  }

  // src/shell.ts
  function createShell(config = {}) {
    const {
      plugins = {},
      dapps: dappEntries,
      manifests: inlineManifests,
      registryUrl = "/registry.json",
      basePath = "/",
      mode = "history",
      scriptLoader,
      styleLoader
    } = config;
    const events = createEventBus();
    const eventRegistry = createEventRegistry(events);
    const registry = createPluginRegistry();
    const lifecycle = createLifecycleManager(events, {
      hasPlugin: (name) => registry.has(name),
      scriptLoader,
      styleLoader
    });
    let manifests = [];
    let router = createRouter({ mode, basePath, manifests: [] });
    let mountContainer = null;
    let routeUnsub = null;
    let initialized = false;
    const enabledState = /* @__PURE__ */ new Map();
    function getEnabledManifests() {
      return manifests.filter((m) => {
        if (!m.optional) return true;
        return enabledState.get(m.id) ?? true;
      });
    }
    function initEnabledState() {
      for (const m of manifests) {
        if (m.optional) {
          enabledState.set(m.id, m.enabled !== false);
        }
      }
      const settingsPlugin = registry.get("settings");
      if (!settingsPlugin || !("getSettingsAPI" in settingsPlugin)) return;
      const api = settingsPlugin.getSettingsAPI();
      for (const m of manifests) {
        if (m.optional) {
          const persisted = api.get("_shell", m.id);
          if (persisted !== void 0) {
            enabledState.set(m.id, persisted);
          }
        }
      }
    }
    function rebuildRouter() {
      const currentDapp = lifecycle.getCurrentDapp();
      if (routeUnsub) {
        routeUnsub();
        routeUnsub = null;
      }
      router.destroy();
      router = createRouter({ mode, basePath, manifests: getEnabledManifests() });
      routeUnsub = router.onRouteChange(handleRouteChange);
      if (currentDapp) {
        const stillEnabled = getEnabledManifests().some((m) => m.id === currentDapp);
        if (!stillEnabled) {
          lifecycle.unmount();
          router.navigate("/");
        }
      }
    }
    function enableDapp(id) {
      const manifest = manifests.find((m) => m.id === id);
      if (!manifest?.optional) return;
      if (enabledState.get(id) === true) return;
      enabledState.set(id, true);
      if (initialized) rebuildRouter();
      events.emit("dx:dapp:enabled", { id });
    }
    function disableDapp(id) {
      const manifest = manifests.find((m) => m.id === id);
      if (!manifest?.optional) return;
      if (enabledState.get(id) === false) return;
      enabledState.set(id, false);
      if (initialized) rebuildRouter();
      events.emit("dx:dapp:disabled", { id });
    }
    function isDappEnabled(id) {
      const manifest = manifests.find((m) => m.id === id);
      if (!manifest) return false;
      if (!manifest.optional) return true;
      return enabledState.get(id) ?? true;
    }
    const context = {
      events,
      eventRegistry,
      router: {
        navigate: (path) => router.navigate(path),
        getCurrentPath: () => router.getCurrentPath()
      },
      getPlugin: (name) => registry.get(name),
      getPlugins: () => registry.getAll(),
      getManifests: () => [...manifests],
      getEnabledManifests: () => getEnabledManifests(),
      enableDapp,
      disableDapp,
      isDappEnabled
    };
    function isValidManifest(m) {
      return m && typeof m.id === "string" && typeof m.route === "string" && typeof m.entry === "string" && m.nav && typeof m.nav.label === "string";
    }
    async function loadDappManifest(entry) {
      try {
        const res = await fetch(entry.manifest);
        if (!res.ok) return null;
        const base = await res.json();
        if (!isValidManifest(base)) {
          events.emit("dx:error", {
            source: "shell:manifest",
            error: new Error(
              `Invalid manifest from ${entry.manifest} \u2014 missing required fields (id, route, entry, nav.label)`
            )
          });
          return null;
        }
        if (entry.overrides) {
          return deepMerge(base, entry.overrides);
        }
        return base;
      } catch {
        return null;
      }
    }
    async function loadManifests() {
      if (dappEntries?.length) {
        const results = await Promise.all(dappEntries.map(loadDappManifest));
        return results.filter((m) => m !== null);
      }
      if (inlineManifests) {
        return inlineManifests;
      }
      try {
        const res = await fetch(registryUrl);
        if (res.ok) {
          return await res.json();
        }
      } catch {
      }
      return [];
    }
    async function init() {
      if (initialized) return;
      for (const [name, plugin] of Object.entries(plugins)) {
        registry.register(name, plugin);
        events.emit("dx:plugin:registered", { name });
      }
      manifests = await loadManifests();
      for (const [name, plugin] of Object.entries(plugins)) {
        if (plugin.init) {
          try {
            await plugin.init(context);
          } catch (err) {
            events.emit("dx:error", {
              source: `plugin:${name}`,
              error: err instanceof Error ? err : new Error(String(err))
            });
          }
        }
      }
      initEnabledState();
      router.destroy();
      router = createRouter({ mode, basePath, manifests: getEnabledManifests() });
      routeUnsub = router.onRouteChange(handleRouteChange);
      Object.freeze(context);
      window.__DXKIT__ = context;
      initialized = true;
      const initial = router.resolve(router.getCurrentPath());
      if (initial) {
        await mountDapp(initial);
      }
      events.emit("dx:ready", {});
    }
    async function handleRouteChange(manifest) {
      if (manifest) {
        await mountDapp(manifest);
      } else {
        lifecycle.unmount();
      }
      events.emit("dx:route:changed", {
        path: router.getCurrentPath(),
        manifest: manifest ?? void 0
      });
    }
    async function mountDapp(manifest) {
      if (lifecycle.getCurrentDapp() === manifest.id) return;
      const container = getMountContainer();
      if (!container) return;
      await lifecycle.mount(manifest, container, router.getCurrentPath());
    }
    function getMountContainer() {
      if (mountContainer) return mountContainer;
      mountContainer = document.getElementById("dx-mount");
      return mountContainer;
    }
    function getPlugin(name) {
      return registry.get(name);
    }
    function getManifests() {
      return [...manifests];
    }
    function navigate(path) {
      router.navigate(path);
    }
    function getCurrentRoute() {
      return router.getCurrentPath();
    }
    function destroy() {
      lifecycle.destroy();
      if (routeUnsub) {
        routeUnsub();
        routeUnsub = null;
      }
      router.destroy();
      for (const plugin of Object.values(registry.getAll())) {
        if (plugin.destroy) {
          plugin.destroy();
        }
      }
      if (window.__DXKIT__ === context) {
        delete window.__DXKIT__;
      }
      mountContainer = null;
      initialized = false;
    }
    return {
      init,
      getPlugin,
      getManifests,
      getEnabledManifests,
      enableDapp,
      disableDapp,
      isDappEnabled,
      navigate,
      getCurrentRoute,
      destroy
    };
  }
  return __toCommonJS(index_exports);
})();
//# sourceMappingURL=index.global.js.map