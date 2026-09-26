import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

// ETH-02/D-19/D-20 offline assertions — the recursion pass proven both directly (against
// synthetic DecodeNode fixtures, exercising every bound and every outcome branch) and end to end
// (the handoff §7.1 outer payload, hand-encoded below). Loads the compiled modules in dependency
// order (D-01's per-file convention), copying test/decode-eth-calldata.test.ts's own
// `new Function('window', code)(window)` idiom and beforeEach load order, with annotators.js
// inserted after signatures.js and before decoders-eth-calldata.js — manifest.json's own order.
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
  loadCompiled('../src/dapps/decode/annotators.js');
  loadCompiled('../src/dapps/decode/decoders-eth-calldata.js');
});

// Mirrors test/decode-eth-calldata.test.ts's own reloadDecoderWithEmptyLocalTable — claimTribute
// is seeded in the REAL local table (signatures.ts), so reaching the unresolved path for it
// requires hiding that entry rather than picking an unseeded selector. Top-level consts
// (ethSignatures/ethRegistry/ethLocalTable) are re-evaluated on every `new Function('window',
// code)(window)` call, so patching the factory before reloading decoders-eth-calldata.js takes
// effect cleanly. Kept local to this file (TST-03's own offline claim) rather than imported —
// this directory has no import mechanism (D-08).
const EMPTY_SIGNATURE_LOOKUP: SignatureLookupPort = {
  async lookup() {
    return { candidates: [], unavailable: false };
  },
};

function reloadDecoderWithEmptyLocalTable(): void {
  loadCompiled('../src/dapps/decode/core.js');
  window.DxDecode!.signatures!.createLocalSignatureTable = () => EMPTY_SIGNATURE_LOOKUP;
  loadCompiled('../src/dapps/decode/decoders-eth-calldata.js');
}

function registry(): DecoderRegistry {
  return window.DxDecode!.registry as DecoderRegistry;
}

function decoder(): DecoderPort {
  return registry().get('eth-calldata')!;
}

function abi(): DxDecodeAbiModule {
  return window.DxDecode!.abi as DxDecodeAbiModule;
}

function keccak(): DxDecodeKeccakModule {
  return window.DxDecode!.keccak as DxDecodeKeccakModule;
}

function annotators(): DxDecodeAnnotatorsModule {
  return window.DxDecode!.annotators as DxDecodeAnnotatorsModule;
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

// ── A small in-test ABI encoder, proven against abi.ts's own decoder before the §7.1 fixture ──
// ── depends on it (Round 2 LOW — see the round-trip test below). Independent of codecs.ts's ──
// ── own Hex codec: hexToBytes is this file's own, deliberately not reusing the SUT. ──────────

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/, '');
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function wordUint(value: bigint | number): string {
  return BigInt(value).toString(16).padStart(64, '0');
}

function wordAddress(addr: string): string {
  return addr.toLowerCase().replace(/^0x/, '').padStart(64, '0');
}

// One length word (in bytes), then the data right-padded to a multiple of 32 — RESEARCH.md
// Pattern 1's own bytes/string tail layout.
function bytesTail(hexData: string): string {
  const clean = hexData.replace(/^0x/, '');
  const byteLen = clean.length / 2;
  const paddedLen = Math.ceil(clean.length / 64) * 64;
  return wordUint(byteLen) + clean.padEnd(paddedLen, '0');
}

type EncArg = { dynamic: false; word: string } | { dynamic: true; tail: string };

// Generic head/tail region assembler (RESEARCH.md Pattern 1) — reused for the top-level
// argument list AND for each dynamic tuple's own head/tail region, exactly as abi.ts's own
// abiDecodeHeadTailRegion is reused for both.
function encodeHeadTail(args: EncArg[]): string {
  let tailCursor = args.length * 32;
  const headWords: string[] = [];
  const tailParts: string[] = [];
  for (const arg of args) {
    if (arg.dynamic) {
      headWords.push(wordUint(tailCursor));
      tailParts.push(arg.tail);
      tailCursor += arg.tail.length / 2;
    } else {
      headWords.push(arg.word);
    }
  }
  return headWords.join('') + tailParts.join('');
}

// A dynamic array of DYNAMIC elements (T[] of dynamic T): a length word, then one offset word
// per element (relative to the position right after the length word — elementHeadBase, in
// abi.ts's own terms), then each element's own self-contained encoding in sequence.
function encodeDynamicArrayOfDynamic(elements: string[]): string {
  let cursor = elements.length * 32;
  const offsetWords: string[] = [];
  for (const el of elements) {
    offsetWords.push(wordUint(cursor));
    cursor += el.length / 2;
  }
  return wordUint(elements.length) + offsetWords.join('') + elements.join('');
}

// One (address,uint256,bytes) tuple, encoded as its own self-contained head/tail region — this
// is what a T[] element offset points at.
function encodeCallTuple(target: string, value: bigint, data: string): string {
  return encodeHeadTail([
    { dynamic: false, word: wordAddress(target) },
    { dynamic: false, word: wordUint(value) },
    { dynamic: true, tail: bytesTail(data) },
  ]);
}

// ── handoff §7.1's own fixture literals — the zOrg proposal 7 nested batch ──────────────────

const TO_SELF = '0x5E58BA0e06ED0F5558f83bE732a4b899a674053E';
const LOOT = '0x62eC86753D9dCb6a6dEe18E2B3A0EBb823359016';
const TRIBUTE = '0x000000000066524fcf78Dc1E41E9D525d9ea73D0';
// The nonce word, verbatim from the handoff doc, already exactly 64 hex chars (32 bytes) — used
// directly as a static bytes32 head word.
const NONCE_WORD = 'faca2964ea31bc208b43e65524756e61ab82ebfe7d4981e56fd985cbde1b261f';

// handoff §7.1's three inner calldata literals, verbatim — mintFromMoloch, approve, claimTribute.
const INNER_MINT =
  '0x2806b0af0000000000000000000000005e58ba0e06ed0f5558f83be732a4b899a674053e0000000000000000000000000000000000000000000000000de0b6b3a7640000';
const INNER_APPROVE =
  '0x095ea7b3000000000000000000000000000000000066524fcf78dc1e41e9d525d9ea73d00000000000000000000000000000000000000000000000000de0b6b3a7640000';
const INNER_CLAIM =
  '0xac6695d10000000000000000000000001c0aa8ccd568d90d61659f060d1bfb1e6f855a200000000000000000000000000000000000000000000000000000000000000000';

// `batchCalls((address,uint256,bytes)[])`'s own calldata — the value the §7.1 outer payload's
// `data` argument carries.
function buildBatchCallsCalldata(): string {
  const el0 = encodeCallTuple(LOOT, 0n, INNER_MINT);
  const el1 = encodeCallTuple(LOOT, 0n, INNER_APPROVE);
  const el2 = encodeCallTuple(TRIBUTE, 0n, INNER_CLAIM);
  const arrayTail = encodeDynamicArrayOfDynamic([el0, el1, el2]);
  const args = encodeHeadTail([{ dynamic: true, tail: arrayTail }]);
  const batchCallsSelector = keccak().selector('batchCalls((address,uint256,bytes)[])');
  return `${batchCallsSelector}${args}`;
}

// The full outer `executeByVotes(uint8,address,uint256,bytes,bytes32)` payload — op=0,
// to=self, value=0, data=the batchCalls calldata above, nonce=the §7.1 word.
function buildOuterPayload(): string {
  const batchCallsCalldata = buildBatchCallsCalldata();
  const args = encodeHeadTail([
    { dynamic: false, word: wordUint(0) },
    { dynamic: false, word: wordAddress(TO_SELF) },
    { dynamic: false, word: wordUint(0) },
    { dynamic: true, tail: bytesTail(batchCallsCalldata) },
    { dynamic: false, word: NONCE_WORD },
  ]);
  const selector = keccak().selector('executeByVotes(uint8,address,uint256,bytes,bytes32)');
  return `${selector}${args}`;
}

describe('the encoder proves itself before the fixture depends on it (Round 2 LOW)', () => {
  it("the fixture's own outer selector is 0xee5b2895", () => {
    expect(buildOuterPayload().slice(0, 10)).toBe('0xee5b2895');
  });

  it('the encoded outer argument list round-trips through abi().decodeParameters to the exact values encoded', () => {
    const batchCallsCalldata = buildBatchCallsCalldata();
    const args = encodeHeadTail([
      { dynamic: false, word: wordUint(0) },
      { dynamic: false, word: wordAddress(TO_SELF) },
      { dynamic: false, word: wordUint(0) },
      { dynamic: true, tail: bytesTail(batchCallsCalldata) },
      { dynamic: false, word: NONCE_WORD },
    ]);
    const parsed = abi().parseTypeString('executeByVotes(uint8,address,uint256,bytes,bytes32)');
    if ('error' in parsed) throw new Error(parsed.error);
    const decoded = abi().decodeParameters(parsed.types, hexToBytes(args), 0, 0);

    expect(decoded).toHaveLength(5);
    expect(decoded[0].value).toBe(0n); // op
    expect(decoded[1].value).toBe(TO_SELF.toLowerCase()); // to
    expect(decoded[2].value).toBe(0n); // value
    expect(decoded[3].raw).toBe(batchCallsCalldata.toLowerCase()); // data — the bytes payload hex
    expect(decoded[4].raw).toBe(`0x${NONCE_WORD}`); // nonce
  });
});

// Real mainnet outer calldata for tx 0x36cde4af05f5d8ce7553d43c9ded7b31d53a378e6fc21a04e5165715a4f656ba
// was not obtainable offline in this execution environment (no network access) — the round-trip
// proof above is the fixture's warrant instead, per this plan's own instruction not to fabricate
// a literal.

describe('end to end — the §7.1 outer payload decodes its nested batchCalls call (ETH-02)', () => {
  it('decodes offline, with neither an ABI source nor a signature source on the context, to a root labelled executeByVotes with the data argument re-identified as batchCalls', async () => {
    const outerPayload = buildOuterPayload();
    const output = await decoder().decode(outerPayload, makeCtx());

    expect(output.node.label).toBe('executeByVotes');
    expect(output.node.provenance).toBe('local');
    expect(output.node.children).toHaveLength(5);

    const toNode = output.node.children![1];
    const dataNode = output.node.children![3];

    expect(toNode.display).toBe('address');

    expect(dataNode.label).toBe('batchCalls');
    expect(dataNode.type).toBe('function');
    expect(dataNode.provenance).toBe('local');
    expect(dataNode.children ?? []).not.toHaveLength(0);

    // raw is byte-identical to the payload hex abi.ts wrote — never touched by the recursion
    // pass — and the former identity survives as an annotation.
    expect(dataNode.raw).toBe(buildBatchCallsCalldata().toLowerCase());
    // A local-table resolution carries no argument names (the ABI parser strips them from a
    // bare canonical signature string — test/decode-eth-calldata.test.ts's own arg0..argN-1
    // assertions are the pinned proof), so the former label here is `arg3`, this argument's
    // position — not the literal word "data". The former TYPE is still `bytes`.
    const identityAnnotation = (dataNode.annotations ?? []).find((a) => a.includes('formerly'));
    expect(identityAnnotation).toBeDefined();
    expect(identityAnnotation).toContain('arg3');
    expect(identityAnnotation).toContain('bytes');

    // the re-identified node kept its index — still 4th of 5, no sibling moved.
    expect(output.node.children![3]).toBe(dataNode);
    expect(output.node.children![1]).toBe(toNode);
  });

  it('a top-level bytes `data` argument after a top-level address `to` in the same argument list resolves, with both reachable as siblings under one root — structurally unreachable when the passes run per argument', async () => {
    const output = await decoder().decode(buildOuterPayload(), makeCtx());
    const children = output.node.children!;
    const toNode = children[1];
    const dataNode = children[3];

    expect(toNode.display).toBe('address');
    expect(dataNode.label).toBe('batchCalls');
    expect(dataNode.type).toBe('function');
    // Both live in the SAME children array — the parent whose children a sibling-scan (Plan 02's
    // ETH-03 rule) or this test both need `data` and `to` to share.
    expect(children).toContain(toNode);
    expect(children).toContain(dataNode);
  });

  it('a nested address inside the batchCalls tuples carries display "address" and a shortened value — decoration ran after recursion, over the grafted subtree', async () => {
    const output = await decoder().decode(buildOuterPayload(), makeCtx());
    const dataNode = output.node.children![3];

    function findAddressNode(node: DecodeNode): DecodeNode | undefined {
      if (node.display === 'address') return node;
      for (const child of node.children ?? []) {
        const found = findAddressNode(child);
        if (found) return found;
      }
      return undefined;
    }

    const nestedAddress = findAddressNode(dataNode);
    expect(nestedAddress).toBeDefined();
    expect(nestedAddress!.value).not.toBe(nestedAddress!.raw);
  });

  it('recurses through all three nested calls — mintFromMoloch, approve and claimTribute, in order, each a function node', async () => {
    const output = await decoder().decode(buildOuterPayload(), makeCtx());
    const dataNode = output.node.children![3];
    const arrayNode = dataNode.children![0];
    const elements = arrayNode.children!;

    expect(elements).toHaveLength(3);
    const nestedCalls = elements.map((el) => el.children![2]);
    expect(nestedCalls.map((n) => n.label)).toEqual(['mintFromMoloch', 'approve', 'claimTribute']);
    for (const n of nestedCalls) expect(n.type).toBe('function');
  });

  it("each nested call is resolved against its own element's own target (ETH-03) — LOOT for elements 0 and 1, TRIBUTE for element 2", async () => {
    const capturedTargets: (string | undefined)[] = [];
    const stubAbis: AbiSourcePort = {
      async getAbi(address) {
        capturedTargets.push(address);
        return null;
      },
    };

    await decoder().decode(buildOuterPayload(), makeCtx({ abis: stubAbis }));

    // The first FOUR captures are the RESOLUTION step (RECURSE runs, and is fully awaited,
    // before 06-06's own name walk is even started): the OUTER graft itself — `data` (the
    // batchCalls call) resolves against TO_SELF, the preceding top-level sibling in
    // executeByVotes's own argument list — then each batchCalls element's own tuple address,
    // never TO_SELF and never a sibling element's — LOOT for elements 0 and 1, TRIBUTE for
    // element 2. Every capture after that is 06-06's ETH-12 name walk, started (never awaited)
    // once decoration finishes: it separately asks about every DISTINCT address
    // display-decorated anywhere in the finished tree — TO_SELF/LOOT/TRIBUTE again, plus
    // claimTribute's own address argument (the one address this fixture decorates that
    // recursion/resolution itself never asks about).
    expect(capturedTargets).toEqual([
      TO_SELF.toLowerCase(),
      LOOT.toLowerCase(),
      LOOT.toLowerCase(),
      TRIBUTE.toLowerCase(),
      TO_SELF.toLowerCase(),
      LOOT.toLowerCase(),
      TRIBUTE.toLowerCase(),
      '0x1c0aa8ccd568d90d61659f060d1bfb1e6f855a20',
    ]);
  });

  it('a nested call resolves via the VERIFIED rung when a stubbed ABI source matches the target ETH-03 resolved for it — the third rung this suite exercises, alongside local (§7.1/§7.2) and registry (§7.3)', async () => {
    const stubAbis: AbiSourcePort = {
      async getAbi(address) {
        if (address === LOOT.toLowerCase()) {
          return {
            name: 'Loot',
            abi: [
              {
                name: 'mintFromMoloch',
                inputs: [
                  { name: 'to', type: 'address' },
                  { name: 'amount', type: 'uint256' },
                ],
              },
            ],
          };
        }
        return null;
      },
    };

    const output = await decoder().decode(buildOuterPayload(), makeCtx({ abis: stubAbis }));
    const dataNode = output.node.children![3];
    const arrayNode = dataNode.children![0];
    const el0Call = arrayNode.children![0].children![2];

    expect(el0Call.label).toBe('mintFromMoloch');
    expect(el0Call.provenance).toBe('verified');
    // The verified ABI carries argument names — 'to', never the local-table's arg0/arg1.
    expect(el0Call.children![0].label).toBe('to');
  });

  // 06-03 Task 3: the case unreachable through the local table or either registry — claimTribute
  // IS seeded locally (signatures.ts), so this is the one call in the §7.1 vector that only ever
  // proves the VERIFIED rung is reachable in the shipped app when a real supplier answers for it.
  it('the §7.1 nested claimTribute call resolves via the VERIFIED rung with argument labels taken from the stubbed ABI (Task 3)', async () => {
    const stubAbis: AbiSourcePort = {
      async getAbi(address) {
        if (address === TRIBUTE.toLowerCase()) {
          return {
            name: 'Tribute',
            abi: [
              {
                name: 'claimTribute',
                inputs: [
                  { name: 'claimant', type: 'address' },
                  { name: 'recipient', type: 'address' },
                ],
              },
            ],
          };
        }
        return null;
      },
    };

    const output = await decoder().decode(buildOuterPayload(), makeCtx({ abis: stubAbis }));
    const dataNode = output.node.children![3];
    const arrayNode = dataNode.children![0];
    const el2Call = arrayNode.children![2].children![2];

    expect(el2Call.label).toBe('claimTribute');
    expect(el2Call.provenance).toBe('verified');
    // The verified ABI carries argument names — 'claimant', never the local-table's arg0/arg1.
    expect(el2Call.children![0].label).toBe('claimant');
  });

  it('aborting the decode signal mid-lookup delivers an aborted signal to the stubbed ABI source (Task 3)', async () => {
    const controller = new AbortController();
    let capturedSignal: AbortSignal | undefined;
    const stubAbis: AbiSourcePort = {
      async getAbi(_address, options) {
        capturedSignal = options?.signal;
        controller.abort();
        return null;
      },
    };

    await decoder().decode(buildOuterPayload(), makeCtx({ abis: stubAbis, signal: controller.signal }));

    expect(capturedSignal).toBeDefined();
    expect(capturedSignal!.aborted).toBe(true);
  });
});

describe('a top-level integer argument is decorated exactly once (proving decoration runs once, not twice)', () => {
  it('a top-level uint256 above the magnitude threshold carries exactly one magnitude annotation', async () => {
    const selector = keccak().selector('approve(address,uint256)');
    const bigValue = 2_000_000_000_000_000_000n; // 2e18, above ETH_MAGNITUDE_THRESHOLD (1e15)
    const calldata = `${selector}${wordAddress(LOOT)}${wordUint(bigValue)}`;

    const output = await decoder().decode(calldata, makeCtx());

    expect(output.node.provenance).toBe('local');
    const valueArg = output.node.children!.find((c) => c.type === 'uint256');
    expect(valueArg).toBeDefined();
    const magnitudeAnnotations = (valueArg!.annotations ?? []).filter((a) => a.startsWith('≈'));
    expect(magnitudeAnnotations).toHaveLength(1);
  });
});

// ── The ETH-02 edge cases, and the bounds/outcome branches, directly against annotators.recurse ──

function candidateShapedPayload(): string {
  // 4-byte selector + one 32-byte word = 36 bytes — a valid recursion-candidate shape
  // ((36 - 4) % 32 === 0), for an unseeded, never-resolving selector.
  return `0xdeadbeef${'0'.repeat(64)}`;
}

describe('the ETH-02 edge cases — recursion is a shape test, not a network round-trip', () => {
  it('a 4-byte bytes payload whose selector is pull() becomes a function node with no children and no error', async () => {
    const pullSelector = keccak().selector('pull()');
    const bytesNode: DecodeNode = { label: 'data', type: 'bytes', value: pullSelector, raw: pullSelector };
    const root: DecodeNode = { label: 'root', type: 'function', value: null, children: [bytesNode] };

    await annotators().recurse!(root, undefined, async (selector) =>
      selector === pullSelector
        ? { ok: true, name: 'pull', types: [], provenance: 'local' }
        : { ok: false, unavailable: false },
    );

    expect(bytesNode.label).toBe('pull');
    expect(bytesNode.type).toBe('function');
    expect(bytesNode.children).toBeUndefined();
    expect(bytesNode.error).toBeUndefined();
  });

  it('a zero-length bytes payload does not recurse and is left completely untouched', async () => {
    const bytesNode: DecodeNode = { label: 'data', type: 'bytes', value: '0x', raw: '0x' };
    const root: DecodeNode = { label: 'root', type: 'function', value: null, children: [bytesNode] };
    let called = false;

    await annotators().recurse!(root, undefined, async () => {
      called = true;
      return { ok: false, unavailable: false };
    });

    expect(called).toBe(false);
    expect(bytesNode.label).toBe('data');
    expect(bytesNode.type).toBe('bytes');
    expect(bytesNode.value).toBe('0x');
    expect(bytesNode.raw).toBe('0x');
    expect(bytesNode.annotations).toBeUndefined();
  });

  it('a 5-byte bytes payload does not recurse and is left completely untouched', async () => {
    const payload = `0x${'11'.repeat(5)}`;
    const bytesNode: DecodeNode = { label: 'data', type: 'bytes', value: payload, raw: payload };
    const root: DecodeNode = { label: 'root', type: 'function', value: null, children: [bytesNode] };
    let called = false;

    await annotators().recurse!(root, undefined, async () => {
      called = true;
      return { ok: false, unavailable: false };
    });

    expect(called).toBe(false);
    expect(bytesNode.type).toBe('bytes');
    expect(bytesNode.value).toBe(payload);
    expect(bytesNode.raw).toBe(payload);
  });

  it('the re-identified node keeps its index and no sibling moves', async () => {
    const pullSelector = keccak().selector('pull()');
    const before: DecodeNode = { label: 'before', type: 'uint256', value: 1n };
    const target: DecodeNode = { label: 'data', type: 'bytes', value: pullSelector, raw: pullSelector };
    const after: DecodeNode = { label: 'after', type: 'uint256', value: 2n };
    const root: DecodeNode = { label: 'root', type: 'function', value: null, children: [before, target, after] };

    await annotators().recurse!(root, undefined, async () => ({
      ok: true,
      name: 'pull',
      types: [],
      provenance: 'local',
    }));

    expect(root.children).toHaveLength(3);
    expect(root.children![0]).toBe(before);
    expect(root.children![1]).toBe(target);
    expect(root.children![1].label).toBe('pull');
    expect(root.children![2]).toBe(after);
  });
});

describe('the resolver outcome union — unavailable vs. a clean miss (T-06-01 sibling)', () => {
  it('a nested lookup reporting unavailable appends exactly one annotation naming the selector and the reason', async () => {
    const payload = candidateShapedPayload();
    const bytesNode: DecodeNode = { label: 'data', type: 'bytes', value: payload, raw: payload };
    const root: DecodeNode = { label: 'root', type: 'function', value: null, children: [bytesNode] };

    await annotators().recurse!(root, undefined, async () => ({
      ok: false,
      unavailable: true,
      reason: 'rate limited',
    }));

    expect(bytesNode.annotations).toHaveLength(1);
    expect(bytesNode.annotations![0]).toContain('0xdeadbeef');
    expect(bytesNode.annotations![0]).toContain('rate limited');
    expect(bytesNode.type).toBe('bytes');
    expect(bytesNode.provenance).toBeUndefined();
  });

  it('a nested lookup reporting a clean miss leaves the node completely untouched', async () => {
    const payload = candidateShapedPayload();
    const bytesNode: DecodeNode = { label: 'data', type: 'bytes', value: payload, raw: payload };
    const root: DecodeNode = { label: 'root', type: 'function', value: null, children: [bytesNode] };

    await annotators().recurse!(root, undefined, async () => ({ ok: false, unavailable: false }));

    expect(bytesNode.annotations).toBeUndefined();
    expect(bytesNode.provenance).toBeUndefined();
    expect(bytesNode.warning).toBeUndefined();
    expect(bytesNode.type).toBe('bytes');
  });
});

describe('the node allowance is seeded from a count of the root (Round 2 HIGH)', () => {
  // DEC-13's missing-settings sentence used to be ASSIGNED to the root, over whatever was already
  // there — and annSeedBudget's bound warning is written to that same field. An RPC-only or
  // explorer-only configuration is a normal way to run this dapp, so both are routinely true at
  // once: the payload below lost the only statement on the tree that recursion had been skipped.
  it('a bounded root keeps its bound warning when the missing-settings sentence is added', async () => {
    // multicall(bytes[]) with more elements than the node budget allows.
    const count = 5001;
    const head = (32).toString(16).padStart(64, '0');
    const len = count.toString(16).padStart(64, '0');
    // Element offsets are relative to the first word AFTER the array length: the offset table is
    // `count` words, then one length word per (empty) element.
    const offsets = Array.from({ length: count }, (_, i) => ((count + i) * 32).toString(16).padStart(64, '0'));
    const elements = Array.from({ length: count }, () => '0'.repeat(64));
    const payload = `0xac9650d8${head}${len}${offsets.join('')}${elements.join('')}`;

    const output = await decoder().decode(payload, makeCtx());

    expect(output.node.warning).toContain('nested decode stopped');
    expect(output.node.warning).toContain('nodes bound reached');
    expect(output.node.warning).toContain('etherscanApiKey');
    expect(output.node.warning).toContain('rpcUrl');
  });

  it('a root whose own node count already meets ANN_MAX_NODES carries the bound warning on the ROOT and attempts no nested decode', async () => {
    // 5,000 leaves + the root itself = 5,001 nodes, at/over the 5,000 budget.
    const bigRoot: DecodeNode = {
      label: 'giant',
      type: 'function',
      value: null,
      children: Array.from({ length: 5000 }, (_, i) => ({
        label: `[${i}]`,
        type: 'bytes',
        value: '0x00',
        raw: '0x00',
      })),
    };
    let called = false;

    await annotators().recurse!(bigRoot, undefined, async () => {
      called = true;
      return { ok: false, unavailable: false };
    });

    expect(bigRoot.warning).toBeDefined();
    expect(called).toBe(false);
  });
});

// ── ETH-03: the nearest-preceding-sibling target rule (06-02, Task 1) ──────────────────────
//
// Synthetic DecodeNode fixtures throughout, per the same pattern as the ETH-02 edge cases
// above — the rule is a shape/traversal test over a finished tree, not a network round-trip, so
// there is no need to hand-encode real calldata for every branch. The §7.1/§7.2/§7.3 handoff
// vectors below DO decode real (or hand-encoded) calldata end to end, because TST-03 names them
// specifically and D-19 requires a fixture built by hand rather than fabricated for convenience.

const ADDR_A = '0x1111111111111111111111111111111111111111';
const ADDR_B = '0x2222222222222222222222222222222222222222';
const ADDR_C = '0x3333333333333333333333333333333333333333';
const ADDR_D = '0x4444444444444444444444444444444444444444';

describe('ETH-03: the nearest-preceding-sibling target rule', () => {
  it("scans backward and returns the FIRST preceding address — handoff §7.2's own tie-break, two addresses equidistant from bytes", async () => {
    // setPermit's own shape: uint8 op, address to (idx1), uint256 value, bytes data (idx3),
    // bytes32 nonce, address spender (idx5), uint256 count. `to` and `spender` sit equidistant
    // from `data`; the PRECEDING one (`to`) must win, never the following one (`spender`).
    const opNode: DecodeNode = { label: 'arg0', type: 'uint8', value: 1n };
    const toNode: DecodeNode = { label: 'arg1', type: 'address', value: ADDR_A, raw: ADDR_A };
    const valueNode: DecodeNode = { label: 'arg2', type: 'uint256', value: 0n };
    const payload = candidateShapedPayload();
    const dataNode: DecodeNode = { label: 'arg3', type: 'bytes', value: payload, raw: payload };
    const nonceNode: DecodeNode = { label: 'arg4', type: 'bytes32', value: '0x00', raw: '0x00' };
    const spenderNode: DecodeNode = { label: 'arg5', type: 'address', value: ADDR_B, raw: ADDR_B };
    const countNode: DecodeNode = { label: 'arg6', type: 'uint256', value: 1n };
    const root: DecodeNode = {
      label: 'setPermit',
      type: 'function',
      value: null,
      children: [opNode, toNode, valueNode, dataNode, nonceNode, spenderNode, countNode],
    };

    const capturedTargets: (string | undefined)[] = [];
    await annotators().recurse!(root, undefined, async (_selector, target) => {
      capturedTargets.push(target);
      return { ok: false, unavailable: false };
    });

    expect(capturedTargets).toEqual([ADDR_A]);
    expect(capturedTargets).not.toContain(ADDR_B);
  });

  it('a top-level bytes resolves against its preceding top-level address even when the pass was called with a DIFFERENT top-level target — a sibling hit, not a coincidental inherited-target agreement', async () => {
    const toNode: DecodeNode = { label: 'arg0', type: 'address', value: ADDR_A, raw: ADDR_A };
    const payload = candidateShapedPayload();
    const dataNode: DecodeNode = { label: 'arg1', type: 'bytes', value: payload, raw: payload };
    const root: DecodeNode = { label: 'fn', type: 'function', value: null, children: [toNode, dataNode] };

    let captured: string | undefined = 'never-called' as unknown as string;
    await annotators().recurse!(root, ADDR_D, async (_selector, target) => {
      captured = target;
      return { ok: false, unavailable: false };
    });

    expect(captured).toBe(ADDR_A);
    expect(captured).not.toBe(ADDR_D);
  });

  it("multicall(bytes[]) with no address anywhere in the argument list — every element inherits the enclosing call's own target", async () => {
    const payload0 = candidateShapedPayload();
    const payload1 = candidateShapedPayload();
    const el0: DecodeNode = { label: '[0]', type: 'bytes', value: payload0, raw: payload0 };
    const el1: DecodeNode = { label: '[1]', type: 'bytes', value: payload1, raw: payload1 };
    const arrayNode: DecodeNode = { label: 'arg0', type: 'bytes[]', value: null, children: [el0, el1] };
    const root: DecodeNode = { label: 'multicall', type: 'function', value: null, children: [arrayNode] };

    const captured: (string | undefined)[] = [];
    await annotators().recurse!(root, ADDR_C, async (_selector, target) => {
      captured.push(target);
      return { ok: false, unavailable: false };
    });

    expect(captured).toEqual([ADDR_C, ADDR_C]);
  });

  it('an address AFTER the bytes argument is not selected — the scan never looks forward, the enclosing target is inherited instead', async () => {
    const payload = candidateShapedPayload();
    const bytesNode: DecodeNode = { label: 'arg0', type: 'bytes', value: payload, raw: payload };
    const laterAddrNode: DecodeNode = { label: 'arg1', type: 'address', value: ADDR_B, raw: ADDR_B };
    const root: DecodeNode = { label: 'fn', type: 'function', value: null, children: [bytesNode, laterAddrNode] };

    let captured: string | undefined;
    await annotators().recurse!(root, ADDR_C, async (_selector, target) => {
      captured = target;
      return { ok: false, unavailable: false };
    });

    expect(captured).toBe(ADDR_C);
    expect(captured).not.toBe(ADDR_B);
  });

  it('no enclosing target at any level — the resolver is called with an undefined target, never a stand-in value', async () => {
    const payload = candidateShapedPayload();
    const bytesNode: DecodeNode = { label: 'arg0', type: 'bytes', value: payload, raw: payload };
    const root: DecodeNode = { label: 'fn', type: 'function', value: null, children: [bytesNode] };

    let sawUndefined = false;
    let wasCalled = false;
    await annotators().recurse!(root, undefined, async (_selector, target) => {
      wasCalled = true;
      sawUndefined = target === undefined;
      return { ok: false, unavailable: false };
    });

    expect(wasCalled).toBe(true);
    expect(sawUndefined).toBe(true);
  });

  it('a node declaring type "address" whose raw fails the 20-byte lowercase hex shape is never selected as a target', async () => {
    const badAddrNode: DecodeNode = { label: 'arg0', type: 'address', value: '0xnotanaddress', raw: '0xnotanaddress' };
    const payload = candidateShapedPayload();
    const bytesNode: DecodeNode = { label: 'arg1', type: 'bytes', value: payload, raw: payload };
    const root: DecodeNode = { label: 'fn', type: 'function', value: null, children: [badAddrNode, bytesNode] };

    let captured: string | undefined;
    await annotators().recurse!(root, ADDR_C, async (_selector, target) => {
      captured = target;
      return { ok: false, unavailable: false };
    });

    expect(captured).toBe(ADDR_C);
  });

  it('the preceding-sibling scan reads `raw`, never `value` — a decoration-shortened value must not change the outcome', async () => {
    // Simulates decoration having already run on this node (it has not, under Plan 01's own
    // ordering, but the scan must not depend on that ordering for correctness).
    const shortenedNode: DecodeNode = {
      label: 'arg0',
      type: 'address',
      value: `${ADDR_A.slice(0, 10)}...${ADDR_A.slice(-6)}`,
      raw: ADDR_A,
    };
    const payload = candidateShapedPayload();
    const bytesNode: DecodeNode = { label: 'arg1', type: 'bytes', value: payload, raw: payload };
    const root: DecodeNode = { label: 'fn', type: 'function', value: null, children: [shortenedNode, bytesNode] };

    let captured: string | undefined;
    await annotators().recurse!(root, undefined, async (_selector, target) => {
      captured = target;
      return { ok: false, unavailable: false };
    });

    expect(captured).toBe(ADDR_A);
  });

  it("a tuple-inside-array element (batchCalls's own shape) resolves against its OWN tuple's address, never a sibling element's — the sibling array is not flattened", async () => {
    const payloadX = candidateShapedPayload();
    const el0Addr: DecodeNode = { label: '0', type: 'address', value: ADDR_A, raw: ADDR_A };
    const el0Value: DecodeNode = { label: '1', type: 'uint256', value: 0n };
    const el0Bytes: DecodeNode = { label: '2', type: 'bytes', value: payloadX, raw: payloadX };
    const el0: DecodeNode = {
      label: '[0]',
      type: '(address,uint256,bytes)',
      value: null,
      children: [el0Addr, el0Value, el0Bytes],
    };

    const payloadY = candidateShapedPayload();
    const el1Addr: DecodeNode = { label: '0', type: 'address', value: ADDR_B, raw: ADDR_B };
    const el1Value: DecodeNode = { label: '1', type: 'uint256', value: 0n };
    const el1Bytes: DecodeNode = { label: '2', type: 'bytes', value: payloadY, raw: payloadY };
    const el1: DecodeNode = {
      label: '[1]',
      type: '(address,uint256,bytes)',
      value: null,
      children: [el1Addr, el1Value, el1Bytes],
    };

    const arrayNode: DecodeNode = {
      label: 'arg0',
      type: '(address,uint256,bytes)[]',
      value: null,
      children: [el0, el1],
    };
    const root: DecodeNode = { label: 'batchCalls', type: 'function', value: null, children: [arrayNode] };

    const captured: (string | undefined)[] = [];
    await annotators().recurse!(root, undefined, async (_selector, target) => {
      captured.push(target);
      return { ok: false, unavailable: false };
    });

    expect(captured).toEqual([ADDR_A, ADDR_B]);
  });
});

// ── Handoff §7.2 — Permit with delegatecall and a zero-arg inner call (top-level argument list) ──

const SETPERMIT_TO = '0x55D2cF1fD3cb803c37340CDd4Fd8fC59d750d050';
const SETPERMIT_SPENDER = '0x006CD14F36F65eCbB29b2519cCBe63A0DC8549F2';

function buildSetPermitPayload(): string {
  const pullSelector = keccak().selector('pull()');
  const args = encodeHeadTail([
    { dynamic: false, word: wordUint(1) }, // op = 1 (DELEGATECALL, per handoff §7.2)
    { dynamic: false, word: wordAddress(SETPERMIT_TO) }, // to
    { dynamic: false, word: wordUint(0) }, // value
    { dynamic: true, tail: bytesTail(pullSelector) }, // data -> pull()
    // Not the real handoff nonce (given truncated, `0xbc5bfc07…81b937`, in the source doc) — a
    // synthetic bytes32 stands in, via wordUint (always exactly 64 hex chars) rather than a
    // hand-typed literal, since no assertion in this suite depends on its value.
    { dynamic: false, word: wordUint(1) }, // nonce
    { dynamic: false, word: wordAddress(SETPERMIT_SPENDER) }, // spender
    { dynamic: false, word: wordUint(1) }, // count
  ]);
  const selector = keccak().selector('setPermit(uint8,address,uint256,bytes,bytes32,address,uint256)');
  return `${selector}${args}`;
}

describe("handoff §7.2 — setPermit's own top-level argument list (the tie-break's real vector)", () => {
  it('decodes offline through the local table, the nested pull() re-identified with target `to` (index 1), never `spender` (index 5)', async () => {
    const capturedTargets: (string | undefined)[] = [];
    const stubAbis: AbiSourcePort = {
      async getAbi(address) {
        capturedTargets.push(address);
        return null;
      },
    };

    const output = await decoder().decode(buildSetPermitPayload(), makeCtx({ abis: stubAbis }));

    expect(output.node.label).toBe('setPermit');
    expect(output.node.provenance).toBe('local');
    const dataNode = output.node.children![3];
    expect(dataNode.label).toBe('pull');
    expect(dataNode.type).toBe('function');
    expect(dataNode.error).toBeUndefined();

    // The FIRST capture is the RESOLUTION step (RECURSE runs, and is fully awaited, before
    // 06-06's own name walk is even started) — ctx.abis is consulted with the NESTED target
    // ETH-03 resolved, `to`, never `spender`. Every capture after that is 06-06's ETH-12 name
    // walk, which separately (and correctly) asks about every distinct address
    // display-decorated anywhere in the finished tree — both of setPermit's own top-level
    // address arguments, `to` and `spender` — a fact the walk's own tests cover, not this one.
    expect(capturedTargets[0]).toBe(SETPERMIT_TO.toLowerCase());
    expect(capturedTargets).toEqual([
      SETPERMIT_TO.toLowerCase(),
      SETPERMIT_TO.toLowerCase(),
      SETPERMIT_SPENDER.toLowerCase(),
    ]);
  });
});

// ── Handoff §7.3 — Simple single call, the registry-rung vector (zOrg proposal 20) ─────────

const Z20_OUTER_TO = '0x0000006D936bA3653b8854490E16E782cd32a9a8';
const Z20_INNER_ADDR = '0x0000006b980ae5e796B3eF484e767993d0E29979';
const Z20_NONCE_WORD = '238f613abfc45402e05ca6cef98099e02b872c173c1ba5ce06c88ea6947acef0';

function buildZ20OuterPayload(): string {
  const setRendererSelector = keccak().selector('setRenderer(address)');
  const innerCalldata = `${setRendererSelector}${wordAddress(Z20_INNER_ADDR)}`;
  const args = encodeHeadTail([
    { dynamic: false, word: wordUint(0) }, // op
    { dynamic: false, word: wordAddress(Z20_OUTER_TO) }, // to
    { dynamic: false, word: wordUint(0) }, // value
    { dynamic: true, tail: bytesTail(innerCalldata) }, // data -> setRenderer(address)
    { dynamic: false, word: Z20_NONCE_WORD }, // nonce
  ]);
  const selector = keccak().selector('executeByVotes(uint8,address,uint256,bytes,bytes32)');
  return `${selector}${args}`;
}

describe('handoff §7.3 — a single nested call whose selector is absent from both the local table and a verified ABI (the REGISTRY rung)', () => {
  it("the fixture's own inner selector is 0x56d3163d, independently re-verified (06-01-SUMMARY's nine-selector record)", () => {
    expect(keccak().selector('setRenderer(address)')).toBe('0x56d3163d');
  });

  it('decodes to one nested setRenderer(address) node resolved against the `to` at index 1, with provenance "registry" and its argument decoding to the inner address', async () => {
    const setRendererSelector = keccak().selector('setRenderer(address)');
    const stubSignatures: SignatureLookupPort = {
      async lookup(selector: string) {
        if (selector === setRendererSelector) {
          return { candidates: [{ signature: 'setRenderer(address)', source: '4byte' }], unavailable: false };
        }
        return { candidates: [], unavailable: false };
      },
    };

    const output = await decoder().decode(buildZ20OuterPayload(), makeCtx({ signatures: stubSignatures }));

    expect(output.node.label).toBe('executeByVotes');
    expect(output.node.provenance).toBe('local');

    const dataNode = output.node.children![3];
    expect(dataNode.label).toBe('setRenderer');
    expect(dataNode.type).toBe('function');
    expect(dataNode.provenance).toBe('registry');
    expect(dataNode.children).toHaveLength(1);
    expect(dataNode.children![0].type).toBe('address');
    expect(dataNode.children![0].raw).toBe(Z20_INNER_ADDR.toLowerCase());
  });
});

// ── TST-03's own offline unresolved case, at recursion-pass scope ──────────────────────────

describe('TST-03: a nested selector that resolves nowhere — local table, verified and registry all miss', () => {
  it('claimTribute (0xac6695d1), local table stubbed empty and both registries clean-missed, resolves unresolved with a stated undecoded byte count and no error, at the TRUE top level', async () => {
    reloadDecoderWithEmptyLocalTable();
    const output = await decoder().decode(INNER_CLAIM, makeCtx({ signatures: EMPTY_SIGNATURE_LOOKUP }));

    expect(output.node.provenance).toBe('unresolved');
    expect(output.node.error).toBeUndefined();
    const text = (output.node.annotations ?? []).join(' ');
    expect(text).toContain('0xac6695d1');
    expect(text).toMatch(/\d+ undecoded byte/);
  });
});

// ── ETH-09 (06-02, Task 2): proving the bounds against generated deep and wide payloads ────
//
// A payload cannot be its own strict sub-slice — every recursion level consumes its own framing
// (selector, offset word, length word, element offset, element length), so a nested `bytes`
// element is always shorter than what encloses it and the equation "the whole payload appears
// again inside itself" has no solution. Finite calldata cannot self-nest, so recursion over a
// fixed input terminates ON ITS OWN; the bound below exists to keep the tab RESPONSIVE on a
// large finite payload, never to prevent an INFINITE loop, which finite calldata cannot produce.
// No fixture in this section attempts the impossible construction, and none of the assertions
// below claim the bound stops an infinite recursion — only that a deliberately deep or wide
// finite payload halts quickly, visibly, and without losing what was already decoded.

// ethDecode (decoders-eth-calldata.ts) unconditionally overwrites the ROOT node's own `warning`
// with DEC-13's missing-settings sentence whenever ctx.settings lacks both etherscanApiKey and
// rpcUrl — makeCtx()'s default `settings: {}` would otherwise clobber a recursion-bound warning
// this section is specifically asserting on. Supplying both keys keeps output.node.warning free
// for THIS section's own assertions; it says nothing about credential-gated behaviour, which is
// out of scope here.
const NO_SETTINGS_NOTE: Partial<DecodeContext> = { settings: { etherscanApiKey: 'x', rpcUrl: 'x' } };

// The 4th `budget` parameter is intentionally NOT part of DxDecodeAnnotatorsModule's frozen
// public contract (types.d.ts's own comment on `recurse`) — restated locally here, matching
// decoders-eth-calldata.ts's own EthSignaturesModuleWithLocalPeek precedent for reaching a real
// runtime member the frozen interface does not name.
interface AnnotatorsModuleWithBudgetSurface extends DxDecodeAnnotatorsModule {
  recurse?: (
    root: DecodeNode,
    target: string | undefined,
    resolve: (
      selector: string,
      target: string | undefined,
    ) => Promise<
      | { ok: true; name: string; types: TypeNode[]; provenance: 'verified' | 'local' | 'registry' }
      | { ok: false; unavailable: boolean; reason?: string }
    >,
    budget?: { nodesRemaining: number; bytesRemaining: number },
  ) => Promise<void>;
  ANN_MAX_DEPTH?: number;
  ANN_MAX_NODES?: number;
  ANN_MAX_BYTES?: number;
}

function annotatorsWithBudget(): AnnotatorsModuleWithBudgetSurface {
  return window.DxDecode!.annotators as AnnotatorsModuleWithBudgetSurface;
}

function countTree(node: DecodeNode): number {
  let count = 1;
  for (const child of node.children ?? []) count += countTree(child);
  return count;
}

function findWarning(node: DecodeNode): string | undefined {
  if (node.warning) return node.warning;
  for (const child of node.children ?? []) {
    const found = findWarning(child);
    if (found) return found;
  }
  return undefined;
}

// A GENERATED chain of nested multicall(bytes[]) calls, each inheriting the enclosing target
// (handoff §6 step 5's own multicall clause), wrapping a leaf pull() call `layers` deep. Each
// wrap beyond the outermost (the top-level decode's own selector) is one nested graft attempt,
// at depths 0..layers-1 — so a 15-layer chain's every graft attempt sits at depth <= 14 (under
// the 16 bound) and a 17-layer chain's LAST attempt sits at depth 16 (at the bound).
function buildMulticallChain(layers: number): string {
  const pullSelector = keccak().selector('pull()');
  let inner = pullSelector;
  const multicallSelector = keccak().selector('multicall(bytes[])');
  for (let i = 0; i < layers; i++) {
    const arrayTail = encodeDynamicArrayOfDynamic([bytesTail(inner)]);
    const args = encodeHeadTail([{ dynamic: true, tail: arrayTail }]);
    inner = `${multicallSelector}${args}`;
  }
  return inner;
}

describe('a generated depth chain — multicall(bytes[]) wrapped N times around a leaf pull() call', () => {
  it('a 15-layer chain decodes to the bottom with no bound warning anywhere in the tree', async () => {
    const output = await decoder().decode(buildMulticallChain(15), makeCtx(NO_SETTINGS_NOTE));

    expect(findWarning(output.node)).toBeUndefined();

    let cursor = output.node;
    let layersWalked = 0;
    while (cursor.label === 'multicall' && cursor.children) {
      cursor = cursor.children[0].children![0];
      layersWalked++;
    }
    expect(cursor.label).toBe('pull');
    expect(cursor.type).toBe('function');
    expect(layersWalked).toBe(15);
  });

  it('a 17-layer chain stops at the depth limit with a bound warning naming the depth bound and the depth/node/byte counts reached, completes well inside the test timeout, and every node above the truncation point is present and unmodified', async () => {
    const startedAt = Date.now();
    const output = await decoder().decode(buildMulticallChain(17), makeCtx(NO_SETTINGS_NOTE));
    // A hang, not a wrong answer, is the failure this asserts against — well inside vitest's own
    // default 5s test timeout.
    expect(Date.now() - startedAt).toBeLessThan(2000);

    let cursor = output.node;
    let successfulGrafts = 0;
    let truncated: DecodeNode | undefined;
    while (cursor.label === 'multicall' && cursor.children) {
      const el = cursor.children[0].children![0];
      if (el.warning) {
        truncated = el;
        break;
      }
      // Every node above the truncation point decoded correctly — still a real multicall call.
      expect(cursor.type).toBe('function');
      cursor = el;
      successfulGrafts++;
    }

    expect(truncated).toBeDefined();
    expect(truncated!.warning).toContain('depth bound reached');
    expect(truncated!.warning).toMatch(/depth 16 of max 16/);
    expect(truncated!.warning).toMatch(/\d+ of max 5000 nodes/);
    expect(truncated!.warning).toMatch(/\d+ of max \d+ bytes/);
    // The candidate was decoded exactly as far as the depth pre-check runs — never grafted.
    expect(truncated!.type).toBe('bytes');
    expect(truncated!.children).toBeUndefined();
    expect(truncated!.error).toBeUndefined();
    // 16 successful grafts (depths 0..15) precede the depth-16 attempt that is refused.
    expect(successfulGrafts).toBe(16);
  });
});

describe('a wide nested array — a returned subtree larger than the remaining node allowance is refused, never grafted', () => {
  const UINT256: TypeNode = { kind: 'elementary', type: 'uint256' };
  const FOUR_UINT256: TypeNode[] = [UINT256, UINT256, UINT256, UINT256];
  // selector (4 bytes) + 4 static uint256 words (128 bytes) = 132 bytes = 4 + 32*4, a valid
  // recursion-candidate shape.
  const wideCandidatePayload = () => `0xdeadbeef${'0'.repeat(64 * 4)}`;

  function wideResolver(): (
    selector: string,
    target: string | undefined,
  ) => Promise<{ ok: true; name: string; types: TypeNode[]; provenance: 'verified' | 'local' | 'registry' }> {
    return async () => ({ ok: true, name: 'wide', types: FOUR_UINT256, provenance: 'local' });
  }

  it('a subtree that decodes to MORE nodes than the remaining allowance (one over) is refused: the node keeps type bytes, has no children, carries the bound warning, and the delivered tree stays within the limit', async () => {
    const payload = wideCandidatePayload();
    const bytesNode: DecodeNode = { label: 'data', type: 'bytes', value: payload, raw: payload };
    const root: DecodeNode = { label: 'root', type: 'function', value: null, children: [bytesNode] };

    // The subtree this resolver produces decodes to exactly 4 nodes (one per uint256 argument).
    // A remaining allowance of 3 is one UNDER that — refused.
    await annotatorsWithBudget().recurse!(root, undefined, wideResolver(), {
      nodesRemaining: 3,
      bytesRemaining: 999_999,
    });

    expect(bytesNode.type).toBe('bytes');
    expect(bytesNode.children).toBeUndefined();
    expect(bytesNode.warning).toBeDefined();
    expect(bytesNode.warning).toContain('nodes bound reached');
    expect(countTree(root)).toBeLessThanOrEqual(5000);
  });

  it('a subtree that decodes to EXACTLY the remaining allowance is grafted — the tie is specified, not incidental', async () => {
    const payload = wideCandidatePayload();
    const bytesNode: DecodeNode = { label: 'data', type: 'bytes', value: payload, raw: payload };
    const root: DecodeNode = { label: 'root', type: 'function', value: null, children: [bytesNode] };

    await annotatorsWithBudget().recurse!(root, undefined, wideResolver(), {
      nodesRemaining: 4,
      bytesRemaining: 999_999,
    });

    expect(bytesNode.type).toBe('function');
    expect(bytesNode.children).toHaveLength(4);
    expect(bytesNode.warning).toBeUndefined();
  });

  it('a subtree one node UNDER the remaining allowance is grafted', async () => {
    const payload = wideCandidatePayload();
    const bytesNode: DecodeNode = { label: 'data', type: 'bytes', value: payload, raw: payload };
    const root: DecodeNode = { label: 'root', type: 'function', value: null, children: [bytesNode] };

    await annotatorsWithBudget().recurse!(root, undefined, wideResolver(), {
      nodesRemaining: 5,
      bytesRemaining: 999_999,
    });

    expect(bytesNode.type).toBe('function');
    expect(bytesNode.children).toHaveLength(4);
    expect(bytesNode.warning).toBeUndefined();
  });
});

describe('a wide TOP-LEVEL argument list — the allowance is seeded from a count of the completed root, not only grafted subtrees (Round 2 HIGH)', () => {
  it('a real multicall(bytes[]) whose own top-level array already decodes to more nodes than the total allowance is refused at the ROOT: the injected signature source is never consulted, and the candidate-shaped element inside it is left completely ungrafted', async () => {
    // 4999 elements: one shaped like recursion-candidate calldata (proves the resolver really
    // would have been reachable had the bound not fired), the rest empty `bytes` — root(1) +
    // array(1) + 4999 elements = 5001 nodes, over the 5,000 allowance, entirely from abi.ts's
    // own top-level decode, before annRecurse ever walks a child.
    const shapedPayload = `0xdeadbeef${'0'.repeat(64)}`;
    const elementCount = 4999;
    const elements = Array.from({ length: elementCount }, (_, i) =>
      i === 0 ? bytesTail(shapedPayload) : bytesTail('0x'),
    );
    const arrayTail = encodeDynamicArrayOfDynamic(elements);
    const args = encodeHeadTail([{ dynamic: true, tail: arrayTail }]);
    const selector = keccak().selector('multicall(bytes[])');
    const payload = `${selector}${args}`;

    let called = false;
    const stubSignatures: SignatureLookupPort = {
      async lookup() {
        called = true;
        return { candidates: [], unavailable: false };
      },
    };

    const output = await decoder().decode(payload, makeCtx({ ...NO_SETTINGS_NOTE, signatures: stubSignatures }));

    expect(output.node.warning).toBeDefined();
    expect(output.node.warning).toContain('nodes bound reached');
    expect(called).toBe(false);

    // The shaped element is exactly what abi.ts itself decoded it as — the recursion pass never
    // touched it. This is what "respects the stated bound" means here: abi.ts's own top-level
    // decode is what produced a root over 5,000 nodes (it carries its own separate 10,000-node
    // ceiling — CR-02, unrelated to this pass's budget); this pass's job is only to add nothing
    // further to it, which is what a completely untouched shaped element proves.
    const arrayNode = output.node.children![0];
    const shapedElement = arrayNode.children![0];
    expect(shapedElement.type).toBe('bytes');
    expect(shapedElement.children).toBeUndefined();
    expect(shapedElement.provenance).toBeUndefined();
  });
});

describe('the byte bound, one step either side — exercised through the exposed budget surface rather than a real 2 MB payload', () => {
  it('a candidate one byte OVER the remaining byte allowance is refused', async () => {
    const payload = candidateShapedPayload(); // 36 bytes: 4-byte selector + one 32-byte word
    const bytesNode: DecodeNode = { label: 'data', type: 'bytes', value: payload, raw: payload };
    const root: DecodeNode = { label: 'root', type: 'function', value: null, children: [bytesNode] };
    let called = false;

    await annotatorsWithBudget().recurse!(
      root,
      undefined,
      async () => {
        called = true;
        return { ok: false, unavailable: false };
      },
      { nodesRemaining: 999_999, bytesRemaining: 35 }, // the candidate is 36 bytes — one over
    );

    expect(called).toBe(false);
    expect(bytesNode.warning).toBeDefined();
    expect(bytesNode.warning).toContain('bytes bound reached');
  });

  it('a candidate exactly AT the remaining byte allowance is examined (the resolver is called) — the tie is specified, not incidental', async () => {
    const payload = candidateShapedPayload(); // 36 bytes
    const bytesNode: DecodeNode = { label: 'data', type: 'bytes', value: payload, raw: payload };
    const root: DecodeNode = { label: 'root', type: 'function', value: null, children: [bytesNode] };
    let called = false;

    await annotatorsWithBudget().recurse!(
      root,
      undefined,
      async () => {
        called = true;
        return { ok: false, unavailable: false };
      },
      { nodesRemaining: 999_999, bytesRemaining: 36 }, // exactly the candidate's own byte length
    );

    expect(called).toBe(true);
    expect(bytesNode.warning).toBeUndefined();
  });

  it('a candidate one byte UNDER the remaining byte allowance is examined (the resolver is called)', async () => {
    const payload = candidateShapedPayload(); // 36 bytes
    const bytesNode: DecodeNode = { label: 'data', type: 'bytes', value: payload, raw: payload };
    const root: DecodeNode = { label: 'root', type: 'function', value: null, children: [bytesNode] };
    let called = false;

    await annotatorsWithBudget().recurse!(
      root,
      undefined,
      async () => {
        called = true;
        return { ok: false, unavailable: false };
      },
      { nodesRemaining: 999_999, bytesRemaining: 37 }, // one more than the candidate needs
    );

    expect(called).toBe(true);
    expect(bytesNode.warning).toBeUndefined();
  });

  it("the exposed constants match the module's own bounds — data, not a mutable setter", () => {
    expect(annotatorsWithBudget().ANN_MAX_DEPTH).toBe(16);
    expect(annotatorsWithBudget().ANN_MAX_NODES).toBe(5000);
    expect(annotatorsWithBudget().ANN_MAX_BYTES).toBe(2 * 1024 * 1024);
  });
});

describe('no bound condition ever throws, rejects, or sets `error` — a bound node is decoded AND flagged, never failed', () => {
  it('every bound path in this section left `error` undefined on the node it warned', async () => {
    const output17 = await decoder().decode(buildMulticallChain(17), makeCtx());
    let cursor = output17.node;
    while (cursor.label === 'multicall' && cursor.children) {
      expect(cursor.error).toBeUndefined();
      const el = cursor.children[0].children![0];
      if (el.warning) {
        expect(el.error).toBeUndefined();
        break;
      }
      cursor = el;
    }
  });
});

// ── ETH-13 (06-02, Task 3): the operation argument annotator ───────────────────────────────

describe('ETH-13: the positional operation-argument table, and the three-way value branch', () => {
  it('op = 0n annotates "(call)" and sets no warning', () => {
    const opArg: DecodeNode = { label: 'arg0', type: 'uint8', value: 0n };
    const root: DecodeNode = { label: 'executeByVotes', type: 'function', value: null, children: [opArg] };

    annotators().annotateTree!(root);

    expect(opArg.annotations).toContain('(call)');
    expect(opArg.warning).toBeUndefined();
  });

  it("op = 1n sets a DELEGATECALL warning naming running target code using the caller's own state", () => {
    const opArg: DecodeNode = { label: 'arg0', type: 'uint8', value: 1n };
    const root: DecodeNode = { label: 'executeByVotes', type: 'function', value: null, children: [opArg] };

    annotators().annotateTree!(root);

    expect(opArg.warning).toBeDefined();
    expect(opArg.warning).toContain('DELEGATECALL');
    expect(opArg.warning!.toLowerCase()).toContain('caller');
    expect(opArg.warning!.toLowerCase()).toContain('state');
  });

  it('op = 2n sets a DISTINCT warning naming the raw value as an unrecognised operation — never the DELEGATECALL wording, since 2 means create in some Safe-derived contracts', () => {
    const opArg: DecodeNode = { label: 'arg0', type: 'uint8', value: 2n };
    const root: DecodeNode = { label: 'executeByVotes', type: 'function', value: null, children: [opArg] };

    annotators().annotateTree!(root);

    expect(opArg.warning).toBeDefined();
    expect(opArg.warning).toContain('2');
    expect(opArg.warning).not.toContain('DELEGATECALL');
  });

  it.each([
    ['executeByVotes', 0],
    ['setPermit', 0],
    ['spendPermit', 0],
    ['execTransaction', 3],
  ] as const)('the positional table covers %s at index %i', (name, index) => {
    const children: DecodeNode[] = Array.from({ length: index + 1 }, (_, i) =>
      i === index ? { label: `arg${i}`, type: 'uint8', value: 0n } : { label: `arg${i}`, type: 'uint256', value: 0n },
    );
    const root: DecodeNode = { label: name, type: 'function', value: null, children };

    annotators().annotateTree!(root);

    expect(children[index].annotations).toContain('(call)');
  });

  it('no other function name triggers a positional annotation', () => {
    const opArg: DecodeNode = { label: 'arg0', type: 'uint8', value: 0n };
    const root: DecodeNode = { label: 'transfer', type: 'function', value: null, children: [opArg] };

    annotators().annotateTree!(root);

    expect(opArg.annotations).toBeUndefined();
    expect(opArg.warning).toBeUndefined();
  });

  it('a uint8 argument at the table index of a function NOT in the table is untouched', () => {
    const opArg: DecodeNode = { label: 'arg0', type: 'uint8', value: 0n };
    const root: DecodeNode = { label: 'someOtherFunction', type: 'function', value: null, children: [opArg] };

    annotators().annotateTree!(root);

    expect(opArg.annotations).toBeUndefined();
    expect(opArg.warning).toBeUndefined();
  });

  it('an argument at the table index whose declared type is NOT uint8 is untouched — the positional rule is a pair (name, index) confirmed by type, never index alone', () => {
    const notUint8: DecodeNode = { label: 'arg0', type: 'uint256', value: 0n };
    const root: DecodeNode = { label: 'executeByVotes', type: 'function', value: null, children: [notUint8] };

    annotators().annotateTree!(root);

    expect(notUint8.annotations).toBeUndefined();
    expect(notUint8.warning).toBeUndefined();
  });
});

describe('ETH-13: the LABEL-based trigger — the verified-ABI path, additive to the positional one', () => {
  it('a node labelled "op", type uint8, on a function name absent from the table is still annotated', () => {
    const opArg: DecodeNode = { label: 'op', type: 'uint8', value: 0n };
    const root: DecodeNode = { label: 'notInTable', type: 'function', value: null, children: [opArg] };

    annotators().annotateTree!(root);

    expect(opArg.annotations).toContain('(call)');
  });

  it('a node labelled "operation", type uint8, is also matched', () => {
    const operationArg: DecodeNode = { label: 'operation', type: 'uint8', value: 1n };
    const root: DecodeNode = { label: 'alsoNotInTable', type: 'function', value: null, children: [operationArg] };

    annotators().annotateTree!(root);

    expect(operationArg.warning).toContain('DELEGATECALL');
  });

  it('annotates EXACTLY ONCE when both the positional and label triggers match the same argument', () => {
    const opArg: DecodeNode = { label: 'op', type: 'uint8', value: 0n }; // positional index 0 AND label 'op'
    const root: DecodeNode = { label: 'executeByVotes', type: 'function', value: null, children: [opArg] };

    annotators().annotateTree!(root);

    const callAnnotations = (opArg.annotations ?? []).filter((a) => a === '(call)');
    expect(callAnnotations).toHaveLength(1);
  });
});

describe('ETH-13: an operation argument inside a NESTED (grafted) call is annotated too', () => {
  it('a function node reached only as a child of another function node is still annotated by the tree walk', () => {
    const innerOpArg: DecodeNode = { label: 'arg0', type: 'uint8', value: 1n };
    const innerCall: DecodeNode = { label: 'executeByVotes', type: 'function', value: null, children: [innerOpArg] };
    const outerRoot: DecodeNode = { label: 'multicall', type: 'function', value: null, children: [innerCall] };

    annotators().annotateTree!(outerRoot);

    expect(innerOpArg.warning).toContain('DELEGATECALL');
  });
});

describe('the annotator writes only `annotations`/`warning`, appends by spread, and never overwrites', () => {
  it('an existing annotation survives alongside the new "(call)" entry', () => {
    const opArg: DecodeNode = { label: 'arg0', type: 'uint8', value: 0n, annotations: ['pre-existing note'] };
    const root: DecodeNode = { label: 'executeByVotes', type: 'function', value: null, children: [opArg] };

    annotators().annotateTree!(root);

    expect(opArg.annotations).toEqual(['pre-existing note', '(call)']);
  });

  it('label/type/value/raw/children/error are left untouched', () => {
    const opArg: DecodeNode = { label: 'arg0', type: 'uint8', value: 0n, raw: '0x00' };
    const root: DecodeNode = { label: 'executeByVotes', type: 'function', value: null, children: [opArg] };

    annotators().annotateTree!(root);

    expect(opArg.label).toBe('arg0');
    expect(opArg.type).toBe('uint8');
    expect(opArg.value).toBe(0n);
    expect(opArg.raw).toBe('0x00');
    expect(opArg.children).toBeUndefined();
    expect(opArg.error).toBeUndefined();
  });
});

// ── handoff §7.2 end to end — the operation argument on the OFFLINE, no-key path ───────────

describe('handoff §7.2 end to end — setPermit(op=1, ...) decoded offline, local table only', () => {
  it('the TOP-LEVEL op argument (index 0) carries the DELEGATECALL warning with label arg0 — the positional rule, not a label match, fires on the no-key path', async () => {
    const output = await decoder().decode(buildSetPermitPayload(), makeCtx());

    expect(output.node.label).toBe('setPermit');
    expect(output.node.provenance).toBe('local');

    const opNode = output.node.children![0];
    expect(opNode.type).toBe('uint8');
    expect(opNode.label).toBe('arg0');
    expect(opNode.warning).toContain('DELEGATECALL');

    const dataNode = output.node.children![3];
    expect(dataNode.label).toBe('pull');
    expect(dataNode.children).toBeUndefined();
    expect(dataNode.error).toBeUndefined();
  });

  it('a stubbed verified ABI whose input names include "op" fires the label-based trigger', async () => {
    const stubAbis: AbiSourcePort = {
      async getAbi() {
        return {
          name: 'Whatever',
          abi: [
            {
              name: 'setPermit',
              inputs: [
                { name: 'op', type: 'uint8' },
                { name: 'to', type: 'address' },
                { name: 'value', type: 'uint256' },
                { name: 'data', type: 'bytes' },
                { name: 'nonce', type: 'bytes32' },
                { name: 'spender', type: 'address' },
                { name: 'count', type: 'uint256' },
              ],
            },
          ],
        };
      },
    };

    const output = await decoder().decode(buildSetPermitPayload(), makeCtx({ target: SETPERMIT_TO, abis: stubAbis }));

    expect(output.node.provenance).toBe('verified');
    const opNode = output.node.children![0];
    expect(opNode.label).toBe('op');
    expect(opNode.warning).toContain('DELEGATECALL');
  });
});

// ── Plan 05 Task 2: the transaction-hash pre-step ────────────────────────────────────────────

const TX_HASH = `0x${'ab'.repeat(32)}`;
const TX_SENDER = '0x00000000000000000000000000000000000009';

function stubTxSource(handler: (hash: string, options?: TxLookupOptions) => Promise<TxLookupResult>): TxSourcePort {
  return { getTransaction: handler };
}

describe('the transaction-hash pre-step (ETH-08, Plan 05 Task 2)', () => {
  it('no transaction source on the context produces a node stating the transaction cannot be fetched and naming both settings', async () => {
    const output = await decoder().decode(TX_HASH, makeCtx());

    expect(output.node.error).toContain('cannot be looked up');
    expect(output.node.error).toContain('RPC endpoint');
    expect(output.node.error).toContain('API key');
    expect(output.node.children).toBeUndefined();
  });

  it('a transaction source that reports could not ask produces the same could-not-fetch wording, with its reason included', async () => {
    const txSource = stubTxSource(async () => ({ unavailable: true, reason: 'no endpoint or key configured' }));
    const output = await decoder().decode(TX_HASH, makeCtx({ txSource }));

    expect(output.node.error).toContain('cannot be looked up');
    expect(output.node.error).toContain('no endpoint or key configured');
  });

  it('a hash the source asked about and missed produces a node distinct from the could-not-ask wording', async () => {
    const txSource = stubTxSource(async () => ({ unavailable: true }));
    const output = await decoder().decode(TX_HASH, makeCtx({ txSource }));

    expect(output.node.error).not.toContain('cannot be looked up');
    expect(output.node.error).toContain('not found');
  });

  it('a null recipient produces a node naming contract creation and stops, with no decode attempted', async () => {
    const txSource = stubTxSource(async () => ({
      transaction: { to: null, input: buildOuterPayload(), from: TX_SENDER },
      unavailable: false,
    }));
    const output = await decoder().decode(TX_HASH, makeCtx({ txSource }));

    expect(output.node.error).toContain('contract');
    expect(output.node.children).toBeUndefined();
  });

  it('a stubbed source answering with the §7.1 outer payload yields the full three-call recursive tree, resolved against the transaction recipient', async () => {
    const txSource = stubTxSource(async () => ({
      transaction: { to: TO_SELF.toLowerCase(), input: buildOuterPayload(), from: TX_SENDER },
      unavailable: false,
    }));
    const output = await decoder().decode(TX_HASH, makeCtx({ txSource }));

    expect(output.node.label).toBe('executeByVotes');
    expect(output.node.provenance).toBe('local');
    expect(output.node.children).toHaveLength(5);
    const dataNode = output.node.children![3];
    expect(dataNode.label).toBe('batchCalls');
    expect(dataNode.children ?? []).not.toHaveLength(0);
  });

  it('every request the source received carries the signal, and an input aborted while the fetch was in flight produces no tree write', async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    const txSource = stubTxSource(async (_hash, options) => {
      receivedSignal = options?.signal;
      controller.abort();
      return {
        transaction: { to: TO_SELF.toLowerCase(), input: buildOuterPayload(), from: TX_SENDER },
        unavailable: false,
      };
    });

    const output = await decoder().decode(TX_HASH, makeCtx({ txSource, signal: controller.signal }));

    expect(receivedSignal).toBe(controller.signal);
    expect(output.node.children ?? []).toHaveLength(0);
    expect(output.node.error).toBeUndefined();
  });

  it('an input of any other length is unaffected', async () => {
    const txSource = stubTxSource(async () => {
      throw new Error('should never be called for non-32-byte input');
    });
    const output = await decoder().decode(buildOuterPayload(), makeCtx({ txSource }));

    expect(output.node.label).toBe('executeByVotes');
  });
});

// ── ETH-12 (06-06 Task 1): the progressive contract-name walk ──────────────────────────────

// Waits out microtask chains that the decode itself never awaits (the name walk is deliberately
// STARTED and not awaited by ethDecodeCalldataBytes) — a macrotask tick, matching
// test/decode-ui.test.ts's own `flush` helper, so every already-scheduled microtask (however
// many `await`s deep) has settled before an assertion reads their side effects.
function flushWalk(): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type AbiLookupResult = { name: string; abi: AbiItem[] } | null;

// A calldata shape with NO bytes argument for RECURSE to graft on and NO ctx.target set — the
// top-level selector resolution's own verified-rung branch (ethResolveSelector's `if (ctx.abis
// && effectiveTarget)`) is therefore never taken, so ctx.abis.getAbi is called ONLY by the name
// walk. Load-bearing for the tests below that stub a lookup which never resolves: the full §7.1
// payload's own RECURSE step calls (and AWAITS) ctx.abis for its own graft-resolution attempts,
// so a stub that hangs forever would hang the whole decode, not just the walk.
function buildApproveCalldata(address: string, amount = 1n): string {
  const selector = keccak().selector('approve(address,uint256)');
  return `${selector}${wordAddress(address)}${wordUint(amount)}`;
}

describe('annCollectAddressNodes / annPatchContractNames — unit-level (06-06 Task 1)', () => {
  it('collectAddressNodes returns one entry per distinct address, an array of every node carrying it, and skips the zero address', () => {
    const addr1: DecodeNode = { label: 'a', display: 'address', raw: LOOT.toLowerCase() };
    const addr2: DecodeNode = { label: 'b', display: 'address', raw: LOOT.toLowerCase() };
    const addr3: DecodeNode = { label: 'c', display: 'address', raw: TRIBUTE.toLowerCase() };
    const zero: DecodeNode = { label: 'z', display: 'address', raw: `0x${'0'.repeat(40)}` };
    const notAnAddress: DecodeNode = { label: 'n', type: 'uint256', value: 1n };
    const root: DecodeNode = {
      label: 'root',
      type: 'function',
      value: null,
      children: [addr1, addr2, addr3, zero, notAnAddress],
    };

    const byAddress = annotators().collectAddressNodes!(root);

    expect(byAddress.size).toBe(2);
    expect(byAddress.get(LOOT.toLowerCase())).toEqual([addr1, addr2]);
    expect(byAddress.get(TRIBUTE.toLowerCase())).toEqual([addr3]);
    expect(byAddress.has(`0x${'0'.repeat(40)}`)).toBe(false);
  });

  it('collectAddressNodes ignores a node whose declared type is address but which has not yet been display-decorated', () => {
    const undecorated: DecodeNode = { label: 'a', type: 'address', raw: LOOT.toLowerCase() };
    const root: DecodeNode = { label: 'root', type: 'function', value: null, children: [undecorated] };

    expect(annotators().collectAddressNodes!(root).size).toBe(0);
  });

  it('patchContractNames appends a `(name)` annotation to every node sharing a resolved address, and notifies once per patched node', async () => {
    const nodeA: DecodeNode = { label: 'a', display: 'address', raw: LOOT.toLowerCase() };
    const nodeB: DecodeNode = { label: 'b', display: 'address', raw: LOOT.toLowerCase() };
    const byAddress = new Map([[LOOT.toLowerCase(), [nodeA, nodeB]]]);
    const notified: [DecodeNode, string][] = [];

    await annotators().patchContractNames!(
      byAddress,
      async () => 'Loot',
      (node, annotation) => notified.push([node, annotation]),
      new AbortController().signal,
    );

    expect(nodeA.annotations).toEqual(['(Loot)']);
    expect(nodeB.annotations).toEqual(['(Loot)']);
    expect(notified).toEqual([
      [nodeA, '(Loot)'],
      [nodeB, '(Loot)'],
    ]);
  });

  it('starts every distinct address lookup CONCURRENTLY — the stub is called for every address before any of them settle, which a call-count check alone cannot distinguish from serial', async () => {
    const callOrder: string[] = [];
    const deferreds = new Map<string, Deferred<string>>();
    const byAddress = new Map([
      [LOOT.toLowerCase(), [{ label: 'a', display: 'address', raw: LOOT.toLowerCase() } as DecodeNode]],
      [TRIBUTE.toLowerCase(), [{ label: 'b', display: 'address', raw: TRIBUTE.toLowerCase() } as DecodeNode]],
      [TO_SELF.toLowerCase(), [{ label: 'c', display: 'address', raw: TO_SELF.toLowerCase() } as DecodeNode]],
    ]);

    const settle = annotators().patchContractNames!(
      byAddress,
      async (address) => {
        callOrder.push(address);
        const deferred = createDeferred<string>();
        deferreds.set(address, deferred);
        return deferred.promise;
      },
      () => {},
      new AbortController().signal,
    );

    await flushWalk();

    // A serial implementation awaiting one lookup at a time would still be stuck on the FIRST
    // address here (none of the deferreds below were ever resolved) — three calls after a flush
    // is only possible if every one of them was started before any settled.
    expect(callOrder.sort()).toEqual([LOOT.toLowerCase(), TO_SELF.toLowerCase(), TRIBUTE.toLowerCase()].sort());

    for (const deferred of deferreds.values()) deferred.resolve('Name');
    await settle;
  });

  it('one address whose lookup REJECTS does not prevent the other addresses names from being appended — the specific hazard of starting the batch together', async () => {
    const okNode: DecodeNode = { label: 'ok', display: 'address', raw: LOOT.toLowerCase() };
    const badNode: DecodeNode = { label: 'bad', display: 'address', raw: TRIBUTE.toLowerCase() };
    const byAddress = new Map([
      [LOOT.toLowerCase(), [okNode]],
      [TRIBUTE.toLowerCase(), [badNode]],
    ]);

    await annotators().patchContractNames!(
      byAddress,
      async (address) => {
        if (address === TRIBUTE.toLowerCase()) throw new Error('boom');
        return 'Loot';
      },
      () => {},
      new AbortController().signal,
    );

    expect(okNode.annotations).toEqual(['(Loot)']);
    expect(badNode.annotations).toBeUndefined();
  });

  it.each([
    ['an absent name', undefined],
    ['an empty-string name', ''],
    ['a whitespace-only name', '   '],
  ])('%s produces no annotation and no notification', async (_description, value) => {
    const node: DecodeNode = { label: 'a', display: 'address', raw: LOOT.toLowerCase() };
    const notified: unknown[] = [];

    await annotators().patchContractNames!(
      new Map([[LOOT.toLowerCase(), [node]]]),
      async () => value,
      () => notified.push(true),
      new AbortController().signal,
    );

    expect(node.annotations).toBeUndefined();
    expect(notified).toEqual([]);
  });

  it('a name containing markup characters is appended verbatim, never escaped or truncated', async () => {
    const node: DecodeNode = { label: 'a', display: 'address', raw: LOOT.toLowerCase() };
    const spelled = '<img src=x onerror=alert(1)>';

    await annotators().patchContractNames!(
      new Map([[LOOT.toLowerCase(), [node]]]),
      async () => spelled,
      () => {},
      new AbortController().signal,
    );

    expect(node.annotations).toEqual([`(${spelled})`]);
  });

  it('a name already composed as the proxy pair produces the annotation exactly `(Proxy → Impl)` — NET-09s stated form — with no proxy special case in this walk', async () => {
    const node: DecodeNode = { label: 'a', display: 'address', raw: LOOT.toLowerCase() };

    await annotators().patchContractNames!(
      new Map([[LOOT.toLowerCase(), [node]]]),
      async () => 'Proxy → Impl',
      () => {},
      new AbortController().signal,
    );

    expect(node.annotations).toEqual(['(Proxy → Impl)']);
  });

  it('an already-aborted signal issues no lookups at all', async () => {
    const controller = new AbortController();
    controller.abort();
    const calls: string[] = [];

    await annotators().patchContractNames!(
      new Map([[LOOT.toLowerCase(), [{ label: 'a', display: 'address', raw: LOOT.toLowerCase() } as DecodeNode]]]),
      async (address) => {
        calls.push(address);
        return 'Loot';
      },
      () => {},
      controller.signal,
    );

    expect(calls).toEqual([]);
  });

  it('a signal that fires after the lookup resolves but before notification suppresses delivery — the abort is re-checked before each notification, not only before each lookup', async () => {
    const controller = new AbortController();
    const node: DecodeNode = { label: 'a', display: 'address', raw: LOOT.toLowerCase() };
    const notified: unknown[] = [];

    await annotators().patchContractNames!(
      new Map([[LOOT.toLowerCase(), [node]]]),
      async () => {
        controller.abort();
        return 'Loot';
      },
      (n, a) => notified.push([n, a]),
      controller.signal,
    );

    expect(notified).toEqual([]);
    expect(node.annotations).toBeUndefined();
  });
});

describe('ETH-12 wired into the decoder — the update channel and the injected lookup (06-06 Task 1)', () => {
  it('the decode promise resolves before any name lookup settles, even when the lookup never resolves', async () => {
    const deferred = createDeferred<AbiLookupResult>();
    const stubAbis: AbiSourcePort = {
      async getAbi() {
        return deferred.promise;
      },
    };

    const output = await decoder().decode(buildApproveCalldata(LOOT), makeCtx({ abis: stubAbis }));

    expect(output.node.label).toBe('approve');
    expect(output.node.children).toHaveLength(2);
    // deferred is deliberately never resolved in this test.
  });

  it('a context with no ABI source produces an output whose update channel is absent', async () => {
    const output = await decoder().decode(buildOuterPayload(), makeCtx());
    expect(output.onNodeUpdate).toBeUndefined();
  });

  it('an ABI source present but answering null (no key configured) still runs the walk per distinct address and issues no annotation — this is what makes the prior test safe to rely on', async () => {
    const calls: string[] = [];
    const stubAbis: AbiSourcePort = {
      async getAbi(address) {
        calls.push(address);
        return null;
      },
    };

    const output = await decoder().decode(buildApproveCalldata(LOOT), makeCtx({ abis: stubAbis }));
    await flushWalk();

    expect(output.onNodeUpdate).toBeDefined();
    expect(calls).toEqual([LOOT.toLowerCase()]);
    const addrNode = output.node.children![0];
    expect(addrNode.annotations ?? []).toHaveLength(0);
  });

  it('the injected lookup closure calls the ABI source as getAbi(address, { signal }) — an options object, never a positional signal and never a chain id', async () => {
    const calls: unknown[][] = [];
    const stubAbis: AbiSourcePort = {
      async getAbi(...args) {
        calls.push(args);
        return null;
      },
    };
    const controller = new AbortController();

    await decoder().decode(buildOuterPayload(), makeCtx({ abis: stubAbis, signal: controller.signal }));
    await flushWalk();

    expect(calls.length).toBeGreaterThan(0);
    for (const [address, options] of calls) {
      expect(typeof address).toBe('string');
      expect(options).toEqual({ signal: controller.signal });
    }
  });

  it('the zero address is never looked up by the walk, and its existing sentinel annotation is unchanged', async () => {
    const selector = keccak().selector('approve(address,uint256)');
    const zeroAddr = `0x${'0'.repeat(40)}`;
    const calldata = `${selector}${wordAddress(zeroAddr)}${wordUint(1n)}`;
    const calls: string[] = [];
    const stubAbis: AbiSourcePort = {
      async getAbi(address) {
        calls.push(address);
        return { name: 'Zero', abi: [] };
      },
    };

    const output = await decoder().decode(calldata, makeCtx({ abis: stubAbis }));
    await flushWalk();

    const addrNode = output.node.children![0];
    expect(addrNode.display).toBe('address');
    expect(calls).toEqual([]);
    expect(addrNode.annotations).toEqual(['address(0) — the zero address / native ETH sentinel']);
  });

  it('a subscriber receives a notification for a node whose address resolves, carrying that node and the annotation text', async () => {
    const deferred = createDeferred<AbiLookupResult>();
    const stubAbis: AbiSourcePort = {
      async getAbi() {
        return deferred.promise;
      },
    };

    const output = await decoder().decode(buildApproveCalldata(LOOT), makeCtx({ abis: stubAbis }));
    expect(output.onNodeUpdate).toBeDefined();

    const notified: [DecodeNode, string][] = [];
    const unsubscribe = output.onNodeUpdate!((node, annotation) => notified.push([node, annotation]));

    deferred.resolve({ name: 'Loot', abi: [] });
    await flushWalk();

    expect(notified.length).toBe(1);
    expect(notified[0][1]).toBe('(Loot)');
    expect(notified[0][0]).toBe(output.node.children![0]);

    unsubscribe();
  });

  it('unsubscribing stops delivery', async () => {
    const deferred = createDeferred<AbiLookupResult>();
    const stubAbis: AbiSourcePort = {
      async getAbi() {
        return deferred.promise;
      },
    };

    const output = await decoder().decode(buildApproveCalldata(LOOT), makeCtx({ abis: stubAbis }));
    const notified: unknown[] = [];
    const unsubscribe = output.onNodeUpdate!(() => notified.push(true));
    unsubscribe();

    deferred.resolve({ name: 'Loot', abi: [] });
    await flushWalk();

    expect(notified).toEqual([]);
  });

  it('subscribing after a name has already arrived does not re-deliver it — the annotation already lives on the node from the first render pass', async () => {
    const stubAbis: AbiSourcePort = {
      async getAbi() {
        return { name: 'Loot', abi: [] };
      },
    };

    const output = await decoder().decode(buildOuterPayload(), makeCtx({ abis: stubAbis }));
    await flushWalk(); // let the un-awaited walk settle before subscribing

    const dataNode = output.node.children![3];
    const arrayNode = dataNode.children![0];
    const el0Address = arrayNode.children![0].children![0];
    expect(el0Address.annotations).toContain('(Loot)');

    const notified: unknown[] = [];
    output.onNodeUpdate!(() => notified.push(true));
    await flushWalk();

    expect(notified).toEqual([]);
  });

  it('every lookup carries the decode abort signal, and no notification is delivered after that signal fires', async () => {
    const controller = new AbortController();
    const deferred = createDeferred<AbiLookupResult>();
    let capturedSignal: AbortSignal | undefined;
    const stubAbis: AbiSourcePort = {
      async getAbi(_address, options) {
        capturedSignal = options?.signal;
        return deferred.promise;
      },
    };

    const output = await decoder().decode(
      buildApproveCalldata(LOOT),
      makeCtx({ abis: stubAbis, signal: controller.signal }),
    );
    const notified: unknown[] = [];
    output.onNodeUpdate!(() => notified.push(true));

    controller.abort();
    deferred.resolve({ name: 'Loot', abi: [] });
    await flushWalk();

    expect(capturedSignal).toBe(controller.signal);
    expect(notified).toEqual([]);
  });

  it("a stub returning Plan 03's composed proxy pair produces the annotation exactly `(Proxy → Impl)` through the full wired path — NET-09's stated form, with no proxy special case anywhere in this walk", async () => {
    const stubAbis: AbiSourcePort = {
      async getAbi(address) {
        if (address === LOOT.toLowerCase()) return { name: 'Proxy → Impl', abi: [] };
        return null;
      },
    };

    const output = await decoder().decode(buildOuterPayload(), makeCtx({ abis: stubAbis }));
    await flushWalk();

    const dataNode = output.node.children![3];
    const arrayNode = dataNode.children![0];
    const el0Address = arrayNode.children![0].children![0];
    expect(el0Address.annotations).toContain('(Proxy → Impl)');
  });
});
