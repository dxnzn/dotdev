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

## Privacy

No bare reference to a network or storage API appears in this directory's source (source scan),
and the mounted dapp performs no network, storage or history write before Copy link is pressed
(runtime test) — both enforced by `test/decode-portability.test.ts` and `test/decode-url.test.ts`,
not merely asserted here. Every decoder this dapp ships — `hex`, `base64`, `url`, `jwt` and
`abi-words` — decodes entirely on-device; none of them reaches the network, which is exactly what
the portability guard's source scan certifies for every file in this directory, not only the first
one. The Log tab's empty state states this directly; a future decoder that does reach out will list
every request there, with credentials redacted.

## Size

Measured with the command Phase 3 established — `npx tsup && wc -c src/dapps/decode/*.js` — run
fresh rather than read from this document, whose own figure had already gone stale once before
this phase began.

**Phase 3 baseline**, re-measured before this phase's first edit (`04-01-SUMMARY.md`) — this
corrects the figure this section previously stated, which was itself already stale by the time
it was written:

| Module | Bytes |
|---|---|
| `codecs.js` | 3,957 |
| `core.js` | 7,624 |
| `dapp.js` | 1,084 |
| `decoders.js` | 1,863 |
| `ui.js` | 18,979 |
| **Total** | **33,507** |

**After Phase 4** — four new decoder modules, plus growth in the framework modules this phase's
new decoders needed (`core.ts` gained `jsonToNode`/`jsonToRaw`/`formatUtcDate`, `codecs.ts` gained
`Percent`/`Base64.splitSegments`, `ui.ts` gained `renderWordTable`). Measured after the phase's
code-review fixes, not before them — the figures this section first carried were written mid-phase
and were stale within the day:

| Module | Bytes |
|---|---|
| `codecs.js` | 4,342 |
| `core.js` | 9,283 |
| `dapp.js` | 1,084 |
| `decoders.js` (hex) | 1,863 |
| `decoders-jwt.js` | 4,207 |
| `decoders-abi-words.js` | 5,384 |
| `decoders-url.js` | 4,713 |
| `decoders-base64.js` | 2,895 |
| `ui.js` | 20,291 |
| **Total** | **54,062** |

**Phase 4 delta: +20,555 bytes** (54,062 − 33,507).

**Cross-check.** Subtracting only the four new decoder modules from the current total
(54,062 − 17,199 = 36,863) does **not** reproduce the 33,507 baseline above — this phase also grew
`core.js`, `codecs.js` and `ui.js` by a combined 3,356 bytes (1,659 + 385 + 1,312), and
36,863 − 33,507 = 3,356 exactly. The figure `04-01-SUMMARY.md` recorded before this phase's first
edit, not this subtraction, is the baseline the delta above is computed against.

**Headroom.** Against the DEC-16 ceiling of under 60,000 bytes uncompressed, Phase 4 consumed
roughly 78% of the ~26,493 bytes of headroom that remained after Phase 3 (20,555 of 26,493 bytes),
leaving **~5,938 bytes (~5.9 KB)** before the ceiling. Phase 5's keccak-256 plus the full ABI codec
plus the network transport is the largest single increment still expected against this same
budget.

This is a **reported running total, confirmed against the full catalogue at the close of Phase 6 —
not a threshold enforced by any test.**
