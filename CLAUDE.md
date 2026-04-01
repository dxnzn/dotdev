# CLAUDE.md — DOTDEV
 
## Project

Read the @README.md **now** for context and understanding about this project.

## Git Commits

1. **Conventional commits** — `feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`. Scope is optional: `feat(theme): add onApply hook`. Use `!` suffix to signal breaking changes: `feat!: rename entry to entrypoint` or `feat(manifest)!: remove styles field`. Breaking changes must also include a `BREAKING CHANGE:` footer in the body explaining what changed and how consumers should migrate.
2. **Subject line under 72 characters.** Use the body for detail.
3. **Body describes the "why" and the shape of the change** — not a diff recap, but enough context that an agent reviewing the commit can understand intent, trade-offs, and what areas were affected without reading every file.
4. **Reference updated docs** — if docs were changed to reflect the commit, include `See: docs/<file> (lines x-y)` in the body so reviewers and agents can jump straight to the relevant documentation.
5. **Co-author line** — always end with `Co-Authored-By: <model> <noreply@anthropic.com>`.

## Coding Standards

### In-line Commentary

1. **Comment the "why", not the "what"** — skip `// create event bus` above `createEventBus()`. If the code reads clearly, it doesn't need a comment.
2. **Document implicit contracts** — where the code relies on conventions not visible in the types (e.g., plugin duck-typing, dapp mount/unmount protocol).
3. **Flag non-obvious behavior** — silent no-ops, fallback chains, ordering dependencies, and cases where failure is intentionally swallowed.
4. **Keep it to one line** where possible. Multi-line comments only when the contract genuinely requires explanation.
5. **Skip comments on trivial code** — barrel exports, simple Map wrappers, and self-evident type definitions don't need commentary.
6. **No `@param` JSDoc on internal functions** — types speak for themselves. Reserve JSDoc for the public API surface.
7. **No section headers** like `// === Router ===` — file structure should be clear from the code organization itself.

### Framework Workarounds

If there is ever a case where we are having to "work-around" the DxKit framework, we should make not of it and generate a feature request or bug fix written to tmp/. This should be targetted at agents - so that I can take the feedback upstream and implement it easily in DxKit.
