# Roadmap: DNZN // DEV — decode milestone

## Overview

This milestone ships three things: a global settings surface for shared Ethereum credentials, wallet
identity in the shell, and a new `decode` dapp whose flagship capability is recursive Ethereum
calldata decoding. Settings (Phase 1) and Wallet (Phase 2) are independent workstreams with no
dependency on the decode dapp or on each other, per PROJECT.md Key Decisions, and can be built in
parallel with everything else.

The decode dapp itself is sliced vertically per its MVP mode. Phase 3 builds the dapp shell and
proves the `DecodeNode`-tree render contract and the port interfaces end-to-end with the simplest
possible real decoder (`hex`) before any Ethereum complexity exists — this is the cheap moment to
get those two abstractions right. Phase 4 stresses that same, unmodified contract with three more
decoder shapes (`base64`'s JSON pretty-print, `url`'s query-param table, `jwt`'s dates-and-banner,
`abi-words`' word annotations). Phase 5 builds the low-risk pure codecs (keccak-256, the full ABI
decoder) properly and completely, once, and delivers single-call Ethereum decoding together with the
network transport and live log — registry lookups (openchain/4byte) need a working transport from
the very first Ethereum decode, so transport cannot be deferred past this phase without breaking the
vertical-slice rule. Phase 6 adds recursion — the actual reason this project exists — reading a
Majeur proposal's nested calls all the way down, exactly as the Python reference tool does.

75 v1 requirements map across 6 phases. Standard granularity nominally targets 4-8 phases; 6 stays
within that band despite the requirement count because each phase is a genuinely coherent,
independently verifiable capability grounded directly in `plans/decoder-dapp-handoff.md`'s
acceptance checklist (§11) and test vectors (§7) — none of the phases below are horizontal layers or
filler work. The <60KB-uncompressed-JS budget (DEC-16) is tracked as a running total via an explicit
**Size checkpoint** reported at the close of Phases 3, 4 and 5, and confirmed against all
first-wave decoders at the close of Phase 6, so an overrun surfaces while it is still cheap to act on.

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

- [ ] **Phase 1: Global Settings & Ethereum Credentials** - A generic, honest settings surface plus a global `ethereum` plugin owning shared credentials
- [ ] **Phase 2: Wallet Identity in the Shell** - Connect, view, and disconnect a browser wallet from the shell header
- [ ] **Phase 3: Decode Dapp Shell & the DecodeNode Contract** - The decode dapp exists, is URL-addressable and portable, and proves the render contract via `hex`
- [ ] **Phase 4: Text Decoder Catalogue** - `base64`, `url`, `jwt`, and `abi-words` stress the same contract with new render shapes
- [ ] **Phase 5: Ethereum Calldata Decoding — Single Call & Live Network Log** - One real function call, decoded correctly, resilient to rate limits, visible in a redacted live log
- [ ] **Phase 6: Recursive Ethereum Calldata Decoding** - Nested calls, all the way down — the core value of the milestone

## Phase Details

### Phase 1: Global Settings & Ethereum Credentials
**Goal**: A person can configure the Ethereum credentials every other part of this milestone depends
on, and manage any dapp's settings, from one generic screen that is honest about being unencrypted.
**Mode:** mvp
**Depends on**: Nothing (first phase)
**Requirements**: SET-01, SET-02, SET-03, SET-04, SET-05, SET-06, SET-07, SET-08, SET-09, SET-10, DX-01, DX-02, DX-03
**Success Criteria** (what must be TRUE):
  1. User can reach `/settings` and see a section for every entry `dx.settings.getSections()` returns — dapp, plugin, and `_shell` alike — each field rendered per its `SettingDefinition.type` and `validation`, with no per-dapp code (SET-02, SET-03, SET-04)
  2. User can set the `ethereum` plugin's `etherscanApiKey`, `rpcUrl`, `chainId`, and `etherscanRps`, credential-like fields render masked with a reveal toggle, and any field declaring `dependsOn` visibly greys out while its sibling boolean is falsy (SET-01, SET-05, SET-07)
  3. A user's edits persist through `dx.settings.set()`, survive a page reload, and an external change (another tab) refreshes the open form live without a reload (SET-06, SET-10)
  4. User can enable and disable an optional dapp (e.g. TPL) from the `_shell` section (SET-09)
  5. The settings page states plainly that values live in this browser only, that there are no backend servers, that nothing is sent to DNZN, and that credentials are currently stored and displayed in plaintext — and `tmp/` gains feature requests for a secret setting type, a pluggable/encryptable settings store, and app-level shell settings registration (SET-08, DX-01, DX-02, DX-03)
**Plans**: TBD
**UI hint**: yes

### Phase 2: Wallet Identity in the Shell
**Goal**: A person can connect their browser wallet from the shell header and see it stay connected
across visits — identity only, no signing.
**Mode:** mvp
**Depends on**: Nothing — independent workstream, parallel-safe with Phase 1
**Requirements**: WAL-01, WAL-02, WAL-03, WAL-04, WAL-05, WAL-06, WAL-07
**Success Criteria** (what must be TRUE):
  1. The shell's wallet button opens a user dropdown, and from it a person can connect a browser (EIP-1193) wallet (WAL-01, WAL-02)
  2. While connected, the dropdown shows the shortened address with a copy control (WAL-03)
  3. A person can disconnect from the dropdown, and a previous connection restores automatically on the next page load (WAL-04, WAL-05)
  4. The dropdown links to `/settings` (WAL-06)
  5. When no wallet provider is available, the dropdown says so rather than failing silently (WAL-07)
**Plans**: TBD
**UI hint**: yes

### Phase 3: Decode Dapp Shell & the DecodeNode Contract
**Goal**: The decode dapp exists at `/tools/decode`, is URL-addressable, shareable, and portable
between DxKit shells, and every one of those behaviours is proven end-to-end through one genuinely
simple decoder (`hex`) — validating the `DecodeNode` render contract and the port interfaces while
they are still cheap to change, before any Ethereum-specific complexity is added.
**Mode:** mvp
**Depends on**: Nothing — independent workstream, parallel-safe with Phases 1-2
**Requirements**: DEC-01, DEC-02, DEC-03, DEC-05, DEC-06, DEC-07, DEC-08, DEC-09, DEC-10, DEC-11, DEC-12, DEC-14, DEC-15, DEC-17, COD-06, TXT-02
**Success Criteria** (what must be TRUE):
  1. User can reach `/tools/decode` laid out in the existing `.layout-tool` grid, choose `hex` from the decoder selector, paste a hex payload into the textarea, and press Decode (or `Ctrl/Cmd+Enter`) to see byte length and, for ≤32 bytes, the integer value — rendered as a real, generic `DecodeNode` tree, expandable/collapsible with copy-on-click, not a one-off hand-rolled view (DEC-01, DEC-02, DEC-08, DEC-09, DEC-10, DEC-11; TXT-02; COD-06; handoff §7.5 hex vector)
  2. `#/tools/decode?decoder=hex&data=<payload>` opens with that decoder and input pre-loaded, and pasting without choosing a decoder auto-selects `hex` by `canDecode()` confidence with a visible auto-detect badge — nothing requiring network runs until Decode is clicked (DEC-03, DEC-05)
  3. Copy link writes the current decoder and input into the URL via `history.replaceState` without triggering a route change, warns above ~32 KB, and offers a compressed `z=` variant built with `CompressionStream('deflate-raw')` + base64url (DEC-06, DEC-07)
  4. A malformed hex payload (odd length) renders as an error node inside the result tree, never as a modal or a thrown error (DEC-12; COD-06)
  5. The dapp directory declares `requires.plugins: ['settings']` and `standalone: false` with no dotdev-specific coupling, ships an MIT `LICENSE` and a `README.md` covering how to add a decoder, and is registered in `src/main.ts` and `tsup.config.ts` (DEC-14, DEC-15, DEC-17)
**Size checkpoint**: report the dapp's uncompressed JS total (shell + `hex` + codecs). Establishes the DEC-16 baseline — budget is <60 KB with all first-wave decoders at Phase 6.
**Plans**: TBD
**UI hint**: yes

### Phase 4: Text Decoder Catalogue
**Goal**: The same `DecodeNode`/UI contract, unmodified, correctly renders three more distinct
content shapes — proving it generalizes before the Ethereum work begins.
**Mode:** mvp
**Depends on**: Phase 3
**Requirements**: TXT-01, TXT-03, TXT-04, TXT-05, TST-02
**Success Criteria** (what must be TRUE):
  1. Pasting base64 `aGVsbG8gd29ybGQ=` decodes to `hello world`, and base64url `eyJhIjoxfQ` (no padding) decodes and pretty-prints as JSON `{"a":1}`, falling back to hex when not valid UTF-8 (TXT-01; handoff §7.5)
  2. Pasting a percent-encoded string decodes it in place, and pasting a full URL renders a table of query parameters each individually decoded (TXT-03; handoff §7.5 `a%20b%26c=1` → `a b&c=1`)
  3. Pasting a JWT renders header and payload JSON with `exp`/`iat`/`nbf` shown as dates and the signature as-is, under an explicit "signature NOT verified" banner (TXT-04; handoff §7.5)
  4. Pasting raw calldata into `abi-words` renders 32-byte words with offsets, the selector on the first line, and each word annotated address-like / small-int / offset-like / length-like (TXT-05)
  5. Offline unit tests cover all five text decoders against the handoff §7.5 vectors (TST-02)
**Size checkpoint**: report the dapp's uncompressed JS total and the delta added by the four text decoders (DEC-16 running total).
**Plans**: TBD
**UI hint**: yes

### Phase 5: Ethereum Calldata Decoding — Single Call & Live Network Log
**Goal**: A person can decode one real Ethereum function call — named arguments, correct selector
provenance, correctly formatted addresses and integers — resilient to registry rate limits, with
every request visible in a live, redacted log. This is the phase where the pure codecs (keccak-256,
the full ABI decoder) get built properly and completely, once, per project mode.
**Mode:** mvp
**Depends on**: Phase 1, Phase 3
**Requirements**: COD-01, COD-02, COD-03, COD-04, COD-05, ETH-01, ETH-05, ETH-06, ETH-07, ETH-10, ETH-11, ETH-14, DEC-04, DEC-13, NET-01, NET-02, NET-03, NET-04, NET-05, NET-06, NET-07, TST-01, TST-04
**Success Criteria** (what must be TRUE):
  1. Pasting one of the handoff §7.1 inner calldata literals (e.g. the `mintFromMoloch` call) and clicking Decode renders named arguments with a provenance badge (`VERIFIED` / `REGISTRY` / `LOCAL` / `UNRESOLVED`), matching the offline assertions from a stubbed `AbiSourcePort` (ETH-01, ETH-05; COD-01, COD-02, COD-03, COD-04; TST-01)
  2. The `claimTribute` selector (`0xac6695d1`, absent from openchain/4byte) renders as an unresolved-selector node with its raw words available under an expandable `abi-words` view, without failing the decode; a zero-argument function like `pull()` renders as a bare node, not an error (ETH-06, ETH-07; COD-05)
  3. Every address and 32-byte value renders shortened (`0x12345678...abcdef`) and linked to the configured chain's explorer, with the full value on hover and via copy; integers ≥1e15 carry an `≈ Ne18` hint and `address(0)` is annotated as the zero address (ETH-10, ETH-11, ETH-14)
  4. Forcing Etherscan's rate-limit response (handoff §7.6) produces visible retries with attempt numbers in the Log tab, honours `Retry-After`, and the decode still completes (unlabelled where needed) instead of crashing; `apikey`/`Authorization` are redacted in the log display and in both Copy as JSON and Copy as cURL (NET-03, NET-04, NET-05, NET-06, NET-07; TST-04)
  5. `#/tools/decode?calldata=0x…` opens as `eth-calldata`, and when a needed global setting is missing the UI names it and links to `/settings`, explaining what degrades without the optional ones (DEC-04, DEC-13)
**Size checkpoint**: report the dapp's uncompressed JS total and the delta added by keccak-256, the ABI codec, and the transport/log (DEC-16 running total — the largest single increment expected).
**Plans**: TBD
**UI hint**: yes

### Phase 6: Recursive Ethereum Calldata Decoding
**Goal**: The core value of this milestone — a person can paste a real Majeur proposal's outer
calldata and read every nested call, all the way down, exactly as the Python reference tool does.
**Mode:** mvp
**Depends on**: Phase 5
**Requirements**: ETH-02, ETH-03, ETH-04, ETH-08, ETH-09, ETH-12, ETH-13, NET-08, NET-09, TST-03, DEC-16
**Success Criteria** (what must be TRUE):
  1. Pasting the handoff §7.1 zOrg proposal 7 outer `executeByVotes → batchCalls` calldata recurses through all three nested calls (`mintFromMoloch`, `approve`, `claimTribute`) without stopping at the first `bytes` layer, each nested call's target resolved as the nearest sibling `address` in the same argument list (ETH-02, ETH-03; handoff §11; TST-03)
  2. With an Etherscan API key configured, the same input labels `Loot`/`Tribute` by contract name, resolves `claimTribute` as `VERIFIED`, and follows any proxy target as `(Proxy → Impl)`; with only an RPC URL configured it resolves via registries and the local table, and verified-ABI lookups are cached in memory and `localStorage` with a TTL and a size cap (ETH-04, ETH-12; NET-08, NET-09)
  3. The handoff §7.2 FWC payload shows `op: 1` with the DELEGATECALL warning explaining it runs target code in the caller's storage, and the nested `pull()` call renders as a zero-argument leaf inside the recursion, not an error (ETH-13)
  4. Pasting a real 32-byte transaction hash fetches the transaction and decodes its input against its `to`, reporting a clear error when neither an RPC URL nor an API key is configured; a deliberately deep/wide payload halts recursion with a visible warning node once a depth, node-count, or byte bound is reached (ETH-08, ETH-09)
  5. With all first-wave decoders included, the dapp's total JavaScript stays under 60 KB uncompressed (DEC-16; handoff §11 "JS payload size... reported in the PR")
**Plans**: TBD

## Progress

**Execution Order:**
Phase 1 and Phase 2 and Phase 3 are independent and parallel-safe. Phase 4 follows Phase 3. Phase 5
follows Phase 1 and Phase 3. Phase 6 follows Phase 5.

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Global Settings & Ethereum Credentials | 0/TBD | Not started | - |
| 2. Wallet Identity in the Shell | 0/TBD | Not started | - |
| 3. Decode Dapp Shell & the DecodeNode Contract | 0/TBD | Not started | - |
| 4. Text Decoder Catalogue | 0/TBD | Not started | - |
| 5. Ethereum Calldata Decoding — Single Call & Live Network Log | 0/TBD | Not started | - |
| 6. Recursive Ethereum Calldata Decoding | 0/TBD | Not started | - |
</content>
