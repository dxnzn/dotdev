// The identity port. After 02-09 it observes rather than persists: the live identity is held in
// module memory for the lifetime of the document and written nowhere. D-05 through D-11 (the
// validated store, the opt-out that governed it, and the deletion that used to run at every
// load) are superseded — see .planning/phases/02-wallet-identity-in-the-shell/02-09-PLAN.md for
// the full supersession list. This file owns no node.
//
// Loaded by its own <script> tag BEFORE shell-wallet.js and reached only through
// window.DnznWalletIdentity. There is no bundler at runtime, so the header adapter has no
// import path to this file and resolves it as a bare global, exactly as src/main.ts resolves
// DxWallet.
//
// It was carved out of src/shell-wallet.ts, which held the store and the header's DOM adapter
// in one file and therefore could not fit the compiled payload budget that both halves now
// meet on their own.

(() => {
  const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

  // The one shape rule for an address, and the reason it is on the exported surface: the
  // header's live branch applies it to a provider event payload, so the alternative is the same
  // rule spelled out in two separately transpiled files, one edit away from a chip the renderer
  // cannot trust.
  function isAddress(value) {
    return typeof value === 'string' && ADDRESS_RE.test(value);
  }

  // The injected provider falls back to a non-numeric or absent chain id on some wallets, so
  // zero and every non-finite value mean unknown here, never chain zero. Nothing in this phase
  // reads chainId for display; it is carried so the deferred network indicator lands without a
  // shape change.
  function toChainId(value) {
    return Number.isFinite(value) && value !== 0 ? value : null;
  }

  // The whole of the persisted identity, now: nothing. `live` holds the in-memory identity or
  // null, reset to null at the top of every init() so a re-init cannot inherit a previous
  // document's answer.
  let live = null;

  // D-18: casing is provider-supplied and deliberately not normalised, so the same account
  // arriving in a different case must not read as an account change. The lowercasing lives
  // inside the comparison below and nowhere else — never written back to memory or the DOM, and
  // both sides are already known to be 40-hex strings by the time it runs.
  //
  // Every live signal — the direct provider subscription below, the vendored plugin's own
  // events, and the query on load — converges here, and it is the only place `live` is
  // reassigned. A payload that is not a 40-hex address crosses a boundary the page cannot
  // authenticate and is dropped whole: the header keeps what it already had.
  //
  // The boolean answers "does the header have something new to paint", which is the whole of
  // what the adapter needs. False covers both an unchanged account and a rejected payload —
  // neither changes what is on screen. `dx` is accepted and unused: the signature is kept
  // stable across the callers that still pass it (shell-wallet.ts's acceptLive), and nothing
  // here needs a settings source any more.
  function acceptLiveIdentity(_dx, address, chainId) {
    if (!isAddress(address)) return false;

    if (live && live.address.toLowerCase() === address.toLowerCase()) {
      // A chainChanged reaches us as the same account. Let the chain id move without
      // rewriting the stored casing and without repainting an unchanged address.
      const nextChainId = toChainId(chainId);
      if (live.chainId !== nextChainId) live = { address: live.address, chainId: nextChainId };
      return false;
    }

    live = { address, chainId: toChainId(chainId) };
    return true;
  }

  // The current in-memory identity, or null — the single source of truth this plan exists to
  // establish. shell-wallet.ts reads it wherever it used to read a stored value.
  function liveIdentity() {
    return live;
  }

  // Forgets the in-memory identity. Called from exactly two places: the Disconnect click
  // (unchanged from D-08) and this module's own init(), which resets it before every query.
  function clearIdentity() {
    live = null;
  }

  // The one sanctioned direct reach around the port, and the only place in dotdev that touches
  // window.ethereum. D-01 permits it: it modifies no DxKit code and registers no second
  // WalletProvider. It exists because the vendored EIP-1193 adapter's only account read sits
  // behind connect()'s eth_requestAccounts, which prompts — and this plan's whole premise is
  // that a silent read of already-granted permission must not prompt. `eth_accounts` is exactly
  // that: it raises no prompt, answers with the accounts this origin currently authorises, and
  // answers `[]` the moment that authorisation is revoked. Do not copy this pattern elsewhere;
  // every other reach for wallet state goes through the vendored plugin.
  //
  // Deliberately does not call acceptLiveIdentity itself (WR-01): this promise is started
  // unawaited and outlives a cleanup that runs before it settles, so the caller decides whether
  // the answer is still current before it is allowed to mutate `live` at all — not only before
  // repainting from it. Returns the raw pair, or null for every "nothing to accept" case.
  async function probeAccounts() {
    const eth = window.ethereum;
    if (typeof eth?.request !== 'function') return null;

    const accounts = await eth.request({ method: 'eth_accounts' });
    const address = Array.isArray(accounts) ? accounts[0] : undefined;
    if (!address) return null;

    // Best-effort: a wallet that answers eth_accounts but rejects or omits eth_chainId still
    // gets an identity, just with an unknown chain rather than none at all.
    let chainId = null;
    try {
      const chainIdHex = await eth.request({ method: 'eth_chainId' });
      chainId = toChainId(Number.parseInt(chainIdHex, 16));
    } catch {
      chainId = null;
    }

    return { address, chainId };
  }

  // Bumped by every init() and by every cleanup() it returns, so a promise started by one mount
  // can recognise, on settling, whether it is still the mount that started it (WR-01). The
  // probe is the only pending handle this module holds across a cleanup — the two direct
  // provider listeners are synchronous subscriptions removeListener retires immediately.
  let generation = 0;

  // `onChange` is how the query's answer and a direct provider event reach the screen: this
  // module owns no node, so the repaint is the adapter's, invoked rather than imported.
  function init(dx, onChange) {
    if (!dx) return () => undefined;

    const gen = ++generation;
    live = null;

    const unsubscribers = [];
    const eth = window.ethereum;

    // T-02-42: both listeners join this closure, so a re-init cannot accumulate handlers
    // writing into a header nothing owns.
    //
    // This subscription is not belt-and-braces. On a session restored by the query alone,
    // connect() was never called, so the vendored adapter has registered no accountsChanged
    // listener at all — without this, switching accounts in the wallet would never reach the
    // header. When an explicit Connect later runs, the adapter subscribes too and both paths
    // converge on acceptLiveIdentity, which answers false for an unchanged account, so the
    // duplicate signal costs one comparison and no repaint.
    if (typeof eth?.on === 'function') {
      const onAccountsChanged = (accounts) => {
        const address = Array.isArray(accounts) ? accounts[0] : undefined;
        // An empty array is what a lock produces too, and the page cannot tell the two apart
        // from this event alone — DEC-B, and the same rule the vendored adapter's own
        // `disconnected` event is held to. Never clear `live` from here.
        if (!address) return;
        if (acceptLiveIdentity(dx, address, undefined)) onChange();
      };
      const onChainChanged = (chainIdHex) => {
        if (!live) return;
        let chainId = null;
        try {
          chainId = toChainId(Number.parseInt(chainIdHex, 16));
        } catch {
          chainId = null;
        }
        if (acceptLiveIdentity(dx, live.address, chainId)) onChange();
      };

      eth.on('accountsChanged', onAccountsChanged);
      eth.on('chainChanged', onChainChanged);
      unsubscribers.push(() => eth.removeListener?.('accountsChanged', onAccountsChanged));
      unsubscribers.push(() => eth.removeListener?.('chainChanged', onChainChanged));
    }

    // T-02-39: started, never awaited, so a provider that never answers eth_accounts must not
    // gate first paint. init() runs after shell.init() has already resolved — outside DxKit's
    // serial plugin-init loop by construction — and the caller (shell-wallet.ts's init) renders
    // synchronously before this promise can possibly settle.
    //
    // WR-01: gen is checked before the answer is allowed to touch `live` at all, not only
    // before onChange — a stale probe from an unmounted document must not silently overwrite
    // the `live = null` a fresh init() just set.
    probeAccounts()
      .then((result) => {
        if (gen !== generation || !result) return;
        if (acceptLiveIdentity(dx, result.address, result.chainId)) onChange();
      })
      .catch(() => undefined);

    return function cleanup() {
      generation++; // orphans the pending probe above, whatever generation started it
      for (const unsubscribe of unsubscribers) unsubscribe();
      unsubscribers.length = 0;
    };
  }

  window.DnznWalletIdentity = {
    init,
    isAddress,
    liveIdentity,
    acceptLiveIdentity,
    clearIdentity,
  };
})();
