// window.DxDecode's abi-words decoder — the fourth slice of Phase 4, and the `cast
// pretty-calldata` view: 32-byte slicing plus byte-pattern heuristics, needing no ABI codec and
// no keccak-256 (that is what makes it affordable here rather than in Phase 5). It is also the
// one decoder in this phase that competes with `hex` for the same `0x…` input (D-10) and the
// one that touches ui.ts (D-08) — see this plan's <autodetect_curve_decision> and
// <raw_view_key_decision> for the reasoning behind each. Loads after decoders-jwt.js per
// manifest.json's ordering (04-04's manifest_load_order block).
//
// Top-level names in this directory must be unique — every file here is a global ambient
// script (no import, no export — D-08), and tsconfig.decode.json compiles them as ONE program,
// so two files sharing a top-level name collide with TS2451. Every top-level binding in this
// file is prefixed `words`, matching decoders-base64.ts's `b64`, decoders-jwt.ts's `jwt` and
// decoders-url.ts's `url` conventions.
window.DxDecode ??= {};

// No `core` cast: unlike decoders-base64.ts/decoders-jwt.ts, this decoder needs no shared
// core.ts helper — the confidence curve is hardcoded (0.95, well above AUTO_DETECT_THRESHOLD),
// matching decoders-url.ts's own precedent (04-02) of dropping an otherwise-unused cast.
const wordsCodecs = window.DxDecode.codecs as DxDecodeCodecsModule;
const wordsRegistry = window.DxDecode.registry as DecoderRegistry;

// Named rather than bare numerals — the arithmetic below (byte-length bounds, offset math,
// annotation predicates) reads as noise otherwise.
const WORD_BYTES = 32;
const SELECTOR_BYTES = 4;

// <autodetect_curve_decision>: D-10 requires this curve to score ABOVE hex's published 0.9 for
// calldata-shaped input, and 0 for everything else — hex's own curve (decoders.ts) is untouched.
// Two lower bounds, each load-bearing, and each documented in the plan text this comment
// condenses:
//   - n >= 1 on the selector shape (>= 36 bytes), not n >= 0: a bare 4-byte payload would
//     otherwise score 0.95 and hijack any short hex paste. hex renders 4 bytes perfectly well
//     (byte count, UTF-8 attempt, integer value); a selector-only word view is strictly less
//     information, and a person who wants it can still pick this decoder from the dropdown.
//   - n >= 2 on the bare-words shape (>= 64 bytes), not n >= 1: a single 32-byte value is
//     overwhelmingly a hash, a uint256 or a storage slot, and hex's integer-and-UTF-8 view is
//     the better default for it.
// Do not "simplify" either bound away — it silently hands real calldata back to hex.
function wordsCanDecode(input: string): number {
  if (!wordsCodecs.Hex.isHexLike(input)) return 0;
  const normalized = wordsCodecs.Hex.normalize(input);
  if (normalized.length === 0 || normalized.length % 2 !== 0) return 0;
  const byteLength = normalized.length / 2;

  const hasSelectorShape =
    byteLength >= SELECTOR_BYTES + WORD_BYTES && (byteLength - SELECTOR_BYTES) % WORD_BYTES === 0;
  const hasBareWordsShape = byteLength >= WORD_BYTES * 2 && byteLength % WORD_BYTES === 0;

  return hasSelectorShape || hasBareWordsShape ? 0.95 : 0;
}

// Reads a 32-byte word big-endian as a BigInt, never a lossy `number` — 03 D-02's rule (a
// uint256 is a bigint here) applied per word, since a value in this range is exactly what an
// ABI-encoded argument word is.
function wordsBigEndianValue(word: Uint8Array): bigint {
  let value = 0n;
  for (const b of word) {
    value = (value << 8n) | BigInt(b);
  }
  return value;
}

// The first of the two-pass structure class 5 (length-like) needs: every word whose value is a
// non-zero, 32-bit-fitting multiple of WORD_BYTES pointing at a LATER word within this same
// argument area contributes ITS TARGET's argument-relative byte offset to this set. A word's own
// argument-relative offset (wordIndex * WORD_BYTES) being a member is what "length-like" checks.
// Address-like values (>= 2^152 once byte 12 is forced non-zero) never reach this set — they
// fail the 32-bit-fits test long before the multiple-of-32 test would even run.
function wordsComputeOffsetTargets(words: Uint8Array[]): Set<number> {
  const offsetTargets = new Set<number>();
  for (let i = 0; i < words.length; i++) {
    const value = wordsBigEndianValue(words[i]);
    if (value === 0n || value > 0xffffffffn) continue;
    if (value % BigInt(WORD_BYTES) !== 0n) continue;
    const targetIndex = Number(value) / WORD_BYTES;
    if (targetIndex > i && targetIndex < words.length) {
      offsetTargets.add(Number(value));
    }
  }
  return offsetTargets;
}

async function wordsDecode(input: string, _ctx: DecodeContext): Promise<DecodeOutput> {
  const result = wordsCodecs.Hex.decode(input);
  if (!result.ok) {
    // DEC-12's concrete instance: malformed input becomes a returned error node, never a
    // thrown exception or a rejected promise — reachable by construction, since the codec this
    // calls has no throw branch to begin with.
    return {
      node: { label: 'abi-words', error: result.error, raw: input },
      rawBytes: null,
    };
  }

  const { bytes } = result;

  if (bytes.length === 0) {
    // A defined result, not an error — matching how `hex` treats the same input.
    return {
      node: { label: 'abi-words', value: null, annotations: ['no bytes to read'] },
      rawBytes: bytes,
      rawView: 'word-table',
    };
  }

  // <selector_shape_predicate> — the SAME test `renderWordTable` (ui.ts) and canDecode's first
  // branch use. The >= 36 floor is not the same as >= SELECTOR_BYTES: a bare 4-byte payload
  // must take neither branch in any of the three, or the Result tab and the Raw tab disagree
  // about what the same bytes are. The two shape tests cannot both hold, since lengths
  // differing by 4 cannot both be multiples of 32 — see decoders-abi-words.ts's other site,
  // ui.ts's renderWordTable, for the identical comment.
  const hasSelector = bytes.length >= SELECTOR_BYTES + WORD_BYTES && (bytes.length - SELECTOR_BYTES) % WORD_BYTES === 0;
  const argStart = hasSelector ? SELECTOR_BYTES : 0;

  const children: DecodeNode[] = [];

  if (hasSelector) {
    // TXT-05's "selector on the first line". provenance is an existing DecodeNode member with
    // an existing renderer badge (ui.ts) — 'unresolved' is exactly what this selector is, since
    // no registry lookup happens in this phase. The annotation exists because the badge alone
    // is ambiguous across phases: from Phase 5 on, 'unresolved' will mean "a lookup ran and
    // found nothing"; here it means "no lookup ran at all", and a reader has no way to tell
    // those apart from the badge alone.
    const selectorHex = wordsCodecs.Hex.encode(bytes.slice(0, SELECTOR_BYTES), { prefix: false });
    children.push({
      label: 'selector',
      value: `0x${selectorHex}`,
      display: 'hex',
      raw: `0x${selectorHex}`,
      provenance: 'unresolved',
      annotations: ['no signature lookup runs in this build'],
    });
  }

  const wordCount = Math.floor((bytes.length - argStart) / WORD_BYTES);
  const words: Uint8Array[] = [];
  for (let i = 0; i < wordCount; i++) {
    words.push(bytes.slice(argStart + i * WORD_BYTES, argStart + (i + 1) * WORD_BYTES));
  }

  const offsetTargets = wordsComputeOffsetTargets(words);

  // wordsAnnotate — the heuristic, and the only place in this repo it lives. Nested here (not
  // top-level) so it can close over argStart: the offset-like annotation names the target row's
  // payload offset, and the payload offset depends on whether a selector was consumed, which is
  // a fact of THIS decode call, not of a single word.
  //
  // The two short-circuits and the additivity are both deliberate. Classes 1 (zero word) and 2
  // (address-like) are TERMINAL — a zero word and an address-like word each get exactly one
  // annotation, because the other classes say nothing useful about them. Classes 3
  // (small/large int), 4 (offset-like) and 5 (length-like) are ADDITIVE — a word a head word
  // points at carries both a small-int and a length-like annotation, and that is correct: both
  // statements are true of it and neither is a determination. Every hypothesis class keeps the
  // `-like` suffix (or an explicit int-class name) and no annotation asserts that a word IS an
  // address, an offset or a length — this plan's kept prohibition, enforced entirely by the
  // vocabulary below.
  function wordsAnnotate(word: Uint8Array, wordIndex: number, count: number, targets: Set<number>): string[] {
    // class 1 — zero word. Terminal: a zero word is not usefully "a small int of 0" as well.
    if (word.every((b) => b === 0)) {
      return ['zero word'];
    }

    // class 2 — address-like. Terminal, and both halves of the predicate are load-bearing (see
    // this plan's <review_disposition>): top twelve bytes zero AND byte 12 non-zero. The
    // `byte 12 non-zero` clause is what keeps a small offset/length (e.g. the value 32, which
    // is also top-twelve-zero) from being misread as an address — a real 20-byte address has
    // its most significant byte set with probability 255/256; a value small enough to be an
    // offset or a length never does. The accepted cost is a value between 2^152 and 2^160 that
    // genuinely is a large integer reading as address-like instead — a false positive of a
    // shape hypothesis, which is precisely what the `-like` vocabulary exists to keep honest.
    const topTwelveZero = word.slice(0, 12).every((b) => b === 0);
    if (topTwelveZero && word[12] !== 0) {
      const addressHex = wordsCodecs.Hex.encode(word.slice(12), { prefix: false });
      return [`address-like — 0x${addressHex}`];
    }

    const annotations: string[] = [];

    // class 3 — small int or large int. Exactly one always applies once classes 1 and 2 did
    // not match, which is what makes "every word annotated" literally true. BigInt is on the
    // portability guard's allowlist and 03 D-02 already establishes that a uint256 is a bigint
    // here, never a lossy number.
    const bigValue = wordsBigEndianValue(word);
    const fitsUint32 = bigValue <= 0xffffffffn;
    annotations.push(fitsUint32 ? `small int — ${bigValue.toString()}` : `large int — ${bigValue.toString()}`);

    // class 4 — offset-like. Names the target in BOTH coordinate systems this decoder uses: the
    // argument-relative byte the word literally contains, and the target row's own word index
    // and payload offset as the label writes it — naming only the first sends a reader to a row
    // labelled by payload offset looking for an argument-relative one; naming only the second
    // hides what the word actually contains.
    if (fitsUint32 && bigValue !== 0n && bigValue % BigInt(WORD_BYTES) === 0n) {
      const targetIndex = Number(bigValue) / WORD_BYTES;
      if (targetIndex > wordIndex && targetIndex < count) {
        const payloadOffset = argStart + targetIndex * WORD_BYTES;
        annotations.push(
          `offset-like — points to argument-relative byte ${Number(bigValue)}, word ${targetIndex} at payload offset 0x${payloadOffset
            .toString(16)
            .padStart(4, '0')}`,
        );
      }
    }

    // class 5 — length-like. The one honest way to tell a length from an ordinary small integer
    // without an ABI: in ABI encoding a length word sits exactly at the byte offset a head word
    // points to. `targets` was built in the first pass over every word that matched class 4.
    if (targets.has(wordIndex * WORD_BYTES)) {
      annotations.push(`length-like — ${bigValue.toString()}`);
    }

    return annotations;
  }

  for (let i = 0; i < wordCount; i++) {
    const offset = argStart + i * WORD_BYTES;
    const wordHex = wordsCodecs.Hex.encode(words[i], { prefix: false });
    children.push({
      label: `word ${i} @ 0x${offset.toString(16).padStart(4, '0')}`,
      value: `0x${wordHex}`,
      display: 'hex',
      raw: `0x${wordHex}`,
      annotations: wordsAnnotate(words[i], i, wordCount, offsetTargets),
    });
  }

  // A partial trailing word — only reachable by manual selection, since canDecode scores such
  // input 0 — is reported rather than dropped.
  const consumed = argStart + wordCount * WORD_BYTES;
  if (consumed < bytes.length) {
    const leftover = bytes.slice(consumed);
    const leftoverHex = wordsCodecs.Hex.encode(leftover, { prefix: false });
    children.push({
      label: `word ${wordCount} @ 0x${consumed.toString(16).padStart(4, '0')}`,
      value: `0x${leftoverHex}`,
      display: 'hex',
      raw: `0x${leftoverHex}`,
      warning: `${leftover.length} leftover byte${leftover.length === 1 ? '' : 's'} — not a whole 32-byte word`,
    });
  }

  const node: DecodeNode = {
    label: 'abi-words',
    type: 'bytes',
    value: null,
    raw: `0x${wordsCodecs.Hex.encode(bytes, { prefix: false })}`,
    children,
  };

  return {
    node,
    rawBytes: bytes,
    // The dispatch key Task 2 registers on RAW_VIEW_DISPATCH (ui.ts) — deliberately NOT this
    // decoder's own id. See this plan's <raw_view_key_decision> block for why.
    rawView: 'word-table',
  };
}

const abiWordsDecoder: DecoderPort = {
  id: 'abi-words',
  label: 'ABI words',
  settings: [],
  canDecode: wordsCanDecode,
  decode: wordsDecode,
};

// D-05's self-registration — the final statement.
wordsRegistry.register(abiWordsDecoder);
