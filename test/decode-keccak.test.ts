import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

// D-18's own vector table, proven against Ethereum's keccak-256 AND, in the same block, proven
// NOT to be SHA3-256 (pad 0x06 instead of 0x01) — the one place someone would otherwise
// reintroduce the pad-suffix hazard. Task 1's first commit writes this block alone, before
// abi.ts or any decoder exists, so the hasher is proven before anything depends on it (the
// cross-AI review's own ordering fix). Task 2 completes the suite with the selector round-trips
// and the multi-block/empty-input edges — do not duplicate these three pairs there.
function loadCompiled(relPath: string): void {
  const code = readFileSync(resolve(__dirname, relPath), 'utf-8');
  new Function('window', code)(window);
}

beforeEach(() => {
  loadCompiled('../src/dapps/decode/keccak.js');
});

function keccak(): DxDecodeKeccakModule {
  return window.DxDecode!.keccak as DxDecodeKeccakModule;
}

const utf8 = new TextEncoder();

function hashHex(input: string): string {
  return Array.from(keccak().hash(utf8.encode(input)), (b) => b.toString(16).padStart(2, '0')).join('');
}

describe('keccak-256 is Ethereum keccak, not SHA3-256 (D-18)', () => {
  it('the empty string hashes to the Ethereum vector, not the SHA3-256 one', () => {
    expect(hashHex('')).toBe('c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
    expect(hashHex('')).not.toBe('a7ffc6f8bf1ed76651c14756a061d662f580ff4de43b49fa82d80a4b80f8434a');
  });

  it('"abc" hashes to the Ethereum vector, not the SHA3-256 one', () => {
    expect(hashHex('abc')).toBe('4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45');
    expect(hashHex('abc')).not.toBe('3a985da74fe225b2045c172d6bd390bd855f086e3e9d525b46bfe24511431532');
  });

  it('"testing" hashes to the Ethereum vector, not the SHA3-256 one', () => {
    expect(hashHex('testing')).toBe('5f16f4c7f149ac4f9510d9cf8cf384038ad348b3bcdc01915f95de12df9d1b02');
    expect(hashHex('testing')).not.toBe('7f5979fb78f082e8b1c676635db8795c4ac6faba03525fb708cb5fd68fd40c5e');
  });
});

// D-18's verified selector round-trips — every one independently corroborated against handoff
// §7.4 and, for the two `f(...)` entries, the Solidity spec's own worked examples.
describe('keccak.selector — the eight verified round-trips (D-18, TST-01)', () => {
  const ROUND_TRIPS: [signature: string, selector: string][] = [
    ['transfer(address,uint256)', '0xa9059cbb'],
    ['approve(address,uint256)', '0x095ea7b3'],
    ['balanceOf(address)', '0x70a08231'],
    ['batchCalls((address,uint256,bytes)[])', '0x11c76fd9'],
    ['executeByVotes(uint256,address,uint256,bytes,bytes32)', '0x22fab893'],
    ['deployNext(bytes,bytes32)', '0x48215787'],
    ['f(uint256,uint32[],bytes10,bytes)', '0x8be65246'],
    ['f((uint256,uint256[],(uint256,uint256)[]),(uint256,uint256),uint256)', '0x6f2be728'],
  ];

  it.each(ROUND_TRIPS)('%s -> %s', (signature, expectedSelector) => {
    expect(keccak().selector(signature)).toBe(expectedSelector);
  });
});

// The multi-block and empty-input edges — the sponge's own block-boundary arithmetic, not the
// Ethereum-vs-SHA3 suffix hazard the first block above already covers.
describe('keccak.hash — multi-block and empty-input edges', () => {
  it('a zero-length Uint8Array produces the digest of the empty string', () => {
    expect(Array.from(keccak().hash(new Uint8Array(0)), (b) => b.toString(16).padStart(2, '0')).join('')).toBe(
      'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470',
    );
  });

  it('a payload longer than one 136-byte rate block hashes correctly (200 bytes, byte i = i % 256)', () => {
    const filler = new Uint8Array(200);
    for (let i = 0; i < filler.length; i++) filler[i] = i % 256;
    // Regression pin, not an independently sourced vector — produced by this implementation
    // once and pinned here, since the empty/abc/testing vectors above already prove the
    // single-block sponge is correct; this pins that the loop absorbing a SECOND rate block
    // does not silently diverge.
    const digest = Array.from(keccak().hash(filler), (b) => b.toString(16).padStart(2, '0')).join('');
    expect(digest).toBe('bfb0aa97863e797943cf7c33bb7e880bb4543f3d2703c0923c6901c2af57b890');
  });

  it('an input of exactly RATE-1 (135) bytes hashes to a DIFFERENT digest than RATE (136) bytes — the pad10*1 collapse would make them equal', () => {
    const rateMinus1 = new Uint8Array(135).fill(0xab);
    const rateExact = new Uint8Array(136).fill(0xab);
    const digestRateMinus1 = Array.from(keccak().hash(rateMinus1), (b) => b.toString(16).padStart(2, '0')).join('');
    const digestRateExact = Array.from(keccak().hash(rateExact), (b) => b.toString(16).padStart(2, '0')).join('');
    expect(digestRateMinus1).not.toBe(digestRateExact);
    // Regression pins for both — a remainder of exactly RATE-1 is the one case where the pad
    // suffix (0x01) and the final-rate-byte OR (0x80) could collapse onto the same byte if the
    // suffix were written after the OR instead of before it.
    expect(digestRateMinus1).toBe('932fedc0e854cc4d32eec69e896c7449570052b3aaceacff7b13745325e4cf47');
    expect(digestRateExact).toBe('302db73a4c8cc8ecc9004fec3a6525d9d6a2dd4b098b1bf62d1b897acff18c9d');
  });
});
