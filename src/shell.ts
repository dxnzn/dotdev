// Shell chrome: header (nav dropdown, theme panel, share, wallet) + footer.
// Renders into #shell-header and #shell-footer after DxKit shell.init().
// Wires behaviors using window.__DXKIT__ context.

const SCHEME_COLORS = {
  'zorgz-156': '#ff6060',
  'zorgz-2625': '#00ffff',
  'zorgz-4065': '#808080',
};

const DARK_BG = {
  'zorgz-156': '#0e0e0e',
  'zorgz-2625': '#0e0e0e',
  'zorgz-4065': '#000000',
};

// biome-ignore lint/correctness/noUnusedVariables: called globally from main.js via <script> tag
function initShellChrome() {
  const dx = window.__DXKIT__;
  if (!dx) return;

  const theme = dx.getPlugin('theme');
  const manifests = dx.getEnabledManifests();

  renderHeader(dx, manifests);
  renderFooter();
  wireDropdowns();
  wireShareButton();
  wireThemePanel(dx, theme);
  wireSettingsButton(dx);
  window.DnznWallet?.init(dx);
  wireNavigation(dx);

  // SET-09 / review finding A1: DxKit rebuilds its router and emits these on
  // enableDapp/disableDapp, but nothing re-renders the static nav dropdown on its own.
  // refreshNavMenu replaces only #app-menu's markup — never renderHeader/wireDropdowns/
  // wireNavigation, each of which would leak a listener or destroy unrelated chrome (see
  // refreshNavMenu's own comment below).
  dx.events.on('dx:dapp:enabled', () => refreshNavMenu(dx));
  dx.events.on('dx:dapp:disabled', () => refreshNavMenu(dx));

  // onApply fires before chrome exists — apply extras now that DOM is ready
  updateThemeExtras(theme.getTheme(), theme.getResolvedMode());
}

// Extracted (SET-09) so refreshNavMenu can rebuild just the dropdown's markup without
// re-running renderHeader, which would destroy .header-actions and everything wired to it.
function buildNavHTML(manifests) {
  // Group manifests by nav.group
  const groups = {};
  for (const m of manifests) {
    if (m.nav.hidden) continue;
    const group = m.nav.group || 'other';
    if (!groups[group]) groups[group] = [];
    groups[group].push(m);
  }

  // Sort within each group by nav.order
  for (const g of Object.values(groups)) {
    g.sort((a, b) => (a.nav.order ?? 0) - (b.nav.order ?? 0));
  }

  // Build nav sections
  let navHTML = '';
  const groupOrder = ['main', 'tools'];
  const groupLabels = { main: 'Navigation', tools: 'Tools' };

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

  return navHTML;
}

function renderHeader(_dx, manifests) {
  const headerEl = document.getElementById('shell-header');
  if (!headerEl) return;

  const navHTML = buildNavHTML(manifests);

  headerEl.className = 'anim-in';
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
          <button data-mode="system">SYS — System</button>
          <button data-mode="light">LTE — Light</button>
          <button data-mode="dark">DRK — Dark</button>
          <hr class="theme-panel-divider">
          <div class="theme-panel-section">Theme</div>
          <button data-scheme="zorgz-2625"><span class="theme-panel-swatch" style="background:#00ffff"></span>zorgz-2625</button>
          <button data-scheme="zorgz-156"><span class="theme-panel-swatch" style="background:#ff6060"></span>zorgz-156</button>
          <button data-scheme="zorgz-4065"><span class="theme-panel-swatch" style="background:#808080"></span>zorgz-4065</button>
        </div>
      </div>
      <button class="settings-btn" id="settings-btn" title="Settings">
        <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
      </button>
      <div class="wallet-panel" id="wallet-panel">
        <button class="wallet-btn" id="wallet-btn" title="Wallet">
          <svg viewBox="0 0 24 24"><rect x="2" y="6" width="20" height="14" rx="2"/><path d="M2 10h20"/><rect x="15" y="13" width="4" height="3" rx="1"/></svg>
        </button>
        <div class="wallet-menu" id="wallet-menu"></div>
      </div>
    </div>`;
}

function renderFooter() {
  const footerEl = document.getElementById('shell-footer');
  if (!footerEl) return;
  footerEl.innerHTML = `by <strong>Denizen.</strong> // dnzn.wei`;
}

// The three header dropdowns, resolved on every call rather than captured once: renderHeader
// rebuilds the header's innerHTML, so a cached list would hold detached nodes.
function dropdownEntries() {
  return [
    { wrapper: document.getElementById('app-dropdown'), trigger: document.getElementById('app-trigger') },
    { wrapper: document.getElementById('theme-panel'), trigger: document.getElementById('theme-panel-trigger') },
    { wrapper: document.getElementById('wallet-panel'), trigger: document.getElementById('wallet-btn') },
  ].filter((entry) => entry.wrapper && entry.trigger);
}

// The one closer every header control uses, so aria-expanded cannot drift from the .open
// class whichever control closed the menu. src/shell-wallet.ts deliberately does NOT call
// this — shell.js and shell-wallet.js are separately transpiled with no import path between
// them, so it closes only the wrapper it owns, with the same two mutations.
function closeAllDropdowns() {
  for (const entry of dropdownEntries()) {
    entry.wrapper.classList.remove('open');
    entry.trigger.setAttribute('aria-expanded', 'false');
  }
}

function wireDropdowns() {
  for (const entry of dropdownEntries()) {
    const { wrapper, trigger } = entry;
    trigger.setAttribute('aria-haspopup', 'true');
    trigger.setAttribute('aria-expanded', 'false');

    trigger.addEventListener('click', (e) => {
      // Without stopPropagation the document handler below immediately re-closes this.
      e.stopPropagation();
      // Read the class before closing, so the trigger still toggles its own panel shut
      // rather than reopening it.
      const wasOpen = wrapper.classList.contains('open');
      closeAllDropdowns();
      if (!wasOpen) {
        wrapper.classList.add('open');
        trigger.setAttribute('aria-expanded', 'true');
      }
    });
  }

  // Exactly one document listener per type, added once. There is no removal path, so a
  // second wireDropdowns() call would leak one per invocation — see refreshNavMenu's comment.
  document.addEventListener('click', () => {
    closeAllDropdowns();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const open = dropdownEntries().find((entry) => entry.wrapper.classList.contains('open'));
    if (!open) return;
    closeAllDropdowns();
    open.trigger.focus();
  });
}

function wireShareButton() {
  const shareBtn = document.getElementById('share-btn');
  if (!shareBtn) return;

  shareBtn.addEventListener('click', function () {
    navigator.clipboard.writeText(window.location.href).then(() => {
      this.classList.add('copied');
      setTimeout(() => this.classList.remove('copied'), 1500);
    });
  });
}

function wireSettingsButton(dx) {
  const settingsBtn = document.getElementById('settings-btn');
  if (!settingsBtn) return;

  settingsBtn.addEventListener('click', () => {
    closeAllDropdowns();
    dx.router.navigate('/settings');
  });
}

function wireThemePanel(dx, theme) {
  if (!theme) return;

  // Mode buttons
  document.querySelectorAll('#theme-panel-menu button[data-mode]').forEach((btn) => {
    btn.addEventListener('click', () => {
      theme.setMode(btn.dataset.mode);
    });
  });

  // Scheme buttons
  document.querySelectorAll('#theme-panel-menu button[data-scheme]').forEach((btn) => {
    btn.addEventListener('click', () => {
      theme.setTheme(btn.dataset.scheme);
    });
  });

  // React to theme changes (extras handled by onApply hook)
  dx.events.on('dx:plugin:theme:changed', () => {
    updateThemePanelState(theme);
  });

  // Set initial active states
  updateThemePanelState(theme);
}

function updateThemePanelState(theme) {
  if (!theme) return;

  const currentMode = theme.getMode();
  const currentTheme = theme.getTheme();

  document.querySelectorAll('#theme-panel-menu button[data-mode]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.mode === currentMode);
  });

  document.querySelectorAll('#theme-panel-menu button[data-scheme]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.scheme === currentTheme);
  });
}

function updateThemeExtras(currentTheme: string, resolved: 'light' | 'dark') {
  const isLight = resolved === 'light';

  // Robot eye color
  const eyeColor = SCHEME_COLORS[currentTheme] || '#00ffff';
  const eyeL = document.getElementById('scheme-eye-l');
  const eyeR = document.getElementById('scheme-eye-r');
  if (eyeL) eyeL.setAttribute('fill', eyeColor);
  if (eyeR) eyeR.setAttribute('fill', eyeColor);

  // Meta theme-color
  const metaTheme = document.querySelector('meta[name="theme-color"]');
  if (metaTheme) {
    metaTheme.setAttribute('content', isLight ? '#ffffff' : DARK_BG[currentTheme] || '#0e0e0e');
  }

  // Favicon swap
  const favicon = document.querySelector('link[rel="icon"]');
  if (favicon) {
    favicon.setAttribute('href', `assets/${currentTheme}.svg`);
  }

  // Title icon swap via CSS content: url() already handles this via theme.css
  // but we need to update the src for the initial load
  const titleIcon = document.querySelector('.title-icon');
  if (titleIcon) {
    titleIcon.src = `assets/${currentTheme}.svg`;
  }
}

// Map manifest IDs to display titles
const DAPP_TITLES: Record<string, string> = {
  about: 'DNZN // DEV',
  projects: 'DNZN // PROJECTS',
  support: 'DNZN // SUPPORT',
  cic: 'DNZN // CIC',
  decode: 'DNZN // DECODE',
  tpl: 'DNZN // TPL',
  settings: 'DNZN // SETTINGS',
};

// Hoisted out of wireNavigation (SET-09) so refreshNavMenu can re-sync active state
// against a freshly rebuilt menu without adding a second dx:route:changed subscription.
function updateActiveNav(dx) {
  const currentPath = dx.router.getCurrentPath();
  document.querySelectorAll('#app-menu a[data-route]').forEach((link) => {
    const route = link.dataset.route;
    const isActive = currentPath === route || currentPath.startsWith(`${route}/`);
    link.classList.toggle('active', isActive);
  });

  document.getElementById('settings-btn')?.classList.toggle('active', currentPath === '/settings');

  // Update header title and page title based on active dapp
  const manifests = dx.getEnabledManifests();
  let matched = null;
  // Longest prefix match
  for (const m of manifests) {
    if (currentPath === m.route || currentPath.startsWith(`${m.route}/`)) {
      if (!matched || m.route.length > matched.route.length) matched = m;
    }
  }
  const title = matched ? DAPP_TITLES[matched.id] || 'DNZN // DEV' : 'DNZN // DEV';
  const h1 = document.querySelector('.app-dropdown-trigger h1');
  if (h1) h1.textContent = title;
  document.title = title;

  // Keep layout width in sync with the route (see index.html for initial paint).
  const wide = matched ? matched.route.startsWith('/tools/') : false;
  document.documentElement.setAttribute('data-layout', wide ? 'wide' : 'narrow');
}

// Extracted (SET-09) so refreshNavMenu can rewire only the links inside a freshly
// rebuilt #app-menu, without re-running wireNavigation and adding a second
// dx:route:changed subscription.
function wireNavLinks(dx) {
  document.querySelectorAll('#app-menu a[data-route]').forEach((link) => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      dx.router.navigate(link.dataset.route);
      document.getElementById('app-dropdown')?.classList.remove('open');
    });
  });
}

function wireNavigation(dx) {
  wireNavLinks(dx);
  dx.events.on('dx:route:changed', () => updateActiveNav(dx));
  updateActiveNav(dx);
}

// SET-09 / review finding A1: DxKit's enableDapp/disableDapp emit dx:dapp:enabled /
// dx:dapp:disabled but never touch the shell's own (static) nav markup. This is the
// fix — subscribed once from initShellChrome, called on both events.
//
// Deliberately does NOT call:
//   - renderHeader: it replaces the whole header's innerHTML, including
//     .header-actions, destroying the share/theme/settings/wallet buttons and every
//     handler wired onto them once at init.
//   - wireDropdowns: it adds a document-level click listener with no removal path —
//     calling it again would leak one listener per toggle.
//   - wireNavigation: it would add a second dx:route:changed subscription per toggle.
// The only handlers re-bound here are on #app-menu's own anchors, which are discarded
// with the markup they were attached to, so re-binding them leaks nothing.
//
// disableDapp may call router.navigate('/') (when the current route belongs to the
// dapp being disabled) BEFORE emitting dx:dapp:disabled, so a dx:route:changed handler
// would run updateActiveNav against the still-stale menu. Calling updateActiveNav again
// here, after the markup is replaced, is what actually keeps it in sync — not the route
// event.
function refreshNavMenu(dx) {
  const appMenu = document.getElementById('app-menu');
  if (!appMenu) return;
  appMenu.innerHTML = buildNavHTML(dx.getEnabledManifests());
  wireNavLinks(dx);
  updateActiveNav(dx);
}
