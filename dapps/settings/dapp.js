let settingsCleanup = null;
let settingsContainer = null;
window.addEventListener("dx:mount", async (e) => {
  if (e.detail.id !== "settings") return;
  const container = e.detail.container;
  settingsContainer = container;
  if (window.DnznSettingsDapp?.init) {
    settingsCleanup = window.DnznSettingsDapp.init(container);
  }
});
window.addEventListener("dx:unmount", (e) => {
  if (e.detail.id !== "settings") return;
  if (settingsCleanup) {
    settingsCleanup();
    settingsCleanup = null;
  }
  if (settingsContainer) {
    settingsContainer.innerHTML = "";
    settingsContainer = null;
  }
});
