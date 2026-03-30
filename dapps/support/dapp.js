let cleanup = null;
window.addEventListener("dx:mount", async (e) => {
  if (e.detail.id !== "support") return;
  const container = e.detail.container;
  const res = await fetch("dapps/support/template.html");
  container.innerHTML = await res.text();
  cleanup = () => {
    container.innerHTML = "";
  };
});
window.addEventListener("dx:unmount", (e) => {
  if (e.detail.id !== "support") return;
  cleanup?.();
  cleanup = null;
});
