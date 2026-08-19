# Codebase Concerns

**Analysis Date:** 2026-08-19

## Tech Debt

**CIC.ts excluded from linting:**
- Issue: `src/dapps/cic/cic.ts` (875 lines) is explicitly excluded from biome linting in `biome.json` line 40 with `!src/dapps/cic/cic.ts`
- Files: `biome.json`, `src/dapps/cic/cic.ts`
- Impact: The largest file in the project is not checked for style violations, import organization, or formatting consistency. Quality issues go undetected.
- Fix approach: Remove the exclusion from `biome.json` and run `make lint-fix` to format cic.ts. The file may need formatting adjustments but should comply with the project's linting rules.

**Large monolithic CIC module:**
- Issue: `src/dapps/cic/cic.ts` is a 875-line IIFE containing calculation engine, chart rendering, UI updates, event wiring, and state management all in one file
- Files: `src/dapps/cic/cic.ts`
- Impact: Difficult to test individual pieces. Hard to find bugs. Changes to one feature (e.g., formula) require understanding the whole file. Re-rendering or event handler logic is tightly coupled.
- Fix approach: Break cic.ts into modules: `calculate.ts` (calculation engine), `chart.ts` (canvas rendering), `ui.ts` (DOM updates), `state.ts` (state management). Each exported via the window.CIC namespace but logically separated.

**Linting bypass in shell.ts:**
- Issue: Line 17 of `src/shell.ts` has `biome-ignore lint/correctness/noUnusedVariables` on the `initShellChrome()` function declaration
- Files: `src/shell.ts:17`
- Impact: Function is marked as unused because it's called via `<script>` tag in HTML, but the bypass suggests the real issue hasn't been addressed. Future maintainers may not understand why this function exists.
- Fix approach: Add JSDoc comment explaining that this function is called globally from `main.js` via `<script>` tag. Consider using a more explicit pattern than a biome-ignore, or document in a README why IIFE exports need this.

**Type safety rules disabled in biome.json:**
- Issue: `biome.json` disables `noExplicitAny` (line 26) and `noNonNullAssertion` (line 29)
- Files: `biome.json`, potentially many `.ts` files
- Impact: Code may use `any` types and non-null assertions without triggering warnings. This can hide type safety issues that would break in strict TypeScript environments.
- Fix approach: Run `make lint-fix` with these rules enabled to identify problem areas. Fix the underlying types rather than disabling the rule. Most issues are DOM queries that can use type guards.

## Test Coverage Gaps

**CIC calculation logic untested:**
- What's not tested: The `calculate()` function in `src/dapps/cic/cic.ts` (lines 91-176) which implements the core compound interest formula. Also untested: chart rendering (`drawChartOn()`), input formatting, contribution increase calculations.
- Files: `src/dapps/cic/cic.ts`, no test file
- Risk: Calculation errors go unnoticed. A change to the formula for inflation adjustment or contribution escalation could break results silently. Users share broken calculators via URL.
- Priority: High — this is the core value of the CIC dapp

**Chart rendering has no visual regression tests:**
- What's not tested: The canvas rendering in `drawChartOn()` (lines 179-301) produces no test coverage. Chart could break due to coordinate calculation errors, color changes, or scaling issues.
- Files: `src/dapps/cic/cic.ts`
- Risk: Chart could display incorrectly on specific input ranges without being caught.
- Priority: Medium — impacts user confidence in the tool

**Shell chrome not tested:**
- What's not tested: `src/shell.ts` has no unit or integration tests. Dropdown behavior, theme switching, navigation updates are untested.
- Files: `src/shell.ts`
- Risk: Changes to navigation or theme logic could break the header/footer across the entire app.
- Priority: Medium — affects core navigation

**Event listener cleanup untested:**
- What's not tested: The cleanup function returned from `CIC.init()` (lines 851-870 of cic.ts) is called on dapp unmount but never tested. Event listeners could leak.
- Files: `src/dapps/cic/cic.ts`, `src/dapps/cic/dapp.ts`
- Risk: Memory leaks if listeners are not properly removed during navigation. ResizeObserver, event handlers, and subscriptions could accumulate.
- Priority: Medium — affects long-term stability during extended use

## Fragile Areas

**Global DOM assumptions in shell.ts:**
- Files: `src/shell.ts`
- Why fragile: Functions like `renderHeader()` assume `#shell-header` exists and is empty. If index.html changes or IDs are renamed, functions fail silently or produce DOM anomalies.
- Safe modification: Add checks at the top of each render function. Return early if container doesn't exist. Consider using defensive selectors with type guards.
- Test coverage: None — add integration tests that render the shell and verify DOM structure.

**Window.__DXKIT__ global dependency:**
- Files: `src/main.ts`, `src/shell.ts`, `src/dapps/cic/cic.ts`
- Why fragile: Code assumes `window.__DXKIT__` is always available and has expected plugin/router/event methods. If DxKit initialization order changes or fails, subsequent code breaks.
- Safe modification: Add null checks before every DxKit access. Consider using a custom hook or context manager to centralize DxKit access.
- Test coverage: Integration tests should verify DxKit is initialized before dapps mount.

**Vendor directory dependency on sibling ../dxkit:**
- Files: `Makefile`, `src/vendor/dxkit/`
- Why fragile: The `vendor` target in Makefile copies files from `../dxkit`, which is a sibling directory outside this repo. If DxKit directory is moved, deleted, or the path is wrong, `make vendor` fails silently or copies stale files.
- Safe modification: Add a check in Makefile to verify `$(DXKIT_ROOT)/dist/index.global.js` exists before copying. Print an error if the file is missing.
- Test coverage: `make vendor` should verify all copied files are present and have expected content.

**Event listener registration without removal in shell.ts:**
- Files: `src/shell.ts` (functions `wireDropdowns()`, `wireShareButton()`, `wireThemePanel()`, `wireNavigation()`)
- Why fragile: Event listeners are attached to `document` without explicit removal. If the shell reinitializes, listeners accumulate. The share button listener uses capture phase (line 802 in cic.ts) which could interfere with other handlers.
- Safe modification: Return cleanup functions from each wire function. Call cleanup on theme change or route change.
- Test coverage: None — add tests that verify listeners are cleaned up.

**CSS variable cache invalidation:**
- Files: `src/dapps/cic/cic.ts` lines 5-23
- Why fragile: `chartStyles()` caches CSS variables in `_cssCache`. On theme change, the cache is set to null (line 777), but if the theme change event fires at the wrong time relative to chart rendering, stale colors could be used.
- Safe modification: Add a timestamp or version to the cache key. Invalidate based on a theme change event counter.
- Test coverage: Test theme switching while a chart is being rendered.

## Known Bugs

**No explicit error handling for URL share failure:**
- Symptoms: If `navigator.clipboard.writeText()` fails (e.g., in insecure contexts), the share button shows "LINK COPIED" but the URL was not actually copied.
- Files: `src/shell.ts` lines 150-154, `src/dapps/cic/cic.ts` lines 797-801
- Trigger: Click share button in a non-secure (non-HTTPS) context or when clipboard API is blocked.
- Workaround: None — users think the link was copied but it wasn't.

**CSV export uses deprecated emoji characters:**
- Symptoms: The copy CSV button uses `✓` and `⎘` characters which may not render consistently across browsers.
- Files: `src/dapps/cic/cic.ts` lines 733-736
- Trigger: Click "Copy as CSV" button on any OS/browser.
- Workaround: None — text copies correctly but visual feedback uses emoji.

## Security Considerations

**No input validation on URL parameters:**
- Risk: The `loadFromURL()` function in `src/dapps/cic/cic.ts` (lines 439-471) parses URL parameters but doesn't validate ranges or sanitize input. A malicious URL could set principal to a huge number causing performance issues or browser crashes.
- Files: `src/dapps/cic/cic.ts` lines 439-471
- Current mitigation: Sliders have `min/max` attributes (e.g., rate-slider 1-30) but text inputs accept any value. The `Math.max()` calls provide some bounds checking.
- Recommendations: Add explicit range validation for all URL parameters. Reject URLs with out-of-range values. Add a max limit on calculation periods to prevent billion-year simulations.

**DOM-based XSS risk in HTML injection:**
- Risk: `innerHTML` is used extensively to update charts, tables, and overviews (cic.ts lines 357-365, 505-510, etc.). While data comes from calculated values, the approach is fragile. A typo could allow injection.
- Files: `src/dapps/cic/cic.ts`
- Current mitigation: Data sources are numeric (no user input directly in rendered HTML). All text is from `fmtMoney()`, `fmtInt()`, etc.
- Recommendations: Use `textContent` for plain text. Use a template library or build HTML with DOM methods rather than string concatenation. Consider using `createElement()` for dynamic HTML.

## Performance Bottlenecks

**Canvas redraw on every input change:**
- Problem: The chart redraws on every debounced input change (120ms debounce, line 570), even if the chart tab is not active. This wastes CPU.
- Files: `src/dapps/cic/cic.ts` lines 570, 563
- Cause: `update()` calls `drawChartOn()` for both `#growth-chart` and `#report-chart-canvas` unconditionally.
- Improvement path: Only redraw the chart if the chart tab is currently active. Check `tab-chart.classList.contains('active')` before calling `drawChartOn()`.

**CSS variable lookup on every chart draw:**
- Problem: `chartStyles()` reads from `getComputedStyle()` on every draw call, which triggers a reflow.
- Files: `src/dapps/cic/cic.ts` lines 8-23
- Cause: The cache is only invalidated on theme change (line 777), but even after invalidation, the next draw recalculates all CSS variables.
- Improvement path: Cache the styles more aggressively. Batch CSS variable reads into a single `getComputedStyle()` call.

**No memoization of yearly data calculations:**
- Problem: `calculate()` is called on every input change and rebuilds the entire `yearlyData` array even if inputs haven't changed.
- Files: `src/dapps/cic/cic.ts` lines 542-544
- Cause: No memoization or diffing of state.
- Improvement path: Implement shallow equality check on state before recalculating. Skip recalculation if state hasn't changed.

## Scaling Limits

**Large year ranges can cause exponential growth in calculations:**
- Current capacity: The app limits years to 30 (slider max at template.html line 37), which produces ~360 compound periods (30 years × 12 monthly compounds). This is tractable.
- Limit: If a user manually sets years to 1000+ via URL parameters, the calculation loop runs for 12,000+ periods. The yearlyData array grows to 1000+ entries, and rendering a chart with that many data points becomes slow.
- Scaling path: Add server-side rate limiting on year values in URL. Cap yearly data to 500 entries regardless of input. Implement sampling (every Nth year) for large date ranges.

**No WebWorker for expensive calculations:**
- Current capacity: Calculations block the UI thread. For a 30-year scenario it's fine (~1-2ms calculation time).
- Limit: If calculation time exceeds 16ms (one frame), the UI becomes janky.
- Scaling path: Move `calculate()` to a WebWorker for large inputs. Return results via postMessage.

## Dependencies at Risk

**DxKit vendored copy not version-locked:**
- Risk: `src/vendor/dxkit/` is a manual copy. If the main DxKit repo is updated upstream and someone runs `make vendor` without updating `../dxkit`, the vendored copy becomes stale. There's no lock file to ensure consistency.
- Impact: New features or fixes in DxKit won't be available. Bugs in the old vendored version could break the site.
- Migration plan: Add a `.vendor-versions` or similar file that tracks the commit SHA of DxKit that was vendored. Compare in Makefile during `make vendor` and warn if out of sync.

**No lock file for transitive dependencies:**
- Risk: `package.json` uses `^` version constraints (e.g., `@biomejs/biome ^2.4.9`). A minor version bump of Biome could change linting behavior.
- Impact: Different developers or CI systems could run different versions of tools, producing inconsistent linting results.
- Migration plan: Commit `package-lock.json` (if using npm) or `yarn.lock` (if using yarn) to enforce exact versions.

## Missing Critical Features

**No offline support:**
- Problem: The app requires network access to load DxKit IIFE scripts and theme files. If the CDN is down or user is offline, the app doesn't load.
- Blocks: Using the CIC tool on an airplane or in areas with poor connectivity.

**No persistent state saving:**
- Problem: When a user navigates away from the CIC calculator, their input values are lost. They must re-enter or use the share URL.
- Blocks: Long-form analysis or experimentation with multiple scenarios.
- Recommendation: Save inputs to localStorage. Auto-restore on page load.

**No calculation history or comparison:**
- Problem: Users can only view one scenario at a time.
- Blocks: Side-by-side comparison of different investment strategies.

---

*Concerns audit: 2026-08-19*
