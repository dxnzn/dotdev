let cleanup = null;

window.addEventListener('dx:mount', async (e) => {
  if (e.detail.id !== 'tpl') return;

  const container = e.detail.container;

  // Tab switching
  const tabButtons = container.querySelectorAll('.tabs button');
  const tabHandler = (btn) => () => {
    const tab = btn.dataset.tab;
    container.querySelectorAll('.tabs button').forEach((b) => {
      b.classList.remove('active');
    });
    btn.classList.add('active');
    container.querySelectorAll('.tab-content').forEach((c) => {
      c.classList.remove('active');
    });
    container.querySelector(`#tab-${tab}`)?.classList.add('active');
  };

  const listeners = [];
  tabButtons.forEach((btn) => {
    const handler = tabHandler(btn);
    btn.addEventListener('click', handler);
    listeners.push([btn, handler]);
  });

  cleanup = () => {
    listeners.forEach(([el, fn]) => {
      el.removeEventListener('click', fn);
    });
    container.innerHTML = '';
  };
});

window.addEventListener('dx:unmount', (e) => {
  if (e.detail.id !== 'tpl') return;
  cleanup?.();
  cleanup = null;
});
