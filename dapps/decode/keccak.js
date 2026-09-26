window.DxDecode ??= {};
const KECCAK_ROUNDS = 24;
const KECCAK_RATE = 136;
const KECCAK_RATE_LANES = 17;
const KECCAK_OUTPUT_BYTES = 32;
const KECCAK_PAD_SUFFIX = 1;
const KECCAK_SELECTOR_BYTES = 4;
const KECCAK_RC_LO = new Uint32Array([
  1,
  32898,
  32906,
  2147516416,
  32907,
  2147483649,
  2147516545,
  32777,
  138,
  136,
  2147516425,
  2147483658,
  2147516555,
  139,
  32905,
  32771,
  32770,
  128,
  32778,
  2147483658,
  2147516545,
  32896,
  2147483649,
  2147516424
]);
const KECCAK_RC_HI = new Uint32Array([
  0,
  0,
  2147483648,
  2147483648,
  0,
  0,
  2147483648,
  2147483648,
  0,
  0,
  0,
  0,
  0,
  2147483648,
  2147483648,
  2147483648,
  2147483648,
  2147483648,
  0,
  2147483648,
  2147483648,
  2147483648,
  0,
  2147483648
]);
const KECCAK_RHO = new Uint8Array([
  0,
  1,
  62,
  28,
  27,
  36,
  44,
  6,
  55,
  20,
  3,
  10,
  43,
  25,
  39,
  41,
  45,
  15,
  21,
  8,
  18,
  2,
  61,
  56,
  14
]);
const KECCAK_C = new Uint32Array(10);
const KECCAK_D = new Uint32Array(10);
const KECCAK_B = new Uint32Array(50);
function keccakF(s) {
  for (let round = 0; round < KECCAK_ROUNDS; round++) {
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
      KECCAK_D[2 * x] = KECCAK_C[prev] ^ (lo << 1 | hi >>> 31);
      KECCAK_D[2 * x + 1] = KECCAK_C[prev + 1] ^ (hi << 1 | lo >>> 31);
    }
    for (let i = 0; i < 25; i++) {
      const x = i % 5;
      s[2 * i] ^= KECCAK_D[2 * x];
      s[2 * i + 1] ^= KECCAK_D[2 * x + 1];
    }
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
          KECCAK_B[to] = hi;
          KECCAK_B[to + 1] = lo;
        } else if (n < 32) {
          KECCAK_B[to] = lo << n | hi >>> 32 - n;
          KECCAK_B[to + 1] = hi << n | lo >>> 32 - n;
        } else {
          const m = n - 32;
          KECCAK_B[to] = hi << m | lo >>> 32 - m;
          KECCAK_B[to + 1] = lo << m | hi >>> 32 - m;
        }
      }
    }
    for (let y = 0; y < 5; y++) {
      for (let x = 0; x < 5; x++) {
        const i = 2 * (x + 5 * y);
        const i1 = 2 * ((x + 1) % 5 + 5 * y);
        const i2 = 2 * ((x + 2) % 5 + 5 * y);
        s[i] = KECCAK_B[i] ^ ~KECCAK_B[i1] & KECCAK_B[i2];
        s[i + 1] = KECCAK_B[i + 1] ^ ~KECCAK_B[i1 + 1] & KECCAK_B[i2 + 1];
      }
    }
    s[0] ^= KECCAK_RC_LO[round];
    s[1] ^= KECCAK_RC_HI[round];
  }
}
function keccakAbsorbBlock(s, bytes, offset) {
  for (let lane = 0; lane < KECCAK_RATE_LANES; lane++) {
    const b = offset + lane * 8;
    s[2 * lane] ^= bytes[b] | bytes[b + 1] << 8 | bytes[b + 2] << 16 | bytes[b + 3] << 24;
    s[2 * lane + 1] ^= bytes[b + 4] | bytes[b + 5] << 8 | bytes[b + 6] << 16 | bytes[b + 7] << 24;
  }
}
function keccakHash(input) {
  const s = new Uint32Array(50);
  let offset = 0;
  while (input.length - offset >= KECCAK_RATE) {
    keccakAbsorbBlock(s, input, offset);
    keccakF(s);
    offset += KECCAK_RATE;
  }
  const tail = new Uint8Array(KECCAK_RATE);
  tail.set(input.subarray(offset));
  tail[input.length - offset] = KECCAK_PAD_SUFFIX;
  tail[KECCAK_RATE - 1] |= 128;
  keccakAbsorbBlock(s, tail, 0);
  keccakF(s);
  const out = new Uint8Array(KECCAK_OUTPUT_BYTES);
  for (let lane = 0; lane < KECCAK_OUTPUT_BYTES / 8; lane++) {
    const lo = s[2 * lane];
    const hi = s[2 * lane + 1];
    const o = lane * 8;
    out[o] = lo & 255;
    out[o + 1] = lo >>> 8 & 255;
    out[o + 2] = lo >>> 16 & 255;
    out[o + 3] = lo >>> 24 & 255;
    out[o + 4] = hi & 255;
    out[o + 5] = hi >>> 8 & 255;
    out[o + 6] = hi >>> 16 & 255;
    out[o + 7] = hi >>> 24 & 255;
  }
  return out;
}
function keccakSelector(signature) {
  const digest = keccakHash(new TextEncoder().encode(signature));
  const hex = Array.from(digest.subarray(0, KECCAK_SELECTOR_BYTES), (b) => b.toString(16).padStart(2, "0")).join("");
  return `0x${hex}`;
}
window.DxDecode.keccak = { hash: keccakHash, selector: keccakSelector };
