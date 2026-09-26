# decode

A generic decoder framework. This phase ships its skeleton — the route, the two-column layout,
the `DecodeNode` result tree, the Result/Raw/Log tabs, and URL-addressable share links — proven
end-to-end by one deliberately trivial decoder, `hex`. Phases 4-6 add decoders through the same
seams without touching the renderer, the registry, or the node type again.

## Namespace

This dapp's window namespace is `window.DxDecode` — a **dapp** namespace, not a framework one.
The `Dx*` prefix elsewhere on this site (`DxKit`, `DxTheme`, `DxSettings`, `DxWallet`) names
vendored DxKit itself; `DxDecode` is this dapp's own, chosen because a dapp meant to be lifted
into another DxKit shell must not carry this org's name (`Dnzn*`) in its global. A reader who
assumes `Dx*` always means "look in the framework" will look for `DxDecode` in the wrong place.

## Adding a decoder

Adding a decoder costs three touchpoints, no more:

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

That is the entire cost — this is the whole argument for `core.ts`'s registry and this
directory's file split (D-05, D-09): only one decoder in this phase needs to prove it, but the
seam is real for the next one too.

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
not merely asserted here. `hex`, this phase's only decoder, decodes entirely on-device. The Log
tab's empty state states this directly; a future decoder that does reach out will list every
request there, with credentials redacted.

## Size

The five compiled modules in this directory (`codecs.js`, `core.js`, `decoders.js`, `ui.js`,
`dapp.js`) total **33,201 bytes** of uncompressed JavaScript, measured after a build at the close
of this phase. This is the DEC-16 baseline the running budget in Phases 4, 5 and 6 is tracked
against, against a target of under 60 KB with the full first-wave decoder catalogue.
