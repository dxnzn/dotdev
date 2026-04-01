let cleanup = null;

window.addEventListener('dx:mount', async (e) => {
  if (e.detail.id !== 'support') return;

  const container = e.detail.container;

  cleanup = () => {
    container.innerHTML = '';
  };
});

window.addEventListener('dx:unmount', (e) => {
  if (e.detail.id !== 'support') return;
  cleanup?.();
  cleanup = null;
});
