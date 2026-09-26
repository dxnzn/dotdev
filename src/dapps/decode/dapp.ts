// decode dapp.js — DxKit lifecycle glue only, matching the settings dapp's shape. All domain
// logic lives in codecs.js/core.js/decoders.js/ui.js, loaded via manifest dependencies before
// this file.
//
// No AbortController is created here. An earlier draft had one per mount, which would have
// split ownership of a single signal with the per-decode controller ui.ts needs (plan 03-05:
// one controller per Decode press, aborting the previous). Two owners for one signal is how a
// signal leaks — ui.ts owns it, and because this file calls ui.ts's cleanup on unmount, D-04's
// "an in-flight decode cannot outlive the route" still holds with one owner instead of two.

// Minimal ambient extension for the one host global this file reads. Not part of the
// DxDecode contract (types.d.ts) — src/types/globals.d.ts doesn't declare Window.__DXKIT__
// either; every existing dapp.ts/shell.ts/cic.ts that reads it does so under the repo's
// pre-existing untyped gap (one of the 314 errors the repo-wide, unscoped tsc reports).
// Declaring it narrowly here keeps decode's own scoped typecheck green without widening any
// shared file.
// biome-ignore lint/correctness/noUnusedVariables: global declaration merge, read via window.__DXKIT__ below
interface Window {
  __DXKIT__?: unknown;
}

// dx:mount/dx:unmount are DxKit dapp-lifecycle events, dispatched with a CustomEvent detail —
// not a key of the DOM's own WindowEventMap, so `addEventListener` falls back to its generic
// `Event` overload. Every existing dapp.ts in this repo hits the same untyped `.detail` access
// under the repo-wide, unscoped tsc (one more of the 314 pre-existing errors); decode's own
// scoped gate does check this file, so the cast is load-bearing here, not cosmetic. Cast at the
// callback boundary and keep the `e.detail.*` shape every other dapp.ts uses (rather than
// extracting to a differently-named local) — test/dapps.test.ts's lifecycle-wiring case
// source-matches on the literal `e.detail.id !== '<id>'` text across every dapp.
type DxMountEvent = CustomEvent<{ id: string; container: HTMLElement; path: string }>;

// WR-02: parseDecodeQuery and init()'s third (query) parameter are now declared directly on
// types.d.ts's DxDecodeCoreModule/DxDecodeUiModule — the local extensions that used to bridge
// the gap between the frozen Task-0 contract and these real runtime members have been folded
// into the single-owner contract instead, so no cast is needed at this call site any more.

// dx:route:subpath is dispatched with the same `{ id, path }` shape dx:mount's own DxMountEvent
// carries, minus `container` (WR-05: the container does not change — this event fires precisely
// BECAUSE the dapp is already mounted there) plus `previousPath`, unused here.
type DxSubpathEvent = CustomEvent<{ id: string; path: string; previousPath: string }>;

let decodeCleanup: DxDecodeUiHandle | null = null;
let decodeContainer: HTMLElement | null = null;

window.addEventListener('dx:mount', async (rawEvent) => {
  const e = rawEvent as DxMountEvent;
  if (e.detail.id !== 'decode') return;

  const container = e.detail.container;
  decodeContainer = container;

  if (window.DxDecode?.ui?.init) {
    // DEC-03: the query lives inside the routed path, not document.location.search — this site
    // routes on the hash, so the query string arrives inside e.detail.path instead (handoff
    // §4.3). Loading a link never itself runs a decode (DEC-05) — that is ui.ts's job to honour.
    const query = window.DxDecode.core?.parseDecodeQuery(e.detail.path);
    decodeCleanup = window.DxDecode.ui.init(container, window.__DXKIT__, query);
    // SHARE-04: the generic single-live-instance seam (types.d.ts's DxDecodeNamespace) a host
    // shell reaches through — this file names nothing about who reads it or why.
    window.DxDecode.activeUi = decodeCleanup;
  }
});

// WR-05: DxKit does not remount a dapp when the route changes WITHIN itself — the vendored
// shell's own mountDapp() emits dx:route:subpath instead of dx:mount once
// lifecycle.getCurrentDapp() already equals this dapp's id. A share link followed while already
// on #/tools/decode (typed into the address bar, or clicked from the page) is exactly that case,
// and DEC-03's "arriving pre-loaded from a link" was silently failing for it — dx:mount alone
// never fires again to apply it. Re-applies to the RUNNING instance via applyQuery() rather than
// tearing down and rebuilding the mount (see ui.ts's own comment beside applyQuery).
window.addEventListener('dx:route:subpath', (rawEvent) => {
  const e = rawEvent as DxSubpathEvent;
  if (e.detail.id !== 'decode' || !decodeCleanup) return;
  const query = window.DxDecode?.core?.parseDecodeQuery(e.detail.path);
  decodeCleanup.applyQuery(query);
});

window.addEventListener('dx:unmount', (rawEvent) => {
  const e = rawEvent as DxMountEvent;
  if (e.detail.id !== 'decode') return;
  if (decodeCleanup) {
    decodeCleanup();
    decodeCleanup = null;
    if (window.DxDecode) window.DxDecode.activeUi = null;
  }
  if (decodeContainer) {
    decodeContainer.innerHTML = '';
    decodeContainer = null;
  }
});
