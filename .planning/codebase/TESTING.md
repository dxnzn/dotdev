# Testing Patterns

**Analysis Date:** 2026-08-19

## Test Framework

**Runner:**
- Vitest 4.1.2 (configured in `vitest.config.ts`)
- Environment: jsdom (browser simulation)
- Config file: `vitest.config.ts` (8 lines)

**Assertion Library:**
- Vitest built-in `expect()` assertions
- Standard matchers: `toEqual()`, `toContain()`, `toBe()`, `toHaveProperty()`, `toHaveLength()`

**Run Commands:**
```bash
npm test                 # Run all tests (runs vitest run)
make test               # Alias for npm test
# Coverage command not configured
```

Test execution: `vitest run` (one-time run, no watch mode configured by default)

## Test File Organization

**Location:**
- Separate `/test` directory at root: `/Users/derks/Development/Denizen/dotdev/test/`
- Tests not co-located with source files (separate-directory pattern)

**Naming:**
- Test files end with `.test.ts`: `main.test.ts`, `dapps.test.ts`
- Follows Vitest convention from `vitest.config.ts` include: `test/**/*.test.ts`

**Structure:**
```
test/
├── main.test.ts          # Tests for src/main.ts shell config
├── dapps.test.ts         # Tests for dapp manifests and lifecycle
└── (future test files)
```

## Test Structure

**Suite Organization:**
```typescript
import { describe, expect, it } from 'vitest';

describe('main — shell configuration', () => {
  it('registers all five dapps with valid manifest paths', () => {
    // Arrange
    const main = readFileSync(resolve(__dirname, '../src/main.ts'), 'utf-8');
    
    // Act
    const manifestPaths = [...main.matchAll(/manifest:\s*'([^']+)'/g)].map((m) => m[1]);
    
    // Assert
    expect(manifestPaths).toEqual([...expected paths...]);
  });
});
```

**Key patterns:**

1. **File-based testing** — read source files and verify structure/config via string matching
   - Example: `test/main.test.ts` reads `src/main.ts` and validates manifest paths (lines 6-16)
   - Validates configuration without mocking the DxKit framework

2. **Manifest validation** — verify dapp files are properly structured
   - Example: `test/dapps.test.ts` iterates DAPP_IDS and checks each manifest (lines 19-50)

3. **Lifecycle verification** — ensure dapps implement required event handlers
   - Check for `dx:mount` listeners (line 59)
   - Check for `dx:unmount` listeners (line 64)
   - Example from lines 53-72

4. **File system checks** — use `existsSync()` to verify required files exist
   - Example: `test/dapps.test.ts` lines 33-38 verify entry points and styles

## Test Examples

**Configuration validation (from `test/main.test.ts:6-17`):**
```typescript
it('registers all five dapps with valid manifest paths', () => {
  const main = readFileSync(resolve(__dirname, '../src/main.ts'), 'utf-8');

  const manifestPaths = [...main.matchAll(/manifest:\s*'([^']+)'/g)].map((m) => m[1]);
  expect(manifestPaths).toEqual([
    'dapps/about/manifest.json',
    'dapps/projects/manifest.json',
    'dapps/support/manifest.json',
    'dapps/tpl/manifest.json',
    'dapps/cic/manifest.json',
  ]);
});
```

**Parameterized manifest tests (from `test/dapps.test.ts:19-50`):**
```typescript
const DAPP_IDS = ['about', 'projects', 'support', 'tpl', 'cic'] as const;

for (const id of DAPP_IDS) {
  describe(id, () => {
    const manifest = loadManifest(id);

    it('has all required fields', () => {
      for (const key of requiredKeys) {
        expect(manifest, `missing "${key}"`).toHaveProperty(key);
      }
    });

    it('entry and styles point to existing files', () => {
      const tsEntry = manifest.entry.replace('.js', '.ts');
      expect(existsSync(resolve(SRC, tsEntry)), `missing ${tsEntry}`).toBe(true);
    });
  });
}
```

**Helper functions (from `test/dapps.test.ts:8-14`):**
```typescript
function loadManifest(id: string) {
  return JSON.parse(readFileSync(resolve(SRC, `dapps/${id}/manifest.json`), 'utf-8'));
}

function loadDappSource(id: string) {
  return readFileSync(resolve(SRC, `dapps/${id}/dapp.ts`), 'utf-8');
}
```

## Mocking

**Framework:** None observed

**What's mocked:**
- No mocking in current tests
- Tests read real files and verify structure
- No database, HTTP, or external API mocks needed (no async operations tested)

**What NOT to mock:**
- File system (use `existsSync()`, `readFileSync()` directly)
- Configuration files (load actual JSON manifests)
- Source code structure (read actual .ts files for validation)

**jsdom environment:**
- Configured for DOM simulation but not actively used in current tests
- Available for future component/UI testing

## Fixtures and Factories

**Test Data:**
```typescript
// Hard-coded constant array (from test/dapps.test.ts:5)
const DAPP_IDS = ['about', 'projects', 'support', 'tpl', 'cic'] as const;

// Hard-coded required fields list (from test/dapps.test.ts:17)
const requiredKeys = ['id', 'name', 'description', 'version', 'route', 'entry', 'styles', 'nav'];
```

**Location:**
- Test data defined inline in test files
- No separate fixtures directory
- Shared constants extracted to module level (e.g., `DAPP_IDS`)
- Each test suite defines its own required keys or loads from manifest

**Manifest loading pattern:**
```typescript
const SRC = resolve(__dirname, '../src');

function loadManifest(id: string) {
  return JSON.parse(readFileSync(resolve(SRC, `dapps/${id}/manifest.json`), 'utf-8'));
}
```

## Coverage

**Requirements:** Not enforced

**View Coverage:**
- No coverage command configured in `package.json`
- No coverage threshold set in `vitest.config.ts`
- To add: Configure via vitest coverage option or add threshold validation

## Test Types

**Unit Tests:**
- Scope: Configuration validation (does the setup match expectations?)
- Approach: Read files, verify structure with regex and property checks
- Examples: `main.test.ts` validates shell config, `dapps.test.ts` validates manifest structure
- No isolated function testing (functions are not exported)

**Integration Tests:**
- Scope: Dapp lifecycle and manifest contracts
- Approach: Verify that manifests declare dependencies correctly, event handlers exist
- Example: `dapps.test.ts:75-91` tests that CIC dapp declares `cic.js` dependency

**E2E Tests:**
- Framework: Not used
- Browser testing would need separate E2E runner (Playwright, Cypress)
- Hash routing makes E2E feasible but not currently implemented

**Async Testing:**
- No async tests in current suite
- If needed, use async/await in test function:
```typescript
it('name', async () => {
  // test code
});
```

**Error Testing:**
- No error scenarios currently tested
- Would use negative assertions: `expect(...).not.toContain(...)`
- Pattern: Read file, verify it DOES NOT contain incorrect patterns

## Test Coverage Gaps

**Currently untested:**
- CIC calculator logic (875 lines in `src/dapps/cic/cic.ts` — complex domain logic)
- Event handler behavior (dom interactions, theme switching)
- Shell chrome UI wiring (event listeners, DOM manipulation)
- Theme panel state management
- Navigation routing

**How to add tests:**

For CIC calculator:
1. Export functions from IIFE (currently all functions are private)
2. Create unit tests for `parseNum()`, `fmtMoney()`, `debounce()` utilities
3. Test calculation engine with known compound interest scenarios

For shell chrome:
1. Use jsdom environment to simulate DOM
2. Create fixtures for HTML structure
3. Test event listener registration and handler execution
4. Verify CSS class toggling and state updates

**Example test structure for future DOM tests:**
```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { JSDOM } from 'jsdom';

describe('shell chrome - DOM interactions', () => {
  let dom: JSDOM;
  
  beforeEach(() => {
    dom = new JSDOM(`<div id="shell-header"></div><div id="shell-footer"></div>`);
    // global.document = dom.window.document;
  });

  it('renders header with nav links', () => {
    // Test DOM rendering
  });
});
```

---

*Testing analysis: 2026-08-19*
