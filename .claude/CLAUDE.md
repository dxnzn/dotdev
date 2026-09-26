<!-- GSD:project-start source:PROJECT.md -->

## Project

**DNZN // DEV (dotdev)**

The source behind [dnzn.dev](https://dnzn.dev) — a static, no-backend site built as a real-world
working example of the [DxKit](https://github.com/dxnzn/dxkit) framework. It hosts a small set of
dapps (About, Projects, Support, CIC) behind a hash-routed DxKit shell, deployed to GitHub Pages
and servable from IPFS.

The site itself is stable. This milestone adds `decode` — a generic decoder dapp whose first and
primary adapter is recursive Ethereum calldata decoding — and the global surfaces it needs to exist:
a user-facing settings dapp, a shared Ethereum credentials namespace, and wallet identity in the
shell header.

**Core Value:** A person can paste nested ABI-encoded calldata and read what it actually does, all the way down,
in a browser that sends nothing to DNZN.

### Constraints

- **Tech stack**: Pure HTML/CSS/TypeScript→JS, no runtime dependencies, no CDN scripts, no npm
  runtime packages — everything (ABI decoding, keccak-256, base64url) implemented in-repo. The site's
  IPFS-servable, no-build-at-runtime posture depends on it.

- **No bundler at runtime**: cross-file code cannot use `import`; extra files are listed in manifest
  `dependencies` (loaded in order, before `entry`) and communicate through one `window` namespace
  (`window.DxDecode`). New `.ts` files must be added to `tsup.config.ts` `entry`.

- **No backend**: all state is `localStorage` or URL. This is a product promise, not just an
  implementation detail.

- **Bring-your-own credentials**: the user supplies their own Etherscan key and RPC URL. Decoders
  declare which settings they need and degrade gracefully — never crash — when they are absent.

- **Payload budget**: target < 128 KB uncompressed and < 32 KB gzipped JS for the decode dapp
  including all first-wave decoders — redefined in Phase 5 from the original `< 60 KB uncompressed` target, now superseded (see `.planning/REQUIREMENTS.md`'s DEC-16 for the full rationale).
  Network work only on demand.

- **DxKit as it stands**: no upstream DxKit change may block this milestone. Gaps become `tmp/`
  feature requests.

- **Hash routing**: query strings arrive inside `e.detail.path` on `dx:mount`; URL updates use
  `history.replaceState` and must not trigger a route change.

- **Testing**: vitest is configured and the full suite is green; pure codec and recursion logic
  must be unit-tested offline against the handoff's real mainnet vectors with a stubbed ABI
  source.
<!-- GSD:project-end -->

<!-- GSD:stack-start source:codebase/STACK.md -->

## Technology Stack

## Languages

- TypeScript 5.4.0 - Application logic and configuration
- HTML - Page templates and dapp templates in `src/index.html` and `src/dapps/*/template.html`
- CSS - Styling via `src/styles/` (base.css, theme.css, shell.css, components.css)
- ES2022 - Compilation target for all TypeScript

## Runtime

- Browser (ES2022+)
- No Node.js runtime — compiled TypeScript runs client-side via script tags
- IIFE modules loaded via `<script>` tags
- No bundler at runtime
- Hash-based routing (`#/path`)
- Single-page application (SPA)

## Package Manager

- Version: Latest (from `package.json`)
- Lockfile: `package-lock.json` (generated, committed)
- Dependencies file: `package.json`

## Frameworks

- DxKit - Framework for shell, routing, plugins, dapps
- tsup 8.0.0 - TypeScript transpiler (no bundling, ESM output)
- serve 14.0.0 - Static file server for local development

## Testing

- Vitest 4.1.2 - Unit/integration test runner

## Code Quality & Formatting

- Biome 2.4.9 - Linting and code formatting

## Compilation & Build

- Version: 5.4.0
- Config: `tsconfig.json`
- Target: ES2022
- Module: ES2022
- Strict mode: Enabled
- Module resolution: bundler
- Makefile orchestration (`make vendor`, `make build`, `make watch`, `make serve`)
- Vendor step: Copies DxKit IIFE + .d.ts to `src/vendor/dxkit/`
- Build step: Runs `npx tsup` to transpile TypeScript
- Versioning: `BUILD_VERSION` file incremented on dist creation

## Configuration Files

- `devbox.json` - Devbox environment (Node.js latest)
- `.nvmrc` - Not present (version from devbox/GitHub Actions)
- `.npmrc` - Not present (default npm config)
- `Makefile` - Build orchestration (setup, vendor, build, serve, dist, clean, lint, test, release)
- `tsup.config.ts` - TypeScript transpilation config
- `tsconfig.json` - TypeScript compiler options
- `vitest.config.ts` - Test runner config
- `biome.json` - Code quality config
- `.github/workflows/deploy.yml` - CI pipeline (lint, test on push/PR)
- `.gitignore` - Excludes `dist/`, `_site/`, `node_modules/`, `src/vendor/`, compiled `.js`

## Platform Requirements

- Node.js 20+ (from GitHub Actions, devbox)
- npm (node package manager)
- GNU Make (for Makefile)
- Git (for version control)
- Browser with ES2022 support
- Modern browser (ES2022 support)
- HTTP server serving static files
- Deployment target: GitHub Pages (`gh-pages` branch)

## Key Runtime Globals

- `window.DxKit` - Core framework (createShell, Router, EventBus, etc.)
- `window.DxTheme` - Theme plugin (createCSSTheme)
- `window.DxSettings` - Settings plugin (createSettings)
- `window.__DXKIT__` - Runtime shell instance (theme, router, events, manifests)
- `window.CIC` - Compound Interest Calculator module (init function)

## Storage

- `localStorage` - Theme and settings persistence (key: `dxkit:theme` — JSON serialized)
- URL state - Query parameters for CIC calculator sharing (`?p=10000&r=7&y=20...`)

<!-- GSD:stack-end -->

<!-- GSD:conventions-start source:CONVENTIONS.md -->

## Conventions

## Naming Patterns

- Kebab-case for most files: `main.ts`, `dapp.ts`, `style.css`
- Exception: Utility/domain logic files use lowercase with underscores in special cases (e.g., `cic.ts`)
- Directory names are lowercase: `src/dapps/`, `src/types/`, `src/vendor/`
- Template files: `.html` extension (e.g., `template.html`)
- Manifest files: `manifest.json` (one per dapp)
- camelCase for all function names: `initShellChrome()`, `renderHeader()`, `wireDropdowns()`, `updateThemeExtras()`
- Private/internal functions start with lowercase (no prefix convention used)
- Function names describe action: verb + object (e.g., `render*`, `wire*`, `update*`, `load*`)
- See examples in `src/shell.ts` (lines 18-276)
- camelCase for all variable declarations: `const headerEl`, `let cleanup`, `const manifests`
- Use `const` by default, only `let` when mutation is needed
- Private state often stored as module-scoped variables (e.g., `cicCleanup`, `cicContainer` in `src/dapps/cic/dapp.ts`)
- DOM element variables end with `El` suffix: `headerEl`, `footerEl`, `appTrigger`
- TypeScript types are inferred from usage where possible
- Explicit type annotations used for function parameters and return types when crossing API boundaries
- Type definitions in `src/types/globals.d.ts` for window augmentation
- Record types used for mapping tables: `Record<string, string>` (see `DAPP_TITLES` in `src/shell.ts:229`)
- UPPER_SNAKE_CASE for important module-level constants
- Examples: `SCHEME_COLORS`, `DARK_BG`, `DAPP_TITLES`, `DAPP_IDS` (in tests)
- Stored as const objects/arrays at the top of modules

## Code Style

- Tool: Biome 2.4.9
- Indentation: 2 spaces
- Line width: 120 characters
- Single quotes for strings: `'string'` not `"string"`
- Trailing commas in all multiline constructs
- Tool: Biome (recommended preset)
- Disabled rules: `noExplicitAny`, `noNonNullAssertion`
- Strict mode enabled in TypeScript
- Format enforcement via `biome.json` (lines 15-37)
- Organize imports automatically: enabled in `biome.json` (lines 11-12)

## Import Organization

- No path aliases configured in `tsconfig.json`
- Uses bundler module resolution: `moduleResolution: 'bundler'`
- Relative imports used where needed (tests use `resolve(__dirname, '../src/...')`)
- DxKit accessed via global `window.__DXKIT__` or `window.DxKit`

## Error Handling

- Early returns to prevent null reference errors: `if (!element) return;` (see `src/shell.ts:37-38`)
- Optional chaining (`?.`) for safe property access: `cleanup?.()` (see `src/dapps/about/dapp.ts:15`)
- Nullish coalescing (`??`) for default values: `const group = m.nav.group || 'other'` (see `src/shell.ts:44`)
- No try-catch blocks observed (script-based architecture doesn't require explicit error handling)
- DOM queries return null; always check before use

## Logging

- Not currently used in this codebase
- If added, would likely use `console` methods for browser environments
- Consider using DxKit event system for observability instead

## Comments

- Explain the "why", not the "what" — skip comments on trivial code
- Flag non-obvious behavior: fallback chains, ordering dependencies, implicit contracts
- Document side effects and timing constraints
- Explain configuration rationale
- Not used for internal functions — types speak for themselves
- Would be used for public API surfaces if this were a library
- Current codebase has no exported function documentation

## Function Design

- Keep functions small and focused (see `renderHeader`, `renderFooter`, `wireDropdowns` in `src/shell.ts`)
- Most functions 10-50 lines; larger functions like `renderHeader` (74 lines) split logical sections with comments
- Use destructuring for object parameters where helpful
- Pass minimal required context: containers, manifests, plugin instances
- Example from `src/shell.ts:36`: `function renderHeader(_dx, manifests)` — `_dx` prefix indicates unused parameter
- Functions often return `void` when operating on DOM (e.g., `renderHeader`, `wireDropdowns`)
- Cleanup functions return `() => void` closure: `const cleanup = () => { container.innerHTML = ''; }`
- Event listeners register without explicit return

## Module Design

- Script-based architecture (IIFE + globals) in most modules
- Limited ES module exports for test utilities
- Domain logic exported via window globals: `window.CIC.init()` (see `src/dapps/cic/cic.ts`)
- Most modules are self-contained and run on load
- `<script>` tags trigger execution (no explicit imports)
- Dapps use event-based lifecycle (`dx:mount`, `dx:unmount`)
- Cleanup is critical — always provide unmount handler
- Not used in this codebase (no re-export index files)
- Each dapp has its own manifest defining its entry points

<!-- GSD:conventions-end -->

<!-- GSD:architecture-start source:ARCHITECTURE.md -->

## Architecture

## System Overview

```text

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

- **Zero bundler at runtime** — All code loads via IIFE `<script>` tags
- **Hash-based routing** — `#/about`, `#/tools/cic/report`, works on GitHub Pages and IPFS
- **DxKit orchestration** — Framework handles routing, lifecycle, events; app owns no DOM except mounts
- **Template-driven** — HTML in `.html` files, JavaScript wires behavior via DOM queries
- **Namespace isolation** — IIFE wrappers (cic.ts) prevent global pollution
- **Async cleanup** — Init functions return cleanup handlers for proper unmounting

## Layers

- Purpose: Create DxKit instance, configure plugins, register dapps
- Location: `src/main.ts`, `src/index.html`
- Contains: Shell config with theme/settings plugins, dapp manifest list
- Depends on: DxKit IIFE, vendor plugins
- Used by: DxKit router to bootstrap the app
- Purpose: Render and manage persistent header, footer, navigation
- Location: `src/shell.ts`
- Contains: Navigation rendering from manifests, theme panel, share button, active state tracking
- Depends on: DxKit event bus, theme plugin, manifest metadata
- Used by: HTML page (mounts to #shell-header, #shell-footer)
- Purpose: Hash-based routing, dapp lifecycle events
- Location: Inside DxKit IIFE (vendor)
- Contains: Route parsing, dx:mount/dx:unmount event firing, path change tracking
- Depends on: Browser location API
- Used by: Shell (for navigation active state), dapps (lifecycle hooks)
- Purpose: Page-level isolation of concerns, lifecycle management
- Location: `src/dapps/{name}/dapp.ts`
- Contains: Mount/unmount event listeners specific to each dapp
- Depends on: DxKit event bus, HTML container, optional domain module
- Used by: Router (fires mount/unmount)
- Purpose: Calculation, state management, rendering, event wiring
- Location: `src/dapps/{name}/{name}.ts` (e.g., `src/dapps/cic/cic.ts`)
- Contains: IIFE-wrapped pure functions (calculate, render) + event wiring (input handlers, theme listeners)
- Depends on: DOM container, CSS custom properties for styling, DxKit event bus
- Used by: Dapp lifecycle handler (`src/dapps/{name}/dapp.ts` calls `window.{NAME}.init()`)

## Data Flow

### Primary Request Path (Page Load / Navigation)

### Route Navigation Flow

### Theme Change Flow

### CIC Calculator State Flow (Example Complex Dapp)

- Form inputs in DOM (source of truth)
- `getState()` reads current form values on demand
- `lastResult` cached for performance (chart resizing, tab switching)
- URL params for sharing state (parsed on mount, built on share button click)
- Theme colors from CSS custom properties (invalidated on theme change)

## Key Abstractions

- Purpose: Declarative configuration for each page/app
- Examples: `src/dapps/about/manifest.json`, `src/dapps/cic/manifest.json`
- Pattern: JSON with id, route, entry (dapp.js), template (html), dependencies (array of scripts), nav metadata
- Used to: Register dapps with router, build navigation menus, determine layout width
- Purpose: Ensure proper resource cleanup on unmount
- Pattern: Init function returns closure over listener array
- Used by: Dapp lifecycle handler calls cleanup on `dx:unmount`
- Purpose: Namespace isolation, private state, public API
- Pattern: `(function() { ... window.{NAME} = { init }; })()`
- Examples: `src/dapps/cic/cic.ts` (exports `window.CIC.init()`)
- Benefit: Multiple dapps don't pollute global namespace, internal functions stay private
- Purpose: Load additional scripts before dapp mount (e.g., domain module)
- Pattern: Dependencies array in manifest → DxKit loads scripts before firing dx:mount
- Example: CIC manifest has `"dependencies": ["dapps/cic/cic.js"]`
- Result: `window.CIC` available when dapp.ts mount handler runs

## Entry Points

- Location: `src/index.html`
- Triggers: Browser load
- Responsibilities: HTML structure, inline FOUC prevention script, stylesheet and script loading order
- Location: `src/main.ts`
- Triggers: Loaded via `<script src="main.js"></script>` in index.html
- Responsibilities: Create shell, configure plugins, register dapps, call init, invoke shell chrome rendering
- Location: `src/shell.ts`
- Triggers: Loaded before main.ts, `initShellChrome()` called from main.ts after shell.init()
- Responsibilities: Render header/footer, wire navigation, theme, share button, event listeners
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

```typescript

```

### Forgetting Theme/Plugin Listeners

```typescript

```

### Querying Outside Container Scope

```typescript

```

### Missing ResizeObserver / RAF Cleanup

```typescript

```

## Error Handling

- `if (!element) return;` — Check for DOM element before querying further
- `theme?.setMode()` — Optional chaining for plugin methods
- Try/catch in FOUC prevention script only (localStorage access)
- No error logging; console.error used only for debugging

```typescript

```

## Cross-Cutting Concerns

- `src/dapps/cic/cic.ts:26-29` — parseNum strips non-numeric chars
- `src/dapps/cic/cic.ts:71-80` — inputFormatters enforce bounds (0-20% for contrib increase)
- Applied via HTML attribute before paint (FOUC prevention)
- Three themes: zorgz-2625 (cyan), zorgz-156 (red), zorgz-4065 (gray)
- Light/dark modes: system (respects prefers-color-scheme) or explicit
- Persisted in localStorage under key `dxkit:theme`
- Button groups use `aria-checked` for active state (`src/dapps/cic/cic.ts:573-577`)
- Theme panel buttons have `data-mode` and `data-scheme` for easy wiring
- No keyboard navigation beyond browser defaults (no tab traps)

<!-- GSD:architecture-end -->

<!-- GSD:skills-start source:skills/ -->

## Project Skills

No project skills found. Add skills to any of: `.claude/skills/`, `.agents/skills/`, `.cursor/skills/`, `.github/skills/`, or `.codex/skills/` with a `SKILL.md` index file.
<!-- GSD:skills-end -->

<!-- GSD:workflow-start source:GSD defaults -->

## GSD Workflow Enforcement

Before using Edit, Write, or other file-changing tools, start work through a GSD command so planning artifacts and execution context stay in sync.

Use these entry points:

- `/gsd-quick` for small fixes, doc updates, and ad-hoc tasks
- `/gsd-debug` for investigation and bug fixing
- `/gsd-execute-phase` for planned phase work

Do not make direct repo edits outside a GSD workflow unless the user explicitly asks to bypass it.
<!-- GSD:workflow-end -->

<!-- GSD:profile-start -->

## Developer Profile

> Profile not yet configured. Run `/gsd-profile-user` to generate your developer profile.
> This section is managed by `generate-claude-profile` -- do not edit manually.
<!-- GSD:profile-end -->
