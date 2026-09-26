let decodeCleanup = null;
let decodeContainer = null;
window.addEventListener("dx:mount", async (rawEvent) => {
  const e = rawEvent;
  if (e.detail.id !== "decode") return;
  const container = e.detail.container;
  decodeContainer = container;
  if (window.DxDecode?.ui?.init) {
    const query = window.DxDecode.core?.parseDecodeQuery(e.detail.path);
    decodeCleanup = window.DxDecode.ui.init(container, window.__DXKIT__, query);
    window.DxDecode.activeUi = decodeCleanup;
  }
});
window.addEventListener("dx:route:subpath", (rawEvent) => {
  const e = rawEvent;
  if (e.detail.id !== "decode" || !decodeCleanup) return;
  const query = window.DxDecode?.core?.parseDecodeQuery(e.detail.path);
  decodeCleanup.applyQuery(query);
});
window.addEventListener("dx:unmount", (rawEvent) => {
  const e = rawEvent;
  if (e.detail.id !== "decode") return;
  if (decodeCleanup) {
    decodeCleanup();
    decodeCleanup = null;
    if (window.DxDecode) window.DxDecode.activeUi = null;
  }
  if (decodeContainer) {
    decodeContainer.innerHTML = "";
    decodeContainer = null;
  }
});
