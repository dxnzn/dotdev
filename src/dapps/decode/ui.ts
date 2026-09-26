// window.DxDecode.ui — the driving adapter: renders the decoder select, the textarea, the
// Result/Raw/Log tab strip, and walks the returned DecodeNode tree into DOM. Loads last, after
// core.ts and decoders.ts, so the registry it reads from is already populated.
//
// Every DOM write in this file assigns text as a property (textContent), never markup —
// decoded bytes are attacker-controlled and printable byte values render as literal
// characters (see the phase's threat register, T-3-01). No query in this file reaches beyond
// its own container.
//
// No branch anywhere in this file may test which decoder produced a tree (see
// test/decode-ui.test.ts's source scan) — every extension point here is a dispatch table
// keyed on a DecodeNode member (display, provenance), per this plan's
// <renderer_completeness_decision>.
window.DxDecode ??= {};

// ── Value formatting (D-02, D-14) ───────────────────────────────────────────────────────

// The one place "what does this node's value actually say" is answered — for both display
// and copy. `raw` wins when present (a decoder's own full-fidelity text); otherwise a bigint
// is rendered via its own toString (never exponential, never truncated — D-02) and anything
// else via String(). Returns undefined only when the node truly has neither, which is what
// lets the copy handler tell "nothing to copy" apart from "the value is falsey".
function underlyingText(node: DecodeNode): string | undefined {
  if (node.raw !== undefined) return node.raw;
  if (node.value === undefined || node.value === null) return undefined;
  if (typeof node.value === 'bigint') return node.value.toString();
  return String(node.value);
}

// A standalone `type` alias, not an inline `DecodeNode['display']` indexed-access — the
// DEC-14 guard's allowlist scan strips type declarations' BODIES but not an arbitrary
// indexed-access type used inline elsewhere, and `DecodeNode['display']` written directly
// inside the Record<> below reads, to that scan, as `DecodeNode` followed by `[` (a runtime
// index access). A named alias keeps the exact same type while giving the guard a declaration
// it fully strips.
type DisplayMode = NonNullable<DecodeNode['display']>;
type ProvenanceMode = NonNullable<DecodeNode['provenance']>;

// The declared display union, restated here only as a Record's key set — TypeScript already
// fails this file to compile if an entry is missing or an extra one is added, and the
// exhaustiveness test compares this table's runtime key set against the union's seven members
// so a mode added to types.d.ts in a later phase fails here rather than silently falling
// through to the default. Every entry today renders the same underlying text: none of this
// phase's decoders shorten a value for display, so display text and copy text coincide. Phase
// 5 decorates `address`/`txhash` with a link — it changes what these functions RETURN, never
// the table's shape (the whole point of <renderer_completeness_decision>).
const DISPLAY_DISPATCH: Record<DisplayMode, (node: DecodeNode) => string | null> = {
  address: (node) => underlyingText(node) ?? null,
  txhash: (node) => underlyingText(node) ?? null,
  hex: (node) => underlyingText(node) ?? null,
  int: (node) => underlyingText(node) ?? null,
  text: (node) => underlyingText(node) ?? null,
  json: (node) => underlyingText(node) ?? null,
  bool: (node) => underlyingText(node) ?? null,
};

// A node declaring no display mode, or one this table doesn't recognise, renders through this
// path rather than throwing or rendering nothing.
function formatDisplayValue(node: DecodeNode): string | null {
  if (node.display && node.display in DISPLAY_DISPATCH) {
    return DISPLAY_DISPATCH[node.display](node);
  }
  return underlyingText(node) ?? null;
}

const PROVENANCE_LABELS: Record<ProvenanceMode, string> = {
  verified: 'Verified',
  registry: 'Registry',
  unresolved: 'Unresolved',
  local: 'Local',
};

// ── Copy-on-click (D-14) ─────────────────────────────────────────────────────────────────

// 1500ms — matching src/shell-wallet.ts's own COPY_MS, the precedent this control follows.
const COPY_CONFIRM_MS = 1500;

// Keyed per row rather than one shared timer: two copies on the SAME row must supersede each
// other (the wallet's own bug fix — two timers left the first clearing the second's
// confirmation early), but two DIFFERENT rows' confirmations must never interfere with each
// other. A shared single timer would fix the first case by breaking the second.
const copyTimers = new Map<HTMLElement, ReturnType<typeof setTimeout>>();

function confirmCopy(row: HTMLElement) {
  const existing = copyTimers.get(row);
  if (existing !== undefined) clearTimeout(existing);
  row.classList.add('decode-copied');
  const timer = setTimeout(() => {
    row.classList.remove('decode-copied');
    copyTimers.delete(row);
  }, COPY_CONFIRM_MS);
  copyTimers.set(row, timer);
}

// Called from the cleanup closure so a copy immediately before unmount leaves nothing running.
function clearAllCopyTimers() {
  for (const timer of copyTimers.values()) clearTimeout(timer);
  copyTimers.clear();
}

// Both copy failure paths land here — clipboard absent, and write rejected — following
// src/shell-wallet.ts's revealFullAddress shape exactly: put the text in a field and call
// focus()/select() on it, reaching no global (getSelection is deliberately off DEC-14's
// allowlist). Scoped to the row's own mounted subtree via closest(), never document.querySelector
// — this file's dapps-own-their-container rule applies to a fallback path exactly as much as
// to the primary render.
function revealCopyFallback(row: HTMLElement, text: string) {
  const field = row.closest('.layout-tool')?.querySelector<HTMLInputElement>('#decode-copy-reveal');
  if (!field) return;
  field.value = text;
  field.classList.add('revealed');
  field.focus();
  field.select();
}

// Shared by tree copy-on-click (D-14) and the share controls (D-19/D-20) — one guarded
// clipboard path, never two independent implementations of "try clipboard, fall back."
// navigator.clipboard is property-guarded because it is undefined outside a secure context and
// this site is explicitly servable from plain-HTTP IPFS gateways. Returns whether the native
// write actually happened, so each call site decides its own confirmation/fallback UI.
async function writeClipboard(text: string): Promise<boolean> {
  if (typeof navigator.clipboard?.writeText !== 'function') return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

// A confirmation is applied strictly after the write resolves, and never on a path that did
// not write (T-3-15).
async function copyValue(node: DecodeNode, row: HTMLElement): Promise<void> {
  const text = underlyingText(node);
  // A falsey value (0, '') is still a value — the branch above is presence, never truthiness.
  // Only a node with neither raw nor value at all reaches here.
  if (text === undefined) return;
  const wrote = await writeClipboard(text);
  if (!wrote) {
    revealCopyFallback(row, text);
    return;
  }
  confirmCopy(row);
}

// ── The generic DecodeNode tree renderer (D-13, D-15, D-03, D-01) ──────────────────────────

let treeIdCounter = 0;
function nextTreeId(): string {
  treeIdCounter += 1;
  return `decode-tree-children-${treeIdCounter}`;
}

// One row per node, in the array's own order (D-03 — position is identity, never sorted,
// never de-duplicated by label). Two targets on the row: the disclosure control (real button,
// toggles expand/collapse, announced via aria-expanded/aria-controls) and the value (real
// button, click-to-copy) — never the row itself, which is why D-13 rejects a native
// <details>/<summary> element in the first place.
function renderNode(node: DecodeNode): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'decode-tree-node';

  const hasChildren = Array.isArray(node.children) && node.children.length > 0;
  let childrenEl: HTMLElement | null = null;
  if (hasChildren) {
    childrenEl = document.createElement('div');
    childrenEl.className = 'decode-tree-children';
    childrenEl.id = nextTreeId();
    // D-15: the decoder decides what is collapsed; no heuristic here on depth or child count.
    if (node.collapsed === true) childrenEl.classList.add('decode-tree-collapsed');
    for (const child of node.children as DecodeNode[]) {
      childrenEl.append(renderNode(child));
    }
  }

  const row = document.createElement('div');
  row.className = 'decode-tree-row';

  if (hasChildren && childrenEl) {
    const disclosure = document.createElement('button');
    disclosure.type = 'button';
    disclosure.className = 'decode-tree-disclosure';
    const collapsedInitially = node.collapsed === true;
    disclosure.setAttribute('aria-expanded', String(!collapsedInitially));
    disclosure.setAttribute('aria-controls', childrenEl.id);
    disclosure.textContent = collapsedInitially ? '▸' : '▾';
    disclosure.addEventListener('click', () => {
      const expanded = disclosure.getAttribute('aria-expanded') === 'true';
      const next = !expanded;
      disclosure.setAttribute('aria-expanded', String(next));
      disclosure.textContent = next ? '▾' : '▸';
      childrenEl?.classList.toggle('decode-tree-collapsed', !next);
    });
    row.append(disclosure);
  }

  const label = document.createElement('span');
  label.className = 'decode-tree-label';
  label.textContent = node.label;
  row.append(label);

  if (node.type || node.display) {
    const hint = document.createElement('span');
    hint.className = 'decode-tree-hint';
    hint.textContent = node.type ?? node.display ?? '';
    row.append(hint);
  }

  // Always a button, even when there is nothing to show — a node with neither raw nor value
  // still has to be a click-on-nothing target (see copyValue's presence check above), which is
  // exactly what D-13 means by "the value is the copy target", not "the value is the copy
  // target when there happens to be one".
  const valueBtn = document.createElement('button');
  valueBtn.type = 'button';
  valueBtn.className = 'decode-tree-value';
  valueBtn.textContent = formatDisplayValue(node) ?? '';
  valueBtn.addEventListener('click', () => {
    void copyValue(node, row);
  });
  row.append(valueBtn);

  if (node.provenance) {
    const badge = document.createElement('span');
    badge.className = `decode-provenance-badge decode-provenance-${node.provenance}`;
    badge.textContent = PROVENANCE_LABELS[node.provenance];
    row.append(badge);
  }

  // D-01: error and warning are different states and can coexist — two independent ifs, never
  // an else-if, because a partially-decoded node that also deserves a caution is exactly what
  // the additive `error` field beside `warning` exists to permit.
  if (node.error) {
    const err = document.createElement('span');
    err.className = 'decode-tree-error';
    err.textContent = node.error;
    row.append(err);
  }
  if (node.warning) {
    const warn = document.createElement('span');
    warn.className = 'decode-tree-warning';
    warn.textContent = node.warning;
    row.append(warn);
  }
  if (node.annotations) {
    for (const text of node.annotations) {
      const ann = document.createElement('span');
      ann.className = 'decode-tree-annotation';
      ann.textContent = text;
      row.append(ann);
    }
  }

  wrapper.append(row);
  if (childrenEl) wrapper.append(childrenEl);
  return wrapper;
}

// ── Raw — the hex dump (D-16) ────────────────────────────────────────────────────────────

// Column count is Claude's discretion (CONTEXT.md) — 16 bytes/row is the conventional width.
const HEXDUMP_BYTES_PER_ROW = 16;
const PRINTABLE_MIN = 0x20;
const PRINTABLE_MAX = 0x7e;

function renderHexDump(bytes: Uint8Array): HTMLElement {
  const table = document.createElement('table');
  table.className = 'decode-hexdump';
  const tbody = document.createElement('tbody');

  for (let offset = 0; offset < bytes.length; offset += HEXDUMP_BYTES_PER_ROW) {
    const rowBytes = bytes.slice(offset, offset + HEXDUMP_BYTES_PER_ROW);
    const tr = document.createElement('tr');

    const offsetCell = document.createElement('td');
    offsetCell.className = 'decode-hexdump-offset';
    offsetCell.textContent = offset.toString(16).padStart(8, '0');
    tr.append(offsetCell);

    const bytesCell = document.createElement('td');
    bytesCell.className = 'decode-hexdump-bytes';
    bytesCell.textContent = Array.from(rowBytes, (b) => b.toString(16).padStart(2, '0')).join(' ');
    tr.append(bytesCell);

    // A byte outside the printable range renders as a placeholder character, never as the
    // control character itself (RESEARCH.md Pitfall 4) — and every cell is textContent, so a
    // printable byte that happens to spell an element creates no element, only visible text.
    const asciiCell = document.createElement('td');
    asciiCell.className = 'decode-hexdump-ascii';
    let ascii = '';
    for (const b of rowBytes) {
      ascii += b >= PRINTABLE_MIN && b <= PRINTABLE_MAX ? String.fromCharCode(b) : '.';
    }
    asciiCell.textContent = ascii;
    tr.append(asciiCell);

    tbody.append(tr);
  }

  table.append(tbody);
  return table;
}

function renderRawEmpty(): HTMLElement {
  const p = document.createElement('p');
  p.className = 'decode-empty-message';
  p.textContent = 'Nothing decoded yet — the raw bytes will appear here once you run a decode.';
  return p;
}

// D-16: which Raw renderer runs is the decoder's choice, read from rawView — never inferred by
// parsing the root node's own `raw` string, which would make this renderer decoder-specific.
// Only one entry exists this phase; an unrecognised rawView falls back to it rather than
// rendering nothing, which is what makes Phase 4's second entry (`abi-words`, TXT-05) a
// registration rather than a rewrite.
const RAW_VIEW_DISPATCH: Record<string, (bytes: Uint8Array) => HTMLElement> = {
  'hex-dump': renderHexDump,
};

function renderRaw(rawBytes: Uint8Array | null, rawView: string): HTMLElement {
  if (!rawBytes) return renderRawEmpty();
  const renderer = RAW_VIEW_DISPATCH[rawView] ?? RAW_VIEW_DISPATCH['hex-dump'];
  return renderer(rawBytes);
}

// ── Log — the privacy statement (D-17) and the live entry table ────────────────────────────

const LOG_COLUMNS: { key: keyof LogEntry; label: string }[] = [
  { key: 'timestamp', label: 'Time' },
  { key: 'method', label: 'Method' },
  { key: 'host', label: 'Host' },
  { key: 'path', label: 'Path' },
  { key: 'status', label: 'Status' },
  { key: 'duration', label: 'Duration' },
  { key: 'attempt', label: 'Attempt' },
];

// D-17: the empty state states the privacy fact rather than reporting an absence. All three
// claims must survive here — nothing left this browser, decoding happens locally, and a
// decoder that does reach out lists every request with credentials redacted — this is product
// copy, not a placeholder waiting for Phase 5.
function renderLogEmpty(): HTMLElement {
  const p = document.createElement('p');
  p.className = 'decode-empty-message';
  p.textContent =
    'Nothing has left this browser. Every decoder here runs entirely on your device — decoding ' +
    'happens locally, with no request sent anywhere. If a decoder ever does reach out, every ' +
    'request it makes will be listed here, with any credentials redacted.';
  return p;
}

function renderLogTable(entries: LogEntry[]): HTMLElement {
  const table = document.createElement('table');
  table.className = 'decode-log-table';

  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (const col of LOG_COLUMNS) {
    const th = document.createElement('th');
    th.textContent = col.label;
    headRow.append(th);
  }
  thead.append(headRow);
  table.append(thead);

  const tbody = document.createElement('tbody');
  for (const entry of entries) {
    const tr = document.createElement('tr');
    for (const col of LOG_COLUMNS) {
      const td = document.createElement('td');
      td.textContent = String(entry[col.key]);
      tr.append(td);
    }
    tbody.append(tr);
  }
  table.append(tbody);

  return table;
}

function renderLog(entries: LogEntry[]): HTMLElement {
  return entries.length === 0 ? renderLogEmpty() : renderLogTable(entries);
}

// ── Auto-detect (D-22, D-23, D-24) ───────────────────────────────────────────────────────

function applyAutoResolution(badge: HTMLElement | null, registry: DecoderRegistry, resolution: AutoDetectResolution) {
  if (!badge) return;
  if (resolution.decoderId) {
    const decoder = registry.get(resolution.decoderId);
    badge.textContent = `Auto-detected: ${decoder ? decoder.label : resolution.decoderId}`;
  } else {
    badge.textContent = resolution.reason;
  }
}

// ── Share links (D-19, D-20, D-21, DEC-03, DEC-06, DEC-07) ─────────────────────────────────

// Bumped by every init() and by its own returned cleanup — the exact shape
// src/wallet-identity.ts's own generation counter uses (lines 118-132, 172-186), reused rather
// than a second mechanism. A mount-time decompress (D-04/T-3-24) is asynchronous and the
// framework dispatches dx:mount synchronously without awaiting async listeners, so a route
// change during inflation could otherwise land a late DOM write in a container the router has
// already handed to another dapp. Checked immediately before every DOM commit on that path;
// never checked, the write is dropped rather than applied.
let mountGeneration = 0;

function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

// Same guarded write, same confirmation mechanism (confirmCopy's per-element Map) as the tree's
// own copy-on-click — the button itself stands in for the "row" confirmCopy/revealCopyFallback
// operate on, since neither function actually depends on anything tree-specific.
async function shareViaClipboard(url: string, button: HTMLButtonElement): Promise<void> {
  const wrote = await writeClipboard(url);
  if (!wrote) {
    revealCopyFallback(button, url);
    return;
  }
  confirmCopy(button);
}

// WR-03: the fallback for a host `dx` that exposes no getManifests() (core.findOwnRoute(dx)
// then returns null) — the current hash IS this dapp's own route right now, since DxKit already
// resolved and mounted it there. Reading it back is runtime data, not the literal WR-03 removes
// from buildShareUrl; a route-with-query hash (a share link that carried its own `?decoder=…`)
// is trimmed to the bare route the same way buildShareUrl composes one.
function routeFromLocationHash(): string {
  const hash = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : window.location.hash;
  return hash.split('?')[0].replace(/\/+$/, '');
}

// ── Mount ────────────────────────────────────────────────────────────────────────────────

function init(container: HTMLElement, dx: unknown, query?: DecodeQueryParams): DxDecodeUiHandle {
  // T-3-24: this mount's own generation, checked before every DOM commit on the async
  // mount-time-inflate path below — an abandoned mount's late write is dropped, never applied.
  const gen = ++mountGeneration;

  const registry = window.DxDecode?.registry;
  const core = window.DxDecode?.core;

  // D-05's guard: a script that fails to load vanishes silently, so an empty registry is a
  // real state to render for, not an assumed-populated selector.
  if (!registry || !core || registry.size() === 0) {
    const message = document.createElement('p');
    message.className = 'decode-empty-message';
    message.textContent = 'No decoders loaded — the decode dapp shipped with an empty registry.';
    container.replaceChildren(message);
    // WR-05: applyQuery is a required member of the returned handle even in this empty-registry
    // branch — a no-op here, since there is nothing to apply a share link's state to.
    const emptyHandle = (() => {
      container.replaceChildren();
    }) as DxDecodeUiHandle;
    emptyHandle.applyQuery = () => {};
    return emptyHandle;
  }

  // WR-03: resolved once per mount, from the host shell's own manifest list — never the literal
  // buildShareUrl used to carry.
  const ownRoute = core.findOwnRoute(dx) ?? routeFromLocationHash();

  const selector = container.querySelector<HTMLSelectElement>('#decode-selector');
  const textarea = container.querySelector<HTMLTextAreaElement>('#decode-textarea');
  const runBtn = container.querySelector<HTMLButtonElement>('#decode-run-btn');
  const clearBtn = container.querySelector<HTMLButtonElement>('#decode-clear-btn');
  const tree = container.querySelector<HTMLElement>('#decode-tree');
  const raw = container.querySelector<HTMLElement>('#decode-raw');
  const badge = container.querySelector<HTMLElement>('#decode-auto-badge');
  const logContainer = container.querySelector<HTMLElement>('#decode-log');
  const logClearBtn = container.querySelector<HTMLButtonElement>('#decode-log-clear-btn');
  const shareBtn = container.querySelector<HTMLButtonElement>('#decode-share-btn');
  const shareZBtn = container.querySelector<HTMLButtonElement>('#decode-share-z-btn');
  const shareSizeEl = container.querySelector<HTMLElement>('#decode-share-size');
  const shareWarningEl = container.querySelector<HTMLElement>('#decode-share-warning');
  const tabButtons = Array.from(container.querySelectorAll<HTMLButtonElement>('#decode-tabs button'));
  const tabPanels = Array.from(container.querySelectorAll<HTMLElement>('.tab-content'));

  if (!selector || !textarea || !runBtn || !clearBtn || !tree) {
    container.replaceChildren();
    // WR-05: same no-op applyQuery as the empty-registry branch above — nothing to apply to.
    const missingDomHandle = (() => {
      container.replaceChildren();
    }) as DxDecodeUiHandle;
    missingDomHandle.applyQuery = () => {};
    return missingDomHandle;
  }

  // Trivial adapters this tracer's decoder needs nothing more than: `hex` declares no
  // settings and links to nothing. Real settings/log/links wiring (D-04's LiveLogStore is
  // already real via window.DxDecode.log; explorer links are plan 03-03/03-06's factory) is
  // out of this task's scope.
  const settings = core.createNullSettingsPort();
  const log = window.DxDecode?.log ?? { record() {}, subscribe: () => () => undefined, clear() {} };
  const links: LinkPort = { address: () => null, tx: () => null };
  const decodeService = core.createDecodeService({ registry, settings, log, links });

  const listeners: Array<() => void> = [];

  // D-22: an explicit Auto entry, first and selected by default. Sourced entirely from the
  // registry's list() — never hardcoded into template.html.
  const autoOption = document.createElement('option');
  autoOption.value = 'auto';
  autoOption.textContent = 'Auto';
  selector.append(autoOption);
  for (const decoder of registry.list()) {
    const option = document.createElement('option');
    option.value = decoder.id;
    option.textContent = decoder.label;
    selector.append(option);
  }
  selector.value = 'auto';

  function renderEmptyResult() {
    const message = document.createElement('p');
    message.className = 'decode-empty-message';
    message.textContent = 'Paste an encoded payload and press Decode (or Ctrl/Cmd+Enter) to see it rendered here.';
    tree?.replaceChildren(message);
  }

  function setActiveTab(target: string) {
    for (const b of tabButtons) b.classList.toggle('active', b.dataset.tab === target);
    for (const panel of tabPanels) panel.classList.toggle('active', panel.id === `decode-tab-${target}`);
  }

  // D-22/D-23: which decoder Auto has resolved to, held independently of the <select>'s own
  // value — the dropdown stays on "Auto" until the person picks a real decoder themselves
  // (D-22's "never silently overridden"); this is the thing a paste or a Decode-click updates.
  let resolvedAutoId: string | null = null;

  // D-04: one AbortController per Decode press, owned here and nowhere else — dapp.ts
  // deliberately creates none. Aborting the previous one before starting the next is what
  // makes an abandoned decode's result arrive already marked stale by DecodeService.
  let currentController: AbortController | null = null;

  async function runDecode() {
    currentController?.abort();
    const controller = new AbortController();
    currentController = controller;

    // Non-null assertions below: TS does not carry a const's null-narrowing across a function
    // boundary (a known limitation, not a live risk — the guard above the querySelector block
    // already returned if any of these were absent, and biome.json disables noNonNullAssertion
    // for exactly this shape).
    const input = textarea!.value;
    let decoderId = selector!.value === 'auto' ? resolvedAutoId : selector!.value;

    // D-24's third trigger: someone who typed rather than pasted still gets a resolution
    // attempt, run right here rather than on every keystroke (which would flicker the badge).
    if (selector!.value === 'auto' && decoderId === null) {
      const resolution = core!.resolve(input);
      applyAutoResolution(badge, registry!, resolution);
      decoderId = resolution.decoderId;
    }

    const result = await decodeService.decode(decoderId, input, { signal: controller.signal });
    // D-04: an abandoned decode's result never reaches the tree — branch on the typed `stale`
    // marker DecodeService sets, never on the text of an error node.
    if (result.stale) return;

    tree!.replaceChildren(renderNode(result.node));
    raw?.replaceChildren(renderRaw(result.rawBytes, result.rawView));
    // Claude's discretion (CONTEXT.md): reset to Result after each decode, so the outcome is
    // always what's on screen rather than whatever tab happened to be open beforehand.
    setActiveTab('result');
  }

  const onRunClick = () => {
    void runDecode();
  };
  runBtn.addEventListener('click', onRunClick);
  listeners.push(() => runBtn.removeEventListener('click', onRunClick));

  const onClearClick = () => {
    textarea!.value = '';
    renderEmptyResult();
  };
  clearBtn.addEventListener('click', onClearClick);
  listeners.push(() => clearBtn.removeEventListener('click', onClearClick));

  // DEC-11: Ctrl+Enter and Cmd+Enter run the decode; plain Enter still inserts a newline
  // because nothing here calls preventDefault() on that path. Scoped to the textarea, not the
  // document, so it never fires from elsewhere on the page.
  const onKeydown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void runDecode();
    }
  };
  textarea.addEventListener('keydown', onKeydown);
  listeners.push(() => textarea.removeEventListener('keydown', onKeydown));

  // WR-04: scores the textarea's value AFTER the browser's own paste insertion, never the raw
  // clipboard fragment alone. Scoring only the fragment (this file's earlier shape) got the
  // FIRST paste into an empty field right but scored the wrong string the moment a paste landed
  // on top of existing content — appending, not replacing, is the common case. A 'paste'
  // listener fires BEFORE the browser inserts the text, so this defers one task; the 'input'
  // event the insertion also fires (below) runs synchronously first and clears resolvedAutoId,
  // so this deferred resolution — scored against the now-current value — is what actually lands
  // for the next Decode press or badge update.
  const onPaste = () => {
    if (selector!.value !== 'auto') return;
    setTimeout(() => {
      const resolution = core!.resolve(textarea!.value);
      resolvedAutoId = resolution.decoderId;
      applyAutoResolution(badge, registry!, resolution);
    }, 0);
  };
  textarea.addEventListener('paste', onPaste);
  listeners.push(() => textarea.removeEventListener('paste', onPaste));

  // D-22: once a real decoder is chosen, nothing switches it back but choosing Auto again.
  // Clearing the badge and the resolved id on every change (whichever direction) means a
  // stale detection never lingers over a choice the person just made.
  const onSelectorChange = () => {
    resolvedAutoId = null;
    if (badge) badge.textContent = '';
  };
  selector.addEventListener('change', onSelectorChange);
  listeners.push(() => selector.removeEventListener('change', onSelectorChange));

  // ── Share links (D-19, D-20, D-21, DEC-06, DEC-07) ─────────────────────────────────────

  function updateShareSize() {
    if (!shareSizeEl) return;
    const bytes = new TextEncoder().encode(textarea!.value).length;
    shareSizeEl.textContent = formatByteSize(bytes);
    const overThreshold = bytes > core!.SHARE_SIZE_WARNING_BYTES;
    if (shareWarningEl) shareWarningEl.hidden = !overThreshold;
    // D-20: the compressed action is a second control surfaced by the size warning, never
    // offered on its own, and never when the platform cannot create one (D-21).
    if (shareZBtn) shareZBtn.hidden = !(overThreshold && core!.supportsCompression());
  }

  // WR-04: any edit while Auto is selected invalidates the paste-time (or Decode-time) answer —
  // select-all-and-retype, or a second paste appended to existing content, must not silently run
  // against a resolution scored for a different string. runDecode's existing "resolve when null"
  // branch (D-24's third trigger) is what re-resolves on the next Decode press; the deferred
  // paste resolution above (a macrotask) runs after this synchronous handler when the two fire
  // together, so it is what actually lands for the badge.
  const onTextareaInput = () => {
    if (selector!.value === 'auto') resolvedAutoId = null;
    updateShareSize();
  };
  textarea.addEventListener('input', onTextareaInput);
  listeners.push(() => textarea.removeEventListener('input', onTextareaInput));

  function currentDecoderId(): string | null {
    return selector!.value === 'auto' ? resolvedAutoId : selector!.value;
  }

  // D-19: the write happens ONLY on a press of one of the two presses named below — never on a
  // keystroke, a paste, or a decode. The sole owner of the plain-link press: both the in-panel
  // #decode-share-btn (below) and the header button's registered builder (immediately after)
  // reach it, and nothing else does.
  function pressPlainShare(): string {
    const url = core!.buildShareUrl(ownRoute, currentDecoderId(), textarea!.value, false);
    history.replaceState(null, '', url);
    return url;
  }

  const onShareClick = () => {
    void (async () => {
      const url = pressPlainShare();
      await shareViaClipboard(url, shareBtn!);
    })();
  };
  if (shareBtn) {
    shareBtn.addEventListener('click', onShareClick);
    listeners.push(() => shareBtn.removeEventListener('click', onShareClick));
  }

  // WR-06: compressForShare constructs `new CompressionStream('deflate-raw')` — on a browser
  // where supportsCompression() passed (the constructor exists) but the 'deflate-raw' FORMAT
  // does not (Chrome 80-102, Safari 16.4), that constructor throws and this async IIFE's
  // rejection previously reached nobody: the button did nothing visible. Caught here and
  // reported the same way a decode failure is — a readable error node, never a silent no-op.
  const onShareZClick = () => {
    void (async () => {
      try {
        const compressed = await core!.compressForShare(textarea!.value);
        const url = core!.buildShareUrl(ownRoute, currentDecoderId(), compressed, true);
        history.replaceState(null, '', url);
        await shareViaClipboard(url, shareZBtn!);
      } catch (err) {
        tree!.replaceChildren(renderNode({ label: 'share', error: err instanceof Error ? err.message : String(err) }));
      }
    })();
  };
  if (shareZBtn) {
    shareZBtn.addEventListener('click', onShareZClick);
    listeners.push(() => shareZBtn.removeEventListener('click', onShareZClick));
  }

  // Content-mode tab switching over the three real buttons/panels template.html ships.
  for (const btn of tabButtons) {
    const onTabClick = () => setActiveTab(btn.dataset.tab ?? 'result');
    btn.addEventListener('click', onTabClick);
    listeners.push(() => btn.removeEventListener('click', onTabClick));
  }

  // D-18: the log is a global ring buffer, emptied only by Clear — subscribe delivers the
  // current entries immediately (so a remount shows history rather than a false-empty tab) and
  // again on every record/clear, so the tab updates live without a further decode.
  let unsubscribeLog: (() => void) | null = null;
  if (logContainer) {
    unsubscribeLog = log.subscribe((entries) => {
      logContainer.replaceChildren(renderLog(entries));
    });
  }
  if (logClearBtn) {
    const onLogClear = () => log.clear();
    logClearBtn.addEventListener('click', onLogClear);
    listeners.push(() => logClearBtn.removeEventListener('click', onLogClear));
  }

  renderEmptyResult();
  raw?.replaceChildren(renderRawEmpty());
  updateShareSize();

  // D-24/DEC-03: applies a share link's state once, at mount — never on a later keystroke or
  // tab switch, and never itself running a decode (DEC-05): starting one unasked would mean
  // opening someone else's link could kick off work its recipient never chose.
  function applyLoadedInput(input: string, decoderId: string | undefined) {
    textarea!.value = input;
    if (decoderId && registry!.get(decoderId)) {
      selector!.value = decoderId;
      resolvedAutoId = null;
      if (badge) badge.textContent = '';
    } else {
      selector!.value = 'auto';
      const resolution = core!.resolve(input);
      resolvedAutoId = resolution.decoderId;
      applyAutoResolution(badge, registry!, resolution);
    }
    updateShareSize();
  }

  // WR-05: DxKit does not remount a dapp when the route changes WITHIN itself — the vendored
  // shell's own mountDapp() emits dx:route:subpath instead (src/vendor/dxkit/index.global.js),
  // never dx:mount, when lifecycle.getCurrentDapp() already equals this dapp's id. A share link
  // followed while already on #/tools/decode (typed into the address bar, or clicked from the
  // page) is exactly that case, and DEC-03's "arriving pre-loaded from a link" was silently
  // failing for it. applyQuery is now a named function, called once at mount (below) and again
  // by dapp.ts's own dx:route:subpath listener — reusing this running instance rather than
  // tearing down and rebuilding it (the listeners, the log subscription and any in-flight decode
  // survive a link load exactly as they do a keystroke). `applyGeneration` guards the SAME race
  // T-3-24's `gen`/`mountGeneration` check guards for the mount case: two applyQuery calls in
  // quick succession (two subpath events before the first's decompress resolves) must let only
  // the LATEST one's result land.
  let applyGeneration = 0;

  // D-21: the compressed parameter wins when both are present — it is the deliberate form,
  // fixed here in the consumer rather than left to whichever parameter happened to be read first.
  // Non-null assertions on `q` throughout: TS does not carry the outer `if`'s narrowing across
  // the nested `.then` closure below (the same known limitation noted elsewhere in this file),
  // and the guard above already returned if this mount's DOM refs were absent.
  function applyQuery(q: DecodeQueryParams | undefined) {
    const myApply = ++applyGeneration;
    if (q?.z) {
      core!.decompressFromShare(q.z).then((result) => {
        // T-3-24: a route change during inflation must not write into a container the router
        // has already reassigned to another dapp — dropped rather than applied once superseded.
        // myApply !== applyGeneration: a second applyQuery call (another subpath event) landed
        // before this one's decompress resolved — this, the now-stale one, is dropped instead.
        if (gen !== mountGeneration || myApply !== applyGeneration) return;
        if (!result.ok) {
          tree?.replaceChildren(renderNode({ label: 'decode', error: result.error, raw: q!.z }));
          textarea!.value = q!.z as string;
          updateShareSize();
          return;
        }
        applyLoadedInput(result.value, q!.decoder);
      });
    } else if (q?.data !== undefined) {
      applyLoadedInput(q!.data as string, q!.decoder);
    }
  }

  applyQuery(query);

  function cleanup() {
    mountGeneration++; // orphans any pending decompressFromShare from this mount
    for (const off of listeners) off();
    listeners.length = 0;
    unsubscribeLog?.();
    currentController?.abort();
    clearAllCopyTimers();
    container.replaceChildren();
  }
  // WR-05: applyQuery is attached to the returned cleanup function itself (a function is an
  // object; this costs nothing new to the contract's call sites, which keep calling the handle
  // as a bare `() => void`) rather than widening init()'s return to a plain object — dapp.ts's
  // existing `decodeCleanup: (() => void) | null` shape barely changes, per types.d.ts's
  // DxDecodeUiHandle.
  const handle = cleanup as DxDecodeUiHandle;
  handle.applyQuery = applyQuery;
  // SHARE-04: a generic, host-integration seam — decode names nothing about who calls these,
  // preserving DEC-14's portability posture (no org-prefixed identifier anywhere in this
  // directory). A host shell that wants its OWN header control to carry decode's plain share
  // link (this dotdev shell's src/main.ts does, via window.DxDecode.activeUi set by dapp.ts)
  // reaches through this handle rather than reimplementing D-19's decoder/textarea resolution
  // externally, which would risk drifting from the in-panel button's own behaviour.
  // pressPlainShare is the SAME function #decode-share-btn calls above — one owner, two callers.
  handle.pressPlainShare = pressPlainShare;
  handle.revealShareFailure = (url: string) => revealCopyFallback(textarea!, url);
  return handle;
}

// types.d.ts's DxDecodeUiModule declares only init() — the driving adapter's public contract.
// The pure render functions below exist purely so test/decode-ui.test.ts can drive the renderer
// with hand-built DecodeNode literals directly, rather than only ever through a full mount + a
// real decode. WR-02: exposed via types.d.ts's DxDecodeUiTestHooks, a SEPARATE interface from
// DxDecodeUiModule (kept minimal) — this intersection type is used only at this one assignment
// site, not declared here, so there is nothing left for a second file to declaration-merge with.
const uiModule: DxDecodeUiModule & DxDecodeUiTestHooks = {
  init,
  renderNode,
  displayDispatchKeys: () => Object.keys(DISPLAY_DISPATCH),
  renderRaw,
  rawViewDispatchKeys: () => Object.keys(RAW_VIEW_DISPATCH),
  renderLog,
};

window.DxDecode.ui = uiModule;
