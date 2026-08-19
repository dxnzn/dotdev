# Requirements: DNZN // DEV — decode milestone

**Defined:** 2026-08-19
**Core Value:** A person can paste nested ABI-encoded calldata and read what it actually does, all the way down, in a browser that sends nothing to DNZN.

Source of truth for decoder behaviour is `plans/decoder-dapp-handoff.md`. Where this document and
the handoff disagree, this document wins — the corrections are recorded in PROJECT.md Key Decisions.

## v1 Requirements

### Global Settings

- [ ] **SET-01**: An `ethereum` DxKit plugin registers `etherscanApiKey`, `rpcUrl`, `chainId` and `etherscanRps` under its own settings namespace, readable by any dapp via `dx.settings.get('ethereum', key)`
- [ ] **SET-02**: User can reach a settings dapp at `/settings`
- [ ] **SET-03**: The settings dapp renders a section for every entry returned by `dx.settings.getSections()` — dapp, plugin and `_shell` alike — with no per-dapp code
- [ ] **SET-04**: Each field renders according to its `SettingDefinition.type` (text, number, boolean, select, multiselect) and enforces its `validation` constraints (required, min, max, pattern)
- [ ] **SET-05**: A field declaring `dependsOn` is visibly disabled while its referenced boolean sibling is falsy
- [ ] **SET-06**: A user's edits persist through `dx.settings.set()` and survive a page reload
- [ ] **SET-07**: Credential-like settings render masked with a reveal toggle, since DxKit has no secret setting type
- [ ] **SET-08**: The settings dapp states plainly that values are stored in this browser only, that there are no backend servers, that nothing is sent to DNZN, and that credentials are currently stored and displayed in plaintext
- [ ] **SET-09**: User can enable and disable optional dapps (e.g. TPL) from the `_shell` section
- [ ] **SET-10**: An external settings change (another tab, a future shell UI) refreshes the open form without a reload

### Wallet

- [ ] **WAL-01**: The shell's wallet button is enabled and opens a user dropdown
- [ ] **WAL-02**: User can connect a browser (EIP-1193) wallet from the dropdown
- [ ] **WAL-03**: While connected, the dropdown shows the shortened address and offers a copy control
- [ ] **WAL-04**: User can disconnect from the dropdown
- [ ] **WAL-05**: A previous connection is restored automatically on the next page load
- [ ] **WAL-06**: The dropdown links to `/settings`
- [ ] **WAL-07**: When no wallet provider is available the dropdown says so rather than failing silently

### Decoder Framework

- [ ] **DEC-01**: User can reach the decode dapp at `/tools/decode`, laid out with configuration in the left column and content in the right using the existing `.layout-tool` grid
- [ ] **DEC-02**: User can choose a decoder from a selector and paste input into a single textarea
- [ ] **DEC-03**: `#/tools/decode?decoder=<id>&data=<payload>` opens with that decoder selected and that input loaded
- [ ] **DEC-04**: `calldata=<payload>` is accepted as an alias implying `decoder=eth-calldata`
- [ ] **DEC-05**: Pasting without choosing a decoder pre-selects the best match by `canDecode()` confidence and shows an auto-detect badge; nothing requiring network runs until the user clicks Decode
- [ ] **DEC-06**: User can copy a share link that writes the current decoder and input into the URL via `history.replaceState` without triggering a route change, with a warning above ~32 KB
- [ ] **DEC-07**: The share link offers a compressed `z=` variant built with `CompressionStream('deflate-raw')` and base64url
- [ ] **DEC-08**: Every decoder returns one `DecodeNode` tree and the UI renders only that tree, so a new decoder needs no UI work
- [ ] **DEC-09**: Results are presented as `Result`, `Raw` and `Log` tabs
- [ ] **DEC-10**: User can expand and collapse any node and copy any value's full underlying text
- [ ] **DEC-11**: `Ctrl/Cmd+Enter` runs the decode
- [ ] **DEC-12**: Failures appear as nodes within the result tree, never as modals or thrown errors
- [ ] **DEC-13**: A decoder missing a required global setting says which one and links to `/settings`, and explains what degrades without the optional ones
- [ ] **DEC-14**: The dapp directory is portable into any DxKit shell — it declares `requires.plugins: ['settings']`, sets `standalone: false`, and contains no dotdev-specific coupling
- [ ] **DEC-15**: The dapp ships an MIT `LICENSE` and a `README.md` covering how to add a decoder
- [ ] **DEC-16**: The dapp's total JavaScript stays under 60 KB uncompressed with all first-wave decoders included
- [ ] **DEC-17**: The dapp is registered in `src/main.ts`, its files are listed in `tsup.config.ts`, and the README dapp table is updated

### Pure Codecs

- [ ] **COD-01**: keccak-256 over `Uint8Array` implemented in-repo with no dependencies
- [ ] **COD-02**: ABI decoder handling static types, dynamic types, fixed and dynamic arrays, and nested tuples, returning `bigint` for integers
- [ ] **COD-03**: A signature parser turning `batchCalls((address,uint256,bytes)[])` into a type tree
- [ ] **COD-04**: Canonical signature expansion so tuple-bearing ABI items hash to the correct selector
- [ ] **COD-05**: Malformed offsets or lengths produce an error node instead of throwing out of the decoder
- [ ] **COD-06**: base64 (standard and url, padding-tolerant), hex (`0x` strip, odd length is an error) and strict UTF-8 validity checking

### Text Decoders

- [ ] **TXT-01**: `base64` decodes to UTF-8 when valid, otherwise hex, and pretty-prints detected JSON
- [ ] **TXT-02**: `hex` decodes to UTF-8 when valid and reports byte length plus the integer value when 32 bytes or fewer
- [ ] **TXT-03**: `url` decodes a percent-encoded string, and for a full URL renders a table of query parameters each decoded
- [ ] **TXT-04**: `jwt` renders header and payload JSON with `exp`/`iat`/`nbf` as dates and the signature as-is, under an explicit banner that the signature is NOT verified
- [ ] **TXT-05**: `abi-words` renders 32-byte words with offsets, the selector on the first line, and each word annotated as address-like, small-int, offset-like or length-like

### Ethereum Calldata Decoder

- [ ] **ETH-01**: Decodes `0x` calldata into a function node with named arguments when provenance is verified, `arg<i>` otherwise
- [ ] **ETH-02**: Recurses into any `bytes` value that is itself calldata — including inside arrays, tuples and `batchCalls`/`multicall`-style aggregators — repeatedly, until nothing decodes further
- [ ] **ETH-03**: Selects each nested call's target as the nearest sibling `address` in the same argument list, falling back to the parent's target
- [ ] **ETH-04**: Resolves selectors in order — local table, the target's verified ABI, openchain, 4byte — with a verified ABI winning whenever present
- [ ] **ETH-05**: Shows provenance on every function node as `VERIFIED`, `REGISTRY`, `LOCAL` or `UNRESOLVED`
- [ ] **ETH-06**: An unresolved selector produces a node saying so, with the raw words available under an `abi-words` view, and stops that branch without failing the decode
- [ ] **ETH-07**: A zero-argument function decodes to a bare function node, not an error
- [ ] **ETH-08**: A 32-byte transaction hash as input fetches the transaction and decodes its input against its `to`, and reports a clear error when neither an RPC URL nor an API key is configured
- [ ] **ETH-09**: Recursion is bounded by depth, node count and total bytes, emitting a warning node when a bound is reached
- [ ] **ETH-10**: Every address is shortened to `0x12345678...abcdef`, links to the correct explorer for the configured chain, and exposes its full value on hover and via copy
- [ ] **ETH-11**: Every 32-byte value renders shortened with a secondary transaction link offered as an affordance
- [ ] **ETH-12**: Address nodes gain the contract name when the ABI source knows it, patched in as lookups return without ever blocking the initial render
- [ ] **ETH-13**: An `op` of type `uint8` is annotated as a call, or carries a DELEGATECALL warning explaining that it runs target code in the caller's storage
- [ ] **ETH-14**: Integers at or above 1e15 carry an `≈ Ne18` hint and `address(0)` is annotated as the zero address / ETH sentinel

### Network Transport & Live Log

- [ ] **NET-01**: All network access goes through a single transport port; domain code never touches `fetch`
- [ ] **NET-02**: Requests are rate-limited per host with bounded concurrency, and identical in-flight GETs are deduplicated
- [ ] **NET-03**: Retries use exponential backoff with jitter on HTTP 429 and 5xx, network errors, Etherscan's rate-limit response body and JSON-RPC rate errors, honouring `Retry-After` and capped at 4 attempts
- [ ] **NET-04**: Hitting a rate limit never crashes a decode — the affected value degrades to unlabelled and the UI says so
- [ ] **NET-05**: Every request attempt is recorded with method, URL, query parameters, request body, status, duration, attempt number and response body
- [ ] **NET-06**: User can expand any log row to the full request and response, and the log updates live while a decode runs
- [ ] **NET-07**: API keys and `Authorization` headers are redacted in the log display and in both the Copy as JSON and Copy as cURL actions
- [ ] **NET-08**: Verified ABIs are cached in memory and `localStorage` with a TTL and a size cap, and error-shaped responses are never cached
- [ ] **NET-09**: Proxy contracts are followed and their implementation ABI merged, shown as `(Proxy → Impl)`

### Tests

- [ ] **TST-01**: Offline unit tests cover keccak-256 against known vectors and the ABI codec including nested tuples and arrays
- [ ] **TST-02**: Offline unit tests cover each text decoder using the handoff §7.5 vectors
- [ ] **TST-03**: Offline unit tests cover recursion and target selection using the handoff §7.1–7.3 calldata literals against a stubbed ABI source, including the unresolved-selector path
- [ ] **TST-04**: Unit tests cover transport retry, backoff and redaction using the handoff §7.6 scenarios

### DxKit Feedback

- [ ] **DX-01**: A `tmp/` feature request for a secret setting type on `SettingDefinition`
- [ ] **DX-02**: A `tmp/` feature request for a pluggable/encryptable settings store, noting that `persist()`/`restore()` are synchronous while WebCrypto is async
- [ ] **DX-03**: A `tmp/` feature request for app-level shell settings registration, since `_shell` is hard-coded to optional-dapp toggles and overwritten

## v2 Requirements

Deferred. Tracked but not in the current roadmap.

### Encrypted Settings Vault

- **VLT-01**: User can opt in to encrypting the browser settings store, with plaintext remaining the default
- **VLT-02**: The encryption key is derived from a wallet signature over a fixed message and held in memory only, never persisted
- **VLT-03**: User is prompted to unlock once per session, and a locked vault degrades gracefully rather than erroring
- **VLT-04**: A recovery path exists for the case where a wallet does not produce deterministic signatures
- **VLT-05**: DxKit's settings plugin supports a pluggable storage codec so encryption is not a dotdev fork

### Decoder Refinements

- **REF-01**: Creation-code awareness — a `bytes` value carrying solc metadata or the init prologue is summarised as a deploy payload with its constructor arguments split off and addresses labelled
- **REF-02**: Majeur proposal-id annotator — computes and displays the proposal id when the call shape matches `executeByVotes`/`spendPermit`
- **REF-03**: Second-wave decoders — `eth-tx`, `eth-log`, `eth-abi-return`, `gzip`, `unix-time`

## Out of Scope

| Feature | Reason |
|---------|--------|
| Any backend, server or account system | The no-backend posture is a product promise, not a gap |
| Wallet signing of any kind in v1 | Wallet is connect and identity only; signing arrives with the vault |
| Standalone shell-less operation of the decode dapp | The real goal is portability between DxKit shells; superseded by `requires.plugins` |
| A settings form inside the decode dapp | Settings are global; decode links to `/settings` instead |
| Wallet-driven chain selection | `chainId` comes from the ethereum plugin so decode stays independent of wallet state |
| Encoding direction | Decode only; encoding is a different tool |
| JWT signature verification | Requires key material the tool has no way to obtain |
| Raw transaction sender recovery | Needs secp256k1 recovery; disproportionate for the value |
| Transaction simulation and state reads | Beyond tx-by-hash and ABI fetch, this needs infrastructure we do not have |
| Multi-chain UX beyond a chainId to explorer table | Deliberately minimal per handoff R19 |
| Runtime dependencies, CDN scripts, npm runtime packages | Breaks the IPFS-servable, no-build-at-runtime posture |
| Upstream DxKit changes | DxKit is mid-milestone on v0.4; gaps become `tmp/` feature requests instead |
| TypeScript 6 upgrade | A major bump deserves its own change; tracked in `plans/TODO.md` |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| SET-01 | Phase 1 | Pending |
| SET-02 | Phase 1 | Pending |
| SET-03 | Phase 1 | Pending |
| SET-04 | Phase 1 | Pending |
| SET-05 | Phase 1 | Pending |
| SET-06 | Phase 1 | Pending |
| SET-07 | Phase 1 | Pending |
| SET-08 | Phase 1 | Pending |
| SET-09 | Phase 1 | Pending |
| SET-10 | Phase 1 | Pending |
| DX-01 | Phase 1 | Pending |
| DX-02 | Phase 1 | Pending |
| DX-03 | Phase 1 | Pending |
| WAL-01 | Phase 2 | Pending |
| WAL-02 | Phase 2 | Pending |
| WAL-03 | Phase 2 | Pending |
| WAL-04 | Phase 2 | Pending |
| WAL-05 | Phase 2 | Pending |
| WAL-06 | Phase 2 | Pending |
| WAL-07 | Phase 2 | Pending |
| DEC-01 | Phase 3 | Pending |
| DEC-02 | Phase 3 | Pending |
| DEC-03 | Phase 3 | Pending |
| DEC-05 | Phase 3 | Pending |
| DEC-06 | Phase 3 | Pending |
| DEC-07 | Phase 3 | Pending |
| DEC-08 | Phase 3 | Pending |
| DEC-09 | Phase 3 | Pending |
| DEC-10 | Phase 3 | Pending |
| DEC-11 | Phase 3 | Pending |
| DEC-12 | Phase 3 | Pending |
| DEC-14 | Phase 3 | Pending |
| DEC-15 | Phase 3 | Pending |
| DEC-17 | Phase 3 | Pending |
| COD-06 | Phase 3 | Pending |
| TXT-02 | Phase 3 | Pending |
| TXT-01 | Phase 4 | Pending |
| TXT-03 | Phase 4 | Pending |
| TXT-04 | Phase 4 | Pending |
| TXT-05 | Phase 4 | Pending |
| TST-02 | Phase 4 | Pending |
| COD-01 | Phase 5 | Pending |
| COD-02 | Phase 5 | Pending |
| COD-03 | Phase 5 | Pending |
| COD-04 | Phase 5 | Pending |
| COD-05 | Phase 5 | Pending |
| ETH-01 | Phase 5 | Pending |
| ETH-05 | Phase 5 | Pending |
| ETH-06 | Phase 5 | Pending |
| ETH-07 | Phase 5 | Pending |
| ETH-10 | Phase 5 | Pending |
| ETH-11 | Phase 5 | Pending |
| ETH-14 | Phase 5 | Pending |
| DEC-04 | Phase 5 | Pending |
| DEC-13 | Phase 5 | Pending |
| NET-01 | Phase 5 | Pending |
| NET-02 | Phase 5 | Pending |
| NET-03 | Phase 5 | Pending |
| NET-04 | Phase 5 | Pending |
| NET-05 | Phase 5 | Pending |
| NET-06 | Phase 5 | Pending |
| NET-07 | Phase 5 | Pending |
| TST-01 | Phase 5 | Pending |
| TST-04 | Phase 5 | Pending |
| ETH-02 | Phase 6 | Pending |
| ETH-03 | Phase 6 | Pending |
| ETH-04 | Phase 6 | Pending |
| ETH-08 | Phase 6 | Pending |
| ETH-09 | Phase 6 | Pending |
| ETH-12 | Phase 6 | Pending |
| ETH-13 | Phase 6 | Pending |
| NET-08 | Phase 6 | Pending |
| NET-09 | Phase 6 | Pending |
| TST-03 | Phase 6 | Pending |
| DEC-16 | Phase 6 | Pending |

**Coverage:**
- v1 requirements: 75 total
- Mapped to phases: 75
- Unmapped: 0 ✓

---
*Requirements defined: 2026-08-19*
*Last updated: 2026-08-19 after roadmap creation*
</content>
