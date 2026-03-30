// CIC dapp.js — DxKit lifecycle glue only.
// All domain logic lives in cic.js, loaded dynamically on first mount.

let cicLoaded = false;
let cicCleanup: (() => void) | null = null;
let cicContainer: HTMLElement | null = null;

window.addEventListener('dx:mount', async (e) => {
  if (e.detail.id !== 'cic') return;

  const container = e.detail.container;
  const path = e.detail.path;
  cicContainer = container;

  // Fetch and inject HTML template
  const res = await fetch('dapps/cic/template.html');
  container.innerHTML = await res.text();

  // Load cic.js on first mount (it stays cached after)
  if (!cicLoaded) {
    await new Promise<void>((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'dapps/cic/cic.js';
      script.onload = () => resolve();
      script.onerror = reject;
      document.head.appendChild(script);
    });
    cicLoaded = true;
  }

  // Determine if report mode from sub-path (strip query string and trailing slash)
  const subPath = path.replace('/tools/cic', '').split('?')[0].replace(/^\//, '').replace(/\/$/, '');
  const isReport = subPath === 'report';

  // Initialize CIC domain logic (exported as window.CIC)
  if (window.CIC?.init) {
    cicCleanup = window.CIC.init(container, isReport);
  }
});

window.addEventListener('dx:unmount', (e) => {
  if (e.detail.id !== 'cic') return;
  if (cicCleanup) {
    cicCleanup();
    cicCleanup = null;
  }
  if (cicContainer) {
    cicContainer.innerHTML = '';
    cicContainer = null;
  }
});
