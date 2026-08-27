# DOTDEV

<!-- Project-specific only. Org-wide rules belong in ../shared/ORG.md. -->

> `../shared` is an optional sibling checkout. Without it, only this file applies.

## Overview

A static, no-backend site that doubles as a real-world working example of building
on the DxKit framework. A hash-routed DxKit shell hosts a handful of small dapps;
the tree is deployed to GitHub Pages and is servable from IPFS unchanged. See
`README.md` for the route table and the build-versioning scheme.

## Repo Structure

- `src/` — the served tree. Compiled `.js` lands beside its `.ts` source here, so
  the source tree *is* the site; there is no runtime build output directory.
- `src/dapps/<name>/` — one directory per dapp: `manifest.json`, `template.html`,
  `dapp.ts` (lifecycle), `style.css`, plus an optional domain module (`cic.ts`).
- `src/vendor/dxkit/` — framework IIFE + `.d.ts`, produced by `make vendor` from
  the `../dxkit` sibling checkout. Gitignored.
- `src/styles/` — `base.css`, `theme.css`, `shell.css`, `components.css`.
- `test/` — vitest suites.
- `tmp/` — untracked scratch for upstream feedback notes (see Gotchas).

## Commands

```
make init      # re-run ../shared/scripts/init.sh
make setup     # npm install
make vendor    # build ../dxkit and vendor its IIFE + .d.ts into src/vendor/
make build     # transpile .ts -> .js via tsup
make watch     # transpile in watch mode
make serve     # build, then serve src/ on :3000
make lint      # biome check .
make test      # lint, then vitest run
make dist      # build + bump BUILD_VERSION + versioned dist/ folder
make deploy    # vendor, build, test, then push _site/ to gh-pages
```

## Conventions

- **No bundler at runtime.** Cross-file code cannot use `import`. Extra files are
  listed in a manifest's `dependencies` (loaded in order, before `entry`) and
  communicate through a single `window` namespace.
- **Every new `.ts` must be added to `tsup.config.ts` `entry`.** It is an explicit
  list, not a glob — omit a file and it silently never compiles.
- **No runtime dependencies and no CDN scripts.** Anything needed is implemented
  in-repo; the IPFS-servable, no-build-at-runtime posture depends on it.
- **No backend.** All state is `localStorage` or the URL. That is a product
  promise, not just an implementation detail.
- **Hash routing** (`#/tools/cic`) — it is what makes GitHub Pages and IPFS both
  work from the same tree.
- **Dapps own only their container.** Scope every query to
  `container.querySelector()`, never `document`.
- **`init()` returns a cleanup closure.** `dx:unmount` must tear down listeners,
  RAF callbacks, and observers; a leak here survives navigation.
- Biome: 2-space indent, single quotes, trailing commas, 120 columns.

## Gotchas

- **Framework workarounds get written up.** Whenever we work around DxKit rather
  than through it, write a feature request or bug report to `tmp/`, addressed at
  agents, so it can be taken upstream and implemented there.
- **A fresh clone must `make vendor` before `make build`** — `src/vendor/` is
  gitignored and comes from `../dxkit`.
- **`data-layout` is set twice, deliberately.** `src/index.html` sets it
  synchronously before first paint to avoid FOUC; `src/shell.ts` keeps it in sync
  afterwards. Change one and the other has to follow.
- **Chart colors are cached.** `cic.ts` reads `--chart-*` custom properties via
  `getComputedStyle` once and memoises them, so a theme change must invalidate
  that cache or the chart keeps painting the old palette.
- **`BUILD_VERSION` auto-increments** on `make dist` / `make dist-history-stubs`.
