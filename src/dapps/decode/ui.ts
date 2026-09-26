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
type LinkKind = NonNullable<DecodeNode['linkKind']>;

// The declared display union, restated here only as a Record's key set — TypeScript already
// fails this file to compile if an entry is missing or an extra one is added, and the
// exhaustiveness test compares this table's runtime key set against the union's seven members
// so a mode added to types.d.ts in a later phase fails here rather than silently falling
// through to the default. Five of the seven entries still render the same underlying text —
// none of THOSE decoders shorten a value for display, so display text and copy text coincide.
//
// 05-06 CORRECTION of an earlier forecast recorded here: this comment used to predict that
// ETH-10 would change what address/txhash's own functions RETURN. It turned out cheaper not
// to — the link travels on `DecodeNode.link`/`linkKind` and is drawn by `renderNode` as a
// sibling anchor beside the value button, never returned by a dispatch entry. What DID change
// for these two entries is which of the node's own two text fields they read: `value` now
// carries the decoder's SHORTENED form (`ethShortenValue`, decoders-eth-calldata.ts) while
// `raw` keeps the full one `underlyingText` — and therefore `copyValue` and
// `applyFullValueTitle` — always reads. The table's shape, its string-returning signature and
// its seven entries are exactly what they were (<renderer_completeness_decision>).
const DISPLAY_DISPATCH: Record<DisplayMode, (node: DecodeNode) => string | null> = {
  address: (node) => (typeof node.value === 'string' ? node.value : (underlyingText(node) ?? null)),
  txhash: (node) => (typeof node.value === 'string' ? node.value : (underlyingText(node) ?? null)),
  hex: (node) => underlyingText(node) ?? null,
  int: (node) => underlyingText(node) ?? null,
  // Reads `value` first for the same reason address/txhash do, but inverted: for an ABI-decoded
  // `string` argument `raw` is the hex of the utf8 bytes and `value` is the text, so
  // underlyingText's raw-wins rule would render `0x5a` where the argument says `Z`. Every other
  // node reaching this entry (base64/url/jwt/hex's own `text` nodes) writes value === raw, so
  // preferring value is a no-op for them. abi.ts's invalid-UTF-8 branch sets value to the hex
  // itself, which is why this needs no separate guard for undecodable bytes.
  text: (node) => (typeof node.value === 'string' ? node.value : (underlyingText(node) ?? null)),
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

// A value longer than this is FOLDED for display — a head-and-tail stand-in plus an expand
// control beside it. Purely presentational and deliberately decoder-agnostic: a 7 KB creation-code
// blob, a base64 image and a JWT payload all fill the panel the same way, and none of their
// decoders should have to know about it. `raw` is untouched, so click-to-copy still yields the
// whole value whether or not it is folded — the fold is what the eye sees, never what the
// clipboard gets. The head is wide enough to keep a 32-byte word (66 characters with its 0x)
// intact, so the common case of one over-long word folds to something still readable.
const VALUE_FOLD_THRESHOLD = 128;
const VALUE_FOLD_HEAD = 66;
const VALUE_FOLD_TAIL = 32;

function foldValue(text: string): string {
  return `${text.slice(0, VALUE_FOLD_HEAD)}…${text.slice(-VALUE_FOLD_TAIL)}`;
}

const PROVENANCE_LABELS: Record<ProvenanceMode, string> = {
  verified: 'Verified',
  registry: 'Registry',
  unresolved: 'Unresolved',
  local: 'Local',
};

// ETH-10: a generic, per-KIND glyph — never decoder- or field-specific wording. `link`/
// `linkKind` are the SAME two members Phase 6's proxy and transaction links will attach to
// (05-01's own note beside DecodeNode.link), and this DEC-13 sentence's own settings-route
// anchor already reuses 'route' for something that is not an explorer link at all — so the
// anchor's own visible text must not assume "this is an explorer" or "this is settings".
const LINK_GLYPH: Record<LinkKind, string> = {
  external: '↗',
  route: '→',
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
// fieldSelector (NET-07, T-05-30): which fallback field this reveal targets. Defaults to the
// Result panel's own field so every pre-existing caller (tree copy-on-click, share links) is
// unchanged; the Log tab's two Copy buttons pass '#decode-log-copy-reveal' instead, since
// #decode-copy-reveal sits inside #decode-tab-result — reusing it would put the payload in a
// panel the person copying isn't looking at, which reads as "nothing happened" rather than as
// a failure.
function revealCopyFallback(row: HTMLElement, text: string, fieldSelector = '#decode-copy-reveal') {
  const field = row.closest('.layout-tool')?.querySelector<HTMLInputElement>(fieldSelector);
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
// Task 2 (06-06): `index`, when supplied, is populated with this node's own ROW element as it
// is built and threaded into every recursive call — a plain Map keyed on the node object itself,
// since node identity is the only handle available (the render contract deliberately has no id
// or path member, and the decoder mutates the very objects this function draws). Optional so the
// signature stays compatible with the frozen single-argument DxDecodeUiTestHooks.renderNode hook
// — every existing test-hook call site keeps working with no changes.
function renderNode(node: DecodeNode, index?: Map<DecodeNode, HTMLElement>): HTMLElement {
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
      childrenEl.append(renderNode(child, index));
    }
  }

  const row = document.createElement('div');
  row.className = 'decode-tree-row';
  index?.set(node, row);

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
  const displayText = formatDisplayValue(node) ?? '';
  const folded = displayText.length > VALUE_FOLD_THRESHOLD;
  valueBtn.textContent = folded ? foldValue(displayText) : displayText;
  valueBtn.addEventListener('click', () => {
    void copyValue(node, row);
  });
  row.append(valueBtn);

  if (folded) {
    // The row is a wrapping flex container and a folded value still wraps over several lines, so
    // without this the control is pushed onto a flex line of its own BELOW the value. The class
    // lets the value claim the remaining width and shrink (min-width: 0) instead of forcing the
    // wrap, which is what keeps the control beside it and top-aligned. Applied only when folded —
    // a short value must not grow, or the link and provenance badge after it get pushed to the
    // far edge of every row in the tree.
    valueBtn.classList.add('decode-tree-value-foldable');
    // A SECOND disclosure, deliberately separate from the children one at the head of the row:
    // that control answers "what is inside this node", this one answers "what does this node's
    // own value say in full", and collapsing either must not collapse the other. Sits after the
    // value button for the same reason the link anchor does — a control nested inside a button
    // is invalid HTML with undefined activation behaviour.
    const expand = document.createElement('button');
    expand.type = 'button';
    expand.className = 'decode-tree-expand';
    expand.setAttribute('aria-expanded', 'false');
    expand.textContent = 'more';
    // The count is the useful fact a folded value hides — how much was elided, not what it says.
    expand.title = `${displayText.length} characters`;
    expand.addEventListener('click', () => {
      // Named `expanded`, not `open`: the portability guard's network-identifier scan treats a
      // bare `open` as window.open, and a local binding is not worth an allowlist entry.
      const expanded = expand.getAttribute('aria-expanded') === 'true';
      const next = !expanded;
      expand.setAttribute('aria-expanded', String(next));
      expand.textContent = next ? 'less' : 'more';
      valueBtn.textContent = next ? displayText : foldValue(displayText);
    });
    row.append(expand);
  } else {
    // ETH-10/ETH-11: exposes the full value on hover whenever the displayed text is a shortened
    // stand-in for it — a no-op for every node whose display already equals its underlying text
    // (applyFullValueTitle's own equality check), so this call is safe to make unconditionally.
    // Skipped for a folded value on purpose: a title carrying thousands of characters is a worse
    // affordance than the expand control that replaces it, not a redundant one.
    applyFullValueTitle(valueBtn, node);
  }

  // 05-06 (D-30, ETH-10): the link travels on the node — `link`/`linkKind` are the whole data
  // path (05-01 Task 0) — and is drawn here as a SIBLING following the value button, never a
  // descendant of it: an anchor nested inside a <button> is invalid HTML with undefined
  // activation behaviour (handoff §6 calls the transaction link "secondary" for the same
  // reason). A node whose `link` member is absent (unknown chain, no settings dapp) renders no
  // anchor at all — never one with no target.
  if (node.link) {
    const kind = node.linkKind ?? 'external';
    const anchor = uiCreateExternalLink(node.link, LINK_GLYPH[kind], kind);
    anchor.className = 'decode-tree-link';
    // Scoped to address/txhash: those are the two modes whose display text is a SHORTENED
    // stand-in for `raw` (see DISPLAY_DISPATCH above), so the anchor's own glyph is exactly as
    // much a stand-in as the value button's shortened text is — hovering either should reveal
    // the same full value. A non-shortened node's link (the DEC-13 settings-route sentence) has
    // nothing to reveal here: its `raw` is the decode's own payload, not the sentence's text.
    if (node.display === 'address' || node.display === 'txhash') {
      applyFullValueTitle(anchor, node);
    }
    row.append(anchor);
  }

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

// TXT-05's second Raw renderer — modelled on renderHexDump immediately above, one word (or the
// leading selector, or a leftover partial word) per row. Decides from the byte length alone
// whether the payload leads with a four-byte selector, using the SAME predicate the decoder
// that selects this view uses for the identical decision — see that file's matching comment.
// The >= 36 floor is load-bearing and is the fix for a real defect: with a lower floor, a
// manually-selected 4-byte paste rendered a selector node in the Result tab and a partial-word
// row here, two views of the same bytes disagreeing about what they are. WORD_LEN/SELECTOR_LEN
// are declared inside this function, not at module top level — a registered decoder file
// already owns identical top-level names in this same compiled program (tsconfig.decode.json),
// and this directory has no imports to share a single declaration through.
//
// This renderer emits no annotations: the shape hypotheses live in the decoder that produced
// the bytes and appear in the Result tree, never here. Every cell is written with textContent,
// never markup, matching this file's own header rule — and unlike renderHexDump, this table has
// no third, ASCII cell, so bytes spelling markup appear here as hex digits and nothing else.
function renderWordTable(bytes: Uint8Array): HTMLElement {
  const WORD_LEN = 32;
  const SELECTOR_LEN = 4;
  const hasSelector = bytes.length >= SELECTOR_LEN + WORD_LEN && (bytes.length - SELECTOR_LEN) % WORD_LEN === 0;

  const table = document.createElement('table');
  table.className = 'decode-wordtable';
  const tbody = document.createElement('tbody');

  function appendRow(offset: number, rowBytes: Uint8Array) {
    const tr = document.createElement('tr');

    const offsetCell = document.createElement('td');
    offsetCell.className = 'decode-wordtable-offset';
    offsetCell.textContent = offset.toString(16).padStart(8, '0');
    tr.append(offsetCell);

    const wordCell = document.createElement('td');
    wordCell.className = 'decode-wordtable-word';
    wordCell.textContent = Array.from(rowBytes, (b) => b.toString(16).padStart(2, '0')).join('');
    tr.append(wordCell);

    tbody.append(tr);
  }

  const argStart = hasSelector ? SELECTOR_LEN : 0;
  if (hasSelector) {
    appendRow(0, bytes.slice(0, SELECTOR_LEN));
  }

  let offset = argStart;
  while (offset + WORD_LEN <= bytes.length) {
    appendRow(offset, bytes.slice(offset, offset + WORD_LEN));
    offset += WORD_LEN;
  }
  if (offset < bytes.length) {
    // A partial trailing word — reported as its own row rather than dropped.
    appendRow(offset, bytes.slice(offset));
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
// Two entries exist as of Phase 4 — an unrecognised rawView still falls back to the first,
// which is what makes adding a renderer here a registration rather than a rewrite. A key in
// this table must never equal a registered decoder's own id — the existing 'hex-dump' / 'hex'
// pair is the worked example: the two are deliberately different strings.
const RAW_VIEW_DISPATCH: Record<string, (bytes: Uint8Array) => HTMLElement> = {
  'hex-dump': renderHexDump,
  'word-table': renderWordTable,
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

// NET-06: expansion state, keyed on entry OBJECT IDENTITY — never a composite of its fields.
// createLiveLogStore (core.ts:65-89) never copies an entry: record() rebuilds the array around
// the SAME objects and subscribe() hands that array straight to every subscriber, so identity
// is stable across the buffer's whole life, which is exactly what a WeakSet needs. A composite
// key of timestamp+attempt+url is NOT collision-proof: two concurrent identical requests
// recorded in the same millisecond agree on all three and would expand together. renderLogTable
// rebuilds its DOM wholesale on every notification; without this set, a row the user had open
// mid-decode would silently collapse the instant the next entry landed. Needs no cleanup on
// Clear — dropping the entries array drops the only references (WeakSet has no clear() method
// to call even if one wanted to).
const LOG_EXPANDED = new WeakSet<LogEntry>();

// Claude's discretion (CONTEXT.md) — 2 KB keeps one large response from pushing the whole
// table off screen while still showing enough to be useful. Named so the byte-count label
// below and this suite's own tests read the same value rather than each restating it.
const LOG_BODY_PREVIEW_BYTES = 2048;

function truncateLogBody(body: string): string {
  const byteLength = new TextEncoder().encode(body).length;
  if (byteLength <= LOG_BODY_PREVIEW_BYTES) return body;
  return `${body.slice(0, LOG_BODY_PREVIEW_BYTES)}… (${byteLength} bytes total, truncated)`;
}

// NET-06: the full request and response for one entry — one row per PRESENT field, never an
// empty row and never the stringified form of a missing value. Every value here is already the
// redacted form the transport recorded at record time (D-24); this function never re-derives
// anything from a live request object.
function renderLogDetail(entry: LogEntry): HTMLElement {
  const el = document.createElement('div');
  el.className = 'decode-log-detail';

  function addField(label: string, value: string) {
    const field = document.createElement('div');
    field.className = 'decode-log-detail-field';
    const labelEl = document.createElement('span');
    labelEl.className = 'decode-log-detail-label';
    labelEl.textContent = label;
    const valueEl = document.createElement('span');
    valueEl.className = 'decode-log-detail-value';
    valueEl.textContent = value;
    field.append(labelEl, valueEl);
    el.append(field);
  }

  if (entry.url !== undefined) addField('URL', entry.url);
  if (entry.query && Object.keys(entry.query).length > 0) {
    addField(
      'Query',
      Object.entries(entry.query)
        .map(([k, v]) => `${k}=${v}`)
        .join('&'),
    );
  }
  if (entry.requestHeaders) {
    for (const [name, value] of Object.entries(entry.requestHeaders)) {
      addField(`Header: ${name}`, value);
    }
  }
  if (entry.requestBody !== undefined) addField('Request body', truncateLogBody(entry.requestBody));
  if (entry.responseBody !== undefined) addField('Response body', truncateLogBody(entry.responseBody));
  if (entry.error !== undefined) addField('Error', entry.error);

  return el;
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
  let detailIdCounter = 0;
  for (const entry of entries) {
    detailIdCounter += 1;
    const detailId = `decode-log-detail-${detailIdCounter}`;
    const expanded = LOG_EXPANDED.has(entry);

    // NET-06: a summary row plus a sibling detail row, the detail hidden until pressed —
    // following renderNode's own disclosure pattern (aria-expanded/aria-controls, the same
    // toggle glyphs) so both disclosure affordances in this dapp behave identically. The
    // disclosure cell has no matching <th> — LOG_COLUMNS/the header row are unchanged so the
    // pre-existing column-label assertion stays green; this is one extra body cell, not a
    // ninth labelled column.
    const summaryRow = document.createElement('tr');
    summaryRow.className = 'decode-log-summary-row';

    const disclosureCell = document.createElement('td');
    const disclosure = document.createElement('button');
    disclosure.type = 'button';
    disclosure.className = 'decode-log-disclosure';
    disclosure.setAttribute('aria-expanded', String(expanded));
    disclosure.setAttribute('aria-controls', detailId);
    disclosure.textContent = expanded ? '▾' : '▸';
    disclosureCell.append(disclosure);
    summaryRow.append(disclosureCell);

    for (const col of LOG_COLUMNS) {
      const td = document.createElement('td');
      td.textContent = String(entry[col.key]);
      summaryRow.append(td);
    }
    tbody.append(summaryRow);

    const detailRow = document.createElement('tr');
    detailRow.className = 'decode-log-detail-row';
    detailRow.id = detailId;
    detailRow.hidden = !expanded;
    const detailCell = document.createElement('td');
    detailCell.colSpan = LOG_COLUMNS.length + 1;
    detailCell.append(renderLogDetail(entry));
    detailRow.append(detailCell);
    tbody.append(detailRow);

    disclosure.addEventListener('click', () => {
      const next = disclosure.getAttribute('aria-expanded') !== 'true';
      disclosure.setAttribute('aria-expanded', String(next));
      disclosure.textContent = next ? '▾' : '▸';
      detailRow.hidden = !next;
      if (next) LOG_EXPANDED.add(entry);
      else LOG_EXPANDED.delete(entry);
    });
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

  // D-07/D-30: real settings and explorer-link wiring, replacing the tracer's trivial
  // adapters — same variable names, same downstream wiring into createDecodeService.
  const settings = createShellSettingsPort(dx);
  const log = window.DxDecode?.log ?? { record() {}, subscribe: () => () => undefined, clear() {} };
  const links: LinkPort = createLiveExplorerLinks(settings);
  // 05-05 Task 3: the transport, the two registry adapters and the resolver, all real in the
  // shipped app — this is what makes a REGISTRY badge and a Log tab entry reachable from a
  // decode rather than only from a test double. `target` is deliberately NOT supplied: a
  // pasted calldata blob has no target address of its own. The verified rung (`abis`, 06-03) is
  // nonetheless reachable in production for every NESTED call, because Plan 06-02's sibling rule
  // supplies those targets from inside the payload itself — and, since Plan 06-05, for the
  // OUTER call too, once a transaction hash's own recipient supplies a top-level target the
  // decoder resolves internally (`txSource`, wired below).
  const { transport, signatures, abis, txSource, settingsRoute } = createDecodeAdapters(dx, settings, log);
  const decodeService = core.createDecodeService({
    registry,
    settings,
    log,
    links,
    transport,
    signatures,
    abis,
    txSource,
    settingsRoute,
  });

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
  // Task 2 (06-06): ETH-12's per-node update-channel bookkeeping for the CURRENT tree — the row
  // index (node -> row element) and the stored unsubscribe for the current decode's channel, if
  // it carries one. Both are torn down together with the controller by endActiveRun, below,
  // never hand-copied across the three call sites that need it.
  let rowIndex: Map<DecodeNode, HTMLElement> | null = null;
  let unsubscribeUpdates: (() => void) | null = null;

  // The one place that ends whatever run is currently active — aborts the controller,
  // unsubscribes the update channel, and discards the row index. Called at the top of every new
  // runDecode (a second Decode press must detach the first run's channel, exactly as it already
  // detached the first run's abort controller), by the Clear handler (Clear now ends the run as
  // completely as pressing Decode does — see onClearClick, below), and by the mount's own
  // cleanup. Three hand-copied call sites is how the third one drifts, which is why this exists
  // as one named function rather than three.
  function endActiveRun(): void {
    currentController?.abort();
    unsubscribeUpdates?.();
    unsubscribeUpdates = null;
    rowIndex = null;
  }

  async function runDecode() {
    endActiveRun();
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

    // Task 2: a fresh index for this render, passed into the single existing renderNode(...)
    // call below regardless of whether this result carries an update channel — building it
    // unconditionally keeps this the one call site renderNode is ever invoked from for a real
    // decode result.
    rowIndex = new Map<DecodeNode, HTMLElement>();
    tree!.replaceChildren(renderNode(result.node, rowIndex));
    raw?.replaceChildren(renderRaw(result.rawBytes, result.rawView));
    // Claude's discretion (CONTEXT.md): reset to Result after each decode, so the outcome is
    // always what's on screen rather than whatever tab happened to be open beforehand.
    setActiveTab('result');

    if (result.onNodeUpdate) {
      // Subscribes in the SAME turn the result was handed to the renderer — the property
      // types.d.ts's own onNodeUpdate comment relies on ("every node whose name arrives after
      // subscription is notified exactly once"). Appends ONE annotation span to the existing
      // row; never rebuilds the row, never touches the children element, never calls the tree
      // renderer again — collapse state lives only in the DOM (the disclosure handler above
      // writes nothing back to the node), so any second render of a subtree here would discard
      // whatever the reader expanded, on the deepest branches, which is exactly where a
      // nested-calldata reader has been drilling. Reads `rowIndex` (never the closed-over local)
      // so endActiveRun's own discard has a real effect, not only a symbolic one: a miss — a
      // node no longer in the current tree, OR a row index endActiveRun already nulled — is a
      // silent no-op either way.
      unsubscribeUpdates = result.onNodeUpdate((node, annotation) => {
        const row = rowIndex?.get(node);
        if (!row) return;
        const ann = document.createElement('span');
        ann.className = 'decode-tree-annotation';
        ann.textContent = annotation;
        row.append(ann);
      });
    }
  }

  const onRunClick = () => {
    void runDecode();
  };
  runBtn.addEventListener('click', onRunClick);
  listeners.push(() => runBtn.removeEventListener('click', onRunClick));

  // Clear ends the active run as completely as pressing Decode does (06-06 Task 2) — previously
  // it neither aborted `currentController` nor had any channel to unsubscribe, so an in-flight
  // lookup kept running and a name resolving after Clear would have patched a row index whose
  // elements are no longer in the document. Pressing Clear is a stronger signal than pressing
  // Decode again ("I am finished with this result"), so it gets the same treatment through the
  // same helper.
  const onClearClick = () => {
    endActiveRun();
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

  // D-19/G-06-7: the write happens ONLY on a press of pressPlainShare — never on a keystroke, a
  // paste, or a decode. The in-panel button that used to call this directly is gone (G-06-7
  // removed it as a duplicate of the shell header's own share control); the header's registered
  // builder (handle.pressPlainShare, below) is now the sole caller.
  function pressPlainShare(): string {
    const url = core!.buildShareUrl(ownRoute, currentDecoderId(), textarea!.value, false);
    // The address-bar update is best-effort; the RETURNED url is the contract. Chromium throws a
    // SecurityError from replaceState at its own URL-length cap (a payload of a few hundred KB
    // reaches it), and letting that escape put the caller's catch in charge of what got copied —
    // src/share-target.ts falls back to window.location.href there, so the person was handed a
    // payload-less link and a green confirmation. Swallowed deliberately and narrowly: the payload
    // is already in the clipboard-bound string, the size readout and the over-length warning beside
    // the textarea are what tell the person a plain link this big is not a usable one, and the
    // compressed action the warning surfaces is the answer.
    try {
      history.replaceState(null, '', url);
    } catch {
      /* URL too long for this browser's history entry — the link itself is still returned */
    }
    return url;
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
  // NET-07: the two Copy buttons below read this snapshot rather than re-subscribing
  // themselves — one subscription, one source of truth for "what's currently in the log".
  let currentLogEntries: LogEntry[] = [];
  let unsubscribeLog: (() => void) | null = null;
  if (logContainer) {
    unsubscribeLog = log.subscribe((entries) => {
      currentLogEntries = entries;
      logContainer.replaceChildren(renderLog(entries));
    });
  }
  if (logClearBtn) {
    const onLogClear = () => log.clear();
    logClearBtn.addEventListener('click', onLogClear);
    listeners.push(() => logClearBtn.removeEventListener('click', onLogClear));
  }

  // NET-07: both Copy buttons read the already-redacted, currently-buffered LogEntry objects
  // and nothing else — the whole of NET-07's correctness (D-24). A clipboard failure reveals
  // the payload in THIS panel's own fallback field, never the Result panel's
  // #decode-copy-reveal (T-05-30) — passed as revealCopyFallback's fieldSelector argument.
  const logCopyJsonBtn = container.querySelector<HTMLButtonElement>('#decode-log-copy-json-btn');
  const logCopyCurlBtn = container.querySelector<HTMLButtonElement>('#decode-log-copy-curl-btn');

  async function copyLogPayload(text: string, button: HTMLButtonElement): Promise<void> {
    const wrote = await writeClipboard(text);
    if (!wrote) {
      revealCopyFallback(button, text, '#decode-log-copy-reveal');
      return;
    }
    confirmCopy(button);
  }

  if (logCopyJsonBtn) {
    const onLogCopyJson = () => {
      void copyLogPayload(logEntriesToJson(currentLogEntries), logCopyJsonBtn);
    };
    logCopyJsonBtn.addEventListener('click', onLogCopyJson);
    listeners.push(() => logCopyJsonBtn.removeEventListener('click', onLogCopyJson));
  }
  if (logCopyCurlBtn) {
    const onLogCopyCurl = () => {
      void copyLogPayload(currentLogEntries.map(logEntryToCurl).join('\n'), logCopyCurlBtn);
    };
    logCopyCurlBtn.addEventListener('click', onLogCopyCurl);
    listeners.push(() => logCopyCurlBtn.removeEventListener('click', onLogCopyCurl));
  }

  renderEmptyResult();
  raw?.replaceChildren(renderRawEmpty());
  updateShareSize();

  // D-24/DEC-03: applies a share link's state once, at mount — never on a later keystroke or tab
  // switch, and — on its own — never running a decode: loading a payload is not the same act as
  // deciding to run it. DEC-05 (amended by G-06-6/06-10): nothing requiring network runs until
  // the user clicks Decode, UNLESS the recipient has themselves enabled auto-running shared links
  // in Settings (default off). That decision is applyQuery's, immediately below, never this
  // function's — this function only ever loads; whether a decode follows depends on the link's
  // own submit request AND the recipient's own prior opt-in, checked together over there.
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

  // G-06-6/06-10 (DEC-05 amendment): a link's submit=1 is a REQUEST, never itself consent — the
  // sender composed the link, not the recipient, and cannot be expected to read a query
  // parameter and understand what it costs. Consent is the recipient's own prior act: the
  // 'autoRunSharedLinks' setting (src/plugins/links.ts), off by default. Read fresh on every
  // applyQuery call (never cached), so a flip made in THIS tab — the settings dapp, or anything
  // else that goes through dx.settings.set — takes effect on the next link without a reload,
  // matching how every other settings read in this file behaves. It does NOT reach a flip made in
  // another tab: the settings plugin reads localStorage at init and never listens for the browser's
  // `storage` event, and this repo's own reconciliation (src/dapps/settings/sync.ts) is loaded as a
  // settings-dapp dependency, so it is not attached while decode is the mounted dapp. A tab sitting
  // on decode therefore keeps the consent it last read until it is reloaded or Settings is visited.
  // The gap is upstream and written up in tmp/dxkit-fr-settings-cross-tab-sync.md; the same limit
  // applies to every credential read in this directory, and none of them may claim otherwise.
  // Deliberately uniform across every decoder — a network-
  // capable decoder is not special-cased — because the ratified rule is "the recipient already
  // agreed to this, for every decoder", not "this one decoder gets a lesser version of consent".
  function shouldAutoRunSharedLink(q: DecodeQueryParams | undefined): boolean {
    return q?.submit === '1' && settings.get('autoRunSharedLinks') === true;
  }

  // D-21: the compressed parameter wins when both are present — it is the deliberate form,
  // fixed here in the consumer rather than left to whichever parameter happened to be read first.
  // Non-null assertions on `q` throughout: TS does not carry the outer `if`'s narrowing across
  // the nested `.then` closure below (the same known limitation noted elsewhere in this file),
  // and the guard above already returned if this mount's DOM refs were absent.
  function applyQuery(q: DecodeQueryParams | undefined) {
    const myApply = ++applyGeneration;
    const autoRun = shouldAutoRunSharedLink(q);
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
        // G-06-6: only after a successful inflation, and only inside the SAME generation guard
        // above — a superseded compressed link must not start a decode into a tree the router has
        // already handed to someone else. Goes through the exact runDecode the Decode button and
        // Ctrl/Cmd+Enter call — never a parallel path — so the abort controller, the stale-result
        // marker, the log subscription, the row index and the tab reset all behave identically.
        if (autoRun) void runDecode();
      });
    } else if (q?.data !== undefined) {
      applyLoadedInput(q!.data as string, q!.decoder);
      // G-06-6: a plain (uncompressed) link's payload is already synchronously available here, so
      // this is the affirmative-and-consented case's other half — no payload, no `data` branch
      // entered at all, which is what makes submit=1-with-no-payload a no-op rather than a decode
      // of the empty string.
      if (autoRun) void runDecode();
    }
  }

  applyQuery(query);

  function cleanup() {
    mountGeneration++; // orphans any pending decompressFromShare from this mount
    for (const off of listeners) off();
    listeners.length = 0;
    unsubscribeLog?.();
    // 06-06 Task 2: the same helper Clear and runDecode use — aborts the controller,
    // unsubscribes the update channel and discards the row index, so a late name arriving after
    // unmount touches no element.
    endActiveRun();
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
  // externally, which would risk drifting from the header button's own behaviour.
  // G-06-7: this is now the ONLY path to a plain share link — the in-panel button that used to
  // call pressPlainShare directly was removed as a duplicate of this seam. A host shell that
  // registers nothing through it offers its users no way to copy a plain link at all (the
  // compressed link, the byte readout and the over-length warning are unaffected — they stay
  // in the panel because no host seam exists for them).
  handle.pressPlainShare = pressPlainShare;
  handle.revealShareFailure = (url: string) => revealCopyFallback(textarea!, url);
  return handle;
}

// Phase 5 Task 0 declared six placeholders (05-01) as REQUIRED members of DxDecodeUiTestHooks so
// the exact-intersection assignment below stays an enforceable compile-time obligation (a hook
// declared in types.d.ts but never implemented fails tsc). All six are now real: 05-04 built
// createShellSettingsPort, renderLogDetail (above, beside renderLogTable), logEntriesToJson and
// logEntryToCurl; this plan (05-06) builds the last two, uiCreateExternalLink and
// applyFullValueTitle, closing the Known Stubs section 05-01-SUMMARY.md opened.

// D-07: bridges a decoder's bare setting key to the host's own two-argument
// dx.settings.get(sectionId, key) API by scanning dx.settings.getSections() for the section
// that declares it — never by naming a plugin's section id as a literal inside this directory,
// which is exactly the dotdev-specific coupling the DEC-14 guard exists to forbid.
// Feature-detects every step; a host with no settings plugin, a host whose getSections isn't a
// function, or a key no section declares all resolve to undefined rather than throwing,
// matching findSettingsRoute's own defensive shape in core.ts. When two sections both declare
// the same bare key, the FIRST one in getSections() order wins — deterministic, and a test
// pins it.
function createShellSettingsPort(dx: unknown): SettingsPort {
  return {
    get(key: string): unknown {
      try {
        const shell = dx as
          | {
              settings?: {
                getSections?: () => { id: string; definitions?: { key: string }[] }[];
                get?: (sectionId: string, key: string) => unknown;
              };
            }
          | null
          | undefined;
        if (!shell?.settings) return undefined;
        const { getSections, get } = shell.settings;
        if (typeof getSections !== 'function' || typeof get !== 'function') return undefined;
        const sections = getSections();
        if (!Array.isArray(sections)) return undefined;
        for (const section of sections) {
          if (section?.definitions?.some((def) => def.key === key)) {
            return get(section.id, key);
          }
        }
        return undefined;
      } catch {
        return undefined;
      }
    },
  };
}

// ETH-10/ETH-11/ETH-14: the real LinkPort createDecodeService receives (D-30). Closes over the
// SETTINGS PORT, never over a chain id — createDecodeService captures this port once in its
// closure (init(), above) and reuses it for every decode, so a LinkPort built from a chain id
// read once at mount would keep pointing at the old chain's explorer after the person changes
// it, and a chain change from the settings dapp in THIS tab is an ordinary event, not a corner case
// (a change made in another tab does not reach this one — see shouldAutoRunSharedLink's note).
// Reading settings.get('chainId') INSIDE each member, at call time, is what fixes it — do not
// "simplify" this back to core.createExplorerLinks(settings.get('chainId')) at the call site;
// that reintroduces the exact staleness this closure exists to prevent (05-04 review, HIGH).
// core.createExplorerLinks already accepts a chain id as a number or a string (a real settings
// read stores the string form), so no normalisation is needed here.
function createLiveExplorerLinks(settings: SettingsPort): LinkPort {
  function currentChainId(): number | string | null {
    const raw = settings.get('chainId');
    return raw === undefined || raw === null ? null : (raw as number | string);
  }
  return {
    address(addr) {
      const chainId = currentChainId();
      const core = window.DxDecode?.core;
      return chainId === null || !core ? null : core.createExplorerLinks(chainId).address(addr);
    },
    tx(hash) {
      const chainId = currentChainId();
      const core = window.DxDecode?.core;
      return chainId === null || !core ? null : core.createExplorerLinks(chainId).tx(hash);
    },
  };
}

// 05-05 Task 3: the composition root — the single place the transport, both registry adapters
// and the resolver meet a DecodeService. Called ONCE per mount from init(), never per decode,
// so every decode in this mount shares the SAME transport (one token bucket, D-22) rather than
// re-composing sources — and constructing it here issues no request; the first request happens
// only when a decode needs a selector it cannot resolve locally (T-05-32).
//
// Feature-detects every namespace sub-key it reads — a host shell could in principle load
// ui.js without transport.js (the manifest makes that unlikely here, but DEC-14's whole
// portability posture is that this directory works in a shell it did not configure). A missing
// sub-key yields an omitted option; DecodeContext's members are optional precisely so the
// decoder degrades to the local table instead of throwing.
function createDecodeAdapters(
  dx: unknown,
  settings: SettingsPort,
  log: LogPort,
): {
  transport?: TransportPort;
  signatures?: SignatureLookupPort;
  abis?: AbiSourcePort;
  txSource?: TxSourcePort;
  settingsRoute?: string;
} {
  const transportModule = window.DxDecode?.transport;
  const signaturesModule = window.DxDecode?.signatures;
  const abiSourceModule = window.DxDecode?.abiSource;
  const txSourceModule = window.DxDecode?.txSource;
  const core = window.DxDecode?.core;

  let transport: TransportPort | undefined;
  if (transportModule) {
    // 05-03 corrected this default to 3; reading it here (rather than hardcoding it a second
    // time) is what keeps the visible setting and the enforced rate the same number.
    const rps = settings.get('etherscanRps');
    transport = transportModule.createTransport({ log, rps: typeof rps === 'number' ? rps : undefined });
  }

  let signatures: SignatureLookupPort | undefined;
  if (
    transport &&
    signaturesModule?.createOpenChainAdapter &&
    signaturesModule.create4byteAdapter &&
    signaturesModule.createSignatureResolver
  ) {
    // D-21: OpenChain then 4byte, in that order — "prefer OpenChain over 4byte, and never
    // present a single 4byte hit as authoritative".
    const openchain = signaturesModule.createOpenChainAdapter(transport);
    const fourbyte = signaturesModule.create4byteAdapter(transport);
    signatures = signaturesModule.createSignatureResolver([openchain, fourbyte]);
  }

  // 06-03: the verified rung's real supplier. Built from the SAME transport instance as
  // `signatures` above — sharing it is what makes the verified-ABI lookup inherit the one token
  // bucket, the dedupe map and the credential redaction, rather than silently defeating all
  // three by constructing a second transport here. Feature-detected like every other sub-key
  // (a host shell could load ui.js without abi-source.js) so a missing module degrades to an
  // omitted option, never a throw.
  let abis: AbiSourcePort | undefined;
  if (transport && abiSourceModule?.createEtherscanAbiSource) {
    abis = abiSourceModule.createEtherscanAbiSource(transport, settings);
  }

  // Plan 05 Task 3: the transaction source's real supplier, built from the SAME transport
  // instance as everything above. Sharing it is load-bearing for four separate reasons: it is
  // what puts these requests behind the one token bucket, what gives them the same retry and
  // backoff policy, what gives them Task 0's timeout, and what applies the log's redaction
  // rules — the `apikey`-family query-key masking and the unconditional userinfo masking Task 0
  // adds. A second transport constructed here would silently defeat all four. Word the fourth
  // reason precisely rather than inflating it: the shared transport redacts a KNOWN credential
  // position, not an arbitrary one — the endpoint leg's protection against a credential in a
  // path segment is its own `logUrl` (tx-source.ts's txsComposeLogUrl), not the transport.
  // "It goes through the transport, so it is safe" is exactly the claim cross-AI review
  // disproved for this plan's own threat model, and it does not survive here either.
  let txSource: TxSourcePort | undefined;
  if (transport && txSourceModule?.txsCreateAdapter) {
    txSource = txSourceModule.txsCreateAdapter(transport, settings);
  }

  // core.findSettingsRoute(dx) returns null for a host with no settings dapp — DEC-13's
  // sentence then renders with no link rather than a broken one.
  const settingsRoute = core?.findSettingsRoute(dx) ?? undefined;

  return { transport, signatures, abis, txSource, settingsRoute };
}

function logEntriesToJson(entries: LogEntry[]): string {
  // D-24: entries already carry redacted url/query/requestHeaders — nothing further to strip.
  return JSON.stringify(entries, null, 2);
}

// NET-07: single-quotes the url and every header/data argument, escaping an embedded single
// quote as '\'' (close the quote, an escaped literal quote, reopen) — a URLSearchParams-built
// query string cannot contain one, but a user-typed RPC host or a POST body is free text that
// could, and an unescaped quote there would produce a silently malformed command.
//
// Plan 05 Task 0: scope now includes a body via `-d`, added when the recorded entry carries one
// (the first POST entry this directory records is Plan 05's JSON-RPC transaction lookup). This
// composes from whatever the LOG ENTRY holds — `entry.requestBody`, which is `logBody` when the
// caller supplied one (see `transport.ts`'s `netRequest`) and `req.body` VERBATIM otherwise. It
// can therefore never expose more than the Log tab already displays, which is the whole of the
// guarantee: the transport does not redact an arbitrary body by default, and this command was
// never claiming to either.
function curlQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function logEntryToCurl(entry: LogEntry): string {
  const url = entry.url ?? `${entry.host}${entry.path}`;
  const parts = ['curl', '-X', entry.method, curlQuote(url)];
  if (entry.requestHeaders) {
    // Without this, a redacted Authorization value would never reach the copied command at
    // all — NET-07's header clause would be satisfied only in the JSON surface.
    for (const [name, value] of Object.entries(entry.requestHeaders)) {
      parts.push('-H', curlQuote(`${name}: ${value}`));
    }
  }
  if (entry.requestBody) {
    parts.push('-d', curlQuote(entry.requestBody));
  }
  return parts.join(' ');
}

// D-03 part 3: the ONE construction site in this directory permitted to name `href` — the
// portability guard's helper-scoped exemption names this function specifically, and a
// synthetic case moving this exact assignment outside it is proven to still fail
// (test/decode-portability.test.ts). `target`/`raw` never reach this function un-shape-
// validated — the decoder composes `target` from `ctx.links`/`ctx.settingsRoute` only after
// its own shape check (D-30); this function draws whatever it is given, unchanged.
//
// T-05-33: `external` gets a new browsing context AND `rel="noopener noreferrer"` — a
// third-party explorer opened without it holds a live `window.opener` reference back to a tab
// showing decoded calldata and settings, and can navigate it. `route` is same-document (an
// in-shell hash route) and gets neither: `noopener` on a same-document link is noise.
function uiCreateExternalLink(target: string, text: string, kind: 'external' | 'route'): HTMLElement {
  const anchor = document.createElement('a');
  // A route is an in-shell hash route, not a server path — compose it the same way
  // buildShareUrl already does (`#${route}`), never assign the bare manifest route as `href`
  // verbatim: the vendored router navigates by writing `location.hash` and intercepts no
  // anchor clicks, so a bare `/settings` is a full-page navigation to a URL that 404s on
  // GitHub Pages and IPFS alike (CR-01). Guard against a route value that already carries its
  // own leading `#` (defensive; nothing in this directory produces one today) so this never
  // emits `##`.
  anchor.href = kind === 'route' ? (target.startsWith('#') ? target : `#${target}`) : target;
  anchor.textContent = text;
  if (kind === 'external') {
    anchor.target = '_blank';
    anchor.rel = 'noopener noreferrer';
  }
  return anchor;
}

// ETH-10/ETH-11: reads the IDENTICAL expression copyValue reads (underlyingText(node),
// above) — deriving the full value a second way here is the exact failure mode sharing one
// expression exists to avoid. Sets a title only when the element's own visible text is NOT
// the full value: a row that already shows everything has nothing to reveal, so it gets no
// tooltip (a plain element property, not a network/storage identifier — no guard amendment
// needed for this function).
function applyFullValueTitle(el: HTMLElement, node: DecodeNode): void {
  const full = underlyingText(node);
  if (full === undefined) return;
  if (el.textContent === full) return;
  el.title = full;
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
  createShellSettingsPort,
  renderLogDetail,
  logEntriesToJson,
  logEntryToCurl,
  uiCreateExternalLink,
  applyFullValueTitle,
};

window.DxDecode.ui = uiModule;
