# Phase 1: Global Settings & Ethereum Credentials - Context

**Gathered:** 2026-08-20
**Status:** Ready for planning

<domain>
## Phase Boundary

A person can configure the Ethereum credentials every other part of this milestone depends on, and
manage any dapp's settings, from one generic screen that is honest about being unencrypted.

Delivers: a dotdev-local `ethereum` DxKit plugin owning `etherscanApiKey`, `rpcUrl`, `chainId` and
`etherscanRps` under its own settings namespace; a settings dapp at `/settings` that renders a
section for every entry `dx.settings.getSections()` returns with no per-dapp code; a privacy notice
that states plainly what is and is not protected; and agent-targeted `tmp/` feature requests for
each DxKit gap this work exposes.

Not in this phase: any wallet work (Phase 2), anything in the decode dapp (Phases 3-6), and any
upstream DxKit change — gaps become `tmp/` requests, never edits to `../dxkit`.

</domain>

<decisions>
## Implementation Decisions

### Storage Namespacing

- **D-01:** All three DxKit plugin storage keys are namespaced `dnzn:dotdev:<concern>` —
  `dnzn:dotdev:settings`, `dnzn:dotdev:theme`, `dnzn:dotdev:wallet`. Motivation: any DxKit app on the
  same origin currently shares the default `dxkit:*` keys, which is not wanted. The two-level
  `org:app:concern` shape leaves room for `dnzn:<otherapp>:settings` later.
  — **Reversibility:** costly — changing the scheme again orphans stored values a second time, and
  the theme key is duplicated in the inline FOUC script, so a rename must be made in two places or
  the pre-paint read silently misses.
- **D-02:** Keys are composed from a single `STORAGE_NS = 'dnzn:dotdev'` const in `src/main.ts`
  (`` `${STORAGE_NS}:settings` `` etc.), not written out as three independent literals — so Phase 2
  adding the wallet plugin cannot silently land back on `dxkit:wallet`.
- **D-03:** The inline FOUC script in `src/index.html` reads the theme key before `main.js` loads and
  therefore needs its own literal. This duplicate is accepted and must be called out in the plan as a
  keep-in-sync point.
- **D-04:** Existing `dxkit:theme` values are **not** migrated. Returning visitors fall back to system
  mode once and re-pick. Chosen over a migration read for a clean, consistent scheme.
  — **Reversibility:** one-way — once a visitor's next page load writes the new key, the old value is
  no longer authoritative; a migration added later would restore stale preferences over newer ones.
- **D-05:** `storageKey` is confirmed available on all three plugins (`plugins/settings/src/index.ts:11`,
  `plugins/theme/src/index.ts:16`, `plugins/wallet/src/index.ts:156`) — this needs **no** upstream
  change. Correction for the plan: the JSDoc calls it a "localStorage key prefix" but it is the entire
  key for one JSON blob, not a prefix DxKit composes onto.

### Credential Masking (SET-07)

- **D-06:** Credential-like fields are identified by an explicit local registry — a
  `SECRET_FIELDS` const mapping section id → key list, e.g. `{ ethereum: ['etherscanApiKey'] }`.
  Rejected: a key-name regex heuristic (false positives on names like `publicKey`) and a marker
  convention on the definition object.
- **D-07:** The registry lives **in the settings dapp**, next to the renderer that consumes it. This
  is a knowing, documented dent in "no per-dapp code" — the settings dapp now names `ethereum` — and
  is the concrete workaround DX-01 asks upstream to remove.
- **D-08:** A masked field renders as `input type="password"` (browser-native dots). The reveal
  toggle flips the `type` attribute. No fingerprint or "set/not set" hint.
- **D-09:** Reveal is **sticky** for as long as the settings dapp is mounted, and re-masks on unmount.
  No blur-triggered re-mask, no auto-hide timer.

### Save Model & Field Controls

- **D-10:** No per-section Save button. Text and number fields commit **per field**: a small check
  button writes via `dx.settings.set()`, and a revert control sits beside it.
- **D-11:** Revert restores the field's `SettingDefinition.default` and commits it. Because
  `etherscanApiKey`'s default is empty, revert doubles as clear-the-credential. It is always
  available, not only while dirty.
- **D-12:** Booleans, selects and multiselects **live-update on change**. This keeps the `_shell`
  toggles responsive: they bridge straight into `dx.enableDapp()`/`disableDapp()` via `onChange`
  (`plugins/settings/src/index.ts:110-117`), so a Save gate would make SET-09 feel inert.
- **D-13:** Controls live inside a **widened `.input-wrap` suffix slot** as a 1-3 button control strip,
  with the input's `padding-right` scaling to the control count. A masked text field carries three:
  reveal, check, revert.
  — **Reversibility:** costly — this edits shared `.input-wrap` rules in `src/styles/components.css`
  that the CIC dapp also consumes, so undoing or reshaping it means re-verifying CIC's form.
- **D-14:** Validation (`required` / `min` / `max` / `pattern`) runs **on commit attempt**, not on
  every keystroke. Failure shows the error and refuses the write. The check button stays enabled
  while dirty.
- **D-15:** `Enter` in a text field is a keyboard alias for the check button.
- **D-16:** A dirty uncommitted field is **visibly marked** (accent border plus an active check
  button) and is **discarded on unmount**. No confirm dialog and no `beforeunload` hook — this site
  has no modals and should not gain its first one here.

### Cross-Tab & External Refresh (SET-10)

- **D-17:** On the `storage` event for `dnzn:dotdev:settings`, parse the blob, **diff it against
  `dx.settings.get()`, and replay only the differences through `dx.settings.set()`**. This repaints
  the form *and* corrects the plugin's in-memory `store` Map.
  Rationale, load-bearing for the milestone: repainting from raw `localStorage` alone would leave the
  form showing a new API key while `dx.settings.get('ethereum', …)` still hands the old one to the
  decode dapp in Phase 5 — the screen and the API disagreeing is worse than not updating.
- **D-18:** Diff-before-write is what makes D-17 self-terminating: the receiving tab's `persist()`
  fires the origin tab's `storage` event, which diffs to zero differences and writes nothing. The
  plan must preserve that ordering — writing before diffing creates a two-tab write loop.
- **D-19:** A field marked dirty is **not** repainted by an external change; clean fields are. The
  in-memory store is still corrected either way — only the visible input is held back. Follows
  directly from D-16: an uncommitted edit belongs to the user.
- **D-20:** Same-tab external changes (a future shell UI) are picked up by subscribing to
  `dx:plugin:settings:changed` on the event bus and repainting that one field unless dirty. Necessary
  because the `storage` event does not fire in the tab that made the write. Unsubscribe in the dapp's
  cleanup closure.

### Page Layout & Discoverability

- **D-21:** Section order is pinned by a small local `SECTION_ORDER` list — `ethereum` first, dapp
  sections next, `_shell` last — with any unnamed section rendering after in returned order, so a
  future dapp still appears with no code change. Rejected raw `getSections()` order (Map insertion
  order puts plugins last, burying the credentials) and alphabetical (arbitrary to the reader).
- **D-22:** `/settings` is reached from a **gear button in `.header-actions`**, beside the theme panel
  trigger, with `nav.hidden: true` on the manifest so it stays out of the app dropdown. Settings is
  chrome, not a destination like Projects or CIC. Note: `shell.ts:57` hardcodes
  `groupOrder = ['main','tools']`, so inventing a new nav group would render nothing.
- **D-23:** Sections render as **stacked `.card`s in a single column, narrow layout**, with
  `.card-title` as each heading and the privacy notice at the top. The route is `/settings`, not
  `/tools/*`, so the shell already picks narrow (`shell.ts:268`) — no layout override needed. Tabs
  rejected: three sections today, and tabs would hide the privacy notice.
- **D-24:** A section whose `definitions` array is empty is **omitted**. Fields disabled by
  `dependsOn` still render (greyed), and a section is never hidden merely because all its fields are
  disabled — that would remove the user's route back to the control that re-enables them.
- **D-25:** Styles split by ownership: the `.input-wrap` control-strip extension goes in
  `src/styles/components.css` (shared component, CIC inherits it, reviewers look there); everything
  settings-specific — section cards, privacy notice, checkbox list, dirty state — goes in
  `src/dapps/settings/style.css`.
- **D-26:** `type: 'multiselect'` renders as a **vertical checkbox list** inside the `.input-group`,
  committing live per D-12. No multiselect style exists today. Native `<select multiple>` rejected
  (ctrl-click deselect is a poor affordance); `.btn-group` toggles rejected as the default (degrades
  past ~5 options, and multiselect declares no option-count bound).

### The `ethereum` Plugin

- **D-27:** `chainId` is `type: 'select'` whose options come from the same chainId → explorer table
  Phase 5 needs for its address links. One source of truth: a chain is selectable exactly when we
  know how to link to its explorer. Rejected `type: 'number'` (would admit chains with no explorer
  URL, pushing an unknown-chain branch into Phase 5) and a select-plus-custom-escape (`dependsOn`
  keys off a **boolean** sibling, so a select-driven reveal is not something the generic renderer
  supports).
- **D-28:** The initial table is **mainnet + Sepolia** — chainId 1 and 11155111. Downstream note for
  Phase 5: this means the transport must resolve an explorer API host per chain; Phase 5 research
  should confirm whether Etherscan's current API accepts a `chainid` parameter against one host and
  one key, or requires per-chain hosts and key scopes. That answer changes the transport's shape.
- **D-29:** Field defaults and validation: `etherscanApiKey` and `rpcUrl` default to empty strings
  with **no** `required` flag; `chainId` defaults to `1`; `etherscanRps` defaults to `5` with
  `min: 1`, `max: 5`. "Bring your own credentials" means the app must be fully valid with none set —
  decoders degrade gracefully, and a first-time visitor's settings page must not render red for a
  state that is legitimately fine. No `pattern` on `rpcUrl` (would reject a legitimate local
  `ws://` or IPC endpoint).
- **D-30:** The plugin is registered as `ethereum:` in the `plugins` object of
  `src/main.ts` — the key becomes the settings namespace via
  `Object.entries(dx.getPlugins())` (`plugins/settings/src/index.ts:126-133`), which is what makes a
  global namespace work with zero upstream change.

### Privacy Notice (SET-08)

- **D-31:** The notice states: values live in this browser only, there are no backend servers,
  nothing is sent to DNZN, credentials are stored and displayed in plaintext — **and names the
  storage key**, `dnzn:dotdev:settings`, noting it is readable by any script on this origin and by
  devtools. The audience is technical; naming the key costs nothing and is the honest version.
  Masking is stated to be presentation only. No per-field inline plaintext hint.

### DxKit Feature Requests

- **D-32:** Five requests, expanded from the three the roadmap names:
  - **DX-01** — a `secret?: boolean` flag on `SettingDefinition`, **not** a sixth `type`. Orthogonal
    and non-breaking, so any type can be marked sensitive and `validation`/`pattern` still compose.
    This is precisely what D-06's local registry emulates.
  - **DX-02** — a pluggable/encryptable settings store, noting `persist()`/`restore()` are
    synchronous (`plugins/settings/src/index.ts:49,67`) while WebCrypto is async.
  - **DX-03** — app-level shell settings registration, since `_shell` is hard-coded to optional-dapp
    toggles and overwritten (`plugins/settings/src/index.ts:110`).
  - **DX-04** *(new)* — an app-level storage namespace on `createShell` that plugins inherit, so no
    app has to remember a `storageKey` per plugin. Include the JSDoc correction from D-05.
  - **DX-05** *(new)* — cross-tab sync owned by the settings plugin: listen to its own storage key,
    reconcile the in-memory store, emit `dx:plugin:settings:changed`. Deliberately kept **separate**
    from DX-02 so this small fix is not hostage to the storage-architecture proposal.
- **D-33:** One file per request, `tmp/dxkit-fr-<slug>.md`, on a shared template: problem, how dotdev
  works around it today, proposed API, blast radius on existing DxKit consumers. One file maps onto
  one DxKit commit and each can be filed independently. Rejected a single combined document.

### Claude's Discretion

- The gear button's icon and its active/open state — match the existing inline-SVG style in
  `renderHeader` (`src/shell.ts:88-98`).
- Exact copy wording of the privacy notice, provided it makes every claim in D-31.
- Whether the check/revert controls use glyphs or inline SVG, and their exact hit targets.
- The `DAPP_TITLES` entry for the settings dapp (`src/shell.ts:229`).

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Project decisions
- `.planning/PROJECT.md` — Key Decisions table; the ethereum-plugin-not-manifest-settings decision,
  the generic-renderer decision, and the verified DxKit facts that shape this phase
- `.planning/REQUIREMENTS.md` — SET-01…SET-10 (lines 13-22) and DX-01…DX-03 (lines 109-111)
- `.planning/ROADMAP.md` §"Phase 1" (lines 46-59) — goal and the five success criteria

### DxKit source (read-only — no upstream edits this milestone)
- `../dxkit/src/types/settings.ts` — `SettingDefinition`, `SettingsSection`, `Settings`. Confirms
  the five types, the absence of any secret flag, and that `dependsOn` references a **boolean**
  sibling
- `../dxkit/plugins/settings/src/index.ts` — the implementation this phase renders from.
  Load-bearing lines: `21` (storageKey default), `49`/`67` (synchronous persist/restore),
  `96-117` (`_shell` synthesis and the enable/disable bridge), `126-133` (plugin namespace
  derivation), `167` (`dx:plugin:settings:changed` emission), `189-203` (`getSections()` order and
  disabled-dapp filtering)
- `../dxkit/plugins/theme/src/index.ts:16` and `../dxkit/plugins/wallet/src/index.ts:156` — the
  other two `storageKey` options renamed under D-01

### Codebase maps
- `.planning/codebase/STRUCTURE.md` — "Where to Add New Code" → new interactive dapp checklist
- `.planning/codebase/CONVENTIONS.md`, `.planning/codebase/ARCHITECTURE.md`

### Downstream (context only — do not implement)
- `plans/decoder-dapp-handoff.md` — the decode spec. Relevant here only for R19 (chainId → explorer
  table, which D-27 makes the source of truth for `chainId`'s select options)

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `.card` / `.card-title` (`src/styles/components.css:45,50`) — one card per settings section per D-23
- `.input-group` / `.input-group label` / `.hint` (`components.css:67-74`) — field row, label, help text
- `.input-wrap` with `.prefix`/`.suffix` slots (`components.css:76-95`) — the control strip of D-13
  extends this; note `.input-wrap.has-suffix input { padding-right: 36px }` is sized for exactly one control
- Styled bare `select` (`components.css:2`) — covers `type: 'select'` with no new CSS
- `.btn-group` with `aria-checked` (`components.css:27-41`, wiring pattern at `src/dapps/cic/cic.ts:573-577`) — booleans
- `.divider` (`components.css:103`) — between fields or sections
- The `tpl` dapp (`src/dapps/tpl/`) exists as the scaffold for a new dapp directory

### Established Patterns
- Fetch-template: HTML in `template.html`, behaviour wired in TS by querying **scoped to the
  container** — never `document.querySelector`
- IIFE + `window` namespace for domain logic, loaded via manifest `dependencies` before `entry`;
  no `import` across files at runtime
- `init()` returns a cleanup closure; every listener registered must be released on `dx:unmount`
  (critical here — D-17's `storage` listener and D-20's event-bus subscription both leak otherwise)
- New `.ts` files must be added to `tsup.config.ts` `entry`
- Theme colours come from CSS custom properties; never hardcode a colour

### Integration Points
- `src/main.ts` — register the `ethereum` plugin in `plugins` (D-30), add
  `{ manifest: 'dapps/settings/manifest.json' }` to `dapps`, and pass `storageKey` to all three
  plugins from `STORAGE_NS` (D-02)
- `src/shell.ts:88-98` (`renderHeader` → `.header-actions`) — the gear button of D-22, wired
  alongside the existing theme-panel and share handlers in `wireDropdowns`
- `src/shell.ts:229` (`DAPP_TITLES`) — needs a `settings` entry or the header title falls back
- `src/index.html` — inline FOUC script's theme-key literal (D-03)
- `src/types/globals.d.ts` — declare the `ethereum` plugin factory and any new `window` namespace
- `src/styles/components.css` — the shared `.input-wrap` change of D-13/D-25

</code_context>

<specifics>
## Specific Ideas

- The per-field commit affordance was the user's own reframing, and it displaced an explicit
  per-section Save: "a small check box button (save) and revert to defaults button next to that.
  uniform - all input fields have that. then booleans, select boxes, etc can all live update."
- The namespacing requirement came from noticing that DxKit apps sharing an origin would share
  settings: "any app built on dxkit on the same origin will share settings which I don't want."
  The two-level shape was explicitly requested so a sibling app becomes `dnzn:<otherapp>:settings`.
- `_shell` toggles must remain instantly responsive — a Save gate on the TPL toggle would leave the
  nav updating a beat late, which reads as a bug.

</specifics>

<deferred>
## Deferred Ideas

- **Conflict-resolution UI for cross-tab edits** — flagging a dirty field as conflicting with a newer
  external value, with a "take theirs" control. Considered and rejected for this phase: it needs two
  tabs open on the same field simultaneously, and D-19's skip-dirty rule covers the case adequately.
- **Migrating existing `dxkit:theme` values forward** — deliberately not done (D-04). If the one-time
  reset proves noticeable, a migration read is a small, self-contained follow-up.
- **A settings-page fingerprint display for secrets** (`set · …a3f9` instead of dots) — better at
  answering "is anything in there?", but a second input state to build. Revisit if DX-01 lands
  upstream and the renderer is being reworked anyway.
- **Chains beyond mainnet and Sepolia** (Base, Arbitrum, Optimism) — each needs its own explorer host
  and API conventions. REQUIREMENTS scopes multi-chain UX out; revisit only when Phase 5's transport
  has been exercised against a second chain.
- **The wallet-encrypted settings vault** — already tracked as v2 (VLT-01…VLT-05). DX-02 and DX-05
  are its groundwork.

</deferred>

---

*Phase: 1-Global Settings & Ethereum Credentials*
*Context gathered: 2026-08-20*
