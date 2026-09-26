import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// This suite runs the COMPILED src/dapps/decode/*.js against the jsdom `window`
// (`new Function('window', code)(window)`), then calls window.DxDecode.ui.init(...) directly
// against a container mounted with the real template.html — the same pattern
// test/settings-render.test.ts established for exercising real dapp runtime behaviour rather
// than static source-text assertions. `make test`/CI build before they test for exactly this
// reason (see Makefile `test: lint build`).
function loadCompiled(relPath: string) {
  const code = readFileSync(resolve(__dirname, relPath), 'utf-8');
  new Function('window', code)(window);
}

function loadTemplate(): string {
  return readFileSync(resolve(__dirname, '../src/dapps/decode/template.html'), 'utf-8');
}

// The tracer's proof — handoff §7.5 / TXT-02's verified vector.
const HEX_VECTOR = '0x68656c6c6f';

function mount(): { container: HTMLElement; cleanup: () => void } {
  const container = document.createElement('div');
  container.innerHTML = loadTemplate();
  document.body.append(container);
  const cleanup = (window.DxDecode!.ui!.init as (c: HTMLElement, dx: unknown) => () => void)(container, {});
  return {
    container,
    cleanup: () => {
      cleanup();
      container.remove();
    },
  };
}

// Waits out the decode service's promise chain (DecodeService.decode -> decoder.decode, each
// an `await`) without depending on how many microtask ticks that chain happens to need.
function flush(): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
}

// The plan's own test helpers, added this plan (03-05) — the pure render functions ui.ts
// exposes on window.DxDecode.ui alongside init(), purely so this suite can drive the renderer
// with hand-built DecodeNode literals directly, per Task 1's own instruction, rather than only
// ever through a full mount + a real decode.
type UiHelpers = {
  renderNode: (node: DecodeNode) => HTMLElement;
  displayDispatchKeys: () => string[];
  renderRaw: (rawBytes: Uint8Array | null, rawView: string) => HTMLElement;
  rawViewDispatchKeys: () => string[];
  renderLog: (entries: LogEntry[]) => HTMLElement;
};
function ui(): UiHelpers {
  return window.DxDecode!.ui as unknown as UiHelpers;
}

// The clipboard is a property on `navigator` that jsdom does not implement — the happy path
// has to define it and the insecure-context path has to be able to take it away again.
// Mirrors test/shell-wallet.test.ts's own installClipboard/removeClipboard shape.
function installClipboard(writeText: ReturnType<typeof vi.fn>) {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  return writeText;
}
function removeClipboard() {
  delete (navigator as unknown as { clipboard?: unknown }).clipboard;
}

// jsdom's ClipboardEvent does not implement a settable clipboardData. WR-04's onPaste no longer
// reads it (it scores the POST-insertion textarea value instead), but the event still needs a
// realistic shape for any handler that checks e.clipboardData without throwing.
function dispatchPaste(el: HTMLElement, text: string) {
  const event = new Event('paste', { bubbles: true, cancelable: true }) as unknown as ClipboardEvent;
  Object.defineProperty(event, 'clipboardData', {
    value: { getData: (type: string) => (type === 'text/plain' || type === 'text' ? text : '') },
  });
  el.dispatchEvent(event);
}

// WR-04: jsdom's synthetic 'paste' dispatch performs neither the browser's own default-action
// text insertion nor the 'input' event that follows it — both are simulated explicitly here,
// appending at the end (the common case), matching the pre-existing "browser's own post-paste
// insertion, simulated" pattern this suite already used for a single paste into an empty field.
function simulatePasteInsert(el: HTMLTextAreaElement, text: string) {
  dispatchPaste(el, text);
  el.value += text;
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

// A brace-depth CSS-rule scanner good enough to compare two small, non-nested-at-rule-heavy
// stylesheets for selector overlap — resets its buffer on every `{` AND `}`, so a selector
// nested inside an `@media` block (components.css has one) is still captured correctly: the
// `@media (...)` prelude itself is skipped (starts with `@`), and the rule immediately inside
// it is captured exactly like a top-level one, because the buffer only ever holds "the text
// since the last brace of any kind" at the moment a `{` is reached.
function extractCssSelectors(css: string): Set<string> {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const selectors = new Set<string>();
  let buffer = '';
  for (const ch of withoutComments) {
    if (ch === '{') {
      const text = buffer.trim();
      buffer = '';
      if (text && !text.startsWith('@')) {
        for (const sel of text.split(',')) {
          const trimmed = sel.trim().replace(/\s+/g, ' ');
          if (trimmed) selectors.add(trimmed);
        }
      }
    } else if (ch === '}') {
      buffer = '';
    } else {
      buffer += ch;
    }
  }
  return selectors;
}

// Strips line/block comments then extracts every quoted string literal's contents — good
// enough to prove ui.ts never branches on a registered decoder id as a whole string literal
// (exact equality, not a word-boundary substring match — 'hex-dump' must never be confused
// with the decoder id 'hex', since the former is this phase's Raw-view id and legitimately
// appears in the file).
function extractStringLiterals(source: string): string[] {
  const stripped = source.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const literals: string[] = [];
  const re = /'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g;
  let m: RegExpExecArray | null = re.exec(stripped);
  while (m) {
    literals.push(m[0].slice(1, -1));
    m = re.exec(stripped);
  }
  return literals;
}

beforeAll(() => {
  loadCompiled('../src/dapps/decode/codecs.js');
  loadCompiled('../src/dapps/decode/core.js');
  loadCompiled('../src/dapps/decode/decoders.js');
  loadCompiled('../src/dapps/decode/ui.js');
});

afterEach(() => {
  document.body.replaceChildren();
});

describe('decode dapp — end-to-end tracer (0x68656c6c6f -> hello)', () => {
  it('populates the decoder select from the registry, Auto first, sourced from the registry rather than markup', () => {
    const { container, cleanup } = mount();
    const options = Array.from(container.querySelectorAll<HTMLOptionElement>('#decode-selector option'));
    expect(options.map((o) => o.value)).toEqual(['auto', 'hex']);
    expect(options[0].textContent).toBe('Auto');
    expect(options[1].textContent).toBe('Hex');
    cleanup();
  });

  it('decodes the handoff vector into byte count, utf8, and integer children', async () => {
    const { container, cleanup } = mount();
    const selector = container.querySelector<HTMLSelectElement>('#decode-selector')!;
    const textarea = container.querySelector<HTMLTextAreaElement>('#decode-textarea')!;
    const runBtn = container.querySelector<HTMLButtonElement>('#decode-run-btn')!;

    selector.value = 'hex';
    textarea.value = HEX_VECTOR;
    runBtn.click();
    await flush();

    const tree = container.querySelector('#decode-tree')!;
    expect(tree.textContent).toContain('5');
    expect(tree.textContent).toContain('hello');
    expect(tree.textContent).toContain('448378203247');

    cleanup();
  });

  it('renders an error node for odd-length hex, never throwing (DEC-12)', async () => {
    const { container, cleanup } = mount();
    const selector = container.querySelector<HTMLSelectElement>('#decode-selector')!;
    const textarea = container.querySelector<HTMLTextAreaElement>('#decode-textarea')!;
    const runBtn = container.querySelector<HTMLButtonElement>('#decode-run-btn')!;

    selector.value = 'hex';
    textarea.value = '0xfff';
    expect(() => runBtn.click()).not.toThrow();
    await flush();

    const tree = container.querySelector('#decode-tree')!;
    expect(tree.textContent).toMatch(/odd-length/i);

    cleanup();
  });

  it('Clear empties the textarea and the Result panel', async () => {
    const { container, cleanup } = mount();
    const selector = container.querySelector<HTMLSelectElement>('#decode-selector')!;
    const textarea = container.querySelector<HTMLTextAreaElement>('#decode-textarea')!;
    const runBtn = container.querySelector<HTMLButtonElement>('#decode-run-btn')!;
    const clearBtn = container.querySelector<HTMLButtonElement>('#decode-clear-btn')!;

    selector.value = 'hex';
    textarea.value = HEX_VECTOR;
    runBtn.click();
    await flush();

    clearBtn.click();
    expect(textarea.value).toBe('');
    expect(container.querySelector('#decode-tree')!.textContent).not.toContain('hello');

    cleanup();
  });

  it('switches Result/Raw/Log tabs on click', () => {
    const { container, cleanup } = mount();
    const rawTabBtn = container.querySelector<HTMLButtonElement>('#decode-tabs button[data-tab="raw"]')!;
    rawTabBtn.click();

    expect(rawTabBtn.classList.contains('active')).toBe(true);
    expect(container.querySelector('#decode-tab-raw')!.classList.contains('active')).toBe(true);
    expect(container.querySelector('#decode-tab-result')!.classList.contains('active')).toBe(false);

    cleanup();
  });

  it('cleanup removes every listener it added and leaves the container empty', async () => {
    const { container, cleanup } = mount();
    cleanup();
    expect(container.innerHTML).toBe('');
  });

  it('renders a visible sentence instead of an empty selector when the registry is empty', () => {
    const container = document.createElement('div');
    container.innerHTML = loadTemplate();
    document.body.append(container);

    const emptyRegistry: DecoderRegistry = {
      register() {},
      get: () => undefined,
      list: () => [],
      size: () => 0,
    };
    const originalRegistry = window.DxDecode!.registry;
    window.DxDecode!.registry = emptyRegistry;

    const cleanup = (window.DxDecode!.ui!.init as (c: HTMLElement, dx: unknown) => () => void)(container, {});
    expect(container.textContent).toMatch(/no decoders/i);
    expect(container.querySelector('#decode-selector')).toBeNull();

    cleanup();
    window.DxDecode!.registry = originalRegistry;
    container.remove();
  });
});

describe('the generic DecodeNode tree renderer (Task 1)', () => {
  it('renders a real disclosure button with an announced expanded state and aria-controls for a node with children', () => {
    const node: DecodeNode = { label: 'root', children: [{ label: 'child', value: 1 }] };
    const el = ui().renderNode(node);
    const button = el.querySelector('.decode-tree-disclosure');
    expect(button?.tagName).toBe('BUTTON');
    expect(button?.getAttribute('aria-expanded')).toBe('true');
    const childrenId = button?.getAttribute('aria-controls');
    expect(childrenId).toBeTruthy();
    expect(el.querySelector(`#${childrenId}`)).not.toBeNull();
  });

  it('toggles the announced expanded state and hides the children list on click', () => {
    const node: DecodeNode = { label: 'root', children: [{ label: 'child', value: 1 }] };
    const el = ui().renderNode(node);
    const button = el.querySelector<HTMLButtonElement>('.decode-tree-disclosure')!;
    const childrenList = el.querySelector('.decode-tree-children')!;
    expect(childrenList.classList.contains('decode-tree-collapsed')).toBe(false);
    button.click();
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(childrenList.classList.contains('decode-tree-collapsed')).toBe(true);
  });

  it('renders no disclosure button for a node with no children', () => {
    const node: DecodeNode = { label: 'leaf', value: 1 };
    expect(ui().renderNode(node).querySelector('.decode-tree-disclosure')).toBeNull();
  });

  it('renders no disclosure button for a node whose children array is present but empty', () => {
    const node: DecodeNode = { label: 'leaf', value: 1, children: [] };
    const el = ui().renderNode(node);
    expect(el.querySelector('.decode-tree-disclosure')).toBeNull();
    expect(el.querySelector('.decode-tree-children')).toBeNull();
  });

  it('renders children in the array order supplied, not sorted', () => {
    const node: DecodeNode = {
      label: 'root',
      children: [
        { label: 'zeta', value: 1 },
        { label: 'alpha', value: 2 },
        { label: 'mid', value: 3 },
      ],
    };
    const el = ui().renderNode(node);
    const rootChildren = el.querySelector(':scope > .decode-tree-children')!;
    const labels = Array.from(rootChildren.children).map(
      (child) => child.querySelector('.decode-tree-label')?.textContent,
    );
    expect(labels).toEqual(['zeta', 'alpha', 'mid']);
  });

  it('renders two sibling children carrying the same label as two rows', () => {
    const node: DecodeNode = {
      label: 'root',
      children: [
        { label: 'dup', value: 1 },
        { label: 'dup', value: 2 },
      ],
    };
    const el = ui().renderNode(node);
    const rootChildren = el.querySelector(':scope > .decode-tree-children')!;
    expect(rootChildren.children.length).toBe(2);
  });

  it('honours the collapsed flag on first paint, independent of depth or child count', () => {
    const node: DecodeNode = {
      label: 'root',
      children: [
        {
          label: 'a',
          value: 1,
          collapsed: true,
          children: [
            { label: 'a1', value: 1 },
            { label: 'a2', value: 2 },
          ],
        },
        { label: 'b', value: 2, children: [{ label: 'b1', value: 1 }] },
      ],
    };
    const el = ui().renderNode(node);
    const rootChildren = el.querySelector(':scope > .decode-tree-children')!;
    const rows = Array.from(rootChildren.children);
    expect(rows[0].querySelector(':scope > .decode-tree-children')?.classList.contains('decode-tree-collapsed')).toBe(
      true,
    );
    expect(rows[1].querySelector(':scope > .decode-tree-children')?.classList.contains('decode-tree-collapsed')).toBe(
      false,
    );
  });

  it('renders an error node styled distinctly from a warning node, and both when a node carries both', () => {
    const errEl = ui().renderNode({ label: 'e', error: 'boom' }).querySelector('.decode-tree-error');
    const warnEl = ui().renderNode({ label: 'w', warning: 'careful' }).querySelector('.decode-tree-warning');
    expect(errEl?.textContent).toBe('boom');
    expect(warnEl?.textContent).toBe('careful');
    expect(errEl?.className).not.toBe(warnEl?.className);

    const both = ui().renderNode({ label: 'both', error: 'boom', warning: 'careful' });
    expect(both.querySelector('.decode-tree-error')?.textContent).toBe('boom');
    expect(both.querySelector('.decode-tree-warning')?.textContent).toBe('careful');
  });

  it("renders a bigint value's full decimal digits, never exponential or truncated, against the handoff vector's integer", () => {
    const node: DecodeNode = { label: 'int', value: 448378203247n, display: 'int', raw: '448378203247' };
    const value = ui().renderNode(node).querySelector('.decode-tree-value');
    expect(value?.textContent).toBe('448378203247');
  });

  it("the display dispatch table's key set equals the declared display union exactly", () => {
    expect(new Set(ui().displayDispatchKeys())).toEqual(
      new Set(['address', 'txhash', 'hex', 'int', 'text', 'json', 'bool']),
    );
  });

  it("renders through each declared display mode's own entry", () => {
    const cases: { display: NonNullable<DecodeNode['display']>; raw: string }[] = [
      { display: 'int', raw: '5' },
      { display: 'text', raw: 'hello' },
      { display: 'json', raw: '{"a":1}' },
      { display: 'bool', raw: 'true' },
      { display: 'address', raw: '0x0000000000000000000000000000000000000001' },
    ];
    for (const { display, raw } of cases) {
      const value = ui().renderNode({ label: 'x', display, raw }).querySelector('.decode-tree-value');
      expect(value?.textContent).toBe(raw);
    }
  });

  it('renders through the default when a node carries no display mode', () => {
    const value = ui().renderNode({ label: 'x', value: 'plain' }).querySelector('.decode-tree-value');
    expect(value?.textContent).toBe('plain');
  });

  it('renders a provenance badge naming the value when present, and none when absent', () => {
    const badge = ui()
      .renderNode({ label: 'x', value: 1, provenance: 'verified' })
      .querySelector('.decode-provenance-badge');
    expect(badge?.textContent).toBe('Verified');
    expect(ui().renderNode({ label: 'y', value: 1 }).querySelector('.decode-provenance-badge')).toBeNull();
  });

  it('no branch anywhere in ui.ts tests a decoder id — every registered id is absent as a whole string literal', () => {
    const source = readFileSync(resolve(__dirname, '../src/dapps/decode/ui.ts'), 'utf-8');
    const literals = extractStringLiterals(source);
    const decoderIds = window.DxDecode!.registry!.list().map((d) => d.id);
    expect(decoderIds.length).toBeGreaterThan(0);
    for (const id of decoderIds) {
      expect(literals).not.toContain(id);
    }
  });

  it('renders decoded text that spells an element as literal text with no such element created', () => {
    const spelled = '<img src=x onerror=alert(1)>';
    const el = ui().renderNode({ label: 'x', value: spelled, display: 'text' });
    expect(el.querySelector('img')).toBeNull();
    expect(el.textContent).toContain(spelled);
  });

  it('the Result panel renders a non-empty explanation before any decode has run', () => {
    const { container, cleanup } = mount();
    expect(container.querySelector('#decode-tree')!.textContent?.trim().length).toBeGreaterThan(0);
    cleanup();
  });

  it('style.css defines no selector already present in src/styles/components.css', () => {
    const decodeCss = readFileSync(resolve(__dirname, '../src/dapps/decode/style.css'), 'utf-8');
    const sharedCss = readFileSync(resolve(__dirname, '../src/styles/components.css'), 'utf-8');
    const decodeSelectors = extractCssSelectors(decodeCss);
    const sharedSelectors = extractCssSelectors(sharedCss);
    const overlap = [...decodeSelectors].filter((s) => sharedSelectors.has(s));
    expect(overlap).toEqual([]);
  });
});

describe('copy-on-click, the keyboard shortcut, and auto-detect (Task 2)', () => {
  afterEach(() => {
    removeClipboard();
    vi.useRealTimers();
  });

  it("copies the node's underlying raw text rather than its value's own string form", async () => {
    const writeText = installClipboard(vi.fn(() => Promise.resolve()));
    const node: DecodeNode = { label: 'x', value: 42, raw: 'FULL-UNDERLYING-TEXT', display: 'int' };
    const el = ui().renderNode(node);
    document.body.append(el);
    const value = el.querySelector<HTMLButtonElement>('.decode-tree-value')!;
    expect(value.textContent).toBe('FULL-UNDERLYING-TEXT');
    value.click();
    await flush();
    expect(writeText).toHaveBeenCalledWith('FULL-UNDERLYING-TEXT');
    el.remove();
  });

  it('the value target is a button element, asserted on the tag rather than a class name', () => {
    const value = ui().renderNode({ label: 'x', value: 1 }).querySelector('.decode-tree-value');
    expect(value?.tagName).toBe('BUTTON');
  });

  it('copies the string "0" for a node whose value is the number zero, with confirmation', async () => {
    const writeText = installClipboard(vi.fn(() => Promise.resolve()));
    const node: DecodeNode = { label: 'x', value: 0, display: 'int' };
    const el = ui().renderNode(node);
    document.body.append(el);
    const row = el.querySelector('.decode-tree-row')!;
    el.querySelector<HTMLButtonElement>('.decode-tree-value')!.click();
    await flush();
    expect(writeText).toHaveBeenCalledWith('0');
    expect(row.classList.contains('decode-copied')).toBe(true);
    el.remove();
  });

  it('copies an empty string for a node whose value is the empty string, with confirmation', async () => {
    const writeText = installClipboard(vi.fn(() => Promise.resolve()));
    const node: DecodeNode = { label: 'x', value: '', display: 'text' };
    const el = ui().renderNode(node);
    document.body.append(el);
    const row = el.querySelector('.decode-tree-row')!;
    el.querySelector<HTMLButtonElement>('.decode-tree-value')!.click();
    await flush();
    expect(writeText).toHaveBeenCalledWith('');
    expect(row.classList.contains('decode-copied')).toBe(true);
    el.remove();
  });

  it('clicking a value with neither underlying text nor any value copies nothing and adds no confirmation', async () => {
    const writeText = installClipboard(vi.fn(() => Promise.resolve()));
    const node: DecodeNode = { label: 'x', warning: 'nothing here' };
    const el = ui().renderNode(node);
    document.body.append(el);
    const row = el.querySelector('.decode-tree-row')!;
    el.querySelector<HTMLButtonElement>('.decode-tree-value')!.click();
    await flush();
    expect(writeText).not.toHaveBeenCalled();
    expect(row.classList.contains('decode-copied')).toBe(false);
    el.remove();
  });

  it('two copies on the same row leave one live timer — the second confirmation survives its full duration', async () => {
    vi.useFakeTimers();
    installClipboard(vi.fn(() => Promise.resolve()));
    const el = ui().renderNode({ label: 'x', value: 1 });
    document.body.append(el);
    const row = el.querySelector('.decode-tree-row')!;
    const value = el.querySelector<HTMLButtonElement>('.decode-tree-value')!;

    value.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(row.classList.contains('decode-copied')).toBe(true);

    await vi.advanceTimersByTimeAsync(1000); // t=1000 — still inside the first copy's window
    value.click(); // second copy, at t=1000
    await vi.advanceTimersByTimeAsync(0);
    expect(row.classList.contains('decode-copied')).toBe(true);

    await vi.advanceTimersByTimeAsync(600); // t=1600 — past the FIRST copy's own 1500ms mark
    expect(row.classList.contains('decode-copied')).toBe(true); // still true: proves the first timer was cleared, not left to fire

    await vi.advanceTimersByTimeAsync(900); // t=2500 — the SECOND copy's own 1500ms mark
    expect(row.classList.contains('decode-copied')).toBe(false);

    el.remove();
  });

  it('falls back to revealing the full value in a selectable form when the clipboard is absent, with no false confirmation', async () => {
    removeClipboard();
    const { container, cleanup } = mount();
    const selector = container.querySelector<HTMLSelectElement>('#decode-selector')!;
    const textarea = container.querySelector<HTMLTextAreaElement>('#decode-textarea')!;
    const runBtn = container.querySelector<HTMLButtonElement>('#decode-run-btn')!;
    selector.value = 'hex';
    textarea.value = HEX_VECTOR;
    runBtn.click();
    await flush();

    const value = container.querySelector<HTMLButtonElement>('.decode-tree-value')!;
    const row = value.closest('.decode-tree-row')!;
    value.click();
    await flush();

    expect(row.classList.contains('decode-copied')).toBe(false);
    const reveal = container.querySelector<HTMLInputElement>('#decode-copy-reveal')!;
    expect(reveal.classList.contains('revealed')).toBe(true);
    expect(reveal.value.length).toBeGreaterThan(0);

    cleanup();
  });

  it('the cleanup closure clears a pending confirmation timer, so a copy immediately before unmount leaves nothing running', async () => {
    vi.useFakeTimers();
    installClipboard(vi.fn(() => Promise.resolve()));
    const { container, cleanup } = mount();
    const selector = container.querySelector<HTMLSelectElement>('#decode-selector')!;
    const textarea = container.querySelector<HTMLTextAreaElement>('#decode-textarea')!;
    const runBtn = container.querySelector<HTMLButtonElement>('#decode-run-btn')!;
    selector.value = 'hex';
    textarea.value = HEX_VECTOR;
    runBtn.click();
    await vi.advanceTimersByTimeAsync(0);

    const value = container.querySelector<HTMLButtonElement>('.decode-tree-value')!;
    value.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    cleanup();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('Ctrl+Enter runs the decode; a plain Enter does not', async () => {
    const { container, cleanup } = mount();
    const selector = container.querySelector<HTMLSelectElement>('#decode-selector')!;
    const textarea = container.querySelector<HTMLTextAreaElement>('#decode-textarea')!;
    selector.value = 'hex';
    textarea.value = HEX_VECTOR;

    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flush();
    expect(container.querySelector('#decode-tree')!.textContent).not.toContain('hello');

    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
    await flush();
    expect(container.querySelector('#decode-tree')!.textContent).toContain('hello');

    cleanup();
  });

  it('Cmd+Enter (metaKey) also runs the decode', async () => {
    const { container, cleanup } = mount();
    const selector = container.querySelector<HTMLSelectElement>('#decode-selector')!;
    const textarea = container.querySelector<HTMLTextAreaElement>('#decode-textarea')!;
    selector.value = 'hex';
    textarea.value = HEX_VECTOR;
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }));
    await flush();
    expect(container.querySelector('#decode-tree')!.textContent).toContain('hello');
    cleanup();
  });

  it('with Auto selected, pasting hex-shaped text resolves the decoder and names it in the badge', async () => {
    const { container, cleanup } = mount();
    const textarea = container.querySelector<HTMLTextAreaElement>('#decode-textarea')!;
    const badge = container.querySelector<HTMLElement>('#decode-auto-badge')!;
    simulatePasteInsert(textarea, HEX_VECTOR);
    await flush();
    expect(badge.textContent).toContain('Hex');
    cleanup();
  });

  it("when nothing clears the threshold, the badge shows the resolver's reason and the selection stays on Auto", async () => {
    const { container, cleanup } = mount();
    const selector = container.querySelector<HTMLSelectElement>('#decode-selector')!;
    const textarea = container.querySelector<HTMLTextAreaElement>('#decode-textarea')!;
    const badge = container.querySelector<HTMLElement>('#decode-auto-badge')!;
    simulatePasteInsert(textarea, '!!! not hex at all !!!');
    await flush();
    expect(badge.textContent).toMatch(/could ?n.?t identify/i);
    expect(selector.value).toBe('auto');
    cleanup();
  });

  it('with a real decoder selected, pasting does not change the selection and claims no detection', () => {
    const { container, cleanup } = mount();
    const selector = container.querySelector<HTMLSelectElement>('#decode-selector')!;
    const textarea = container.querySelector<HTMLTextAreaElement>('#decode-textarea')!;
    const badge = container.querySelector<HTMLElement>('#decode-auto-badge')!;
    selector.value = 'hex';
    selector.dispatchEvent(new Event('change'));
    dispatchPaste(textarea, HEX_VECTOR);
    expect(selector.value).toBe('hex');
    expect(badge.textContent).toBe('');
    cleanup();
  });

  it('re-selecting Auto restores detection on the next paste', async () => {
    const { container, cleanup } = mount();
    const selector = container.querySelector<HTMLSelectElement>('#decode-selector')!;
    const textarea = container.querySelector<HTMLTextAreaElement>('#decode-textarea')!;
    const badge = container.querySelector<HTMLElement>('#decode-auto-badge')!;
    selector.value = 'hex';
    selector.dispatchEvent(new Event('change'));
    selector.value = 'auto';
    selector.dispatchEvent(new Event('change'));
    simulatePasteInsert(textarea, HEX_VECTOR);
    await flush();
    expect(badge.textContent).toContain('Hex');
    cleanup();
  });

  it('pressing Decode while still unresolved in Auto runs a resolution first, so typed input still gets a result', async () => {
    const { container, cleanup } = mount();
    const textarea = container.querySelector<HTMLTextAreaElement>('#decode-textarea')!;
    const runBtn = container.querySelector<HTMLButtonElement>('#decode-run-btn')!;
    textarea.value = HEX_VECTOR; // typed, never pasted — no paste event fires
    runBtn.click();
    await flush();
    expect(container.querySelector('#decode-tree')!.textContent).toContain('hello');
    cleanup();
  });

  it('pasting an odd-length hex string with Auto selected resolves to hex, and Decode renders its error node', async () => {
    const { container, cleanup } = mount();
    const textarea = container.querySelector<HTMLTextAreaElement>('#decode-textarea')!;
    const runBtn = container.querySelector<HTMLButtonElement>('#decode-run-btn')!;
    const badge = container.querySelector<HTMLElement>('#decode-auto-badge')!;
    simulatePasteInsert(textarea, '0xfff');
    await flush();
    expect(badge.textContent).toContain('Hex');
    runBtn.click();
    await flush();
    expect(container.querySelector('#decode-tree')!.textContent).toMatch(/odd-length/i);
    cleanup();
  });

  // WR-04: resolvedAutoId used to be reset only on a selector change, so an in-place edit after
  // a successful paste left Decode running the STALE resolver id against unrelated text (with
  // one decoder registered, an odd "invalid hex" error; from Phase 4 on, silently the wrong
  // decoder — exactly what D-22/D-24 forbid).
  it('WR-04: editing the textarea after a paste invalidates the stale resolution, so Decode re-resolves', async () => {
    const { container, cleanup } = mount();
    const textarea = container.querySelector<HTMLTextAreaElement>('#decode-textarea')!;
    const runBtn = container.querySelector<HTMLButtonElement>('#decode-run-btn')!;
    const badge = container.querySelector<HTMLElement>('#decode-auto-badge')!;

    simulatePasteInsert(textarea, HEX_VECTOR);
    await flush();
    expect(badge.textContent).toContain('Hex');

    // An in-place edit away from the pasted hex — not a fresh paste — must invalidate the
    // resolution rather than leave Decode running hex against unrelated text.
    textarea.value = 'not hex at all';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    runBtn.click();
    await flush();

    expect(badge.textContent).toMatch(/could ?n.?t identify/i);
    cleanup();
  });

  // WR-04: the paste handler used to score the clipboard FRAGMENT alone, so a second paste
  // landing on top of existing content scored the wrong string — appending is the common case,
  // not replacing.
  it('WR-04: a second paste appended to existing content scores the combined value, not the fragment alone', async () => {
    const { container, cleanup } = mount();
    const textarea = container.querySelector<HTMLTextAreaElement>('#decode-textarea')!;
    const badge = container.querySelector<HTMLElement>('#decode-auto-badge')!;

    simulatePasteInsert(textarea, '!!!');
    await flush();
    expect(badge.textContent).toMatch(/could ?n.?t identify/i);

    // The garbage is still there — the COMBINED value must not resolve to Hex; scoring only
    // the fragment (a valid hex string on its own) would wrongly succeed.
    simulatePasteInsert(textarea, HEX_VECTOR);
    await flush();
    expect(textarea.value).toBe(`!!!${HEX_VECTOR}`);
    expect(badge.textContent).not.toContain('Hex');

    cleanup();
  });

  it('pressing Decode twice in quick succession leaves the tree showing only the second decode', async () => {
    const { container, cleanup } = mount();
    const selector = container.querySelector<HTMLSelectElement>('#decode-selector')!;
    const textarea = container.querySelector<HTMLTextAreaElement>('#decode-textarea')!;
    const runBtn = container.querySelector<HTMLButtonElement>('#decode-run-btn')!;
    selector.value = 'hex';

    textarea.value = '0x68656c6c6f';
    runBtn.click();
    textarea.value = '0xfff';
    runBtn.click();
    await flush();
    await flush();

    const treeText = container.querySelector('#decode-tree')!.textContent ?? '';
    expect(treeText).toMatch(/odd-length/i);
    expect(treeText).not.toContain('hello');

    cleanup();
  });

  it("drops a stale result by its typed stale flag, not by inspecting the result's text", async () => {
    let callCount = 0;
    const slowDecoder: DecoderPort = {
      id: 'slow',
      label: 'Slow',
      settings: [],
      canDecode: () => 1,
      decode: async (input) => {
        callCount += 1;
        const n = callCount;
        if (n === 1) await new Promise((r) => setTimeout(r, 20));
        return { node: { label: 'slow', value: `call-${n}-for-${input}` } };
      },
    };
    const isolatedRegistry: DecoderRegistry = {
      register() {},
      get: (id) => (id === slowDecoder.id ? slowDecoder : undefined),
      list: () => [slowDecoder],
      size: () => 1,
    };
    const originalRegistry = window.DxDecode!.registry;
    window.DxDecode!.registry = isolatedRegistry;

    const { container, cleanup } = mount();
    const selector = container.querySelector<HTMLSelectElement>('#decode-selector')!;
    const textarea = container.querySelector<HTMLTextAreaElement>('#decode-textarea')!;
    const runBtn = container.querySelector<HTMLButtonElement>('#decode-run-btn')!;

    selector.value = 'slow';
    textarea.value = 'first';
    runBtn.click();
    textarea.value = 'second';
    runBtn.click();
    await new Promise((r) => setTimeout(r, 50));

    const treeText = container.querySelector('#decode-tree')!.textContent ?? '';
    expect(treeText).toContain('call-2-for-second');
    expect(treeText).not.toContain('call-1-for-first');

    cleanup();
    window.DxDecode!.registry = originalRegistry;
  });

  it('the cleanup closure removes the keydown, paste and change listeners this task added', () => {
    const { container, cleanup } = mount();
    const textarea = container.querySelector<HTMLTextAreaElement>('#decode-textarea')!;
    const selector = container.querySelector<HTMLSelectElement>('#decode-selector')!;
    const removeTextareaSpy = vi.spyOn(textarea, 'removeEventListener');
    const removeSelectorSpy = vi.spyOn(selector, 'removeEventListener');

    cleanup();

    const textareaRemovedTypes = removeTextareaSpy.mock.calls.map((args) => args[0]);
    expect(textareaRemovedTypes).toEqual(expect.arrayContaining(['keydown', 'paste']));
    expect(removeSelectorSpy.mock.calls.map((args) => args[0])).toContain('change');
  });

  it('the cleanup closure aborts the current in-flight decode', async () => {
    let observedAborted = false;
    const abortAwareDecoder: DecoderPort = {
      id: 'abort-test',
      label: 'AbortTest',
      settings: [],
      canDecode: () => 1,
      decode: async (_input, ctx) => {
        await new Promise((r) => setTimeout(r, 20));
        observedAborted = ctx.signal.aborted;
        return { node: { label: 'x', value: 1 } };
      },
    };
    const isolatedRegistry: DecoderRegistry = {
      register() {},
      get: (id) => (id === abortAwareDecoder.id ? abortAwareDecoder : undefined),
      list: () => [abortAwareDecoder],
      size: () => 1,
    };
    const originalRegistry = window.DxDecode!.registry;
    window.DxDecode!.registry = isolatedRegistry;

    const { container, cleanup } = mount();
    const selector = container.querySelector<HTMLSelectElement>('#decode-selector')!;
    const textarea = container.querySelector<HTMLTextAreaElement>('#decode-textarea')!;
    const runBtn = container.querySelector<HTMLButtonElement>('#decode-run-btn')!;
    selector.value = 'abort-test';
    textarea.value = 'x';
    runBtn.click();

    cleanup();
    await new Promise((r) => setTimeout(r, 40));

    expect(observedAborted).toBe(true);
    window.DxDecode!.registry = originalRegistry;
  });
});

describe('the three tabs — Result, the Raw hex dump, and the Log tab (Task 3)', () => {
  afterEach(() => {
    window.DxDecode!.log!.clear();
  });

  it('renders bytes from the result contract, never by re-parsing a raw hex string', () => {
    const bytes = new Uint8Array([0x41, 0x42]); // 'AB'
    const el = ui().renderRaw(bytes, 'hex-dump');
    expect(el.textContent).toContain('41 42');
    expect(el.textContent).not.toContain('68 65'); // 'he' — proves no independent re-derivation
  });

  it('renders the empty state when rawBytes is null', () => {
    const el = ui().renderRaw(null, 'hex-dump');
    expect(el.className).toBe('decode-empty-message');
  });

  it('dispatches on rawView through a table, falling back to the hex dump for an unrecognised value', () => {
    const bytes = new Uint8Array([0xff]);
    const known = ui().renderRaw(bytes, 'hex-dump');
    const unknown = ui().renderRaw(bytes, 'some-future-view');
    expect(unknown.outerHTML).toBe(known.outerHTML);
    expect(ui().rawViewDispatchKeys()).toContain('hex-dump');
  });

  it('renders five bytes with their offsets and an ASCII gutter reading the decoded text, for the handoff vector', () => {
    const bytes = new Uint8Array([0x68, 0x65, 0x6c, 0x6c, 0x6f]); // 'hello'
    const el = ui().renderRaw(bytes, 'hex-dump');
    expect(el.textContent).toContain('00000000');
    expect(el.textContent).toContain('68 65 6c 6c 6f');
    expect(el.textContent).toContain('hello');
  });

  it('renders a byte outside the printable range as a placeholder character, never the control character itself', () => {
    const bytes = new Uint8Array([0x00, 0x41]);
    const el = ui().renderRaw(bytes, 'hex-dump');
    expect(el.querySelector('.decode-hexdump-ascii')?.textContent).toBe('.A');
  });

  it('renders bytes spelling an element as literal text in the gutter with no such element created', () => {
    const text = '<img>';
    const bytes = new Uint8Array(Array.from(text, (c) => c.charCodeAt(0)));
    const el = ui().renderRaw(bytes, 'hex-dump');
    expect(el.querySelector('img')).toBeNull();
    expect(el.textContent).toContain(text);
  });

  it("the Log empty state makes all three of D-17's claims, each asserted separately", () => {
    const text = ui().renderLog([]).textContent ?? '';
    expect(text).toMatch(/nothing has left this browser/i);
    expect(text).toMatch(/locally/i);
    expect(text).toMatch(/redacted/i);
  });

  it('renders a table with the handoff-named columns when entries exist', () => {
    const entries: LogEntry[] = [
      { timestamp: 0, method: 'GET', host: 'example.com', path: '/x', status: 200, duration: 12, attempt: 1 },
    ];
    const el = ui().renderLog(entries);
    expect(el.tagName).toBe('TABLE');
    expect(Array.from(el.querySelectorAll('th')).map((th) => th.textContent)).toEqual([
      'Time',
      'Method',
      'Host',
      'Path',
      'Status',
      'Duration',
      'Attempt',
    ]);
    expect(el.textContent).toContain('example.com');
  });

  it('mounting when the buffer already holds entries renders them immediately', () => {
    window.DxDecode!.log!.record({
      timestamp: 1,
      method: 'GET',
      host: 'h',
      path: '/p',
      status: 200,
      duration: 1,
      attempt: 1,
    });
    const { container, cleanup } = mount();
    expect(container.querySelector('#decode-log')!.textContent).toContain('/p');
    cleanup();
  });

  it('recording an entry updates the open Log tab without a further decode', () => {
    const { container, cleanup } = mount();
    const logTab = container.querySelector('#decode-log')!;
    expect(logTab.textContent).toMatch(/nothing has left this browser/i);
    window.DxDecode!.log!.record({
      timestamp: 1,
      method: 'GET',
      host: 'h',
      path: '/live',
      status: 200,
      duration: 1,
      attempt: 1,
    });
    expect(logTab.textContent).toContain('/live');
    cleanup();
  });

  it('two consecutive records leave both entries in the buffer; Clear empties it', () => {
    const { container, cleanup } = mount();
    const logTab = container.querySelector('#decode-log')!;
    const clearBtn = container.querySelector<HTMLButtonElement>('#decode-log-clear-btn')!;
    window.DxDecode!.log!.record({
      timestamp: 1,
      method: 'GET',
      host: 'h',
      path: '/one',
      status: 200,
      duration: 1,
      attempt: 1,
    });
    window.DxDecode!.log!.record({
      timestamp: 2,
      method: 'GET',
      host: 'h',
      path: '/two',
      status: 200,
      duration: 1,
      attempt: 1,
    });
    expect(logTab.textContent).toContain('/one');
    expect(logTab.textContent).toContain('/two');
    clearBtn.click();
    expect(logTab.textContent).toMatch(/nothing has left this browser/i);
    cleanup();
  });

  it('the cleanup closure unsubscribes from the log, so a second mount does not accumulate subscriptions', () => {
    let subscriberCount = 0;
    const stubLog: LogPort = {
      record() {},
      subscribe(cb) {
        subscriberCount += 1;
        cb([]);
        return () => {
          subscriberCount -= 1;
        };
      },
      clear() {},
    };
    const originalLog = window.DxDecode!.log;
    window.DxDecode!.log = stubLog;

    const first = mount();
    expect(subscriberCount).toBe(1);
    first.cleanup();
    expect(subscriberCount).toBe(0);

    const second = mount();
    expect(subscriberCount).toBe(1);
    second.cleanup();
    expect(subscriberCount).toBe(0);

    window.DxDecode!.log = originalLog;
  });
});
