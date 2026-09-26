// D-19/D-20/D-21/DEC-03/DEC-06/DEC-07 — URL state: arriving pre-loaded from a link, writing one
// back only on an explicit Copy link press, the ~32 KB size warning, and the compressed `z=`
// variant (feature-detected, precedence-fixed, bounded, and readable when it fails).
//
// This suite runs the COMPILED src/dapps/decode/*.js against the real jsdom `window`
// (`new Function('window', code)(window)`), the same pattern test/decode-ui.test.ts and
// test/settings-render.test.ts already established, so `make test` building first is exactly
// why this file needs a real build to exist before it can pass.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

function loadCompiled(relPath: string) {
  const code = readFileSync(resolve(__dirname, relPath), 'utf-8');
  new Function('window', code)(window);
}

function loadTemplate(): string {
  return readFileSync(resolve(__dirname, '../src/dapps/decode/template.html'), 'utf-8');
}

const HEX_VECTOR = '0x68656c6c6f';

// The fixed interoperability fixture (plan's own artifact list): produced by Node's own
// `zlib.deflateRawSync` at level 9 and base64url-encoded — an implementation OTHER than this
// one's `CompressionStream`. Its job is to fail if the encoding, the alphabet substitution, the
// padding rule or the compression format ever drifts; it is an INFLATE INPUT, never an expected
// COMPRESS output (a compressor's own byte choices are not pinned here, only the wire format).
const INTEROP_FIXTURE_B64URL = 'M6gwszAzNUsGwjQA';
const INTEROP_FIXTURE_TEXT = '0x68656c6c6f';

type QueryParams = { decoder?: string; data?: string; z?: string };

type CoreHelpers = {
  parseDecodeQuery(path: string): QueryParams;
  // WR-03: route is a required first parameter now, never a literal — buildShareUrl no longer
  // hardcodes '/tools/decode' internally.
  buildShareUrl(route: string, decoderId: string | null, dataParam: string, compressed: boolean): string;
  SHARE_SIZE_WARNING_BYTES: number;
  supportsCompression(): boolean;
  compressForShare(input: string): Promise<string>;
  decompressFromShare(z: string): Promise<{ ok: true; value: string } | { ok: false; error: string }>;
};

function core(): CoreHelpers {
  return window.DxDecode!.core as unknown as CoreHelpers;
}

type InitFn = (container: HTMLElement, dx: unknown, query?: QueryParams) => () => void;

// WR-03: a stub shell exposing getManifests() the way the real window.__DXKIT__ does — ui.ts's
// init() calls core.findOwnRoute(dx) to resolve the route buildShareUrl composes, and this
// suite needs the real answer ('/tools/decode'), not the location.hash fallback (jsdom's default
// hash is empty, which would build a link this suite could not tell apart from a bug).
const DECODE_DX_STUB = { getManifests: () => [{ id: 'decode', route: '/tools/decode' }] };

function mount(query?: QueryParams): { container: HTMLElement; cleanup: () => void } {
  const container = document.createElement('div');
  container.innerHTML = loadTemplate();
  document.body.append(container);
  const init = window.DxDecode!.ui!.init as unknown as InitFn;
  const cleanup = init(container, DECODE_DX_STUB, query);
  return {
    container,
    cleanup: () => {
      cleanup();
      container.remove();
    },
  };
}

// A real CompressionStream/DecompressionStream pipeline schedules across more than one
// microtask tick (it is backed by Node's actual zlib bindings) — a bare `setTimeout(fn, 0)` is
// enough for the synchronous decode paths elsewhere in this dapp but not for a fire-and-forget
// click handler that awaits a real compress/inflate round trip, so this file's own flush waits
// a short, fixed interval rather than a single tick.
function flush(): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
}

// Mirrors test/decode-ui.test.ts / test/shell-wallet.test.ts's own clipboard-stub shape.
function installClipboard(writeText: ReturnType<typeof vi.fn>) {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
}
function removeClipboard() {
  delete (navigator as unknown as { clipboard?: unknown }).clipboard;
}

// Copied from test/shell-wallet.test.ts's installFakeLocalStorage — this Node runtime exposes an
// experimental native globalThis.localStorage/sessionStorage that shadows jsdom's simulated
// Storage and has no setItem/getItem/clear. A Map-backed, Storage-shaped stand-in restores a real
// (and spy-able) surface for either key.
function installFakeStorage(key: 'localStorage' | 'sessionStorage') {
  const map = new Map<string, string>();
  const storage = {
    getItem: (k: string) => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k: string, v: string) => {
      map.set(k, String(v));
    },
    removeItem: (k: string) => {
      map.delete(k);
    },
    clear: () => {
      map.clear();
    },
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    get length() {
      return map.size;
    },
  };
  Object.defineProperty(window, key, { configurable: true, value: storage });
  return storage;
}

// Mirrors test/decode-ui.test.ts's own dispatchPaste — jsdom's ClipboardEvent has no settable
// clipboardData, so a plain Event carrying the same shape is all onPaste actually reads.
function dispatchPaste(el: HTMLElement, text: string) {
  const event = new Event('paste', { bubbles: true, cancelable: true }) as unknown as ClipboardEvent;
  Object.defineProperty(event, 'clipboardData', {
    value: { getData: (type: string) => (type === 'text/plain' || type === 'text' ? text : '') },
  });
  el.dispatchEvent(event);
}

beforeAll(() => {
  loadCompiled('../src/share-target.js');
  loadCompiled('../src/dapps/decode/codecs.js');
  loadCompiled('../src/dapps/decode/core.js');
  loadCompiled('../src/dapps/decode/decoders.js');
  loadCompiled('../src/dapps/decode/ui.js');
});

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

// ── Parsing (DEC-03) ─────────────────────────────────────────────────────────────────────

describe('parseDecodeQuery', () => {
  it('returns the decoder name and the payload when both are present', () => {
    expect(core().parseDecodeQuery('/tools/decode/?decoder=hex&data=abc')).toEqual({
      decoder: 'hex',
      data: 'abc',
    });
  });

  it('returns the payload with no decoder when only data is present', () => {
    expect(core().parseDecodeQuery('/tools/decode/?data=abc')).toEqual({ data: 'abc' });
  });

  it('returns neither and does not throw for a routed path with no query string', () => {
    expect(() => core().parseDecodeQuery('/tools/decode')).not.toThrow();
    expect(core().parseDecodeQuery('/tools/decode')).toEqual({});
  });
});

// ── Mounting from a link (DEC-03, D-24, DEC-05) ─────────────────────────────────────────────

describe('mounting with a link that names a decoder', () => {
  it('selects that decoder, loads the input, and runs no decode', () => {
    const hexDecoder = window.DxDecode!.registry!.get('hex')!;
    const decodeSpy = vi.spyOn(hexDecoder, 'decode');

    const { container, cleanup } = mount({ decoder: 'hex', data: HEX_VECTOR });
    const selector = container.querySelector<HTMLSelectElement>('#decode-selector')!;
    const textarea = container.querySelector<HTMLTextAreaElement>('#decode-textarea')!;

    expect(selector.value).toBe('hex');
    expect(textarea.value).toBe(HEX_VECTOR);
    expect(decodeSpy).not.toHaveBeenCalled();

    cleanup();
  });
});

describe('mounting with a link that carries a payload but no decoder', () => {
  it('leaves the selection on Auto and the badge naming a resolved decoder', () => {
    const { container, cleanup } = mount({ data: HEX_VECTOR });
    const selector = container.querySelector<HTMLSelectElement>('#decode-selector')!;
    const badge = container.querySelector<HTMLElement>('#decode-auto-badge')!;

    expect(selector.value).toBe('auto');
    expect(badge.textContent).toContain('Hex');

    cleanup();
  });
});

// ── dx:route:subpath — a share link followed while already mounted (WR-05) ────────────────
//
// DxKit does not remount a dapp when the route changes WITHIN itself — the vendored shell's own
// mountDapp() emits dx:route:subpath instead of dx:mount once the dapp is already current
// (src/vendor/dxkit/index.global.js). dapp.ts applying the query only on dx:mount meant a share
// link followed while already on #/tools/decode was silently ignored. This exercises dapp.ts's
// REAL event wiring end-to-end (not ui.ts's init() called directly, the way every other test in
// this file does) — loading dapp.js and dispatching the same window events the real shell would.
describe('dx:route:subpath — a share link followed while already mounted', () => {
  beforeAll(() => {
    loadCompiled('../src/dapps/decode/dapp.js');
  });

  it('re-applies a share-link query to the running instance, without a fresh mount', async () => {
    const container = document.createElement('div');
    container.innerHTML = loadTemplate();
    document.body.append(container);

    window.dispatchEvent(new CustomEvent('dx:mount', { detail: { id: 'decode', container, path: '/tools/decode' } }));
    const textarea = container.querySelector<HTMLTextAreaElement>('#decode-textarea')!;
    expect(textarea.value).toBe('');

    window.dispatchEvent(
      new CustomEvent('dx:route:subpath', {
        detail: {
          id: 'decode',
          path: `/tools/decode/?decoder=hex&data=${HEX_VECTOR}`,
          previousPath: '/tools/decode',
        },
      }),
    );
    await flush();

    expect(textarea.value).toBe(HEX_VECTOR);
    const selector = container.querySelector<HTMLSelectElement>('#decode-selector')!;
    expect(selector.value).toBe('hex');

    window.dispatchEvent(new CustomEvent('dx:unmount', { detail: { id: 'decode', container, path: '/tools/decode' } }));
    container.remove();
  });

  it('ignores the event when it names a different dapp id', async () => {
    const container = document.createElement('div');
    container.innerHTML = loadTemplate();
    document.body.append(container);

    window.dispatchEvent(new CustomEvent('dx:mount', { detail: { id: 'decode', container, path: '/tools/decode' } }));
    const textarea = container.querySelector<HTMLTextAreaElement>('#decode-textarea')!;

    window.dispatchEvent(
      new CustomEvent('dx:route:subpath', {
        detail: { id: 'settings', path: `/settings/?data=${HEX_VECTOR}`, previousPath: '/settings' },
      }),
    );
    await flush();

    expect(textarea.value).toBe('');

    window.dispatchEvent(new CustomEvent('dx:unmount', { detail: { id: 'decode', container, path: '/tools/decode' } }));
    container.remove();
  });
});

// ── Copy link — writes only on the press, never a keystroke/paste/decode (D-19) ────────────

describe('Copy link', () => {
  it('replaces history exactly once with a URL containing the decoder and the payload, and never pushes', async () => {
    const replaceState = vi.spyOn(window.history, 'replaceState').mockImplementation(() => undefined);
    const pushState = vi.spyOn(window.history, 'pushState').mockImplementation(() => undefined);
    installClipboard(vi.fn().mockResolvedValue(undefined));

    const { container, cleanup } = mount();
    const selector = container.querySelector<HTMLSelectElement>('#decode-selector')!;
    const textarea = container.querySelector<HTMLTextAreaElement>('#decode-textarea')!;
    const shareBtn = container.querySelector<HTMLButtonElement>('#decode-share-btn')!;

    selector.value = 'hex';
    textarea.value = HEX_VECTOR;
    shareBtn.click();
    await flush();

    expect(replaceState).toHaveBeenCalledTimes(1);
    expect(pushState).not.toHaveBeenCalled();
    const [, , url] = replaceState.mock.calls[0];
    expect(url).toContain('decoder=hex');
    expect(url).toContain(`data=${encodeURIComponent(HEX_VECTOR)}`);

    cleanup();
    removeClipboard();
  });

  it('builds a URL with the route followed by a slash then the question mark, params after the hash', () => {
    const url = core().buildShareUrl('/tools/decode', 'hex', HEX_VECTOR, false);
    expect(url).toContain('#/tools/decode/?');
    const hashIndex = url.indexOf('#');
    expect(url.slice(0, hashIndex)).not.toContain('?');
  });

  it('the round trip is closed — the built URL parses back to the same decoder and payload', () => {
    const url = core().buildShareUrl('/tools/decode', 'hex', HEX_VECTOR, false);
    const hashPath = url.slice(url.indexOf('#') + 1);
    expect(core().parseDecodeQuery(hashPath)).toEqual({ decoder: 'hex', data: HEX_VECTOR });
  });

  it('typing, pasting and decoding without pressing Copy link never touches history', async () => {
    const replaceState = vi.spyOn(window.history, 'replaceState').mockImplementation(() => undefined);
    const pushState = vi.spyOn(window.history, 'pushState').mockImplementation(() => undefined);

    const { container, cleanup } = mount();
    const textarea = container.querySelector<HTMLTextAreaElement>('#decode-textarea')!;
    const runBtn = container.querySelector<HTMLButtonElement>('#decode-run-btn')!;

    textarea.value = HEX_VECTOR;
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    runBtn.click();
    await flush();

    expect(replaceState).not.toHaveBeenCalled();
    expect(pushState).not.toHaveBeenCalled();

    cleanup();
  });

  // WR-01's runtime half of the D-17/README privacy claim: the source scan
  // (test/decode-portability.test.ts) can only prove no CODE in this directory names a forbidden
  // API; it says nothing about what the MOUNTED dapp actually does. This mounts the real dapp,
  // types, pastes, runs a decode and switches every tab, with spies/assertions on every write
  // surface the product promise forbids, and proves none of them fire — only Copy link (covered
  // by the tests above) is allowed to.
  it('typing, pasting, decoding and switching tabs writes no history, cookie, storage, request or image load until Copy link is pressed', async () => {
    // This Node runtime exposes an experimental native globalThis.localStorage/sessionStorage
    // that shadows jsdom's simulated Storage and has no setItem/getItem/clear — same gap
    // test/shell-wallet.test.ts's installFakeLocalStorage documents. A Map-backed, Storage-shaped
    // stand-in restores a real surface so setItem is actually spy-able.
    const localStorageStub = installFakeStorage('localStorage');
    const sessionStorageStub = installFakeStorage('sessionStorage');
    const localSetItem = vi.spyOn(localStorageStub, 'setItem');
    const sessionSetItem = vi.spyOn(sessionStorageStub, 'setItem');
    const replaceState = vi.spyOn(window.history, 'replaceState').mockImplementation(() => undefined);
    const pushState = vi.spyOn(window.history, 'pushState').mockImplementation(() => undefined);
    const cookieSet = vi.spyOn(document, 'cookie', 'set');
    const windowOpen = vi.spyOn(window, 'open').mockImplementation(() => null);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response());
    const imageSrcSet = vi.spyOn(HTMLImageElement.prototype, 'src', 'set');

    const { container, cleanup } = mount();
    const selector = container.querySelector<HTMLSelectElement>('#decode-selector')!;
    const textarea = container.querySelector<HTMLTextAreaElement>('#decode-textarea')!;
    const runBtn = container.querySelector<HTMLButtonElement>('#decode-run-btn')!;
    const rawTabBtn = container.querySelector<HTMLButtonElement>('#decode-tabs button[data-tab="raw"]')!;
    const logTabBtn = container.querySelector<HTMLButtonElement>('#decode-tabs button[data-tab="log"]')!;

    textarea.value = HEX_VECTOR;
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    dispatchPaste(textarea, HEX_VECTOR);
    selector.value = 'hex';
    runBtn.click();
    await flush();
    rawTabBtn.click();
    logTabBtn.click();

    expect(replaceState).not.toHaveBeenCalled();
    expect(pushState).not.toHaveBeenCalled();
    expect(cookieSet).not.toHaveBeenCalled();
    expect(windowOpen).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(imageSrcSet).not.toHaveBeenCalled();
    expect(localSetItem).not.toHaveBeenCalled();
    expect(sessionSetItem).not.toHaveBeenCalled();
    expect(localStorageStub.length).toBe(0);
    expect(sessionStorageStub.length).toBe(0);

    cleanup();
  });
});

// ── Copy link via the header button (SHARE-04) ──────────────────────────────────────────────
//
// Deviation from the plan as originally written (see SUMMARY.md): decode cannot itself call
// window.DnznShareTarget.register — DEC-14's portability guard (test/decode-portability.test.ts)
// forbids any `Dnzn*`-prefixed identifier anywhere in src/dapps/decode/, and that guard stays
// green, unedited, per this plan's own success criteria. The real wiring lives in src/main.ts
// (dx:mount/dx:unmount listeners, test/main.test.ts's source-string concern) and reaches
// decode's own generic pressPlainShare()/revealShareFailure() hooks. This suite proves THAT
// contract end-to-end against the REAL src/share-target.js, by replicating main.ts's two-line
// registration inline — the same call, not a stand-in for it — so the real header (initShellChrome,
// #share-btn's default handler) stays test/share-target.test.ts's concern, and the button here
// only needs to satisfy `closest('#share-btn')`.
describe('Copy link — header button (via decode-independent share-target wiring)', () => {
  type DecodeUiHandleLike = (() => void) & {
    pressPlainShare(): string;
    revealShareFailure(url: string): void;
  };

  // Mirrors src/main.ts's own dx:mount/dx:unmount registration verbatim, and
  // src/dapps/decode/dapp.ts's window.DxDecode.activeUi assignment — proving the CONTRACT
  // those two files rely on, without loading either (main.ts constructs a real DxKit shell,
  // far too heavy for this suite; dapp.ts's own real event wiring is exercised separately by
  // the "dx:route:subpath" describe block above).
  //
  // Calls init() directly (not this file's shared `mount()` helper) because mount() wraps the
  // real handle in a fresh `() => void` closure for its own cleanup convenience — a wrapper
  // that does not carry pressPlainShare/revealShareFailure. This suite needs the ORIGINAL
  // handle object those are attached to.
  function mountWithHeaderButton(query?: QueryParams) {
    const headerBtn = document.createElement('button');
    headerBtn.id = 'share-btn';
    document.body.append(headerBtn);

    const container = document.createElement('div');
    container.innerHTML = loadTemplate();
    document.body.append(container);
    const init = window.DxDecode!.ui!.init as unknown as InitFn;
    const handle = init(container, DECODE_DX_STUB, query) as unknown as DecodeUiHandleLike;

    window.DxDecode!.activeUi = handle as unknown as NonNullable<Window['DxDecode']>['activeUi'];
    const releaseShareTarget = window.DnznShareTarget!.register(() => handle.pressPlainShare(), {
      onCopyFailed: (url) => handle.revealShareFailure(url),
    });
    return {
      container,
      headerBtn,
      // Mirrors dapp.ts's dx:unmount handler: unregister, clear activeUi, THEN the dapp's own
      // cleanup — same order, same effect, without dispatching a real window event for it.
      cleanup: () => {
        releaseShareTarget();
        window.DxDecode!.activeUi = null;
        handle();
        container.remove();
      },
    };
  }

  it('copies the plain share link (decoder + payload) and writes history exactly once, never pushing', async () => {
    const replaceState = vi.spyOn(window.history, 'replaceState').mockImplementation(() => undefined);
    const pushState = vi.spyOn(window.history, 'pushState').mockImplementation(() => undefined);
    installClipboard(vi.fn().mockResolvedValue(undefined));

    const { container, headerBtn, cleanup } = mountWithHeaderButton();
    const selector = container.querySelector<HTMLSelectElement>('#decode-selector')!;
    const textarea = container.querySelector<HTMLTextAreaElement>('#decode-textarea')!;

    selector.value = 'hex';
    textarea.value = HEX_VECTOR;
    headerBtn.click();
    await flush();

    expect(replaceState).toHaveBeenCalledTimes(1);
    expect(pushState).not.toHaveBeenCalled();
    const [, , url] = replaceState.mock.calls[0];
    expect(url).toContain('decoder=hex');
    expect(url).toContain(`data=${encodeURIComponent(HEX_VECTOR)}`);

    cleanup();
    headerBtn.remove();
    removeClipboard();
  });

  it('mounting, typing, and decoding without pressing the header button touches neither history nor the clipboard (D-19)', async () => {
    const replaceState = vi.spyOn(window.history, 'replaceState').mockImplementation(() => undefined);
    const pushState = vi.spyOn(window.history, 'pushState').mockImplementation(() => undefined);
    const writeText = vi.fn().mockResolvedValue(undefined);
    installClipboard(writeText);

    const { container, headerBtn, cleanup } = mountWithHeaderButton();
    const textarea = container.querySelector<HTMLTextAreaElement>('#decode-textarea')!;
    const runBtn = container.querySelector<HTMLButtonElement>('#decode-run-btn')!;

    textarea.value = HEX_VECTOR;
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    runBtn.click();
    await flush();

    expect(replaceState).not.toHaveBeenCalled();
    expect(pushState).not.toHaveBeenCalled();
    expect(writeText).not.toHaveBeenCalled();

    cleanup();
    headerBtn.remove();
    removeClipboard();
  });

  it('after unmount, pressing the header button no longer produces a decode link', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    installClipboard(writeText);

    const { headerBtn, cleanup } = mountWithHeaderButton();
    cleanup(); // unregisters the header override AND unmounts decode — headerBtn itself stays
    // attached, as it would in production (only the dapp's own container is torn down), so this
    // click exercises the real "override is gone" path rather than a click nothing observes.

    headerBtn.click();
    await flush();

    expect(writeText).not.toHaveBeenCalled();

    headerBtn.remove();
    removeClipboard();
  });

  it('a failed clipboard write reveals the URL in #decode-copy-reveal', async () => {
    removeClipboard();

    const { container, headerBtn, cleanup } = mountWithHeaderButton();
    const selector = container.querySelector<HTMLSelectElement>('#decode-selector')!;
    const textarea = container.querySelector<HTMLTextAreaElement>('#decode-textarea')!;
    selector.value = 'hex';
    textarea.value = HEX_VECTOR;

    expect(() => headerBtn.click()).not.toThrow();
    await flush();

    const reveal = container.querySelector<HTMLInputElement>('#decode-copy-reveal')!;
    expect(reveal.classList.contains('revealed')).toBe(true);
    expect(reveal.value).toContain('decoder=hex');

    cleanup();
    headerBtn.remove();
  });
});

// ── The size report and warning (D-06, D-20) ────────────────────────────────────────────────

describe('the share size report and warning', () => {
  it('reports the current payload size', () => {
    const { container, cleanup } = mount();
    const textarea = container.querySelector<HTMLTextAreaElement>('#decode-textarea')!;
    const sizeEl = container.querySelector<HTMLElement>('#decode-share-size')!;

    textarea.value = 'hello';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));

    expect(sizeEl.textContent).toContain('5');

    cleanup();
  });

  it('shows the warning above the shared threshold and hides it below', () => {
    const { container, cleanup } = mount();
    const textarea = container.querySelector<HTMLTextAreaElement>('#decode-textarea')!;
    const warningEl = container.querySelector<HTMLElement>('#decode-share-warning')!;

    textarea.value = 'short';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    expect(warningEl.hidden).toBe(true);

    textarea.value = '0'.repeat(core().SHARE_SIZE_WARNING_BYTES + 1);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    expect(warningEl.hidden).toBe(false);

    cleanup();
  });

  it('the size threshold is a named constant, read by both the implementation and this test', () => {
    expect(core().SHARE_SIZE_WARNING_BYTES).toBe(32 * 1024);
  });
});

// ── The compressed variant (DEC-07, D-20, D-21) ─────────────────────────────────────────────

describe('the compressed variant — core-level codec behavior', () => {
  it('round-trips a short payload and one past the size threshold', async () => {
    for (const input of ['hello world', '0'.repeat(core().SHARE_SIZE_WARNING_BYTES + 1000)]) {
      const z = await core().compressForShare(input);
      const result = await core().decompressFromShare(z);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toBe(input);
    }
  });

  it('inflates the fixed interoperability fixture (produced by a different raw-deflate implementation) to its known string', async () => {
    const result = await core().decompressFromShare(INTEROP_FIXTURE_B64URL);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(INTEROP_FIXTURE_TEXT);
  });

  it('produces only URL-safe base64 characters and no padding', async () => {
    const z = await core().compressForShare('a payload with enough entropy to need padding, maybe');
    expect(z).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(z).not.toContain('=');
  });

  it('an invalid compressed payload fails rather than throwing', async () => {
    const result = await core().decompressFromShare('not-valid-deflate-raw-bytes-at-all');
    expect(result.ok).toBe(false);
  });

  it('cancels the reader and fails once the inflated output crosses the ceiling, rather than measuring a fully-inflated buffer afterward', async () => {
    const cancelSpy = vi.spyOn(ReadableStreamDefaultReader.prototype, 'cancel');
    const huge = '0'.repeat(9 * 1024 * 1024);
    const z = await core().compressForShare(huge);
    const result = await core().decompressFromShare(z);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/ceiling/);
    expect(cancelSpy).toHaveBeenCalled();
  });

  it('with the decompression constructor absent, reports a distinct "cannot expand" failure', async () => {
    const original = globalThis.DecompressionStream;
    // @ts-expect-error deliberately removing a lib-declared global to simulate its absence
    delete globalThis.DecompressionStream;
    try {
      const result = await core().decompressFromShare(INTEROP_FIXTURE_B64URL);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('cannot expand');
    } finally {
      globalThis.DecompressionStream = original;
    }
  });
});

// WR-06: supportsCompression() used to check only that the CONSTRUCTORS exist, a different
// question from whether they accept the 'deflate-raw' FORMAT this file actually asks for.
// Chrome 80-102 and Safari 16.4 ship the constructors without 'deflate-raw' (added in Chrome
// 103) — `new CompressionStream('deflate-raw')` throws a TypeError on those browsers, which the
// constructor-only check could never see coming.
describe('supportsCompression — checks the format, not just the constructors', () => {
  it('returns true against the real constructors this test environment ships (Node zlib-backed, supports deflate-raw)', () => {
    expect(core().supportsCompression()).toBe(true);
  });

  it('returns false when the constructors exist but throw for the deflate-raw format specifically', () => {
    const originalCompression = globalThis.CompressionStream;
    const originalDecompression = globalThis.DecompressionStream;
    // Mirrors the real Chrome-80-102/Safari-16.4 shape: the constructor exists, and throws only
    // for the one format string this file passes.
    class ConstructorExistsFormatUnsupported {
      constructor(format: string) {
        if (format === 'deflate-raw') {
          throw new TypeError(`Failed to construct 'CompressionStream': unsupported format: '${format}'`);
        }
      }
    }
    // @ts-expect-error deliberately substituting a constructor that exists but rejects the
    // format supportsCompression() must actually probe
    globalThis.CompressionStream = ConstructorExistsFormatUnsupported;
    // @ts-expect-error same
    globalThis.DecompressionStream = ConstructorExistsFormatUnsupported;

    try {
      expect(core().supportsCompression()).toBe(false);
    } finally {
      globalThis.CompressionStream = originalCompression;
      globalThis.DecompressionStream = originalDecompression;
    }
  });
});

describe('the compressed variant — the source scan proving no one-shot drain on the inflate path', () => {
  it('decompressFromShare never drains its stream in one shot via .arrayBuffer() — only compressForShare (the trusted, already-bounded input side) may', () => {
    const source = readFileSync(resolve(__dirname, '../src/dapps/decode/core.ts'), 'utf-8');
    const stripped = source.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    const start = stripped.indexOf('async function decompressFromShare');
    expect(start).toBeGreaterThan(-1);
    const nextFnAt = stripped.indexOf('\nasync function ', start + 1);
    const nextTopLevelAt = stripped.indexOf('\nfunction ', start + 1);
    const candidates = [nextFnAt, nextTopLevelAt, stripped.indexOf('\nwindow.DxDecode.core', start)].filter(
      (i) => i !== -1,
    );
    const end = candidates.length > 0 ? Math.min(...candidates) : stripped.length;
    const body = stripped.slice(start, end);
    // `new Response(decoded.bytes)` legitimately appears here — it is how the untrusted bytes
    // are turned into an input stream, not how the inflated output is drained. The anti-pattern
    // this guards against is a one-shot buffer read of the OUTPUT (`.arrayBuffer()`), which has
    // no way to stop early once started.
    expect(body).not.toMatch(/\.arrayBuffer\(\)/);
    expect(body).toContain('reader.read()');
    expect(body).toContain('reader.cancel()');
  });
});

describe('the compressed variant — mounted in the UI', () => {
  it('with both stream constructors absent, the compressed action stays hidden and the ordinary link still works', async () => {
    const originalCompression = globalThis.CompressionStream;
    const originalDecompression = globalThis.DecompressionStream;
    // @ts-expect-error deliberately removing lib-declared globals to simulate their absence
    delete globalThis.CompressionStream;
    // @ts-expect-error same
    delete globalThis.DecompressionStream;

    try {
      const replaceState = vi.spyOn(window.history, 'replaceState').mockImplementation(() => undefined);
      installClipboard(vi.fn().mockResolvedValue(undefined));

      const { container, cleanup } = mount();
      const textarea = container.querySelector<HTMLTextAreaElement>('#decode-textarea')!;
      const shareBtn = container.querySelector<HTMLButtonElement>('#decode-share-btn')!;
      const shareZBtn = container.querySelector<HTMLButtonElement>('#decode-share-z-btn')!;

      textarea.value = '0'.repeat(core().SHARE_SIZE_WARNING_BYTES + 1);
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      expect(shareZBtn.hidden).toBe(true);

      shareBtn.click();
      await flush();
      expect(replaceState).toHaveBeenCalledTimes(1);

      cleanup();
      removeClipboard();
    } finally {
      globalThis.CompressionStream = originalCompression;
      globalThis.DecompressionStream = originalDecompression;
    }
  });

  it('the compressed action is absent before the size warning shows and present after', () => {
    const { container, cleanup } = mount();
    const textarea = container.querySelector<HTMLTextAreaElement>('#decode-textarea')!;
    const shareZBtn = container.querySelector<HTMLButtonElement>('#decode-share-z-btn')!;

    textarea.value = 'short';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    expect(shareZBtn.hidden).toBe(true);

    textarea.value = '0'.repeat(core().SHARE_SIZE_WARNING_BYTES + 1);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    expect(shareZBtn.hidden).toBe(false);

    cleanup();
  });

  it('pressing the compressed link replaces history with a z= URL and copies it', async () => {
    const replaceState = vi.spyOn(window.history, 'replaceState').mockImplementation(() => undefined);
    installClipboard(vi.fn().mockResolvedValue(undefined));

    const { container, cleanup } = mount();
    const textarea = container.querySelector<HTMLTextAreaElement>('#decode-textarea')!;
    const shareZBtn = container.querySelector<HTMLButtonElement>('#decode-share-z-btn')!;

    textarea.value = '0'.repeat(core().SHARE_SIZE_WARNING_BYTES + 1);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    shareZBtn.click();
    await flush();

    expect(replaceState).toHaveBeenCalledTimes(1);
    const [, , url] = replaceState.mock.calls[0];
    expect(url).toContain('z=');
    expect(url).not.toContain('data=');

    cleanup();
    removeClipboard();
  });

  it('a link carrying both an uncompressed and a compressed payload loads the compressed one', async () => {
    const shortText = 'the uncompressed payload';
    const z = await core().compressForShare('the compressed payload — a different string entirely');

    const { container, cleanup } = mount({ data: shortText, z });
    await flush();
    const textarea = container.querySelector<HTMLTextAreaElement>('#decode-textarea')!;

    expect(textarea.value).toBe('the compressed payload — a different string entirely');
    expect(textarea.value).not.toBe(shortText);

    cleanup();
  });

  it('a compressed payload that will not inflate renders an error node and leaves the value visible', async () => {
    const badZ = 'not-a-real-compressed-payload';
    const { container, cleanup } = mount({ z: badZ });
    await flush();

    const tree = container.querySelector('#decode-tree')!;
    const textarea = container.querySelector<HTMLTextAreaElement>('#decode-textarea')!;

    expect(tree.textContent).toBeTruthy();
    expect(textarea.value).toBe(badZ);

    cleanup();
  });

  it('with the decompression constructor absent, opening a compressed link renders an error node and leaves the value visible', async () => {
    const z = await core().compressForShare('a payload sent before this browser lost decompression');
    const original = globalThis.DecompressionStream;
    // @ts-expect-error deliberately removing a lib-declared global to simulate its absence
    delete globalThis.DecompressionStream;

    try {
      const { container, cleanup } = mount({ z });
      await flush();
      const tree = container.querySelector('#decode-tree')!;
      const textarea = container.querySelector<HTMLTextAreaElement>('#decode-textarea')!;

      expect(tree.textContent).toContain('cannot expand');
      expect(textarea.value).toBe(z);

      cleanup();
    } finally {
      globalThis.DecompressionStream = original;
    }
  });

  it('unmounting mid-inflate produces no DOM write once the deferred inflate resolves', async () => {
    let resolveDeferred!: (result: { ok: false; error: string }) => void;
    const deferred = new Promise<{ ok: false; error: string }>((res) => {
      resolveDeferred = res;
    });
    const coreModule = window.DxDecode!.core as unknown as {
      decompressFromShare: (z: string) => Promise<{ ok: false; error: string }>;
    };
    const original = coreModule.decompressFromShare;
    coreModule.decompressFromShare = () => deferred;

    const { container, cleanup } = mount({ z: 'irrelevant-while-mocked' });
    const treeEl = container.querySelector('#decode-tree')!;
    const beforeText = treeEl.textContent;

    cleanup(); // unmount while the inflate is still pending
    resolveDeferred({ ok: false, error: 'should never be rendered' });
    await flush();

    expect(treeEl.textContent).toBe(beforeText);
    expect(treeEl.textContent).not.toContain('should never be rendered');

    coreModule.decompressFromShare = original;
  });

  // WR-06: pressing Copy compressed link used to swallow a rejection from compressForShare
  // silently — the button did nothing visible. This forces that rejection (compressForShare's
  // own `new CompressionStream('deflate-raw')`, the exact call the format-mismatch throws from)
  // and proves the click handler now renders a readable error instead of a silent no-op.
  it('a rejection from compressForShare renders a readable error node instead of doing nothing', async () => {
    const originalCompression = globalThis.CompressionStream;
    class ThrowingCompressionStream {
      constructor() {
        throw new TypeError("Failed to construct 'CompressionStream': unsupported format: 'deflate-raw'");
      }
    }
    // @ts-expect-error deliberately substituting a constructor that throws, to exercise the
    // catch path compressForShare's own construction call can hit
    globalThis.CompressionStream = ThrowingCompressionStream;

    try {
      const { container, cleanup } = mount();
      const textarea = container.querySelector<HTMLTextAreaElement>('#decode-textarea')!;
      const shareZBtn = container.querySelector<HTMLButtonElement>('#decode-share-z-btn')!;

      textarea.value = '0'.repeat(core().SHARE_SIZE_WARNING_BYTES + 1);
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      // Clicked directly regardless of the button's own hidden state — supportsCompression()
      // also constructs against the same (now-throwing) globals, so this exercises the catch
      // path the same way a real race between the two checks would.
      expect(() => shareZBtn.click()).not.toThrow();
      await flush();

      const tree = container.querySelector('#decode-tree')!;
      expect(tree.textContent).toContain('unsupported format');

      cleanup();
    } finally {
      globalThis.CompressionStream = originalCompression;
    }
  });
});
