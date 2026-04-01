let cicCleanup = null;
let cicContainer = null;
window.addEventListener("dx:mount", async (e) => {
  if (e.detail.id !== "cic") return;
  const container = e.detail.container;
  const path = e.detail.path;
  cicContainer = container;
  const subPath = path.replace("/tools/cic", "").split("?")[0].replace(/^\//, "").replace(/\/$/, "");
  const isReport = subPath === "report";
  if (window.CIC?.init) {
    cicCleanup = window.CIC.init(container, isReport);
  }
});
window.addEventListener("dx:unmount", (e) => {
  if (e.detail.id !== "cic") return;
  if (cicCleanup) {
    cicCleanup();
    cicCleanup = null;
  }
  if (cicContainer) {
    cicContainer.innerHTML = "";
    cicContainer = null;
  }
});
