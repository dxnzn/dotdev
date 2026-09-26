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
- `src/shell.ts`, `src/wallet-identity.ts`, `src/shell-wallet.ts` — shell-level modules, one
  `<script>` tag each, reached only through a `window` namespace. `shell.ts` renders and wires the
  chrome. The other two are a port and its adapter: `src/wallet-identity.ts`
  (`window.DnznWalletIdentity`) owns a silent on-load query of the injected provider's
  already-authorised accounts, the direct `accountsChanged`/`chainChanged` subscriptions the page
  holds itself, and the in-memory identity the header renders from — nothing about the wallet is
  written to this browser, and the file touches no DOM. `src/shell-wallet.ts`
  (`window.DnznWallet`) owns the header chip, the dropdown's three states and
  connect/disconnect/copy, and is what `initShellChrome` calls. They are two files because the
  split is a policy module with no DOM against a DOM module with no provider access — the org's
  own ports-and-adapters rule, not a size argument. Load `wallet-identity.js` first: the adapter
  resolves the port as a bare global, exactly as `src/main.ts` resolves `DxWallet`. Reaching
  `window.ethereum` directly is a deliberate, singular exception confined to
  `src/wallet-identity.ts`: the vendored plugin's only account read sits behind a prompting
  `connect()`, so a silent read of already-granted permission has no path through it. D-01
  permits the exception — no DxKit code is modified and no second `WalletProvider` is written —
  and no other module may reach the injected provider directly.
- `src/plugins/` — dotdev-local DxKit plugin factories (`ethereum.ts`), registered
  in `src/main.ts` and loaded by their own `<script>` tag in `src/index.html` before
  `main.js` — a plugin factory has to exist at shell-construction time and there is no
  manifest-driven load path for plugins the way a dapp dependency has.
- `src/vendor/dxkit/` — framework IIFE + `.d.ts`, produced by `make vendor` from
  the `../dxkit` sibling checkout. Gitignored.
- `src/styles/` — `base.css`, `theme.css`, `shell.css`, `components.css`.
- `test/` — vitest suites.
- `tmp/` — untracked scratch for upstream feedback notes (see Gotchas).

## Commands

```
make init      # re-run ../shared/scripts/init.sh
make setup     # npm install
make vendor    # preflight ../dxkit artifacts, then vendor IIFE + .d.ts into src/vendor/
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
  list, not a glob — omit a file and it silently never compiles. A new **top-level**
  `src/*.ts` costs a second touchpoint: its compiled output needs its own line in the
  `.gitignore` compiled-output block, which enumerates literal paths — `src/shell.js` does not
  cover `src/shell-wallet.js`, so the artifact would be committed. The asymmetry is what makes
  this easy to miss: the plugin and dapp entries in that block *are* globs, so a new plugin or
  dapp needs no `.gitignore` change and a new top-level module always does. Two such literal
  lines exist today, `src/wallet-identity.js` and `src/shell-wallet.js`.
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
- **`src/main.ts`'s first statement deletes a storage key on purpose.** It removes the wallet
  plugin's persisted provider id (`dnzn:dotdev:wallet`) before `createShell` — load-bearing, not
  tidying. DxKit awaits every plugin's `init()` serially with no timeout and the wallet plugin's
  restore reaches a live account request with no user gesture, so a locked wallet whose prompt is
  dismissed leaves that promise pending and blocks the router, the first mount and the whole
  chrome on every route. Identity comes from asking the injected provider on load instead of a
  stored value, and the re-arm on dropdown open now exists so the plugin acquires an active
  provider and Disconnect can actually revoke. See `tmp/dxkit-fr-wallet-identity-cache.md`.
- **`data-layout` is set twice, deliberately.** `src/index.html` sets it
  synchronously before first paint to avoid FOUC; `src/shell.ts` keeps it in sync
  afterwards. Change one and the other has to follow.
- **Chart colors are cached.** `cic.ts` reads `--chart-*` custom properties via
  `getComputedStyle` once and memoises them, so a theme change must invalidate
  that cache or the chart keeps painting the old palette.
- **`BUILD_VERSION` auto-increments** on `make dist` / `make dist-history-stubs`.
