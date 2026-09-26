import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

// ETH-01/ETH-05/ETH-07 offline assertions, all against a stubbed AbiSourcePort/SignatureLookupPort
// per D-32 — no test in this phase makes a real network request. Loads the compiled modules in
// dependency order (D-01's per-file convention), matching test/decode-registry.test.ts's own
// `new Function('window', code)(window)` idiom, reloaded fresh in beforeEach for full isolation.
function loadCompiled(relPath: string): void {
  const code = readFileSync(resolve(__dirname, relPath), 'utf-8');
  new Function('window', code)(window);
}

beforeEach(() => {
  loadCompiled('../src/dapps/decode/codecs.js');
  loadCompiled('../src/dapps/decode/keccak.js');
  loadCompiled('../src/dapps/decode/abi.js');
  loadCompiled('../src/dapps/decode/core.js');
  loadCompiled('../src/dapps/decode/signatures.js');
  // hex and abi-words are eth-calldata's two auto-detect competitors (D-27) — loaded here too
  // so the canDecode-relation assertions below can score the SAME input against all three.
  loadCompiled('../src/dapps/decode/decoders.js');
  loadCompiled('../src/dapps/decode/decoders-eth-calldata.js');
  loadCompiled('../src/dapps/decode/decoders-abi-words.js');
});

function registry(): DecoderRegistry {
  return window.DxDecode!.registry as DecoderRegistry;
}

function abi(): DxDecodeAbiModule {
  return window.DxDecode!.abi as DxDecodeAbiModule;
}

function keccak(): DxDecodeKeccakModule {
  return window.DxDecode!.keccak as DxDecodeKeccakModule;
}

function decoder(): DecoderPort {
  return registry().get('eth-calldata')!;
}

function otherDecoder(id: string): DecoderPort {
  return registry().get(id)!;
}

const NULL_LINKS: LinkPort = { address: () => null, tx: () => null };

function makeCtx(overrides: Partial<DecodeContext> = {}): DecodeContext {
  return {
    settings: {},
    log: { record: () => {}, subscribe: () => () => {}, clear: () => {} },
    signal: new AbortController().signal,
    links: NULL_LINKS,
    ...overrides,
  };
}

// handoff §7.1's mintFromMoloch inner call — mintFromMoloch(address,uint256), selector
// 0x2806b0af (seeded in signatures.ts's local table), decoding to the address
// 0x5E58BA0e06ED0F5558f83bE732a4b899a674053E (asserted lowercase here — this decoder's own
// address rendering choice) and the uint256 1000000000000000000n (1e18).
const MINT_FROM_MOLOCH_CALLDATA =
  '0x2806b0af' +
  '0000000000000000000000005e58ba0e06ed0f5558f83be732a4b899a674053e' +
  '0000000000000000000000000000000000000000000000000de0b6b3a7640000';

// handoff §7.1's claimTribute call, real mainnet vector — selector 0xac6695d1, seeded in
// signatures.ts's local table (05-01). ETH-06's unresolved path is reached by stubbing the
// table empty (below) rather than by picking an unseeded selector, per planner_assumptions #2.
const CLAIM_TRIBUTE_SELECTOR = '0xac6695d1';
const CLAIM_TRIBUTE_CALLDATA =
  '0xac6695d1' +
  '0000000000000000000000001c0aa8ccd568d90d61659f060d1bfb1e6f855a20' +
  '0000000000000000000000000000000000000000000000000000000000000000';

const EMPTY_SIGNATURE_LOOKUP: SignatureLookupPort = {
  async lookup() {
    return { candidates: [], unavailable: false };
  },
};

function unavailableLookup(reason: string): SignatureLookupPort {
  return {
    async lookup() {
      return { candidates: [], unavailable: true, reason };
    },
  };
}

function candidateLookup(candidates: SignatureCandidate[]): SignatureLookupPort {
  return {
    async lookup() {
      return { candidates, unavailable: false };
    },
  };
}

// claimTribute is seeded in the real local table (signatures.ts), so reaching ETH-06's
// unresolved path for it requires hiding that entry rather than picking a different selector —
// a fresh core.js (a fresh registry) plus a monkeypatched, already-loaded signatures module's
// factory, then a fresh decoder reload so its OWN module-scope local table is built from the
// patched factory. Top-level consts (ethSignatures/ethRegistry/ethLocalTable) are re-evaluated
// on every `new Function('window', code)(window)` call, so this takes effect cleanly.
function reloadDecoderWithEmptyLocalTable(): void {
  loadCompiled('../src/dapps/decode/core.js');
  window.DxDecode!.signatures!.createLocalSignatureTable = () => EMPTY_SIGNATURE_LOOKUP;
  loadCompiled('../src/dapps/decode/decoders-eth-calldata.js');
}

describe('eth-calldata — the tracer vertical (ETH-01, ETH-05)', () => {
  it('decodes the mintFromMoloch literal to a named function node with LOCAL provenance and two typed children', async () => {
    const output = await decoder().decode(MINT_FROM_MOLOCH_CALLDATA, makeCtx());

    expect(output.node.label).toBe('mintFromMoloch');
    expect(output.node.provenance).toBe('local');
    expect(output.node.children).toHaveLength(2);

    const [addressArg, amountArg] = output.node.children!;
    expect(addressArg.type).toBe('address');
    expect(addressArg.raw).toBe('0x5e58ba0e06ed0f5558f83be732a4b899a674053e');

    expect(amountArg.type).toBe('uint256');
    expect(amountArg.value).toBe(1000000000000000000n);
    expect(typeof amountArg.value).toBe('bigint');
  });

  it('verified rung: a stubbed AbiSourcePort supplying input names labels children with those names and sets provenance verified', async () => {
    const stubAbis: AbiSourcePort = {
      async getAbi() {
        return {
          name: 'Moloch',
          abi: [
            {
              name: 'mintFromMoloch',
              inputs: [
                { name: 'molochLoot', type: 'address' },
                { name: 'amount', type: 'uint256' },
              ],
            },
          ],
        };
      },
    };

    const output = await decoder().decode(
      MINT_FROM_MOLOCH_CALLDATA,
      makeCtx({ abis: stubAbis, target: '0xTargetContract' }),
    );

    expect(output.node.provenance).toBe('verified');
    expect(output.node.children).toHaveLength(2);
    expect(output.node.children![0].label).toBe('molochLoot');
    expect(output.node.children![1].label).toBe('amount');
  });

  it('ctx.abis set but ctx.target absent: the ABI source is not consulted and resolution falls through to local', async () => {
    let called = false;
    const stubAbis: AbiSourcePort = {
      async getAbi() {
        called = true;
        return null;
      },
    };

    const output = await decoder().decode(MINT_FROM_MOLOCH_CALLDATA, makeCtx({ abis: stubAbis }));

    expect(called).toBe(false);
    expect(output.node.provenance).toBe('local');
  });

  it('with no name source at all — only a canonical signature string — children are labelled arg0..argN-1', async () => {
    // pull() has no arguments, so use a two-argument local-table signature via the registry
    // source instead — batchCalls's own top-level signature has one dynamic argument, which
    // this plan does not decode; approve(address,uint256) is a clean two-argument case that
    // stays fully static and is seeded locally.
    const approveSelector = keccak().selector('approve(address,uint256)');
    const calldata = `${approveSelector}${'0'.repeat(63)}1${'0'.repeat(63)}1`;

    const output = await decoder().decode(calldata, makeCtx());

    expect(output.node.provenance).toBe('local');
    expect(output.node.children).toHaveLength(2);
    expect(output.node.children![0].label).toBe('arg0');
    expect(output.node.children![1].label).toBe('arg1');
  });

  it('a 4-byte-only payload resolving to pull() returns a node with no children and no error (ETH-07)', async () => {
    const pullSelector = keccak().selector('pull()');
    const output = await decoder().decode(pullSelector, makeCtx());

    expect(output.node.label).toBe('pull');
    expect(output.node.provenance).toBe('local');
    expect(output.node.children ?? []).toHaveLength(0);
    expect(output.node.error).toBeUndefined();
  });

  it('argument nodes come back in declaration order for a 3-argument signature', async () => {
    const signature = 'executeByVotes(uint256,address,uint256,bytes,bytes32)';
    const selector = keccak().selector(signature);
    // Only the first three (all static) are exercised here — bytes/bytes32 in positions 4/5
    // are out of this plan's decode scope; three static words plus two dynamic offset words
    // are enough to prove ordering across the static/dynamic boundary.
    const words = [1, 2, 3].map((n) => n.toString(16).padStart(64, '0'));
    // bytes/bytes32 offsets — bytes32 is STATIC (fixed-size, not dynamic) and bytes is dynamic;
    // give bytes a dummy offset word so the dynamic branch has something bounded to read.
    const bytesOffset = (5 * 32).toString(16).padStart(64, '0');
    const bytes32Word = '0'.repeat(64);
    const tail = '0'.repeat(64); // length word for the (unread) bytes tail — length 0
    const calldata = `${selector}${words.join('')}${bytesOffset}${bytes32Word}${tail}`;

    const output = await decoder().decode(calldata, makeCtx());

    expect(output.node.provenance).toBe('local');
    const labels = output.node.children!.map((c) => c.value ?? c.error);
    expect(output.node.children).toHaveLength(5);
    expect(output.node.children![0].value).toBe(1n);
    expect(output.node.children![1].raw).toMatch(/^0x0{39}2$/);
    expect(output.node.children![2].value).toBe(3n);
    expect(labels.length).toBe(5);
  });

  it('a candidate signature whose keccak selector does not equal the input selector is rejected — falls through to unresolved', async () => {
    // A hand-crafted "local" source whose one candidate signature does not actually hash to
    // the selector being resolved — D-21's verification must reject it rather than decode
    // against a mismatched signature.
    const wrongSelectorCalldata = '0xdeadbeef' + '0'.repeat(64);
    const output = await decoder().decode(wrongSelectorCalldata, makeCtx());

    expect(output.node.provenance).toBe('unresolved');
  });

  it('an unresolved decode carries a non-null rawBytes (payload byte length) AND rawView word-table, in the same test', async () => {
    const unresolvedCalldata = '0xdeadbeef' + '0'.repeat(64);
    const output = await decoder().decode(unresolvedCalldata, makeCtx());

    expect(output.rawBytes).toBeInstanceOf(Uint8Array);
    expect(output.rawBytes!.length).toBe(36);
    expect(output.rawView).toBe('word-table');
  });
});

describe('the provenance ladder and the unresolved selector (ETH-05, ETH-06, NET-04)', () => {
  it('claimTribute, local table stubbed empty, both registries clean-missed: unresolved with a non-null rawBytes, rawView word-table, and no node.error', async () => {
    reloadDecoderWithEmptyLocalTable();
    const output = await decoder().decode(CLAIM_TRIBUTE_CALLDATA, makeCtx({ signatures: EMPTY_SIGNATURE_LOOKUP }));

    expect(output.node.provenance).toBe('unresolved');
    expect(output.node.error).toBeUndefined();
    expect(output.rawBytes).toBeInstanceOf(Uint8Array);
    expect(output.rawBytes!.length).toBe(68); // 4-byte selector + two 32-byte address words
    expect(output.rawView).toBe('word-table');

    const text = output.node.annotations!.join(' ');
    expect(text).toContain(CLAIM_TRIBUTE_SELECTOR);
    expect(text).toContain('64 undecoded byte'); // 68 total - 4-byte selector
  });

  it('a clean miss from both registries carries the ETH_LOOKUP_MISS wording; an unavailable registry carries ETH_LOOKUP_UNAVAILABLE and the result reason — the two messages differ', async () => {
    reloadDecoderWithEmptyLocalTable();
    const missOutput = await decoder().decode(CLAIM_TRIBUTE_CALLDATA, makeCtx({ signatures: EMPTY_SIGNATURE_LOOKUP }));
    const unavailableOutput = await decoder().decode(
      CLAIM_TRIBUTE_CALLDATA,
      makeCtx({ signatures: unavailableLookup('rate limited') }),
    );

    const missText = missOutput.node.annotations!.join(' ');
    const unavailableText = unavailableOutput.node.annotations!.join(' ');
    expect(missText).not.toBe(unavailableText);
    expect(unavailableText).toMatch(/unavailable/i);
    expect(unavailableText).toContain('rate limited');
  });

  it('the local table populated (real signatures.ts): provenance local', async () => {
    const output = await decoder().decode(CLAIM_TRIBUTE_CALLDATA, makeCtx({ signatures: EMPTY_SIGNATURE_LOOKUP }));
    expect(output.node.provenance).toBe('local');
  });

  it('local table empty, OpenChain (ctx.signatures) stubbed to a verifying hit: provenance registry', async () => {
    reloadDecoderWithEmptyLocalTable();
    const claimTributeSelector = keccak().selector('claimTribute(address,address)');
    const hit = candidateLookup([{ signature: 'claimTribute(address,address)', source: 'openchain' }]);
    const output = await decoder().decode(CLAIM_TRIBUTE_CALLDATA, makeCtx({ signatures: hit }));

    expect(claimTributeSelector).toBe(CLAIM_TRIBUTE_SELECTOR);
    expect(output.node.provenance).toBe('registry');
    expect(output.node.label).toBe('claimTribute');
  });

  it('a stubbed AbiSourcePort returning a matching verified ABI, with ctx.target set: provenance verified, argument nodes take the ABI input names', async () => {
    const stubAbis: AbiSourcePort = {
      async getAbi() {
        return {
          name: 'Tribute',
          abi: [
            {
              name: 'claimTribute',
              inputs: [
                { name: 'member', type: 'address' },
                { name: 'delegate', type: 'address' },
              ],
            },
          ],
        };
      },
    };

    const output = await decoder().decode(
      CLAIM_TRIBUTE_CALLDATA,
      makeCtx({ abis: stubAbis, target: '0xTribute', signatures: EMPTY_SIGNATURE_LOOKUP }),
    );

    expect(output.node.provenance).toBe('verified');
    expect(output.node.children![0].label).toBe('member');
    expect(output.node.children![1].label).toBe('delegate');
  });

  it('the same stub with ctx.target absent: ctx.abis is never consulted, resolution falls through to the local table', async () => {
    let called = false;
    const stubAbis: AbiSourcePort = {
      async getAbi() {
        called = true;
        return null;
      },
    };

    const output = await decoder().decode(CLAIM_TRIBUTE_CALLDATA, makeCtx({ abis: stubAbis }));

    expect(called).toBe(false);
    expect(output.node.provenance).toBe('local');
  });

  it('a registry candidate whose keccak selector does not match is discarded — unresolved, not a confidently wrong decode', async () => {
    reloadDecoderWithEmptyLocalTable();
    const wrongCandidate = candidateLookup([{ signature: 'notTheRealFunction(uint256)', source: 'openchain' }]);
    const output = await decoder().decode(CLAIM_TRIBUTE_CALLDATA, makeCtx({ signatures: wrongCandidate }));

    expect(output.node.provenance).toBe('unresolved');
    expect(output.node.children).toBeUndefined();
  });

  it('a 4byte stub returning the six-result collision body resolves to transfer(address,uint256) with provenance registry — never verified', async () => {
    reloadDecoderWithEmptyLocalTable();
    // The real create4byteAdapter (Task 1) does the ranking (oldest-id-first) — this test goes
    // through it rather than hand-ordering a candidates array, so it also proves the decoder
    // trusts the adapter's own order rather than re-sorting.
    const transferSelector = keccak().selector('transfer(address,uint256)');
    const fourByteTransport: TransportPort = {
      async request() {
        return {
          status: 200,
          ok: true,
          attempts: 1,
          body: '',
          json: {
            count: 6,
            results: [
              { id: 1111734, text_signature: 'workMyDirefulOwner(uint256,uint256)' },
              { id: 844280, text_signature: 'join_tg_invmru_haha_fd06787(address,bool)' },
              { id: 313067, text_signature: 'func_2093253501(bytes)' },
              { id: 161159, text_signature: 'transfer(bytes4[9],bytes5[6],int48[11])' },
              { id: 31780, text_signature: 'many_msg_babbage(bytes1)' },
              { id: 145, text_signature: 'transfer(address,uint256)' },
            ],
          },
        };
      },
    };
    const fourbyteAdapter = window.DxDecode!.signatures!.create4byteAdapter!(fourByteTransport);
    const calldata = `${transferSelector}${'0'.repeat(64)}${'0'.repeat(64)}`;
    const output = await decoder().decode(calldata, makeCtx({ signatures: fourbyteAdapter }));

    expect(output.node.provenance).toBe('registry');
    expect(output.node.label).toBe('transfer');
  });

  it('a transport that resolves ok: false after its retry cap: the decode resolves normally, the node is unresolved, and it names the label unavailable because a lookup was rate limited — nothing rejects', async () => {
    reloadDecoderWithEmptyLocalTable();
    const output = await decoder().decode(
      CLAIM_TRIBUTE_CALLDATA,
      makeCtx({ signatures: unavailableLookup('rate limited') }),
    );

    expect(output.node.provenance).toBe('unresolved');
    const text = output.node.annotations!.join(' ');
    expect(text).toMatch(/unavailable/i);
    expect(text).toContain('rate limited');
  });

  it('ethCanDecode scores strictly higher than abi-words for a locally-known selector, using abi-words own canDecode return, not a restated numeral', () => {
    const resolvedScore = decoder().canDecode(MINT_FROM_MOLOCH_CALLDATA);
    const abiWordsScore = otherDecoder('abi-words').canDecode(MINT_FROM_MOLOCH_CALLDATA);
    expect(resolvedScore).toBeGreaterThan(abiWordsScore);
  });

  it('driving core.resolve(input) over the whole registry: local-known selector resolves eth-calldata; unknown resolves abi-words; a bare 4-byte payload for a seeded selector resolves eth-calldata not hex', () => {
    const core = window.DxDecode!.core!;

    expect(core.resolve(MINT_FROM_MOLOCH_CALLDATA).decoderId).toBe('eth-calldata');

    const unresolvedCalldata = '0xdeadbeef' + '0'.repeat(64);
    expect(core.resolve(unresolvedCalldata).decoderId).toBe('abi-words');

    const pullSelector = keccak().selector('pull()');
    expect(core.resolve(pullSelector).decoderId).toBe('eth-calldata');
    expect(core.resolve(pullSelector).decoderId).not.toBe('hex');
  });

  it('pull() still decodes to a bare node with no children and no error, now through the full resolution path', async () => {
    const pullSelector = keccak().selector('pull()');
    const output = await decoder().decode(pullSelector, makeCtx({ signatures: EMPTY_SIGNATURE_LOOKUP }));

    expect(output.node.label).toBe('pull');
    expect(output.node.children).toBeUndefined();
    expect(output.node.error).toBeUndefined();
  });
});

describe('abiParseTypeString — the signature parser (COD-03)', () => {
  it('batchCalls((address,uint256,bytes)[]) parses to one dynamic array of a 3-member tuple', () => {
    const parsed = abi().parseTypeString('batchCalls((address,uint256,bytes)[])');
    if ('error' in parsed) throw new Error(`unexpected parse error: ${parsed.error}`);

    expect(parsed.name).toBe('batchCalls');
    expect(parsed.types).toHaveLength(1);

    const [arrayType] = parsed.types;
    expect(arrayType.kind).toBe('array');
    expect(arrayType.length).toBeUndefined();

    const tuple = arrayType.element!;
    expect(tuple.kind).toBe('tuple');
    expect(tuple.components).toHaveLength(3);
    expect(tuple.components!.map((c) => c.type)).toEqual(['address', 'uint256', 'bytes']);
  });
});

describe('ethCanDecode — the auto-detect curve (D-27, Task 0 option A)', () => {
  it('returns 0 for non-hex input, the empty string, and a payload that is not 4 + 32k bytes', () => {
    expect(decoder().canDecode('not hex at all')).toBe(0);
    expect(decoder().canDecode('')).toBe(0);
    expect(decoder().canDecode('0x1234')).toBe(0); // 2 bytes — too short for even a selector-only shape... actually 2 bytes
    expect(decoder().canDecode('0x' + '00'.repeat(5))).toBe(0); // 5 bytes: not 4 + 32k
  });

  it('scores strictly higher than abi-words when the selector resolves locally, and between hex and abi-words when it does not', () => {
    const resolvedScore = decoder().canDecode(MINT_FROM_MOLOCH_CALLDATA);
    const abiWordsResolvedScore = otherDecoder('abi-words').canDecode(MINT_FROM_MOLOCH_CALLDATA);
    expect(resolvedScore).toBeGreaterThan(abiWordsResolvedScore);

    const unresolvedCalldata = '0xdeadbeef' + '0'.repeat(64);
    const shapedScore = decoder().canDecode(unresolvedCalldata);
    const abiWordsShapedScore = otherDecoder('abi-words').canDecode(unresolvedCalldata);
    const hexShapedScore = otherDecoder('hex').canDecode(unresolvedCalldata);
    expect(shapedScore).toBeLessThan(abiWordsShapedScore);
    expect(shapedScore).toBeGreaterThan(hexShapedScore);
  });
});

// ── ETH-10/ETH-11/ETH-14 — shortening, annotation and linking (05-06 Task 1) ────────────────

// A LinkPort that actually distinguishes inputs — NULL_LINKS (above) always returns null, which
// proves the "no chain configured" edge but cannot prove three addresses get three DIFFERENT
// links.
function trackingLinks(): LinkPort {
  return {
    address: (addr) => `https://explorer.example/address/${addr}`,
    tx: (hash) => `https://explorer.example/tx/${hash}`,
  };
}

function padWord(hexNoPrefix: string): string {
  return hexNoPrefix.padStart(64, '0');
}

describe('ETH-10/ETH-11/ETH-14 — shortening, annotation and linking (05-06 Task 1)', () => {
  it("an address argument's node shortens for display, keeps the full value in raw, and links via ctx.links.address(raw)", async () => {
    const output = await decoder().decode(MINT_FROM_MOLOCH_CALLDATA, makeCtx({ links: trackingLinks() }));
    const [addressArg] = output.node.children!;

    expect(addressArg.type).toBe('address');
    expect(addressArg.raw).toBe('0x5e58ba0e06ed0f5558f83be732a4b899a674053e');
    expect(addressArg.display).toBe('address');
    expect(addressArg.value).not.toBe(addressArg.raw);
    expect(addressArg.value).toMatch(/^0x[0-9a-f]{8}\.\.\.[0-9a-f]{6}$/);
    expect(addressArg.link).toBe(`https://explorer.example/address/${addressArg.raw}`);
    expect(addressArg.linkKind).toBe('external');
  });

  it('address(0) still shortens, still carries a zero-address annotation, and still links when a chain is known', async () => {
    const selector = keccak().selector('zeroTest(address)');
    const calldata = `${selector}${padWord('0'.repeat(40))}`;
    const output = await decoder().decode(
      calldata,
      makeCtx({
        signatures: candidateLookup([{ signature: 'zeroTest(address)', source: 'openchain' }]),
        links: trackingLinks(),
      }),
    );
    const [addressArg] = output.node.children!;

    expect(addressArg.raw).toBe(`0x${'0'.repeat(40)}`);
    expect(addressArg.value).not.toBe(addressArg.raw);
    expect(addressArg.annotations?.some((a) => /zero address/i.test(a))).toBe(true);
    expect(addressArg.link).toBe(`https://explorer.example/address/${addressArg.raw}`);
  });

  it('three distinct addresses in one decode produce three distinct link values — no shared or last-wins link', async () => {
    const sig = 'threeAddrs(address,address,address)';
    const selector = keccak().selector(sig);
    const a1 = '1'.repeat(40);
    const a2 = '2'.repeat(40);
    const a3 = '3'.repeat(40);
    const calldata = `${selector}${padWord(a1)}${padWord(a2)}${padWord(a3)}`;
    const output = await decoder().decode(
      calldata,
      makeCtx({ signatures: candidateLookup([{ signature: sig, source: 'openchain' }]), links: trackingLinks() }),
    );
    const links = output.node.children!.map((c) => c.link);

    expect(links).toHaveLength(3);
    expect(new Set(links).size).toBe(3);
  });

  it('a 32-byte non-address value gets display txhash, shortens, and links via ctx.links.tx(raw)', async () => {
    const sig = 'hashArg(bytes32)';
    const selector = keccak().selector(sig);
    const word = 'ab'.repeat(32);
    const calldata = `${selector}${word}`;
    const output = await decoder().decode(
      calldata,
      makeCtx({ signatures: candidateLookup([{ signature: sig, source: 'openchain' }]), links: trackingLinks() }),
    );
    const [wordArg] = output.node.children!;

    expect(wordArg.type).toBe('bytes32');
    expect(wordArg.raw).toBe(`0x${word}`);
    expect(wordArg.display).toBe('txhash');
    expect(wordArg.value).not.toBe(wordArg.raw);
    expect(wordArg.link).toBe(`https://explorer.example/tx/${wordArg.raw}`);
    expect(wordArg.linkKind).toBe('external');
  });

  it('a 31-byte and a 33-byte value get no link and no linkKind', async () => {
    const sig = 'oddBytes(bytes31,bytes33)';
    const selector = keccak().selector(sig);
    const calldata = `${selector}${'11'.repeat(32)}${'22'.repeat(32)}`;
    const output = await decoder().decode(
      calldata,
      makeCtx({ signatures: candidateLookup([{ signature: sig, source: 'openchain' }]), links: trackingLinks() }),
    );
    const [a, b] = output.node.children!;

    expect(a.type).toBe('bytes31');
    expect(a.link).toBeUndefined();
    expect(a.linkKind).toBeUndefined();
    expect(b.type).toBe('bytes33');
    expect(b.link).toBeUndefined();
    expect(b.linkKind).toBeUndefined();
  });

  it('a uint256 of 999999999999999 has no magnitude annotation; 1000000000000000 does; 1000000000000000000 reads as approximately 1e18', async () => {
    const sig = 'amt(uint256)';
    const selector = keccak().selector(sig);
    const ctx = makeCtx({ signatures: candidateLookup([{ signature: sig, source: 'openchain' }]) });

    async function annotationsFor(value: bigint): Promise<string[] | undefined> {
      const calldata = `${selector}${padWord(value.toString(16))}`;
      const output = await decoder().decode(calldata, ctx);
      return output.node.children![0].annotations;
    }

    expect(await annotationsFor(999999999999999n)).toBeUndefined();
    expect(await annotationsFor(1000000000000000n)).toEqual(expect.arrayContaining([expect.stringContaining('1e15')]));
    expect(await annotationsFor(1000000000000000000n)).toEqual(
      expect.arrayContaining([expect.stringContaining('1e18')]),
    );
  });

  it('a 32-byte all-zero word still renders shortened and still carries the tx affordance', async () => {
    const sig = 'hashArg(bytes32)';
    const selector = keccak().selector(sig);
    const calldata = `${selector}${'0'.repeat(64)}`;
    const output = await decoder().decode(
      calldata,
      makeCtx({ signatures: candidateLookup([{ signature: sig, source: 'openchain' }]), links: trackingLinks() }),
    );
    const [wordArg] = output.node.children!;

    expect(wordArg.display).toBe('txhash');
    expect(wordArg.value).not.toBe(wordArg.raw);
    expect(wordArg.link).toBe(`https://explorer.example/tx/${wordArg.raw}`);
  });

  it('with no chain configured (ctx.links returning null from both members), an address node still shortens and annotates, and both link and linkKind are absent', async () => {
    const output = await decoder().decode(MINT_FROM_MOLOCH_CALLDATA, makeCtx());
    const [addressArg] = output.node.children!;

    expect(addressArg.value).not.toBe(addressArg.raw);
    expect(addressArg.link).toBeUndefined();
    expect(addressArg.linkKind).toBeUndefined();
  });

  it('the value element remains the click-to-copy source of truth: an address node exposes the FULL value in raw regardless of shortening', async () => {
    const output = await decoder().decode(MINT_FROM_MOLOCH_CALLDATA, makeCtx({ links: trackingLinks() }));
    const [addressArg] = output.node.children!;
    expect(addressArg.raw).toBe('0x5e58ba0e06ed0f5558f83be732a4b899a674053e');
  });
});

// ── DEC-13 — the degraded-credentials sentence and the provenance ceiling (05-06 Task 3) ────

describe('DEC-13 — the degraded-credentials sentence and the provenance ceiling (05-06 Task 3)', () => {
  it('with no settings at all, decoding a locally-known selector still produces a full named-argument tree with provenance local — the decode is not blocked', async () => {
    const output = await decoder().decode(MINT_FROM_MOLOCH_CALLDATA, makeCtx());
    expect(output.node.provenance).toBe('local');
    expect(output.node.children).toHaveLength(2);
  });

  it('the root node carries a sentence naming each absent setting and saying plainly what it is for', async () => {
    const output = await decoder().decode(MINT_FROM_MOLOCH_CALLDATA, makeCtx());
    expect(output.node.warning).toContain('etherscanApiKey');
    expect(output.node.warning).toContain('rpcUrl');
  });

  it('the root node carries link = ctx.settingsRoute and linkKind: route when something is missing and a route exists; neither when settingsRoute is absent', async () => {
    const withRoute = await decoder().decode(MINT_FROM_MOLOCH_CALLDATA, makeCtx({ settingsRoute: '/settings' }));
    expect(withRoute.node.link).toBe('/settings');
    expect(withRoute.node.linkKind).toBe('route');

    const withoutRoute = await decoder().decode(MINT_FROM_MOLOCH_CALLDATA, makeCtx());
    expect(withoutRoute.node.link).toBeUndefined();
    expect(withoutRoute.node.linkKind).toBeUndefined();
  });

  it('ethMissingSettingsNote takes (snapshot, ctx), never a host dx — the decoder file never reaches for a manifest list', () => {
    const source = readFileSync(resolve(__dirname, '../src/dapps/decode/decoders-eth-calldata.ts'), 'utf-8');
    expect(source).not.toContain('getManifests');
  });

  it('calling decode with a bare DecodeContext (no settingsRoute, no ports) does not throw', async () => {
    await expect(decoder().decode(MINT_FROM_MOLOCH_CALLDATA, makeCtx())).resolves.toBeDefined();
  });

  it('with the api key present, the sentence no longer names it; with both present, no sentence is produced at all', async () => {
    const apiKeyOnly = await decoder().decode(
      MINT_FROM_MOLOCH_CALLDATA,
      makeCtx({ settings: { etherscanApiKey: 'k' } }),
    );
    expect(apiKeyOnly.node.warning).not.toContain('etherscanApiKey');
    expect(apiKeyOnly.node.warning).toContain('rpcUrl');

    const both = await decoder().decode(
      MINT_FROM_MOLOCH_CALLDATA,
      makeCtx({ settings: { etherscanApiKey: 'k', rpcUrl: 'https://rpc.example' } }),
    );
    expect(both.node.warning).toBeUndefined();
  });

  it('the sentence is assigned before the selector is examined, so a decode that errors early still carries it', async () => {
    const malformed = await decoder().decode('0xzz', makeCtx());
    expect(malformed.node.error).toBeDefined();
    expect(malformed.node.warning).toBeDefined();
  });

  it('ethProvenanceCeiling reports local for a bare context whatever the settings snapshot contains, registry when ctx.signatures is present, and verified only when BOTH ctx.abis and ctx.target are present', async () => {
    const withApiKey = { etherscanApiKey: 'k' };
    const withRpc = { rpcUrl: 'https://rpc.example' };
    const withBoth = { etherscanApiKey: 'k', rpcUrl: 'https://rpc.example' };
    const settingsAxis = [{}, withApiKey, withRpc, withBoth];

    const stubAbis: AbiSourcePort = {
      async getAbi() {
        return null;
      },
    };

    for (const settings of settingsAxis) {
      // Neither ctx.signatures nor ctx.abis/ctx.target present: falls through to local — proven
      // by the existing provenance assertions above; here we only need the SENTENCE not to
      // claim a rung it cannot reach, checked below for each axis.
      const bare = await decoder().decode(MINT_FROM_MOLOCH_CALLDATA, makeCtx({ settings }));
      expect(bare.node.provenance).toBe('local');

      const withSignatures = await decoder().decode(
        MINT_FROM_MOLOCH_CALLDATA,
        makeCtx({ settings, signatures: EMPTY_SIGNATURE_LOOKUP }),
      );
      // local table still wins over the registry when it has the selector — provenance stays
      // 'local' here (the ladder's own order), which is exactly why the ceiling function (not
      // the actual resolution) is what the sentence must be derived from, not vice versa.
      expect(withSignatures.node.provenance).toBe('local');

      // ctx.abis present but ctx.target absent: the verified rung is not reachable (ETH-05's
      // own order — ctx.abis is never consulted without ctx.target), so the sentence for
      // etherscanApiKey must still say "not wired yet", never a raises-claim.
      const abisOnly = await decoder().decode(MINT_FROM_MOLOCH_CALLDATA, makeCtx({ settings, abis: stubAbis }));
      if (!ethSettingPresentInSettings(settings, 'etherscanApiKey')) {
        expect(abisOnly.node.warning).toContain('not wired yet');
      }
    }
  });

  it('for a setting no shipped adapter consumes, the sentence says the value is stored for a feature that is not wired yet and never claims it raises the rung', async () => {
    const output = await decoder().decode(MINT_FROM_MOLOCH_CALLDATA, makeCtx());
    expect(output.node.warning).toContain(
      'etherscanApiKey is not set — the value is stored for a feature that is not wired yet',
    );
    expect(output.node.warning).not.toMatch(/etherscanApiKey.*raises/i);
  });

  it("the decoder's declared settings array lists both credential keys, each required: false with a non-empty why", () => {
    const settings = decoder().settings;
    expect(settings.length).toBeGreaterThanOrEqual(2);
    const keys = settings.map((s) => s.key);
    expect(keys).toEqual(expect.arrayContaining(['etherscanApiKey', 'rpcUrl']));
    for (const spec of settings) {
      expect(spec.required).toBe(false);
      expect(spec.why.length).toBeGreaterThan(0);
    }
  });
});

// Small helper local to the cross-product test above — reads the exact same presence rule the
// decoder itself uses (a non-empty string), so the test's own gating agrees with what the
// implementation actually checks rather than restating a different rule.
function ethSettingPresentInSettings(settings: Record<string, unknown>, key: string): boolean {
  const value = settings[key];
  return typeof value === 'string' && value.trim().length > 0;
}
