// Wallet header control: the dropdown's state machine, the header chip and the connect,
// disconnect and copy actions. The identity it renders from is not its own — persisting and
// governing that is src/wallet-identity.ts's job, reached here through window.DnznWalletIdentity.
// Loaded by its own <script> tag after wallet-identity.js and before shell.js, and reached only
// through window.DnznWallet — there is no bundler at runtime, so this file has no import path to
// the port, to shell.ts or to main.ts.
// The pure helpers are exported beside init() because that is the only way anything here is
// reachable from a unit test in this repo's idiom.

(() => {
  // The identity port, resolved once at load: wallet-identity.js is the script tag immediately
  // before this one, so the global is already assigned — the same bare-global contract
  // src/main.ts has with DxWallet. Aliased rather than spelled out at each call site below,
  // because the compiled file carries a hard payload budget.
  const port = window.DnznWalletIdentity;

  // D-17: four characters each side of a horizontal ellipsis, after the 0x. Casing is passed
  // through untouched in both directions — correct EIP-55 casing needs keccak-256 (Phase 5),
  // and normalising here would destroy a checksum the provider supplied.
  function shortenAddress(addr) {
    if (typeof addr !== 'string' || addr.length <= 12) return addr;
    return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
  }

  // Codes per EIP-1193 Provider Errors; -32002 is MetaMask's pending-request code.
  //
  // Two codes deliberately say nothing, and only one of them is obvious. 4001 is a decline the
  // person just made. -32002 diverges from RESEARCH's reference mapping, which gives it a
  // sentence: it is a *wait* state, the control is disabled for the duration, and reporting it
  // would train the person to ignore the one channel that carries real failures (T-02-25).
  //
  // That silence is honest only while something else is telling the person to look at their
  // wallet, and the bounded guard supplies exactly that: whenever the watchdog has re-armed the
  // control with a request still outstanding, CONNECT_WAITING is on screen, so a -32002 mapped
  // to null withholds nothing they cannot already read. Do not "fix" this back to a sentence
  // without also removing the bound, because the two are one design.
  function describeError(err) {
    switch (err?.code) {
      case 4001:
      case -32002:
        return null;
      case 4100:
        return 'This site is not authorized. Approve the connection in your wallet.';
      case 4200:
        return 'Your wallet does not support this request.';
      case 4900:
        return 'Your wallet is disconnected from all networks.';
      case 4901:
        return 'Your wallet is not connected to this network.';
      default:
        return 'Could not connect to your wallet.';
    }
  }

  // Where the address came from. There is one source now — the port's in-memory identity — so
  // 'live' is the only positive value; 'none' is everything else. The discriminator survives
  // the collapse from two sources to one because prohibition P2 still forbids implying more
  // than a live authorisation, and because copyAddress and stateFrom both need "is there
  // anything to show" answered the same way. Its only reader is stateFrom.
  //
  // Suppressed to null after an explicit Disconnect, exactly as the plugin branch was before
  // this plan: within a session the plugin keeps reporting `connected` until its own async
  // teardown finishes, so a repaint that consulted it would put back the chip the click just
  // removed — the silent-reconnect defect P6 forbids. liveSuppressed is cleared the moment a
  // fresh Connect gesture is made.
  //
  // The plugin's own getState() is deliberately not consulted here any more. Every plugin
  // signal already flows into the port through acceptLive below, so a second source read
  // straight from the plugin would restore the two-truths problem this plan exists to remove —
  // the port's in-memory identity is authoritative, full stop.
  function resolveIdentity(_dx) {
    const live = liveSuppressed ? null : port.liveIdentity();
    return live ? { address: live.address, source: 'live' } : { address: null, source: 'none' };
  }

  function stateFrom(dx, identity) {
    // Ask the plugin, never re-derive from window.ethereum: the adapter owns what "available"
    // means, so the menu reports no provider exactly when a connect would fail, not on some
    // independent signal.
    const providers = dx?.getPlugin?.('wallet')?.getProviders?.() ?? [];
    if (!providers.some((p) => p?.available?.())) return 'no-provider';
    // There is one source now, and it is live: no identity means disconnected, any identity
    // means connected. No separate "reports connected while the source is empty" case survives
    // the collapse to a single source.
    return identity.source === 'none' ? 'disconnected' : 'connected';
  }

  function resolveState(dx) {
    return stateFrom(dx, resolveIdentity(dx));
  }

  // Every node this module creates is the same three moves: a tag, a class, and text. Keeping
  // them in one place is what makes "textContent, never markup" a property of the module rather
  // than a habit repeated at six call sites — and it is the difference between this file fitting
  // its payload envelope and not.
  function buildNode(tag, className, text) {
    const node = document.createElement(tag);
    node.className = className;
    node.textContent = text;
    return node;
  }

  // One row shape for every action in the menu. A real <button type="button">, so Tab/Shift-Tab
  // and Space/Enter work with no keydown handler, no role="menu" and no roving tabindex — D-22,
  // and the reasoning fields.ts:389-390 used to reject a keydown handler on its switch.
  function buildMenuRow(label, id, onClick) {
    const row = buildNode('button', 'wallet-menu-row', label);
    row.type = 'button';
    row.id = id;
    row.addEventListener('click', onClick);
    return row;
  }

  // WAL-06. A real button through the router, not <a href="#/settings">, which would land on
  // DxKit's unmatched-route path if the dapp were ever absent. Hidden rather than dead when no
  // enabled manifest claims the route; the settings dapp is not `optional`, so this is
  // belt-and-braces and cheap.
  function buildSettingsRow(dx) {
    const manifests = dx?.getEnabledManifests?.() ?? [];
    if (!manifests.some((m) => m?.route === '/settings')) return null;

    return buildMenuRow('Settings', 'wallet-settings', () => {
      // Closes only the wrapper this module owns. shell.ts has its own shared closer for all
      // three header dropdowns, but it sits in a separately transpiled file with no import path
      // to here, so calling it would depend on an accidental global. These are the same two
      // mutations, and this is the only place in this module that needs them.
      document.getElementById('wallet-panel')?.classList.remove('open');
      document.getElementById('wallet-btn')?.setAttribute('aria-expanded', 'false');
      dx.router.navigate('/settings');
    });
  }

  // The chip sits inside the trigger, so a returning visitor sees the address without opening
  // anything. Only the chip is replaced — never the trigger, which is the header's node and whose
  // siblings carry every other action button's handlers. The chip itself holds no listener, so
  // dropping and rebuilding it is cheaper than reaching inside it.
  //
  // The shortened address is the whole label, here and in the menu row: nothing in this milestone
  // signs anything, so no copy beside it may imply the person's identity was proven (P2).
  function paintChip(trigger, address) {
    if (!trigger) return;

    // A shortened 0x1234…5678 collides trivially, so all 42 characters stay reachable without
    // opening anything — T-02-05's first mitigation, and it costs one attribute.
    trigger.setAttribute('title', address ?? 'Wallet');
    trigger.querySelector('.wallet-chip')?.remove();
    if (!address) return;

    const chip = buildNode('span', 'wallet-chip', '');
    chip.append(buildNode('span', 'wallet-address', shortenAddress(address)));
    trigger.append(chip);
  }

  // Both copy failure paths land here — clipboard absent, and write rejected. The inline
  // sentence alone would be advice the UI cannot honour: the visible row shows only the
  // shortened 4+4 form, and the full value sits in the trigger's `title`, which is not
  // selectable text. So the field is revealed, focused and selected. `readonly` rather than
  // `disabled`, because a disabled input cannot be selected either.
  function revealFullAddress(address) {
    setMessage(COPY_FAILED);
    const field = document.querySelector('#wallet-menu .wallet-address-full');
    if (!field) return;
    field.value = address;
    field.classList.add('revealed');
    field.focus();
    field.select();
  }

  // The confirmation is applied strictly after the write resolves, and never on a path that did
  // not write. A confirmation for a write that did not happen tells the person they hold an
  // address they do not, and what they then paste into a transaction is whatever was actually on
  // the clipboard — T-02-28, and the exact defect `.planning/codebase/CONCERNS.md` §Known Bugs
  // logs against the share button under "No explicit error handling for URL share failure".
  // That button is deliberately left as this task found it; this module must not repeat it.
  //
  // navigator.clipboard is property-guarded because it is `undefined` outside a secure context
  // and this site is explicitly servable from plain-HTTP IPFS gateways: the share button's
  // unguarded shape throws a TypeError synchronously, before any `.then()` — an uncaught error
  // and a dead control. No fallback onto the legacy deprecated copy command either: the inline
  // message plus the selectable field is the honest degradation, and it is not deprecated.
  async function copyAddress(dx, button) {
    // Current state at click time, never a value closed over when the row was built. An account
    // switch repaints the row, and a handler holding a captured string would copy the previous
    // account's address while the row displays the new one (T-02-27).
    const address = resolveIdentity(dx).address;
    if (!address) return;
    // The full 42 characters exactly as stored, casing untouched — a shortened 0x1234…5678
    // collides trivially, and pasting one into a transaction is the loss this control avoids.
    if (typeof navigator.clipboard?.writeText !== 'function') {
      revealFullAddress(address);
      return;
    }
    try {
      await navigator.clipboard.writeText(address);
    } catch {
      revealFullAddress(address);
      return;
    }
    button.classList.add('copied');
    // Tracked and superseded, the way guardTimer is. Two copies inside COPY_MS used to leave two
    // timers, and the first then removed the confirmation the second had just applied — the
    // second flash vanishing early. It is also a subscription this module has to be able to
    // release: init's cleanup closure makes exactly that argument for the watchdog handle.
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => button.classList.remove('copied'), COPY_MS);
  }

  // Repaints the menu's own children and the trigger's chip only — never the header, which
  // renderHeader owns and which would take every other action button's handlers with it. Rows
  // are recreated rather than mutated in place, so their listeners are discarded with the
  // nodes they sit on, the same argument refreshNavMenu makes for #app-menu. Every value
  // reaches the DOM through textContent — this module never assigns markup.
  function render(dx) {
    const menu = document.getElementById('wallet-menu');
    if (!menu) return;

    const identity = resolveIdentity(dx);
    const state = stateFrom(dx, identity);
    const trigger = document.getElementById('wallet-btn');
    trigger?.classList.toggle('muted', state === 'no-provider');
    menu.replaceChildren();

    if (state === 'no-provider') {
      // WAL-07 / D-15: one plain sentence. No Connect action, because offering a control that
      // provably cannot work is the failure this requirement exists to prevent; no wallet
      // vendor named and no outbound link, because a named vendor in a wallet prompt is itself
      // a phishing shape.
      paintChip(trigger, null);
      menu.append(
        buildNode('p', 'wallet-message', 'No Ethereum wallet was detected in this browser. Install one to connect.'),
      );
      return;
    }

    paintChip(trigger, state === 'connected' ? identity.address : null);

    if (state === 'connected') {
      // D-13's first row: the shortened form, a discrete copy control beside it, and the
      // selectable full-address field the failure branch reveals. A real <button> rather than a
      // clickable row, so this hit target is not ambiguous with the Settings and Disconnect rows
      // below it — and not `.copy-btn` from components.css, whose margin-top: 1.5rem is tuned
      // for the CIC report footer and would push a dropdown row apart.
      const addressRow = buildNode('div', 'wallet-address-row', '');
      addressRow.append(buildNode('span', 'wallet-address', shortenAddress(identity.address)));
      const copy = buildNode('button', 'wallet-copy', 'COPY');
      copy.type = 'button';
      copy.append(buildNode('span', 'wallet-copied', 'COPIED'));
      copy.addEventListener('click', () => copyAddress(dx, copy));
      addressRow.append(copy);
      // In the DOM from the first paint and hidden by CSS, so the failure branch only reveals it
      // and the menu's geometry never moves while it is not needed.
      const full = buildNode('input', 'wallet-address-full', '');
      full.type = 'text';
      full.readOnly = true;
      addressRow.append(full);
      menu.append(addressRow);
    } else {
      // D-14's disconnected dropdown: a Connect action above the Settings link. The id is how
      // the guard finds this row again from a timer callback, after a repaint has replaced any
      // reference a closure could have held.
      menu.append(buildMenuRow('Connect wallet', 'wallet-connect', () => startConnect(dx)));
    }

    const settingsRow = buildSettingsRow(dx);
    if (settingsRow) menu.append(settingsRow);

    // D-13's third row, after the address row and the Settings link. Connected state only:
    // offering it anywhere else would be a control with nothing to end.
    if (state === 'connected') menu.append(buildMenuRow('Disconnect', 'wallet-disconnect', () => disconnectWallet(dx)));

    // In the DOM and empty rather than created on demand, so a repaint never has to find or make
    // it, and `.wallet-message:empty` keeps it from leaving a gap. `.wallet-alert` is the only
    // thing that tells it apart from the static sentence above, which shares the same shape and
    // must survive setMessage's clear-on-open (D-16).
    menu.append(buildNode('p', 'wallet-message wallet-alert', ''));
  }

  // The one path from a live provider signal to the screen, and the seam's whole width on this
  // side: the port applies D-18's casing rule and D-07's chain-id rule and answers whether the
  // header has anything new to paint. Both entry points — the connect success path and every
  // wallet event — go through here, so a repaint can never happen on a signal the port rejected.
  function acceptLive(dx, live) {
    // WR-01: startConnect's connect().then() is not otherwise gated — only its finally is
    // token-checked — so a connect() that settles after cleanup() must not reach the port or
    // the menu through here.
    if (disposed) return;
    if (port.acceptLiveIdentity(dx, live?.address, live?.chainId)) render(dx);
  }

  // Long enough that an ordinary human approval settles first, so the watchdog never fires on
  // the happy path; short enough that an unanswered prompt cannot make Connect inert for the
  // rest of the session.
  const CONNECT_GUARD_MS = 30000;
  const CONNECT_WAITING = 'Your wallet has not answered yet — check your wallet, then try again.';

  // D-13 reuses the shell's settled confirmation idiom rather than adding a toast: the same
  // `.copied` class and the same 1500ms window `src/shell.ts`'s share button and
  // `src/dapps/cic/cic.ts:797-800` already share.
  const COPY_MS = 1500;
  const COPY_FAILED = 'Could not reach the clipboard. Select the full address below and copy it.';
  let copyTimer = null;

  // One flag for both entry points into wallet.connect(), bounded by the two members below.
  let inFlight = false;
  let guardTimer = null;
  // Which attempt owns the two members above. releaseConnectGuard mutates module state with no
  // notion of an owner, and after the watchdog re-arms the control a second attempt can be in
  // flight when the FIRST one finally settles: an ungated release would then clear the newer
  // request's flag and cancel its watchdog, leaving it unbounded. A third connect() would tear
  // down the listener the second one's approval arrives on
  // (../dxkit/plugins/wallet/src/index.ts:300-305), so the person approves in their
  // wallet, updateState reaches no subscriber, and the header sits on CONNECT_WAITING until a
  // reload. Only the current owner releases; the explicit close and cleanup paths are not
  // attempt-scoped by design, because they release whatever is current on purpose.
  let connectToken = 0;
  // How the module knows a request is still outstanding *after* the watchdog has re-armed the
  // control. It is what keeps the -32002 silence honest: while this is above zero, the person
  // has CONNECT_WAITING on screen rather than nothing.
  let unsettledConnects = 0;

  // Set by the Disconnect click, cleared by the next Connect gesture. Its only reader is
  // resolveIdentity's live branch; see the comment there for why the plugin's own state has to
  // lose to a decision the person made explicitly.
  let liveSuppressed = false;

  // WR-01: set the moment cleanup() runs, read by acceptLive so a connect() that settles after
  // this mount has stopped owning the menu cannot mutate the port or repaint into it — the same
  // hole wallet-identity.ts's own generation counter closes for the unawaited probe. Cleared at
  // the top of every init() rather than only declared once, so a re-init (this module's own test
  // seam; production wires the header once and never unmounts it) starts undisposed again.
  let disposed = false;

  // A null text means "say nothing" and leaves whatever is on screen alone, so describeError's
  // null for a decline or a pending request flows straight through with no branch at the caller.
  // An empty string still clears.
  function setMessage(text) {
    const node = document.querySelector('#wallet-menu .wallet-alert');
    if (node && text !== null) node.textContent = text;
  }

  // The one seam that puts inFlight back to false, and the answer to "where is this flag
  // reset". Idempotent, with exactly four callers and no others: startConnect's finally, the
  // watchdog callback, the dropdown-close path and init's cleanup closure. It releases the
  // module's current guard, whichever attempt armed it — which is why only the finally, the one
  // caller that can arrive out of order, is gated on connectToken.
  function releaseConnectGuard() {
    inFlight = false;
    clearTimeout(guardTimer);
    guardTimer = null;
    document.getElementById('wallet-connect')?.removeAttribute('disabled');
  }

  // The one bounded single-flight connect, reached from the explicit Connect click and from
  // D-08's lazy re-arm below — two gestures, one call. eth_requestAccounts is single-flight per
  // origin, and worse here: the plugin tears the previous provider down before it starts
  // (../dxkit/plugins/wallet/src/index.ts:300-305), so a second request during an
  // in-flight first one both rejects -32002 and unsubscribes the listeners the first one is
  // about to need (T-02-24).
  //
  // The bound is the load-bearing part, not the flag. MetaMask #11280 leaves
  // eth_requestAccounts pending forever when an unlock prompt is dismissed; a promise that never
  // settles never runs a finally, so a finally-only reset would leave inFlight true for the rest
  // of the session and this control permanently inert — with -32002 deliberately silent, with no
  // message at all. So: a watchdog re-arms the control and says so, and unsettledConnects
  // remembers that the request is still out there.
  function startConnect(dx) {
    if (inFlight) return;
    const wallet = dx?.getPlugin?.('wallet');
    if (typeof wallet?.connect !== 'function') return;

    // Before the counter moves, so a first attempt clears the region and a retry re-asserts the
    // watchdog's sentence instead of erasing it (D-16). WR-02: unsettledConnects alone survives
    // an identity that later arrived through a path that is not this connect() — an unlock, an
    // account switch — so the state check keeps a connected header from being told to wait.
    setMessage(unsettledConnects > 0 && resolveState(dx) !== 'connected' ? CONNECT_WAITING : '');
    // A fresh Connect gesture is the one thing that lifts a previous Disconnect's suppression of
    // the plugin's live state: the person is asking for a live connection again.
    liveSuppressed = false;
    inFlight = true;
    const token = ++connectToken;
    unsettledConnects += 1;
    // The attribute, not the property, because `?.` cannot appear on an assignment target and
    // the reflected IDL property reads exactly the same to anything that asks. The DOM enforces
    // what the flag asserts, so a second click never reaches a listener at all.
    document.getElementById('wallet-connect')?.setAttribute('disabled', '');
    guardTimer = setTimeout(() => {
      releaseConnectGuard();
      setMessage(CONNECT_WAITING);
    }, CONNECT_GUARD_MS);

    // wallet.connect() runs synchronously, inside the click's own task: deferring
    // eth_requestAccounts even by a microtask is how a wallet popup gets treated as unsolicited.
    // The Promise constructor is what routes a synchronous throw out of an adapter into the same
    // catch as a rejection, so neither escapes the click handler.
    new Promise((resolve) => resolve(wallet.connect()))
      .then((live) => acceptLive(dx, live))
      // Only describeError's own fixed sentences reach the DOM — never the error's `message`,
      // which is extension-controlled text this page did not write (T-02-23). Its null for 4001
      // and -32002 means say nothing, which setMessage honours without a branch here.
      .catch((err) => setMessage(describeError(err)))
      .finally(() => {
        unsettledConnects -= 1;
        if (token === connectToken) releaseConnectGuard();
      });
  }

  // What this exists for changed with 02-09: the header now paints straight from the injected
  // provider's own answer, so there is no cache to restore from. What re-arm gives the plugin
  // instead is an *active provider* — a session the query restored never called connect(), so
  // the vendored disconnect() has nothing to revoke (it gates EIP-2255 revocation on
  // activeProvider?.id === 'eip1193'). Opening the dropdown on a live-but-not-plugin-connected
  // identity quietly re-establishes that connection, so a later Disconnect can actually revoke
  // rather than merely forgetting an address the page never told the wallet to release. It
  // routes through startConnect rather than owning a second call, which is also what puts this
  // path under the watchdog — the exact path the review found latching.
  //
  // The no-provider check comes first and reuses the module's own state resolver rather than
  // adding a second notion of availability. Remove or disable the extension after connecting
  // and the in-memory identity outlives it for the rest of the session, so both conditions below
  // still hold: this path would issue a connect from a menu the same paint rendered as
  // no-provider, whose contract (WAL-07 / D-15) is that it offers no Connect action at all. That
  // attempt is also silent — the plugin throws a bare "No wallet provider available" and the
  // no-provider render appends no .wallet-alert, so setMessage has nothing to write into.
  function reArm(dx) {
    // An explicit Disconnect's suppression must outrank the lazy re-arm: only the Connect row is
    // a gesture. Consult the module's own identity resolver, which already folds suppression in
    // — reading port.liveIdentity() directly here is the exact back door CR-01 found: a
    // provider accountsChanged after Disconnect repopulates the port, and the next mere dropdown
    // open silently reconnected through it.
    if (liveSuppressed || resolveState(dx) === 'no-provider' || !resolveIdentity(dx).address) return;
    const live = dx?.getPlugin?.('wallet')?.getState?.();
    if (live?.connected && live.address) return;
    startConnect(dx);
  }

  // WAL-04, and the order is the whole design. Clear first, because the person's intent has to
  // survive a rejection, a hang or a tab closed mid-call. Repaint second, because they must see
  // their own decision immediately. Start the provider call third and never await it here, so a
  // slow wallet is the wallet's problem and not the page's.
  //
  // Upstream awaits the EIP-2255 permission-revocation RPC *before* it tears the provider down
  // (../dxkit/plugins/wallet/src/index.ts:330), and either await can stay pending — the
  // same unanswered-prompt shape startConnect bounds. Clear-then-await would leave the identity
  // cache already deleted while the connected chip stayed on screen: a visibly hung Disconnect,
  // with the person's data gone and the UI claiming the opposite (T-02-36).
  //
  // What this promises, no more strongly than it is true: it ends *this site's* wallet
  // connection for the rest of this document's life, and it forgets the in-memory identity so a
  // reload does not start from where this session left off with no way for the person to have
  // asked. Permission revocation is the plugin's *attempt* — only when the revokeOnDisconnect
  // setting is on, only for the EIP-1193 adapter, and swallowed by a bare catch when the wallet
  // does not support it. This module adds no second revoke path and detects no wallet
  // capabilities.
  //
  // The residual DEC-A creates and does not hide: with nothing persisted, an explicit Disconnect
  // only survives a reload if the wallet actually revoked. On a wallet without
  // wallet_revokePermissions support, or after a re-arm the person declined, this origin is
  // still authorised in the wallet's own eyes — so the next load's query answers with the
  // account again, and the header correctly shows it as connected. That is not this page failing
  // to disconnect; it is this page having nothing left to forget once the wallet itself has not
  // let go. The durable path is ending the connection from inside the wallet's own connected-
  // sites list, which this module cannot do on the person's behalf.
  //
  // It sits on a click handler because a human gesture is the only legitimate trigger — routing
  // it through the `disconnected` event instead would wipe the identity on every auto-lock,
  // which is Pitfall 3 through the back door.
  function disconnectWallet(dx) {
    port.clearIdentity();
    // Both sources, not just the in-memory identity: the plugin still reports `connected` until
    // its own async teardown lands, and a repaint that believed it would restore the chip this
    // click removes.
    liveSuppressed = true;
    render(dx);
    new Promise((resolve) => resolve(dx?.getPlugin?.('wallet')?.disconnect?.())).catch(() => undefined);
  }

  // The gesture. shell.ts wires its own toggle on this same node first, so by the time this
  // listener runs the .open class already reflects the click's outcome: open means the menu
  // just opened, closed means it just shut.
  function wireTrigger(dx) {
    const trigger = document.getElementById('wallet-btn');
    if (!trigger) return () => undefined;

    const onClick = () => {
      if (document.getElementById('wallet-panel')?.classList.contains('open')) {
        // D-16, literally: the region empties on the next open — except while a request is still
        // outstanding, where the watchdog's sentence is re-asserted rather than erased. WR-02:
        // gated on state too, so a session that became connected through another path (a wallet
        // unlock, an account switch) is not told to wait on every subsequent open.
        setMessage(unsettledConnects > 0 && resolveState(dx) !== 'connected' ? CONNECT_WAITING : '');
        // Alongside the message clear: a revealed fallback field is part of the same failure
        // report, so it goes when the report does rather than persisting into the next open.
        document.querySelector('#wallet-menu .wallet-address-full')?.classList.remove('revealed');
        reArm(dx);
        return;
      }
      // The dropdown-close bound. It does not replace the watchdog and the watchdog does not
      // replace it: they bound different people. This one bounds the person who reopens the
      // menu; the timer bounds the person who never touches it again.
      releaseConnectGuard();
    };
    trigger.addEventListener('click', onClick);
    return () => trigger.removeEventListener('click', onClick);
  }

  // Every piece of feedback this menu paints — the COPY flash, describeError's sentences, the
  // revealed full-address field — lands INSIDE the menu, and shell.ts closes all three header
  // dropdowns from a document-level click listener. Without this, a row's own click closed the
  // menu that was about to report back: the confirmation and the error text were written into a
  // node already at opacity 0, and the clear-on-open in wireTrigger then wiped them before the
  // next open could show them. Registered on the menu wrapper rather than on each row, because
  // render() rebuilds the rows and the wrapper survives. The Settings row still closes the menu —
  // it does that itself, deliberately, on its way to the route.
  function wireMenuContainment() {
    const menu = document.getElementById('wallet-menu');
    if (!menu) return () => undefined;
    const onClick = (e) => e.stopPropagation();
    menu.addEventListener('click', onClick);
    return () => menu.removeEventListener('click', onClick);
  }

  function init(dx) {
    if (!dx) return () => undefined;

    // A re-init (the test seam; production never unmounts this header) must start undisposed,
    // or every acceptLive after the first mount would be a permanent no-op.
    disposed = false;

    // The port first: it resets its in-memory identity and starts the injected provider's own
    // eth_accounts query, unawaited. Its cleanup joins this module's list, so one closure still
    // releases everything, including the two direct provider listeners it may have registered.
    const unsubscribers = [port.init(dx, () => render(dx))];

    // Render before the query can possibly have answered — T-02-39's property at this call
    // site. The header paints the disconnected state for the frame or two until the query's
    // `then` calls back into render(dx) through the onChange above; that flash is DEC-A's stated
    // cost, not a bug to design around (see the SUMMARY's UAT note).
    render(dx);

    // One handler for every live-identity signal, whatever shape it arrives in. The address is
    // validated inside the port, so nothing here has to re-check it.
    const onLive = (live) => acceptLive(dx, live);

    // Two disposable shapes, both real: the wallet plugin's onStateChange returns a bare
    // unsubscribe function, while dx.events.on returns an { off() } object. Both are stored
    // and both are released below.
    //
    // A lock arrives at onStateChange as { connected: false, address: null }. D-08's rule, and
    // the one the whole plan turns on: locked is not disconnected, so clear nothing and repaint
    // nothing. Carrying the connected flag is the whole job of this guard.
    const stateUnsub = dx.getPlugin?.('wallet')?.onStateChange?.((live) => {
      if (live?.connected) onLive(live);
    });
    if (typeof stateUnsub === 'function') unsubscribers.push(stateUnsub);

    // `disconnected` is deliberately inert, and it is the rule the whole plan turns on. The
    // adapter maps an empty accountsChanged to connected:false unconditionally
    // (../dxkit/plugins/wallet/src/index.ts:56-68), and MetaMask fires that same handler
    // when the wallet merely locks, so the event is ambiguous between lock and revoke.
    // Treating it as a disconnect would wipe the identity on every auto-lock (T-02-20). The
    // in-memory identity is cleared by the Disconnect click and by nothing else — there is no
    // toggle to clear it any more.
    const handlers = { connected: onLive, changed: onLive, disconnected: () => undefined };
    for (const [event, handler] of Object.entries(handlers)) {
      const listener = dx.events?.on?.(`dx:plugin:wallet:${event}`, handler);
      if (listener?.off) unsubscribers.push(() => listener.off());
    }

    unsubscribers.push(wireTrigger(dx));
    unsubscribers.push(wireMenuContainment());

    // Header chrome is wired once and never unmounted (src/shell.ts's refreshNavMenu comment
    // spells out why), so this closure has no production caller today. It exists because
    // AGENTS.md makes a cleanup closure init()'s contract, and because it is the test seam.
    return function cleanup() {
      // WR-01: flips first, so a connect() already in flight settles into a disposed acceptLive
      // no-op rather than the menu this closure is about to empty.
      disposed = true;
      // Both pending handles are subscriptions: left armed, either callback would write into a
      // menu this closure has already stopped owning.
      releaseConnectGuard();
      clearTimeout(copyTimer);
      copyTimer = null;
      // And so is every row render() built. Each one closes over dx and reaches startConnect,
      // disconnectWallet, copyAddress or the router, so rows left in the document after this
      // runs are live controls into a menu nothing owns — including a Connect that would arm the
      // very timer cleared two lines up. Dropping the nodes is how their listeners go, the same
      // argument render() itself makes for recreating rows rather than mutating them. The chip
      // stays: it carries no listener, and un-painting was never this closure's contract.
      document.getElementById('wallet-menu')?.replaceChildren();
      for (const unsubscribe of unsubscribers) unsubscribe();
      unsubscribers.length = 0;
    };
  }

  // Four members, all of them display: init and the three pure helpers that are the unit-test
  // seam for it. Everything about the live identity — observing it, reading it, clearing it — is
  // window.DnznWalletIdentity's surface and is deliberately not re-exported here; a delegation
  // kept "so a caller need only know one namespace" is exactly what would let the seam rot.
  window.DnznWallet = {
    init,
    shortenAddress,
    describeError,
    resolveState,
  };
})();
