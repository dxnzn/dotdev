(() => {
  const port = window.DnznWalletIdentity;
  function shortenAddress(addr) {
    if (typeof addr !== "string" || addr.length <= 12) return addr;
    return `${addr.slice(0, 6)}\u2026${addr.slice(-4)}`;
  }
  function describeError(err) {
    switch (err?.code) {
      case 4001:
      case -32002:
        return null;
      case 4100:
        return "This site is not authorized. Approve the connection in your wallet.";
      case 4200:
        return "Your wallet does not support this request.";
      case 4900:
        return "Your wallet is disconnected from all networks.";
      case 4901:
        return "Your wallet is not connected to this network.";
      default:
        return "Could not connect to your wallet.";
    }
  }
  function resolveIdentity(_dx) {
    const live = liveSuppressed ? null : port.liveIdentity();
    return live ? { address: live.address, source: "live" } : { address: null, source: "none" };
  }
  function stateFrom(dx, identity) {
    const providers = dx?.getPlugin?.("wallet")?.getProviders?.() ?? [];
    if (!providers.some((p) => p?.available?.())) return "no-provider";
    return identity.source === "none" ? "disconnected" : "connected";
  }
  function resolveState(dx) {
    return stateFrom(dx, resolveIdentity(dx));
  }
  function buildNode(tag, className, text) {
    const node = document.createElement(tag);
    node.className = className;
    node.textContent = text;
    return node;
  }
  function buildMenuRow(label, id, onClick) {
    const row = buildNode("button", "wallet-menu-row", label);
    row.type = "button";
    row.id = id;
    row.addEventListener("click", onClick);
    return row;
  }
  function buildSettingsRow(dx) {
    const manifests = dx?.getEnabledManifests?.() ?? [];
    if (!manifests.some((m) => m?.route === "/settings")) return null;
    return buildMenuRow("Settings", "wallet-settings", () => {
      document.getElementById("wallet-panel")?.classList.remove("open");
      document.getElementById("wallet-btn")?.setAttribute("aria-expanded", "false");
      dx.router.navigate("/settings");
    });
  }
  function paintChip(trigger, address) {
    if (!trigger) return;
    trigger.setAttribute("title", address ?? "Wallet");
    trigger.querySelector(".wallet-chip")?.remove();
    if (!address) return;
    const chip = buildNode("span", "wallet-chip", "");
    chip.append(buildNode("span", "wallet-address", shortenAddress(address)));
    trigger.append(chip);
  }
  function revealFullAddress(address) {
    setMessage(COPY_FAILED);
    const field = document.querySelector("#wallet-menu .wallet-address-full");
    if (!field) return;
    field.value = address;
    field.classList.add("revealed");
    field.focus();
    field.select();
  }
  async function copyAddress(dx, button) {
    const address = resolveIdentity(dx).address;
    if (!address) return;
    if (typeof navigator.clipboard?.writeText !== "function") {
      revealFullAddress(address);
      return;
    }
    try {
      await navigator.clipboard.writeText(address);
    } catch {
      revealFullAddress(address);
      return;
    }
    button.classList.add("copied");
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => button.classList.remove("copied"), COPY_MS);
  }
  function render(dx) {
    const menu = document.getElementById("wallet-menu");
    if (!menu) return;
    const identity = resolveIdentity(dx);
    const state = stateFrom(dx, identity);
    const trigger = document.getElementById("wallet-btn");
    trigger?.classList.toggle("muted", state === "no-provider");
    menu.replaceChildren();
    if (state === "no-provider") {
      paintChip(trigger, null);
      menu.append(
        buildNode("p", "wallet-message", "No Ethereum wallet was detected in this browser. Install one to connect.")
      );
      return;
    }
    paintChip(trigger, state === "connected" ? identity.address : null);
    if (state === "connected") {
      const addressRow = buildNode("div", "wallet-address-row", "");
      addressRow.append(buildNode("span", "wallet-address", shortenAddress(identity.address)));
      const copy = buildNode("button", "wallet-copy", "COPY");
      copy.type = "button";
      copy.append(buildNode("span", "wallet-copied", "COPIED"));
      copy.addEventListener("click", () => copyAddress(dx, copy));
      addressRow.append(copy);
      const full = buildNode("input", "wallet-address-full", "");
      full.type = "text";
      full.readOnly = true;
      addressRow.append(full);
      menu.append(addressRow);
    } else {
      menu.append(buildMenuRow("Connect wallet", "wallet-connect", () => startConnect(dx)));
    }
    const settingsRow = buildSettingsRow(dx);
    if (settingsRow) menu.append(settingsRow);
    if (state === "connected") menu.append(buildMenuRow("Disconnect", "wallet-disconnect", () => disconnectWallet(dx)));
    menu.append(buildNode("p", "wallet-message wallet-alert", ""));
  }
  function acceptLive(dx, live) {
    if (disposed) return;
    if (port.acceptLiveIdentity(dx, live?.address, live?.chainId)) render(dx);
  }
  const CONNECT_GUARD_MS = 3e4;
  const CONNECT_WAITING = "Your wallet has not answered yet \u2014 check your wallet, then try again.";
  const COPY_MS = 1500;
  const COPY_FAILED = "Could not reach the clipboard. Select the full address below and copy it.";
  let copyTimer = null;
  let inFlight = false;
  let guardTimer = null;
  let connectToken = 0;
  let unsettledConnects = 0;
  let liveSuppressed = false;
  let disposed = false;
  function setMessage(text) {
    const node = document.querySelector("#wallet-menu .wallet-alert");
    if (node && text !== null) node.textContent = text;
  }
  function releaseConnectGuard() {
    inFlight = false;
    clearTimeout(guardTimer);
    guardTimer = null;
    document.getElementById("wallet-connect")?.removeAttribute("disabled");
  }
  function startConnect(dx) {
    if (inFlight) return;
    const wallet = dx?.getPlugin?.("wallet");
    if (typeof wallet?.connect !== "function") return;
    setMessage(unsettledConnects > 0 && resolveState(dx) !== "connected" ? CONNECT_WAITING : "");
    liveSuppressed = false;
    inFlight = true;
    const token = ++connectToken;
    unsettledConnects += 1;
    document.getElementById("wallet-connect")?.setAttribute("disabled", "");
    guardTimer = setTimeout(() => {
      releaseConnectGuard();
      setMessage(CONNECT_WAITING);
    }, CONNECT_GUARD_MS);
    new Promise((resolve) => resolve(wallet.connect())).then((live) => acceptLive(dx, live)).catch((err) => setMessage(describeError(err))).finally(() => {
      unsettledConnects -= 1;
      if (token === connectToken) releaseConnectGuard();
    });
  }
  function reArm(dx) {
    if (liveSuppressed || resolveState(dx) === "no-provider" || !resolveIdentity(dx).address) return;
    const live = dx?.getPlugin?.("wallet")?.getState?.();
    if (live?.connected && live.address) return;
    startConnect(dx);
  }
  function disconnectWallet(dx) {
    port.clearIdentity();
    liveSuppressed = true;
    render(dx);
    new Promise((resolve) => resolve(dx?.getPlugin?.("wallet")?.disconnect?.())).catch(() => void 0);
  }
  function wireTrigger(dx) {
    const trigger = document.getElementById("wallet-btn");
    if (!trigger) return () => void 0;
    const onClick = () => {
      if (document.getElementById("wallet-panel")?.classList.contains("open")) {
        setMessage(unsettledConnects > 0 && resolveState(dx) !== "connected" ? CONNECT_WAITING : "");
        document.querySelector("#wallet-menu .wallet-address-full")?.classList.remove("revealed");
        reArm(dx);
        return;
      }
      releaseConnectGuard();
    };
    trigger.addEventListener("click", onClick);
    return () => trigger.removeEventListener("click", onClick);
  }
  function wireMenuContainment() {
    const menu = document.getElementById("wallet-menu");
    if (!menu) return () => void 0;
    const onClick = (e) => e.stopPropagation();
    menu.addEventListener("click", onClick);
    return () => menu.removeEventListener("click", onClick);
  }
  function init(dx) {
    if (!dx) return () => void 0;
    disposed = false;
    const unsubscribers = [port.init(dx, () => render(dx))];
    render(dx);
    const onLive = (live) => acceptLive(dx, live);
    const stateUnsub = dx.getPlugin?.("wallet")?.onStateChange?.((live) => {
      if (live?.connected) onLive(live);
    });
    if (typeof stateUnsub === "function") unsubscribers.push(stateUnsub);
    const handlers = { connected: onLive, changed: onLive, disconnected: () => void 0 };
    for (const [event, handler] of Object.entries(handlers)) {
      const listener = dx.events?.on?.(`dx:plugin:wallet:${event}`, handler);
      if (listener?.off) unsubscribers.push(() => listener.off());
    }
    unsubscribers.push(wireTrigger(dx));
    unsubscribers.push(wireMenuContainment());
    return function cleanup() {
      disposed = true;
      releaseConnectGuard();
      clearTimeout(copyTimer);
      copyTimer = null;
      document.getElementById("wallet-menu")?.replaceChildren();
      for (const unsubscribe of unsubscribers) unsubscribe();
      unsubscribers.length = 0;
    };
  }
  window.DnznWallet = {
    init,
    shortenAddress,
    describeError,
    resolveState
  };
})();
