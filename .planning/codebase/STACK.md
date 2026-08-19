# Technology Stack

**Analysis Date:** 2026-08-19

## Languages

**Primary:**
- TypeScript 5.4.0 - Application logic and configuration
- HTML - Page templates and dapp templates in `src/index.html` and `src/dapps/*/template.html`
- CSS - Styling via `src/styles/` (base.css, theme.css, shell.css, components.css)

**Target:**
- ES2022 - Compilation target for all TypeScript

## Runtime

**Environment:**
- Browser (ES2022+)
- No Node.js runtime — compiled TypeScript runs client-side via script tags

**Execution Model:**
- IIFE modules loaded via `<script>` tags
- No bundler at runtime
- Hash-based routing (`#/path`)
- Single-page application (SPA)

## Package Manager

**npm**
- Version: Latest (from `package.json`)
- Lockfile: `package-lock.json` (generated, committed)
- Dependencies file: `package.json`

## Frameworks

**Core:**
- DxKit - Framework for shell, routing, plugins, dapps
  - Vendored from `../dxkit/` via `make vendor`
  - IIFE distributions: `src/vendor/dxkit/index.global.js`
  - TypeScript definitions: `src/vendor/dxkit/index.d.ts`
  - Plugins: Theme (`DxTheme`), Settings (`DxSettings`)

**Build/Compilation:**
- tsup 8.0.0 - TypeScript transpiler (no bundling, ESM output)
  - Config: `tsup.config.ts`
  - Transpiles `.ts` to `.js` in-place in `src/`
  - Target: `es2022`, browser platform
  - Splitting disabled (one-to-one TS→JS mapping)

**Development Server:**
- serve 14.0.0 - Static file server for local development
  - Runs on `http://localhost:3000`
  - No hot reload

## Testing

**Test Framework:**
- Vitest 4.1.2 - Unit/integration test runner
  - Config: `vitest.config.ts`
  - Environment: jsdom (simulated DOM)
  - Command: `npm run test` (runs `vitest run`)
  - Test files: `test/**/*.test.ts`

## Code Quality & Formatting

**Linting:**
- Biome 2.4.9 - Linting and code formatting
  - Config: `biome.json` (schema: 2.5.1)
  - Format: 2-space indentation, 120-char line width
  - JavaScript: Single quotes, trailing commas
  - Rules: Recommended preset (suspicious.noExplicitAny off, style.noNonNullAssertion off)
  - Includes: `src/**/*.ts`, `test/**/*.ts`
  - Excludes: `src/dapps/cic/cic.ts` (large domain-logic file)

## Compilation & Build

**TypeScript Compiler:**
- Version: 5.4.0
- Config: `tsconfig.json`
- Target: ES2022
- Module: ES2022
- Strict mode: Enabled
- Module resolution: bundler

**Build Process:**
- Makefile orchestration (`make vendor`, `make build`, `make watch`, `make serve`)
- Vendor step: Copies DxKit IIFE + .d.ts to `src/vendor/dxkit/`
- Build step: Runs `npx tsup` to transpile TypeScript
- Versioning: `BUILD_VERSION` file incremented on dist creation

## Configuration Files

**Development:**
- `devbox.json` - Devbox environment (Node.js latest)
- `.nvmrc` - Not present (version from devbox/GitHub Actions)
- `.npmrc` - Not present (default npm config)

**Build:**
- `Makefile` - Build orchestration (setup, vendor, build, serve, dist, clean, lint, test, release)
- `tsup.config.ts` - TypeScript transpilation config
- `tsconfig.json` - TypeScript compiler options
- `vitest.config.ts` - Test runner config
- `biome.json` - Code quality config

**Git/CI:**
- `.github/workflows/deploy.yml` - CI pipeline (lint, test on push/PR)
- `.gitignore` - Excludes `dist/`, `_site/`, `node_modules/`, `src/vendor/`, compiled `.js`

## Platform Requirements

**Development:**
- Node.js 20+ (from GitHub Actions, devbox)
- npm (node package manager)
- GNU Make (for Makefile)
- Git (for version control)
- Browser with ES2022 support

**Production:**
- Modern browser (ES2022 support)
- HTTP server serving static files
- Deployment target: GitHub Pages (`gh-pages` branch)

## Key Runtime Globals

**DxKit IIFE Globals:**
- `window.DxKit` - Core framework (createShell, Router, EventBus, etc.)
- `window.DxTheme` - Theme plugin (createCSSTheme)
- `window.DxSettings` - Settings plugin (createSettings)
- `window.__DXKIT__` - Runtime shell instance (theme, router, events, manifests)
- `window.CIC` - Compound Interest Calculator module (init function)

## Storage

**Client-Side:**
- `localStorage` - Theme and settings persistence (key: `dxkit:theme` — JSON serialized)
- URL state - Query parameters for CIC calculator sharing (`?p=10000&r=7&y=20...`)

---

*Stack analysis: 2026-08-19*
