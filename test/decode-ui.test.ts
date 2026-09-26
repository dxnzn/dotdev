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

// Task 2 (04-01): the manifest's own `dependencies` array IS the module load list — deriving it
// here, rather than restating it as a literal, means this suite proves the browser's real load
// order works and never needs its own beforeAll edited again as this phase adds decoders. Each
// entry is a path relative to `src/` (e.g. `dapps/decode/codecs.js`); this suite loads relative
// to `test/`, so `../src/` is prepended.
function loadManifestDependencies(): string[] {
  const manifest = JSON.parse(readFileSync(resolve(__dirname, '../src/dapps/decode/manifest.json'), 'utf-8')) as {
    dependencies: string[];
  };
  return manifest.dependencies.map((dep) => `../src/${dep}`);
}

// The tracer's proof — handoff §7.5 / TXT-02's verified vector.
const HEX_VECTOR = '0x68656c6c6f';

function mount(dx: unknown = {}): { container: HTMLElement; cleanup: () => void } {
  const container = document.createElement('div');
  container.innerHTML = loadTemplate();
  document.body.append(container);
  const cleanup = (window.DxDecode!.ui!.init as (c: HTMLElement, dx: unknown) => () => void)(container, dx);
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
  // This plan's (05-04) own additions to DxDecodeUiTestHooks.
  createShellSettingsPort: (dx: unknown) => { get(key: string): unknown };
  renderLogDetail: (entry: LogEntry) => HTMLElement;
  logEntriesToJson: (entries: LogEntry[]) => string;
  logEntryToCurl: (entry: LogEntry) => string;
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
  for (const relPath of loadManifestDependencies()) {
    loadCompiled(relPath);
  }
});

afterEach(() => {
  document.body.replaceChildren();
});

describe('decode dapp — end-to-end tracer (0x68656c6c6f -> hello)', () => {
  it('populates the decoder select from the registry, Auto first, sourced from the registry rather than markup', () => {
    const { container, cleanup } = mount();
    const options = Array.from(container.querySelectorAll<HTMLOptionElement>('#decode-selector option'));
    const registry = window.DxDecode!.registry!;

    // Guard against the case passing vacuously — an empty registry would satisfy the
    // options-equal-registry assertion below trivially.
    expect(registry.size()).toBeGreaterThanOrEqual(2);
    expect(registry.list().map((d) => d.id)).toEqual(expect.arrayContaining(['hex', 'base64']));

    expect(options[0].value).toBe('auto');
    expect(options[0].textContent).toBe('Auto');
    // The real claim: the select mirrors the registry, in registration order, which under
    // manifest-derived loading is manifest order — not a literal restated here that goes stale
    // on every new decoder.
    expect(options.slice(1).map((o) => o.value)).toEqual(registry.list().map((d) => d.id));
    expect(options.length).toBe(registry.size() + 1);
    // hex is still first in registration order — a label assertion, not a list pin.
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

describe('ETH-10/ETH-11 — the link affordance and the full-value hover title (05-06 Task 1)', () => {
  afterEach(() => {
    removeClipboard();
  });

  const FULL_ADDRESS = '0x5e58ba0e06ed0f5558f83be732a4b899a674053e';
  const SHORT_ADDRESS = '0x5e58ba0e...674053e';
  const FULL_TXHASH = `0x${'ab'.repeat(32)}`;
  const SHORT_TXHASH = '0xabababab...ababab';

  it('renders an anchor as a SIBLING following the value button, never inside it', () => {
    const node: DecodeNode = {
      label: 'to',
      type: 'address',
      display: 'address',
      value: SHORT_ADDRESS,
      raw: FULL_ADDRESS,
      link: `https://etherscan.io/address/${FULL_ADDRESS}`,
      linkKind: 'external',
    };
    const el = ui().renderNode(node);
    const row = el.querySelector('.decode-tree-row')!;
    expect(row.querySelector('button.decode-tree-value a')).toBeNull();
    const anchor = row.querySelector('a');
    expect(anchor).not.toBeNull();
    expect(anchor!.parentElement).toBe(row);
    expect(anchor!.getAttribute('href')).toBe(node.link);
  });

  it('an external link carries rel="noopener noreferrer" and opens in a new context; a route link carries neither', () => {
    const external = ui()
      .renderNode({
        label: 'x',
        display: 'address',
        value: SHORT_ADDRESS,
        raw: FULL_ADDRESS,
        link: 'https://etherscan.io/address/x',
        linkKind: 'external',
      })
      .querySelector('a')!;
    expect(external.getAttribute('rel')).toBe('noopener noreferrer');
    expect(external.getAttribute('target')).toBe('_blank');

    const route = ui()
      .renderNode({ label: 'y', value: null, warning: 'note', link: '/settings', linkKind: 'route' })
      .querySelector('a')!;
    expect(route.getAttribute('rel')).toBeNull();
    expect(route.getAttribute('target')).toBeNull();
  });

  it('CR-01: a route link is composed as a navigable in-shell hash route, never the bare manifest path', () => {
    const route = ui()
      .renderNode({ label: 'y', value: null, warning: 'note', link: '/settings', linkKind: 'route' })
      .querySelector('a')!;
    expect(route.getAttribute('href')).toBe('#/settings');
  });

  it('CR-01: a route value that already carries a leading "#" is not double-prefixed', () => {
    const route = ui()
      .renderNode({ label: 'y', value: null, warning: 'note', link: '#/settings', linkKind: 'route' })
      .querySelector('a')!;
    expect(route.getAttribute('href')).toBe('#/settings');
  });

  it('a node with no link renders no anchor at all', () => {
    const el = ui().renderNode({ label: 'x', display: 'address', value: SHORT_ADDRESS, raw: FULL_ADDRESS });
    expect(el.querySelector('a')).toBeNull();
  });

  it('an address node whose rendered text is shortened exposes the unshortened 42-character value on hover, comparing against the same string the copy handler writes', () => {
    const node: DecodeNode = { label: 'x', display: 'address', value: SHORT_ADDRESS, raw: FULL_ADDRESS };
    const valueBtn = ui().renderNode(node).querySelector('.decode-tree-value') as HTMLElement;
    expect(valueBtn.textContent).toBe(SHORT_ADDRESS);
    expect(valueBtn.title).toBe(FULL_ADDRESS);
  });

  it("the same assertion for a txhash node's 66-character raw, and the anchor carries that title too when a link is rendered", () => {
    const node: DecodeNode = {
      label: 'x',
      display: 'txhash',
      value: SHORT_TXHASH,
      raw: FULL_TXHASH,
      link: `https://etherscan.io/tx/${FULL_TXHASH}`,
      linkKind: 'external',
    };
    const el = ui().renderNode(node);
    const valueBtn = el.querySelector('.decode-tree-value') as HTMLElement;
    const anchor = el.querySelector('a') as HTMLAnchorElement;
    expect(valueBtn.title).toBe(FULL_TXHASH);
    expect(anchor.title).toBe(FULL_TXHASH);
  });

  it('a node whose rendered text equals its underlying text has NO title attribute at all', () => {
    const valueBtn = ui()
      .renderNode({ label: 'x', display: 'int', value: 5n, raw: '5' })
      .querySelector('.decode-tree-value') as HTMLElement;
    expect(valueBtn.hasAttribute('title')).toBe(false);
  });

  it('a link on a non-shortened node (e.g. the DEC-13 settings-route sentence) carries no title', () => {
    const anchor = ui()
      .renderNode({
        label: 'y',
        value: null,
        raw: 'the full decode payload, unrelated to the sentence',
        link: '/settings',
        linkKind: 'route',
      })
      .querySelector('a') as HTMLAnchorElement;
    expect(anchor.hasAttribute('title')).toBe(false);
  });

  it('clicking the value button still copies the full raw, never the shortened display text', async () => {
    const writeText = installClipboard(vi.fn(() => Promise.resolve()));
    const node: DecodeNode = { label: 'x', display: 'address', value: SHORT_ADDRESS, raw: FULL_ADDRESS };
    const el = ui().renderNode(node);
    document.body.append(el);
    el.querySelector<HTMLButtonElement>('.decode-tree-value')!.click();
    await flush();
    expect(writeText).toHaveBeenCalledWith(FULL_ADDRESS);
    el.remove();
  });

  it('the display dispatch table still has exactly seven entries', () => {
    expect(ui().displayDispatchKeys()).toHaveLength(7);
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
    //
    // 04-01: this input is also load-bearing for the base64 curve specifically, not just for
    // this WR-04 case. codecs.ts strips whitespace before any alphabet check, so
    // `nothexatall` is accepted by Base64.decode — the base64 decoder's positive-evidence rule
    // (no padding, no distinguishing char, not valid UTF-8) is what keeps this resolving to
    // "couldn't identify" instead of a Base64 badge. Do not relax this into a hex-only
    // regression check.
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

  // TXT-05 (D-08's raw-view registration) — the word-table Raw view, added this plan as one
  // new RAW_VIEW_DISPATCH entry beside 'hex-dump'. `rawViewDispatchKeys()` below already picks
  // up this new key automatically (it now runs against a registry containing `abi-words`,
  // since the beforeAll load list is manifest-derived — see this file's header comment); these
  // cases are additive, not a rewrite of the hex-dump suite above. Nested inside the enclosing
  // describe so the afterEach (log clearing) still applies uniformly.
  describe('the Raw word table (04-04, TXT-05)', () => {
    function hexToBytes(hex: string): Uint8Array {
      const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
      const bytes = new Uint8Array(clean.length / 2);
      for (let i = 0; i < bytes.length; i++) {
        bytes[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
      }
      return bytes;
    }

    // handoff §7.1's mintFromMoloch inner call — the same REAL-1 vector this plan's decoder suite
    // (test/decode-abi-words-decoder.test.ts) pins: a 4-byte selector and two 32-byte words.
    const REAL_1_BYTES = hexToBytes(
      '0x2806b0af' +
        '0000000000000000000000005e58ba0e06ed0f5558f83be732a4b899a674053e' +
        '0000000000000000000000000000000000000000000000000de0b6b3a7640000',
    );

    it('rawViewDispatchKeys contains both hex-dump and word-table, and exactly two entries', () => {
      const keys = ui().rawViewDispatchKeys();
      expect(keys).toEqual(expect.arrayContaining(['hex-dump', 'word-table']));
      expect(keys).toHaveLength(2);
    });

    it('renders REAL-1 as three rows — selector, word 0, word 1 — with the expected offsets and hex', () => {
      const el = ui().renderRaw(REAL_1_BYTES, 'word-table');
      const rows = Array.from(el.querySelectorAll('tr'));
      expect(rows).toHaveLength(3);
      const offsets = rows.map((r) => r.querySelector('.decode-wordtable-offset')?.textContent);
      expect(offsets).toEqual(['00000000', '00000004', '00000024']);
      expect(rows[0].querySelector('.decode-wordtable-word')?.textContent).toBe('2806b0af');
      expect(rows[1].querySelector('.decode-wordtable-word')?.textContent).toBe(
        '0000000000000000000000005e58ba0e06ed0f5558f83be732a4b899a674053e',
      );
    });

    it('renders a payload with no selector shape starting at offset 00000000 with no selector row', () => {
      const bytes = hexToBytes(`0x${'c3'.repeat(32)}${'d4'.repeat(32)}`);
      const el = ui().renderRaw(bytes, 'word-table');
      const rows = Array.from(el.querySelectorAll('tr'));
      expect(rows).toHaveLength(2);
      expect(rows[0].querySelector('.decode-wordtable-offset')?.textContent).toBe('00000000');
    });

    it('renders a bare 4-byte payload as one row with no selector row — matching the decoder side of the same predicate', () => {
      const bytes = hexToBytes('0xdeadbeef');
      const el = ui().renderRaw(bytes, 'word-table');
      const rows = Array.from(el.querySelectorAll('tr'));
      expect(rows).toHaveLength(1);
      expect(rows[0].querySelector('.decode-wordtable-offset')?.textContent).toBe('00000000');
    });

    it('falls back to the hex dump for an unrecognised rawView, proving the fallback is intact', () => {
      const bytes = new Uint8Array([0xff]);
      const el = ui().renderRaw(bytes, 'nonsense-key');
      expect(el.className).toBe('decode-hexdump');
    });

    it('renders the empty state, not a table, when rawBytes is null', () => {
      const el = ui().renderRaw(null, 'word-table');
      expect(el.className).toBe('decode-empty-message');
    });

    // The cross-AI review's second HIGH finding: this table has no ASCII column (unlike
    // renderHexDump), so hostile bytes can never appear here as visible literal text — only as
    // hex digits. Asserted accordingly: no element created, the expected hex/offsets are present,
    // and no cell's text contains an angle bracket — never "the markup renders as text", which is
    // unpassable for this renderer by design. Do not "fix" this case to match the hex-dump
    // precedent; that precedent relies on a column this table deliberately does not have.
    it('renders hostile bytes as hex only — no element created, no angle bracket in any cell', () => {
      const text = '<img src=x onerror=alert(1)>';
      const bytes = new Uint8Array(Array.from(text, (c) => c.charCodeAt(0)));
      const expectedHex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

      const el = ui().renderRaw(bytes, 'word-table');
      expect(el.querySelector('img')).toBeNull();

      const cells = Array.from(el.querySelectorAll('td'));
      const combinedText = cells.map((c) => c.textContent).join('');
      expect(combinedText).not.toContain('<');
      expect(combinedText).not.toContain('>');
      expect(el.querySelector('.decode-wordtable-word')?.textContent).toBe(expectedHex);
    });

    it('emits no annotation text — cells carry offsets and hex only', () => {
      const el = ui().renderRaw(REAL_1_BYTES, 'word-table');
      const text = el.textContent ?? '';
      expect(text).not.toMatch(/like|small int|large int|zero word/);
    });
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

// ── Task 1: createShellSettingsPort / real LinkPort wiring ───────────────────────────────────

describe('createShellSettingsPort — resolving a bare key by scanning getSections() (Task 1)', () => {
  function stubDx(sections: { id: string; definitions: { key: string }[] }[], store: Record<string, unknown>) {
    return {
      settings: {
        getSections: () => sections,
        get: (sectionId: string, key: string) => store[`${sectionId}\0${key}`],
      },
    };
  }

  it('resolves a key by scanning, from a section id invented for the test (not a real plugin id)', () => {
    const dx = stubDx([{ id: 'not-a-real-plugin-id', definitions: [{ key: 'chainId' }] }], {
      'not-a-real-plugin-id\0chainId': 11155111,
    });
    expect(ui().createShellSettingsPort(dx).get('chainId')).toBe(11155111);
  });

  it('the same key resolves the same value from a DIFFERENT section id — the id genuinely does not matter', () => {
    const dxA = stubDx([{ id: 'section-a', definitions: [{ key: 'chainId' }] }], { 'section-a\0chainId': 1 });
    const dxB = stubDx([{ id: 'section-b', definitions: [{ key: 'chainId' }] }], { 'section-b\0chainId': 1 });
    expect(ui().createShellSettingsPort(dxA).get('chainId')).toBe(1);
    expect(ui().createShellSettingsPort(dxB).get('chainId')).toBe(1);
  });

  it('a key no section declares returns undefined', () => {
    const dx = stubDx([{ id: 'section-a', definitions: [{ key: 'chainId' }] }], {});
    expect(ui().createShellSettingsPort(dx).get('etherscanApiKey')).toBeUndefined();
  });

  it('a host with no settings member returns undefined rather than throwing', () => {
    expect(() => ui().createShellSettingsPort({}).get('chainId')).not.toThrow();
    expect(ui().createShellSettingsPort({}).get('chainId')).toBeUndefined();
  });

  it('a host whose settings.getSections is not a function returns undefined rather than throwing', () => {
    const dx = { settings: { getSections: 'nope', get: () => 1 } };
    expect(() => ui().createShellSettingsPort(dx).get('chainId')).not.toThrow();
    expect(ui().createShellSettingsPort(dx).get('chainId')).toBeUndefined();
  });

  it('a null host returns undefined rather than throwing', () => {
    expect(() => ui().createShellSettingsPort(null).get('chainId')).not.toThrow();
    expect(ui().createShellSettingsPort(null).get('chainId')).toBeUndefined();
  });

  it('when two sections both declare the same key, the FIRST one in getSections() order wins', () => {
    const dx = stubDx(
      [
        { id: 'first', definitions: [{ key: 'chainId' }] },
        { id: 'second', definitions: [{ key: 'chainId' }] },
      ],
      { 'first\0chainId': 'from-first', 'second\0chainId': 'from-second' },
    );
    expect(ui().createShellSettingsPort(dx).get('chainId')).toBe('from-first');
  });

  it('no plugin section id (e.g. "ethereum") appears as a string literal in ui.ts', () => {
    const source = readFileSync(resolve(__dirname, '../src/dapps/decode/ui.ts'), 'utf-8');
    const literals = extractStringLiterals(source);
    expect(literals).not.toContain('ethereum');
  });
});

describe('createLiveExplorerLinks — real LinkPort wiring, read per call, never at mount (Task 1)', () => {
  const LINK_PROBE_ID = 'test-link-probe-05-04';

  beforeAll(() => {
    // A temporary decoder that calls ctx.links.address(...) — no first-wave decoder does yet
    // (that's a Phase 5/6 decorator's job), so this is the only way to observe the LinkPort
    // createDecodeService actually wires, end to end, without exporting the internal factory
    // (createLiveExplorerLinks is deliberately NOT one of DxDecodeUiTestHooks' members).
    window.DxDecode!.registry!.register({
      id: LINK_PROBE_ID,
      label: 'link probe',
      settings: [],
      canDecode: () => 0,
      decode: async (_input, ctx) => {
        const link = ctx.links.address('0xabc');
        return { node: { label: 'probe', value: link ?? 'none', raw: link ?? 'none' } };
      },
    });
  });

  function stubChainDx(initial: unknown) {
    let chainId = initial;
    return {
      dx: {
        settings: {
          getSections: () => [{ id: 'some-section', definitions: [{ key: 'chainId' }] }],
          get: (_sectionId: string, key: string) => (key === 'chainId' ? chainId : undefined),
        },
      },
      setChainId(next: unknown) {
        chainId = next;
      },
    };
  }

  async function runProbe(container: HTMLElement): Promise<string> {
    container.querySelector<HTMLSelectElement>('#decode-selector')!.value = LINK_PROBE_ID;
    container.querySelector<HTMLTextAreaElement>('#decode-textarea')!.value = 'anything';
    container.querySelector<HTMLButtonElement>('#decode-run-btn')!.click();
    await flush();
    return container.querySelector('#decode-tree')!.textContent ?? '';
  }

  it('returns an explorer url for a known chain id supplied as the string form settings actually store', async () => {
    const { dx } = stubChainDx('1');
    const { container, cleanup } = mount(dx);
    const text = await runProbe(container);
    expect(text).toContain('etherscan.io');
    expect(text).toContain('0xabc');
    cleanup();
  });

  it('returns null (rendered as "none") for an unset chain id', async () => {
    const { dx } = stubChainDx(undefined);
    const { container, cleanup } = mount(dx);
    const text = await runProbe(container);
    expect(text).toContain('none');
    cleanup();
  });

  it('returns null (rendered as "none") for a chain id the table does not contain', async () => {
    const { dx } = stubChainDx(999999);
    const { container, cleanup } = mount(dx);
    const text = await runProbe(container);
    expect(text).toContain('none');
    cleanup();
  });

  it('follows a chain change WITHOUT a remount — the same mounted instance, decoded twice', async () => {
    const { dx, setChainId } = stubChainDx(1);
    const { container, cleanup } = mount(dx);

    const first = await runProbe(container);
    expect(first).toContain('etherscan.io');
    expect(first).not.toContain('sepolia');

    setChainId(11155111);
    const second = await runProbe(container);
    expect(second).toContain('sepolia.etherscan.io');
    expect(second).not.toBe(first);

    cleanup();
  });
});

// ── Task 2: expandable log rows, live while a decode runs ────────────────────────────────────

describe('Log row expansion — the full request and response, live while a decode runs (Task 2)', () => {
  afterEach(() => {
    window.DxDecode!.log!.clear();
  });

  function baseEntry(overrides: Partial<LogEntry> = {}): LogEntry {
    return {
      timestamp: 1,
      method: 'GET',
      host: 'api.example.com',
      path: '/x',
      status: 200,
      duration: 5,
      attempt: 1,
      ...overrides,
    };
  }

  it('each summary row carries a disclosure with aria-expanded initially false and aria-controls pointing at its own detail row', () => {
    const el = ui().renderLog([baseEntry()]);
    const disclosure = el.querySelector<HTMLButtonElement>('.decode-log-disclosure')!;
    expect(disclosure.getAttribute('aria-expanded')).toBe('false');
    const controlsId = disclosure.getAttribute('aria-controls')!;
    expect(el.querySelector(`#${controlsId}`)).not.toBeNull();
  });

  it('clicking the disclosure reveals the detail region; clicking again hides it', () => {
    const el = ui().renderLog([baseEntry({ url: 'https://api.example.com/x?a=1' })]);
    const disclosure = el.querySelector<HTMLButtonElement>('.decode-log-disclosure')!;
    const detailId = disclosure.getAttribute('aria-controls')!;
    const detail = el.querySelector<HTMLElement>(`#${detailId}`)!;

    expect(detail.hidden).toBe(true);
    disclosure.click();
    expect(detail.hidden).toBe(false);
    expect(detail.textContent).toContain('https://api.example.com/x?a=1');
    disclosure.click();
    expect(detail.hidden).toBe(true);
  });

  it('an entry with no request body produces a detail region with one fewer row, and no stringified missing value', () => {
    const withBody = ui().renderLogDetail(baseEntry({ url: 'https://x', requestBody: '{"a":1}' }));
    const withoutBody = ui().renderLogDetail(baseEntry({ url: 'https://x' }));
    const rowCount = (el: HTMLElement) => el.querySelectorAll('.decode-log-detail-field').length;
    expect(rowCount(withoutBody)).toBe(rowCount(withBody) - 1);
    expect(withoutBody.textContent).not.toMatch(/undefined|null/);
  });

  it('requestHeaders render as one row per header, with the redaction sentinel intact', () => {
    const el = ui().renderLogDetail(
      baseEntry({ requestHeaders: { Authorization: '[redacted]', Accept: 'application/json' } }),
    );
    const fields = Array.from(el.querySelectorAll('.decode-log-detail-field'));
    expect(fields.length).toBe(2);
    expect(el.textContent).toContain('Authorization');
    expect(el.textContent).toContain('[redacted]');
    expect(el.textContent).toContain('Accept');
    expect(el.textContent).toContain('application/json');
  });

  it('a response body longer than LOG_BODY_PREVIEW_BYTES renders truncated with its full byte count stated, shorter than the body', () => {
    const longBody = 'x'.repeat(5000);
    const el = ui().renderLogDetail(baseEntry({ responseBody: longBody }));
    const value = el.querySelector('.decode-log-detail-value')!.textContent ?? '';
    expect(value.length).toBeLessThan(longBody.length);
    expect(value).toContain('5000 bytes total');
  });

  it('a short response body renders in full, untruncated', () => {
    const shortBody = 'ok';
    const el = ui().renderLogDetail(baseEntry({ responseBody: shortBody }));
    expect(el.querySelector('.decode-log-detail-value')!.textContent).toBe(shortBody);
  });

  it('two entries with identical timestamp, attempt and url expand independently', () => {
    const a = baseEntry({ url: 'https://x/dup' });
    const b = baseEntry({ url: 'https://x/dup' });
    const el = ui().renderLog([a, b]);
    const disclosures = Array.from(el.querySelectorAll<HTMLButtonElement>('.decode-log-disclosure'));
    expect(disclosures.length).toBe(2);
    disclosures[0].click();
    expect(disclosures[0].getAttribute('aria-expanded')).toBe('true');
    expect(disclosures[1].getAttribute('aria-expanded')).toBe('false');
  });

  it('re-rendering after a new entry arrives leaves a previously expanded row expanded', () => {
    const { container, cleanup } = mount();
    window.DxDecode!.log!.record(baseEntry({ path: '/one' }));
    const disclosure = container.querySelector<HTMLButtonElement>('.decode-log-disclosure')!;
    disclosure.click();
    expect(disclosure.getAttribute('aria-expanded')).toBe('true');

    window.DxDecode!.log!.record(baseEntry({ path: '/two', timestamp: 2 }));
    const disclosuresAfter = Array.from(container.querySelectorAll<HTMLButtonElement>('.decode-log-disclosure'));
    expect(disclosuresAfter.length).toBe(2);
    // The first entry (path /one) was recorded first — oldest-first ordering means it's still first.
    expect(disclosuresAfter[0].getAttribute('aria-expanded')).toBe('true');
    expect(disclosuresAfter[1].getAttribute('aria-expanded')).toBe('false');
    cleanup();
  });

  it('recording three entries in sequence repaints #decode-log three times — the live-update path', () => {
    const { container, cleanup } = mount();
    const logEl = container.querySelector('#decode-log')!;
    const spy = vi.spyOn(logEl, 'replaceChildren');
    for (let i = 0; i < 3; i++) {
      window.DxDecode!.log!.record(baseEntry({ path: `/r${i}`, timestamp: i }));
    }
    expect(spy).toHaveBeenCalledTimes(3);
    cleanup();
  });

  it('the Clear button still empties the table and returns the empty state', () => {
    const { container, cleanup } = mount();
    window.DxDecode!.log!.record(baseEntry());
    container.querySelector<HTMLButtonElement>('#decode-log-clear-btn')!.click();
    expect(container.querySelector('#decode-log')!.textContent).toMatch(/nothing has left this browser/i);
    cleanup();
  });
});

// ── Task 3: Copy as JSON and Copy as cURL ─────────────────────────────────────────────────────

describe('logEntriesToJson / logEntryToCurl — pure serializers reading only the redacted entry (Task 3)', () => {
  function entry(overrides: Partial<LogEntry> = {}): LogEntry {
    return {
      timestamp: 1,
      method: 'GET',
      host: 'api.etherscan.io',
      path: '/api',
      status: 200,
      duration: 5,
      attempt: 1,
      ...overrides,
    };
  }

  it('logEntriesToJson round-trips to an array of the same length, every field present', () => {
    const entries = [entry(), entry({ path: '/api2' })];
    const parsed = JSON.parse(ui().logEntriesToJson(entries));
    expect(parsed.length).toBe(2);
    expect(parsed[0].host).toBe('api.etherscan.io');
  });

  it('a redacted url survives the JSON round trip byte for byte', () => {
    const redactedUrl = 'https://api.etherscan.io/api?module=x&apikey=[redacted]';
    const parsed = JSON.parse(ui().logEntriesToJson([entry({ url: redactedUrl })]));
    expect(parsed[0].url).toBe(redactedUrl);
  });

  it('Copy as JSON on an empty log produces an empty array rather than throwing', () => {
    expect(() => ui().logEntriesToJson([])).not.toThrow();
    expect(JSON.parse(ui().logEntriesToJson([]))).toEqual([]);
  });

  it('logEntryToCurl names the method and wraps the url in single quotes', () => {
    const out = ui().logEntryToCurl(entry({ url: 'https://api.etherscan.io/api?module=x' }));
    expect(out).toContain('-X GET');
    expect(out).toContain("'https://api.etherscan.io/api?module=x'");
  });

  it("a redacted url fixture — the sentinel appears in both serializers' output", () => {
    const redactedUrl = 'https://api.etherscan.io/api?module=x&apikey=[redacted]';
    const e = entry({ url: redactedUrl });
    expect(ui().logEntriesToJson([e])).toContain('[redacted]');
    expect(ui().logEntryToCurl(e)).toContain('[redacted]');
  });

  it('a redacted Authorization header appears in both outputs, name and sentinel', () => {
    const e = entry({ requestHeaders: { Authorization: '[redacted]' } });
    expect(ui().logEntriesToJson([e])).toContain('Authorization');
    expect(ui().logEntriesToJson([e])).toContain('[redacted]');
    const curl = ui().logEntryToCurl(e);
    expect(curl).toContain("-H 'Authorization: [redacted]'");
  });

  it('an entry with no requestHeaders produces no -H argument', () => {
    expect(ui().logEntryToCurl(entry())).not.toContain('-H');
  });

  it('a url containing a single quote is emitted escaped, with balanced quoting', () => {
    const out = ui().logEntryToCurl(entry({ url: "https://example.com/it's" }));
    expect(out).toContain("https://example.com/it'\\''s");
    // Balanced: an even number of unescaped-context single quotes framing each segment —
    // proven concretely by round-tripping the exact escaped substring above.
  });

  it('neither serializer re-derives from anywhere else — mutating the fixture changes both outputs', () => {
    const e = entry({ url: 'https://original' });
    const before = { json: ui().logEntriesToJson([e]), curl: ui().logEntryToCurl(e) };
    e.url = 'https://mutated';
    const after = { json: ui().logEntriesToJson([e]), curl: ui().logEntryToCurl(e) };
    expect(before.json).not.toBe(after.json);
    expect(after.json).toContain('https://mutated');
    expect(after.curl).toContain('https://mutated');
  });
});

describe('Copy as JSON / Copy as cURL — button wiring (Task 3)', () => {
  afterEach(() => {
    window.DxDecode!.log!.clear();
    removeClipboard();
  });

  it('#decode-tab-log contains exactly three buttons: Clear, Copy as JSON, Copy as cURL, plus the reveal field', () => {
    const { container, cleanup } = mount();
    const logTab = container.querySelector('#decode-tab-log')!;
    const buttons = Array.from(logTab.querySelectorAll('button'));
    expect(buttons.map((b) => b.textContent)).toEqual(['Clear', 'Copy as JSON', 'Copy as cURL']);
    expect(logTab.querySelector('#decode-log-copy-reveal')).not.toBeNull();
    cleanup();
  });

  it('both buttons route through the existing clipboard helper', async () => {
    const writeText = installClipboard(vi.fn().mockResolvedValue(undefined));
    const { container, cleanup } = mount();
    window.DxDecode!.log!.record({
      timestamp: 1,
      method: 'GET',
      host: 'h',
      path: '/x',
      status: 200,
      duration: 1,
      attempt: 1,
    });
    container.querySelector<HTMLButtonElement>('#decode-log-copy-json-btn')!.click();
    await flush();
    expect(writeText).toHaveBeenCalledTimes(1);
    container.querySelector<HTMLButtonElement>('#decode-log-copy-curl-btn')!.click();
    await flush();
    expect(writeText).toHaveBeenCalledTimes(2);
    cleanup();
    removeClipboard();
  });

  it('a clipboard failure with the Log tab active reveals the payload inside #decode-tab-log, never the Result panel field', async () => {
    removeClipboard();
    const { container, cleanup } = mount();
    container.querySelector<HTMLButtonElement>('[data-tab="log"]')!.click();
    window.DxDecode!.log!.record({
      timestamp: 1,
      method: 'GET',
      host: 'h',
      path: '/x',
      status: 200,
      duration: 1,
      attempt: 1,
    });
    container.querySelector<HTMLButtonElement>('#decode-log-copy-json-btn')!.click();
    await flush();

    const revealed = container.querySelector<HTMLInputElement>('#decode-log-copy-reveal')!;
    expect(revealed.value).not.toBe('');
    expect(revealed.closest('#decode-tab-log')).not.toBeNull();

    const resultReveal = container.querySelector<HTMLInputElement>('#decode-copy-reveal')!;
    expect(resultReveal.value).toBe('');

    cleanup();
  });
});

// ── 05-05 Task 3: the composition root — real in the shipped dapp, not only in a test double ──

describe('composition root — real transport, registry adapters and settingsRoute (Task 3)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  // Deliberately unseeded (test/decode-autodetect.test.ts's own D-27 negative-case selector) —
  // signatures.ts's local table has never heard of it, so resolving it MUST reach the network.
  const UNSEEDED_SELECTOR = '0x1509b894';
  const UNSEEDED_CALLDATA = `${UNSEEDED_SELECTOR}${'0'.repeat(64)}`;

  function stubOpenChainHit(): ReturnType<typeof vi.fn> {
    const body = {
      ok: true,
      result: {
        function: {
          [UNSEEDED_SELECTOR]: [{ name: 'noSuchFunctionSeeded(uint256)', filtered: false, hasVerifiedContract: true }],
        },
        event: {},
      },
    };
    const fetchMock = vi.fn(() => Promise.resolve(new Response(JSON.stringify(body), { status: 200 })));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  async function runDecodeAndFlush(container: HTMLElement, decoderId: string, input: string): Promise<void> {
    container.querySelector<HTMLSelectElement>('#decode-selector')!.value = decoderId;
    container.querySelector<HTMLTextAreaElement>('#decode-textarea')!.value = input;
    container.querySelector<HTMLButtonElement>('#decode-run-btn')!.click();
    await flush();
  }

  it('an unknown selector resolves through the real composition root: exactly one lookup request, provenance registry — reached through init(), not a hand-built DecodeContext', async () => {
    const fetchMock = stubOpenChainHit();
    const { container, cleanup } = mount();

    await runDecodeAndFlush(container, 'eth-calldata', UNSEEDED_CALLDATA);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const tree = container.querySelector('#decode-tree')!;
    expect(tree.querySelector('.decode-provenance-badge')?.textContent).toBe('Registry');
    cleanup();
  });

  it('the same mount records at least one #decode-log row for that request, with a method, host and status', async () => {
    stubOpenChainHit();
    const { container, cleanup } = mount();

    await runDecodeAndFlush(container, 'eth-calldata', UNSEEDED_CALLDATA);

    const logContainer = container.querySelector('#decode-log')!;
    const rows = logContainer.querySelectorAll('.decode-log-summary-row');
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0].textContent).toContain('GET');
    expect(rows[0].textContent).toContain('api.openchain.xyz');
    expect(rows[0].textContent).toContain('200');
    cleanup();
  });

  it('a network primitive failing on every attempt: the decode still completes, the node is unresolved with lookup-unavailable wording, the Log tab shows the attempts, and nothing rejects', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(() => Promise.reject(new Error('boom')));
    vi.stubGlobal('fetch', fetchMock);
    const { container, cleanup } = mount();

    let rejected = false;
    const decodePromise = runDecodeAndFlush(container, 'eth-calldata', UNSEEDED_CALLDATA).catch(() => {
      rejected = true;
    });
    // Both adapters (OpenChain then 4byte) retry up to NET_MAX_ATTEMPTS with backoff — advance
    // generously past both sequences; advancing past completion is harmless.
    for (let i = 0; i < 16; i++) {
      await vi.advanceTimersByTimeAsync(5000);
    }
    await decodePromise;

    expect(rejected).toBe(false);
    const tree = container.querySelector('#decode-tree')!;
    expect(tree.querySelector('.decode-provenance-badge')?.textContent).toBe('Unresolved');
    expect(tree.textContent).toMatch(/unavailable/i);

    const rows = container.querySelector('#decode-log')!.querySelectorAll('.decode-log-summary-row');
    expect(rows.length).toBeGreaterThan(0);
    cleanup();
  });

  // handoff §7.1's mintFromMoloch literal — same locally-seeded selector (0x2806b0af) 05-01's
  // own eth-calldata suite already uses. Local to this describe block since decode-ui.test.ts
  // does not otherwise need a decodable eth-calldata vector.
  const LOCAL_SELECTOR_CALLDATA =
    '0x2806b0af' +
    '0000000000000000000000005e58ba0e06ed0f5558f83be732a4b899a674053e' +
    '0000000000000000000000000000000000000000000000000de0b6b3a7640000';

  it('with no settings at all, a locally-known selector still decodes with provenance local and issues NO request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { container, cleanup } = mount({});

    await runDecodeAndFlush(container, 'eth-calldata', LOCAL_SELECTOR_CALLDATA);

    expect(fetchMock).not.toHaveBeenCalled();
    const tree = container.querySelector('#decode-tree')!;
    expect(tree.querySelector('.decode-provenance-badge')?.textContent).toBe('Local');
    cleanup();
  });

  // Each test below registers its OWN probe id — the registry (window.DxDecode.registry) is
  // loaded once for the whole file (beforeAll) and register() no-ops on a duplicate id, so a
  // shared id across tests would silently keep the FIRST test's closure and never call the
  // later ones' decode functions.
  it("the DecodeContext the mounted service builds carries a transport, a signatures and a settingsRoute — asserted through a decoder double, not by inspecting ui.ts's internals", async () => {
    const probeId = 'composition-probe-05-05-ctx';
    let capturedCtx: DecodeContext | undefined;
    window.DxDecode!.registry!.register({
      id: probeId,
      label: 'composition probe',
      settings: [],
      canDecode: () => 0,
      decode: async (_input, ctx) => {
        capturedCtx = ctx;
        return { node: { label: 'probe' } };
      },
    });

    const dx = { getManifests: () => [{ id: 'settings', route: '/tools/settings' }] };
    const { container, cleanup } = mount(dx);
    await runDecodeAndFlush(container, probeId, 'anything');

    expect(capturedCtx?.transport).toBeDefined();
    expect(capturedCtx?.signatures).toBeDefined();
    expect(capturedCtx?.settingsRoute).toBe('/tools/settings');
    cleanup();
  });

  it('settingsRoute is absent (never throws) for a stub host with no settings dapp', async () => {
    const probeId = 'composition-probe-05-05-noroute';
    let capturedCtx: DecodeContext | undefined;
    window.DxDecode!.registry!.register({
      id: probeId,
      label: 'composition probe',
      settings: [],
      canDecode: () => 0,
      decode: async (_input, ctx) => {
        capturedCtx = ctx;
        return { node: { label: 'probe' } };
      },
    });

    const { container, cleanup } = mount({});
    await expect(runDecodeAndFlush(container, probeId, 'anything')).resolves.not.toThrow();

    expect(capturedCtx?.settingsRoute).toBeUndefined();
    cleanup();
  });

  it('the transport is constructed ONCE per mount, not once per decode — two decodes in one mount observe the SAME transport instance', async () => {
    const probeId = 'composition-probe-05-05-once';
    const refs: (TransportPort | undefined)[] = [];
    window.DxDecode!.registry!.register({
      id: probeId,
      label: 'composition probe',
      settings: [],
      canDecode: () => 0,
      decode: async (_input, ctx) => {
        refs.push(ctx.transport);
        return { node: { label: 'probe' } };
      },
    });

    const { container, cleanup } = mount();
    await runDecodeAndFlush(container, probeId, 'first');
    await runDecodeAndFlush(container, probeId, 'second');

    expect(refs).toHaveLength(2);
    expect(refs[0]).toBeDefined();
    expect(refs[0]).toBe(refs[1]);
    cleanup();
  });

  it('the one shared transport instance actually enforces one token bucket: a fourth rapid lookup is deferred behind the first three', async () => {
    const probeId = 'composition-probe-05-05-bucket';
    const fetchMock = vi.fn(() => Promise.resolve(new Response('{}', { status: 200 })));
    vi.stubGlobal('fetch', fetchMock);

    let capturedTransport: TransportPort | undefined;
    window.DxDecode!.registry!.register({
      id: probeId,
      label: 'composition probe',
      settings: [],
      canDecode: () => 0,
      decode: async (_input, ctx) => {
        capturedTransport = ctx.transport;
        return { node: { label: 'probe' } };
      },
    });

    // Prime with a REAL-timer decode first — flush() uses setTimeout internally, and fake
    // timers must not be active yet or that setTimeout never advances on its own.
    const { container, cleanup } = mount();
    await runDecodeAndFlush(container, probeId, 'anything');
    expect(capturedTransport).toBeDefined();

    vi.useFakeTimers();

    // Four rapid lookups against the SAME captured transport instance, none awaited between —
    // the default rate is 3/sec (etherscanRps's own documented default, D-08/D-12), so the
    // fourth must be deferred behind the token bucket rather than firing immediately.
    for (let i = 0; i < 4; i++) {
      capturedTransport!.request({ method: 'GET', url: `https://example.test/burst-${i}`, dedupe: false });
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock.mock.calls.length).toBe(3);

    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchMock.mock.calls.length).toBe(4);

    cleanup();
  });
});
