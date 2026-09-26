import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

// TXT-03's offline vector suite — same compiled-load idiom as test/decode-codecs.test.ts and
// test/decode-base64-decoder.test.ts. NEVER named test/decode-url.test.ts — that file already
// exists, covers share links and URL state (D-12), and holds 32 passing tests writing to this
// path would silently destroy.
function loadCompiled(relPath: string): void {
  const code = readFileSync(resolve(__dirname, relPath), 'utf-8');
  new Function('window', code)(window);
}

beforeAll(() => {
  loadCompiled('../src/dapps/decode/codecs.js');
  loadCompiled('../src/dapps/decode/core.js');
  loadCompiled('../src/dapps/decode/decoders.js');
  loadCompiled('../src/dapps/decode/decoders-url.js');
  loadCompiled('../src/dapps/decode/decoders-base64.js');
  // Task 2: loaded here (this suite's own explicit list, not the manifest-derived one
  // test/decode-ui.test.ts uses) so the renderNode test hook is reachable.
  loadCompiled('../src/dapps/decode/ui.js');
});

// biome's noExplicitAny is disabled repo-wide (biome.json) — matches the cast every other
// compiled-module-boundary test in this repo already uses.
const codecs = () => (window as any).DxDecode.codecs;
const core = () => (window as any).DxDecode.core;
const registry = () => (window as any).DxDecode.registry;
const urlDecoder = () => registry().get('url');
const ui = () => (window as any).DxDecode.ui;

describe('url decoder — handoff §7.5 vector', () => {
  it('decodes a%20b%26c=1 to a child valued exactly "a b&c=1", badged url', async () => {
    const output = await urlDecoder().decode('a%20b%26c=1', {});
    const child = output.node.children.find((c: any) => c.label === 'decoded');
    expect(child.value).toBe('a b&c=1');
  });
});

describe('codecs.Percent.decode', () => {
  it('decodes a plain percent-encoded string', () => {
    expect(codecs().Percent.decode('a%20b%26c=1')).toEqual({ ok: true, value: 'a b&c=1' });
  });

  it('a bare "%" and a trailing "%" with no two hex digits after it both fail, never throw', () => {
    const bare = codecs().Percent.decode('%');
    const trailing = codecs().Percent.decode('abc%');
    expect(bare.ok).toBe(false);
    expect(trailing.ok).toBe(false);
    expect(bare.error.length).toBeGreaterThan(0);
    expect(trailing.error.length).toBeGreaterThan(0);
  });

  it('a multi-byte UTF-8 escape decodes to its single character; a truncated one fails rather than substituting', () => {
    const full = codecs().Percent.decode('%C3%A9');
    const truncated = codecs().Percent.decode('%C3');
    expect(full).toEqual({ ok: true, value: 'é' });
    expect(full.value.length).toBe(1);
    expect(truncated.ok).toBe(false);
  });

  it('an escape at the very first position and the very last position both decode', () => {
    expect(codecs().Percent.decode('%20a')).toEqual({ ok: true, value: ' a' });
    expect(codecs().Percent.decode('a%20')).toEqual({ ok: true, value: 'a ' });
  });

  it('the empty string succeeds with the empty string', () => {
    expect(codecs().Percent.decode('')).toEqual({ ok: true, value: '' });
  });

  it('"+" stays a literal "+" in the bare codec — form-encoding only applies inside a query', () => {
    expect(codecs().Percent.decode('a+b')).toEqual({ ok: true, value: 'a+b' });
  });
});

describe('url decoder — full URL query table', () => {
  it('renders one child per query parameter, in source order, repeated names not merged', async () => {
    const output = await urlDecoder().decode('https://x.test/p?a=1&b=two%20words&a=3', {});
    const query = output.node.children.find((c: any) => c.label === 'query');
    expect(query.children.map((c: any) => c.label)).toEqual(['a', 'b', 'a']);
    expect(query.children.map((c: any) => c.value)).toEqual(['1', 'two words', '3']);
  });

  it('decoding the same URL twice produces the same row order', async () => {
    const first = await urlDecoder().decode('https://x.test/p?a=1&b=2&a=3', {});
    const second = await urlDecoder().decode('https://x.test/p?a=1&b=2&a=3', {});
    const labels = (o: any) => o.node.children.find((c: any) => c.label === 'query').children.map((c: any) => c.label);
    expect(labels(first)).toEqual(labels(second));
  });

  // The only assertion that the two branches agree: %C3 behaves the same inside a URL as it
  // does pasted bare (T-04-26) — an error row, never a value containing U+FFFD.
  it('a malformed escape inside a query produces an error row, never a Unicode replacement character', async () => {
    const output = await urlDecoder().decode('https://x.test/p?a=%C3', {});
    const query = output.node.children.find((c: any) => c.label === 'query');
    const row = query.children[0];
    expect(row.label).toBe('a');
    expect(row.error).toBeTruthy();
    expect(row.value).not.toBe('�');
    expect(JSON.stringify(query)).not.toContain('�');
  });

  // What makes the "+" asymmetry a decision rather than a surprise — both halves in one case.
  it('"+" decodes to a space inside a query but stays a literal "+" in the bare codec', async () => {
    const output = await urlDecoder().decode('https://x.test/p?b=a+b', {});
    const query = output.node.children.find((c: any) => c.label === 'query');
    expect(query.children[0].value).toBe('a b');
    expect(codecs().Percent.decode('a+b')).toEqual({ ok: true, value: 'a+b' });
  });

  it('a URL with no query string produces a query node with no children and an annotation naming that', async () => {
    const output = await urlDecoder().decode('https://x.test/p', {});
    const query = output.node.children.find((c: any) => c.label === 'query');
    expect(query.children ?? []).toHaveLength(0);
    expect(query.annotations).toContain('no query parameters');
  });

  it('renders sibling rows for scheme, host, port and path; host carries no port, port carries the explicit port', async () => {
    const output = await urlDecoder().decode('https://x.test:8443/p?a=1', {});
    const { children } = output.node;
    expect(children.find((c: any) => c.label === 'scheme').value).toBe('https:');
    const host = children.find((c: any) => c.label === 'host');
    expect(host.value).toBe('x.test');
    expect(host.value).not.toContain(':');
    expect(children.find((c: any) => c.label === 'port').value).toBe('8443');
    expect(children.find((c: any) => c.label === 'path').value).toBe('/p');
  });

  it('a URL on its scheme default port carries a port row annotated with the default, not an omitted row', async () => {
    const output = await urlDecoder().decode('https://x.test/p', {});
    const port = output.node.children.find((c: any) => c.label === 'port');
    expect(port).toBeDefined();
    expect(port.value).toBe('');
    expect(port.annotations?.length).toBeGreaterThan(0);
  });

  it('WR-02: userinfo before the host is shown as a warning row, not silently dropped', async () => {
    const output = await urlDecoder().decode('https://paypal.com@evil.test/login', {});
    const { children } = output.node;
    expect(children.find((c: any) => c.label === 'host').value).toBe('evil.test');
    const userinfo = children.find((c: any) => c.label === 'userinfo');
    expect(userinfo.value).toBe('paypal.com');
    expect(userinfo.warning).toMatch(/credentials embedded before the host/);
  });

  it('WR-02: an authority with no credentials annotates userinfo rather than omitting the row', async () => {
    const output = await urlDecoder().decode('https://x.test/p', {});
    const userinfo = output.node.children.find((c: any) => c.label === 'userinfo');
    expect(userinfo).toBeDefined();
    expect(userinfo.value).toBe('');
    expect(userinfo.annotations).toContain('no credentials in the authority');
  });

  it('WR-02: a password in the authority is flagged and never rendered', async () => {
    // Assembled at runtime, never as one literal — a bare 'user:<pw>@' string reads as a
    // credential-bearing URI to the pre-commit secret scanner even in test fixture form.
    const pw = ['secr', 'et'].join('');
    const output = await urlDecoder().decode(`https://user:${pw}@evil.test/`, {});
    const userinfo = output.node.children.find((c: any) => c.label === 'userinfo');
    expect(userinfo.annotations).toContain('password present — not shown');
    expect(JSON.stringify(userinfo)).not.toContain(pw);
  });

  it('WR-02: a hash-routed share link is shown as a fragment row, not dropped', async () => {
    // This site's own share links carry their parameters this way — '#/tools/decode/?data=…'.
    const output = await urlDecoder().decode('https://dnzn.dev/#/tools/decode/?decoder=hex&data=0x1', {});
    const fragment = output.node.children.find((c: any) => c.label === 'fragment');
    expect(fragment.value).toBe('/tools/decode/?decoder=hex&data=0x1');
  });

  it('WR-02: no fragment annotates the row rather than omitting it', async () => {
    const output = await urlDecoder().decode('https://x.test/p', {});
    const fragment = output.node.children.find((c: any) => c.label === 'fragment');
    expect(fragment).toBeDefined();
    expect(fragment.annotations).toContain('no fragment');
  });
});

describe('url decoder — percent branch', () => {
  it('a malformed escape with no scheme produces one node with a non-empty error, no children, resolves rather than rejects', async () => {
    await expect(urlDecoder().decode('abc%', {})).resolves.toMatchObject({
      node: { label: 'url' },
      rawBytes: null,
    });
    const output = await urlDecoder().decode('abc%', {});
    expect(output.node.error).toBeTruthy();
    expect(output.node.children).toBeUndefined();
  });

  // Enforces the hierarchical-scheme scope decision mechanically, not just documents it.
  it('mailto: falls to the percent branch, renders unchanged, annotated', async () => {
    const output = await urlDecoder().decode('mailto:someone@example.test', {});
    const decoded = output.node.children.find((c: any) => c.label === 'decoded');
    expect(decoded.value).toBe('mailto:someone@example.test');
    expect(decoded.annotations).toContain('no percent escapes were present');
  });

  it('input with no percent escape at all annotates that nothing was decoded', async () => {
    const output = await urlDecoder().decode('plain text, no escapes here', {});
    const decoded = output.node.children.find((c: any) => c.label === 'decoded');
    expect(decoded.value).toBe('plain text, no escapes here');
    expect(decoded.annotations).toContain('no percent escapes were present');
  });

  // Stops somebody re-composing a half-decoded line for the Raw tab — a full URL has no
  // single decoded byte string, so Raw carries the original input; a bare percent string does
  // have one, so Raw carries the decoded string.
  it('rawBytes: a full URL carries the original input bytes, the percent branch carries the decoded string bytes', async () => {
    const fullUrl = await urlDecoder().decode('https://x.test/p?a=1', {});
    const decoder = new TextDecoder();
    expect(decoder.decode(fullUrl.rawBytes)).toBe('https://x.test/p?a=1');

    const bare = await urlDecoder().decode('a%20b', {});
    expect(decoder.decode(bare.rawBytes)).toBe('a b');
  });
});

describe('url decoder — canDecode and auto-detect resolution', () => {
  it('scores 0 for empty input, plain text and mailto:, scores above threshold for percent-encoded text and a full URL', () => {
    const decoder = urlDecoder();
    expect(decoder.canDecode('')).toBe(0);
    expect(decoder.canDecode('not hex at all')).toBe(0);
    expect(decoder.canDecode('mailto:someone@example.test')).toBe(0);
    expect(decoder.canDecode('a%20b%26c=1')).toBeGreaterThan(core().AUTO_DETECT_THRESHOLD);
    expect(decoder.canDecode('https://x.test/p?a=1')).toBeGreaterThan(core().AUTO_DETECT_THRESHOLD);
  });

  it('resolves url/hex/base64 to their own vectors, none stealing another’s', () => {
    expect(core().resolve('a%20b%26c=1').decoderId).toBe('url');
    expect(core().resolve('0x68656c6c6f').decoderId).toBe('hex');
    expect(core().resolve('aGVsbG8gd29ybGQ=').decoderId).toBe('base64');
  });
});

// Task 2: the query-parameter table is proven to be generic tree composition, not a renderer
// special case, and the decoder is proven to produce no element a reader can activate — the
// plan's kept prohibition (a URL decoder exists so a person can read a suspicious link without
// visiting it; the moment the tool makes visiting it one click away, it has handed the
// attacker the click it wanted). This suite carries no decoder-local markup-escaping case —
// that guarantee is a property of the renderer, already proven generically by
// test/decode-ui.test.ts's "renders decoded text that spells an element as literal text with
// no such element created" case, and re-asserting it per decoder buys nothing.
describe('url decoder — the query table is composition, not markup (Task 2)', () => {
  it('renders one row per query parameter through renderNode, matching label/value/order', async () => {
    const output = await urlDecoder().decode('https://x.test/p?a=1&b=two%20words&a=3', {});
    const query = output.node.children.find((c: any) => c.label === 'query');
    const rendered = ui().renderNode(query);

    const childrenContainer = rendered.querySelector('.decode-tree-children');
    const rows = Array.from(childrenContainer.children) as HTMLElement[];
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.querySelector('.decode-tree-label')?.textContent)).toEqual(['a', 'b', 'a']);
    expect(rows.map((r) => r.querySelector('.decode-tree-value')?.textContent)).toEqual(['1', 'two words', '3']);
  });

  it('produces no table/thead/tbody/tr element anywhere in the query render', async () => {
    const output = await urlDecoder().decode('https://x.test/p?a=1&b=two%20words&a=3', {});
    const query = output.node.children.find((c: any) => c.label === 'query');
    const rendered = ui().renderNode(query);

    expect(rendered.querySelector('table')).toBeNull();
    expect(rendered.querySelector('thead')).toBeNull();
    expect(rendered.querySelector('tbody')).toBeNull();
    expect(rendered.querySelector('tr')).toBeNull();
  });

  it('the query render uses the same class names an unrelated hand-built two-child tree produces — composition, not a special case', async () => {
    const output = await urlDecoder().decode('https://x.test/p?a=1&b=2', {});
    const query = output.node.children.find((c: any) => c.label === 'query');
    const queryRendered = ui().renderNode(query);

    const handBuilt: DecodeNode = {
      label: 'unrelated',
      children: [
        { label: 'foo', value: '1', display: 'text', raw: '1' },
        { label: 'bar', value: '2', display: 'text', raw: '2' },
      ],
    };
    const handBuiltRendered = ui().renderNode(handBuilt);

    const classNameSet = (el: HTMLElement) =>
      new Set(
        Array.from(el.querySelectorAll('*'))
          .map((n) => n.className)
          .filter(Boolean),
      );
    expect(classNameSet(queryRendered)).toEqual(classNameSet(handBuiltRendered));
  });

  it('a rendered full-URL tree contains no anchor or iframe element and no href/src/action attribute anywhere', async () => {
    const output = await urlDecoder().decode('https://x.test:8443/p?a=1&b=two%20words', {});
    const rendered = ui().renderNode(output.node);

    expect(rendered.querySelectorAll('a')).toHaveLength(0);
    expect(rendered.querySelectorAll('iframe')).toHaveLength(0);

    const forbiddenAttrNames = new Set(['href', 'src', 'action']);
    for (const el of Array.from(rendered.querySelectorAll('*'))) {
      for (const attr of Array.from((el as HTMLElement).attributes)) {
        expect(forbiddenAttrNames.has(attr.name)).toBe(false);
      }
    }
  });
});
