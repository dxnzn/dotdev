# Coding Conventions

**Analysis Date:** 2026-08-19

## Naming Patterns

**Files:**
- Kebab-case for most files: `main.ts`, `dapp.ts`, `style.css`
- Exception: Utility/domain logic files use lowercase with underscores in special cases (e.g., `cic.ts`)
- Directory names are lowercase: `src/dapps/`, `src/types/`, `src/vendor/`
- Template files: `.html` extension (e.g., `template.html`)
- Manifest files: `manifest.json` (one per dapp)

**Functions:**
- camelCase for all function names: `initShellChrome()`, `renderHeader()`, `wireDropdowns()`, `updateThemeExtras()`
- Private/internal functions start with lowercase (no prefix convention used)
- Function names describe action: verb + object (e.g., `render*`, `wire*`, `update*`, `load*`)
- See examples in `src/shell.ts` (lines 18-276)

**Variables:**
- camelCase for all variable declarations: `const headerEl`, `let cleanup`, `const manifests`
- Use `const` by default, only `let` when mutation is needed
- Private state often stored as module-scoped variables (e.g., `cicCleanup`, `cicContainer` in `src/dapps/cic/dapp.ts`)
- DOM element variables end with `El` suffix: `headerEl`, `footerEl`, `appTrigger`

**Types:**
- TypeScript types are inferred from usage where possible
- Explicit type annotations used for function parameters and return types when crossing API boundaries
- Type definitions in `src/types/globals.d.ts` for window augmentation
- Record types used for mapping tables: `Record<string, string>` (see `DAPP_TITLES` in `src/shell.ts:229`)

**Constants:**
- UPPER_SNAKE_CASE for important module-level constants
- Examples: `SCHEME_COLORS`, `DARK_BG`, `DAPP_TITLES`, `DAPP_IDS` (in tests)
- Stored as const objects/arrays at the top of modules

## Code Style

**Formatting:**
- Tool: Biome 2.4.9
- Indentation: 2 spaces
- Line width: 120 characters
- Single quotes for strings: `'string'` not `"string"`
- Trailing commas in all multiline constructs

**Linting:**
- Tool: Biome (recommended preset)
- Disabled rules: `noExplicitAny`, `noNonNullAssertion`
- Strict mode enabled in TypeScript
- Format enforcement via `biome.json` (lines 15-37)
- Organize imports automatically: enabled in `biome.json` (lines 11-12)

**Example formatted code from `src/shell.ts`:**
```typescript
headerEl.innerHTML = `
  <div class="app-dropdown" id="app-dropdown">
    <button class="app-dropdown-trigger" id="app-trigger" title="Menu">
      <img src="assets/zorgz-2625.svg" alt="" class="title-icon">
      <h1>DNZN // DEV</h1>
    </button>
  </div>`;
```

## Import Organization

**Order (from `biome.json`):**
1. Node.js standard library (e.g., `import { readFileSync } from 'node:fs'`)
2. External packages (DxKit globals in this project)
3. Local types and utilities

**Example from `test/dapps.test.ts` (lines 1-6):**
```typescript
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
```

**Path resolution:**
- No path aliases configured in `tsconfig.json`
- Uses bundler module resolution: `moduleResolution: 'bundler'`
- Relative imports used where needed (tests use `resolve(__dirname, '../src/...')`)
- DxKit accessed via global `window.__DXKIT__` or `window.DxKit`

## Error Handling

**Patterns:**
- Early returns to prevent null reference errors: `if (!element) return;` (see `src/shell.ts:37-38`)
- Optional chaining (`?.`) for safe property access: `cleanup?.()` (see `src/dapps/about/dapp.ts:15`)
- Nullish coalescing (`??`) for default values: `const group = m.nav.group || 'other'` (see `src/shell.ts:44`)
- No try-catch blocks observed (script-based architecture doesn't require explicit error handling)
- DOM queries return null; always check before use

**Pattern in dapp lifecycle:**
```typescript
window.addEventListener('dx:mount', async (e) => {
  if (e.detail.id !== 'cic') return;  // Early return to filter
  // Safe to proceed
});
```

## Logging

**Framework:** None observed — no `console.log()` or logging library used

**When to log:**
- Not currently used in this codebase
- If added, would likely use `console` methods for browser environments
- Consider using DxKit event system for observability instead

## Comments

**When to Comment:**
- Explain the "why", not the "what" — skip comments on trivial code
- Flag non-obvious behavior: fallback chains, ordering dependencies, implicit contracts
- Document side effects and timing constraints
- Explain configuration rationale

**Examples from codebase:**

Single-line comment explaining setup order (from `src/shell.ts:32`):
```typescript
// onApply fires before chrome exists — apply extras now that DOM is ready
```

Multi-line header explaining file purpose (from `src/shell.ts:1-3`):
```typescript
// Shell chrome: header (nav dropdown, theme panel, share, wallet) + footer.
// Renders into #shell-header and #shell-footer after DxKit shell.init().
// Wires behaviors using window.__DXKIT__ context.
```

Section comment organizing code (from `src/dapps/cic/cic.ts` pattern):
```typescript
// ── CSS STYLE CACHE (invalidated on theme change) ──
```

Biome directives for rule suppression (from `src/shell.ts:17`):
```typescript
// biome-ignore lint/correctness/noUnusedVariables: called globally from main.js via <script> tag
```

**JSDoc/TSDoc:**
- Not used for internal functions — types speak for themselves
- Would be used for public API surfaces if this were a library
- Current codebase has no exported function documentation

## Function Design

**Size:**
- Keep functions small and focused (see `renderHeader`, `renderFooter`, `wireDropdowns` in `src/shell.ts`)
- Most functions 10-50 lines; larger functions like `renderHeader` (74 lines) split logical sections with comments

**Parameters:**
- Use destructuring for object parameters where helpful
- Pass minimal required context: containers, manifests, plugin instances
- Example from `src/shell.ts:36`: `function renderHeader(_dx, manifests)` — `_dx` prefix indicates unused parameter

**Return Values:**
- Functions often return `void` when operating on DOM (e.g., `renderHeader`, `wireDropdowns`)
- Cleanup functions return `() => void` closure: `const cleanup = () => { container.innerHTML = ''; }`
- Event listeners register without explicit return

**Cleanup Pattern (used in all dapps):**
```typescript
let cleanup = null;

window.addEventListener('dx:mount', async (e) => {
  if (e.detail.id !== 'about') return;
  const container = e.detail.container;
  cleanup = () => {
    container.innerHTML = '';
  };
});

window.addEventListener('dx:unmount', (e) => {
  if (e.detail.id !== 'about') return;
  cleanup?.();
  cleanup = null;
});
```

## Module Design

**Exports:**
- Script-based architecture (IIFE + globals) in most modules
- Limited ES module exports for test utilities
- Domain logic exported via window globals: `window.CIC.init()` (see `src/dapps/cic/cic.ts`)

**Module Lifecycle:**
- Most modules are self-contained and run on load
- `<script>` tags trigger execution (no explicit imports)
- Dapps use event-based lifecycle (`dx:mount`, `dx:unmount`)
- Cleanup is critical — always provide unmount handler

**Barrel Files:**
- Not used in this codebase (no re-export index files)
- Each dapp has its own manifest defining its entry points

---

*Convention analysis: 2026-08-19*
