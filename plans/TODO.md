# TODO

Tracked follow-up work for dnzn.dev. Newest at top.

## TypeScript 6 upgrade

**Status:** pending · **Added:** 2026-06-29

`typescript` 5.9.3 → 6.0.x is a **major** bump, held back during the routine dep
refresh on 2026-06-29 (all other dev deps brought in-range that day).

TS 6.0 is the first release on the new major and may introduce stricter type
checking / removed deprecated options. Treat as its own isolated change.

- [ ] Bump `typescript` to `^6.0.0` in `package.json`, `npm install`
- [ ] `make build` — confirm tsup compile is clean
- [ ] `make test` — confirm lint (biome) + 46 vitest tests pass
- [ ] Check tsup/biome compatibility with TS 6 (peer ranges)
- [ ] Skim TS 6.0 release notes for breaking flags affecting `tsconfig.json`
- [ ] If clean: commit as `chore(deps): upgrade typescript to 6`

## biome config schema migration

**Status:** done · **Added:** 2026-06-29 · **Completed:** 2026-06-29

biome 2.4.9 → 2.5.1 bumped the config schema and deprecated the
`linter.rules.recommended` field. Migrated via `biome migrate --write`:
`$schema` → 2.5.1, `recommended: true` → `preset: "recommended"`.
`make test` clean (exit 0, 46/46).
