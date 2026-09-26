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

// ── The decode service (core.ts) ─────────────────────────────────────────────────────────

interface DecodeServiceOptions {
  registry: DecoderRegistry;
  settings: SettingsPort;
  log: LogPort;
  links: LinkPort;
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
}

interface Utf8Codec {
  isValid(bytes: Uint8Array): boolean;
  decode(bytes: Uint8Array): string | null;
}

interface DxDecodeCodecsModule {
  Hex: HexCodec;
  Utf8: Utf8Codec;
  // WR-02: no longer optional/`unknown` — codecs.ts has assigned a real Base64 value since plan
  // 03-02, and `unknown` was only ever the frozen contract's placeholder for a value added
  // after the freeze. Describing it as `unknown` is exactly the staleness WR-02 exists to close.
  Base64: Base64Codec;
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
}

// The shared namespace type. Every sub-key is optional — not only the ones a later plan
// attaches — because every one of the five runtime modules opens with
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
}

// dotdev's dapp namespace, not a DxKit framework namespace — the `Dx*` prefix has so far
// meant vendored DxKit (DxKit, DxTheme, DxSettings, DxWallet); DxDecode is this dapp's own,
// per D-07. Not `Dnzn*`: a dapp meant to be lifted into another DxKit shell (DEC-14) must not
// carry this org's name in its global.
declare interface Window {
  DxDecode?: DxDecodeNamespace;
}
