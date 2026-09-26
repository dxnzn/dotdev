// The decode dapp's contract — the phase's whole reason to exist. Frozen here, once, at
// Task 0's checkpoint (approve-as-specified): every port, every module-shaped interface and
// every member the whole phase ends with is declared in this single pass. Plans 02 through 06
// implement against this file and do not edit it again.
//
// No import/export anywhere in this file, matching D-08: it is a global ambient script, not a
// module, exactly like src/types/globals.d.ts. Picked up by the root tsconfig's
// "src/**/*.ts" include (a .d.ts filename still ends in ".ts") and, scoped, by
// tsconfig.decode.json's own include list.

// ── The result tree (D-01, D-02, D-03) ──────────────────────────────────────────────────

// The published contract every decoder in Phases 4-6 returns. D-02: value deliberately keeps
// bigint — a uint256 is a bigint, not a lossy number or a pre-formatted string; no serializer
// is written in this phase because nothing consumes one yet. D-03: no id/path member —
// position in traversal order is identity, and copy reads `raw` off the clicked element.
type DecodeNode = {
  label: string;
  type?: string;
  value?: string | number | bigint | null;
  display?: 'address' | 'txhash' | 'hex' | 'int' | 'text' | 'json' | 'bool';
  annotations?: string[];
  provenance?: 'verified' | 'registry' | 'unresolved' | 'local';
  children?: DecodeNode[];
  collapsed?: boolean;
  raw?: string;
  warning?: string;
  // D-01: a failed node is marked by this field sitting beside `warning`, not by a `kind`
  // discriminator and not by overloading `warning`. node.error != null is the branch test.
  // A node can carry both — a partially-decoded node with a caution is not the same thing
  // as one that did not decode at all.
  error?: string;
  // Phase 5 Task 0 (option A, ratified): the ONLY concession this phase makes against 04 D-05's
  // "these seams don't change" freeze, taken under that decision's own additive-concession
  // clause (purely additive, a new optional field, never a changed one, recorded as a finding —
  // see 05-01-SUMMARY.md's d05_additive_concession heading). `link` is an ALREADY-COMPOSED,
  // ALREADY-SHAPE-VALIDATED target string — the decoder builds it (via `ctx.links` for an
  // explorer url, `ctx.settingsRoute` for the settings route) and the renderer draws whatever it
  // is given, unchanged from D-30's decoder-side rule. Absent means no link: an unknown chain, or
  // a host with no settings dapp, produces a plain node with no anchor.
  link?: string;
  // Tells the renderer which kind of anchor to build: 'external' gets target="_blank" and
  // rel="noopener noreferrer" (an explorer link leaves the page); 'route' is an in-shell hash
  // route and gets neither. Named `link`/`linkKind` — NOT `href`/`url`/`src`/`target` — on
  // purpose: `href`/`src`/`open`/`action` all sit on test/decode-portability.test.ts's
  // NETWORK_IDENTIFIERS list, matched as whole words against comment-stripped source with string
  // literals retained, and this .d.ts is scanned as a .ts file; `url` is avoided separately
  // because it is a registered decoder id and test/decode-ui.test.ts:421 forbids any decoder id
  // appearing as a string literal in ui.ts. Do not "tidy" these names later.
  linkKind?: 'external' | 'route';
};

// ── Task 0's checkpoint additions (approve-as-specified) ────────────────────────────────

// What a DecoderPort.decode(...) resolves to. Additive over handoff §5.1's bare
// Promise<DecodeNode>: without rawBytes the Raw tab would have to recover bytes by parsing
// the root node's `raw` string as hex, which would make the renderer decoder-specific — the
// exact coupling this phase exists to prevent. rawView names which Raw renderer the decoder
// wants; 'hex-dump' is the only value this phase implements (D-16). D-16 already promises
// Phase 4 a second one ('abi-words', TXT-05), selected by the decoder — so this member is a
// contract term this phase owes, not scope added to it.
interface DecodeOutput {
  node: DecodeNode;
  rawBytes?: Uint8Array | null;
  rawView?: string;
}

// What DecodeService.decode(...) resolves to. `stale` is the discriminator that lets a caller
// drop a superseded decode without string-matching an error message's text.
interface DecodeRunResult {
  node: DecodeNode;
  rawBytes: Uint8Array | null;
  rawView: string;
  stale: boolean;
}

// ── Ports (handoff §5.1, narrowed/extended per CONTEXT.md D-04/D-06/D-12) ───────────────

interface SettingSpec {
  key: string;
  required: boolean;
  why: string;
}

interface DecodeContext {
  // D-06: a flat Record<string, unknown> snapshot resolved by DecodeService from the
  // decoder's own bare setting keys — never a { section, key } pair. A decoder never learns
  // which plugin namespace (if any) backs a setting, which is what keeps DEC-14 true.
  settings: Record<string, unknown>;
  log: LogPort;
  signal: AbortSignal;
  links: LinkPort;
  // Phase 5 Task 0 (CONTEXT.md D-06): five OPTIONAL members. Optionality is load-bearing —
  // test/decode-registry.test.ts and every Phase 3/4 decoder construct a bare context, and a
  // required member here turns those suites red at once.
  transport?: TransportPort;
  abis?: AbiSourcePort;
  signatures?: SignatureLookupPort;
  // The contract address the call was sent to, when one is known. What AbiSourcePort.getAbi is
  // called with. A single pasted calldata blob has no target, so this phase has no production
  // supplier and the verified rung is stub-only — deliberately (see AbiSourcePort's own comment).
  target?: string;
  // The settings dapp's route, resolved by ui.ts from core.findSettingsRoute(dx) and passed in
  // here so a decoder can satisfy DEC-13 without ever seeing the host `dx` — DecoderPort.decode
  // takes no host handle, and hardcoding '/settings' inside this directory is exactly the
  // coupling the portability guard forbids. null/absent when the host has no settings dapp,
  // which renders the sentence with no link rather than a broken one.
  settingsRoute?: string;
}

interface DecoderPort {
  id: string;
  label: string;
  settings: SettingSpec[];
  // Synchronous, no network — 0..1 confidence. D-23's threshold is applied by the resolver
  // (plan 03-03), not by the decoder itself.
  canDecode(input: string): number;
  decode(input: string, ctx: DecodeContext): Promise<DecodeOutput>;
}

interface DecoderRegistry {
  // D-05: first registration for a given id wins, so load order (manifest `dependencies`)
  // stays deterministic even if a script were ever loaded twice.
  register(decoder: DecoderPort): void;
  get(id: string): DecoderPort | undefined;
  // Preserves registration order — D-23's tie-break rule depends on it.
  list(): DecoderPort[];
  size(): number;
}

interface LogEntry {
  timestamp: number;
  method: string;
  host: string;
  path: string;
  status: number;
  duration: number;
  attempt: number;
  // Phase 5 Task 0 (CONTEXT.md D-23): six OPTIONAL members. Optionality is load-bearing —
  // LOG_COLUMNS is typed `keyof LogEntry` (ui.ts:388-396) and renderLogTable is a flat
  // seven-column table, so a required member breaks both at once. `url`, `query` and
  // `requestHeaders` are the ALREADY-REDACTED forms — D-24: the transport stores the redacted
  // values, never the real ones, so every surface (log display, Copy as JSON, Copy as cURL)
  // inherits redaction structurally instead of each re-implementing it.
  url?: string;
  query?: Record<string, string>;
  // NOT optional decoration: NET-07 promises both the api key AND an Authorization header are
  // redacted in the log display and in both copy actions. Without a headers member on the
  // entry, a redacted Authorization value has nowhere to live. D-08 means no Phase 5 request
  // actually sends one (the key rides in the query parameter) — this member is exercised by a
  // synthetic header in the transport suite, stated as such rather than pretended to be live.
  requestHeaders?: Record<string, string>;
  requestBody?: string;
  responseBody?: string;
  error?: string;
}

interface LogPort {
  record(entry: LogEntry): void;
  // Delivers the CURRENT entries immediately on subscribe, then again on every change, and
  // returns an unsubscribe function. Without the immediate delivery, D-18's "emptied only by
  // Clear" is visibly false the first time somebody navigates away and back — a remount would
  // render an empty Log tab over a buffer that already has entries in it.
  subscribe(cb: (entries: LogEntry[]) => void): () => void;
  clear(): void;
}

interface LinkPort {
  address(addr: string): string | null;
  tx(hash: string): string | null;
}

// Narrowed from handoff §5.1's { get, set, onChange } to get-only. PROJECT.md rules out
// decode ever having a settings form of its own, so `set`/`onChange` are dead public surface
// a portable decoder would never call — the org's minimal-API-surface rule says leave them out.
interface SettingsPort {
  get(key: string): unknown;
}

// ── Phase 5 ports (CONTEXT.md D-06/D-08/D-09/D-10/D-11/D-13/D-21, Task 0 option A) ───────
//
// All three ports are declared here, in this one pass, because Phase 6's Etherscan ABI
// adapter, transaction adapter and proxy follower are written against exactly these shapes.
// None of them may ever reject — a failed call resolves with an explicit failure branch
// instead, matching this file's established no-throw convention (DEC-12).

// A transport-level request. `dedupe` lets a caller opt an identical in-flight request into
// sharing one network call rather than racing two.
interface HttpRequest {
  method: 'GET' | 'POST';
  url: string;
  query?: Record<string, string>;
  body?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
  dedupe?: boolean;
}

// `ok` is TRANSPORT-LEVEL success, deliberately NOT `Response.ok` (HTTP 2xx). D-10: Etherscan
// reports its own rate-limit and invalid-key failures as HTTP 200 with an in-body
// `{"status":"0",...}` — a consumer that branches on `status`/`Response.ok` treats every one of
// those failures as a success. `ok: false` with `error` set is what NET-04's retry logic and the
// Log tab actually key off.
interface HttpResponse {
  status: number;
  body: string;
  json: unknown;
  attempts: number;
  ok: boolean;
  error?: string;
}

// D-13/D-15: dotdev's own transport — DxKit has no HTTP port to reuse. `transport.ts` is the
// SINGLE file in this directory allowed to reach the network (D-15); every adapter that fetches
// anything (openchain, 4byte, Phase 6's Etherscan adapter) goes through this one method. Never
// rejects (NET-04) — a failed request resolves with `ok: false` and `error` set.
interface TransportPort {
  request(req: HttpRequest): Promise<HttpResponse>;
}

interface AbiInput {
  name: string;
  type: string;
  components?: AbiInput[];
}

interface AbiItem {
  name: string;
  type?: string;
  inputs: AbiInput[];
}

// D-06: the verified-provenance rung. `address` is supplied from DecodeContext.target (below) —
// this phase has no production supplier for `target` (a single pasted calldata blob has no
// target address), so the rung is exercised against a stub here; Phase 6's ETH-08 transaction
// input is what fills it for real. Resolves `null` when unavailable or unconfigured; never
// rejects.
interface AbiSourcePort {
  getAbi(address: string, chainId: number): Promise<{ name: string; abi: AbiItem[] } | null>;
}

interface SignatureCandidate {
  signature: string;
  source: 'local' | 'openchain' | '4byte';
  rank?: number;
}

// A RESULT OBJECT, not a bare array — load-bearing (D-21). A bare `[]` collapses "nobody knows
// this selector" (unavailable: false, empty candidates) into "we could not ask" (unavailable:
// true, reason naming the cause — a transport that gave up after its retry cap, an absent
// adapter, a malformed body). 05-05 surfaces those as different user-facing messages, and the
// distinction is unrecoverable once a bare array has erased it. `candidates` is the CANDIDATE
// list — D-21 forbids presenting a single 4byte hit as authoritative — so the consumer ranks
// and keccak-verifies every one of them (never trusts the list's own order).
interface SignatureLookupResult {
  candidates: SignatureCandidate[];
  unavailable: boolean;
  reason?: string;
}

// Selector resolution order — stated ONCE, here, so no later plan restates it differently:
// `verified` (only when BOTH ctx.abis AND ctx.target are present — a verified ABI is ground
// truth for a known target, and getAbi(address, chainId) has nothing to be called with
// otherwise), then `local` (the in-repo table — the convenience path for when there is no
// target, which is every production decode in this phase), then `registry` (ctx.signatures —
// OpenChain, then 4byte), then `unresolved`. 05-05 cites this comment rather than restating the
// order, and 05-01 Task 1's tests are written against it. Never rejects.
interface SignatureLookupPort {
  lookup(selector: string): Promise<SignatureLookupResult>;
}

// The parsed-signature type tree, shared by both abiParseTypeString (canonical signature
// strings) and abiParseAbiInputs (JSON-ABI AbiInput[] — the shape an AbiSourcePort returns).
// `length` is absent for a dynamic array (`T[]`), present for a fixed one (`T[3]`).
interface TypeNode {
  kind: 'elementary' | 'tuple' | 'array';
  type: string;
  name?: string;
  components?: TypeNode[];
  element?: TypeNode;
  length?: number;
  bits?: number;
  size?: number;
}

// ── The decode service (core.ts) ─────────────────────────────────────────────────────────

interface DecodeServiceOptions {
  registry: DecoderRegistry;
  settings: SettingsPort;
  log: LogPort;
  links: LinkPort;
  // Phase 5 Task 0: the SAME five optional members DecodeContext grows (below), so 05-05's
  // composition root can supply real adapters without a second edit to core.ts. Optionality is
  // load-bearing here too — every plan up to and including this one constructs a bare options
  // object with none of these set.
  transport?: TransportPort;
  abis?: AbiSourcePort;
  signatures?: SignatureLookupPort;
  target?: string;
  settingsRoute?: string;
}

interface DecodeRunOptions {
  signal?: AbortSignal;
}

interface DecodeService {
  // decoderId is nullable — a null/unresolved id (the Auto sentinel with nothing chosen)
  // resolves to an error DecodeRunResult rather than throwing; D-22/D-23's actual resolver
  // logic is plan 03-03's, not this contract's.
  decode(decoderId: string | null, input: string, options?: DecodeRunOptions): Promise<DecodeRunResult>;
}

// ── Module-shaped interfaces — one per per-module sub-key (D-07/D-08) ──────────────────

// WR-02: normalize/isHexLike folded in from decoders.ts's now-deleted HexCodecWithNormalize —
// both are real runtime members plan 03-02's codecs.ts attaches. The "local" extension was a
// global ambient declaration the moment it was written (D-08 — no import/export anywhere in
// this directory), so decoders.ts already depended on the leak while its own comment called it
// "confined to this file". Declared here now, in the one place this contract lives.
interface HexCodec {
  strip0x(input: string): string;
  // Never throws (DEC-12's structural guarantee) — a discriminated result instead.
  decode(input: string): { ok: true; bytes: Uint8Array } | { ok: false; error: string };
  encode(bytes: Uint8Array, options?: { prefix?: boolean }): string;
  normalize(input: string): string;
  isHexLike(input: string): boolean;
}

// WR-02: folded in from core.ts's now-deleted Base64CodecWithUrl. decode()'s bytes are typed as
// the plain Uint8Array codecs.ts's base64Decode actually returns — not the narrower
// Uint8Array<ArrayBuffer> the deleted extension declared to satisfy one caller's
// `new Response(...)` — a contract states what the function returns, not what one consumer
// wishes it returned; that consumer (core.ts's decompressFromShare) narrows locally if needed.
interface Base64Codec {
  decode(input: string): { ok: true; bytes: Uint8Array } | { ok: false; error: string };
  encodeUrl(bytes: Uint8Array): string;
  // 04-03: additive member (Task 0's ratified D-05 reinterpretation — the render contract is
  // frozen, module-shaped interfaces may still grow). Never throws (DEC-12) — a split has no
  // failure branch beyond its own answer, exactly as Utf8.isValid's file-header comment says.
  splitSegments(input: string): string[];
}

interface Utf8Codec {
  isValid(bytes: Uint8Array): boolean;
  decode(bytes: Uint8Array): string | null;
}

// 04-02: additive member on DxDecodeCodecsModule (Task 0's ratified D-05 reinterpretation, see
// 04-01-SUMMARY.md — the render contract is frozen, module-shaped interfaces may still grow).
// window.DxDecode.codecs is assigned a fresh object literal against this typed target, so
// TypeScript excess-property-checks it and Percent could not be attached without first being
// declared here.
interface PercentCodec {
  // Never throws (DEC-12) — the platform decodeURIComponent's URIError is converted to the
  // failure branch at the codec boundary (codecs.ts).
  decode(input: string): { ok: true; value: string } | { ok: false; error: string };
}

interface DxDecodeCodecsModule {
  Hex: HexCodec;
  Utf8: Utf8Codec;
  // WR-02: no longer optional/`unknown` — codecs.ts has assigned a real Base64 value since plan
  // 03-02, and `unknown` was only ever the frozen contract's placeholder for a value added
  // after the freeze. Describing it as `unknown` is exactly the staleness WR-02 exists to close.
  Base64: Base64Codec;
  Percent: PercentCodec;
}

// WR-02: folded in from core.ts's now-deleted top-level interface — the auto-detect resolver's
// return shape (D-22/D-23, plan 03-03).
interface AutoDetectResolution {
  decoderId: string | null;
  score: number;
  reason: string;
}

// WR-02: folded in from core.ts's now-deleted top-level interface — the share-link query shape
// (D-19/D-20/D-21/DEC-03).
interface DecodeQueryParams {
  decoder?: string;
  data?: string;
  z?: string;
}

interface DxDecodeCoreModule {
  createDecodeService(options: DecodeServiceOptions): DecodeService;
  // What the tracer's own DecodeContext.settings resolves through — a settings port whose
  // get() always returns undefined, which is all `hex`'s empty `settings: []` needs.
  createNullSettingsPort(): SettingsPort;
  // D-23: the auto-detect confidence threshold, one named constant. Plan 03-02 scores hex's
  // own canDecode curve against it and plan 03-03 writes the resolver that applies it —
  // nothing in this plan's own code consults it. Both later plans read this one value rather
  // than each guessing their own.
  AUTO_DETECT_THRESHOLD: number;
  // D-12: resolves the settings dapp's route from dx.getManifests() rather than hardcoding
  // '/settings' — hardcoding would put a literal dotdev route inside the directory D-11's
  // portability guard polices.
  findSettingsRoute(dx: unknown): string | null;
  // WR-03: same reasoning, for decode's OWN route — resolves it from dx.getManifests() rather
  // than hardcoding '/tools/decode' inside buildShareUrl.
  findOwnRoute(dx: unknown): string | null;
  // WR-02: folded in from core.ts's now-deleted DxDecodeCoreModuleWithHelpers — every member
  // below is a real runtime attachment (plans 03-02 through 03-06), not a gap in the contract.
  createLiveLogStore(): LogPort;
  createExplorerLinks(chainId: number | string): LinkPort;
  // D-22/D-23: the auto-detect resolver.
  resolve(input: string): AutoDetectResolution;
  // 04-01: additive member (Task 0's ratified D-05 reinterpretation — the render contract is
  // frozen, this module-shaped interface may still grow). coreModule is an explicitly typed
  // object literal, so an undeclared member cannot be attached to it at all; this is that
  // declaration. Shared by this plan's base64 decoder and plan 04-03's jwt decoder — walks any
  // parsed JSON value into a DecodeNode tree, one child per key/index, bounded recursion.
  jsonToNode(label: string, value: unknown): DecodeNode;
  // CR-01 (04-review): additive member. jsonToNode's own recursion is bounded at
  // JSON_WALK_MAX_DEPTH, but `JSON.stringify` on the same parsed value is a second, unbounded
  // recursion — this wraps it and returns undefined (never throws) on pathological nesting, so
  // a decoder's `raw` for a JSON node is total the same way the tree already is.
  jsonToRaw(value: unknown): string | undefined;
  // 04-03: additive member (Task 0's ratified D-05 reinterpretation — the render contract is
  // frozen, this module-shaped interface may still grow). epochSeconds -> YYYY-MM-DDTHH:MM:SSZ,
  // or null when the resulting Date is invalid (see the function's own comment in core.ts for
  // why a nullable return, not a NaN-shaped string, is the total form of this signature).
  formatUtcDate(epochSeconds: number): string | null;
  LOG_CAPACITY: number;
  parseDecodeQuery(path: string): DecodeQueryParams;
  // WR-03: `route` is the host's OWN route for this dapp (resolved via findOwnRoute, falling
  // back to the current mount's own hash) — never a literal.
  buildShareUrl(route: string, decoderId: string | null, dataParam: string, compressed: boolean): string;
  SHARE_SIZE_WARNING_BYTES: number;
  supportsCompression(): boolean;
  compressForShare(input: string): Promise<string>;
  decompressFromShare(z: string): Promise<{ ok: true; value: string } | { ok: false; error: string }>;
}

// WR-05: init()'s return value — still callable as a bare cleanup (dapp.ts's existing shape:
// `decodeCleanup: (() => void) | null`, unwidened), plus applyQuery(), which re-applies a
// share-link query to this ALREADY-mounted instance. DxKit does not remount a dapp when the
// route changes within itself (the vendored shell's own mountDapp() emits dx:route:subpath
// instead of dx:mount when the dapp is already current) — a share link followed while already on
// this route needs to reach the running instance, not a fresh one, which is what applyQuery is
// for. Re-applying reuses the listeners, the log subscription and any in-flight decode rather
// than tearing the mount down and rebuilding it.
// quick-260905-ac3: two additive members, past this file's original Task-0 freeze. That freeze
// scoped plans 02-06's OWN execution against a stable contract; it was never a promise that no
// later, separately-reviewed change could ever extend it. Needed because SHARE-04 (a shell
// header button carrying decode's plain share link) can only be satisfied correctly from
// OUTSIDE this directory — src/dapps/decode/*.ts is scanned by test/decode-portability.test.ts
// for any `Dnzn*`-prefixed identifier (DEC-14), so no file in this directory may itself name
// window.DnznShareTarget. Exposing these two generic hooks lets a host shell (this repo's
// src/main.ts) drive D-19's exact press path without decode knowing anything about who calls it
// or why — the same reasoning applyQuery's own host-integration seam already establishes.
interface DxDecodeUiHandle {
  (): void;
  applyQuery(query?: DecodeQueryParams): void;
  // The SAME function #decode-share-btn's own click handler calls — one owner, two callers.
  // Builds the plain share URL, writes it via history.replaceState (D-19), and returns it.
  pressPlainShare(): string;
  // Called by a host integration when ITS OWN copy of `url` failed to reach the clipboard —
  // reveals it in this mount's own #decode-copy-reveal field, exactly as a failed in-panel
  // press already does.
  revealShareFailure(url: string): void;
}

interface DxDecodeUiModule {
  // The driving adapter. dx is intentionally untyped here (matching DnznWalletModule's own
  // init(dx: unknown) in src/types/globals.d.ts) — this task's renderer touches none of its
  // members; a later plan narrows call sites as it starts reading from it. `query` (WR-02:
  // folded in from dapp.ts's now-deleted DxDecodeUiModuleWithQuery) is the share-link query
  // parsed out of the routed path (D-19/DEC-03) — optional because a mount with no link still
  // calls init() with nothing to apply.
  init(container: HTMLElement, dx: unknown, query?: DecodeQueryParams): DxDecodeUiHandle;
}

// WR-02: the pure render functions ui.ts exposes only so test/decode-ui.test.ts can drive the
// renderer with hand-built DecodeNode literals directly (folded in from ui.ts's now-deleted
// DxDecodeUiModuleWithHelpers) — kept as a SEPARATE interface, not merged into DxDecodeUiModule,
// so the module's real public surface stays just `init`. ui.ts types its exported object as the
// intersection `DxDecodeUiModule & DxDecodeUiTestHooks` at its one assignment site; that is a
// type used there, not a second interface declaration anything could ever declaration-merge with.
interface DxDecodeUiTestHooks {
  renderNode(node: DecodeNode): HTMLElement;
  displayDispatchKeys(): string[];
  renderRaw(rawBytes: Uint8Array | null, rawView: string): HTMLElement;
  rawViewDispatchKeys(): string[];
  renderLog(entries: LogEntry[]): HTMLElement;
  // Phase 5 Task 0: the six members 05-04 and 05-06 implement, declared here and ONLY here.
  // ui.ts:872-885 assigns its module object as the exact intersection
  // `DxDecodeUiModule & DxDecodeUiTestHooks`, so it is excess-property checked — a hook
  // implemented in a later plan but not declared here fails tsc, and one declared here but not
  // implemented by the end of the phase fails it too. That symmetry is what makes the "types.d.ts
  // is written once" claim enforceable rather than merely asserted (grep-checked in Task 0's own
  // verify gate).
  createShellSettingsPort(dx: unknown): SettingsPort;
  renderLogDetail(entry: LogEntry): HTMLElement;
  logEntriesToJson(entries: LogEntry[]): string;
  logEntryToCurl(entry: LogEntry): string;
  uiCreateExternalLink(target: string, text: string, kind: 'external' | 'route'): HTMLElement;
  applyFullValueTitle(el: HTMLElement, node: DecodeNode): void;
}

// ── Phase 5 module-shaped interfaces (Task 0, one per new per-module sub-key) ────────────
//
// Each declares EVERY member its file ends the phase with — not only what this plan (05-01)
// attaches — so a later plan's addition is a passthrough, never a second edit to this file.

interface DxDecodeKeccakModule {
  hash(input: Uint8Array): Uint8Array;
  selector(signature: string): string;
}

interface DxDecodeAbiModule {
  parseTypeString(sig: string): { name: string; types: TypeNode[] } | { error: string };
  parseAbiInputs(inputs: AbiInput[]): TypeNode[];
  canonicalType(type: TypeNode): string;
  canonicalSignature(name: string, types: TypeNode[]): string;
  decodeParameters(types: TypeNode[], data: Uint8Array, base: number, depth: number): DecodeNode[];
  // 05-02 completes full coverage of these two (bytes/string/arrays/tuples); declared now so
  // the module's eventual shape is fixed before either plan writes against it. Optional because
  // this plan (05-01) wires only the elementary static types — the dynamic branch must exist and
  // be reachable in Task 1's architecture, but is not yet expected to be a required member of
  // every intermediate assignment.
  isDynamic?(type: TypeNode): boolean;
  headWidth?(type: TypeNode): number;
}

interface DxDecodeSignaturesModule {
  // 05-01 (this plan).
  createLocalSignatureTable(): SignatureLookupPort;
  // 05-05 — optional here because this plan's signatures.ts assigns an object literal typed
  // against this interface while implementing only createLocalSignatureTable; a required member
  // 05-05 alone attaches would fail this plan's own tsc gate.
  createOpenChainAdapter?(transport: TransportPort): SignatureLookupPort;
  create4byteAdapter?(transport: TransportPort): SignatureLookupPort;
  createSignatureResolver?(sources: SignatureLookupPort[]): SignatureLookupPort;
}

interface DxDecodeTransportModule {
  // 05-03.
  createTransport(options: unknown): TransportPort;
}

// The shared namespace type. Every sub-key is optional — not only the ones a later plan
// attaches — because every runtime module in this directory opens with
// `window.DxDecode ??= {}`, and that assignment only typechecks against a type whose every
// member is optional. Do not "tidy" a member to required; it breaks the one line every module
// starts with.
interface DxDecodeNamespace {
  core?: DxDecodeCoreModule;
  codecs?: DxDecodeCodecsModule;
  registry?: DecoderRegistry;
  ui?: DxDecodeUiModule;
  // The single live log store instance (D-18), created once at module load in core.ts.
  log?: LogPort;
  // quick-260905-ac3: the currently mounted instance's handle, set by dapp.ts's own dx:mount
  // listener and cleared on dx:unmount — a generic single-live-instance seam, mirroring `log`'s
  // existing shape, for a host shell to reach pressPlainShare/revealShareFailure without decode
  // coupling to what uses it.
  activeUi?: DxDecodeUiHandle | null;
  // Phase 5 Task 0: every new module in this phase, optional like every existing sub-key —
  // `window.DxDecode ??= {}` only typechecks against a type whose every member is optional.
  keccak?: DxDecodeKeccakModule;
  abi?: DxDecodeAbiModule;
  signatures?: DxDecodeSignaturesModule;
  transport?: DxDecodeTransportModule;
}

// dotdev's dapp namespace, not a DxKit framework namespace — the `Dx*` prefix has so far
// meant vendored DxKit (DxKit, DxTheme, DxSettings, DxWallet); DxDecode is this dapp's own,
// per D-07. Not `Dnzn*`: a dapp meant to be lifted into another DxKit shell (DEC-14) must not
// carry this org's name in its global.
declare interface Window {
  DxDecode?: DxDecodeNamespace;
}
