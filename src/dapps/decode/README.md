# decode

A generic decoder framework. Phase 3 shipped its skeleton — the route, the two-column layout, the
`DecodeNode` result tree, the Result/Raw/Log tabs, and URL-addressable share links — proven
end-to-end by one deliberately trivial decoder, `hex`. Phase 4 then added four more decoders —
`base64`, `url`, `jwt`, `abi-words` — through those same seams, and the claim that later phases
would not need to touch the renderer, the registry, or the node type again held for every one of
them, with one concession: `types.d.ts`'s module-shaped interfaces (`DxDecodeCoreModule`,
`DxDecodeCodecsModule`) gained members additively, forced by TypeScript's excess-property checking
on the explicitly typed object literals those modules assemble. Nothing existing on the render
contract — `DecodeNode`, `DecodeOutput`, `DecoderPort`, `DecodeContext`, `DecodeRunResult`,
`renderNode` — was changed, narrowed, or removed. See `04-05-SUMMARY.md` for the full two-part
finding.

## Namespace

This dapp's window namespace is `window.DxDecode` — a **dapp** namespace, not a framework one.
The `Dx*` prefix elsewhere on this site (`DxKit`, `DxTheme`, `DxSettings`, `DxWallet`) names
vendored DxKit itself; `DxDecode` is this dapp's own, chosen because a dapp meant to be lifted
into another DxKit shell must not carry this org's name (`Dnzn*`) in its global. A reader who
assumes `Dx*` always means "look in the framework" will look for `DxDecode` in the wrong place.

Phase 5 added four sub-keys alongside `core`/`codecs`/`registry`/`log`:

- `window.DxDecode.keccak` — keccak-256 over `Uint8Array`, and the selector/canonical-signature
  helpers built on it.
- `window.DxDecode.abi` — the head/tail ABI decoder and the signature-string parser (canonical
  and JSON-ABI front doors), covering every ABI type at every nesting depth.
- `window.DxDecode.transport` — `createTransport(options)`, the sole `fetch`-bearing factory in
  this directory; see § Privacy below for what the portability guard enforces about it.
- `window.DxDecode.signatures` — the local signature table plus the OpenChain/4byte registry
  adapters and the resolver that keccak-verifies a candidate before trusting it.

Phase 6 added four more modules:

- `annotators.ts` (`window.DxDecode.annotators`) — three ordered post-order passes over the
  finished tree: the bounded cross-call recursion pass (`recurse`), the operation-argument
  annotator (`annotateTree`/`annotateOp`), and the progressive contract-name walk
  (`collectAddressNodes`/`patchContractNames`) that patches a resolved name into the tree without
  blocking the initial render.
- `abi-source.ts` (`window.DxDecode.abiSource`) — the verified-ABI source: fetches a target's
  source-code entry through the shared transport, follows a proxy's implementation one level
  (NET-09) — including when the proxy's own ABI exposes no callable function at all, which is the
  ordinary minimal-proxy shape — and feeds both selector resolution's verified rung and, since this
  plan, contract-name labelling.
- `cache.ts` (`window.DxDecode.cache`) — the two-tier (in-memory plus browser-local persistence)
  verified-ABI cache behind the portability guard's third named exemption — the annotators' name
  walk is what makes every distinct address in a decoded tree cost one lookup per mounted session,
  not one per node. Three write tiers: `both` for a contract's own verified ABI (durable), `memory`
  for an answer that must not outlive the session — a proxy's merged implementation ABI, since the
  implementation is exactly what an upgrade replaces — and `negative` for a contract asked about and
  genuinely not verified.
- `tx-source.ts` (`window.DxDecode.txSource`) — the transaction lookup: the user's own RPC
  endpoint first, the explorer's proxy module second — what a pasted 32-byte transaction hash
  resolves through.

A fifth followed, out of the original phase scope (REF-01's §7.4 slice), once real use showed a
pasted deploy payload reading as an unresolved selector over thousands of undecoded bytes:

- `creation-code.ts` (`window.DxDecode.creationCode`) — recognises contract creation bytecode by
  its solc CBOR metadata tail (corroborated by an EVM init opcode in the first byte, without which
  every `deployNext(bytes,bytes32)` CALL would be mistaken for the payload it carries) and splits
  the constructor words off the compiled blob. Pure, like `abi.ts`: no ctx, no network, no DOM. It
  is deliberately **not** a decoder — a deploy payload is usually an argument, so both the
  top-level paste (`decoders-eth-calldata.ts`) and the recursion pass (`annotators.ts`, where it
  is the guard handoff §6.5 step 5 demands before grafting a `bytes` argument as a nested call)
  call the same module. Constructor words come out typed `address`, which is what hands them to
  the existing shortening, linking and contract-name passes rather than re-implementing any of it.
  Bytecode analysis proper — disassembly, selector recovery, immutables — remains REF-01, v2.

## Adding a decoder

Registering a decoder and getting it to compile and load costs three touchpoints, no more. A
decoder that also needs a shared capability (a helper in `core.ts` or `codecs.ts`) or its own
test suite adds those files too — that is ordinary new work, not a hidden central-list edit, and
it is not what this section's cost claim is about. Plan 04-01's `base64` decoder is the real
example: the wiring below cost exactly three touchpoints, and it separately needed `core.ts`
(a shared `jsonToNode` helper), `types.d.ts` (declaring that helper) and a test file — each its
own new work, not evidence the wiring claim was wrong.

1. **One new file** in this directory, e.g. `src/dapps/decode/decoders-foo.ts`. Its shape is the
   `DecoderPort` interface (`types.d.ts`):

   ```typescript
   const fooDecoder: DecoderPort = {
     id: 'foo',
     label: 'Foo',
     settings: [], // bare setting keys this decoder needs, or none
     canDecode(input) {
       /* 0..1 confidence, synchronous, no network */
     },
     async decode(input, ctx) {
       /* returns a DecodeOutput: { node, rawBytes?, rawView? } */
     },
   };

   registry.register(fooDecoder);
   ```

   The final line is the whole registration story (D-05) — no central "list of decoders" file to
   edit. `src/dapps/decode/decoders.ts` is the real, working example: read it alongside this file.

   **Every top-level binding in this file must be unique across the whole `src/dapps/decode/`
   directory.** `tsconfig.decode.json` compiles `src/dapps/decode/**/*.ts` as one TypeScript
   program of import-free global scripts (D-08 — no file here has an `import` or `export`), so
   two files declaring the same top-level `const` or `function` name collide with
   `TS2451: Cannot redeclare block-scoped variable` the moment `make lint`'s typecheck gate runs
   — this is a compile-time collision in the scoped typecheck program, not a runtime one: the
   vendored shell loads each decoder file as its own `<script type="module">`
   (`src/vendor/dxkit/index.global.js`), so at runtime every file already has its own module
   scope. Prefix every top-level name with something naming this decoder — `decoders.ts` owns the
   bare names `codecs`, `registry`, `core`, `canDecode`, `decode`, `hexDecoder`;
   `decoders-base64.ts` owns `b64Codecs`, `b64Registry`, `b64Core`, `b64CanDecode`, `b64Decode`,
   `base64Decoder`. A worked example for a hypothetical `foo` decoder would use `fooCodecs`,
   `fooRegistry`, `fooCore`, `fooCanDecode`, `fooDecode`, and the port object `fooDecoder` shown
   above.

2. **One entry in the manifest's `dependencies` array** (`src/dapps/decode/manifest.json`), so the
   new file loads before `dapp.ts` mounts:

   ```json
   "dependencies": [
     "dapps/decode/codecs.js",
     "dapps/decode/core.js",
     "dapps/decode/decoders.js",
     "dapps/decode/decoders-foo.js",
     "dapps/decode/ui.js"
   ]
   ```

3. **One entry in `tsup.config.ts`'s `entry` array** (repo root), so the new file compiles at all:

   ```typescript
   'src/dapps/decode/decoders-foo.ts',
   ```

That is the entire cost of registering a decoder and getting it to compile and load — this is
the whole argument for `core.ts`'s registry and this directory's file split (D-05, D-09). A
decoder needing a shared helper or a test suite of its own pays for those separately, as plan
04-01's `base64` decoder did.

A decoder may also declare credential-backed settings (`settings: ['etherscanApiKey', ...]`,
bare keys resolved through the real `SettingsPort` — see § Host-shell contract) and reach a
signature registry through `ctx.signatures` (`SignatureLookupPort`, optional on `DecodeContext`).
It must degrade rather than fail when a credential or `ctx.signatures` is absent — `eth-calldata`
is the worked example: with no transport wired it still resolves against its local table and
renders `UNRESOLVED` rather than throwing when nothing local matches.

## Host-shell contract

This directory is portable into any DxKit shell that satisfies two things:

- **A `settings` plugin registered with the host shell.** The manifest declares
  `requires.plugins: ["settings"]`, and DxKit's own lifecycle manager genuinely enforces this at
  mount — a host missing the plugin gets a `dx:error` and the dapp is never mounted. This is a
  real dependency, not documentation.
- **These shared CSS classes**, all consumed and none redefined here (only `.left-col` is copied
  locally, per this repo's own per-dapp convention — see `src/dapps/cic/style.css` for the same
  pattern; `.left-col` is not a shell-shared class, defined once and copied by every `/tools/*`
  dapp that needs it):
  - `.layout-tool` — the two-column grid
  - `.card`, `.card-title` — the input and results panels
  - `.input-group`, `.select-wrap` — the decoder selector and its label
  - `.btn-group` — the Decode/Clear actions
  - `.tabs`, `.tab-content` — the Result/Raw/Log tab strip
  - `.results-area` — the right-hand column wrapper

The other half of that contract (G-06-5): this directory owns its own horizontal overflow rather
than relying on a host wrapper for it. `#decode-tree` and `#decode-log` are both scrollports in
their own right, deliberate because the site's own `html`, `body` and `.app` all carry
`overflow-x: hidden` (`src/styles/base.css`), so an unclipped descendant is silently invisible
rather than scrollable — a host shell does not have to wrap either panel for long content to stay
reachable, and lifting this directory into another shell carries the overflow behaviour with it.
Per-level tree indentation also decays after the sixth level so a tree at the recursion depth
bound stays inside its panel, expressed as a descendant-selector chain in `style.css` rather than
as a measured value in `ui.ts` — a measured cap would need browser-measurement globals the
portability guard does not permit (see `AGENTS.md`).

A third piece of that contract (G-06-7): the plain share link (DEC-06) is now reached only
through a host-integration seam, never through a control in the panel itself. `init()`'s returned
handle exposes `pressPlainShare(): string` (builds the link from the current decoder and input,
writes it via `history.replaceState`, and returns it) and `revealShareFailure(url: string)`
(shown in this mount's own copy-fallback field when a host's own clipboard write fails). A host
that wants a plain-link control — a header button, a menu item, whatever fits its own chrome —
must wire it to `pressPlainShare` itself; **a host that wires nothing gives its users no way to
copy a plain link at all.** This dotdev shell wires it in `src/main.ts` via the `dx:mount`/
`dx:unmount` listeners and `window.DxDecode.activeUi` (the same single-live-instance seam `log`
uses), driving its own header button. The compressed variant (DEC-07), the byte readout, and the
over-length warning all remain in the panel itself — no host seam exists for those, so removing
the in-panel plain-link button did not touch them.

`DecodeContext` also carries four **optional** ports a host may supply, each of which a decoder
must treat as absent-capable rather than assumed:

- `transport?: TransportPort` — a rate-limited, deduplicated, retried network primitive. This
  dapp's own `init()` constructs one from `window.DxDecode.transport` when that module loaded;
  a host that omits the module (or a decoder used standalone) sees `ctx.transport` as `undefined`.
- `abis?: AbiSourcePort` — a verified-ABI lookup by target address, supplied by this dapp's own
  composition root as of Phase 6 (`window.DxDecode.abiSource`, cached by `window.DxDecode.cache`).
  Feeds selector resolution's verified rung, the contract-name walk (ETH-12), and NET-09's
  one-level proxy follow.
- `signatures?: SignatureLookupPort` — the 4-byte-selector-to-signature resolver, backed here by
  `window.DxDecode.signatures`'s registry adapters when a transport is also present.
- `txSource?: TxSourcePort` — a transaction lookup by hash, supplied by this dapp's own
  composition root as of Phase 6 (`window.DxDecode.txSource`) — the user's own RPC endpoint
  first, the explorer's proxy module second.

## Share links

G-06-7: there is no in-panel "Copy link" button any more — a plain share link is copied only
through whatever control the host shell wires to `pressPlainShare` (see the host-shell contract
above). This dotdev shell wires it to its own header button. Pressing that control writes the
current decoder and input into the address bar via `history.replaceState` — never on a keystroke,
a paste, or a decode, and never causing a route change. The emitted form always carries a slash
between the route and the query:

```
#/tools/decode/?decoder=hex&data=0x68656c6c6f
```

A link written without that slash (the form a hand-typed URL or an older link might carry) still
opens: the host shell canonicalizes it before its router ever reads the path, and this dapp's own
parser accepts both forms regardless. The canonicalization lives in the host shell
(`src/main.ts`), not here — it is a workaround for a routing gap in the framework version this
repo vendors, and a portable dapp must not carry a workaround for one host's framework version.

Above roughly 32 KB the share area also offers a second action, **Copy compressed link**, using
the platform's own `CompressionStream('deflate-raw')` and a URL-safe base64 alphabet — no
dependency added. It is hidden outright on a platform without compression support, rather than
offered and then failing. When a link carries both the plain and the compressed parameter, the
compressed one wins; a compressed payload that will not inflate renders as a readable error in
the result tree, with the original value left visible in the input field.

A third form, `calldata=<payload>`, is an alias for `data` that also implies
`decoder=eth-calldata` — the form a link generator (or a person) reaches for when it already
knows the payload is Ethereum calldata and does not want to name the decoder explicitly:

```
#/tools/decode/?calldata=0xabcd
```

Two precedence rules, both following the same principle — an explicit parameter always beats an
implied one: an explicit `decoder` parameter wins over the alias's own implication, and an
explicit `data` parameter wins over `calldata` as the payload source (while the alias's decoder
implication still stands, since nothing contradicted it).

A fourth parameter, `submit=1` (G-06-6), asks the link to decode itself on load instead of only
loading the payload and waiting for a click:

```
#/tools/decode/?decoder=hex&data=0x68656c6c6f&submit=1
```

Any value other than the literal `1` — empty, `true`, a typo, or the key being absent at all — is
ignored, and the link behaves exactly as it does today. **`submit=1` is a request, not consent.**
The person who composed the link cannot know what the recipient has configured, and DEC-05
promises that nothing requiring network runs until the user asks for it. The amended rule (ratified
at the 06-10 checkpoint, recorded in that plan's SUMMARY) reads:

> Pasting without choosing a decoder pre-selects the best match by `canDecode()` confidence and
> shows an auto-detect badge; nothing requiring network runs until the user clicks Decode, unless
> the recipient has themselves enabled auto-running shared links in Settings (default off).

Consent is therefore something the **recipient** grants once, ahead of time, in their own copy of
the settings dapp — never something a query parameter can grant on the sender's behalf. With the
setting off (the default), `submit=1` changes nothing. With it on, `submit=1` runs whichever
decoder the link names, **uniformly, for every decoder** — hex and base64 exactly the same as
`eth-calldata` — because a recipient who opted in has already agreed to it for all of them; there
is no partial or per-decoder version of this setting.

**What turning it on actually costs**, so a link author composing one for someone else knows what
they are asking for: even with no Etherscan key or RPC URL configured, `eth-calldata`'s selector
lookup reaches two public, keyless registries (`api.openchain.xyz`, `4byte.directory`) the moment
the link opens — that lookup is not gated on credentials at all. With an Etherscan key and RPC URL
configured, an auto-run also spends the recipient's own request quota against their own providers
before they have seen what the payload is. Nothing in either case reaches DNZN or the link's
author: every request goes to the recipient's own configured endpoint or to a keyless public
registry, and a link carries only the payload, the decoder id and now this flag — never a target
URL, so there is no way for a link to redirect a lookup anywhere the recipient (or this file's own
fixed constants) didn't already point it.

## Privacy

Phase 5 gave `eth-calldata` a real network path (registry lookups), so the claim this section
makes narrowed on purpose — from "nothing in this directory can reach the network" to what the
guard and the test suite actually enforce, in both directions:

- **Enforced by the source scan** (`test/decode-portability.test.ts`): exactly one file,
  `transport.ts`, may invoke the network primitive, and every invocation of it in that file sits
  inside `netRequest`, the one function that writes the log entry. Exactly one helper,
  `uiCreateExternalLink`, may construct a link (`href`). Both exemptions are asserted to have
  exactly one entry, and each has a synthetic failing-direction test proving the call site outside
  its permitted function IS caught.
- **Enforced by behavioural tests**: every completed request attempt is recorded as its own log
  entry with its attempt number; the api key and any `Authorization` header are redacted **before**
  the entry is stored, so they are absent from the stored object, from Copy as JSON and from Copy
  as cURL; nothing in the directory reaches a persistent-storage API.

This section does **not** claim a request is logged *before* it is issued — `LogPort`
(`types.d.ts`) is append-and-clear (`record`/`subscribe`/`clear`, no start/update lifecycle), and a
completed log entry carries a status, a duration and a response body, none of which exist before
the request returns. The source scan cannot establish that timing either; it matches call sites,
not control flow. The honest claim is that every *completed* attempt is recorded, and that is
what this section says.

The five decoders that ship with no network path at all — `hex`, `base64`, `url`, `jwt` and
`abi-words` — still decode entirely on-device, unaffected by any of the above; `eth-calldata` is
the one exception, and only through the one file and one function named. The Log tab lists every
request `transport.ts` makes, with credentials already redacted.

## Size

Measured with the command Phase 3 established — `npx tsup && wc -c src/dapps/decode/*.js` — run
fresh rather than read from this document, whose own figure had already gone stale twice already
before this phase began (see the two superseded snapshots this section used to carry).

**Phase 5 measurement**, taken from a fresh build after this phase's own commits landed — every
compiled module in the directory, the pattern rather than a fixed roster, so this table needs no
edit the next time a decoder is added or removed:

| Module | Bytes |
|---|---|
| `abi.js` | 16,606 |
| `codecs.js` | 4,342 |
| `core.js` | 9,979 |
| `dapp.js` | 1,084 |
| `decoders-abi-words.js` | 5,436 |
| `decoders-base64.js` | 2,895 |
| `decoders-eth-calldata.js` | 9,429 |
| `decoders.js` (hex) | 1,863 |
| `decoders-jwt.js` | 4,207 |
| `decoders-url.js` | 4,713 |
| `keccak.js` | 4,585 |
| `signatures.js` | 4,553 |
| `transport.js` | 12,418 |
| `ui.js` | 28,287 |
| **Total** | **110,397** |

**Three numbers, three baselines, per D-02** — never a figure carried forward from a previous
document, always the same fresh build:

| Mode | This phase | Pre-phase baseline | Delta |
|---|---|---|---|
| Uncompressed | **110,397 bytes** | 54,062 bytes (`04-05-SUMMARY.md`, post-review) | **+56,335 bytes** |
| Gzipped | **27,061 bytes** | 10,584 bytes | **+16,477 bytes** |
| Minified | **66,855 bytes** | none recorded | not applicable |

- **Uncompressed**, measured with the command above. 54,062 — not 52,744 — is the correct
  pre-phase baseline: 52,744 was `04-05-SUMMARY.md`'s measurement taken *before* the post-review
  commits `7cb9331`, `cc9f265` and `1c0c19e` landed, and using it would understate this phase's
  delta by 1,318 bytes.
- **Gzipped**, measured as `cat src/dapps/decode/*.js | gzip -9 | wc -c` over the same fresh
  build — the actual served bytes, gzipped, since this toolchain has no minify step and `src/` is
  what a server compresses on the wire. **This is a methodology change from the 10,584-byte
  pre-phase figure**, which was gzip of a one-off *minified* rebuild rather than of the served
  output itself (gzip of this phase's own minified rebuild, below, is 20,803 bytes — closer to
  10,584's ratio of raw). The +16,477 delta above is reported because D-02 asks for one against
  the recorded baseline, but the two figures are not a clean apples-to-apples subtraction; the
  128,000/32,000-byte budget approved for this phase (below) was set against *this* phase's own
  gzip-of-served-output methodology, which this document adopts going forward as the more honest
  measure of real transfer cost — no minify step exists, so gzip of the served tree is what a
  visitor's browser actually receives.
- **Minified**, produced ad hoc for this report only — there is no minify step in the toolchain
  (`tsup.config.ts`: `bundle: false`, `outDir: 'src'`) and this phase does not add one. Reproduce
  with `for f in src/dapps/decode/*.js; do npx esbuild --minify "$f"; done | wc -c` — `esbuild`
  already ships as a `tsup` dependency, so this adds nothing to `package.json`, and stdout means
  no artifact ever lands in `src/`, the tree that is actually served. **No pre-phase minified
  baseline was ever recorded** (D-01 recorded a gzip figure derived from a minified build but
  never the minified total itself), so this number is reported as an absolute, context for the
  pair, and is not itself a gate.

**The largest contributors to this phase's increment**, by name, since the ROADMAP's own size
checkpoint asks for them: the full ABI codec (`abi.js`, 16,606 bytes), the sole-fetch-bearing
transport (`transport.js`, 12,418 bytes), the `eth-calldata` decoder (`decoders-eth-calldata.js`,
9,429 bytes), keccak-256 (`keccak.js`, 4,585 bytes), the registry adapters
(`signatures.js`, 4,553 bytes), and the Log tab / link / settings growth inside `ui.js` (+7,996
bytes over its Phase 4 size).

**Headroom, against the pair this phase's checkpoint approved: `< 128 KB uncompressed` and
`< 32 KB gzipped`.** DEC-16's original, now-superseded single `< 60 KB uncompressed` ceiling did
not survive this phase — see `.planning/REQUIREMENTS.md`'s DEC-16 line for the full reasoning,
stated once there and referenced rather than repeated here. Against the approved pair: **17,603 bytes
(~17.6 KB) of uncompressed headroom** (128,000 − 110,397) and **4,939 bytes (~4.9 KB) of gzipped
headroom** (32,000 − 27,061) remain before Phase 6's Etherscan ABI adapter and proxy follower.
Gzip is the tighter of the two margins and is the figure that matters for real transfer cost.

This was a **reported running total, confirmed against the full catalogue at the close of Phase 6 —
not a threshold enforced by any test.** The confirmation below is that close.

**Phase 6 measurement**, taken from a fresh build after this phase's own commits landed. The set
is derived from `src/dapps/decode/manifest.json`'s `dependencies` array plus its `entry` — never a
filesystem glob — because the transpiler runs with `clean: false` (`tsup.config.ts`), so a module
removed or renamed from the entry list would leave its old compiled artefact sitting in the
directory for a glob to keep counting toward both the size and the module count. Reproduce with:

```
npx tsup && node -e '
const fs=require("node:fs");
const m=require("./src/dapps/decode/manifest.json");
const list=[...m.dependencies,m.entry].map((p)=>"src/"+p).sort();
console.log(list.join(" "));
' | xargs -I{} sh -c 'cat {} | wc -c; cat {} | gzip -9 | wc -c'
```

— concatenating the sorted, manifest-derived list for the uncompressed and concatenated-gzip
figures, then each file's own `gzip -9 | wc -c` summed separately for the transfer estimate below.

| Module | Bytes |
|---|---|
| `ui.js` | 29,535 |
| `abi.js` | 18,139 |
| `transport.js` | 16,094 |
| `decoders-eth-calldata.js` | 12,769 |
| `core.js` | 10,384 |
| `annotators.js` | 7,656 |
| `tx-source.js` | 6,804 |
| `abi-source.js` | 6,370 |
| `cache.js` | 6,071 |
| `signatures.js` | 5,441 |
| `decoders-abi-words.js` | 5,436 |
| `decoders-url.js` | 4,713 |
| `keccak.js` | 4,585 |
| `codecs.js` | 4,342 |
| `decoders-jwt.js` | 4,207 |
| `decoders-base64.js` | 2,895 |
| `decoders.js` (hex) | 1,863 |
| `dapp.js` | 1,084 |
| **Total (18 modules)** | **148,388** |

**Four figures, per the Round 2 review disposition that added the fourth** (concatenated gzip
alone understates real transfer cost for separately-loaded module scripts, each of which gets its
own compression stream):

| Metric | Value | Delta vs. Phase 5 close (110,397 / 27,061, 14 modules) |
|---|---|---|
| Uncompressed | **148,388 bytes** | +37,991 bytes (+34.4%) |
| Gzipped (concatenated — the NORMATIVE DEC-16 metric) | **36,171 bytes** | +9,110 bytes (+33.7%) |
| Gzipped (sum of per-file — reported, not gated) | **43,221 bytes** | not tracked before this phase |
| Modules | **18** | +4 |

- **DEC-16's pair is read decimally**: 128 KB is 128,000 bytes and 32 KB is 32,000 bytes — the
  stricter of the two available readings (the binary reading would allow 131,072 / 32,768), so no
  gate in this phase could ever have passed a payload the requirement forbade under the looser one.
- **Concatenated gzip is the NORMATIVE DEC-16 metric** — it is what the budget was set against and
  what every prior plan in this phase reported, so it is the only figure comparable across phases.
  **Sum-of-per-file gzip is the transfer estimate, reported and never gated** — not by preference
  but by arithmetic: measured on the 14-module tree this phase started from, concatenated `gzip -9`
  was 27,315 bytes while the per-file sum was already **32,665 bytes — over the old 32,000 limit
  before this phase wrote a line of code.** Gating on it would fail every phase for a condition
  that predates all of them.
- **The uncompressed total is concatenation-order independent; the gzipped total is not.** The
  sorted manifest-derived order used here differs slightly from Phase 5's own shell-glob collation,
  so a gzipped figure computed the two ways over the identical file set can differ by a handful of
  bytes — a fact about ordering, not a regression.
- **Both headline figures — 148,388 uncompressed and 36,171 gzipped — are now over the
  previously-approved 128,000/32,000 pair.** Per the DEC-16 amendment (ratified ahead of this plan;
  see `.planning/REQUIREMENTS.md`'s DEC-16 line for the full reasoning, referenced rather than
  repeated here), this is **reported, not a phase failure**: no scope was shed to chase the old
  number, no minify step was added, and DEC-16's pair itself was not moved. The binding constraints
  remain DEC-05/R5 (no runtime dependencies, no CDN scripts, everything in-repo) and the
  IPFS-servable, source-tree-*is*-the-site posture, for which size discipline is a proxy — not the
  constraint itself.

**The largest contributors to this plan's own increment** (145,488 → 148,388 uncompressed,
35,543 → 36,171 gzipped, both close of 06-05): `ui.js` (the row-index/patch mechanism and its
`onNodeUpdate` subscription, Task 2), `annotators.js` (the name walk, `annCollectAddressNodes`/
`annPatchContractNames`, Task 1) and `decoders-eth-calldata.ts` (the update-channel wiring,
Task 1) — the three files ETH-12 touched. Every other module in the directory is byte-identical to
its 06-05 close.

**The phase's own progression, module count and both headline figures, at the close of each plan**
(uncompressed / gzipped-concatenated):

| Plan | Modules | Uncompressed | Gzipped |
|---|---|---|---|
| Phase 5 close (baseline) | 14 | 110,397 | 27,061 |
| 06-01 | 15 | 116,964 | 28,714 |
| 06-02 | 15 | 119,921 | 29,507 |
| 06-03 | 16 | 125,700 | 30,962 |
| 06-04 | 17 | 133,239 | 32,732 |
| 06-05 | 18 | 145,488 | 35,543 |
| **06-06 (this plan, phase close)** | **18** | **148,388** | **36,171** |
| 06-UAT gap closure (the nineteenth module lands) | 19 | 154,701 | 37,952 |
| **v1.2 milestone close (after PR #1's review fixes)** | **19** | **155,443** | **38,063** |

Measured against the tree at phase close, *after* the three `fix(06-review)` commits (CR-01,
CR-02, WR-05). An earlier revision of this section reported 148,138 / 36,175, taken at the
`docs(06-06)` measurement commit and therefore three commits stale; the review fixes added ~250
bytes to `transport.js` and `abi-source.js` and removed a few from `tx-source.js`. The correction
is recorded rather than silently overwritten because a reported metric that is quietly refreshed
is no more trustworthy than a gate that is quietly raised — which is the whole reason DEC-16 is
reported rather than gated. Note gzip is not monotonic in input size: the concatenated figure
fell by 4 bytes while the uncompressed total rose by 250.

**The two rows after the phase close**, recorded the same way and for the same reason a stale
figure was corrected rather than overwritten above. The first is the nineteenth module,
`creation-code.js`, written to close a UAT gap after the phase-close measurement was taken. The
second is the milestone-close figure, measured after the eleven commits that answered PR #1's two
code reviews: +742 bytes uncompressed and +111 gzipped, spread across `abi-source.js`, `cache.js`,
`transport.js`, `tx-source.js`, `creation-code.js`, `ui.js` and `decoders-eth-calldata.js`. No
module was added or removed. Reproduce either row with the command above. **155,443 / 38,063 is
the final reported v1.2 figure** — over the retired 128,000/32,000 pair, reported and not gated,
exactly as the DEC-16 amendment provides for.

**The shedding order and its reserve trigger** (recorded 06-01, restated here at the close, per
this plan's own obligation): least user-visible first — the persistent cache tier, then the
explorer leg of the transaction source, then POST Copy-as-cURL — triggered at 122,000 bytes
uncompressed or 30,500 bytes gzipped. **The trigger fired at the close of Plan 03** (125,700
uncompressed / 30,962 gzipped, both past the reserve though still under the then-hard 128,000/
32,000 pair) and stayed fired for the rest of the phase. **Nothing was shed.** Plan 04 built the
persistent cache tier in full; Plan 05 built the explorer transaction leg and extended
Copy-as-cURL to POST, also in full — all three items in the recorded order were implemented
rather than cut, once Plan 04's own blocking checkpoint ratified the DEC-16 restoration (a
measured-and-reported metric, no longer a pass/fail ceiling) ahead of building any of them. The
shedding order's own precondition — a gate that would otherwise have blocked the phase — no
longer existed once that ratification landed, which is why an unfired-after-04 outcome was never
in question: it fired once, early, and the phase kept building anyway, deliberately.
