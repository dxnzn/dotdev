import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

// COD-02/COD-03/COD-04/COD-05 offline assertions against abi.ts directly (no decoder wrapper
// in between) — the compiled-load idiom every suite in this directory shares (D-01), reloaded
// fresh in beforeEach for full isolation. Only codecs/keccak/abi are needed: this file never
// touches the eth-calldata decoder or the registry.
function loadCompiled(relPath: string): void {
  const code = readFileSync(resolve(__dirname, relPath), 'utf-8');
  new Function('window', code)(window);
}

beforeEach(() => {
  loadCompiled('../src/dapps/decode/codecs.js');
  loadCompiled('../src/dapps/decode/keccak.js');
  loadCompiled('../src/dapps/decode/abi.js');
});

function abi(): DxDecodeAbiModule {
  return window.DxDecode!.abi as DxDecodeAbiModule;
}
function keccak(): DxDecodeKeccakModule {
  return window.DxDecode!.keccak as DxDecodeKeccakModule;
}
function codecs(): DxDecodeCodecsModule {
  return window.DxDecode!.codecs as DxDecodeCodecsModule;
}

function toBytes(hex: string): Uint8Array {
  const result = codecs().Hex.decode(hex);
  if (!result.ok) throw new Error(`bad test fixture hex: ${result.error}`);
  return result.bytes;
}

function typesFor(sig: string): TypeNode[] {
  const parsed = abi().parseTypeString(sig);
  if ('error' in parsed) throw new Error(`bad test fixture signature "${sig}": ${parsed.error}`);
  return parsed.types;
}

// ── A tiny, independent ABI encoder for building test fixtures ─────────────────────────────
//
// Implements the SAME publicly-documented head/tail algorithm abi.ts decodes (RESEARCH.md
// Pattern 1) but written from scratch against the spec, not derived from abi.ts's own code —
// so a bug shared between the encoder and the decoder under test is not how these fixtures get
// their confidence. Real handoff §7.1 literals (used directly, byte-for-byte, in the "real
// mainnet vectors" block below) are the independent cross-check for both.
type EncSpec =
  | { t: 'uint' | 'int'; v: bigint }
  | { t: 'address'; v: string }
  | { t: 'bool'; v: boolean }
  | { t: 'bytesN'; v: string } // hex, no 0x, exactly N*2 chars
  | { t: 'function'; v: string } // hex, no 0x, exactly 48 chars (24 bytes)
  | { t: 'bytes'; v: string } // hex, no 0x
  | { t: 'string'; v: string }
  | { t: 'array'; length?: number; items: EncSpec[] }
  | { t: 'tuple'; items: EncSpec[] };

function hexWord(n: bigint): string {
  return n.toString(16).padStart(64, '0');
}

function encIsDynamic(spec: EncSpec): boolean {
  if (spec.t === 'bytes' || spec.t === 'string') return true;
  if (spec.t === 'array') {
    if (spec.length === undefined) return true;
    return spec.items.length > 0 ? encIsDynamic(spec.items[0]) : false;
  }
  if (spec.t === 'tuple') return spec.items.some(encIsDynamic);
  return false;
}

function encElementaryWord(spec: EncSpec): string {
  switch (spec.t) {
    case 'uint':
      return hexWord(spec.v);
    case 'int':
      return hexWord(spec.v < 0n ? spec.v + (1n << 256n) : spec.v);
    case 'address':
      return spec.v.replace(/^0x/, '').toLowerCase().padStart(64, '0');
    case 'bool':
      return hexWord(spec.v ? 1n : 0n);
    case 'bytesN':
      return spec.v.padEnd(64, '0');
    case 'function':
      return spec.v.padEnd(64, '0');
    default:
      throw new Error(`encElementaryWord: not an elementary spec: ${spec.t}`);
  }
}

function encBytesTail(hexNoPrefix: string): string {
  const byteLen = hexNoPrefix.length / 2;
  const padLen = (64 - (hexNoPrefix.length % 64)) % 64;
  return hexWord(BigInt(byteLen)) + hexNoPrefix + '0'.repeat(padLen);
}

function encStringTail(text: string): string {
  const hexNoPrefix = Array.from(new TextEncoder().encode(text), (b) => b.toString(16).padStart(2, '0')).join('');
  return encBytesTail(hexNoPrefix);
}

// Self-contained head/tail region over `specs` — every offset it writes is relative to THIS
// string's own start (position 0), which is exactly what makes it composable: embed the
// returned string anywhere and its internal offsets are still correct, whether it's the
// top-level argument list or one level of tuple/array nesting.
function encList(specs: EncSpec[]): string {
  const headWidths = specs.map(encHeadWidth);
  const headSize = headWidths.reduce((a, b) => a + b, 0);
  let tailCursor = headSize;
  const headParts: string[] = [];
  const tailParts: string[] = [];
  for (const spec of specs) {
    if (encIsDynamic(spec)) {
      headParts.push(hexWord(BigInt(tailCursor)));
      const tailHex = encTail(spec);
      tailParts.push(tailHex);
      tailCursor += tailHex.length / 2;
    } else {
      headParts.push(encStaticInline(spec));
    }
  }
  return headParts.join('') + tailParts.join('');
}

function encHeadWidth(spec: EncSpec): number {
  if (!encIsDynamic(spec)) {
    if (spec.t === 'array' && spec.length !== undefined) return spec.length * encHeadWidth(spec.items[0]);
    if (spec.t === 'tuple') return spec.items.reduce((sum, s) => sum + encHeadWidth(s), 0);
  }
  return 32;
}

function encStaticInline(spec: EncSpec): string {
  if (spec.t === 'array' || spec.t === 'tuple') return encList(spec.items);
  return encElementaryWord(spec);
}

function encTail(spec: EncSpec): string {
  if (spec.t === 'bytes') return encBytesTail(spec.v);
  if (spec.t === 'string') return encStringTail(spec.v);
  if (spec.t === 'array' && spec.length === undefined) {
    return hexWord(BigInt(spec.items.length)) + encList(spec.items);
  }
  if (spec.t === 'array' || spec.t === 'tuple') {
    // Fixed-size array of a dynamic element, or a dynamic tuple: self-contained region, no
    // length word (the size is already fixed by the type itself).
    return encList(spec.items);
  }
  throw new Error(`encTail: not a dynamic spec: ${spec.t}`);
}

function payload(specs: EncSpec[]): Uint8Array {
  return toBytes(`0x${encList(specs)}`);
}

// ── Task 1 <behavior> ────────────────────────────────────────────────────────────────────

describe('dynamic bytes/string — empty and adjacency edges (COD-02)', () => {
  it('bytes with a length word of 0 decodes to an empty value node, no children, no error', () => {
    const [node] = abi().decodeParameters(typesFor('f(bytes)'), payload([{ t: 'bytes', v: '' }]), 0, 0);
    expect(node.error).toBeUndefined();
    expect(node.children).toBeUndefined();
    expect(node.value).toBe('0x');
  });

  it('a dynamic array with a length word of 0 decodes to a node with zero children, no error', () => {
    const [node] = abi().decodeParameters(typesFor('f(uint256[])'), payload([{ t: 'array', items: [] }]), 0, 0);
    expect(node.error).toBeUndefined();
    expect(node.children).toHaveLength(0);
  });

  it('two bytes arguments with adjacent tails each decode their own bytes with no overlap', () => {
    const specs: EncSpec[] = [
      { t: 'bytes', v: '1122' },
      { t: 'bytes', v: '3344' },
    ];
    const [a, b] = abi().decodeParameters(typesFor('f(bytes,bytes)'), payload(specs), 0, 0);
    expect(a.value).toBe('0x1122');
    expect(b.value).toBe('0x3344');
    expect(a.error).toBeUndefined();
    expect(b.error).toBeUndefined();
  });
});

describe('integer sign extension and masking (COD-02, RESEARCH Pitfall 2)', () => {
  it('int256 of 32 bytes of 0xff decodes to exactly -1n', () => {
    const data = toBytes(`0x${'ff'.repeat(32)}`);
    const [node] = abi().decodeParameters(typesFor('f(int256)'), data, 0, 0);
    expect(node.value).toBe(-1n);
  });

  it("int8 encoded as the full-word two's complement of -1 decodes to -1n (sign-extended before narrowing)", () => {
    const data = toBytes(`0x${'ff'.repeat(32)}`);
    const [node] = abi().decodeParameters(typesFor('f(int8)'), data, 0, 0);
    expect(node.value).toBe(-1n);
  });
});

describe('bool leniency (COD-02, RESEARCH assumption A2)', () => {
  it('a word of 0x…02 decodes to true and carries a warning', () => {
    const data = toBytes(`0x${hexWord(2n)}`);
    const [node] = abi().decodeParameters(typesFor('f(bool)'), data, 0, 0);
    expect(node.value).toBe('true');
    expect(node.warning).toBeTruthy();
  });

  it('0x…00 and 0x…01 decode with no warning', () => {
    const zero = abi().decodeParameters(typesFor('f(bool)'), toBytes(`0x${hexWord(0n)}`), 0, 0)[0];
    const one = abi().decodeParameters(typesFor('f(bool)'), toBytes(`0x${hexWord(1n)}`), 0, 0)[0];
    expect(zero.value).toBe('false');
    expect(zero.warning).toBeUndefined();
    expect(one.value).toBe('true');
    expect(one.warning).toBeUndefined();
  });
});

describe('bytesN left-alignment (COD-02)', () => {
  it('bytes4 decodes to the FIRST four bytes of the word, not the last four', () => {
    const data = toBytes(`0xaabbccdd${'00'.repeat(28)}`);
    const [node] = abi().decodeParameters(typesFor('f(bytes4)'), data, 0, 0);
    expect(node.value).toBe('0xaabbccdd');
  });
});

describe('fixed-size array of a dynamic type (COD-02)', () => {
  it("string[3] decodes all three strings, element offsets relative to the array's own tail start", () => {
    const specs: EncSpec[] = [
      {
        t: 'array',
        length: 3,
        items: [
          { t: 'string', v: 'a' },
          { t: 'string', v: 'bb' },
          { t: 'string', v: 'ccc' },
        ],
      },
    ];
    const [node] = abi().decodeParameters(typesFor('f(string[3])'), payload(specs), 0, 0);
    expect(node.error).toBeUndefined();
    expect(node.children).toHaveLength(3);
    expect(node.children![0].value).toBe('a');
    expect(node.children![1].value).toBe('bb');
    expect(node.children![2].value).toBe('ccc');
  });
});

describe('dynamic array of a dynamic element type — the off-by-one-word trap (COD-02)', () => {
  it('bytes[] with two adjacent-tail elements decodes both byte strings correctly', () => {
    const specs: EncSpec[] = [
      {
        t: 'array',
        items: [
          { t: 'bytes', v: 'aa' },
          { t: 'bytes', v: 'bbcc' },
        ],
      },
    ];
    const [node] = abi().decodeParameters(typesFor('f(bytes[])'), payload(specs), 0, 0);
    expect(node.error).toBeUndefined();
    expect(node.children).toHaveLength(2);
    expect(node.children![0].value).toBe('0xaa');
    expect(node.children![1].value).toBe('0xbbcc');
  });

  it('bytes[][2] decodes all four inner byte strings, surviving two levels of the same trap', () => {
    const specs: EncSpec[] = [
      {
        t: 'array',
        length: 2,
        items: [
          {
            t: 'array',
            items: [
              { t: 'bytes', v: '01' },
              { t: 'bytes', v: '02' },
            ],
          },
          {
            t: 'array',
            items: [
              { t: 'bytes', v: '03' },
              { t: 'bytes', v: '04' },
            ],
          },
        ],
      },
    ];
    const [node] = abi().decodeParameters(typesFor('f(bytes[][2])'), payload(specs), 0, 0);
    expect(node.error).toBeUndefined();
    expect(node.children).toHaveLength(2);
    expect(node.children![0].children).toHaveLength(2);
    expect(node.children![0].children![0].value).toBe('0x01');
    expect(node.children![0].children![1].value).toBe('0x02');
    expect(node.children![1].children![0].value).toBe('0x03');
    expect(node.children![1].children![1].value).toBe('0x04');
  });
});

describe('nested tuple offsets relative to the enclosing region (COD-02, RESEARCH Pitfall 1)', () => {
  it("(uint256,(uint256,bytes)) decodes the inner tuple's bytes correctly", () => {
    const specs: EncSpec[] = [
      { t: 'uint', v: 7n },
      {
        t: 'tuple',
        items: [
          { t: 'uint', v: 9n },
          { t: 'bytes', v: 'deadbeef' },
        ],
      },
    ];
    const [outer, inner] = abi().decodeParameters(typesFor('f(uint256,(uint256,bytes))'), payload(specs), 0, 0);
    expect(outer.value).toBe(7n);
    expect(inner.error).toBeUndefined();
    expect(inner.children![0].value).toBe(9n);
    expect(inner.children![1].value).toBe('0xdeadbeef');
  });
});

describe('function and fixed128x18 elementary dispositions (COD-05, ABI_SUPPORTED_ELEMENTARY)', () => {
  it('function (24 bytes, left-aligned) decodes to its hex value — never a node with no value and no error', () => {
    const funcHex = 'a'.repeat(48); // 24 bytes
    const data = toBytes(`0x${funcHex}${'0'.repeat(64 - 48)}`);
    const [node] = abi().decodeParameters(typesFor('f(function)'), data, 0, 0);
    expect(node.error).toBeUndefined();
    expect(node.value).toBe(`0x${funcHex}`);
  });

  it('fixed128x18 returns a node whose error names the type — never a node with no value and no error', () => {
    const data = toBytes(`0x${hexWord(0n)}`);
    const [node] = abi().decodeParameters(typesFor('f(fixed128x18)'), data, 0, 0);
    expect(node.value).toBeUndefined();
    expect(node.error).toBeTruthy();
    expect(node.error).toContain('fixed128x18');
  });
});

describe('one owner per node field (COD-02, D-30)', () => {
  it('a node returned by abiDecodeParameters has no display/annotations/link/linkKind/collapsed/provenance member', () => {
    const specs: EncSpec[] = [
      { t: 'uint', v: 1n },
      { t: 'address', v: '0x1111111111111111111111111111111111111111' },
    ];
    const nodes = abi().decodeParameters(typesFor('f(uint256,address)'), payload(specs), 0, 0);
    for (const node of nodes) {
      expect(node.display).toBeUndefined();
      expect(node.annotations).toBeUndefined();
      expect(node.link).toBeUndefined();
      expect(node.linkKind).toBeUndefined();
      expect(node.collapsed).toBeUndefined();
      expect(node.provenance).toBeUndefined();
    }
  });
});

describe('canonicalType — elementary aliasing (COD-04, D-19)', () => {
  it('address and bool survive alias normalisation untouched', () => {
    expect(abi().canonicalType({ kind: 'elementary', type: 'address' })).toBe('address');
    expect(abi().canonicalType({ kind: 'elementary', type: 'bool' })).toBe('bool');
  });

  it('bare uint/int aliases normalise to their 256-bit form', () => {
    expect(abi().canonicalType({ kind: 'elementary', type: 'uint' })).toBe('uint256');
    expect(abi().canonicalType({ kind: 'elementary', type: 'int' })).toBe('int256');
  });

  it('tuple[] canonicalizes to (...)[] with the array suffix adjacent — no inserted space', () => {
    const item: AbiInput = {
      name: '',
      type: 'tuple[]',
      components: [
        { name: '', type: 'address' },
        { name: '', type: 'uint256' },
        { name: '', type: 'bytes' },
      ],
    };
    const [node] = abi().parseAbiInputs([item]);
    expect(abi().canonicalType(node)).toBe('(address,uint256,bytes)[]');
  });

  it('a function with an empty inputs array canonicalizes to name(), and a zero-component tuple expands to ()', () => {
    expect(abi().canonicalSignature('name', [])).toBe('name()');
    expect(abi().canonicalType({ kind: 'tuple', type: '', components: [] })).toBe('()');
  });

  it('component order is preserved verbatim — a reordered components array yields a different selector', () => {
    const forward: AbiItem = {
      name: 'batchCalls',
      inputs: [
        {
          name: '',
          type: 'tuple[]',
          components: [
            { name: '', type: 'address' },
            { name: '', type: 'uint256' },
            { name: '', type: 'bytes' },
          ],
        },
      ],
    };
    const reordered: AbiItem = {
      name: 'batchCalls',
      inputs: [
        {
          name: '',
          type: 'tuple[]',
          components: [
            { name: '', type: 'uint256' },
            { name: '', type: 'address' },
            { name: '', type: 'bytes' },
          ],
        },
      ],
    };
    const forwardSig = abi().canonicalSignature(forward.name, abi().parseAbiInputs(forward.inputs));
    const reorderedSig = abi().canonicalSignature(reordered.name, abi().parseAbiInputs(reordered.inputs));
    expect(forwardSig).toBe('batchCalls((address,uint256,bytes)[])');
    expect(keccak().selector(forwardSig)).toBe('0x11c76fd9');
    expect(keccak().selector(reorderedSig)).not.toBe('0x11c76fd9');
  });
});

describe('malformed offsets and lengths never throw (COD-05, D-20)', () => {
  it('an offset word of 0xffffffff… produces a node carrying error, no throw', () => {
    const hugeOffsetData = toBytes(`0x${'f'.repeat(64)}`);
    const [hugeOffsetNode] = abi().decodeParameters(typesFor('f(bytes)'), hugeOffsetData, 0, 0);
    expect(typeof hugeOffsetNode.error).toBe('string');
    expect(hugeOffsetNode.error!.length).toBeGreaterThan(0);
  });

  it('a length word larger than the remaining bytes produces a node carrying error, no throw', () => {
    const shortLengthData = toBytes(`0x${hexWord(32n)}${hexWord(1000n)}`);
    const [shortLengthNode] = abi().decodeParameters(typesFor('f(bytes)'), shortLengthData, 0, 0);
    expect(typeof shortLengthNode.error).toBe('string');
    expect(shortLengthNode.error!.length).toBeGreaterThan(0);
  });

  it('an offset resolving before the region base produces a node carrying error, no throw (defensive gate — a base exceeding the payload forces the same bounds check a corrupted offset would)', () => {
    // Every offset word is read as an UNSIGNED big-endian value (abiWordBigEndianValue), so
    // `regionBase + offsetValue` can never itself go negative through a genuinely encoded
    // payload — the `tailStart < regionBase` arm in abiDecodeHeadTailRegion exists as a
    // belt-and-suspenders companion to the `tailStart > data.length` arm, not as an
    // independently reachable path. Exercised here via a `base` already past the payload's own
    // length (as a malformed nested-region base would be), which the SAME bounds check rejects.
    const data = toBytes(`0x${hexWord(0n)}`);
    const [node] = abi().decodeParameters(typesFor('f(bytes)'), data, data.length + 1, 0);
    expect(typeof node.error).toBe('string');
    expect(node.error!.length).toBeGreaterThan(0);
  });

  it('every malformed case above resolves without throwing (a plain call, no try/catch, no rejects)', () => {
    expect(() => abi().decodeParameters(typesFor('f(bytes)'), toBytes(`0x${'f'.repeat(64)}`), 0, 0)).not.toThrow();
  });
});

// ── Task 2 block 1: the real §7.1 literals ─────────────────────────────────────────────────

describe('real §7.1 mainnet literals (COD-02, COD-03)', () => {
  // Address casing convention (stated once, in abi.ts's own header): lowercase hex, no EIP-55
  // checksum. Every comparison below is against the lowercase form.
  it('mintFromMoloch(address,uint256) decodes to the exact address and 1e18 amount', () => {
    const data = toBytes(
      '0x0000000000000000000000005e58ba0e06ed0f5558f83be732a4b899a674053e' +
        '0000000000000000000000000000000000000000000000000de0b6b3a7640000',
    );
    const [addressArg, amountArg] = abi().decodeParameters(typesFor('mintFromMoloch(address,uint256)'), data, 0, 0);
    expect(addressArg.value).toBe('0x5e58ba0e06ed0f5558f83be732a4b899a674053e');
    expect(amountArg.value).toBe(1000000000000000000n);
  });

  it('approve(address,uint256) decodes to the exact vanity address and 1e18 amount', () => {
    const data = toBytes(
      '0x000000000000000000000000000000000066524fcf78dc1e41e9d525d9ea73d0' +
        '0000000000000000000000000000000000000000000000000de0b6b3a7640000',
    );
    const [addressArg, amountArg] = abi().decodeParameters(typesFor('approve(address,uint256)'), data, 0, 0);
    expect(addressArg.value).toBe('0x000000000066524fcf78dc1e41e9d525d9ea73d0');
    expect(amountArg.value).toBe(1000000000000000000n);
  });

  it('claimTribute(address,address) decodes to the exact target and the zero address', () => {
    const data = toBytes(
      '0x0000000000000000000000001c0aa8ccd568d90d61659f060d1bfb1e6f855a20' +
        '0000000000000000000000000000000000000000000000000000000000000000',
    );
    const [firstArg, secondArg] = abi().decodeParameters(typesFor('claimTribute(address,address)'), data, 0, 0);
    expect(firstArg.value).toBe('0x1c0aa8ccd568d90d61659f060d1bfb1e6f855a20');
    expect(secondArg.value).toBe('0x0000000000000000000000000000000000000000');
  });
});

// ── Task 2 block 2: the signature parser (COD-03) ──────────────────────────────────────────

describe('abiParseTypeString — signature parser edges (COD-03)', () => {
  it('batchCalls((address,uint256,bytes)[]) parses to one dynamic array of a 3-member tuple', () => {
    const [arrayType] = typesFor('batchCalls((address,uint256,bytes)[])');
    expect(arrayType.kind).toBe('array');
    expect(arrayType.length).toBeUndefined();
    expect(arrayType.element!.kind).toBe('tuple');
    expect(arrayType.element!.components!.map((c) => c.type)).toEqual(['address', 'uint256', 'bytes']);
  });

  it("f(uint256,uint32[],bytes10,bytes) parses to the Solidity spec's own worked example shape", () => {
    const parsed = abi().parseTypeString('f(uint256,uint32[],bytes10,bytes)');
    if ('error' in parsed) throw new Error(parsed.error);
    expect(parsed.types.map((t) => t.type)).toEqual(['uint256', 'uint32[]', 'bytes10', 'bytes']);
  });

  it('a nested-tuple signature parses without error', () => {
    const parsed = abi().parseTypeString('f((uint256,uint256[],(uint256,uint256)[]),(uint256,uint256),uint256)');
    expect('error' in parsed).toBe(false);
  });

  it('[0] is accepted rather than rejected', () => {
    const parsed = abi().parseTypeString('f(uint256[0])');
    if ('error' in parsed) throw new Error('expected [0] to be accepted');
    expect(parsed.types[0].length).toBe(0);
  });

  it('whitespace, argument names, and data-location keywords are stripped', () => {
    const bare = abi().parseTypeString('f(uint256,address)');
    const decorated = abi().parseTypeString('f(uint256 a, address memory b)');
    if ('error' in bare || 'error' in decorated) throw new Error('unexpected parse error');
    expect(decorated.types.map((t) => t.type)).toEqual(bare.types.map((t) => t.type));
  });
});

// ── Task 2 block 3: canonical expansion round-trips through keccak (COD-04) ────────────────

describe('canonical expansion round-trips through keccak (COD-04, D-18)', () => {
  const ROUND_TRIPS: Array<[string, string]> = [
    ['transfer(address,uint256)', '0xa9059cbb'],
    ['approve(address,uint256)', '0x095ea7b3'],
    ['balanceOf(address)', '0x70a08231'],
    ['batchCalls((address,uint256,bytes)[])', '0x11c76fd9'],
    ['executeByVotes(uint256,address,uint256,bytes,bytes32)', '0x22fab893'],
    ['deployNext(bytes,bytes32)', '0x48215787'],
    ['f(uint256,uint32[],bytes10,bytes)', '0x8be65246'],
    ['f((uint256,uint256[],(uint256,uint256)[]),(uint256,uint256),uint256)', '0x6f2be728'],
  ];

  it.each(ROUND_TRIPS)('%s hashes to %s via abiCanonicalSignature', (sig, expectedSelector) => {
    const parsed = abi().parseTypeString(sig);
    if ('error' in parsed) throw new Error(parsed.error);
    const canonical = abi().canonicalSignature(parsed.name, parsed.types);
    expect(keccak().selector(canonical)).toBe(expectedSelector);
  });
});

// ── Task 2 block 4: the inversion trap, as a negative assertion ───────────────────────────

describe('the tuple[] inversion trap (COD-04, RESEARCH.md Anti-Patterns)', () => {
  it('hashing the unexpanded JSON-ABI form does NOT produce 0x11c76fd9, while the expanded form does', () => {
    const batchCalls: AbiItem = {
      name: 'batchCalls',
      inputs: [
        {
          name: 'calls',
          type: 'tuple[]',
          components: [
            { name: 'target', type: 'address' },
            { name: 'value', type: 'uint256' },
            { name: 'data', type: 'bytes' },
          ],
        },
      ],
    };

    // Built by joining the RAW type fields — the literal word `tuple` is never written out in
    // this file, so this string is constructed, not typed.
    const unexpandedSignature = `${batchCalls.name}(${batchCalls.inputs.map((i) => i.type).join(',')})`;
    const expandedSignature = abi().canonicalSignature(batchCalls.name, abi().parseAbiInputs(batchCalls.inputs));

    expect(keccak().selector(unexpandedSignature)).not.toBe('0x11c76fd9');
    expect(keccak().selector(expandedSignature)).toBe('0x11c76fd9');
  });
});

// ── Task 2 block 5: bounds, depth and ordering ─────────────────────────────────────────────

describe('bounds, depth and ordering (COD-05)', () => {
  it('a payload truncated mid-tail produces an error node, no throw', () => {
    // A valid offset (32) but no tail data at all following the head.
    const data = toBytes(`0x${hexWord(32n)}`);
    const [node] = abi().decodeParameters(typesFor('f(bytes)'), data, 0, 0);
    expect(typeof node.error).toBe('string');
  });

  it('a length word of 0xffffffffffffffff produces an error node, no throw', () => {
    const data = toBytes(`0x${hexWord(32n)}${'f'.repeat(16).padStart(64, '0')}`);
    const [node] = abi().decodeParameters(typesFor('f(bytes)'), data, 0, 0);
    expect(typeof node.error).toBe('string');
  });

  it('a signature nested past ABI_MAX_DEPTH produces an error node rather than a stack overflow', () => {
    // Direct decoder-side stress: build a TypeNode tree nesting a tuple far past the cap,
    // bypassing the string parser entirely so this pins the DECODER's own guard.
    function nestedTuple(depth: number): TypeNode {
      const inner: TypeNode = depth === 0 ? { kind: 'elementary', type: 'uint256', bits: 256 } : nestedTuple(depth - 1);
      return { kind: 'tuple', type: `(${inner.type})`, components: [inner] };
    }
    const deepType = nestedTuple(64);
    const data = toBytes(`0x${'00'.repeat(32)}`);
    // The tree stays decoded (03 D-01's "a node can be both decoded and flagged"): the cutoff
    // produces an error node AT THE DEPTH WHERE IT'S CUT OFF, not necessarily at the root, so
    // this walks the tree looking for it rather than asserting on the top-level node directly.
    function findErrorNode(node: DecodeNode): DecodeNode | undefined {
      if (node.error) return node;
      for (const child of node.children ?? []) {
        const found = findErrorNode(child);
        if (found) return found;
      }
      return undefined;
    }
    const [node] = abi().decodeParameters([deepType], data, 0, 0);
    const errorNode = findErrorNode(node);
    expect(errorNode).toBeDefined();
    expect(typeof errorNode!.error).toBe('string');
    expect(errorNode!.error!.length).toBeGreaterThan(0);

    // Parser-side guard (T-05-11): the same hazard from a hand-typed signature string.
    const deepSig = `f(${'('.repeat(40)}uint256${')'.repeat(40)})`;
    const parsed = abi().parseTypeString(deepSig);
    expect('error' in parsed).toBe(true);
  });

  it('a dynamic array of a static element type with a 2^40 length word errors WITHOUT any allocation, completing in under one second', () => {
    const hugeLength = (1n << 40n).toString(16).padStart(64, '0');
    const data = toBytes(`0x${hexWord(32n)}${hugeLength}`);
    const start = Date.now();
    const [node] = abi().decodeParameters(typesFor('f(uint256[])'), data, 0, 0);
    const elapsedMs = Date.now() - start;
    expect(typeof node.error).toBe('string');
    expect(elapsedMs).toBeLessThan(1000);
  });

  it('CR-02: a fixed-size array whose declared length exceeds the payload errors WITHOUT looping, completing in under one second', () => {
    // f(uint256[3000000]) against an EMPTY payload — the reviewer measured this against the
    // compiled module (pre-fix) allocating 3,000,001 nodes in 432ms. It must now fail the
    // pre-loop byte bound in a single check, producing no children at all.
    const data = new Uint8Array(0);
    const start = Date.now();
    const [node] = abi().decodeParameters(typesFor('f(uint256[3000000])'), data, 0, 0);
    const elapsedMs = Date.now() - start;
    expect(typeof node.error).toBe('string');
    expect(node.children).toBeUndefined();
    expect(elapsedMs).toBeLessThan(1000);
  });

  it('CR-02: a fixed array of a zero-width element type defeats a byte-length bound but still errors WITHOUT looping', () => {
    // f(uint256[0][3000000]) — the inner `uint256[0]` element has headWidth 0, so
    // `length * elementWidth` is 0 for ANY length and a byte bound alone is vacuous. The
    // reviewer measured this against the compiled module (pre-fix) producing 3,000,001 nodes
    // in 487ms with NO error node anywhere in the tree. elementWidth === 0 must be rejected
    // outright, regardless of how small or large the declared length is.
    const data = new Uint8Array(0);
    const start = Date.now();
    const [node] = abi().decodeParameters(typesFor('f(uint256[0][3000000])'), data, 0, 0);
    const elapsedMs = Date.now() - start;
    expect(typeof node.error).toBe('string');
    expect(node.children).toBeUndefined();
    expect(elapsedMs).toBeLessThan(1000);
  });

  it('CR-02: nested fixed arrays that each individually pass the byte bound are still capped by a total node budget', () => {
    // f(uint256[25][25][25]) = 25 * 25 * 25 = 15,625 uint256 leaves, none of which trips the
    // per-array byte bound on its own (the payload below is sized to hold every one of them),
    // so only a total node budget across the whole decode — not a per-array check — can bound
    // the output. The budget is 10,000 nodes; the tree returned must stay well under the
    // 16,276-node (1 + 25 + 625 + 15,625) unbounded total.
    const data = new Uint8Array(25 * 25 * 25 * 32);
    function countNodes(n: DecodeNode): number {
      return 1 + (n.children ?? []).reduce((sum, c) => sum + countNodes(c), 0);
    }
    const start = Date.now();
    const [node] = abi().decodeParameters(typesFor('f(uint256[25][25][25])'), data, 0, 0);
    const elapsedMs = Date.now() - start;
    expect(countNodes(node)).toBeLessThan(11000);
    expect(elapsedMs).toBeLessThan(1000);
  });

  it('argument nodes appear in declaration order for a 5-argument signature', () => {
    const specs: EncSpec[] = [
      { t: 'uint', v: 1n },
      { t: 'uint', v: 2n },
      { t: 'uint', v: 3n },
      { t: 'uint', v: 4n },
      { t: 'uint', v: 5n },
    ];
    const nodes = abi().decodeParameters(typesFor('f(uint256,uint256,uint256,uint256,uint256)'), payload(specs), 0, 0);
    expect(nodes.map((n) => n.value)).toEqual([1n, 2n, 3n, 4n, 5n]);
  });

  it('array element nodes appear in index order for a 3-element array', () => {
    const specs: EncSpec[] = [
      {
        t: 'array',
        items: [
          { t: 'uint', v: 10n },
          { t: 'uint', v: 20n },
          { t: 'uint', v: 30n },
        ],
      },
    ];
    const [node] = abi().decodeParameters(typesFor('f(uint256[])'), payload(specs), 0, 0);
    expect(node.children!.map((c) => c.value)).toEqual([10n, 20n, 30n]);
  });
});
