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
- `src/dapps/decode/` — a shared-namespace dapp behind one global, `window.DxDecode` (a
  **dapp** namespace, not a framework one — the `Dx*` prefix elsewhere means vendored DxKit,
  this is decode's own). Its framework modules are `core.ts` (the ports, the `DecodeNode` result
  type, the decoder registry and the decode service), `codecs.ts` (the pure hex/base64/UTF-8
  codecs), `ui.ts` (the renderer and all DOM) and `dapp.ts` (lifecycle glue only) — plus **one
  file per decoder**, each self-registering per the directory's own README "add a decoder"
  walkthrough: `decoders.ts` (hex), `decoders-base64.ts`, `decoders-url.ts`, `decoders-jwt.ts`
  and `decoders-abi-words.ts`, with a new decoder arriving as a new sibling rather than growing
  an existing file. Phase 5 added five more modules by the same pattern: `keccak.ts`
  (keccak-256, no dependencies), `abi.ts` (the head/tail ABI decoder and signature-string
  parser), `signatures.ts` (the local signature table plus the OpenChain/4byte registry
  adapters), `decoders-eth-calldata.ts` (the Ethereum calldata decoder composing the three
  above), and `transport.ts` — **the only file in this directory that may invoke `fetch`**,
  because the portability guard's source scan permits exactly one named exemption and asserts
  every call site inside it sits inside `netRequest`, the one function that also writes the log
  entry; every other file, including the four other Phase 5 additions, is still forbidden the
  network primitive outright. Phase 6 added four more modules: `annotators.ts` (the bounded
  cross-call recursion pass, the operation-argument annotator, and the progressive contract-name
  walk that patches a resolved name into the tree without blocking the initial render — ETH-12),
  `abi-source.ts` (the verified-ABI source and its one-level proxy follow), `cache.ts` (the
  two-tier verified-ABI cache — the guard's THIRD named exemption, `localStorage` confined to this
  one file's `cchCreatePersistenceAccess`, alongside `fetch`/`transport.ts` and `href`/`ui.ts`),
  and `tx-source.ts` (the transaction lookup, the user's own RPC endpoint first, the explorer's
  proxy module second) — taking the directory from 14 shipped modules to 18. A nineteenth,
  `creation-code.ts`, landed after Phase 6's UAT surfaced the gap it closes: it recognises contract
  creation bytecode and splits its constructor words off the compiled blob (REF-01's §7.4 slice).
  It is **not** a decoder and registers nothing — a deploy payload is usually an argument, so
  `decoders-eth-calldata.ts` calls it for a top-level paste and `annotators.ts` calls it as the
  guard that must run BEFORE a `bytes` argument is grafted as a nested call. Built to be portable
  into any DxKit shell (`requires.plugins: ["settings"]`, `standalone: false`, no `Dnzn*`-prefixed
  identifier anywhere in the directory) and a source-scanning guard
  (`test/decode-portability.test.ts`) enforces that posture on every change. See
  `src/dapps/decode/README.md`.
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
make serve     # build, then serve src/ on :3333 (override: make serve PORT=…)
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
  dapp needs no `.gitignore` change — but only for its **entry module** (`dapp.js`, covered by
  the `src/dapps/*/dapp.js` glob). This holds for a single-module dapp like CIC or settings, but
  the decode dapp proved it false in general: its non-entry modules needed a directory-glob line
  of their own, `src/dapps/decode/*.js` — that pattern, not a literal per-file line, is what a
  future multi-module dapp should follow. Phase 4 is that pattern's first real proof: it added
  four new decoder modules to the directory and none needed an ignore-file change, the glob
  already covering every non-entry module in the directory rather than a named or counted set of
  them. Phase 5 is the second proof and the stronger one: it added five more modules
  (`keccak.ts`, `abi.ts`, `signatures.ts`, `transport.ts`, `decoders-eth-calldata.ts`), again with
  no `.gitignore` change, confirming the glob covers every non-entry module in the directory
  rather than a set fixed at whatever count existed when the glob was written.

  Phase 6 is the third proof: it added `annotators.ts`, `abi-source.ts`, `cache.ts` and
  `tx-source.ts` to the directory — four new modules — again with no `.gitignore` change, the same
  directory-glob line already covering every one of them with nothing added or counted by hand.
  Two literal per-file lines also exist today for top-level modules, `src/wallet-identity.js`
  and `src/shell-wallet.js`.
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
- **`src/main.ts` also canonicalizes a hash route's query string, before the shell exists.** The
  vendored router strips a base path and a trailing slash from a hash route but never a query
  string, so `#/tools/decode?decoder=hex&data=…` does not route — only `#/tools/decode/?…` (the
  query separated by a slash) does. Removing the canonicalizer breaks every hash route on this
  site that carries a query string, not just decode's; `test/decode-route.test.ts` records both
  halves of the reason (the framework's own router failing to resolve the non-slash form, and
  the canonicalizer converting it). See `tmp/dxkit-bug-router-hash-query.md`.
- **`data-layout` is set twice, deliberately.** `src/index.html` sets it
  synchronously before first paint to avoid FOUC; `src/shell.ts` keeps it in sync
  afterwards. Change one and the other has to follow.
- **Chart colors are cached.** `cic.ts` reads `--chart-*` custom properties via
  `getComputedStyle` once and memoises them, so a theme change must invalidate
  that cache or the chart keeps painting the old palette.
- **`BUILD_VERSION` auto-increments** on `make dist` / `make dist-history-stubs`.
- **The decode portability guard (`test/decode-portability.test.ts`) has exactly three named
  exemptions, each file-and-function scoped, not directory-wide.** `fetch` is permitted only in
  `src/dapps/decode/transport.ts`, and only inside `netRequest`, the one function that also
  writes the log entry; `href` is permitted only inside `ui.ts`'s `uiCreateExternalLink`;
  `localStorage` is permitted only inside `src/dapps/decode/cache.ts`'s
  `cchCreatePersistenceAccess`, the one function every persistence call site sits inside (D-12,
  ratified at Plan 04's own blocking checkpoint — NET-08's verified-ABI cache). A future decoder
  that needs to reach the network, construct a link, or persist something cannot add its own call
  site — it must route through `transport.ts`'s `createTransport()`, `ui.ts`'s existing link
  helper, or `cache.ts`'s own factory. All three exemptions are asserted to have exactly one
  entry, so adding a second exempt file or helper requires deliberately widening the allowlist,
  not just writing the code — the guard's failure message alone (a plain "unlisted global" or
  network/storage-identifier violation) won't explain this design; this note is the explanation.
