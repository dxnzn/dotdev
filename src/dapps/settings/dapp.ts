// Settings dapp.js — DxKit lifecycle glue only.
// All domain logic lives in fields.js/sync.js/settings.js, loaded via manifest dependencies.

let settingsCleanup: (() => void) | null = null;
let settingsContainer: HTMLElement | null = null;

window.addEventListener('dx:mount', async (e) => {
  if (e.detail.id !== 'settings') return;

  const container = e.detail.container;
  settingsContainer = container;

  if (window.DnznSettingsDapp?.init) {
    settingsCleanup = window.DnznSettingsDapp.init(container);
  }
});

window.addEventListener('dx:unmount', (e) => {
  if (e.detail.id !== 'settings') return;
  if (settingsCleanup) {
    settingsCleanup();
    settingsCleanup = null;
  }
  if (settingsContainer) {
    settingsContainer.innerHTML = '';
    settingsContainer = null;
  }
});
