# Phase 1: Global Settings & Ethereum Credentials - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-08-20
**Phase:** 1-Global Settings & Ethereum Credentials
**Areas discussed:** Credential masking rule, Storage namespacing (emergent), Save model & validation, Cross-tab refresh (SET-10), Page layout & discoverability, Ethereum plugin definitions, DxKit feature requests

---

## Credential Masking Rule

**How the generic renderer identifies a credential-like field**

| Option | Description | Selected |
|--------|-------------|----------|
| Key-name heuristic | Regex on the definition key (`/key\|secret\|token\|password/i`). Zero config, generic, but false-positives on names like `publicKey`. | |
| Local section:key registry | A `SECRET_FIELDS` const in the settings dapp. Explicit and exact; costs an edit per new credential-bearing dapp. | ✓ |
| Marker in the definition | A dotdev convention the plugin author opts into. Generic and declarative; costs a documented convention. | |
| Heuristic + registry override | Regex by default with a force-mask/force-unmask escape hatch. | |

**User's choice:** Local section:key registry
**Notes:** Accepted as a knowing dent in "no per-dapp code" — the settings dapp now names `ethereum`.

**What a masked field shows**

| Option | Description | Selected |
|--------|-------------|----------|
| Password dots | `input type="password"` until revealed; toggle flips the type attribute. | ✓ |
| Fingerprint, not the value | `set · …a3f9` / `not set` as read-only text with an Edit action. | |
| Dots + 'set' hint | Password dots plus a label indicating whether a value is configured. | |

**User's choice:** Password dots

**Reveal toggle behaviour**

| Option | Description | Selected |
|--------|-------------|----------|
| Sticky until navigate away | Stays visible while the dapp is mounted; re-masks on unmount. | ✓ |
| Re-mask on blur | Visible only while focused. Shoulder-surfing resistant; fights cross-window comparison. | |
| Sticky + auto-hide timer | Re-masks itself after ~30s. Adds a timer to own and cancel. | |

**User's choice:** Sticky until navigate away

**What DX-01 should ask upstream for**

| Option | Description | Selected |
|--------|-------------|----------|
| `type: 'secret'` | A sixth `SettingDefinition.type`. Clean switch arm; loses composability with validation. | |
| `secret?: boolean` flag | Orthogonal, non-breaking, composes with any type and with validation. | ✓ |
| Both — flag now, storage later | The flag scoped as display-only, with at-rest protection explicitly deferred to DX-02. | |

**User's choice:** `secret?: boolean` flag

**Where the registry lives**

| Option | Description | Selected |
|--------|-------------|----------|
| In the settings dapp | A const beside the renderer that consumes it. | ✓ |
| On the ethereum plugin | Plugin exports its own secret-key list; renderer collects from any plugin exposing one. | |
| A shared local module | A neutral `src/settings-secrets.ts` listing every section:key site-wide. | |

**User's choice:** In the settings dapp

---

## Storage Namespacing

*Emergent area — raised by the user mid-discussion, not one of the four originally selected.*

**User's question:** "is there an override in dxkit/setting to set where the settings key/vals live?
I realize that any app built on dxkit on the same origin will share settings which I don't want.
can that be overridden to be `<app>` prefixed?"

**Finding:** Yes — `storageKey` exists on all three plugins (settings, theme, wallet) with no upstream
change needed. Also surfaced that theme has an installed base under `dxkit:theme` and that the inline
FOUC script in `src/index.html` reads that key literal before any module loads.

**Namespacing scope**

| Option | Description | Selected |
|--------|-------------|----------|
| Namespace settings + wallet only | Leave theme on `dxkit:theme` so existing visitors keep their theme and the FOUC script is untouched. Inconsistent keys. | |
| Namespace all three, migrate theme | One-time read of the old theme key, written forward. Consistent and nothing orphaned; touches FOUC script and shell theme wiring. | |
| Namespace all three, accept the reset | Clean prefix everywhere, no migration; returning visitors re-pick their theme once. | ✓ |

**User's choice:** Namespace all three, accept the reset

**Key shape**

**User's question:** "can it be double keys? like `dnzn:dotdev:settings`? so the future app could be
`dnzn:<otherapp>:settings`?"

**Finding:** Yes — `storageKey` is opaque and passed straight to `localStorage.setItem`. Colons carry
no meaning to DxKit. Also corrected: the JSDoc calls it a "key prefix" but it is the entire key.

| Option | Description | Selected |
|--------|-------------|----------|
| `dnzn:dotdev:<concern>` | Org, then app (repo name), then concern. | ✓ |
| `dnzn:dnzn.dev:<concern>` | App segment is the deployed domain rather than the repo name. | |

**User's choice:** `dnzn:dotdev:<concern>`

**Enforcement**

| Option | Description | Selected |
|--------|-------------|----------|
| Just write the three strings | Literals at each registration site. Risk: Phase 2 forgets the wallet key. | |
| One local const, composed | `STORAGE_NS` in main.ts; FOUC script still needs its own literal. | |
| Const now, plus a DX-04 request | The const, plus a new upstream request for an app-level namespace on `createShell`. | ✓ |

**User's choice:** Const now, plus a DX-04 request

**Privacy notice specificity**

| Option | Description | Selected |
|--------|-------------|----------|
| Name the storage key | Full notice plus `dnzn:dotdev:settings`, readable by any script on this origin and by devtools. | ✓ |
| State the limitation generally | The SET-08 claims without naming the key or mechanism. | |
| Named key + inline per-field hint | Full notice plus a repeated per-field plaintext caveat. | |

**User's choice:** Name the storage key

---

## Save Model & Validation

**When an edit reaches `dx.settings.set()`**

| Option | Description | Selected |
|--------|-------------|----------|
| Live on change/blur | No Save button, no dirty state; invalid values must be blocked at the field. | |
| Explicit Save per section | Per-section Save/Reset with dirty state. Initially selected, then withdrawn. | |
| Live, with per-field undo | Live-save plus a revert-to-default control per field. | |
| **Per-field commit (user-authored)** | A small check button per input field commits, with a revert control beside it; booleans/selects live-update. | ✓ |

**User's choice:** Per-field commit — the user's own reframing after initially picking explicit
per-section Save.
**Notes:** Verbatim: "i don't think we should save gate (button) now on a per section - i'm wondering
if we can have a small 'check box' button (save) and 'revert to defaults' button next to that.
uniform - all input fields have that. then booleans, select boxes, etc can all live update on
select/set/etc." This resolved the `_shell` toggle problem raised in the follow-up — those bridge
into `dx.enableDapp()` on change, so a Save gate would have made SET-09 feel inert.

**What revert reverts to**

| Option | Description | Selected |
|--------|-------------|----------|
| The `SettingDefinition` default | Restores and commits the declared default; doubles as clear-the-credential. | ✓ |
| The last saved value | Cancel-edit rather than reset; no path back to the declared default. | |
| Both controls | Cancel-edit while dirty plus always-available revert-to-default; up to four controls in a masked gutter. | |

**User's choice:** The `SettingDefinition` default

**Control layout** (a masked field needs reveal + save + revert; `.input-wrap` has one slot today)

| Option | Description | Selected |
|--------|-------------|----------|
| Widen the suffix into a control strip | 1-3 icon buttons inside the field; padding scales to count. Edits shared CSS that CIC uses. | ✓ |
| Reveal inside, save/revert outside | Reveal in the existing suffix; commit controls as an adjacent `.btn-group`. No shared-CSS change. | |
| Controls on a row below the field | Shown only when dirty; zero gutter pressure, but layout shifts as you type. | |

**User's choice:** Widen the suffix into a control strip

**Validation timing**

| Option | Description | Selected |
|--------|-------------|----------|
| Validate on input, gate the check | Errors as you type; nothing invalid can reach `set()`. Nags on pattern-constrained fields. | |
| Validate on commit attempt | Quiet while typing; validates and refuses on check. | ✓ |
| Validate on blur and on commit | Middle ground; two trigger points to keep consistent. | |

**User's choice:** Validate on commit attempt

**Enter key and navigate-away**

| Option | Description | Selected |
|--------|-------------|----------|
| Enter commits, leaving discards | Simplest; silent loss if someone types and clicks away. | |
| Enter commits, warn on leaving | Confirm dialog on dirty unmount; two hooks and the site's first modal. | |
| Enter commits, dirty stays marked | Visible dirty state throughout; discarded on leave, but never ambiguous. | ✓ |

**User's choice:** Enter commits, dirty stays marked

---

## Cross-Tab Refresh (SET-10)

*The user asked for explicit recommendations at this point; all subsequent options were presented
with a recommended choice and rationale.*

**How far to go**

| Option | Description | Selected |
|--------|-------------|----------|
| Re-render + replay through API *(recommended)* | Diff the storage blob against `get()`, replay differences through `set()`; repaints the form and corrects the stale in-memory store. Self-terminating via diff-before-write. | ✓ |
| Re-render from raw localStorage | Least code; but the form would show a new key while `get()` still hands the old one to decode. | |
| Storage event triggers a banner | Honest and cheap, but requires the reload SET-10 asked to avoid. | |

**User's choice:** Re-render + replay through API
**Notes:** The deciding argument was milestone-specific — Phase 5's decode dapp reads these
credentials via `dx.settings.get()`, so a stale in-memory store is a real bug in the thing this
phase exists to provide.

**Cross-tab change lands on a dirty field**

| Option | Description | Selected |
|--------|-------------|----------|
| Skip dirty fields *(recommended)* | Repaint clean fields only; the store is still corrected. | ✓ |
| Overwrite everything | Form always mirrors the store; destroys in-progress typing. | |
| Skip dirty, flag the conflict | Real conflict-resolution UI for a two-tabs-same-field case. | |

**User's choice:** Skip dirty fields

**Upstream request**

| Option | Description | Selected |
|--------|-------------|----------|
| Yes — new DX-05 *(recommended)* | Settings plugin owns cross-tab sync; kept separate from DX-02. | ✓ |
| Fold into DX-02 | Fewer documents, but bundles a sync bug into a storage-architecture proposal. | |
| No request — just the workaround | Ship the workaround silently. | |

**User's choice:** Yes — new DX-05

**Same-tab external changes**

| Option | Description | Selected |
|--------|-------------|----------|
| Subscribe to `dx:plugin:settings:changed` *(recommended)* | The supported path; already emitted on every `set()`. | ✓ |
| Re-read on window focus | A poll dressed as an event; does nothing for a same-tab change while focused. | |
| Storage event only | Does not fire in the writing tab — invisible for exactly this case. | |

**User's choice:** Subscribe to the changed event

---

## Page Layout & Discoverability

**Section order**

| Option | Description | Selected |
|--------|-------------|----------|
| Pin a local order, unknowns after *(recommended)* | `ethereum` first, `_shell` last; unnamed sections still render. | ✓ |
| Raw `getSections()` order | Buries credentials under dapp toggles by Map insertion order. | |
| Alphabetical by label | Deterministic but arbitrary to the reader; breaks on rename. | |

**User's choice:** Pin a local order, unknowns after

**Reaching /settings** (`shell.ts:57` hardcodes `groupOrder = ['main','tools']`)

| Option | Description | Selected |
|--------|-------------|----------|
| Header gear button *(recommended)* | In `.header-actions` beside the theme trigger; `nav.hidden: true`. | ✓ |
| App dropdown under 'main' | Zero shell.ts change; reads as a content page alongside About/Projects. | |
| Deep-link only | Undiscoverable until Phase 2 ships; contradicts SET-02. | |

**User's choice:** Header gear button

**Section presentation**

| Option | Description | Selected |
|--------|-------------|----------|
| Stacked cards, narrow layout *(recommended)* | Reuses `.card`/`.card-title`; route isn't `/tools/*` so narrow is automatic. | ✓ |
| Tabs per section | Keeps the page short as sections multiply; hides the privacy notice. | |
| Cards in the wide tool grid | Requires overriding the shell's route-driven layout logic. | |

**User's choice:** Stacked cards, narrow layout

**Empty sections**

| Option | Description | Selected |
|--------|-------------|----------|
| Omit sections with no definitions *(recommended)* | `dependsOn`-disabled fields still render; only truly empty sections skipped. | ✓ |
| Render every section with a placeholder | A complete inventory, but puts empty furniture on the page. | |
| Omit empty, and hide fully-disabled sections too | Disorienting — removes the route back to the enabling control. | |

**User's choice:** Omit sections with no definitions

**Style ownership**

| Option | Description | Selected |
|--------|-------------|----------|
| Split by ownership *(recommended)* | `.input-wrap` strip in components.css; settings-specific in the dapp's style.css. | ✓ |
| All in the dapp's style.css | Zero CIC risk, but forks `.input-wrap` into two implementations. | |
| All in components.css | Grows a global file with single-use rules. | |

**User's choice:** Split by ownership

**Multiselect rendering** (no style exists today)

| Option | Description | Selected |
|--------|-------------|----------|
| Checkbox list in the field slot *(recommended)* | No new component vocabulary; all options visible. | ✓ |
| Native `<select multiple>` | Least code; ctrl-click deselect is a poor affordance. | |
| Reuse `.btn-group` as toggles | Most on-brand; degrades past ~5 options. | |

**User's choice:** Checkbox list in the field slot

---

## Ethereum Plugin Definitions

**How `chainId` is declared**

| Option | Description | Selected |
|--------|-------------|----------|
| `select` over a small chain table *(recommended)* | Options come from the chainId → explorer table Phase 5 needs; one source of truth. | ✓ |
| `number` with validation | Admits chains with no explorer URL, pushing an unknown-chain branch into Phase 5. | |
| `select` plus a custom escape | `dependsOn` keys off a boolean sibling, so a select-driven reveal isn't supported generically. | |

**User's choice:** `select` over a small chain table

**Which chains seed the table**

| Option | Description | Selected |
|--------|-------------|----------|
| Mainnet only *(recommended)* | Every handoff §7 vector is mainnet; REQUIREMENTS scopes multi-chain out. | |
| Mainnet + Sepolia | Adds a testnet; implies per-chain explorer API resolution in Phase 5. | ✓ |
| Mainnet + major L2s | Each L2 needs its own host and conventions; promises what Phase 5 can't deliver. | |

**User's choice:** Mainnet + Sepolia
**Notes:** Recommendation was not taken. Flagged for Phase 5: confirm whether Etherscan's current API
takes a `chainid` parameter against one host and key, or needs per-chain hosts and key scopes.

**Defaults and validation**

| Option | Description | Selected |
|--------|-------------|----------|
| Empty credentials, working defaults *(recommended)* | Empty key/RPC with no `required`; chainId 1; etherscanRps 5 (min 1, max 5). | ✓ |
| Mark credentials required | Contradicts graceful degradation; paints a first visit red for a valid state. | |
| Add a URL pattern to rpcUrl | Catches paste errors but rejects legitimate local `ws://` or IPC endpoints. | |

**User's choice:** Empty credentials, working defaults

---

## DxKit Feature Requests

**Document shape** (five requests: DX-01 through DX-05)

| Option | Description | Selected |
|--------|-------------|----------|
| One file each, shared template *(recommended)* | `tmp/dxkit-fr-<slug>.md`; one file maps onto one DxKit commit. | ✓ |
| One combined document | Reads as one narrative, but bundles independent changes of very different sizes. | |
| One file each, plus an index | The five files plus a priority/dependency README. | |

**User's choice:** One file each, shared template

---

## Claude's Discretion

- Gear button icon and active/open state — match the existing inline-SVG style in `renderHeader`
- Exact privacy-notice copy, provided every claim in D-31 is made
- Whether check/revert controls use glyphs or inline SVG, and their hit targets
- The `DAPP_TITLES` entry for the settings dapp

## Deferred Ideas

- Conflict-resolution UI for cross-tab edits on a dirty field
- Migrating existing `dxkit:theme` values forward instead of accepting the reset
- A fingerprint display for secrets (`set · …a3f9`) instead of password dots
- Chains beyond mainnet and Sepolia (Base, Arbitrum, Optimism)
- The wallet-encrypted settings vault — already tracked as v2 (VLT-01…VLT-05)
