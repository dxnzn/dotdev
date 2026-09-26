// window.DxDecode.keccak — this chain's keccak-256, ported (D-16) essentially verbatim from
// /dnznlabs/dxkit/plugins/web3/src/keccak.ts rather than rewritten. Loads second, right after
// codecs.ts and before abi.ts (manifest.json), because abi.ts reads window.DxDecode.keccak at
// module load to derive selectors.
//
// Why vendored/ported at all (kept from the source file's own header — this is the one place
// someone would otherwise reintroduce the bug): the single highest-risk detail in this package
// is the domain-separation suffix. This chain's keccak-256 is the PRE-standardisation Keccak and
// differs from FIPS-202 SHA3-256 in exactly one byte: the pad suffix is `0x01`, not `0x06`.
// Node's `crypto` exposes `sha3-256` under every name that reads like "keccak" and can never be
// substituted. A wrong suffix produces a completely different digest from an otherwise-correct
// sponge — test/decode-keccak.test.ts asserts the empty-input anchor vector explicitly, with a
// negative assertion against the SHA3-256 value in the same block.
//
// Parameters: Keccak-f[1600], 24 rounds, rate 136 bytes (1088 bits), capacity 512 bits, pad
// suffix `0x01`, final rate byte OR `0x80`, 32-byte output.
//
// Lanes are held as 32-bit pairs in a single `Uint32Array(50)` — `s[2i]` is lane `i`'s low word,
// `s[2i+1]` its high word — rather than as BigInts, which would allocate per round and make a
// multi-kilobyte payload materially slow (D-17: 14x faster on a 64 KB blob, measured).
//
// Deliberately exposes no runner, algorithm or suffix parameter: an injectable hasher next to
// code whose whole point is pinning one immutable suffix is exactly the kind of seam that
// invites misuse.
//
// Two changes from the ported source, per D-16: the ES-module export is replaced with this
// directory's IIFE + window.DxDecode shape, and every top-level binding takes the `keccak`
// prefix (D-14's directory-wide uniqueness rule — no import/export anywhere here, so the whole
// directory compiles as one TS program).
window.DxDecode ??= {};

const KECCAK_ROUNDS = 24;
/** Rate in bytes: 1600 bits state − 512 bits capacity = 1088 bits. */
const KECCAK_RATE = 136;
/** 17 lanes of the 25 are absorbed per block (136 / 8). */
const KECCAK_RATE_LANES = 17;
const KECCAK_OUTPUT_BYTES = 32;
/** This chain's pre-standardisation Keccak pad. FIPS-202 SHA3-256 uses 0x06 — see the header. */
const KECCAK_PAD_SUFFIX = 0x01;
/** bytes4(selector) — the first four bytes of a signature's keccak-256 digest. */
const KECCAK_SELECTOR_BYTES = 4;

/** Round-constant low words, indexed by round. */
const KECCAK_RC_LO = new Uint32Array([
  0x00000001, 0x00008082, 0x0000808a, 0x80008000, 0x0000808b, 0x80000001, 0x80008081, 0x00008009, 0x0000008a,
  0x00000088, 0x80008009, 0x8000000a, 0x8000808b, 0x0000008b, 0x00008089, 0x00008003, 0x00008002, 0x00000080,
  0x0000800a, 0x8000000a, 0x80008081, 0x00008080, 0x80000001, 0x80008008,
]);

/** Round-constant high words, indexed by round. */
const KECCAK_RC_HI = new Uint32Array([
  0x00000000, 0x00000000, 0x80000000, 0x80000000, 0x00000000, 0x00000000, 0x80000000, 0x80000000, 0x00000000,
  0x00000000, 0x00000000, 0x00000000, 0x00000000, 0x80000000, 0x80000000, 0x80000000, 0x80000000, 0x80000000,
  0x00000000, 0x80000000, 0x80000000, 0x80000000, 0x00000000, 0x80000000,
]);

/** Rho rotation offsets, flattened as `x + 5y` over the standard r[x][y] table. */
const KECCAK_RHO = new Uint8Array([
  0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14,
]);

// Scratch buffers, allocated once at module scope. keccakHash is synchronous end to end, so no
// two invocations can interleave and share them — the same reason the sponge state below is
// per-call while these are not.
const KECCAK_C = new Uint32Array(10);
const KECCAK_D = new Uint32Array(10);
const KECCAK_B = new Uint32Array(50);

function keccakF(s: Uint32Array): void {
  for (let round = 0; round < KECCAK_ROUNDS; round++) {
    // theta: column parities, then D[x] = C[x-1] ^ rotl1(C[x+1])
    for (let x = 0; x < 5; x++) {
      let lo = 0;
      let hi = 0;
      for (let y = 0; y < 5; y++) {
        const i = 2 * (x + 5 * y);
        lo ^= s[i];
        hi ^= s[i + 1];
      }
      KECCAK_C[2 * x] = lo;
      KECCAK_C[2 * x + 1] = hi;
    }
    for (let x = 0; x < 5; x++) {
      const next = 2 * ((x + 1) % 5);
      const prev = 2 * ((x + 4) % 5);
      const lo = KECCAK_C[next];
      const hi = KECCAK_C[next + 1];
      KECCAK_D[2 * x] = KECCAK_C[prev] ^ ((lo << 1) | (hi >>> 31));
      KECCAK_D[2 * x + 1] = KECCAK_C[prev + 1] ^ ((hi << 1) | (lo >>> 31));
    }
    for (let i = 0; i < 25; i++) {
      const x = i % 5;
      s[2 * i] ^= KECCAK_D[2 * x];
      s[2 * i + 1] ^= KECCAK_D[2 * x + 1];
    }

    // rho (rotate each lane) + pi (move lane (x,y) to (y, 2x+3y))
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        const from = 2 * (x + 5 * y);
        const to = 2 * (y + 5 * ((2 * x + 3 * y) % 5));
        const n = KECCAK_RHO[x + 5 * y];
        const lo = s[from];
        const hi = s[from + 1];
        if (n === 0) {
          KECCAK_B[to] = lo;
          KECCAK_B[to + 1] = hi;
        } else if (n === 32) {
          // JS shift counts are taken mod 32, so the `n < 32` arithmetic below degenerates at
          // exactly n === 32 — a 32-bit rotation is a plain word swap here, and without this
          // branch `lo << 32` would silently be `lo << 0`, producing a wrong digest with no error.
          KECCAK_B[to] = hi;
          KECCAK_B[to + 1] = lo;
        } else if (n < 32) {
          KECCAK_B[to] = (lo << n) | (hi >>> (32 - n));
          KECCAK_B[to + 1] = (hi << n) | (lo >>> (32 - n));
        } else {
          const m = n - 32;
          KECCAK_B[to] = (hi << m) | (lo >>> (32 - m));
          KECCAK_B[to + 1] = (lo << m) | (hi >>> (32 - m));
        }
      }
    }

    // chi: A[x][y] = B[x][y] ^ (~B[x+1][y] & B[x+2][y])
    for (let y = 0; y < 5; y++) {
      for (let x = 0; x < 5; x++) {
        const i = 2 * (x + 5 * y);
        const i1 = 2 * (((x + 1) % 5) + 5 * y);
        const i2 = 2 * (((x + 2) % 5) + 5 * y);
        s[i] = KECCAK_B[i] ^ (~KECCAK_B[i1] & KECCAK_B[i2]);
        s[i + 1] = KECCAK_B[i + 1] ^ (~KECCAK_B[i1 + 1] & KECCAK_B[i2 + 1]);
      }
    }

    // iota
    s[0] ^= KECCAK_RC_LO[round];
    s[1] ^= KECCAK_RC_HI[round];
  }
}

/** XORs one full 136-byte rate block, little-endian, into lanes 0..16. */
function keccakAbsorbBlock(s: Uint32Array, bytes: Uint8Array, offset: number): void {
  for (let lane = 0; lane < KECCAK_RATE_LANES; lane++) {
    const b = offset + lane * 8;
    s[2 * lane] ^= bytes[b] | (bytes[b + 1] << 8) | (bytes[b + 2] << 16) | (bytes[b + 3] << 24);
    s[2 * lane + 1] ^= bytes[b + 4] | (bytes[b + 5] << 8) | (bytes[b + 6] << 16) | (bytes[b + 7] << 24);
  }
}

/** This chain's keccak-256. Synchronous; returns exactly 32 bytes for any input length. */
function keccakHash(input: Uint8Array): Uint8Array {
  const s = new Uint32Array(50);

  let offset = 0;
  while (input.length - offset >= KECCAK_RATE) {
    keccakAbsorbBlock(s, input, offset);
    keccakF(s);
    offset += KECCAK_RATE;
  }

  // pad10*1 with this chain's domain suffix. A remainder of exactly RATE-1 collapses the two
  // pad bytes onto one, which is why the suffix is written before the 0x80 is OR-ed in.
  const tail = new Uint8Array(KECCAK_RATE);
  tail.set(input.subarray(offset));
  tail[input.length - offset] = KECCAK_PAD_SUFFIX;
  tail[KECCAK_RATE - 1] |= 0x80;
  keccakAbsorbBlock(s, tail, 0);
  keccakF(s);

  const out = new Uint8Array(KECCAK_OUTPUT_BYTES);
  for (let lane = 0; lane < KECCAK_OUTPUT_BYTES / 8; lane++) {
    const lo = s[2 * lane];
    const hi = s[2 * lane + 1];
    const o = lane * 8;
    out[o] = lo & 0xff;
    out[o + 1] = (lo >>> 8) & 0xff;
    out[o + 2] = (lo >>> 16) & 0xff;
    out[o + 3] = (lo >>> 24) & 0xff;
    out[o + 4] = hi & 0xff;
    out[o + 5] = (hi >>> 8) & 0xff;
    out[o + 6] = (hi >>> 16) & 0xff;
    out[o + 7] = (hi >>> 24) & 0xff;
  }
  return out;
}

// D-19: the signature must be canonical — no spaces, no parameter names — because keccak is
// over the exact string. abi.ts's canonicalSignature is what produces that string; this
// function only hashes and truncates whatever it is given.
function keccakSelector(signature: string): string {
  const digest = keccakHash(new TextEncoder().encode(signature));
  const hex = Array.from(digest.subarray(0, KECCAK_SELECTOR_BYTES), (b) => b.toString(16).padStart(2, '0')).join('');
  return `0x${hex}`;
}

window.DxDecode.keccak = { hash: keccakHash, selector: keccakSelector };
