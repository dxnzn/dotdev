(() => {
  const CONFIRM_MS = 1500;
  let activeBuild = null;
  let activeOptions;
  let confirmButton = null;
  let confirmTimer = null;
  async function writeClipboard(text) {
    if (typeof navigator.clipboard?.writeText !== "function") return false;
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  }
  function flashConfirmed(button) {
    if (confirmTimer !== null) clearTimeout(confirmTimer);
    confirmButton = button;
    button.classList.add("copied");
    confirmTimer = setTimeout(() => {
      button.classList.remove("copied");
      confirmTimer = null;
      confirmButton = null;
    }, CONFIRM_MS);
  }
  function clearPendingConfirm() {
    if (confirmTimer !== null) clearTimeout(confirmTimer);
    confirmTimer = null;
    confirmButton?.classList.remove("copied");
    confirmButton = null;
  }
  function onShareCapture(e) {
    const target = e.target;
    const btn = target?.closest?.("#share-btn");
    if (!btn || !activeBuild) return;
    e.stopImmediatePropagation();
    const build = activeBuild;
    const options = activeOptions;
    void (async () => {
      let url;
      try {
        const built = await build();
        url = built ?? window.location.href;
      } catch {
        url = window.location.href;
      }
      const wrote = await writeClipboard(url);
      if (!wrote) {
        options?.onCopyFailed?.(url);
        return;
      }
      flashConfirmed(btn);
    })();
  }
  function register(build, options) {
    if (!activeBuild) {
      document.addEventListener("click", onShareCapture, true);
    }
    activeBuild = build;
    activeOptions = options;
    let released = false;
    return function unregister() {
      if (released) return;
      released = true;
      if (activeBuild !== build) return;
      activeBuild = null;
      activeOptions = void 0;
      clearPendingConfirm();
      document.removeEventListener("click", onShareCapture, true);
    };
  }
  function activeTarget() {
    return activeBuild;
  }
  window.DnznShareTarget = { register, activeTarget };
})();
