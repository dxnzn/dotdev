# DNZN // DEV (dotdev)

## What This Is

The source behind [dnzn.dev](https://dnzn.dev) — a static, no-backend site built as a real-world
working example of the [DxKit](https://github.com/dxnzn/dxkit) framework. It hosts a small set of
dapps (About, Projects, Support, CIC) behind a hash-routed DxKit shell, deployed to GitHub Pages
and servable from IPFS.

The site itself is stable. This milestone adds `decode` — a generic decoder dapp whose first and
primary adapter is recursive Ethereum calldata decoding — and the global surfaces it needs to exist:
a user-facing settings dapp, a shared Ethereum credentials namespace, and wallet identity in the
shell header.

## Core Value

A person can paste nested ABI-encoded calldata and read what it actually does, all the way down,
in a browser that sends nothing to DNZN.

## Requirements

### Validated

<!-- Inferred from existing code; shipped and relied upon. See .planning/codebase/. -->

- ✓ DxKit shell with hash routing (`#/path`), works on GitHub Pages and IPFS — existing
- ✓ Fetch-template dapp pattern: `manifest.json` + `dapp.ts` + `template.html` + `style.css` — existing
- ✓ Four dapps routed and navigable: About (`/`), Projects, Support, CIC (`/tools/cic`) — existing
- ✓ TPL dapp registered as `optional`, disabled by default — existing
- ✓ Three zorgs themes × light/dark via the DxKit theme plugin, persisted to `localStorage` — existing
- ✓ Theme panel in the shell header (the only settings UI that exists today) — existing
- ✓ App dropdown navigation, grouped, built from manifests — existing
- ✓ Share button copying the current URL — existing
- ✓ Wide layout auto-applied to `/tools/*` routes (`html[data-layout="wide"]`) — existing
- ✓ URL-as-state for CIC (`?p=&r=&y=`) — existing
- ✓ IIFE script-tag loading, no runtime bundler, no CDN, no runtime npm deps — existing
- ✓ tsup transpile, Biome lint, 46 vitest tests, Makefile build/dist/versioning — existing
- ✓ DxKit settings plugin registered in `src/main.ts` — but with no UI to drive it — existing

### Active

<!-- This milestone. Hypotheses until shipped and validated. -->

- [ ] A global `ethereum` DxKit plugin owning shared credentials (`etherscanApiKey`, `rpcUrl`,
      `chainId`, `etherscanRps`) under its own settings namespace, so any current or future dapp
      reads the same values
- [ ] A settings dapp on its own route that renders **generically** from `dx.settings.getSections()`
      — every dapp, plugin, and `_shell` section gets a form with no per-dapp code
- [ ] A clear privacy notice on the settings dapp: values live in this browser only, there are no
      backend servers, nothing is sent to DNZN — and, honestly, that the API key is stored and
      displayed in plaintext until DxKit gains a secret setting type
- [ ] The shell's wallet button enabled as a user dropdown: connect/disconnect, address display,
      persisted reconnect, and a link into settings
- [ ] `decode` dapp at `/tools/decode` — generic decoder framework, URL-addressable, first-wave
      decoder catalogue, per `plans/decoder-dapp-handoff.md`
- [ ] Recursive Ethereum calldata decoding that does not stop at the first `bytes` layer, with
      selector provenance always shown (verified / registry / local / unresolved)
- [ ] Pure in-repo codecs — keccak-256, ABI decoder, base64, hex — no runtime dependencies
- [ ] Graceful rate-limit handling and a live request log with credentials redacted
- [ ] DxKit gaps captured as agent-targeted feature requests in `tmp/`

### Out of Scope

- **Wallet-encrypted settings vault** — the intent is real and wanted (encrypt the browser settings
  store with a key derived from a wallet signature, opt-in, plaintext by default). Deferred because
  it requires upstream DxKit work that collides with DxKit's active v0.4 milestone. The storage seam
  is designed for it; the crypto lands later. See Key Decisions.
- **Any signing in this milestone** — wallet is connect + identity only. Signing arrives with the vault.
- **Standalone (shell-less) operation of the decode dapp** — the real goal is portability *between*
  DxKit shells, not running with no shell. Superseded; see Key Decisions.
- **A per-dapp settings form inside decode** — settings are global; decode links to the settings
  dapp when required values are missing.
- **Wallet-driven chain selection** — `chainId` comes from the ethereum plugin setting, not from the
  connected wallet. Keeps decode independent of wallet state.
- **Any backend, server, or account system** — there is none and there will not be one in this milestone.
- **Encoding direction, JWT signature verification, raw-tx sender recovery, tx simulation,
  multi-chain UX beyond a chainId → explorer table** — non-goals per handoff §10.
- **Second-wave decoders** (`eth-tx`, `eth-log`, `eth-abi-return`, `gzip`, `unix-time`) — design for
  them, do not build them.
- **TypeScript 6 upgrade** — tracked separately in `plans/TODO.md`; a major bump deserves its own change.

## Context

**Motivation.** Reading Majeur DAO proposals (zOrg, FWC). A proposal's substance is ABI-encoded two
or three layers deep (`executeByVotes → batchCalls → inner call`), and the web decoders linked from
the DAO interface stop at the first layer and print `bytes` where the meaning is. A working
Python/`cast` prototype already does the full job and is the behavioural reference:
`../research/scripts/decode-calldata.py`, written up in `../research/docs/projects/zfi/majeur.md`.

**Prior art in this repo.** `plans/decoder-dapp-handoff.md` (345 lines, committed 665dfd6) is a
complete implementation spec — normative requirements, decoder catalogue, DxKit integration facts
verified against source, hexagonal architecture, render model, UI spec, real mainnet test vectors
with expected results, and an acceptance checklist. This milestone adopts it wholesale, with the
corrections recorded in Key Decisions below.

**Codebase state.** Mapped 2026-08-19 into `.planning/codebase/`. The site is stable; no major
changes pending. `src/shell.ts:105` already contains a `#wallet-btn`, rendered but `disabled` with
`title="Connect wallet"` — the affordance exists and has never been wired.

**DxKit relationship.** We own DxKit and vendor it locally (`make vendor` from `../dxkit`), so
upstream changes are fast. But DxKit runs its own GSD project and is mid-milestone on v0.4
(On-Chain Deployment / ERC-8244, phases 11–18, active). This milestone is therefore deliberately
scoped to what works against DxKit as it stands today.

**Verified DxKit facts** (read from `../dxkit`, 2026-08-19 — these shape the plan):

- `Wallet.sign(message)` exists (`src/types/interfaces.ts:40`); the wallet plugin is real
  (`plugins/wallet/`) with EIP-1193 and local dev providers and persisted reconnect.
- `SettingDefinition.type` is `'text'|'number'|'boolean'|'select'|'multiselect'`
  (`src/types/settings.ts:9`) — **no** secret/password type and no `secret` flag.
- `SettingDefinition.dependsOn` exists — a field greys out when a sibling boolean is falsy. Not
  mentioned in the handoff doc; useful for the settings form.
- `getSections()` returns dapp **and** plugin **and** `_shell` sections
  (`plugins/settings/src/index.ts:196`), so one generic renderer covers everything.
- Plugins register settings under their own name (`plugins/settings/src/index.ts:130-135`) — this is
  what makes a global `ethereum` namespace possible with zero upstream change.
- `_shell` is hard-coded to optional-dapp toggles and overwritten (`index.ts:110`) — there is no API
  for an app to register its own shell-level settings.
- Settings `persist()`/`restore()` are **synchronous** `JSON.stringify` → `localStorage`
  (`index.ts:49,67`). WebCrypto is async — this is the concrete blocker for an encrypted vault.
- `manifest.standalone` is documented as "Whether this dapp can run outside the shell"
  (`src/types/manifest.ts:58`); `requires.plugins` declares plugins that must be registered before
  mount (`manifest.ts:41-44`).

## Constraints

- **Tech stack**: Pure HTML/CSS/TypeScript→JS, no runtime dependencies, no CDN scripts, no npm
  runtime packages — everything (ABI decoding, keccak-256, base64url) implemented in-repo. The site's
  IPFS-servable, no-build-at-runtime posture depends on it.
- **No bundler at runtime**: cross-file code cannot use `import`; extra files are listed in manifest
  `dependencies` (loaded in order, before `entry`) and communicate through one `window` namespace
  (`window.DxDecode`). New `.ts` files must be added to `tsup.config.ts` `entry`.
- **No backend**: all state is `localStorage` or URL. This is a product promise, not just an
  implementation detail.
- **Bring-your-own credentials**: the user supplies their own Etherscan key and RPC URL. Decoders
  declare which settings they need and degrade gracefully — never crash — when they are absent.
- **Payload budget**: target < 60 KB uncompressed JS for the decode dapp including all first-wave
  decoders. Network work only on demand.
- **DxKit as it stands**: no upstream DxKit change may block this milestone. Gaps become `tmp/`
  feature requests.
- **Hash routing**: query strings arrive inside `e.detail.path` on `dx:mount`; URL updates use
  `history.replaceState` and must not trigger a route change.
- **Testing**: vitest is configured and 46 tests pass today; pure codec and recursion logic must be
  unit-tested offline against the handoff's real mainnet vectors with a stubbed ABI source.

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Adopt `plans/decoder-dapp-handoff.md` as the decode spec | 345 lines already verified against DxKit source, with real test vectors and expected results. Re-deriving it would waste the work and risk drift. | — Pending |
| Ethereum credentials are **global**, not decode's | The key, RPC URL and chainId will be needed by other dapps. Scoping them to `decode` would force a migration later. Supersedes handoff §4.2 manifest `settings`. | — Pending |
| Global settings via a dotdev-local `ethereum` **plugin** | Plugins already register settings under their own namespace, so this works against today's DxKit with no upstream change — unlike `_shell`, which is hard-coded and overwritten. | — Pending |
| Settings dapp renders **generically** from `getSections()` | Every future dapp gets a settings UI for free. Hand-written sections would mean editing the settings dapp for every new dapp. | — Pending |
| Decode has **no** settings form of its own | Supersedes handoff §4.5. Settings are global; decode links to the settings dapp when required values are missing. | — Pending |
| "Standalone" reframed as **portable between DxKit shells** | The real goal is lifting the dapp into another DxKit app (likely its own project later) with the settings plugin still present — not shell-less operation. DxKit's `standalone` flag means the latter, so use `requires.plugins: ['settings']` and `standalone: false`. Supersedes handoff R14/§4.6: drops `standalone.html`, `LocalStorageSettingsAdapter`, and the `__DXKIT__` branch. | — Pending |
| Wallet is **connect + identity only** this milestone | Decode needs no signing and there is no backend, so connecting must not pretend to do more than it does. Signing arrives with the vault. | — Pending |
| Encrypted settings vault **deferred** | Wanted and designed for, but the settings plugin's persist/restore is synchronous and WebCrypto is async — a real upstream change, and DxKit's v0.4 is active. Plaintext by default with an honest notice; encryption opt-in later. | — Pending |
| Signature-derived key is the vault's eventual mechanism | MetaMask's `eth_getEncryptionPublicKey`/`eth_decrypt` are deprecated and removed. The viable path is `wallet.sign(fixed message)` → HKDF → AES-GCM, key in memory only. Caveat: relies on RFC 6979 deterministic ECDSA, which is convention not spec — so it needs a recovery path. | — Pending |
| Privacy notice states the plaintext limitation | "No backend" is true but insufficient while the API key sits readable in `localStorage` and renders in a visible input. Saying so is the honest version. | — Pending |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd-complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-08-19 after initialization*
