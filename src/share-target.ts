// The header share-button override port. By default #share-btn copies window.location.href via
// src/shell.ts's own wireShareButton — that stays the ONLY behaviour for any route whose dapp
// registers nothing here. A dapp that wants the button to copy something else (CIC's
// calculator/report link, decode's plain share link) registers a builder through this module
// instead of reaching for the button or the shell directly.
//
// Loaded by its own <script> tag, reached only through window.DnznShareTarget — there is no
// bundler at runtime, so a consumer resolves this as a bare global, exactly as
// src/shell-wallet.ts resolves window.DnznWalletIdentity.
//
// This file is the one deliberate, documented exception to AGENTS.md's "dapps own only their
// container": the listener below is registered on `document`, not on a container. The reason is
// verified, not folklore — src/main.ts:104-106 runs `shell.init().then(() => initShellChrome())`,
// and shell.init() has already mounted the FIRST dapp by the time that promise resolves.
// initShellChrome() is the only thing that ever creates #share-btn (via renderHeader), so the
// header genuinely does not exist yet when a dapp's own init() runs — there is nothing for a
// dapp to bind a click listener to at that point. A document-level listener, added once here and
// never by a dapp, is the only way a dapp's override can exist before the button itself does.
// It runs in the CAPTURE phase specifically so it runs BEFORE the button's own bubble-phase
// handler (wireShareButton's), and stopImmediatePropagation() is what suppresses that handler
// once a builder is registered. Consumers register a builder through this module and never reach
// `document` for this themselves.

(() => {
  // 1500ms, matching src/shell-wallet.ts's COPY_MS and src/dapps/cic/cic.ts's own value —
  // and the .share-btn.copied .share-copied rule in src/styles/shell.css:135.
  const CONFIRM_MS = 1500;

  // The one active registration, or null. Exclusive: a second register() call replaces
  // whatever was here, so two dapps' overrides can never both be live.
  let activeBuild: (() => string | null | Promise<string | null>) | null = null;
  let activeOptions: { onCopyFailed?: (url: string) => void } | undefined;

  // The button and pending timer for the current confirmation flash, so unregister can cancel
  // one still running (a copy immediately before navigation must not leave a timer behind).
  let confirmButton: HTMLElement | null = null;
  let confirmTimer: ReturnType<typeof setTimeout> | null = null;

  // Duplicates src/dapps/decode/ui.ts's writeClipboard deliberately — separately transpiled
  // IIFEs with no import path between them, the same reason src/shell.ts documents for
  // closeAllDropdowns. navigator.clipboard is property-guarded because it is undefined outside a
  // secure context, and this site is explicitly servable from plain-HTTP IPFS gateways.
  async function writeClipboard(text: string): Promise<boolean> {
    if (typeof navigator.clipboard?.writeText !== 'function') return false;
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  }

  // Named flashConfirmed rather than `confirm` — that would shadow the global. Adds the shell's
  // own `copied` class and clears/replaces any timer already pending for this button.
  function flashConfirmed(button: HTMLElement) {
    if (confirmTimer !== null) clearTimeout(confirmTimer);
    confirmButton = button;
    button.classList.add('copied');
    confirmTimer = setTimeout(() => {
      button.classList.remove('copied');
      confirmTimer = null;
      confirmButton = null;
    }, CONFIRM_MS);
  }

  function clearPendingConfirm() {
    if (confirmTimer !== null) clearTimeout(confirmTimer);
    confirmTimer = null;
    confirmButton?.classList.remove('copied');
    confirmButton = null;
  }

  // The one document listener. Resolves the button with an optional-call closest — an event
  // target is not always guaranteed to be an Element in every dispatch path (jsdom included), so
  // this guards rather than assumes. Returns early with nothing suppressed when there is no
  // button in the path or no active builder — the shell's own bubble-phase handler runs
  // untouched in that case, which is exactly SHARE-05's default.
  function onShareCapture(e: Event) {
    const target = e.target as Element | null;
    const btn = target?.closest?.('#share-btn') as HTMLElement | null;
    if (!btn || !activeBuild) return;

    e.stopImmediatePropagation();

    // Captured into locals: the registration can change while the async work below is in
    // flight (a dapp could unmount and a new one mount before this press resolves).
    const build = activeBuild;
    const options = activeOptions;

    // Never let this reject — an unhandled rejection here reaches nobody, exactly the failure
    // src/dapps/decode/ui.ts's WR-06 comment already calls out for its own compressed-share path.
    void (async () => {
      let url: string;
      try {
        const built = await build();
        url = built ?? window.location.href;
      } catch {
        url = window.location.href;
      }

      const wrote = await writeClipboard(url);
      if (!wrote) {
        options?.onCopyFailed?.(url);
        return;
      }
      flashConfirmed(btn);
    })();
  }

  function register(
    build: () => string | null | Promise<string | null>,
    options?: { onCopyFailed?: (url: string) => void },
  ): () => void {
    if (!activeBuild) {
      document.addEventListener('click', onShareCapture, true);
    }
    activeBuild = build;
    activeOptions = options;

    let released = false;
    return function unregister() {
      // Guarded twice: released makes a second call a no-op, and the identity check makes a
      // late release from an already-replaced registration a no-op too — it must not tear down
      // its successor's override. DxKit unmounts before it mounts, so today this identity check
      // is defensive rather than load-bearing; it costs two lines and is the difference between
      // a leak and a silent dead button.
      if (released) return;
      released = true;
      if (activeBuild !== build) return;

      activeBuild = null;
      activeOptions = undefined;
      clearPendingConfirm();
      document.removeEventListener('click', onShareCapture, true);
    };
  }

  // Test seam only — the active builder, or null.
  function activeTarget() {
    return activeBuild;
  }

  window.DnznShareTarget = { register, activeTarget };
})();
