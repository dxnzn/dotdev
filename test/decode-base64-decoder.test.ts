import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

// TXT-01's offline vector suite — same compiled-load idiom as test/decode-codecs.test.ts:
// `new Function('window', code)(window)` against the real jsdom `window`, then access through
// window.DxDecode.registry.get('base64').
function loadCompiled(relPath: string): void {
  const code = readFileSync(resolve(__dirname, relPath), 'utf-8');
  new Function('window', code)(window);
}

beforeAll(() => {
  loadCompiled('../src/dapps/decode/codecs.js');
  loadCompiled('../src/dapps/decode/core.js');
  loadCompiled('../src/dapps/decode/decoders.js');
  loadCompiled('../src/dapps/decode/decoders-base64.js');
});

// biome's noExplicitAny is disabled repo-wide (biome.json) — matches the cast every other
// compiled-module-boundary test in this repo already uses.
const codecs = () => (window as any).DxDecode.codecs;
const core = () => (window as any).DxDecode.core;
const base64Decoder = () => (window as any).DxDecode.registry.get('base64');

// handoff §7.5's two vectors.
const HELLO_VECTOR = 'aGVsbG8gd29ybGQ=';
const JSON_VECTOR = 'eyJhIjoxfQ';

describe('base64 decoder — handoff §7.5 vectors', () => {
  it('decodes the padded vector to a child valued exactly "hello world"', async () => {
    const output = await base64Decoder().decode(HELLO_VECTOR, {});
    expect(output.rawBytes?.length).toBe(11);
    const textChild = output.node.children.find((c: any) => c.label === 'text');
    expect(textChild.value).toBe('hello world');
  });

  it('decodes the unpadded url-alphabet vector into a json node with both a pretty-printed raw and per-key children', async () => {
    const output = await base64Decoder().decode(JSON_VECTOR, {});
    const jsonChild = output.node.children.find((c: any) => c.label === 'json');
    expect(jsonChild.raw).toBe('{\n  "a": 1\n}');
    expect(jsonChild.children).toHaveLength(1);
    expect(jsonChild.children[0].label).toBe('a');
    expect(jsonChild.children[0].value).toBe(1);
  });
});

describe('base64 decoder — non-UTF-8 and malformed payloads', () => {
  it('bytes that are not valid UTF-8 render as a hex child carrying a warning, never omitted', async () => {
    // 0xff 0xfe is not valid UTF-8.
    const invalidUtf8 = codecs().Base64.encodeUrl(new Uint8Array([0xff, 0xfe]));
    const output = await base64Decoder().decode(invalidUtf8, {});
    const hexChild = output.node.children.find((c: any) => c.label === 'hex');
    expect(hexChild).toBeDefined();
    expect(hexChild.raw).toMatch(/^0x/);
    expect(hexChild.warning).toMatch(/not valid UTF-8/i);
  });

  it('valid UTF-8 text starting with { that does not parse gets a root annotation, not a silent skip', async () => {
    const looksLikeJson = codecs().Base64.encodeUrl(new TextEncoder().encode('{not json'));
    const output = await base64Decoder().decode(looksLikeJson, {});
    expect(output.node.annotations).toContain('looks like JSON but did not parse');
  });

  it('a malformed mixed-alphabet payload resolves (never rejects) to a single error node with no children', async () => {
    await expect(base64Decoder().decode('abc+def-ghi_jkl', {})).resolves.toMatchObject({
      node: expect.objectContaining({ error: expect.any(String) }),
      rawBytes: null,
    });
    const output = await base64Decoder().decode('abc+def-ghi_jkl', {});
    expect(output.node.children).toBeUndefined();
  });
});

describe('base64 decoder — CR-01 pathological JSON nesting', () => {
  // Reproduces the review's exact shape: JSON.parse accepts arbitrary nesting, but the sibling
  // JSON.stringify used to build `raw` is recursive and threw RangeError past a few thousand
  // levels — bypassing jsonToNode's own JSON_WALK_MAX_DEPTH cap and breaking this decoder's
  // never-rejects claim. decode() itself must resolve, not reject, and the json node must carry
  // a warning in place of `raw` rather than silently losing the pretty-printed copy text.
  it('decode() resolves rather than rejecting on a 100,000-deep array, with a warning in place of raw', async () => {
    const pathological = codecs().Base64.encodeUrl(
      new TextEncoder().encode(`${'['.repeat(100000)}1${']'.repeat(100000)}`),
    );
    await expect(base64Decoder().decode(pathological, {})).resolves.toBeDefined();
    const output = await base64Decoder().decode(pathological, {});
    const jsonChild = output.node.children.find((c: any) => c.label === 'json');
    expect(jsonChild.raw).toBeUndefined();
    expect(jsonChild.warning).toMatch(/too deeply nested to pretty-print/);
  });
});

describe('base64 decoder — canDecode scoring', () => {
  it('scores 0 for empty input, hex-shaped input, and codec-rejected input', () => {
    expect(base64Decoder().canDecode('')).toBe(0);
    expect(base64Decoder().canDecode('deadbeef')).toBe(0);
    expect(base64Decoder().canDecode('0x68656c6c6f')).toBe(0);
  });

  it('scores strictly above AUTO_DETECT_THRESHOLD for both handoff §7.5 vectors', () => {
    expect(base64Decoder().canDecode(HELLO_VECTOR)).toBeGreaterThan(core().AUTO_DETECT_THRESHOLD);
    expect(base64Decoder().canDecode(JSON_VECTOR)).toBeGreaterThan(core().AUTO_DETECT_THRESHOLD);
  });

  // The positive-evidence rule, stated as a test rather than a comment: the codec ACCEPTS
  // these three prose inputs (proven in the same case) and the curve refuses them anyway.
  // Without the second assertion a later reader could mistake the zero scores for codec
  // rejection and delete the rule as redundant.
  it('scores 0 for ordinary prose that the codec nonetheless accepts as valid base64', () => {
    const prose = ['not hex at all', 'hello world', 'hellohello'];
    for (const input of prose) {
      expect(base64Decoder().canDecode(input)).toBe(0);
      expect(codecs().Base64.decode(input).ok).toBe(true);
    }
  });
});

describe('base64 decoder — auto-detect resolution', () => {
  it('resolves the base64 vector to base64, still resolves the hex vector to hex, and still fails to identify prose', () => {
    expect(core().resolve(HELLO_VECTOR).decoderId).toBe('base64');
    expect(core().resolve('0x68656c6c6f').decoderId).toBe('hex');
    expect(core().resolve('not hex at all').decoderId).toBeNull();
  });
});

describe('core.jsonToNode', () => {
  it('walks a nested object into one child per key', () => {
    const node = core().jsonToNode('root', { a: 1, b: { c: 2 } });
    expect(node.children).toHaveLength(2);
    expect(node.children[0].label).toBe('a');
    expect(node.children[0].value).toBe(1);
    expect(node.children[1].label).toBe('b');
    expect(node.children[1].children[0].label).toBe('c');
  });

  it('walks an array into bracketed index labels', () => {
    const node = core().jsonToNode('root', [10, 20]);
    expect(node.children.map((c: any) => c.label)).toEqual(['[0]', '[1]']);
    expect(node.children[0].value).toBe(10);
  });

  it('turns a scalar into a leaf whose value and raw are the scalar and its string form, including null', () => {
    const strNode = core().jsonToNode('s', 'hi');
    expect(strNode.value).toBe('hi');
    expect(strNode.raw).toBe('hi');

    const numNode = core().jsonToNode('n', 42);
    expect(numNode.value).toBe(42);
    expect(numNode.raw).toBe('42');

    const nullNode = core().jsonToNode('z', null);
    expect(nullNode.value).toBeNull();
    expect(nullNode.raw).toBe('null');
    expect(nullNode.children).toBeUndefined();
  });

  it('a boolean leaf carries display "bool" and a STRING value, never the primitive', () => {
    const node = core().jsonToNode('b', true);
    expect(node.display).toBe('bool');
    expect(typeof node.value).toBe('string');
    expect(node.value).toBe('true');
    expect(node.raw).toBe('true');
  });

  it('WR-01: an integer past Number.MAX_SAFE_INTEGER carries a warning naming the loss, not a silently rounded value', () => {
    // JSON.parse has already rounded this by the time the walker sees it — the leaf still
    // carries whatever number/string JSON.parse produced, but now flagged rather than silent.
    const node = core().jsonToNode('id', JSON.parse('12345678901234567890'));
    expect(Number.isSafeInteger(node.value)).toBe(false);
    expect(node.warning).toMatch(/exceeds 2\^53/);

    // A safe integer must NOT carry the warning — this is a boundary check, not a blanket flag.
    const safeNode = core().jsonToNode('n', Number.MAX_SAFE_INTEGER);
    expect(safeNode.warning).toBeUndefined();
  });

  it('a tree nested past the depth cap returns rather than overflowing, with a warning naming the limit', () => {
    let deep: any = { leaf: 'bottom' };
    for (let i = 0; i < 40; i++) {
      deep = { nested: deep };
    }
    expect(() => core().jsonToNode('root', deep)).not.toThrow();
    const node = core().jsonToNode('root', deep);

    let cursor = node;
    let deepest = node;
    while (cursor.children && cursor.children.length > 0) {
      cursor = cursor.children[0];
      deepest = cursor;
    }
    expect(deepest.warning).toMatch(/nested deeper than \d+ levels/i);
  });
});
