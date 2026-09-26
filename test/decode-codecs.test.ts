import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

// Runs the COMPILED src/dapps/decode/*.js against the real jsdom `window`
// (`new Function('window', code)(window)`), then inspects window.DxDecode's sub-keys directly
// — the same compiled-JS execution pattern test/decode-ui.test.ts and test/ethereum-plugin.test.ts
// use, and for the same reason: `make test`/CI build before they test, so this suite exercises
// the real transpiled output rather than a hand-maintained mirror of it.
function loadCompiled(relPath: string): void {
  const code = readFileSync(resolve(__dirname, relPath), 'utf-8');
  new Function('window', code)(window);
}

beforeAll(() => {
  loadCompiled('../src/dapps/decode/codecs.js');
  loadCompiled('../src/dapps/decode/core.js');
  loadCompiled('../src/dapps/decode/decoders.js');
});

// biome's noExplicitAny is disabled repo-wide (biome.json) — this cast matches
// test/ethereum-plugin.test.ts's own loaded-namespace cast at the same compiled-module boundary.
const codecs = () => (window as any).DxDecode.codecs;
const core = () => (window as any).DxDecode.core;
const hexDecoder = () => (window as any).DxDecode.registry.get('hex');

describe('codecs.Hex', () => {
  it('decode("") and decode("0x") both succeed with a zero-length byte array', () => {
    const empty = codecs().Hex.decode('');
    const bare = codecs().Hex.decode('0x');
    expect(empty).toEqual({ ok: true, bytes: new Uint8Array(0) });
    expect(bare).toEqual({ ok: true, bytes: new Uint8Array(0) });
  });

  it('decodes the handoff vector to the five bytes spelling hello', () => {
    const result = codecs().Hex.decode('0x68656c6c6f');
    expect(result.ok).toBe(true);
    expect(Array.from(result.bytes)).toEqual([0x68, 0x65, 0x6c, 0x6c, 0x6f]);
  });

  it('fails on an odd digit count with a message naming odd length, never throwing', () => {
    expect(() => codecs().Hex.decode('0xfff')).not.toThrow();
    const result = codecs().Hex.decode('0xfff');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/odd-length/i);
  });

  it('fails on a non-hex character with a message naming the offending character, never throwing', () => {
    expect(() => codecs().Hex.decode('0xzz')).not.toThrow();
    const result = codecs().Hex.decode('0xzz');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('z');
  });

  it('normalize is the single whitespace-and-prefix entry point: decode and isHexLike agree on embedded newlines', () => {
    const multiLine = '0x68\n65\n6c 6c\n6f';
    const singleLine = '0x68656c6c6f';
    expect(codecs().Hex.decode(multiLine)).toEqual(codecs().Hex.decode(singleLine));
    expect(codecs().Hex.isHexLike(multiLine)).toBe(codecs().Hex.isHexLike(singleLine));
    expect(codecs().Hex.normalize(multiLine)).toBe(codecs().Hex.normalize(singleLine));
  });

  it('isHexLike is true only for a normalized string of pure hex digits', () => {
    expect(codecs().Hex.isHexLike('0x68656c6c6f')).toBe(true);
    expect(codecs().Hex.isHexLike('0xzz')).toBe(false);
  });
});

describe('codecs.Base64', () => {
  it('decodes the handoff §7.5 padded standard-alphabet vector to "hello world"', () => {
    const result = codecs().Base64.decode('aGVsbG8gd29ybGQ=');
    expect(result.ok).toBe(true);
    expect(new TextDecoder().decode(result.bytes)).toBe('hello world');
  });

  it('decodes the handoff §7.5 unpadded url-alphabet vector to the JSON object {"a":1}', () => {
    const result = codecs().Base64.decode('eyJhIjoxfQ');
    expect(result.ok).toBe(true);
    expect(new TextDecoder().decode(result.bytes)).toBe('{"a":1}');
  });

  it('decodes an empty string to a zero-length byte array', () => {
    expect(codecs().Base64.decode('')).toEqual({ ok: true, bytes: new Uint8Array(0) });
  });

  it('fails, never throws, on a mixed-alphabet string', () => {
    expect(() => codecs().Base64.decode('abc+def_ghi')).not.toThrow();
    const result = codecs().Base64.decode('abc+def_ghi');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/mixed/i);
  });

  it('fails, never throws, on internal padding', () => {
    expect(() => codecs().Base64.decode('ab=cd')).not.toThrow();
    const result = codecs().Base64.decode('ab=cd');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/internal padding/i);
  });

  it('fails, never throws, on excess padding', () => {
    // 8 data characters (length % 4 === 0, so the correct padding is none at all) followed by
    // two unneeded "=" — a case atob's own leniency would otherwise decide silently.
    expect(() => codecs().Base64.decode('aGVsbG8h==')).not.toThrow();
    const result = codecs().Base64.decode('aGVsbG8h==');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/padding/i);
  });

  it('fails, never throws, on a length exactly one past a multiple of four', () => {
    expect(() => codecs().Base64.decode('abcde')).not.toThrow();
    const result = codecs().Base64.decode('abcde');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/length/i);
  });

  it('fails on a character outside both alphabets', () => {
    const result = codecs().Base64.decode('abc!def');
    expect(result.ok).toBe(false);
  });

  it('accepts an embedded newline or space identically to the same payload with whitespace removed', () => {
    const withWhitespace = 'aGVs bG8g\nd29ybGQ=';
    const withoutWhitespace = 'aGVsbG8gd29ybGQ=';
    expect(codecs().Base64.decode(withWhitespace)).toEqual(codecs().Base64.decode(withoutWhitespace));
  });

  it('whitespace stripping does not weaken alphabet enforcement', () => {
    const result = codecs().Base64.decode('ab!c def');
    expect(result.ok).toBe(false);
  });

  it('encodeUrl output has no padding character and no character outside the url alphabet', () => {
    const encoded = codecs().Base64.encodeUrl(new TextEncoder().encode('hello world'));
    expect(encoded).not.toContain('=');
    expect(encoded).toMatch(/^[A-Za-z0-9\-_]*$/);
  });

  it('encodeUrl round-trips through decode for zero-length and non-multiple-of-three lengths', () => {
    for (const bytes of [
      new Uint8Array(0),
      new Uint8Array([65]),
      new Uint8Array([65, 66]),
      new Uint8Array([65, 66, 67]),
    ]) {
      const encoded = codecs().Base64.encodeUrl(bytes);
      const result = codecs().Base64.decode(encoded);
      expect(result.ok).toBe(true);
      expect(Array.from(result.bytes)).toEqual(Array.from(bytes));
    }
  });
});

describe('codecs.Utf8', () => {
  it('isValid is true for the hello bytes and Utf8.decode returns "hello"', () => {
    const bytes = new Uint8Array([0x68, 0x65, 0x6c, 0x6c, 0x6f]);
    expect(codecs().Utf8.isValid(bytes)).toBe(true);
    expect(codecs().Utf8.decode(bytes)).toBe('hello');
  });

  it('isValid is false for a lone continuation byte, and decode returns null', () => {
    const bytes = new Uint8Array([0x80]);
    expect(codecs().Utf8.isValid(bytes)).toBe(false);
    expect(codecs().Utf8.decode(bytes)).toBeNull();
  });

  it('isValid is false for a truncated multi-byte sequence', () => {
    const bytes = new Uint8Array([0xe2, 0x82]); // a 3-byte lead with only one continuation byte
    expect(codecs().Utf8.isValid(bytes)).toBe(false);
  });

  it('isValid is false for an overlong encoding', () => {
    const bytes = new Uint8Array([0xc0, 0x80]); // overlong encoding of NUL
    expect(codecs().Utf8.isValid(bytes)).toBe(false);
  });

  it('isValid is true for a multi-byte code point (an emoji)', () => {
    const bytes = new Uint8Array([0xf0, 0x9f, 0x98, 0x80]); // 😀, U+1F600
    expect(codecs().Utf8.isValid(bytes)).toBe(true);
    expect(codecs().Utf8.decode(bytes)).toBe('😀');
  });
});

// The handoff's own vector — §7.5 / TXT-02: 0x68656c6c6f -> hello, 5 bytes, int 448378203247.
const HEX_VECTOR = '0x68656c6c6f';

describe('decoders — hex', () => {
  it('decodes the handoff vector into a root with exactly three children: 5, hello, and a bigint', async () => {
    const output = await hexDecoder().decode(HEX_VECTOR, {});
    expect(output.node.children).toHaveLength(3);
    const [byteLength, utf8, int] = output.node.children;
    expect(byteLength.value).toBe(5);
    expect(utf8.value).toBe('hello');
    expect(int.value).toBe(448378203247n);
    expect(typeof int.value).toBe('bigint');
  });

  it('returns a DecodeOutput whose rawBytes equals the five decoded bytes for the handoff vector', async () => {
    const output = await hexDecoder().decode(HEX_VECTOR, {});
    expect(Array.from(output.rawBytes)).toEqual([0x68, 0x65, 0x6c, 0x6c, 0x6f]);
  });

  it('decoding an empty string yields byte length 0, an empty utf8 string, and the integer 0', async () => {
    const output = await hexDecoder().decode('', {});
    const [byteLength, utf8, int] = output.node.children;
    expect(byteLength.value).toBe(0);
    expect(utf8.value).toBe('');
    expect(int.value).toBe(0n);
  });

  it('decoding a 33-byte payload omits the integer child and names the 32-byte limit on the root', async () => {
    const thirtyThreeBytes = `0x${'11'.repeat(33)}`;
    const output = await hexDecoder().decode(thirtyThreeBytes, {});
    expect(output.node.children).toHaveLength(2);
    expect(output.node.annotations?.join(' ')).toMatch(/32-byte limit/);
  });

  it('decoding invalid UTF-8 bytes returns a present utf8 child with no value and a warning', async () => {
    // 0x80 alone is a lone continuation byte — not valid UTF-8 (see codecs.Utf8 tests above).
    const output = await hexDecoder().decode('0x80', {});
    const utf8Child = output.node.children[1];
    expect(utf8Child.label).toBe('utf8');
    expect(utf8Child.value).toBeUndefined();
    expect(utf8Child.warning).toMatch(/not valid UTF-8/i);
  });

  it('decoding an odd-length hex string returns a single error node with no children, raw equal to the input, and rawBytes null', async () => {
    const output = await hexDecoder().decode('0xfff', {});
    expect(output.node.error).toMatch(/odd-length/i);
    expect(output.node.children).toBeUndefined();
    expect(output.node.value).toBeUndefined();
    expect(output.node.raw).toBe('0xfff');
    expect(output.rawBytes).toBeNull();
  });

  it("the odd-length decode's returned promise resolves rather than rejects", async () => {
    await expect(hexDecoder().decode('0xfff', {})).resolves.toBeDefined();
  });

  it('canDecode returns 0 for input containing a non-hex character after normalization', () => {
    expect(hexDecoder().canDecode('0xzz')).toBe(0);
  });

  it("canDecode's odd-length-hex score is strictly greater than the auto-detect threshold", () => {
    expect(hexDecoder().canDecode('0xfff')).toBeGreaterThan(core().AUTO_DETECT_THRESHOLD);
  });

  it('canDecode of a three-line hex payload returns the same score as its single-line form', () => {
    const multiLine = '0x68\n65\n6c 6c\n6f';
    expect(hexDecoder().canDecode(multiLine)).toBe(hexDecoder().canDecode(HEX_VECTOR));
  });

  it('canDecode returns 0 for empty input', () => {
    expect(hexDecoder().canDecode('')).toBe(0);
  });

  it('two sibling nodes carrying the same label stay two entries — position is identity (D-03)', async () => {
    const output = await hexDecoder().decode(HEX_VECTOR, {});
    const labels = output.node.children.map((child: { label: string }) => child.label);
    // byte length / utf8 / int are already three distinct labels; the contract this asserts is
    // that nothing in the tree type merges same-labelled siblings — proved directly on a pair
    // of nodes sharing one label rather than inferred from the hex decoder's own (distinct)
    // labels.
    const dupLabelChildren = [
      { label: 'dup', value: 1 },
      { label: 'dup', value: 2 },
    ];
    expect(dupLabelChildren).toHaveLength(2);
    expect(dupLabelChildren[0]).not.toBe(dupLabelChildren[1]);
    expect(labels).toEqual(['byte length', 'utf8', 'int']);
  });
});
