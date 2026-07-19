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
    "dx:route:subpath",
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
  function isTimeoutActive(timeoutMs) {
    return timeoutMs > 0 && Number.isFinite(timeoutMs);
  }
  function withTimeout(loader, timeoutMs, label) {
    if (!isTimeoutActive(timeoutMs)) return loader;
    return (arg) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Timed out loading dapp ${label} after ${timeoutMs}ms: ${arg}`));
      }, timeoutMs);
      loader(arg).then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (err) => {
          clearTimeout(timer);
          reject(err);
        }
      );
    });
  }
  function withSanitizeTimeout(sanitizer, timeoutMs) {
    if (!isTimeoutActive(timeoutMs)) return sanitizer;
    return (html, manifest) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Timed out sanitizing dapp template after ${timeoutMs}ms: ${manifest.id}`));
      }, timeoutMs);
      Promise.resolve(sanitizer(html, manifest)).then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (err) => {
          clearTimeout(timer);
          reject(err);
        }
      );
    });
  }
  function defaultScriptLoader(timeoutMs) {
    const loaded = /* @__PURE__ */ new Set();
    return (src) => {
      if (loaded.has(src)) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.type = "module";
        script.src = src;
        let timer;
        script.onload = () => {
          if (timer) clearTimeout(timer);
          loaded.add(src);
          resolve();
        };
        script.onerror = () => {
          if (timer) clearTimeout(timer);
          reject(new Error(`Failed to load dapp script: ${src}`));
        };
        document.head.appendChild(script);
        if (isTimeoutActive(timeoutMs)) {
          timer = setTimeout(() => {
            script.onload = null;
            script.onerror = null;
            script.remove();
            reject(new Error(`Timed out loading dapp script after ${timeoutMs}ms: ${src}`));
          }, timeoutMs);
        }
      });
    };
  }
  function defaultStyleLoader(timeoutMs) {
    const loaded = /* @__PURE__ */ new Set();
    return (href) => {
      if (loaded.has(href)) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const link = document.createElement("link");
        link.rel = "stylesheet";
        link.href = href;
        let timer;
        link.onload = () => {
          if (timer) clearTimeout(timer);
          loaded.add(href);
          resolve();
        };
        link.onerror = () => {
          if (timer) clearTimeout(timer);
          reject(new Error(`Failed to load dapp styles: ${href}`));
        };
        document.head.appendChild(link);
        if (isTimeoutActive(timeoutMs)) {
          timer = setTimeout(() => {
            link.onload = null;
            link.onerror = null;
            link.remove();
            reject(new Error(`Timed out loading dapp styles after ${timeoutMs}ms: ${href}`));
          }, timeoutMs);
        }
      });
    };
  }
  function defaultTemplateLoader(timeoutMs) {
    return async (src) => {
      if (!isTimeoutActive(timeoutMs)) {
        const res = await fetch(src);
        if (!res.ok) throw new Error(`Failed to load dapp template: ${src} (${res.status})`);
        return res.text();
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(src, { signal: controller.signal });
        if (!res.ok) throw new Error(`Failed to load dapp template: ${src} (${res.status})`);
        return await res.text();
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
          throw new Error(`Timed out loading dapp template after ${timeoutMs}ms: ${src}`);
        }
        throw err;
      } finally {
        clearTimeout(timer);
      }
    };
  }
  function createLifecycleManager(events, options = {}) {
    const timeoutMs = options.timeout ?? 3e4;
    const loadScript = options.scriptLoader ? withTimeout(options.scriptLoader, timeoutMs, "script") : defaultScriptLoader(timeoutMs);
    const loadStyle = options.styleLoader ? withTimeout(options.styleLoader, timeoutMs, "styles") : defaultStyleLoader(timeoutMs);
    const loadTemplateUncached = options.templateLoader ? withTimeout(options.templateLoader, timeoutMs, "template") : defaultTemplateLoader(timeoutMs);
    const hasPlugin = options.hasPlugin ?? (() => true);
    const sanitizeTemplate = options.sanitizeTemplate ? withSanitizeTimeout(options.sanitizeTemplate, timeoutMs) : void 0;
    let currentDappId = null;
    let mountGeneration = 0;
    let inFlightMountId = null;
    let inFlightGeneration = null;
    const cacheEnabled = options.cacheTemplates ?? true;
    const templateCache = /* @__PURE__ */ new Map();
    async function loadTemplate(url) {
      if (!cacheEnabled) return loadTemplateUncached(url);
      const cached = templateCache.get(url);
      if (cached !== void 0) return cached;
      const html = await loadTemplateUncached(url);
      templateCache.set(url, html);
      return html;
    }
    async function mount(manifest, container, path) {
      const generation = ++mountGeneration;
      inFlightMountId = manifest.id;
      inFlightGeneration = generation;
      const isStale = () => generation !== mountGeneration;
      const clearOwnedInFlightMarker = () => {
        if (inFlightGeneration === generation) {
          inFlightMountId = null;
          inFlightGeneration = null;
        }
      };
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
          clearOwnedInFlightMarker();
          return false;
        }
      }
      if (manifest.styles) {
        try {
          await loadStyle(manifest.styles);
        } catch (err) {
          if (!isStale()) {
            events.emit("dx:error", {
              source: `lifecycle:${manifest.id}:styles`,
              error: err instanceof Error ? err : new Error(String(err))
            });
          }
        }
      }
      if (manifest.template) {
        let html;
        try {
          html = await loadTemplate(manifest.template);
        } catch (err) {
          if (!isStale()) {
            events.emit("dx:error", {
              source: `lifecycle:${manifest.id}:template`,
              error: err instanceof Error ? err : new Error(String(err))
            });
          }
          clearOwnedInFlightMarker();
          return false;
        }
        if (isStale()) {
          clearOwnedInFlightMarker();
          return false;
        }
        if (sanitizeTemplate) {
          let sanitized;
          try {
            sanitized = await sanitizeTemplate(html, manifest);
          } catch (err) {
            if (!isStale()) {
              events.emit("dx:error", {
                source: `lifecycle:${manifest.id}:sanitize`,
                error: err instanceof Error ? err : new Error(String(err), { cause: err })
              });
            }
            clearOwnedInFlightMarker();
            return false;
          }
          if (isStale()) {
            clearOwnedInFlightMarker();
            return false;
          }
          container.innerHTML = sanitized;
        } else {
          container.innerHTML = html;
        }
      }
      if (manifest.dependencies?.length) {
        for (const dep of manifest.dependencies) {
          try {
            await loadScript(dep);
          } catch (err) {
            if (!isStale()) {
              events.emit("dx:error", {
                source: `lifecycle:${manifest.id}:dependency`,
                error: err instanceof Error ? err : new Error(String(err))
              });
              container.innerHTML = "";
            }
            clearOwnedInFlightMarker();
            return false;
          }
          if (isStale()) {
            clearOwnedInFlightMarker();
            return false;
          }
        }
      }
      try {
        await loadScript(manifest.entry);
      } catch (err) {
        if (!isStale()) {
          events.emit("dx:error", {
            source: `lifecycle:${manifest.id}`,
            error: err instanceof Error ? err : new Error(String(err))
          });
          container.innerHTML = "";
        }
        clearOwnedInFlightMarker();
        return false;
      }
      if (isStale()) {
        clearOwnedInFlightMarker();
        return false;
      }
      currentDappId = manifest.id;
      clearOwnedInFlightMarker();
      events.emit("dx:mount", { id: manifest.id, container, path: path ?? manifest.route });
      events.emit("dx:dapp:mounted", { id: manifest.id });
      return true;
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
    function clearTemplateCache() {
      templateCache.clear();
    }
    function invalidateTemplate(url) {
      templateCache.delete(url);
    }
    function invalidatePendingMount(id) {
      if (inFlightMountId === id) {
        mountGeneration++;
      }
    }
    function invalidateAnyPendingMount() {
      if (inFlightMountId !== null) {
        mountGeneration++;
      }
    }
    return {
      mount,
      unmount,
      getCurrentDapp,
      destroy,
      clearTemplateCache,
      invalidateTemplate,
      invalidatePendingMount,
      invalidateAnyPendingMount
    };
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
    const sorted = [...manifests].sort((a, b) => b.route.length - a.route.length);
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
        const target = `#${fullPath}`;
        if (window.location.hash === target) {
          notifyListeners();
        } else {
          window.location.hash = target;
        }
      } else {
        window.history.pushState(null, "", fullPath);
        notifyListeners();
      }
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
    const overrides = b;
    for (const key of Object.keys(overrides)) {
      if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
      const val = overrides[key];
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
    const flatLoaderKeys = ["scriptLoader", "styleLoader", "templateLoader"];
    const presentFlatKeys = flatLoaderKeys.filter((key) => Object.hasOwn(config, key));
    if (presentFlatKeys.length > 0) {
      throw new Error(
        `ShellConfig.${presentFlatKeys.join("/")} ${presentFlatKeys.length > 1 ? "are" : "is"} no longer supported \u2014 move to config.lifecycle.${presentFlatKeys.join("/")}.`
      );
    }
    const registryUrlExplicit = Object.hasOwn(config, "registryUrl");
    const {
      plugins = {},
      dapps: dappEntries,
      manifests: inlineManifests,
      registryUrl = "/registry.json",
      basePath = "/",
      mode = "history",
      lifecycle: lifecycleOptions = {}
    } = config;
    const events = createEventBus();
    const eventRegistry = createEventRegistry(events);
    const registry = createPluginRegistry();
    const lifecycle = createLifecycleManager(events, {
      ...lifecycleOptions,
      // Bound last so a consumer-supplied hasPlugin (including `hasPlugin: undefined`) can't
      // clobber the registry-backed check and disable required-plugin enforcement.
      hasPlugin: (name) => registry.has(name)
    });
    let manifests = [];
    let router = createRouter({ mode, basePath, manifests: [] });
    let mountContainer = null;
    let routeUnsub = null;
    let initialized = false;
    let currentPath = null;
    let pendingMountId = null;
    let pendingMountToken = 0;
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
      if (initialized) {
        const routeOwnedByDisabledDapp = router.resolve(router.getCurrentPath())?.id === id;
        const wasUncommittedMount = lifecycle.getCurrentDapp() !== id;
        lifecycle.invalidatePendingMount(id);
        if (pendingMountId === id) releasePendingMount();
        rebuildRouter();
        if (routeOwnedByDisabledDapp && wasUncommittedMount) {
          router.navigate("/");
        }
      }
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
        if (!res.ok) {
          const statusInfo = typeof res.status === "number" ? ` (status ${res.status})` : "";
          events.emit("dx:error", {
            source: "shell:manifest",
            error: new Error(`Failed to fetch manifest from ${entry.manifest}${statusInfo} \u2014 non-OK response`)
          });
          return null;
        }
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
      } catch (err) {
        events.emit("dx:error", {
          source: "shell:manifest",
          error: new Error(
            `Failed to load manifest from ${entry.manifest} \u2014 request failed or response was not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
            { cause: err }
          )
        });
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
        if (!res.ok) {
          if (registryUrlExplicit) {
            const statusInfo = typeof res.status === "number" ? ` (status ${res.status})` : "";
            events.emit("dx:error", {
              source: "shell:manifest",
              error: new Error(`Failed to fetch registry from ${registryUrl}${statusInfo} \u2014 non-OK response`)
            });
          }
          return [];
        }
        const parsed = await res.json();
        if (!Array.isArray(parsed)) {
          events.emit("dx:error", {
            source: "shell:manifest",
            error: new Error(
              // `typeof null` is 'object', so disambiguate null explicitly — a null body and an
              // object-wrapped registry ({ manifests: [...] }) are the two common misconfigurations.
              `Failed to load registry from ${registryUrl} \u2014 expected a JSON array of manifests, got ${parsed === null ? "null" : typeof parsed}`
            )
          });
          return [];
        }
        return parsed;
      } catch (err) {
        if (registryUrlExplicit) {
          events.emit("dx:error", {
            source: "shell:manifest",
            error: new Error(
              `Failed to load registry from ${registryUrl} \u2014 request failed or response was not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
              { cause: err }
            )
          });
        }
      }
      return [];
    }
    function normalizeRoute(route) {
      const trimmed = route.trim();
      if (trimmed === "") return null;
      let normalized = trimmed;
      if (!normalized.startsWith("/")) normalized = `/${normalized}`;
      if (normalized.length > 1 && normalized.endsWith("/")) {
        normalized = normalized.slice(0, -1);
      }
      return normalized;
    }
    function normalizeAndValidateManifests(list) {
      const validated = [];
      for (const m of list) {
        if (!isValidManifest(m)) {
          events.emit("dx:error", {
            source: "shell:manifest",
            error: new Error(
              `Invalid manifest "${m?.id ?? "unknown"}" \u2014 missing required fields (id, route, entry, nav.label)`
            )
          });
          continue;
        }
        const normalizedRoute = normalizeRoute(m.route);
        if (normalizedRoute === null) {
          events.emit("dx:error", {
            source: "shell:route",
            error: new Error(`Manifest "${m.id}" has an empty or whitespace-only route \u2014 discarded`)
          });
          continue;
        }
        validated.push(normalizedRoute === m.route ? m : { ...m, route: normalizedRoute });
      }
      const seenRoutes = /* @__PURE__ */ new Map();
      for (const m of validated) {
        const firstId = seenRoutes.get(m.route);
        if (firstId) {
          events.emit("dx:error", {
            source: "shell:manifest",
            error: new Error(
              `Duplicate route "${m.route}" declared by manifests "${firstId}" and "${m.id}" \u2014 "${firstId}" wins (first registered)`
            )
          });
        } else {
          seenRoutes.set(m.route, m.id);
        }
      }
      return validated;
    }
    async function init() {
      if (initialized) return;
      for (const [name, plugin] of Object.entries(plugins)) {
        registry.register(name, plugin);
        events.emit("dx:plugin:registered", { name });
      }
      manifests = normalizeAndValidateManifests(await loadManifests());
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
        lifecycle.invalidateAnyPendingMount();
        releasePendingMount();
        lifecycle.unmount();
      }
      events.emit("dx:route:changed", {
        path: router.getCurrentPath(),
        manifest: manifest ?? void 0
      });
    }
    function releasePendingMount() {
      pendingMountToken++;
      pendingMountId = null;
    }
    async function mountDapp(manifest) {
      const path = router.getCurrentPath();
      if (lifecycle.getCurrentDapp() === manifest.id) {
        if (currentPath !== null && currentPath !== path) {
          const previousPath = currentPath;
          currentPath = path;
          events.emit("dx:route:subpath", { id: manifest.id, path, previousPath });
        }
        return;
      }
      if (pendingMountId === manifest.id) return;
      const container = getMountContainer();
      if (!container) {
        events.emit("dx:error", {
          source: "shell:mount",
          error: new Error(`Mount failed for "${manifest.id}" \u2014 #dx-mount container not found in the DOM`)
        });
        return;
      }
      pendingMountId = manifest.id;
      const myToken = ++pendingMountToken;
      try {
        const committed = await lifecycle.mount(manifest, container, path);
        if (committed) {
          const freshPath = router.getCurrentPath();
          if (freshPath !== path) {
            events.emit("dx:route:subpath", { id: manifest.id, path: freshPath, previousPath: path });
          }
          currentPath = freshPath;
        }
      } finally {
        if (pendingMountToken === myToken) {
          pendingMountId = null;
        }
      }
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