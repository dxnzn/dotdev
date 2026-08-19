# Codebase Structure

**Analysis Date:** 2026-08-19

## Directory Layout

```
dotdev/
├── src/
│   ├── index.html                    # Main HTML entry point (structure + FOUC prevention script)
│   ├── main.ts                       # Shell initialization (DxKit config, dapps registration)
│   ├── shell.ts                      # Chrome rendering (header, footer, nav, theme panel)
│   │
│   ├── dapps/                        # Each dapp is self-contained
│   │   ├── about/
│   │   │   ├── manifest.json         # Route config, nav metadata, dependencies
│   │   │   ├── dapp.ts               # Lifecycle handler (mount/unmount)
│   │   │   ├── template.html         # Static markup
│   │   │   └── style.css             # Dapp-specific styles
│   │   ├── projects/
│   │   │   ├── manifest.json
│   │   │   ├── dapp.ts
│   │   │   ├── template.html
│   │   │   └── style.css
│   │   ├── support/
│   │   │   ├── manifest.json
│   │   │   ├── dapp.ts
│   │   │   ├── template.html
│   │   │   └── style.css
│   │   ├── cic/                      # Compound Interest Calculator (interactive)
│   │   │   ├── manifest.json         # Has dependencies array
│   │   │   ├── dapp.ts               # Lifecycle, calls window.CIC.init()
│   │   │   ├── cic.ts                # Domain logic IIFE (calculation, rendering, wiring)
│   │   │   ├── template.html         # Form + chart + table + overview + formula sections
│   │   │   └── style.css             # Tool-specific styles
│   │   └── tpl/
│   │       ├── manifest.json         # Disabled by default (can enable in main.ts)
│   │       ├── dapp.ts
│   │       ├── template.html
│   │       └── style.css
│   │
│   ├── styles/
│   │   ├── base.css                  # Reset, fonts, root variables, .app layout
│   │   ├── theme.css                 # Theme-specific colors (3 themes × light/dark)
│   │   ├── shell.css                 # Header, footer, nav dropdown, theme panel
│   │   └── components.css            # Cards, buttons, inputs, tabs, tables
│   │
│   ├── types/
│   │   └── globals.d.ts              # Type declarations for DxKit globals
│   │
│   ├── vendor/
│   │   └── dxkit/                    # Vendored DxKit IIFE builds
│   │       ├── index.global.js       # DxKit core (createShell, Router, etc)
│   │       ├── index.d.ts
│   │       ├── theme/
│   │       │   ├── index.global.js   # Theme plugin
│   │       │   └── index.d.ts
│   │       └── settings/
│   │           ├── index.global.js   # Settings plugin
│   │           └── index.d.ts
│   │
│   └── assets/
│       ├── zorgz-2625.svg            # Cyan theme icon
│       ├── zorgz-156.svg             # Red theme icon
│       ├── zorgz-4065.svg            # Gray theme icon
│       └── fonts/
│           └── ibm-plex-mono-*.woff2 # Monospace font files
│
├── test/                             # Test files (vitest)
│
├── Makefile                          # Build tasks (vendor, build, serve, dist, deploy)
├── tsconfig.json                     # TypeScript config (target ES2022, strict mode)
├── tsup.config.ts                    # tsup config (transpile only, no bundling)
├── package.json                      # Dependencies (devDependencies only)
├── BUILD_VERSION                     # Auto-incrementing version (starts at 1001)
└── README.md                         # Project overview

```

## Directory Purposes

**src/:**
- Purpose: All source code; compiled in-place to `.js` files
- Contains: TypeScript, HTML templates, CSS, type definitions, vendored framework
- Key files: `index.html` (entry), `main.ts` (shell init), `shell.ts` (chrome)

**src/dapps/:**
- Purpose: Page-level separation of concerns
- Contains: 5 dapps (about, projects, support, cic, tpl) each with manifest, lifecycle, template, styles
- Pattern: Each dapp is self-contained; no cross-dapp imports
- Key files: Each dapp's `manifest.json` (route config), `dapp.ts` (lifecycle hook)

**src/dapps/{name}/:**
- Purpose: Single dapp directory with all related files
- Contains: manifest.json, dapp.ts, template.html, style.css, and optional domain module
- Key files: `manifest.json` (declares route, entry, template, dependencies, nav)
- Naming: Lowercase dapp name matches directory

**src/styles/:**
- Purpose: Global stylesheets applied to all pages
- Contains: Reset/base, theme system, shell chrome, component library
- Load order: base.css → theme.css → shell.css → components.css
- Scoping: Global (applies to whole page); dapp-specific styles live in `src/dapps/{name}/style.css`

**src/vendor/dxkit/:**
- Purpose: Vendored DxKit framework (IIFE builds only)
- Contains: Core IIFE, theme plugin IIFE, settings plugin IIFE, type definition files
- Origin: Built from `../dxkit/` repo, copied by `make vendor` target
- Not committed: Generated on `make vendor`; should not be edited

**src/types/:**
- Purpose: TypeScript type declarations for global IIFE objects
- Contains: `globals.d.ts` declaring DxKit, DxTheme, DxSettings, shell functions
- Used by: TypeScript type checking for window.DxKit, etc.

**test/:**
- Purpose: Vitest unit and integration tests
- Contains: Test files (*.test.ts, *.spec.ts)
- Run: `make test` or `npm run test`

## Key File Locations

**Entry Points:**
- `src/index.html` — HTML document structure, inline FOUC prevention, script/stylesheet loading order
- `src/main.ts` — Shell creation, dapp registration, init orchestration
- `src/shell.ts` — Chrome rendering, event wiring (nav, theme, share)

**Configuration:**
- `tsconfig.json` — TypeScript (ES2022, strict, no emit)
- `tsup.config.ts` — Transpile TS to JS in-place (no bundling)
- `Makefile` — Build/deploy/vendor tasks
- `package.json` — Dev dependencies (biome, tsup, vitest, serve, etc.)

**Core Logic:**
- `src/dapps/cic/cic.ts` — Only complex domain module; calculation engine, chart, form wiring
- `src/dapps/about/template.html` — FAQ and about content

**Styling:**
- `src/styles/theme.css` — Theme variables for 3 themes × light/dark modes
- `src/styles/shell.css` — Header, footer, dropdown menus, theme panel layout
- `src/styles/components.css` — Cards, buttons, inputs, tabs, scrollable sections

**Testing:**
- `test/` — Vitest test files (if any present; not shown in exploration)

## Naming Conventions

**Files:**
- TypeScript source: `camelCase.ts` (e.g., `shell.ts`, `cic.ts`)
- HTML templates: `template.html` (always this name per dapp)
- Styles: `style.css` (always this name per dapp)
- Manifests: `manifest.json` (always this name per dapp)
- Entry point: `dapp.ts` (always this name; compiled to `dapp.js`)
- Build config: kebab-case (e.g., `tsup.config.ts`, `tsconfig.json`)

**Directories:**
- Dapps: lowercase single word (e.g., `about`, `projects`, `cic`, `tpl`)
- Layers: lowercase plural where appropriate (e.g., `dapps/`, `styles/`, `types/`, `vendor/`)

**IDs & Routes:**
- Dapp ID: matches directory name (e.g., dapp id="cic" → `src/dapps/cic/`)
- Route: starts with `/` (e.g., `"/"` for about, `"/tools/cic"` for calculator)
- CSS selectors: kebab-case or BEM-like (e.g., `.app-dropdown`, `.theme-panel-trigger`)

**CSS Custom Properties:**
- Theme colors: `--bg`, `--text`, `--accent`, `--border`, etc. (set in theme.css)
- Chart colors (CIC): `--chart-grid`, `--chart-interest-fill`, `--chart-line-principal`, etc.
- Text variants: `--text`, `--text-muted`, `--text-dim`

## Where to Add New Code

**New Static Dapp:**
1. Create directory: `src/dapps/{name}/`
2. Create manifest: `src/dapps/{name}/manifest.json` (copy from about, update id/route/label)
3. Create dapp handler: `src/dapps/{name}/dapp.ts` (copy from about or projects)
4. Create template: `src/dapps/{name}/template.html` (your HTML content)
5. Create styles: `src/dapps/{name}/style.css` (or empty if using only global styles)
6. Register in shell: Add to `src/main.ts:10-15` dapps array with manifest path
7. Build: `make build`

**New Interactive Dapp (with domain logic):**
1. Create directory: `src/dapps/{name}/`
2. Create manifest: `src/dapps/{name}/manifest.json` (add dependencies array with domain module path)
3. Create domain module: `src/dapps/{name}/{name}.ts` (IIFE wrapping, export `window.{NAME}.init()`)
   - Follow CIC pattern: `src/dapps/cic/cic.ts:517-871` for init function signature
   - Return cleanup function from init
   - Track all listeners for cleanup
4. Create dapp handler: `src/dapps/{name}/dapp.ts` (call `window.{NAME}.init(container, options)`)
5. Create template: `src/dapps/{name}/template.html` (HTML for domain module to query)
6. Create styles: `src/dapps/{name}/style.css`
7. Register in shell: Add to `src/main.ts:10-15`
8. Add types: Update `src/types/globals.d.ts` to declare `window.{NAME}` interface
9. Build: `make build`

**New Global Component/Style:**
1. If reusable across multiple dapps, add to `src/styles/components.css`
2. If dapp-specific, add to `src/dapps/{name}/style.css`
3. Theme-dependent colors? Use CSS custom properties from theme.css (e.g., `var(--accent)`)
4. Build: `make build` (CSS already compiled)

**New Utility Function:**
1. If used by multiple dapps or the shell: Create `src/utils/{name}.ts` (new directory)
2. If used by single dapp: Keep in dapp's domain module (e.g., `src/dapps/{name}/{name}.ts`)
3. Build: `make build`

**New Routes/Sub-Paths:**
1. Edit dapp's manifest route field (e.g., `"/tools/cic"` to handle `/tools/cic/report`)
2. Handle sub-path in dapp lifecycle handler or domain module
3. Example: `src/dapps/cic/cic.ts:820-838` listens to `dx:route:subpath` event

## Special Directories

**src/vendor/dxkit/:**
- Purpose: Framework code (not your code)
- Generated: Yes, by `make vendor` command
- Committed: Only the source files in parent repo (`../dxkit/`); these IIFEs are rebuilt
- Edit: Never directly; edit DxKit source in parent repo, rebuild with `make vendor`

**dist/ and _site/:**
- Purpose: Build outputs
- Generated: Yes, by `make dist` or `make prepare-site`
- Committed: No; generated on deployment
- Clean: `make clean` removes dist/

**node_modules/:**
- Purpose: Dependencies
- Generated: Yes, by `npm install` / `make setup`
- Committed: No; use .gitignore

**BUILD_VERSION:**
- Purpose: Version counter for dist folder naming
- Format: Single integer (starts at 1001)
- Updated: Auto-incremented by `make dist` and `make dist-history-stubs`
- Purpose: Versioned dist folders: `dnzn.dev-20260819.1001/`, `dnzn.dev-20260819.1002/`, etc.

## Build Output Structure

After `make build`, each TypeScript file has a corresponding `.js` file in the same directory:
```
src/main.ts → src/main.js
src/shell.ts → src/shell.js
src/dapps/cic/dapp.ts → src/dapps/cic/dapp.js
src/dapps/cic/cic.ts → src/dapps/cic/cic.js
```

These `.js` files are:
- Transpiled only (not bundled)
- ES2022 compatible
- Loaded via `<script src="...">` tags in HTML or manifests
- Not committed to git (.gitignore)

---

*Structure analysis: 2026-08-19*
