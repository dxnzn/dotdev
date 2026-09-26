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

`DecodeContext` also carries three **optional** ports a host may supply, each of which a decoder
must treat as absent-capable rather than assumed:

- `transport?: TransportPort` — a rate-limited, deduplicated, retried network primitive. This
  dapp's own `init()` constructs one from `window.DxDecode.transport` when that module loaded;
  a host that omits the module (or a decoder used standalone) sees `ctx.transport` as `undefined`.
- `abis?: AbiSourcePort` — a verified-ABI lookup by target address. Not supplied by this dapp's
  own composition root this phase (no adapter exists until Phase 6's Etherscan integration).
- `signatures?: SignatureLookupPort` — the 4-byte-selector-to-signature resolver, backed here by
  `window.DxDecode.signatures`'s registry adapters when a transport is also present.

## Share links

Pressing **Copy link** writes the current decoder and input into the address bar via
`history.replaceState` — never on a keystroke, a paste, or a decode, and never causing a route
change. The emitted form always carries a slash between the route and the query:

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

This is a **reported running total, confirmed against the full catalogue at the close of Phase 6 —
not a threshold enforced by any test.**
