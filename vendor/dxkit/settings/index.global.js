"use strict";
var DxSettings = (() => {
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
    createSettings: () => createSettings
  });
  function createSettings(options = {}) {
    const { storageKey = "dxkit:settings" } = options;
    const store = /* @__PURE__ */ new Map();
    const definitions = /* @__PURE__ */ new Map();
    const sectionLabels = /* @__PURE__ */ new Map();
    const keyHandlers = /* @__PURE__ */ new Map();
    const dappHandlers = /* @__PURE__ */ new Map();
    let dx = null;
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
        const data = {};
        for (const [dappId, values] of store) {
          data[dappId] = Object.fromEntries(values);
        }
        localStorage.setItem(storageKey, JSON.stringify(data));
      } catch {
      }
    }
    function restore() {
      if (!canUseStorage()) return;
      try {
        const raw = localStorage.getItem(storageKey);
        if (!raw) return;
        const data = JSON.parse(raw);
        for (const [dappId, values] of Object.entries(data)) {
          const map = /* @__PURE__ */ new Map();
          for (const [key, value] of Object.entries(values)) {
            map.set(key, value);
          }
          store.set(dappId, map);
        }
      } catch {
      }
    }
    function getDefault(dappId, key) {
      const defs = definitions.get(dappId);
      if (!defs) return void 0;
      const def = defs.find((d) => d.key === key);
      return def?.default;
    }
    function loadDefinitions(dx2) {
      const optionalDapps = dx2.getManifests().filter((m) => m.optional);
      if (optionalDapps.length > 0) {
        const dappToggleDefs = optionalDapps.map((m) => ({
          key: m.id,
          label: m.name,
          type: "boolean",
          default: m.enabled !== false,
          description: m.description
        }));
        definitions.set("_shell", dappToggleDefs);
        sectionLabels.set("_shell", "Dapps");
        for (const m of optionalDapps) {
          settingsAPI.onChange("_shell", m.id, (value) => {
            if (value) {
              dx2.enableDapp(m.id);
            } else {
              dx2.disableDapp(m.id);
            }
          });
        }
      }
      for (const m of dx2.getManifests()) {
        if (m.settings?.length) {
          definitions.set(m.id, m.settings);
          sectionLabels.set(m.id, m.name);
        }
      }
      for (const [name, plugin2] of Object.entries(dx2.getPlugins())) {
        if (plugin2.settings?.length) {
          definitions.set(name, plugin2.settings);
          sectionLabels.set(name, name.charAt(0).toUpperCase() + name.slice(1));
        }
      }
    }
    const settingsAPI = {
      get(dappId, key) {
        const dappStore = store.get(dappId);
        if (dappStore?.has(key)) return dappStore.get(key);
        return getDefault(dappId, key);
      },
      set(dappId, key, value) {
        if (!store.has(dappId)) store.set(dappId, /* @__PURE__ */ new Map());
        store.get(dappId).set(key, value);
        persist();
        const kHandlers = keyHandlers.get(`${dappId}:${key}`);
        if (kHandlers) {
          for (const handler of kHandlers) handler(value);
        }
        const dHandlers = dappHandlers.get(dappId);
        if (dHandlers) {
          for (const handler of dHandlers) handler(key, value);
        }
        dx?.events.emit("dx:plugin:settings:changed", { dappId, key, value });
      },
      getAll(dappId) {
        const result = {};
        const defs = definitions.get(dappId);
        if (defs) {
          for (const def of defs) {
            result[def.key] = def.default;
          }
        }
        const dappStore = store.get(dappId);
        if (dappStore) {
          for (const [key, value] of dappStore) {
            result[key] = value;
          }
        }
        return result;
      },
      getSections() {
        const sections = [];
        const manifests = dx ? new Set(dx.getManifests().map((m) => m.id)) : /* @__PURE__ */ new Set();
        for (const [id, defs] of definitions) {
          if (id !== "_shell" && manifests.has(id) && dx && !dx.isDappEnabled(id)) continue;
          sections.push({
            id,
            label: sectionLabels.get(id) ?? id,
            definitions: defs
          });
        }
        return sections;
      },
      onChange(dappId, key, handler) {
        const mapKey = `${dappId}:${key}`;
        if (!keyHandlers.has(mapKey)) keyHandlers.set(mapKey, /* @__PURE__ */ new Set());
        keyHandlers.get(mapKey).add(handler);
        return () => keyHandlers.get(mapKey)?.delete(handler);
      },
      onAnyChange(dappId, handler) {
        if (!dappHandlers.has(dappId)) dappHandlers.set(dappId, /* @__PURE__ */ new Set());
        dappHandlers.get(dappId).add(handler);
        return () => dappHandlers.get(dappId)?.delete(handler);
      }
    };
    const plugin = {
      name: "settings",
      async init(context) {
        dx = context;
        context.eventRegistry.registerEvent("settings", [{ name: "dx:plugin:settings:changed" }]);
        restore();
        loadDefinitions(context);
        context.settings = settingsAPI;
      },
      async destroy() {
        keyHandlers.clear();
        dappHandlers.clear();
        dx = null;
      },
      getSettingsAPI() {
        return settingsAPI;
      }
    };
    return plugin;
  }
  return __toCommonJS(index_exports);
})();
//# sourceMappingURL=index.global.js.map