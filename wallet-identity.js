(() => {
  const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
  function isAddress(value) {
    return typeof value === "string" && ADDRESS_RE.test(value);
  }
  function toChainId(value) {
    return Number.isFinite(value) && value !== 0 ? value : null;
  }
  let live = null;
  function acceptLiveIdentity(_dx, address, chainId) {
    if (!isAddress(address)) return false;
    if (live && live.address.toLowerCase() === address.toLowerCase()) {
      const nextChainId = toChainId(chainId);
      if (live.chainId !== nextChainId) live = { address: live.address, chainId: nextChainId };
      return false;
    }
    live = { address, chainId: toChainId(chainId) };
    return true;
  }
  function liveIdentity() {
    return live;
  }
  function clearIdentity() {
    live = null;
  }
  async function probeAccounts() {
    const eth = window.ethereum;
    if (typeof eth?.request !== "function") return null;
    const accounts = await eth.request({ method: "eth_accounts" });
    const address = Array.isArray(accounts) ? accounts[0] : void 0;
    if (!address) return null;
    let chainId = null;
    try {
      const chainIdHex = await eth.request({ method: "eth_chainId" });
      chainId = toChainId(Number.parseInt(chainIdHex, 16));
    } catch {
      chainId = null;
    }
    return { address, chainId };
  }
  let generation = 0;
  function init(dx, onChange) {
    if (!dx) return () => void 0;
    const gen = ++generation;
    live = null;
    const unsubscribers = [];
    const eth = window.ethereum;
    if (typeof eth?.on === "function") {
      const onAccountsChanged = (accounts) => {
        const address = Array.isArray(accounts) ? accounts[0] : void 0;
        if (!address) return;
        if (acceptLiveIdentity(dx, address, void 0)) onChange();
      };
      const onChainChanged = (chainIdHex) => {
        if (!live) return;
        let chainId = null;
        try {
          chainId = toChainId(Number.parseInt(chainIdHex, 16));
        } catch {
          chainId = null;
        }
        if (acceptLiveIdentity(dx, live.address, chainId)) onChange();
      };
      eth.on("accountsChanged", onAccountsChanged);
      eth.on("chainChanged", onChainChanged);
      unsubscribers.push(() => eth.removeListener?.("accountsChanged", onAccountsChanged));
      unsubscribers.push(() => eth.removeListener?.("chainChanged", onChainChanged));
    }
    probeAccounts().then((result) => {
      if (gen !== generation || !result) return;
      if (acceptLiveIdentity(dx, result.address, result.chainId)) onChange();
    }).catch(() => void 0);
    return function cleanup() {
      generation++;
      for (const unsubscribe of unsubscribers) unsubscribe();
      unsubscribers.length = 0;
    };
  }
  window.DnznWalletIdentity = {
    init,
    isAddress,
    liveIdentity,
    acceptLiveIdentity,
    clearIdentity
  };
})();
