<!-- refreshed: 2026-08-19 -->
# Architecture

**Analysis Date:** 2026-08-19

## System Overview

```text
┌──────────────────────────────────────────────────────────────┐
│                    DxKit Shell (main.ts)                     │
│  Creates routing, theme plugin, settings plugin, dapps list  │
├──────────────────┬──────────────────┬───────────────────────┤
│  Theme Plugin    │  Settings Plugin │   Router (hash-mode)  │
│ `src/main.ts:5`  │ `src/main.ts:7`  │   `src/main.ts:16`    │
└────────┬─────────┴────────┬─────────┴──────────┬────────────┘
         │                  │                     │
         ▼                  ▼                     ▼
┌──────────────────────────────────────────────────────────────┐
│              Shell Chrome (shell.ts)                         │
│  Header (nav, theme toggle), footer, navigation wiring      │
│  Scoped DOM mutations: #shell-header, #shell-footer         │
└──────────────────┬───────────────────────────────────────────┘
         │
         ▼
┌──────────────────────────────────────────────────────────────┐
│  Dapps Layer (dx:mount / dx:unmount lifecycle)              │
│                                                               │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐       │
│  │About (static)│  │Projects      │  │Support       │       │
│  │`src/dapps/   │  │(static)      │  │(static)      │       │
│  │ about/`      │  │`src/dapps/   │  │`src/dapps/   │       │
│  └──────────────┘  └──────────────┘  └──────────────┘       │
│                                                               │
│  ┌──────────────┐  ┌──────────────┐                         │
│  │CIC           │  │TPL           │                         │
│  │(interactive) │  │(interactive) │                         │
│  │`src/dapps/   │  │`src/dapps/   │                         │
│  │ cic/`        │  │ tpl/`        │                         │
│  └──────────────┘  └──────────────┘                         │
└──────────────────────────────────────────────────────────────┘
```

## Component Responsibilities

| Component | Responsibility | File |
|-----------|----------------|------|
| Shell Creation | Initialize DxKit with plugins and dapps | `src/main.ts` |
| Chrome Rendering | Render header nav, footer, theme panel | `src/shell.ts` |
| Theme Management | Persist theme/mode, apply colors, swap icons | `src/shell.ts:198-226` |
| Navigation | Route tracking, active state, title sync | `src/shell.ts:237-276` |
| Dapp Lifecycle | Mount/unmount event handling | Each `src/dapps/{name}/dapp.ts` |
| HTML Templates | Static markup and forms | Each `src/dapps/{name}/template.html` |
| Styles | Global + dapp-specific CSS | `src/styles/` + `src/dapps/{name}/style.css` |
| Domain Logic | Calculation, rendering (interactive dapps) | `src/dapps/{name}/{name}.ts` (IIFEs) |

## Pattern Overview

**Overall:** Headless framework orchestration + vanilla TypeScript

**Key Characteristics:**
- **Zero bundler at runtime** — All code loads via IIFE `<script>` tags
- **Hash-based routing** — `#/about`, `#/tools/cic/report`, works on GitHub Pages and IPFS
- **DxKit orchestration** — Framework handles routing, lifecycle, events; app owns no DOM except mounts
- **Template-driven** — HTML in `.html` files, JavaScript wires behavior via DOM queries
- **Namespace isolation** — IIFE wrappers (cic.ts) prevent global pollution
- **Async cleanup** — Init functions return cleanup handlers for proper unmounting

## Layers

**Shell Initialization Layer:**
- Purpose: Create DxKit instance, configure plugins, register dapps
- Location: `src/main.ts`, `src/index.html`
- Contains: Shell config with theme/settings plugins, dapp manifest list
- Depends on: DxKit IIFE, vendor plugins
- Used by: DxKit router to bootstrap the app

**Shell Chrome Layer:**
- Purpose: Render and manage persistent header, footer, navigation
- Location: `src/shell.ts`
- Contains: Navigation rendering from manifests, theme panel, share button, active state tracking
- Depends on: DxKit event bus, theme plugin, manifest metadata
- Used by: HTML page (mounts to #shell-header, #shell-footer)

**Router Layer (DxKit):**
- Purpose: Hash-based routing, dapp lifecycle events
- Location: Inside DxKit IIFE (vendor)
- Contains: Route parsing, dx:mount/dx:unmount event firing, path change tracking
- Depends on: Browser location API
- Used by: Shell (for navigation active state), dapps (lifecycle hooks)

**Dapp Layer:**
- Purpose: Page-level isolation of concerns, lifecycle management
- Location: `src/dapps/{name}/dapp.ts`
- Contains: Mount/unmount event listeners specific to each dapp
- Depends on: DxKit event bus, HTML container, optional domain module
- Used by: Router (fires mount/unmount)

**Domain Logic Layer (Interactive Dapps Only):**
- Purpose: Calculation, state management, rendering, event wiring
- Location: `src/dapps/{name}/{name}.ts` (e.g., `src/dapps/cic/cic.ts`)
- Contains: IIFE-wrapped pure functions (calculate, render) + event wiring (input handlers, theme listeners)
- Depends on: DOM container, CSS custom properties for styling, DxKit event bus
- Used by: Dapp lifecycle handler (`src/dapps/{name}/dapp.ts` calls `window.{NAME}.init()`)

## Data Flow

### Primary Request Path (Page Load / Navigation)

1. **Bootstrap** (`src/index.html`, lines 11-29) — Inline script applies theme from localStorage before CSS loads (FOUC prevention)
2. **Stylesheet Load** (`src/index.html`, lines 33-36) — Global and component styles apply
3. **Vendor Scripts** (`src/index.html`, lines 45-47) — Load DxKit, theme plugin, settings plugin (IIFE scripts)
4. **Shell Script** (`src/index.html:48`) — Load `src/shell.ts` (compiled to shell.js)
5. **Main Script** (`src/index.html:49`) — Load `src/main.ts` (compiled to main.js)
   - Creates shell via `DxKit.createShell()` with config
   - Calls `shell.init()` which fires `dx:mount` for the default route dapp
6. **Shell Initialization** (`src/main.ts:20`) — Calls `initShellChrome()` after init completes
   - `src/shell.ts:18-34` renders header, footer, wires events
7. **Dapp Mount** — DxKit fires `dx:mount` event
   - Dapp listener (`src/dapps/{name}/dapp.ts`) fires
   - For interactive dapps: calls `window.{NAME}.init(container, options)` which returns cleanup function
8. **DOM Population** — Dapp listener or domain module populates container via innerHTML

### Route Navigation Flow

1. User clicks nav link in header
2. `wireNavigation()` (`src/shell.ts:266-269`) prevents default, calls `dx.router.navigate(route)`
3. Router fires `dx:route:changed` event
4. `updateActiveNav()` callback updates active states, syncs layout width
5. Router fires `dx:unmount` for previous dapp
   - Cleanup function runs (removes listeners, cancels animations, disconnects observers)
6. Router loads new dapp's manifest dependencies (if any) then fires `dx:mount`
7. New dapp initializes

### Theme Change Flow

1. User clicks theme/mode button in theme panel
2. `wireThemePanel()` (`src/shell.ts:161-172`) calls `theme.setTheme()` or `theme.setMode()`
3. Theme plugin fires `dx:plugin:theme:changed` event
4. Two handlers fire:
   - `updateThemePanelState()` updates button active states
   - If dapp subscribed (e.g., CIC): `src/dapps/cic/cic.ts:776-782` invalidates CSS cache, redraws chart

### CIC Calculator State Flow (Example Complex Dapp)

1. User types in input field
2. `on(el, 'input', ...)` handler (`src/dapps/cic/cic.ts:613-644`) captures event
3. Value is parsed, formatted, debounced, calls `update()`
4. `getState()` reads all form values from DOM (`src/dapps/cic/cic.ts:527-539`)
5. `calculate(state)` runs pure math (no DOM) → returns result
6. Result renders to DOM: result numbers, formula, overview, chart, table
7. If URL params loaded initially (`src/dapps/cic/cic.ts:439-471`), calculator state syncs

**State Management:**
- Form inputs in DOM (source of truth)
- `getState()` reads current form values on demand
- `lastResult` cached for performance (chart resizing, tab switching)
- URL params for sharing state (parsed on mount, built on share button click)
- Theme colors from CSS custom properties (invalidated on theme change)

## Key Abstractions

**Dapp Manifest:**
- Purpose: Declarative configuration for each page/app
- Examples: `src/dapps/about/manifest.json`, `src/dapps/cic/manifest.json`
- Pattern: JSON with id, route, entry (dapp.js), template (html), dependencies (array of scripts), nav metadata
- Used to: Register dapps with router, build navigation menus, determine layout width

**Lifecycle Cleanup Pattern:**
- Purpose: Ensure proper resource cleanup on unmount
- Pattern: Init function returns closure over listener array
  ```typescript
  // src/dapps/cic/cic.ts:851-870
  return function cleanup() {
    listeners.forEach(([el, event, handler, opts]) => el.removeEventListener(event, handler, opts));
    if (themeUnsub) themeUnsub.off();
    if (routeUnsub) routeUnsub.off();
    if (resizeRAF) cancelAnimationFrame(resizeRAF);
    if (chartRO) chartRO.disconnect();
  };
  ```
- Used by: Dapp lifecycle handler calls cleanup on `dx:unmount`

**IIFE Module Pattern:**
- Purpose: Namespace isolation, private state, public API
- Pattern: `(function() { ... window.{NAME} = { init }; })()`
- Examples: `src/dapps/cic/cic.ts` (exports `window.CIC.init()`)
- Benefit: Multiple dapps don't pollute global namespace, internal functions stay private

**Manifest Dependency Loading:**
- Purpose: Load additional scripts before dapp mount (e.g., domain module)
- Pattern: Dependencies array in manifest → DxKit loads scripts before firing dx:mount
- Example: CIC manifest has `"dependencies": ["dapps/cic/cic.js"]`
- Result: `window.CIC` available when dapp.ts mount handler runs

## Entry Points

**index.html:**
- Location: `src/index.html`
- Triggers: Browser load
- Responsibilities: HTML structure, inline FOUC prevention script, stylesheet and script loading order

**main.ts:**
- Location: `src/main.ts`
- Triggers: Loaded via `<script src="main.js"></script>` in index.html
- Responsibilities: Create shell, configure plugins, register dapps, call init, invoke shell chrome rendering

**shell.ts:**
- Location: `src/shell.ts`
- Triggers: Loaded before main.ts, `initShellChrome()` called from main.ts after shell.init()
- Responsibilities: Render header/footer, wire navigation, theme, share button, event listeners

**Dapp Entry Points (per dapp):**
- Location: `src/dapps/{name}/dapp.ts`
- Triggers: DxKit fires `dx:mount` event when route matches dapp's manifest route
- Responsibilities: Listen for mount/unmount, initialize domain module, manage cleanup

## Architectural Constraints

- **Single-threaded event loop** — All code runs in main thread; long calculations (CIC chart draw) use `requestAnimationFrame` to avoid blocking
- **No global state outside IIFE modules** — Window pollution prevented by IIFE wrappers; only DxKit and explicit modules exported to window
- **Manifest-driven** — Dapps must be registered in `src/main.ts:9-15` and have a manifest file to be routable
- **Template-first** — HTML structure defines DOM; JavaScript queries and mutates (no virtual DOM, no JSX)
- **Layout width sync** — `data-layout` attribute set synchronously before first paint (index.html script) then kept in sync by shell.ts to avoid chart reflow
- **CSS custom properties for theming** — Chart draw reads `--chart-*` colors from computed styles; invalidated on theme change via cache-bust
- **No circular dependencies** — Dapps don't import each other; shell chrome is separate from dapp logic
- **Scoped DOM queries** — All DOM queries in dapp code are scoped to container: `container.querySelector()` not `document.querySelector()`

## Anti-Patterns

### Unnecessary Global State

**What happens:** Code stores state on `window.something` outside of IIFE modules (e.g., `window.currentUser = { ... }`)

**Why it's wrong:** State persists across dapp unmounts and can cause memory leaks or stale state on re-mount; multiple dapps can't maintain independent state

**Do this instead:** Store state in closure or return init function that captures it:
```typescript
// src/dapps/cic/cic.ts:517-525 — correct pattern
function init(container, isReport) {
  let lastResult = null;        // Private to this instance
  const listeners = [];          // Tracks listeners for cleanup
  // ... return cleanup function that references these
}
```

### Forgetting Theme/Plugin Listeners

**What happens:** Dapp subscribes to theme or route change events but doesn't unsubscribe on unmount

**Why it's wrong:** After unmount, event fires on disposed DOM or with stale closures; multiple mounts leak listeners

**Do this instead:** Capture unsubscribe function and call it in cleanup:
```typescript
// src/dapps/cic/cic.ts:773-784 — correct pattern
let themeUnsub = null;
if (dx) {
  const onThemeChange = () => { /* ... */ };
  themeUnsub = dx.events.on('dx:plugin:theme:changed', onThemeChange);
}
// In cleanup:
if (themeUnsub) themeUnsub.off();
```

### Querying Outside Container Scope

**What happens:** Dapp uses `document.querySelector()` instead of `container.querySelector()`

**Why it's wrong:** Affects shell chrome or other dapps' DOM; breaks isolation; causes hard-to-debug conflicts

**Do this instead:** Always scope to container:
```typescript
// WRONG:
const input = document.getElementById('principal');

// RIGHT (src/dapps/cic/cic.ts:529):
const input = container.querySelector('#principal');
```

### Missing ResizeObserver / RAF Cleanup

**What happens:** Code starts `requestAnimationFrame` or `ResizeObserver` but doesn't cancel/disconnect

**Why it's wrong:** After unmount, RAF fires on destroyed container; observer holds reference preventing GC

**Do this instead:** Track and cancel/disconnect in cleanup:
```typescript
// src/dapps/cic/cic.ts:759-768 — correct pattern
let resizeRAF = 0;
// ... setup ResizeObserver
if (chartRO) chartRO.disconnect();
if (resizeRAF) cancelAnimationFrame(resizeRAF);
```

## Error Handling

**Strategy:** Fail gracefully; assume DOM may be missing; use optional chaining

**Patterns:**
- `if (!element) return;` — Check for DOM element before querying further
- `theme?.setMode()` — Optional chaining for plugin methods
- Try/catch in FOUC prevention script only (localStorage access)
- No error logging; console.error used only for debugging

Example: `src/shell.ts:38` — returns early if headerEl not found
```typescript
function renderHeader(_dx, manifests) {
  const headerEl = document.getElementById('shell-header');
  if (!headerEl) return;  // Fail silently if header not in DOM
  // ...
}
```

## Cross-Cutting Concerns

**Logging:** Console output for debug only; no structured logging library

**Validation:** Input parsing functions strip invalid characters, min/max clamping:
- `src/dapps/cic/cic.ts:26-29` — parseNum strips non-numeric chars
- `src/dapps/cic/cic.ts:71-80` — inputFormatters enforce bounds (0-20% for contrib increase)

**Authentication:** Not implemented; no auth system in place

**Theme/Dark Mode:** 
- Applied via HTML attribute before paint (FOUC prevention)
- Three themes: zorgz-2625 (cyan), zorgz-156 (red), zorgz-4065 (gray)
- Light/dark modes: system (respects prefers-color-scheme) or explicit
- Persisted in localStorage under key `dxkit:theme`

**Accessibility:**
- Button groups use `aria-checked` for active state (`src/dapps/cic/cic.ts:573-577`)
- Theme panel buttons have `data-mode` and `data-scheme` for easy wiring
- No keyboard navigation beyond browser defaults (no tab traps)

---

*Architecture analysis: 2026-08-19*
