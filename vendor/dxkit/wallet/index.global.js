"use strict";
var DxWallet = (() => {
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
    createEIP1193Provider: () => createEIP1193Provider,
    createEthereumWallet: () => createEthereumWallet,
    createLocalWalletProvider: () => createLocalWalletProvider,
    createWallet: () => createWallet
  });
  function createEIP1193Provider() {
    let state = { connected: false, address: null, chainId: null, provider: null };
    const handlers = /* @__PURE__ */ new Set();
    let accountsListener = null;
    let chainListener = null;
    function getEthereumProvider() {
      return window.ethereum;
    }
    function updateState(updates) {
      state = { ...state, ...updates };
      for (const handler of handlers) handler(state);
    }
    return {
      id: "eip1193",
      name: "Browser Wallet",
      available() {
        return !!window.ethereum;
      },
      async connect() {
        const provider = getEthereumProvider();
        if (!provider) {
          throw new Error("No wallet detected. Install MetaMask or another EIP-1193 wallet.");
        }
        const accounts = await provider.request({ method: "eth_requestAccounts" });
        if (accounts.length === 0) {
          throw new Error("Wallet connection request returned no accounts.");
        }
        const chainIdHex = await provider.request({ method: "eth_chainId" });
        const chainId = parseInt(chainIdHex, 16);
        updateState({ connected: true, address: accounts[0], chainId, provider });
        accountsListener = (accts) => {
          if (accts.length === 0) {
            updateState({ connected: false, address: null, provider: null });
          } else {
            updateState({ connected: true, address: accts[0] });
          }
        };
        chainListener = (hex) => {
          updateState({ chainId: parseInt(hex, 16) });
        };
        provider.on?.("accountsChanged", accountsListener);
        provider.on?.("chainChanged", chainListener);
        return state;
      },
      async disconnect() {
        const provider = getEthereumProvider();
        if (accountsListener) provider?.removeListener?.("accountsChanged", accountsListener);
        if (chainListener) provider?.removeListener?.("chainChanged", chainListener);
        accountsListener = null;
        chainListener = null;
        updateState({ connected: false, address: null, chainId: null, provider: null });
      },
      async sign(message) {
        const provider = getEthereumProvider();
        if (!provider || !state.address) throw new Error("Wallet not connected");
        return provider.request({ method: "personal_sign", params: [message, state.address] });
      },
      onStateChange(handler) {
        handlers.add(handler);
        return () => handlers.delete(handler);
      }
    };
  }
  function createLocalWalletProvider(options) {
    const address = options?.address ?? "0x0000000000000000000000000000000001";
    let state = { connected: false, address: null, chainId: null, provider: null };
    const handlers = /* @__PURE__ */ new Set();
    function updateState(updates) {
      state = { ...state, ...updates };
      for (const handler of handlers) handler(state);
    }
    return {
      id: "local",
      name: "Local (Dev)",
      available() {
        return true;
      },
      async connect() {
        updateState({ connected: true, address, chainId: 0, provider: null });
        return state;
      },
      async disconnect() {
        updateState({ connected: false, address: null, chainId: null, provider: null });
      },
      async sign(message) {
        if (!state.connected) throw new Error("Wallet not connected");
        const bytes = new TextEncoder().encode(message);
        const hex = Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
        return `0x${hex}`;
      },
      onStateChange(handler) {
        handlers.add(handler);
        return () => handlers.delete(handler);
      }
    };
  }
  function createWallet(options) {
    const providers = options.providers;
    const storageKey = options.storageKey ?? "dxkit:wallet";
    let activeProvider = null;
    let activeUnsub = null;
    let dx = null;
    let storageWarned = false;
    let state = { connected: false, address: null, chainId: null, provider: null };
    const handlers = /* @__PURE__ */ new Set();
    function canUseStorage() {
      try {
        return typeof localStorage !== "undefined" && typeof localStorage.setItem === "function";
      } catch (err) {
        if (!storageWarned && dx) {
          storageWarned = true;
          dx.events.emit("dx:error", {
            source: "plugin:wallet:storage:unavailable",
            error: new Error(
              `Wallet storage is unavailable (opaque origin or similar) \u2014 degrading to in-memory state: ${err instanceof Error ? err.message : String(err)}`,
              { cause: err }
            )
          });
        }
        return false;
      }
    }
    function persistProvider(providerId) {
      if (!canUseStorage()) return;
      try {
        if (providerId) {
          localStorage.setItem(storageKey, providerId);
        } else {
          localStorage.removeItem(storageKey);
        }
      } catch (err) {
        dx?.events.emit("dx:error", {
          source: "plugin:wallet:storage:write",
          error: new Error(`Wallet provider persist failed: ${err instanceof Error ? err.message : String(err)}`, {
            cause: err
          })
        });
      }
    }
    function getPersistedProvider() {
      if (!canUseStorage()) return null;
      try {
        return localStorage.getItem(storageKey);
      } catch (err) {
        dx?.events.emit("dx:error", {
          source: "plugin:wallet:storage:read",
          error: new Error(`Wallet provider restore failed: ${err instanceof Error ? err.message : String(err)}`, {
            cause: err
          })
        });
        return null;
      }
    }
    function updateState(newState) {
      const wasConnected = state.connected;
      state = { ...newState };
      for (const handler of handlers) handler(state);
      if (!dx) return;
      if (newState.connected && !newState.address) {
        dx.events.emit("dx:error", {
          source: "plugin:wallet:state",
          error: new Error("Wallet provider reported connected state with no address")
        });
      }
      if (newState.connected && newState.address && !wasConnected) {
        dx.events.emit("dx:plugin:wallet:connected", { address: newState.address, chainId: newState.chainId ?? 0 });
      } else if (!newState.connected && wasConnected) {
        dx.events.emit("dx:plugin:wallet:disconnected", {});
      } else if (newState.connected && newState.address && wasConnected) {
        dx.events.emit("dx:plugin:wallet:changed", { address: newState.address, chainId: newState.chainId ?? 0 });
      }
    }
    function getSetting(key, fallback) {
      try {
        const settings = dx?.settings;
        if (settings) return settings.get("wallet", key) ?? fallback;
      } catch {
      }
      return fallback;
    }
    const plugin = {
      name: "wallet",
      settings: [
        {
          key: "revokeOnDisconnect",
          label: "Revoke on Disconnect",
          type: "boolean",
          default: true,
          description: "Revoke wallet permissions when disconnecting. When enabled, reconnecting requires explicit wallet approval."
        }
      ],
      async init(context) {
        dx = context;
        context.eventRegistry.registerEvent("wallet", [
          { name: "dx:plugin:wallet:connected" },
          { name: "dx:plugin:wallet:disconnected" },
          { name: "dx:plugin:wallet:changed" }
        ]);
        const savedId = getPersistedProvider();
        if (savedId) {
          const provider = providers.find((p) => p.id === savedId);
          if (provider?.available()) {
            try {
              await plugin.connect(savedId);
            } catch (err) {
              dx?.events.emit("dx:error", {
                source: "plugin:wallet:reconnect",
                error: err instanceof Error ? err : new Error(String(err), { cause: err })
              });
              persistProvider(null);
            }
          }
        }
      },
      async destroy() {
        if (activeUnsub) activeUnsub();
        activeUnsub = null;
        if (activeProvider) {
          await activeProvider.disconnect();
        }
        activeProvider = null;
        handlers.clear();
        dx = null;
      },
      async connect(providerId) {
        if (activeProvider) {
          if (activeUnsub) activeUnsub();
          activeUnsub = null;
          await activeProvider.disconnect();
        }
        let provider;
        if (providerId) {
          provider = providers.find((p) => p.id === providerId);
          if (!provider) throw new Error(`Wallet provider '${providerId}' not found`);
          if (!provider.available()) throw new Error(`Wallet provider '${providerId}' is not available`);
        } else {
          provider = providers.find((p) => p.available());
          if (!provider) throw new Error("No wallet provider available");
        }
        activeProvider = provider;
        activeUnsub = provider.onStateChange((providerState) => {
          updateState(providerState);
        });
        await provider.connect();
        persistProvider(provider.id);
        return state;
      },
      async disconnect() {
        const shouldRevoke = getSetting("revokeOnDisconnect", true);
        if (shouldRevoke && activeProvider?.id === "eip1193") {
          try {
            const eth = window.ethereum;
            if (eth) {
              await eth.request({
                method: "wallet_revokePermissions",
                params: [{ eth_accounts: {} }]
              });
            }
          } catch {
          }
        }
        if (activeUnsub) activeUnsub();
        activeUnsub = null;
        if (activeProvider) {
          await activeProvider.disconnect();
        }
        activeProvider = null;
        persistProvider(null);
        updateState({ connected: false, address: null, chainId: null, provider: null });
      },
      getState() {
        return { ...state };
      },
      async sign(message) {
        if (!activeProvider || !state.connected) throw new Error("Wallet not connected");
        return activeProvider.sign(message);
      },
      onStateChange(handler) {
        handlers.add(handler);
        return () => handlers.delete(handler);
      },
      getProviders() {
        return [...providers];
      },
      getActiveProvider() {
        return activeProvider;
      }
    };
    return plugin;
  }
  function createEthereumWallet() {
    return createWallet({ providers: [createEIP1193Provider()] });
  }
  return __toCommonJS(index_exports);
})();
//# sourceMappingURL=index.global.js.map
