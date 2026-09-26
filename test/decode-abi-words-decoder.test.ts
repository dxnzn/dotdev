import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

// TXT-05's offline vector suite — same compiled-load idiom as test/decode-codecs.test.ts,
// test/decode-base64-decoder.test.ts, test/decode-url-decoder.test.ts and
// test/decode-jwt-decoder.test.ts: `new Function('window', code)(window)` against the real
// jsdom `window`, then access through window.DxDecode.registry.get('abi-words'). `make
// test`/CI build before they test for exactly this reason (Makefile `test: lint build`).
function loadCompiled(relPath: string): void {
  const code = readFileSync(resolve(__dirname, relPath), 'utf-8');
  new Function('window', code)(window);
}

beforeAll(() => {
  loadCompiled('../src/dapps/decode/codecs.js');
  loadCompiled('../src/dapps/decode/core.js');
  loadCompiled('../src/dapps/decode/decoders.js');
  loadCompiled('../src/dapps/decode/decoders-jwt.js');
  loadCompiled('../src/dapps/decode/decoders-abi-words.js');
  loadCompiled('../src/dapps/decode/decoders-url.js');
  loadCompiled('../src/dapps/decode/decoders-base64.js');
});

// biome's noExplicitAny is disabled repo-wide (biome.json) — matches the cast every other
// compiled-module-boundary test in this repo already uses.
const core = () => (window as any).DxDecode.core;
const registry = () => (window as any).DxDecode.registry;
const abiWords = () => registry().get('abi-words');
const hexDecoder = () => registry().get('hex');

// <test_vectors> — pinned in the plan so the decoder and this suite are graded against the
// same bytes. REAL-1/REAL-2 are handoff §7.1's real inner calldata; SYNTH-1 is synthetic, since
// the handoff has no offset/length vector of its own.

// handoff §7.1, the mintFromMoloch inner call: a 4-byte selector and two words. Word 0 is
// address-like (top twelve bytes zero, byte 12 is 0x5e); word 1 is 1000000000000000000, which
// does not fit in 32 bits, so it is a large int and not a small int.
const REAL_1 =
  '0x2806b0af' +
  '0000000000000000000000005e58ba0e06ed0f5558f83be732a4b899a674053e' +
  '0000000000000000000000000000000000000000000000000de0b6b3a7640000';
const REAL_1_ADDRESS = '5e58ba0e06ed0f5558f83be732a4b899a674053e';
const REAL_1_LARGE_INT_DECIMAL = '1000000000000000000';

// handoff §7.1, the claimTribute inner call: a 4-byte selector, an address-like word, and an
// all-zero word.
const REAL_2 = `0xac6695d10000000000000000000000001c0aa8ccd568d90d61659f060d1bfb1e6f855a20${'0'.repeat(64)}`;

// The offset/length pair no real §7.1 vector exercises: selector 0xdeadbeef, word 0 = 32
// (0x…20, pointing at word 1's argument-relative byte offset), word 1 = 3, word 2 = 7
// (anything non-zero). 100 bytes total.
function wordHex(n: number): string {
  return n.toString(16).padStart(64, '0');
}
const SYNTH_1 = `0xdeadbeef${wordHex(32)}${wordHex(3)}${wordHex(7)}`;

// BOUNDS — both sides of both lower bounds, plus the address negative.
const BOUNDS_4_BYTES = '0xdeadbeef';
const BOUNDS_20_BYTES = `0x${'a1'.repeat(20)}`; // an address — must resolve to hex
const BOUNDS_32_BYTES = `0x${'b2'.repeat(32)}`; // a bare hash — must resolve to hex
const BOUNDS_36_BYTES = `0x${'ee'.repeat(4)}${'c3'.repeat(32)}`; // selector + 1 word — abi-words
const BOUNDS_64_BYTES = `0x${'c3'.repeat(32)}${'d4'.repeat(32)}`; // 2 bare words — abi-words

// A partial trailing word — 1 whole word (32 bytes) plus 8 leftover bytes. Not reachable via
// Auto (canDecode scores it 0), only by manual selection.
const PARTIAL_TRAILING = `0x${'aa'.repeat(32)}${'bb'.repeat(8)}`;

describe('abi-words decoder — canDecode scoring (D-10)', () => {
  it('scores REAL-1, REAL-2 and SYNTH-1 at 0.95, strictly above hex own live score', () => {
    for (const vector of [REAL_1, REAL_2, SYNTH_1]) {
      expect(abiWords().canDecode(vector)).toBe(0.95);
      expect(abiWords().canDecode(vector)).toBeGreaterThan(hexDecoder().canDecode(vector));
    }
  });

  it('scores 0 for a 4-byte, a 20-byte and a 32-byte payload — the lower-bound floor from both sides', () => {
    expect(abiWords().canDecode(BOUNDS_4_BYTES)).toBe(0);
    expect(abiWords().canDecode(BOUNDS_20_BYTES)).toBe(0);
    expect(abiWords().canDecode(BOUNDS_32_BYTES)).toBe(0);
  });

  it('scores 0.95 for a 36-byte and a 64-byte payload — the other side of both bounds', () => {
    expect(abiWords().canDecode(BOUNDS_36_BYTES)).toBe(0.95);
    expect(abiWords().canDecode(BOUNDS_64_BYTES)).toBe(0.95);
  });

  it("scores 0 for '', for odd-length hex, and for non-hex", () => {
    expect(abiWords().canDecode('')).toBe(0);
    expect(abiWords().canDecode('0xfff')).toBe(0);
    expect(abiWords().canDecode('0xzz')).toBe(0);
  });
});

describe('abi-words decoder — auto-detect resolution against hex (D-10)', () => {
  it('resolves REAL-1 to abi-words', () => {
    expect(core().resolve(REAL_1).decoderId).toBe('abi-words');
  });

  it('resolves a 20-byte address and a bare 32-byte word to hex, not abi-words', () => {
    expect(core().resolve(BOUNDS_20_BYTES).decoderId).toBe('hex');
    expect(core().resolve(BOUNDS_32_BYTES).decoderId).toBe('hex');
  });
});

describe('abi-words decoder — decoding real calldata', () => {
  it('REAL-1: a selector node then exactly two word children', async () => {
    const output = await abiWords().decode(REAL_1, {});
    const [selector, word0, word1, ...rest] = output.node.children as any[];
    expect(rest).toHaveLength(0);

    expect(selector.label).toBe('selector');
    expect(selector.value).toBe('0x2806b0af');
    expect(selector.provenance).toBe('unresolved');
    expect(selector.annotations?.length).toBeGreaterThan(0);
    expect(selector.annotations[0]).toMatch(/no signature lookup runs/);

    expect(word0.label).toContain('0x0004');
    expect(word1.label).toContain('0x0024');
  });

  it('REAL-1 word 0 is address-like, exactly one annotation, no int annotation — the terminal short-circuit', async () => {
    const output = await abiWords().decode(REAL_1, {});
    const word0 = output.node.children[1];
    expect(word0.annotations).toHaveLength(1);
    expect(word0.annotations[0]).toContain('address-like');
    expect(word0.annotations[0]).toContain(REAL_1_ADDRESS);
  });

  it('REAL-1 word 1 is a large int carrying the exact decimal, and no small-int entry', async () => {
    const output = await abiWords().decode(REAL_1, {});
    const word1 = output.node.children[2];
    const largeIntEntry = word1.annotations.find((a: string) => a.includes('large int'));
    expect(largeIntEntry).toBeDefined();
    expect(largeIntEntry).toContain(REAL_1_LARGE_INT_DECIMAL);
    expect(word1.annotations.some((a: string) => a.includes('small int'))).toBe(false);
  });

  it('REAL-2 word 1 is exactly one zero-word entry — no address-like, no int entry', async () => {
    const output = await abiWords().decode(REAL_2, {});
    const word1 = output.node.children[2];
    expect(word1.annotations).toHaveLength(1);
    expect(word1.annotations[0]).toBe('zero word');
  });

  it('SYNTH-1: word 0 is offset-like AND small-int (additive); word 1 is small-int AND length-like (additive)', async () => {
    const output = await abiWords().decode(SYNTH_1, {});
    const word0 = output.node.children[1];
    const word1 = output.node.children[2];

    expect(word0.annotations.some((a: string) => a.includes('small int') && a.includes('32'))).toBe(true);
    const offsetEntry = word0.annotations.find((a: string) => a.includes('offset-like'));
    expect(offsetEntry).toBeDefined();
    expect(offsetEntry).toContain('32');
    expect(offsetEntry).toContain('0024');
    // Proves the tightened address-like predicate does NOT fire on a small multiple of 32 —
    // byte 12 is zero, so the terminal short-circuit does not swallow the offset-like reading.
    expect(word0.annotations.some((a: string) => a.includes('address-like'))).toBe(false);

    expect(word1.annotations.some((a: string) => a.includes('small int') && a.includes('3'))).toBe(true);
    expect(word1.annotations.some((a: string) => a.includes('length-like') && a.includes('3'))).toBe(true);
  });

  it('a no-selector payload of two whole words produces word children starting at offset 0 and no selector child', async () => {
    const output = await abiWords().decode(BOUNDS_64_BYTES, {});
    expect(output.node.children).toHaveLength(2);
    expect(output.node.children[0].label).not.toContain('selector');
    expect(output.node.children[0].label).toContain('0x0000');
    expect(output.node.children[1].label).toContain('0x0020');
  });

  it('a bare 4-byte payload (manual selection) produces no selector child, one partial-word child with a leftover-byte warning', async () => {
    const output = await abiWords().decode(BOUNDS_4_BYTES, {});
    expect(output.node.children).toHaveLength(1);
    const only = output.node.children[0];
    expect(only.label).not.toBe('selector');
    expect(only.warning).toMatch(/4 leftover bytes/);
  });

  it('a payload with a partial trailing word produces whole-word children plus one final child with a leftover warning', async () => {
    const output = await abiWords().decode(PARTIAL_TRAILING, {});
    expect(output.node.children).toHaveLength(2);
    expect(output.node.children[0].warning).toBeUndefined();
    expect(output.node.children[1].warning).toMatch(/8 leftover bytes/);
  });

  it('decoding an empty string yields a defined node with no children and a no-bytes annotation, not an error', async () => {
    const output = await abiWords().decode('', {});
    expect(output.node.error).toBeUndefined();
    expect(output.node.children).toBeUndefined();
    expect(output.node.annotations).toEqual(['no bytes to read']);
  });

  it('decoding an odd-length hex string yields a single error node, and the returned promise resolves', async () => {
    await expect(abiWords().decode('0xfff', {})).resolves.toBeDefined();
    const output = await abiWords().decode('0xfff', {});
    expect(output.node.error).toBeTruthy();
    expect(output.rawBytes).toBeNull();
  });

  it('every word child in every decoded case carries at least one annotation', async () => {
    for (const vector of [REAL_1, REAL_2, SYNTH_1, BOUNDS_36_BYTES, BOUNDS_64_BYTES]) {
      const output = await abiWords().decode(vector, {});
      for (const child of output.node.children as any[]) {
        if (child.label === 'selector' || child.warning) continue;
        expect(child.annotations?.length).toBeGreaterThan(0);
      }
    }
  });

  it('the returned output carries rawBytes equal to the decoded bytes and rawView equal to word-table', async () => {
    const output = await abiWords().decode(REAL_1, {});
    expect(output.rawView).toBe('word-table');
    expect(output.rawBytes).toBeInstanceOf(Uint8Array);
    expect(output.rawBytes.length).toBe(68);
  });

  it('every annotation the decoder emits uses a -like form or an explicit int-class name — never asserts a determination', () => {
    const source = readFileSync(resolve(__dirname, '../src/dapps/decode/decoders-abi-words.ts'), 'utf-8');
    // Every hypothesis-naming template literal in the file keeps the -like suffix or the
    // 'small int'/'large int'/'zero word' vocabulary — read by hand against the source, then
    // pinned here so a later edit cannot silently reword one into an assertion of type.
    expect(source).toContain('address-like');
    expect(source).toContain('offset-like');
    expect(source).toContain('length-like');
    expect(source).toContain('zero word');
    expect(source).toContain('small int');
    expect(source).toContain('large int');
    expect(source).not.toMatch(/is an address\b/);
    expect(source).not.toMatch(/is an offset\b/);
    expect(source).not.toMatch(/is a length\b/);
  });
});

describe('abi-words decoder — hex is untouched (D-10)', () => {
  it('this decoder registers alongside hex without changing hex own file', () => {
    // Enforced structurally by the plan verify step's git diff --quiet against decoders.ts;
    // this case is the in-suite mirror, proving hex still scores exactly as TXT-02 pinned it.
    expect(hexDecoder().canDecode('0x68656c6c6f')).toBe(0.9);
  });
});
