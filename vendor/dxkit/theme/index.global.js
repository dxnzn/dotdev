"use strict";
var DxTheme = (() => {
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
    createCSSTheme: () => createCSSTheme
  });
  function createCSSTheme(options = {}) {
    const { themes = ["default"], defaultMode = "system", storageKey = "dxkit:theme", onApply } = options;
    let currentTheme = themes[0];
    let currentMode = defaultMode;
    let dx = null;
    let settingsListener = null;
    let syncing = false;
    const modeHandlers = /* @__PURE__ */ new Set();
    const themeHandlers = /* @__PURE__ */ new Set();
    const mql = typeof window !== "undefined" ? window.matchMedia("(prefers-color-scheme: dark)") : null;
    function resolveMode() {
      if (currentMode !== "system") return currentMode;
      return mql?.matches ? "dark" : "light";
    }
    function applyToDOM() {
      if (typeof document === "undefined") return;
      const el = document.documentElement;
      const resolved = resolveMode();
      el.setAttribute("data-theme", currentTheme);
      el.setAttribute("data-mode", resolved);
      onApply?.({ theme: currentTheme, mode: currentMode, resolved });
    }
    function canUseStorage() {
      try {
        return typeof localStorage !== "undefined" && typeof localStorage.setItem === "function";
      } catch {
        return false;
      }
    }
    function persist() {
      if (!canUseStorage()) return;
      try {
        localStorage.setItem(
          storageKey,
          JSON.stringify({
            theme: currentTheme,
            mode: currentMode
          })
        );
      } catch {
      }
    }
    function restore() {
      if (!canUseStorage()) return;
      try {
        const raw = localStorage.getItem(storageKey);
        if (!raw) return;
        const saved = JSON.parse(raw);
        if (saved.theme && themes.includes(saved.theme)) currentTheme = saved.theme;
        if (saved.mode && ["light", "dark", "system"].includes(saved.mode)) currentMode = saved.mode;
      } catch {
      }
    }
    function syncToSettings() {
      if (!dx?.settings || syncing) return;
      syncing = true;
      dx.settings.set("theme", "theme", currentTheme);
      dx.settings.set("theme", "mode", currentMode);
      syncing = false;
    }
    function notifyModeChange() {
      const resolved = resolveMode();
      for (const handler of modeHandlers) handler(currentMode, resolved);
      dx?.events.emit("dx:plugin:theme:changed", { theme: currentTheme, mode: currentMode, resolved });
      syncToSettings();
    }
    function notifyThemeChange() {
      for (const handler of themeHandlers) handler(currentTheme);
      dx?.events.emit("dx:plugin:theme:changed", { theme: currentTheme, mode: currentMode, resolved: resolveMode() });
      syncToSettings();
    }
    function onSystemChange() {
      if (currentMode !== "system") return;
      applyToDOM();
      notifyModeChange();
    }
    function onSettingsChanged(event) {
      if (event.dappId !== "theme" || syncing) return;
      if (event.key === "theme" && typeof event.value === "string") {
        plugin.setTheme(event.value);
      } else if (event.key === "mode" && typeof event.value === "string") {
        plugin.setMode(event.value);
      }
    }
    function buildSettings() {
      const defs = [];
      if (themes.length > 1) {
        defs.push({
          key: "theme",
          label: "Theme",
          type: "select",
          default: themes[0],
          description: "Color palette.",
          options: themes.map((t) => ({ label: t.charAt(0).toUpperCase() + t.slice(1), value: t }))
        });
      }
      defs.push({
        key: "mode",
        label: "Mode",
        type: "select",
        default: defaultMode,
        description: "Light, dark, or match your system.",
        options: [
          { label: "System", value: "system" },
          { label: "Light", value: "light" },
          { label: "Dark", value: "dark" }
        ]
      });
      return defs;
    }
    const plugin = {
      name: "theme",
      settings: buildSettings(),
      async init(context) {
        dx = context;
        context.eventRegistry.registerEvent("theme", [{ name: "dx:plugin:theme:changed" }]);
        restore();
        applyToDOM();
        mql?.addEventListener("change", onSystemChange);
        syncToSettings();
        settingsListener = dx.events.on("dx:plugin:settings:changed", onSettingsChanged);
      },
      async destroy() {
        mql?.removeEventListener("change", onSystemChange);
        if (settingsListener) {
          settingsListener.off();
          settingsListener = null;
        }
        modeHandlers.clear();
        themeHandlers.clear();
        dx = null;
      },
      getMode() {
        return currentMode;
      },
      setMode(mode) {
        if (currentMode === mode) return;
        currentMode = mode;
        applyToDOM();
        persist();
        notifyModeChange();
      },
      toggleMode() {
        const cycle = ["system", "light", "dark"];
        const idx = cycle.indexOf(currentMode);
        plugin.setMode(cycle[(idx + 1) % cycle.length]);
      },
      getResolvedMode() {
        return resolveMode();
      },
      onModeChange(handler) {
        modeHandlers.add(handler);
        return () => modeHandlers.delete(handler);
      },
      getTheme() {
        return currentTheme;
      },
      setTheme(theme) {
        if (currentTheme === theme) return;
        if (!themes.includes(theme)) return;
        currentTheme = theme;
        applyToDOM();
        persist();
        notifyThemeChange();
      },
      getAvailableThemes() {
        return [...themes];
      },
      onThemeChange(handler) {
        themeHandlers.add(handler);
        return () => themeHandlers.delete(handler);
      }
    };
    return plugin;
  }
  return __toCommonJS(index_exports);
})();
//# sourceMappingURL=index.global.js.map