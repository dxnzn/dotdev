# Handoff: `decode` — a generic decoder dapp for dnzn.dev

Status: specification for implementation. Written 2026-08-19. Target repo: this one (`dotdev`). Audience: the agent or human who builds it.

## 1. What this is and why

A DxKit dapp at `/tools/decode` that turns an encoded blob into something a person can read, with Ethereum calldata as the first and most important decoder. The immediate motivation is reading Majeur DAO proposals (zOrg, FWC): a proposal's substance is ABI-encoded calldata nested two or three layers deep (`executeByVotes → batchCalls → inner call`), and the web decoders linked from the DAO interface stop at the first layer and print `bytes` where the substance is. A Python/`cast` prototype that does the full job already exists and is the behavioural reference:

- Reference implementation: `../research/scripts/decode-calldata.py` (run it: `make decode ARGS='--tx <hash>'` from `../research`)
- Reference write-up of the problem and the expected decode of a real proposal: `../research/docs/projects/zfi/majeur.md`, sections "Reading a Proposal" and "Doing it in one pass"

Port that behaviour to the browser, make the decoder pluggable so base64/hex/JWT/etc. are one adapter each, and ship it as a DxKit dapp that can also run standalone.

## 2. Requirements (normative)

### 2.1 Product

- R1. Generic decoder framework with a decoder selector and one input textarea for whatever the encoded thing is. Ethereum calldata is one decoder among several.
- R2. URL-addressable: `?decoder=<id>&data=<payload>`. For backward/convenience, `calldata=<payload>` is accepted as an alias that implies `decoder=eth-calldata`. Note dotdev uses hash routing, so the real URL is `#/tools/decode?decoder=eth-calldata&data=0x…` and the query string arrives inside `e.detail.path` on `dx:mount` (see §4.3).
- R3. Ethereum calldata decoder must recurse: any `bytes` value that is itself calldata (including inside `batchCalls`/`multicall`-style aggregators, arrays and tuples) is decoded in place, repeatedly, until nothing decodes further.
- R4. Ethereum addresses and transaction hashes are detected and linked to a block explorer (address → `/address/<addr>`, tx → `/tx/<hash>`), displayed shortened as `<first 8 incl. 0x>...<last 6>` (e.g. `0x5E58BA0e...74053E`), full value on hover and via a copy control.
- R5. Pure HTML/CSS/TypeScript→JS. No runtime dependencies, no CDN scripts, no npm runtime packages. Everything needed (ABI decoding, keccak-256, RLP if used, base64url, etc.) is implemented in-repo.
- R6. Lightweight: target < 60 KB of JS uncompressed for the whole dapp including all first-wave decoders; lazy work (network) only on demand.
- R7. Bring-your-own credentials: Etherscan API key and JSON-RPC URL. Each decoder declares the settings it supports, each marked `required` or `optional`. A decoder whose required settings are missing says so in the UI and explains what degrades without the optional ones.
- R8. DxKit dapp, integrated with the DxKit settings plugin (`dx.settings`), which already persists to localStorage. Etherscan API key and RPC URL live there (manifest `settings`).
- R9. Rate limiting from Etherscan and RPC providers handled gracefully: retry with backoff, bounded concurrency, caching, dedupe, never crash the decode — degrade to "unlabelled" and say so.
- R10. Live log: every external request is recorded (method, URL, query params, request body, response status, duration, retries, response body) and viewable in a collapsible list where each row expands to the full request/response. API keys are redacted in the log display and in any copy/export.
- R11. Lightweight hexagonal architecture: ports as TypeScript interfaces, adapters per concrete thing (`Base64Adapter`, `EthCalldataAdapter`, `EtherscanAbiAdapter`, `FetchTransportAdapter`, …), domain code that knows nothing about `fetch`, `localStorage` or the DOM.
- R12. Wide-page format: configuration on the left pane, content on the right, using dotdev's existing `.layout-tool` grid (§4.4).
- R13. MIT license; `LICENSE` file in the dapp directory like `src/dapps/cic/LICENSE`.
- R14. Standalone-capable (DxKit standard): the dapp directory can be lifted out and served from a plain `index.html` with no shell, with settings falling back to a localStorage adapter. `manifest.standalone: true`.

### 2.2 Additions I recommend treating as requirements

- R15. Unit tests (vitest is already configured in this repo) for: the ABI codec, keccak-256, each text decoder, the recursion/target-selection logic, the transport's retry/backoff and redaction. Test vectors in §7.
- R16. Selector provenance is always shown: "verified ABI of target", "public registry (unconfirmed)", or "unresolved". The Python reference does this and it matters — registry selectors collide and the registry does not know everything.
- R17. Creation-code awareness in the calldata decoder: a `bytes` argument containing solc metadata (or beginning with the standard init prologue) is a deploy payload; summarise it, split the constructor arguments off the tail, print them as words with addresses labelled. Proposals that deploy contracts are common on the target DAOs.
- R18. Share link: a button that writes the current decoder + input into the URL (`history.replaceState`) and copies it. Warn above ~32 KB of payload; the hash fragment has no hard limit in modern browsers but links that long are fragile. Optional extra: a `z=` variant compressed with the native `CompressionStream('deflate-raw')` + base64url — no dependency, and calldata compresses well.
- R19. Chain awareness kept minimal: a `chainId` setting (default `1`) mapping to an explorer base URL table (`1 → https://etherscan.io`, `8453 → https://basescan.org`, `42161 → https://arbiscan.io`, …) and the Etherscan v2 `chainid` query param. Do not build multi-chain UX beyond that.
- R20. Privacy note in the UI: the input is sent to third parties only for lookups the decoder needs (selector registries, Etherscan ABI, your RPC), and which ones is visible in the live log. Nothing goes to DNZN.
- R21. Write any DxKit friction you hit to `tmp/` as an agent-targeted feature request, per this repo's `CLAUDE.md`. One is already known: see §4.5 (no shell-level settings UI).

## 3. Decoder catalogue

First wave (build these):

| ID | INPUT | OUTPUT | SETTINGS | NOTES |
|----|-------|--------|----------|-------|
| `eth-calldata` | `0x…` calldata, or a 32-byte tx hash | Recursive call tree (§6) | `etherscanApiKey` optional, `rpcUrl` optional, `chainId` optional | A tx hash input fetches the tx (`eth_getTransactionByHash` via RPC, else Etherscan `module=proxy`) and decodes `input` against `to`. Without either, a hash input is an error with a clear message. |
| `abi-words` | `0x…` | 32-byte words with offsets, selector on the first line, each word annotated (address-like, small int, offset-like, length-like) | none | The `cast pretty-calldata` view. Cheap and useful when the signature is unknown. |
| `base64` | base64 or base64url, padding optional | Decoded bytes: shown as UTF-8 if valid, else hex; auto-detect JSON and pretty-print | none | Also encode direction is trivial but out of scope for v1. |
| `hex` | `0x…` or bare hex | UTF-8 (if valid), byte length, and the integer value if ≤ 32 bytes | none | |
| `url` | percent-encoded string or a full URL | Decoded string; if a URL, a table of query params each decoded | none | |
| `jwt` | `a.b.c` | Header JSON, payload JSON, `exp`/`iat`/`nbf` rendered as dates, signature shown as-is. Explicit banner: signature NOT verified | none | |

Second wave (design for, do not build now): `eth-tx` (raw signed tx, RLP/typed envelopes → fields, from/chain recovered needs secp256k1 — probably skip recovery), `eth-log` (topics + data + ABI → event), `eth-abi-return` (return data + user-supplied types), `gzip` (via `DecompressionStream`), `unix-time`.

Detection: when the user pastes without picking a decoder, run a cheap `canDecode(input)` sniff across adapters (confidence score) and pre-select the best. Never auto-decode anything that needs network; the user clicks Decode.

## 4. DxKit / dotdev integration facts (verified against the source, 2026-08-19)

### 4.1 Dapp anatomy in this repo

- A dapp is `src/dapps/<id>/{manifest.json, dapp.ts, template.html, style.css}` plus optional extra scripts. `dapp.ts` is lifecycle glue only; CIC keeps domain logic in `cic.ts` and exposes it as `window.CIC` (see `src/dapps/cic/dapp.ts`, `src/dapps/cic/cic.ts`).
- There is no bundler at runtime. `tsup.config.ts` transpiles each listed `.ts` to a sibling `.js` (`bundle: false`, ESM syntax but loaded as plain scripts). Cross-file code therefore cannot use `import`; extra files are listed in manifest `dependencies` (loaded in array order, before `entry`) and communicate through a `window` namespace. Use one namespace, `window.DxDecode`, and add the new `.ts` files to `tsup.config.ts` `entry`.
- Register the dapp in `src/main.ts` `dapps: [...]` with `{ manifest: 'dapps/decode/manifest.json' }`, and add it to the README dapp table.
- Lifecycle: `window.addEventListener('dx:mount', e => { if (e.detail.id !== 'decode') return; … })` with `e.detail.container` (HTMLElement) and `e.detail.path` (full path including any `?query`); `dx:unmount` must tear down listeners and clear the container. The template HTML is already injected into the container before `dx:mount` fires.
- Context: `window.__DXKIT__` has `settings?`, `router`, `events`, `getManifests()`. Standalone detection is `if (window.__DXKIT__) … else …`.

### 4.2 Manifest for this dapp

```json
{
  "id": "decode",
  "name": "DECODE",
  "description": "DNZN // DECODE - decode calldata, base64, hex, JWTs and other encoded blobs.",
  "version": "0.1.0",
  "route": "/tools/decode",
  "entry": "dapps/decode/dapp.js",
  "template": "dapps/decode/template.html",
  "dependencies": [
    "dapps/decode/core.js",
    "dapps/decode/decoders-text.js",
    "dapps/decode/decoders-eth.js",
    "dapps/decode/ui.js"
  ],
  "styles": "dapps/decode/style.css",
  "standalone": true,
  "nav": { "label": "DECODE", "group": "tools", "order": 3 },
  "settings": [
    { "key": "etherscanApiKey", "label": "Etherscan API key", "type": "text", "default": "", "description": "Used for verified ABIs and contract names (and tx lookup when no RPC URL is set). Stored only in this browser." },
    { "key": "rpcUrl", "label": "JSON-RPC URL", "type": "text", "default": "", "description": "Used to fetch transactions by hash. Any Ethereum JSON-RPC endpoint." },
    { "key": "chainId", "label": "Chain ID", "type": "number", "default": 1, "description": "Selects the explorer for links and the Etherscan chainid parameter." },
    { "key": "etherscanRps", "label": "Etherscan requests/second", "type": "number", "default": 4, "validation": { "min": 1, "max": 10 } }
  ]
}
```

The `SettingDefinition` type (from `../vendor/dxkit/src/types/settings.ts`) supports `key, label, type ('text'|'number'|'boolean'|'select'|'multiselect'), default, description, options, validation {required,min,max,pattern}`. There is no per-setting "secret" flag; render `etherscanApiKey` as `<input type="password">` with a reveal toggle in our own form regardless.

### 4.3 Query string inside hash routes

Shell mode is `hash`. `e.detail.path` for `#/tools/decode?decoder=base64&data=aGk=` is `/tools/decode?decoder=base64&data=aGk=`. Parse with `new URLSearchParams(path.split('?')[1] ?? '')`. CIC does the same split for its sub-path; see `src/dapps/cic/dapp.ts`. When the dapp updates the URL (share link), keep the `#/tools/decode` prefix and use `history.replaceState` — do not trigger a route change.

Payloads in URLs must be URL-encoded; `0x…` hex is safe as-is, base64 is not (`+`, `/`, `=`). Encode on write, `URLSearchParams` decodes on read.

### 4.4 Layout

Use the existing two-column grid: `<div class="layout-tool"><div class="left-col">…</div><div>…</div></div>`. `.layout-tool` is `grid-template-columns: minmax(0, 420px) 1fr`, collapsing to one column under 960px (`src/styles/components.css`). The shell sets `html[data-layout="wide"]` automatically for any route under `/tools/` (`src/shell.ts` ~line 261, and inline in `src/index.html`), so nothing to do for width. Reuse `.card`, `.card-title`, `.input-group`, `.btn-group`, `.dapp-nav-bar` from CIC for visual consistency; add dapp-specific rules only in `style.css`.

### 4.5 Settings plugin: registered, no UI yet

`src/main.ts` registers `DxSettings.createSettings()` but the shell has no settings panel (only the theme panel). Consequences:

- The dapp must render its own settings form in the left pane, driven by its manifest definitions (`dx.settings.getSections()` filtered to `id === 'decode'`, or the manifest from `dx.getManifests()`), reading with `dx.settings.get('decode', key)` and writing with `dx.settings.set('decode', key, value)`. Writing through the plugin keeps values in the plugin's localStorage document (`dxkit:settings` → `{ decode: {…} }`) so a future shell-level settings UI sees the same values.
- Subscribe with `dx.settings.onAnyChange('decode', …)` so an external change (future shell UI, another tab) refreshes the form and the adapters' credentials.
- Write a feature request to `tmp/dxkit-shell-settings-panel.md`: the shell should offer a generic settings panel built from `getSections()`, and `SettingDefinition` should support `secret: true`.

### 4.6 Standalone

Provide `src/dapps/decode/standalone.html` that loads the same `core.js`, `decoders-*.js`, `ui.js` and `dapp.js` via script tags, includes the dapp `style.css` plus a minimal copy of the CSS variables it relies on (or the shell's `base.css`/`components.css` — pick one and document it), and calls the same init with a `LocalStorageSettingsAdapter` (`localStorage['dxkit:settings']`, same shape as the plugin, so credentials survive a move between shell and standalone). `dapp.ts` branches on `window.__DXKIT__` exactly as the DxKit docs show. The acceptance test for R14 is: copy `src/dapps/decode/` somewhere, open `standalone.html` from a static server, decode the §7 vectors.

## 5. Architecture

Hexagonal, kept small. Domain in the centre, ports as interfaces, adapters at the edge, UI as one more adapter on the driving side.

```
                ┌─────────────── driving side ───────────────┐
                │  ui.ts (DOM)   dapp.ts (DxKit mount)        │
                └──────────────┬──────────────────────────────┘
                               │ DecodeService.decode(decoderId, input, settings)
   ┌───────────────────────────▼──────────────────────────────────┐
   │ core.ts — domain                                              │
   │  DecoderPort, DecoderRegistry, DecodeNode tree, Annotators,   │
   │  AbiCodec (pure), Keccak256 (pure), HexUtil, Base64Util       │
   └──┬──────────────┬──────────────┬───────────────┬──────────────┘
      │ TransportPort│ AbiSourcePort│ SignatureLookupPort │ SettingsPort │ LogPort │ LinkPort
   ┌──▼──────────┐ ┌─▼───────────┐ ┌─▼───────────────┐ ┌─▼────────┐ ┌─▼─────┐ ┌─▼──────────┐
   │FetchTransport│ │EtherscanAbi │ │OpenchainSigs    │ │DxSettings│ │LiveLog│ │Explorer    │
   │(rate-limit,  │ │JsonRpcTx    │ │FourByteSigs     │ │LocalStor.│ │Store  │ │LinkAdapter │
   │ retry, log)  │ │             │ │LocalSigTable    │ │          │ │       │ │            │
   └─────────────┘ └─────────────┘ └─────────────────┘ └──────────┘ └───────┘ └────────────┘
```

### 5.1 Ports (TypeScript interfaces, in `core.ts`)

```ts
interface DecoderPort {
  id: string;                      // 'eth-calldata'
  label: string;                   // 'Ethereum calldata'
  settings: SettingSpec[];         // { key, required: boolean, why: string }
  canDecode(input: string): number;          // 0..1 confidence, sync, no network
  decode(input: string, ctx: DecodeContext): Promise<DecodeNode>;
}
interface DecodeContext { settings: Record<string, unknown>; log: LogPort; signal: AbortSignal; links: LinkPort; }

interface TransportPort {           // the only thing that touches the network
  request(req: HttpRequest): Promise<HttpResponse>;   // handles rate limiting, retries, logging
}
interface AbiSourcePort   { getAbi(address: string, chainId: number): Promise<{ name: string; abi: AbiItem[] } | null>; }
interface SignatureLookupPort { lookup(selector: string): Promise<string[]>; }   // candidate signatures
interface TxSourcePort    { getTransaction(hash: string, chainId: number): Promise<{ to: string | null; input: string; from: string } | null>; }
interface SettingsPort    { get(key: string): unknown; set(key: string, v: unknown): void; onChange(cb: (key: string, v: unknown) => void): () => void; }
interface LogPort         { record(entry: LogEntry): void; subscribe(cb: (entries: LogEntry[]) => void): () => void; clear(): void; }
interface LinkPort        { address(addr: string): string | null; tx(hash: string): string | null; }  // null when no explorer for chain
```

### 5.2 The result model

Every decoder returns a `DecodeNode` tree; the UI renders only this, so new decoders need no UI work.

```ts
type DecodeNode = {
  label: string;                    // 'op', 'calls[0].data', 'payload'
  type?: string;                    // 'uint8', 'address', 'bytes', 'json', 'text'
  value?: string | number | bigint | null;  // scalar display value
  display?: 'address' | 'txhash' | 'hex' | 'int' | 'text' | 'json' | 'bool';
  annotations?: string[];           // '(call)', '≈1e18', 'DELEGATECALL — runs target code in the caller's storage'
  provenance?: 'verified' | 'registry' | 'unresolved' | 'local';  // for function/selector nodes
  children?: DecodeNode[];
  collapsed?: boolean;              // default expanded; set true for blobs
  raw?: string;                     // full underlying value for copy / --full
  warning?: string;                 // shown inline with △
};
```

### 5.3 Pure codecs you must write (no deps)

- `Keccak256` — keccak-f[1600] over `Uint8Array`, returns hex. Needed for function selectors from ABI items (`keccak(sig)[0:4]`), and for the optional Majeur proposal-id annotator. ~120 lines with BigInt or split 32-bit lanes; the 32-bit-lane version is faster and fine.
- `AbiCodec.decode(types: string[], data: Uint8Array, offset): value[]` — full ABI head/tail decoding: static types (`uintN/intN/address/bool/bytesN`), dynamic (`bytes/string`), fixed and dynamic arrays, tuples (nested, static and dynamic), with a signature parser that turns `batchCalls((address,uint256,bytes)[])` into a type tree. Return `bigint` for integers. Must reject malformed offsets/lengths without throwing out of the decoder (return an error node).
- `AbiCodec.canonicalSignature(abiItem)` — expands `tuple` components into `(…)` form so the selector hashes correctly.
- `Base64` (std + url, padding-tolerant), `Hex` (strip `0x`, odd length → error node), UTF-8 validity check via `TextDecoder('utf-8', { fatal: true })`.
- Optional: `Rlp.decode` for the second-wave `eth-tx`.

### 5.4 Adapters

- `FetchTransportAdapter(log: LogPort, limits: { [host]: rps })` — token bucket per host; dedupe identical in-flight GETs; retry on HTTP 429, HTTP 5xx, network error, Etherscan body `{"status":"0","result":"Max rate limit reached"}` (string result where a record is expected), JSON-RPC error `-32005`/`-32029`/"rate" in message; exponential backoff with jitter (`500ms × 2^n ± 20%`, max 4 tries, honour `Retry-After`); `AbortSignal` support; records every attempt to the log with attempt number; redacts `apikey` query params and `Authorization` headers in the log entry it writes (store the redacted URL, never the real one).
- `EtherscanAbiAdapter(transport, settings)` — `module=contract&action=getsourcecode` on the v2 API with `chainid`; returns `{ name, abi }`; follows `Proxy === "1"` + `Implementation` and merges the implementation ABI; caches in memory and in `localStorage['dxdecode:abi:<chainId>:<addr>']` with a 7-day TTL and a size cap (evict oldest). Validates the response shape — `result` is a string on errors, never cache those. Without an API key this adapter is disabled (the decoder falls through to registries and says so).
- `JsonRpcTxAdapter(transport, settings)` — `eth_getTransactionByHash`; `EtherscanTxAdapter` — `module=proxy&action=eth_getTransactionByHash` as fallback. Order: RPC if set, else Etherscan if key set, else error.
- `OpenchainSignatureAdapter` — `https://api.openchain.xyz/signature-database/v1/lookup?function=<sel>&filter=true`; `FourByteSignatureAdapter` — `https://www.4byte.directory/api/v1/signatures/?hex_signature=<sel>` (results sorted by id ascending = oldest first, which is the usual disambiguation); `LocalSignatureTable` — a small built-in map for things the registries miss or that we care about (Majeur: `executeByVotes`, `spendPermit`, `setPermit`, `batchCalls`, `multicall`, `claimTribute(address,address)`; ERC-20/721/1155 basics; `multicall(bytes[])`, `aggregate((address,bytes)[])`, Safe `execTransaction`). Local table is consulted first and flagged `local`.
- `DxSettingsAdapter` (reads/writes `dx.settings` for dapp id `decode`) and `LocalStorageSettingsAdapter` (same JSON shape under `dxkit:settings`), selected in `dapp.ts`.
- `LiveLogStore` — in-memory ring buffer (cap 500 entries) implementing `LogPort`; UI subscribes.
- `ExplorerLinkAdapter(chainId)` — table of explorer bases; returns `null` for unknown chains so the UI renders plain text.

### 5.5 Annotators (eth-calldata extension point)

Small pure functions `(node, context) => void` run over the finished tree, each adds `annotations`/`warning`:

- `op` of type `uint8`: `0 → (call)`, else `DELEGATECALL — runs target code in the caller's storage` as a warning.
- Integers ≥ 1e15: `≈ <n/1e18>e18`.
- `address(0)` → `(zero address / ETH sentinel)`.
- Bytes that look like creation code → summarise + constructor words (R17).
- Majeur proposal id: if the top-level function is `executeByVotes(uint8,address,uint256,bytes,bytes32)` or `spendPermit(...)` and the call target (the DAO) is known, compute `keccak256(abi.encode(dao, op, to, value, keccak256(data), nonce, config))` with `config` from an optional numeric input (default 0) and show it as a node. This is the one DAO-specific thing; keep it in an annotator so it is obviously optional.

## 6. Ethereum calldata decoder — behaviour spec (port of the Python tool)

Given `input` (hex) and optional `target`:

1. If `input` is 32 bytes (a tx hash): fetch the tx (§5.4), set `input = tx.input`, `target = tx.to`, and emit a header node with `from`, `to`, hash (linked). If `tx.to` is null it is a contract creation; decode as creation code (step 7) with no function layer.
2. `selector = input[0:10]`. Resolve in order: local table → verified ABI of `target` (if target known and Etherscan configured) → openchain → 4byte. Verified beats local when both hit and differ? No: verified ABI wins over everything when present (it is the ground truth for that target); local is a convenience for when there is no target. Record provenance.
3. If unresolved: emit a node `selector 0x…… could not be resolved — N bytes undecoded` with the raw words available under an expandable `abi-words` view, and stop for this branch.
4. Decode arguments with `AbiCodec`. Label each argument with the ABI input name when provenance is `verified`, else `arg<i>`; tuple components get component names when available.
5. Recurse: for each value of type `bytes` with length `4 + 32k` (`k ≥ 0`) that is **not** creation code (step 7 check first), decode it as calldata. Its target is the nearest sibling `address` in the same tuple/argument list (covers `batchCalls((address,uint256,bytes)[])`, `executeByVotes(op,to,value,data,nonce)`, `setPermit`/`spendPermit`, Safe `execTransaction`); if none, inherit the parent's target (covers `multicall(bytes[])`, which delegatecalls to self). Arrays of `bytes` recurse per element. Zero-argument functions (`pull()`) decode to a bare function node with no children — not an error.
6. Bound the recursion: depth ≤ 16, total nodes ≤ 5,000, total bytes decoded ≤ 2 MB; emit a warning node when a bound is hit.
7. Creation code: a `bytes` value matching `/64736f6c6343[0-9a-f]{6}0033/i` (solc CBOR metadata tail) or starting with `0x6080604052`/`0x6040608052` is treated as a deploy payload. Node: `bytes[N] — contract creation code (solc metadata at byte M)`, collapsed, with `raw` for "show full". Bytes after the metadata: if a multiple of 32, render as `constructor args (k words)` — a word that is 12 zero bytes + 20 non-zero bytes is shown as an address (linked, labelled via `AbiSourcePort` name if available), otherwise as hex with a decimal hint when small.
8. Labels: every address node gets `← (ContractName)` when the ABI source knows it. Label lookups are best-effort, concurrent (bounded), and never block rendering — render the tree, then patch labels in as they arrive. Proxies: show `(Proxy → ImplName)` when followed.
9. Output the tree; run annotators; return.

Display rules (UI): addresses shortened per R4 and linked; 32-byte hex values rendered shortened with a secondary "tx ↗" link (they may or may not be tx hashes — the link is an affordance, the label stays neutral); big integers grouped with thin spaces or a `≈` hint; long hex collapsed with byte count and a "show full" toggle; provenance badge on every function node (`VERIFIED` / `REGISTRY` / `LOCAL` / `UNRESOLVED`).

## 7. Test vectors (real, mainnet; expected results verified with the Python tool on 2026-08-19)

Keep these as fixtures. Network-dependent assertions (names, verified provenance) go in an integration test behind an env flag; the pure decode assertions run offline with a stubbed `AbiSourcePort`.

### 7.1 Nested batch — zOrg proposal 7

- Tx: `0x36cde4af05f5d8ce7553d43c9ded7b31d53a378e6fc21a04e5165715a4f656ba` (to `0x5E58BA0e06ED0F5558f83bE732a4b899a674053E`, block 23875426)
- Outer: `executeByVotes(uint8,address,uint256,bytes,bytes32)` with `op=0`, `to=0x5E58BA0e…74053E` (self), `value=0`, `nonce=0xfaca2964ea31bc208b43e65524756e61ab82ebfe7d4981e56fd985cbde1b261f`
- `data` (836 bytes) decodes as `batchCalls((address,uint256,bytes)[])` with 3 elements:
  1. target `0x62eC86753D9dCb6a6dEe18E2B3A0EBb823359016` (Loot), value 0, data `0x2806b0af…` → `mintFromMoloch(address,uint256)` = (`0x5E58BA0e…74053E`, `1000000000000000000`)
  2. same target, data `0x095ea7b3…` → `approve(address,uint256)` = (`0x000000000066524fcf78Dc1E41E9D525d9ea73D0`, `1000000000000000000`)
  3. target `0x000000000066524fcf78Dc1E41E9D525d9ea73D0` (Tribute), data `0xac6695d1…` → `claimTribute(address,address)` = (`0x1C0Aa8cCD568d90d61659F060D1bFb1e6f855A20`, `0x0000000000000000000000000000000000000000`). `0xac6695d1` is **not** in openchain/4byte — it must resolve via the target's verified ABI (or the local table), and the test must assert the unresolved path when neither is available.
- Expected proposal id (config 0): `0x28f8700c3e0140a067dad58abddc335a1bf2bcd0623ec9f47dae362916b03d72`
- Inner calldata literals for offline tests:
  - `0x2806b0af0000000000000000000000005e58ba0e06ed0f5558f83be732a4b899a674053e0000000000000000000000000000000000000000000000000de0b6b3a7640000`
  - `0x095ea7b3000000000000000000000000000000000066524fcf78dc1e41e9d525d9ea73d00000000000000000000000000000000000000000000000000de0b6b3a7640000`
  - `0xac6695d10000000000000000000000001c0aa8ccd568d90d61659f060d1bfb1e6f855a200000000000000000000000000000000000000000000000000000000000000000`

### 7.2 Permit with delegatecall and a zero-arg inner call — FWC

- Tx: `0x4f3bfa5e336c3e1661a6d1e1119e30506f0a563c1209595b1b023a845f30017f` (to `0xE7Aa6cA3a9Ca3fe92a425dFeaD24900B9BF49853`)
- `executeByVotes(op=0, to=self, value=0, data, nonce=0xbc5bfc07…81b937)` → `data` = `setPermit(uint8,address,uint256,bytes,bytes32,address,uint256)` with `op=1` (annotate DELEGATECALL), `to=0x55D2cF1fD3cb803c37340CDd4Fd8fC59d750d050` (FWCPoisonPill), `value=0`, `data=0x…` → `pull()` (4 bytes, zero args — must not be an error), `spender=0x006CD14F36F65eCbB29b2519cCBe63A0DC8549F2`, `count=1`.
- Expected proposal id (config 0): `0x7aba6a6b8fa73168870b443093a4b1c81b224d03c245ebee83df93e49645bb6c`

### 7.3 Simple single call — zOrg proposal 20

- Tx `0xf90b79da45a6d9062d4b83d0df35c33a7166b8ec72fc58365e503134d1f8dd80`; `executeByVotes(0, 0x0000006D936bA3653b8854490E16E782cd32a9a8, 0, 0x56d3163d0000000000000000000000000000006b980ae5e796b3ef484e767993d0e29979, 0x238f613abfc45402e05ca6cef98099e02b872c173c1ba5ce06c88ea6947acef0)` → `setRenderer(address)` = `0x0000006b980ae5e796B3eF484e767993d0E29979`.
- Expected proposal id (config 0): `0xe78a45cec2e9fb4d8c06e31588e61751ee8b01496673519361606ad5c9707d25`

### 7.4 Deploy payload — `deployNext(bytes,bytes32)`

- Selector `0x48215787` resolves in openchain to `deployNext(bytes,bytes32)`. The `bytes` argument (7719 bytes in the real case) begins `0x6102406040523461030957…`, contains `64736f6c634300082400 33`, and is followed by 14 constructor words: `0x5e58ba0e…74053e` (Moloch), `0x00000095643cffa7d9fae407a84dfcb6406456c6` (zSwap), then 12 more addresses. Test with a synthetic short payload: prologue + padding + metadata marker + 4 address words; assert the creation-code branch fires **even when the blob length happens to be 4+32k**, and that the 4 constructor words come out labelled as addresses.

### 7.5 Text decoders

- base64 `aGVsbG8gd29ybGQ=` → `hello world`; base64url `eyJhIjoxfQ` (no padding) → JSON `{"a":1}` pretty-printed.
- hex `0x68656c6c6f` → `hello`, 5 bytes, int 448378203247.
- url `a%20b%26c=1` → `a b&c=1`.
- jwt `eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjE3MDAwMDAwMDB9.sig` → header `{"alg":"HS256"}`, payload with `exp` rendered as 2023-11-14T22:13:20Z, signature `sig`, banner "not verified".

### 7.6 Transport

- Etherscan body `{"status":"0","message":"NOTOK","result":"Max rate limit reached"}` with HTTP 200 → retried with backoff, logged as attempt 1..n, never cached, final failure surfaces as "unlabelled" not as a crash.
- HTTP 429 with `Retry-After: 2` → waits ≥ 2 s.
- Log entry for an Etherscan call shows `apikey=REDACTED`.

## 8. UI spec

Left pane (`.left-col`), top to bottom:

1. `Decoder` — `<select>` populated from the registry; auto-detect badge when `canDecode` picked it.
2. `Input` — `<textarea>` (monospace, auto-grow to ~12 rows, then scroll); paste handler trims whitespace/newlines for hex-type decoders; a `Decode` button and `Clear`.
3. `Options` — decoder-specific inputs that are not credentials (e.g. eth-calldata: `target address` optional, `config` for proposal id, "follow proxies" toggle).
4. `Settings` — form for the selected decoder's declared settings, each with a `REQUIRED`/`OPTIONAL` badge and one line saying what it enables; values read/written through `SettingsPort`; API key as password input with reveal.
5. `Share` — "Copy link" writes `?decoder=…&data=…` into the hash and copies; shows byte size; warns > 32 KB.

Right pane: `.dapp-nav-bar` tabs `Result | Raw | Log`.

- `Result` — the `DecodeNode` tree: indented rows, expand/collapse per node, provenance badges, linked/shortened addresses, copy-on-click for any value (copies the full `raw`). Empty state explains what to paste and links to the Majeur page on dnzn.research for the "why".
- `Raw` — for hex inputs the `abi-words` view; for text decoders the decoded bytes as hex dump.
- `Log` — table of `LogEntry` rows: time, method, host+path, status, duration, attempt; click expands to full (redacted) URL, query params, request body, response headers subset, response body (pretty JSON, truncated at 64 KB with "show more"). Buttons: `Clear`, `Copy as JSON`, `Copy as cURL` (redacted). Live: updates while a decode is running.

States: decoding spinner on the button; partial results render immediately with label placeholders that fill in; errors are nodes in the tree, not modals. Keyboard: `Ctrl/Cmd+Enter` decodes.

## 9. File layout (proposed)

```
src/dapps/decode/
  manifest.json
  LICENSE                 (MIT, same text as cic/LICENSE)
  template.html           (layout-tool skeleton; ids for ui.ts)
  style.css               (dapp-specific only)
  core.ts                 (ports, DecodeNode, registry, Keccak256, AbiCodec, Hex/Base64 utils, annotator runner)
  decoders-text.ts        (Base64Adapter, HexAdapter, UrlAdapter, JwtAdapter, AbiWordsAdapter)
  decoders-eth.ts         (EthCalldataAdapter + FetchTransportAdapter, EtherscanAbiAdapter, tx adapters, signature adapters, LocalSignatureTable, ExplorerLinkAdapter, LiveLogStore)
  ui.ts                   (renders settings form, tree, log; subscribes; no business logic)
  dapp.ts                 (dx:mount/unmount glue; picks DxSettingsAdapter vs LocalStorageSettingsAdapter; parses query)
  standalone.html
  README.md               (how to port standalone; how to add a decoder in ~30 lines)
test/decode/
  keccak.test.ts  abi-codec.test.ts  decoders-text.test.ts  eth-calldata.test.ts  transport.test.ts
```

All new `.ts` files go into `tsup.config.ts` `entry`. Each file attaches to `window.DxDecode` (create the namespace in `core.ts`, guard with `window.DxDecode ??= {}`). Keep `dapp.ts` and `ui.ts` free of decoding logic.

## 10. Non-goals for v1

- No encoding direction (only decode).
- No signature verification for JWTs, no sender recovery for raw txs.
- No transaction simulation, no state reads beyond tx-by-hash and ABI fetch.
- No multi-chain UX beyond `chainId` + explorer table.
- No server component of any kind.

## 11. Acceptance checklist

- [ ] `#/tools/decode?decoder=eth-calldata&data=<7.1 inner literal>` renders the decoded call with registry provenance badge and no network errors when no key/RPC is set.
- [ ] `#/tools/decode?calldata=0x…` behaves as `decoder=eth-calldata&data=…`.
- [ ] With an Etherscan key: 7.1 tx hash input yields the full three-call tree with `Loot`/`Tribute` labels, `claimTribute` resolved as VERIFIED, and the proposal id shown.
- [ ] With only an RPC URL: 7.1 tx hash input yields the tree with registry/local provenance and the third call resolved via the local table, flagged LOCAL.
- [ ] 7.2 shows `op: 1` with the DELEGATECALL warning and `pull()` as a leaf.
- [ ] 7.4 synthetic payload shows the creation-code summary and 4 constructor addresses.
- [ ] Every address in the tree is shortened `0x12345678...abcdef` and links to the right explorer for the configured chain; every 32-byte value offers a tx link.
- [ ] Forcing Etherscan's rate-limit response in a test produces retries visible in the Log tab and a completed (unlabelled) decode.
- [ ] Log rows expand to full request/response; `apikey` is redacted in the display and in both copy actions.
- [ ] Settings persist across reload through `dx.settings`; changing the key in the form is reflected in the next request.
- [ ] `standalone.html` served from `src/dapps/decode/` alone decodes all §7 vectors.
- [ ] Unit tests pass (`npm test`); JS payload size for the dapp reported in the PR.
- [ ] README dapp table and `src/main.ts` updated; `tmp/dxkit-shell-settings-panel.md` written.

## 12. Open decisions (decide in the first commit, note in the dapp README)

1. Tree rendering: hand-rolled DOM (recommended, no deps) vs. `<details>`/`<summary>` — the latter is zero-JS for collapse but harder to style consistently with the shell.
2. Local signature table scope: keep it to the Majeur/Safe/ERC set above, or grow it. Recommendation: keep it small and make it a plain object so it is obviously editable.
3. Whether `abi-words` is a separate decoder or only the Raw tab of `eth-calldata`. Recommendation: both — it is one adapter either way.
4. Whether to expose the Majeur proposal-id annotator in the UI as "DAO: compute proposal id" or keep it silent when the shape matches. Recommendation: silent when shape matches, with a `config` option in the Options card.
