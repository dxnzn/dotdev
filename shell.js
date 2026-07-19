const SCHEME_COLORS = {
  "zorgz-156": "#ff6060",
  "zorgz-2625": "#00ffff",
  "zorgz-4065": "#808080"
};
const DARK_BG = {
  "zorgz-156": "#0e0e0e",
  "zorgz-2625": "#0e0e0e",
  "zorgz-4065": "#000000"
};
function initShellChrome() {
  const dx = window.__DXKIT__;
  if (!dx) return;
  const theme = dx.getPlugin("theme");
  const manifests = dx.getEnabledManifests();
  renderHeader(dx, manifests);
  renderFooter();
  wireDropdowns();
  wireShareButton();
  wireThemePanel(dx, theme);
  wireNavigation(dx);
  updateThemeExtras(theme.getTheme(), theme.getResolvedMode());
}
function renderHeader(_dx, manifests) {
  const headerEl = document.getElementById("shell-header");
  if (!headerEl) return;
  const groups = {};
  for (const m of manifests) {
    if (m.nav.hidden) continue;
    const group = m.nav.group || "other";
    if (!groups[group]) groups[group] = [];
    groups[group].push(m);
  }
  for (const g of Object.values(groups)) {
    g.sort((a, b) => (a.nav.order ?? 0) - (b.nav.order ?? 0));
  }
  let navHTML = "";
  const groupOrder = ["main", "tools"];
  const groupLabels = { main: "Navigation", tools: "Tools" };
  for (let i = 0; i < groupOrder.length; i++) {
    const g = groupOrder[i];
    const items = groups[g];
    if (!items || items.length === 0) continue;
    if (i > 0) navHTML += '<hr class="app-dropdown-divider">';
    navHTML += `<div class="app-dropdown-section">${groupLabels[g] || g}</div>`;
    for (const m of items) {
      const href = `#${m.route}`;
      navHTML += `<a href="${href}" data-route="${m.route}">${m.nav.label}</a>`;
    }
  }
  headerEl.className = "anim-in";
  headerEl.innerHTML = `
    <div class="app-dropdown" id="app-dropdown">
      <button class="app-dropdown-trigger" id="app-trigger" title="Menu">
        <img src="assets/zorgz-2625.svg" alt="" class="title-icon">
        <h1>DNZN // DEV</h1>
      </button>
      <div class="app-dropdown-menu" id="app-menu">
        ${navHTML}
      </div>
    </div>
    <div class="header-actions">
      <button class="share-btn" id="share-btn" title="Copy share link">
        <svg class="share-icon" viewBox="0 0 24 24"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
        <span class="share-copied">LINK COPIED</span>
      </button>
      <div class="theme-panel" id="theme-panel">
        <button class="theme-panel-trigger" id="theme-panel-trigger" title="Theme settings">
          <svg viewBox="0 0 24 24"><path d="M8 2h8l2 4H6L8 2z"/><rect x="4" y="6" width="16" height="10" rx="2"/><circle id="scheme-eye-l" cx="9" cy="11" r="2"/><circle id="scheme-eye-r" cx="15" cy="11" r="2"/><path d="M6 16l-2 6h4l1-3h6l1 3h4l-2-6"/></svg>
        </button>
        <div class="theme-panel-menu" id="theme-panel-menu">
          <div class="theme-panel-section">Mode</div>
          <button data-mode="system">SYS \u2014 System</button>
          <button data-mode="light">LTE \u2014 Light</button>
          <button data-mode="dark">DRK \u2014 Dark</button>
          <hr class="theme-panel-divider">
          <div class="theme-panel-section">Theme</div>
          <button data-scheme="zorgz-2625"><span class="theme-panel-swatch" style="background:#00ffff"></span>zorgz-2625</button>
          <button data-scheme="zorgz-156"><span class="theme-panel-swatch" style="background:#ff6060"></span>zorgz-156</button>
          <button data-scheme="zorgz-4065"><span class="theme-panel-swatch" style="background:#808080"></span>zorgz-4065</button>
        </div>
      </div>
      <button class="wallet-btn" id="wallet-btn" title="Connect wallet" disabled>
        <svg viewBox="0 0 24 24"><rect x="2" y="6" width="20" height="14" rx="2"/><path d="M2 10h20"/><rect x="15" y="13" width="4" height="3" rx="1"/></svg>
      </button>
    </div>`;
}
function renderFooter() {
  const footerEl = document.getElementById("shell-footer");
  if (!footerEl) return;
  footerEl.innerHTML = `by <strong>Denizen.</strong> // dnzn.wei`;
}
function wireDropdowns() {
  const appTrigger = document.getElementById("app-trigger");
  const appDropdown = document.getElementById("app-dropdown");
  const themePanel = document.getElementById("theme-panel");
  const themeTrigger = document.getElementById("theme-panel-trigger");
  if (appTrigger && appDropdown) {
    appTrigger.addEventListener("click", (e) => {
      e.stopPropagation();
      if (themePanel) themePanel.classList.remove("open");
      appDropdown.classList.toggle("open");
    });
  }
  if (themeTrigger && themePanel) {
    themeTrigger.addEventListener("click", (e) => {
      e.stopPropagation();
      if (appDropdown) appDropdown.classList.remove("open");
      themePanel.classList.toggle("open");
    });
  }
  document.addEventListener("click", () => {
    if (appDropdown) appDropdown.classList.remove("open");
    if (themePanel) themePanel.classList.remove("open");
  });
}
function wireShareButton() {
  const shareBtn = document.getElementById("share-btn");
  if (!shareBtn) return;
  shareBtn.addEventListener("click", function() {
    navigator.clipboard.writeText(window.location.href).then(() => {
      this.classList.add("copied");
      setTimeout(() => this.classList.remove("copied"), 1500);
    });
  });
}
function wireThemePanel(dx, theme) {
  if (!theme) return;
  document.querySelectorAll("#theme-panel-menu button[data-mode]").forEach((btn) => {
    btn.addEventListener("click", () => {
      theme.setMode(btn.dataset.mode);
    });
  });
  document.querySelectorAll("#theme-panel-menu button[data-scheme]").forEach((btn) => {
    btn.addEventListener("click", () => {
      theme.setTheme(btn.dataset.scheme);
    });
  });
  dx.events.on("dx:plugin:theme:changed", () => {
    updateThemePanelState(theme);
  });
  updateThemePanelState(theme);
}
function updateThemePanelState(theme) {
  if (!theme) return;
  const currentMode = theme.getMode();
  const currentTheme = theme.getTheme();
  document.querySelectorAll("#theme-panel-menu button[data-mode]").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.mode === currentMode);
  });
  document.querySelectorAll("#theme-panel-menu button[data-scheme]").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.scheme === currentTheme);
  });
}
function updateThemeExtras(currentTheme, resolved) {
  const isLight = resolved === "light";
  const eyeColor = SCHEME_COLORS[currentTheme] || "#00ffff";
  const eyeL = document.getElementById("scheme-eye-l");
  const eyeR = document.getElementById("scheme-eye-r");
  if (eyeL) eyeL.setAttribute("fill", eyeColor);
  if (eyeR) eyeR.setAttribute("fill", eyeColor);
  const metaTheme = document.querySelector('meta[name="theme-color"]');
  if (metaTheme) {
    metaTheme.setAttribute("content", isLight ? "#ffffff" : DARK_BG[currentTheme] || "#0e0e0e");
  }
  const favicon = document.querySelector('link[rel="icon"]');
  if (favicon) {
    favicon.setAttribute("href", `assets/${currentTheme}.svg`);
  }
  const titleIcon = document.querySelector(".title-icon");
  if (titleIcon) {
    titleIcon.src = `assets/${currentTheme}.svg`;
  }
}
const DAPP_TITLES = {
  about: "DNZN // DEV",
  projects: "DNZN // PROJECTS",
  support: "DNZN // SUPPORT",
  cic: "DNZN // CIC",
  tpl: "DNZN // TPL"
};
function wireNavigation(dx) {
  function updateActiveNav() {
    const currentPath = dx.router.getCurrentPath();
    document.querySelectorAll("#app-menu a[data-route]").forEach((link) => {
      const route = link.dataset.route;
      const isActive = currentPath === route || currentPath.startsWith(`${route}/`);
      link.classList.toggle("active", isActive);
    });
    const manifests = dx.getEnabledManifests();
    let matched = null;
    for (const m of manifests) {
      if (currentPath === m.route || currentPath.startsWith(`${m.route}/`)) {
        if (!matched || m.route.length > matched.route.length) matched = m;
      }
    }
    const title = matched ? DAPP_TITLES[matched.id] || "DNZN // DEV" : "DNZN // DEV";
    const h1 = document.querySelector(".app-dropdown-trigger h1");
    if (h1) h1.textContent = title;
    document.title = title;
    const wide = matched ? matched.route.startsWith("/tools/") : false;
    document.documentElement.setAttribute("data-layout", wide ? "wide" : "narrow");
  }
  document.querySelectorAll("#app-menu a[data-route]").forEach((link) => {
    link.addEventListener("click", (e) => {
      e.preventDefault();
      dx.router.navigate(link.dataset.route);
      document.getElementById("app-dropdown")?.classList.remove("open");
    });
  });
  dx.events.on("dx:route:changed", updateActiveNav);
  updateActiveNav();
}
