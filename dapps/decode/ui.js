window.DxDecode ??= {};
function underlyingText(node) {
  if (node.raw !== void 0) return node.raw;
  if (node.value === void 0 || node.value === null) return void 0;
  if (typeof node.value === "bigint") return node.value.toString();
  return String(node.value);
}
const DISPLAY_DISPATCH = {
  address: (node) => typeof node.value === "string" ? node.value : underlyingText(node) ?? null,
  txhash: (node) => typeof node.value === "string" ? node.value : underlyingText(node) ?? null,
  hex: (node) => underlyingText(node) ?? null,
  int: (node) => underlyingText(node) ?? null,
  // Reads `value` first for the same reason address/txhash do, but inverted: for an ABI-decoded
  // `string` argument `raw` is the hex of the utf8 bytes and `value` is the text, so
  // underlyingText's raw-wins rule would render `0x5a` where the argument says `Z`. Every other
  // node reaching this entry (base64/url/jwt/hex's own `text` nodes) writes value === raw, so
  // preferring value is a no-op for them. abi.ts's invalid-UTF-8 branch sets value to the hex
  // itself, which is why this needs no separate guard for undecodable bytes.
  text: (node) => typeof node.value === "string" ? node.value : underlyingText(node) ?? null,
  json: (node) => underlyingText(node) ?? null,
  bool: (node) => underlyingText(node) ?? null
};
function formatDisplayValue(node) {
  if (node.display && node.display in DISPLAY_DISPATCH) {
    return DISPLAY_DISPATCH[node.display](node);
  }
  return underlyingText(node) ?? null;
}
const VALUE_FOLD_THRESHOLD = 128;
const VALUE_FOLD_HEAD = 66;
const VALUE_FOLD_TAIL = 32;
function foldValue(text) {
  return `${text.slice(0, VALUE_FOLD_HEAD)}\u2026${text.slice(-VALUE_FOLD_TAIL)}`;
}
const PROVENANCE_LABELS = {
  verified: "Verified",
  registry: "Registry",
  unresolved: "Unresolved",
  local: "Local"
};
const LINK_GLYPH = {
  external: "\u2197",
  route: "\u2192"
};
const COPY_CONFIRM_MS = 1500;
const copyTimers = /* @__PURE__ */ new Map();
function confirmCopy(row) {
  const existing = copyTimers.get(row);
  if (existing !== void 0) clearTimeout(existing);
  row.classList.add("decode-copied");
  const timer = setTimeout(() => {
    row.classList.remove("decode-copied");
    copyTimers.delete(row);
  }, COPY_CONFIRM_MS);
  copyTimers.set(row, timer);
}
function clearAllCopyTimers() {
  for (const timer of copyTimers.values()) clearTimeout(timer);
  copyTimers.clear();
}
function revealCopyFallback(row, text, fieldSelector = "#decode-copy-reveal") {
  const field = row.closest(".layout-tool")?.querySelector(fieldSelector);
  if (!field) return;
  field.value = text;
  field.classList.add("revealed");
  field.focus();
  field.select();
}
async function writeClipboard(text) {
  if (typeof navigator.clipboard?.writeText !== "function") return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
async function copyValue(node, row) {
  const text = underlyingText(node);
  if (text === void 0) return;
  const wrote = await writeClipboard(text);
  if (!wrote) {
    revealCopyFallback(row, text);
    return;
  }
  confirmCopy(row);
}
let treeIdCounter = 0;
function nextTreeId() {
  treeIdCounter += 1;
  return `decode-tree-children-${treeIdCounter}`;
}
function renderNode(node, index) {
  const wrapper = document.createElement("div");
  wrapper.className = "decode-tree-node";
  const hasChildren = Array.isArray(node.children) && node.children.length > 0;
  let childrenEl = null;
  if (hasChildren) {
    childrenEl = document.createElement("div");
    childrenEl.className = "decode-tree-children";
    childrenEl.id = nextTreeId();
    if (node.collapsed === true) childrenEl.classList.add("decode-tree-collapsed");
    for (const child of node.children) {
      childrenEl.append(renderNode(child, index));
    }
  }
  const row = document.createElement("div");
  row.className = "decode-tree-row";
  index?.set(node, row);
  if (hasChildren && childrenEl) {
    const disclosure = document.createElement("button");
    disclosure.type = "button";
    disclosure.className = "decode-tree-disclosure";
    const collapsedInitially = node.collapsed === true;
    disclosure.setAttribute("aria-expanded", String(!collapsedInitially));
    disclosure.setAttribute("aria-controls", childrenEl.id);
    disclosure.textContent = collapsedInitially ? "\u25B8" : "\u25BE";
    disclosure.addEventListener("click", () => {
      const expanded = disclosure.getAttribute("aria-expanded") === "true";
      const next = !expanded;
      disclosure.setAttribute("aria-expanded", String(next));
      disclosure.textContent = next ? "\u25BE" : "\u25B8";
      childrenEl?.classList.toggle("decode-tree-collapsed", !next);
    });
    row.append(disclosure);
  }
  const label = document.createElement("span");
  label.className = "decode-tree-label";
  label.textContent = node.label;
  row.append(label);
  if (node.type || node.display) {
    const hint = document.createElement("span");
    hint.className = "decode-tree-hint";
    hint.textContent = node.type ?? node.display ?? "";
    row.append(hint);
  }
  const valueBtn = document.createElement("button");
  valueBtn.type = "button";
  valueBtn.className = "decode-tree-value";
  const displayText = formatDisplayValue(node) ?? "";
  const folded = displayText.length > VALUE_FOLD_THRESHOLD;
  valueBtn.textContent = folded ? foldValue(displayText) : displayText;
  valueBtn.addEventListener("click", () => {
    void copyValue(node, row);
  });
  row.append(valueBtn);
  if (folded) {
    valueBtn.classList.add("decode-tree-value-foldable");
    const expand = document.createElement("button");
    expand.type = "button";
    expand.className = "decode-tree-expand";
    expand.setAttribute("aria-expanded", "false");
    expand.textContent = "more";
    expand.title = `${displayText.length} characters`;
    expand.addEventListener("click", () => {
      const expanded = expand.getAttribute("aria-expanded") === "true";
      const next = !expanded;
      expand.setAttribute("aria-expanded", String(next));
      expand.textContent = next ? "less" : "more";
      valueBtn.textContent = next ? displayText : foldValue(displayText);
    });
    row.append(expand);
  } else {
    applyFullValueTitle(valueBtn, node);
  }
  if (node.link) {
    const kind = node.linkKind ?? "external";
    const anchor = uiCreateExternalLink(node.link, LINK_GLYPH[kind], kind);
    anchor.className = "decode-tree-link";
    if (node.display === "address" || node.display === "txhash") {
      applyFullValueTitle(anchor, node);
    }
    row.append(anchor);
  }
  if (node.provenance) {
    const badge = document.createElement("span");
    badge.className = `decode-provenance-badge decode-provenance-${node.provenance}`;
    badge.textContent = PROVENANCE_LABELS[node.provenance];
    row.append(badge);
  }
  if (node.error) {
    const err = document.createElement("span");
    err.className = "decode-tree-error";
    err.textContent = node.error;
    row.append(err);
  }
  if (node.warning) {
    const warn = document.createElement("span");
    warn.className = "decode-tree-warning";
    warn.textContent = node.warning;
    row.append(warn);
  }
  if (node.annotations) {
    for (const text of node.annotations) {
      const ann = document.createElement("span");
      ann.className = "decode-tree-annotation";
      ann.textContent = text;
      row.append(ann);
    }
  }
  wrapper.append(row);
  if (childrenEl) wrapper.append(childrenEl);
  return wrapper;
}
const HEXDUMP_BYTES_PER_ROW = 16;
const PRINTABLE_MIN = 32;
const PRINTABLE_MAX = 126;
function renderHexDump(bytes) {
  const table = document.createElement("table");
  table.className = "decode-hexdump";
  const tbody = document.createElement("tbody");
  for (let offset = 0; offset < bytes.length; offset += HEXDUMP_BYTES_PER_ROW) {
    const rowBytes = bytes.slice(offset, offset + HEXDUMP_BYTES_PER_ROW);
    const tr = document.createElement("tr");
    const offsetCell = document.createElement("td");
    offsetCell.className = "decode-hexdump-offset";
    offsetCell.textContent = offset.toString(16).padStart(8, "0");
    tr.append(offsetCell);
    const bytesCell = document.createElement("td");
    bytesCell.className = "decode-hexdump-bytes";
    bytesCell.textContent = Array.from(rowBytes, (b) => b.toString(16).padStart(2, "0")).join(" ");
    tr.append(bytesCell);
    const asciiCell = document.createElement("td");
    asciiCell.className = "decode-hexdump-ascii";
    let ascii = "";
    for (const b of rowBytes) {
      ascii += b >= PRINTABLE_MIN && b <= PRINTABLE_MAX ? String.fromCharCode(b) : ".";
    }
    asciiCell.textContent = ascii;
    tr.append(asciiCell);
    tbody.append(tr);
  }
  table.append(tbody);
  return table;
}
function renderWordTable(bytes) {
  const WORD_LEN = 32;
  const SELECTOR_LEN = 4;
  const hasSelector = bytes.length >= SELECTOR_LEN + WORD_LEN && (bytes.length - SELECTOR_LEN) % WORD_LEN === 0;
  const table = document.createElement("table");
  table.className = "decode-wordtable";
  const tbody = document.createElement("tbody");
  function appendRow(offset2, rowBytes) {
    const tr = document.createElement("tr");
    const offsetCell = document.createElement("td");
    offsetCell.className = "decode-wordtable-offset";
    offsetCell.textContent = offset2.toString(16).padStart(8, "0");
    tr.append(offsetCell);
    const wordCell = document.createElement("td");
    wordCell.className = "decode-wordtable-word";
    wordCell.textContent = Array.from(rowBytes, (b) => b.toString(16).padStart(2, "0")).join("");
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
    appendRow(offset, bytes.slice(offset));
  }
  table.append(tbody);
  return table;
}
function renderRawEmpty() {
  const p = document.createElement("p");
  p.className = "decode-empty-message";
  p.textContent = "Nothing decoded yet \u2014 the raw bytes will appear here once you run a decode.";
  return p;
}
const RAW_VIEW_DISPATCH = {
  "hex-dump": renderHexDump,
  "word-table": renderWordTable
};
function renderRaw(rawBytes, rawView) {
  if (!rawBytes) return renderRawEmpty();
  const renderer = RAW_VIEW_DISPATCH[rawView] ?? RAW_VIEW_DISPATCH["hex-dump"];
  return renderer(rawBytes);
}
const LOG_COLUMNS = [
  { key: "timestamp", label: "Time" },
  { key: "method", label: "Method" },
  { key: "host", label: "Host" },
  { key: "path", label: "Path" },
  { key: "status", label: "Status" },
  { key: "duration", label: "Duration" },
  { key: "attempt", label: "Attempt" }
];
function renderLogEmpty() {
  const p = document.createElement("p");
  p.className = "decode-empty-message";
  p.textContent = "Nothing has left this browser. Every decoder here runs entirely on your device \u2014 decoding happens locally, with no request sent anywhere. If a decoder ever does reach out, every request it makes will be listed here, with any credentials redacted.";
  return p;
}
const LOG_EXPANDED = /* @__PURE__ */ new WeakSet();
const LOG_BODY_PREVIEW_BYTES = 2048;
function truncateLogBody(body) {
  const byteLength = new TextEncoder().encode(body).length;
  if (byteLength <= LOG_BODY_PREVIEW_BYTES) return body;
  return `${body.slice(0, LOG_BODY_PREVIEW_BYTES)}\u2026 (${byteLength} bytes total, truncated)`;
}
function renderLogDetail(entry) {
  const el = document.createElement("div");
  el.className = "decode-log-detail";
  function addField(label, value) {
    const field = document.createElement("div");
    field.className = "decode-log-detail-field";
    const labelEl = document.createElement("span");
    labelEl.className = "decode-log-detail-label";
    labelEl.textContent = label;
    const valueEl = document.createElement("span");
    valueEl.className = "decode-log-detail-value";
    valueEl.textContent = value;
    field.append(labelEl, valueEl);
    el.append(field);
  }
  if (entry.url !== void 0) addField("URL", entry.url);
  if (entry.query && Object.keys(entry.query).length > 0) {
    addField(
      "Query",
      Object.entries(entry.query).map(([k, v]) => `${k}=${v}`).join("&")
    );
  }
  if (entry.requestHeaders) {
    for (const [name, value] of Object.entries(entry.requestHeaders)) {
      addField(`Header: ${name}`, value);
    }
  }
  if (entry.requestBody !== void 0) addField("Request body", truncateLogBody(entry.requestBody));
  if (entry.responseBody !== void 0) addField("Response body", truncateLogBody(entry.responseBody));
  if (entry.error !== void 0) addField("Error", entry.error);
  return el;
}
function renderLogTable(entries) {
  const table = document.createElement("table");
  table.className = "decode-log-table";
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const col of LOG_COLUMNS) {
    const th = document.createElement("th");
    th.textContent = col.label;
    headRow.append(th);
  }
  thead.append(headRow);
  table.append(thead);
  const tbody = document.createElement("tbody");
  let detailIdCounter = 0;
  for (const entry of entries) {
    detailIdCounter += 1;
    const detailId = `decode-log-detail-${detailIdCounter}`;
    const expanded = LOG_EXPANDED.has(entry);
    const summaryRow = document.createElement("tr");
    summaryRow.className = "decode-log-summary-row";
    const disclosureCell = document.createElement("td");
    const disclosure = document.createElement("button");
    disclosure.type = "button";
    disclosure.className = "decode-log-disclosure";
    disclosure.setAttribute("aria-expanded", String(expanded));
    disclosure.setAttribute("aria-controls", detailId);
    disclosure.textContent = expanded ? "\u25BE" : "\u25B8";
    disclosureCell.append(disclosure);
    summaryRow.append(disclosureCell);
    for (const col of LOG_COLUMNS) {
      const td = document.createElement("td");
      td.textContent = String(entry[col.key]);
      summaryRow.append(td);
    }
    tbody.append(summaryRow);
    const detailRow = document.createElement("tr");
    detailRow.className = "decode-log-detail-row";
    detailRow.id = detailId;
    detailRow.hidden = !expanded;
    const detailCell = document.createElement("td");
    detailCell.colSpan = LOG_COLUMNS.length + 1;
    detailCell.append(renderLogDetail(entry));
    detailRow.append(detailCell);
    tbody.append(detailRow);
    disclosure.addEventListener("click", () => {
      const next = disclosure.getAttribute("aria-expanded") !== "true";
      disclosure.setAttribute("aria-expanded", String(next));
      disclosure.textContent = next ? "\u25BE" : "\u25B8";
      detailRow.hidden = !next;
      if (next) LOG_EXPANDED.add(entry);
      else LOG_EXPANDED.delete(entry);
    });
  }
  table.append(tbody);
  return table;
}
function renderLog(entries) {
  return entries.length === 0 ? renderLogEmpty() : renderLogTable(entries);
}
function applyAutoResolution(badge, registry, resolution) {
  if (!badge) return;
  if (resolution.decoderId) {
    const decoder = registry.get(resolution.decoderId);
    badge.textContent = `Auto-detected: ${decoder ? decoder.label : resolution.decoderId}`;
  } else {
    badge.textContent = resolution.reason;
  }
}
let mountGeneration = 0;
function formatByteSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}
async function shareViaClipboard(url, button) {
  const wrote = await writeClipboard(url);
  if (!wrote) {
    revealCopyFallback(button, url);
    return;
  }
  confirmCopy(button);
}
function routeFromLocationHash() {
  const hash = window.location.hash.startsWith("#") ? window.location.hash.slice(1) : window.location.hash;
  return hash.split("?")[0].replace(/\/+$/, "");
}
function init(container, dx, query) {
  const gen = ++mountGeneration;
  const registry = window.DxDecode?.registry;
  const core = window.DxDecode?.core;
  if (!registry || !core || registry.size() === 0) {
    const message = document.createElement("p");
    message.className = "decode-empty-message";
    message.textContent = "No decoders loaded \u2014 the decode dapp shipped with an empty registry.";
    container.replaceChildren(message);
    const emptyHandle = (() => {
      container.replaceChildren();
    });
    emptyHandle.applyQuery = () => {
    };
    return emptyHandle;
  }
  const ownRoute = core.findOwnRoute(dx) ?? routeFromLocationHash();
  const selector = container.querySelector("#decode-selector");
  const textarea = container.querySelector("#decode-textarea");
  const runBtn = container.querySelector("#decode-run-btn");
  const clearBtn = container.querySelector("#decode-clear-btn");
  const tree = container.querySelector("#decode-tree");
  const raw = container.querySelector("#decode-raw");
  const badge = container.querySelector("#decode-auto-badge");
  const logContainer = container.querySelector("#decode-log");
  const logClearBtn = container.querySelector("#decode-log-clear-btn");
  const shareZBtn = container.querySelector("#decode-share-z-btn");
  const shareSizeEl = container.querySelector("#decode-share-size");
  const shareWarningEl = container.querySelector("#decode-share-warning");
  const tabButtons = Array.from(container.querySelectorAll("#decode-tabs button"));
  const tabPanels = Array.from(container.querySelectorAll(".tab-content"));
  if (!selector || !textarea || !runBtn || !clearBtn || !tree) {
    container.replaceChildren();
    const missingDomHandle = (() => {
      container.replaceChildren();
    });
    missingDomHandle.applyQuery = () => {
    };
    return missingDomHandle;
  }
  const settings = createShellSettingsPort(dx);
  const log = window.DxDecode?.log ?? { record() {
  }, subscribe: () => () => void 0, clear() {
  } };
  const links = createLiveExplorerLinks(settings);
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
    settingsRoute
  });
  const listeners = [];
  const autoOption = document.createElement("option");
  autoOption.value = "auto";
  autoOption.textContent = "Auto";
  selector.append(autoOption);
  for (const decoder of registry.list()) {
    const option = document.createElement("option");
    option.value = decoder.id;
    option.textContent = decoder.label;
    selector.append(option);
  }
  selector.value = "auto";
  function renderEmptyResult() {
    const message = document.createElement("p");
    message.className = "decode-empty-message";
    message.textContent = "Paste an encoded payload and press Decode (or Ctrl/Cmd+Enter) to see it rendered here.";
    tree?.replaceChildren(message);
  }
  function setActiveTab(target) {
    for (const b of tabButtons) b.classList.toggle("active", b.dataset.tab === target);
    for (const panel of tabPanels) panel.classList.toggle("active", panel.id === `decode-tab-${target}`);
  }
  let resolvedAutoId = null;
  let currentController = null;
  let rowIndex = null;
  let unsubscribeUpdates = null;
  function endActiveRun() {
    currentController?.abort();
    unsubscribeUpdates?.();
    unsubscribeUpdates = null;
    rowIndex = null;
  }
  async function runDecode() {
    endActiveRun();
    const controller = new AbortController();
    currentController = controller;
    const input = textarea.value;
    let decoderId = selector.value === "auto" ? resolvedAutoId : selector.value;
    if (selector.value === "auto" && decoderId === null) {
      const resolution = core.resolve(input);
      applyAutoResolution(badge, registry, resolution);
      decoderId = resolution.decoderId;
    }
    const result = await decodeService.decode(decoderId, input, { signal: controller.signal });
    if (result.stale) return;
    rowIndex = /* @__PURE__ */ new Map();
    tree.replaceChildren(renderNode(result.node, rowIndex));
    raw?.replaceChildren(renderRaw(result.rawBytes, result.rawView));
    setActiveTab("result");
    if (result.onNodeUpdate) {
      unsubscribeUpdates = result.onNodeUpdate((node, annotation) => {
        const row = rowIndex?.get(node);
        if (!row) return;
        const ann = document.createElement("span");
        ann.className = "decode-tree-annotation";
        ann.textContent = annotation;
        row.append(ann);
      });
    }
  }
  const onRunClick = () => {
    void runDecode();
  };
  runBtn.addEventListener("click", onRunClick);
  listeners.push(() => runBtn.removeEventListener("click", onRunClick));
  const onClearClick = () => {
    endActiveRun();
    textarea.value = "";
    renderEmptyResult();
  };
  clearBtn.addEventListener("click", onClearClick);
  listeners.push(() => clearBtn.removeEventListener("click", onClearClick));
  const onKeydown = (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void runDecode();
    }
  };
  textarea.addEventListener("keydown", onKeydown);
  listeners.push(() => textarea.removeEventListener("keydown", onKeydown));
  const onPaste = () => {
    if (selector.value !== "auto") return;
    setTimeout(() => {
      const resolution = core.resolve(textarea.value);
      resolvedAutoId = resolution.decoderId;
      applyAutoResolution(badge, registry, resolution);
    }, 0);
  };
  textarea.addEventListener("paste", onPaste);
  listeners.push(() => textarea.removeEventListener("paste", onPaste));
  const onSelectorChange = () => {
    resolvedAutoId = null;
    if (badge) badge.textContent = "";
  };
  selector.addEventListener("change", onSelectorChange);
  listeners.push(() => selector.removeEventListener("change", onSelectorChange));
  function updateShareSize() {
    if (!shareSizeEl) return;
    const bytes = new TextEncoder().encode(textarea.value).length;
    shareSizeEl.textContent = formatByteSize(bytes);
    const overThreshold = bytes > core.SHARE_SIZE_WARNING_BYTES;
    if (shareWarningEl) shareWarningEl.hidden = !overThreshold;
    if (shareZBtn) shareZBtn.hidden = !(overThreshold && core.supportsCompression());
  }
  const onTextareaInput = () => {
    if (selector.value === "auto") resolvedAutoId = null;
    updateShareSize();
  };
  textarea.addEventListener("input", onTextareaInput);
  listeners.push(() => textarea.removeEventListener("input", onTextareaInput));
  function currentDecoderId() {
    return selector.value === "auto" ? resolvedAutoId : selector.value;
  }
  function pressPlainShare() {
    const url = core.buildShareUrl(ownRoute, currentDecoderId(), textarea.value, false);
    try {
      history.replaceState(null, "", url);
    } catch {
    }
    return url;
  }
  const onShareZClick = () => {
    void (async () => {
      try {
        const compressed = await core.compressForShare(textarea.value);
        const url = core.buildShareUrl(ownRoute, currentDecoderId(), compressed, true);
        history.replaceState(null, "", url);
        await shareViaClipboard(url, shareZBtn);
      } catch (err) {
        tree.replaceChildren(renderNode({ label: "share", error: err instanceof Error ? err.message : String(err) }));
      }
    })();
  };
  if (shareZBtn) {
    shareZBtn.addEventListener("click", onShareZClick);
    listeners.push(() => shareZBtn.removeEventListener("click", onShareZClick));
  }
  for (const btn of tabButtons) {
    const onTabClick = () => setActiveTab(btn.dataset.tab ?? "result");
    btn.addEventListener("click", onTabClick);
    listeners.push(() => btn.removeEventListener("click", onTabClick));
  }
  let currentLogEntries = [];
  let unsubscribeLog = null;
  if (logContainer) {
    unsubscribeLog = log.subscribe((entries) => {
      currentLogEntries = entries;
      logContainer.replaceChildren(renderLog(entries));
    });
  }
  if (logClearBtn) {
    const onLogClear = () => log.clear();
    logClearBtn.addEventListener("click", onLogClear);
    listeners.push(() => logClearBtn.removeEventListener("click", onLogClear));
  }
  const logCopyJsonBtn = container.querySelector("#decode-log-copy-json-btn");
  const logCopyCurlBtn = container.querySelector("#decode-log-copy-curl-btn");
  async function copyLogPayload(text, button) {
    const wrote = await writeClipboard(text);
    if (!wrote) {
      revealCopyFallback(button, text, "#decode-log-copy-reveal");
      return;
    }
    confirmCopy(button);
  }
  if (logCopyJsonBtn) {
    const onLogCopyJson = () => {
      void copyLogPayload(logEntriesToJson(currentLogEntries), logCopyJsonBtn);
    };
    logCopyJsonBtn.addEventListener("click", onLogCopyJson);
    listeners.push(() => logCopyJsonBtn.removeEventListener("click", onLogCopyJson));
  }
  if (logCopyCurlBtn) {
    const onLogCopyCurl = () => {
      void copyLogPayload(currentLogEntries.map(logEntryToCurl).join("\n"), logCopyCurlBtn);
    };
    logCopyCurlBtn.addEventListener("click", onLogCopyCurl);
    listeners.push(() => logCopyCurlBtn.removeEventListener("click", onLogCopyCurl));
  }
  renderEmptyResult();
  raw?.replaceChildren(renderRawEmpty());
  updateShareSize();
  function applyLoadedInput(input, decoderId) {
    textarea.value = input;
    if (decoderId && registry.get(decoderId)) {
      selector.value = decoderId;
      resolvedAutoId = null;
      if (badge) badge.textContent = "";
    } else {
      selector.value = "auto";
      const resolution = core.resolve(input);
      resolvedAutoId = resolution.decoderId;
      applyAutoResolution(badge, registry, resolution);
    }
    updateShareSize();
  }
  let applyGeneration = 0;
  function shouldAutoRunSharedLink(q) {
    return q?.submit === "1" && settings.get("autoRunSharedLinks") === true;
  }
  function applyQuery(q) {
    const myApply = ++applyGeneration;
    const autoRun = shouldAutoRunSharedLink(q);
    if (q?.z) {
      core.decompressFromShare(q.z).then((result) => {
        if (gen !== mountGeneration || myApply !== applyGeneration) return;
        if (!result.ok) {
          tree?.replaceChildren(renderNode({ label: "decode", error: result.error, raw: q.z }));
          textarea.value = q.z;
          updateShareSize();
          return;
        }
        applyLoadedInput(result.value, q.decoder);
        if (autoRun) void runDecode();
      });
    } else if (q?.data !== void 0) {
      applyLoadedInput(q.data, q.decoder);
      if (autoRun) void runDecode();
    }
  }
  applyQuery(query);
  function cleanup() {
    mountGeneration++;
    for (const off of listeners) off();
    listeners.length = 0;
    unsubscribeLog?.();
    endActiveRun();
    clearAllCopyTimers();
    container.replaceChildren();
  }
  const handle = cleanup;
  handle.applyQuery = applyQuery;
  handle.pressPlainShare = pressPlainShare;
  handle.revealShareFailure = (url) => revealCopyFallback(textarea, url);
  return handle;
}
function createShellSettingsPort(dx) {
  return {
    get(key) {
      try {
        const shell = dx;
        if (!shell?.settings) return void 0;
        const { getSections, get } = shell.settings;
        if (typeof getSections !== "function" || typeof get !== "function") return void 0;
        const sections = getSections();
        if (!Array.isArray(sections)) return void 0;
        for (const section of sections) {
          if (section?.definitions?.some((def) => def.key === key)) {
            return get(section.id, key);
          }
        }
        return void 0;
      } catch {
        return void 0;
      }
    }
  };
}
function createLiveExplorerLinks(settings) {
  function currentChainId() {
    const raw = settings.get("chainId");
    return raw === void 0 || raw === null ? null : raw;
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
    }
  };
}
function createDecodeAdapters(dx, settings, log) {
  const transportModule = window.DxDecode?.transport;
  const signaturesModule = window.DxDecode?.signatures;
  const abiSourceModule = window.DxDecode?.abiSource;
  const txSourceModule = window.DxDecode?.txSource;
  const core = window.DxDecode?.core;
  let transport;
  if (transportModule) {
    const rps = settings.get("etherscanRps");
    transport = transportModule.createTransport({ log, rps: typeof rps === "number" ? rps : void 0 });
  }
  let signatures;
  if (transport && signaturesModule?.createOpenChainAdapter && signaturesModule.create4byteAdapter && signaturesModule.createSignatureResolver) {
    const openchain = signaturesModule.createOpenChainAdapter(transport);
    const fourbyte = signaturesModule.create4byteAdapter(transport);
    signatures = signaturesModule.createSignatureResolver([openchain, fourbyte]);
  }
  let abis;
  if (transport && abiSourceModule?.createEtherscanAbiSource) {
    abis = abiSourceModule.createEtherscanAbiSource(transport, settings);
  }
  let txSource;
  if (transport && txSourceModule?.txsCreateAdapter) {
    txSource = txSourceModule.txsCreateAdapter(transport, settings);
  }
  const settingsRoute = core?.findSettingsRoute(dx) ?? void 0;
  return { transport, signatures, abis, txSource, settingsRoute };
}
function logEntriesToJson(entries) {
  return JSON.stringify(entries, null, 2);
}
function curlQuote(value) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
function logEntryToCurl(entry) {
  const url = entry.url ?? `${entry.host}${entry.path}`;
  const parts = ["curl", "-X", entry.method, curlQuote(url)];
  if (entry.requestHeaders) {
    for (const [name, value] of Object.entries(entry.requestHeaders)) {
      parts.push("-H", curlQuote(`${name}: ${value}`));
    }
  }
  if (entry.requestBody) {
    parts.push("-d", curlQuote(entry.requestBody));
  }
  return parts.join(" ");
}
function uiCreateExternalLink(target, text, kind) {
  const anchor = document.createElement("a");
  anchor.href = kind === "route" ? target.startsWith("#") ? target : `#${target}` : target;
  anchor.textContent = text;
  if (kind === "external") {
    anchor.target = "_blank";
    anchor.rel = "noopener noreferrer";
  }
  return anchor;
}
function applyFullValueTitle(el, node) {
  const full = underlyingText(node);
  if (full === void 0) return;
  if (el.textContent === full) return;
  el.title = full;
}
const uiModule = {
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
  applyFullValueTitle
};
window.DxDecode.ui = uiModule;
