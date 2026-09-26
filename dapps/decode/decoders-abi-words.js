window.DxDecode ??= {};
const wordsCodecs = window.DxDecode.codecs;
const wordsRegistry = window.DxDecode.registry;
const WORD_BYTES = 32;
const SELECTOR_BYTES = 4;
function wordsCanDecode(input) {
  if (!wordsCodecs.Hex.isHexLike(input)) return 0;
  const normalized = wordsCodecs.Hex.normalize(input);
  if (normalized.length === 0 || normalized.length % 2 !== 0) return 0;
  const byteLength = normalized.length / 2;
  const hasSelectorShape = byteLength >= SELECTOR_BYTES + WORD_BYTES && (byteLength - SELECTOR_BYTES) % WORD_BYTES === 0;
  const hasBareWordsShape = byteLength >= WORD_BYTES * 2 && byteLength % WORD_BYTES === 0;
  return hasSelectorShape || hasBareWordsShape ? 0.95 : 0;
}
function wordsBigEndianValue(word) {
  let value = 0n;
  for (const b of word) {
    value = value << 8n | BigInt(b);
  }
  return value;
}
function wordsComputeOffsetTargets(words) {
  const offsetTargets = /* @__PURE__ */ new Set();
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
async function wordsDecode(input, _ctx) {
  const result = wordsCodecs.Hex.decode(input);
  if (!result.ok) {
    return {
      node: { label: "abi-words", error: result.error, raw: input },
      rawBytes: null
    };
  }
  const { bytes } = result;
  if (bytes.length === 0) {
    return {
      node: { label: "abi-words", value: null, annotations: ["no bytes to read"] },
      rawBytes: bytes,
      rawView: "word-table"
    };
  }
  const hasSelector = bytes.length >= SELECTOR_BYTES + WORD_BYTES && (bytes.length - SELECTOR_BYTES) % WORD_BYTES === 0;
  const argStart = hasSelector ? SELECTOR_BYTES : 0;
  const children = [];
  if (hasSelector) {
    const selectorHex = wordsCodecs.Hex.encode(bytes.slice(0, SELECTOR_BYTES), { prefix: false });
    children.push({
      label: "selector",
      value: `0x${selectorHex}`,
      display: "hex",
      raw: `0x${selectorHex}`,
      provenance: "unresolved",
      annotations: ["no signature lookup runs for this decoder \u2014 pick eth-calldata to resolve the selector"]
    });
  }
  const wordCount = Math.floor((bytes.length - argStart) / WORD_BYTES);
  const words = [];
  for (let i = 0; i < wordCount; i++) {
    words.push(bytes.slice(argStart + i * WORD_BYTES, argStart + (i + 1) * WORD_BYTES));
  }
  const offsetTargets = wordsComputeOffsetTargets(words);
  function wordsAnnotate(word, wordIndex, count, targets) {
    if (word.every((b) => b === 0)) {
      return ["zero word"];
    }
    const topTwelveZero = word.slice(0, 12).every((b) => b === 0);
    if (topTwelveZero && word[12] !== 0) {
      const addressHex = wordsCodecs.Hex.encode(word.slice(12), { prefix: false });
      return [`address-like \u2014 0x${addressHex}`];
    }
    const annotations = [];
    const bigValue = wordsBigEndianValue(word);
    const fitsUint32 = bigValue <= 0xffffffffn;
    annotations.push(fitsUint32 ? `small int \u2014 ${bigValue.toString()}` : `large int \u2014 ${bigValue.toString()}`);
    if (fitsUint32 && bigValue !== 0n && bigValue % BigInt(WORD_BYTES) === 0n) {
      const targetIndex = Number(bigValue) / WORD_BYTES;
      if (targetIndex > wordIndex && targetIndex < count) {
        const payloadOffset = argStart + targetIndex * WORD_BYTES;
        annotations.push(
          `offset-like \u2014 points to argument-relative byte ${Number(bigValue)}, word ${targetIndex} at payload offset 0x${payloadOffset.toString(16).padStart(4, "0")}`
        );
      }
    }
    if (targets.has(wordIndex * WORD_BYTES)) {
      annotations.push(`length-like \u2014 ${bigValue.toString()}`);
    }
    return annotations;
  }
  for (let i = 0; i < wordCount; i++) {
    const offset = argStart + i * WORD_BYTES;
    const wordHex = wordsCodecs.Hex.encode(words[i], { prefix: false });
    children.push({
      label: `word ${i} @ 0x${offset.toString(16).padStart(4, "0")}`,
      value: `0x${wordHex}`,
      display: "hex",
      raw: `0x${wordHex}`,
      annotations: wordsAnnotate(words[i], i, wordCount, offsetTargets)
    });
  }
  const consumed = argStart + wordCount * WORD_BYTES;
  if (consumed < bytes.length) {
    const leftover = bytes.slice(consumed);
    const leftoverHex = wordsCodecs.Hex.encode(leftover, { prefix: false });
    children.push({
      label: `word ${wordCount} @ 0x${consumed.toString(16).padStart(4, "0")}`,
      value: `0x${leftoverHex}`,
      display: "hex",
      raw: `0x${leftoverHex}`,
      warning: `${leftover.length} leftover byte${leftover.length === 1 ? "" : "s"} \u2014 not a whole 32-byte word`
    });
  }
  const node = {
    label: "abi-words",
    type: "bytes",
    value: null,
    raw: `0x${wordsCodecs.Hex.encode(bytes, { prefix: false })}`,
    children
  };
  return {
    node,
    rawBytes: bytes,
    // The dispatch key Task 2 registers on RAW_VIEW_DISPATCH (ui.ts) — deliberately NOT this
    // decoder's own id. See this plan's <raw_view_key_decision> block for why.
    rawView: "word-table"
  };
}
const abiWordsDecoder = {
  id: "abi-words",
  label: "ABI words",
  settings: [],
  canDecode: wordsCanDecode,
  decode: wordsDecode
};
wordsRegistry.register(abiWordsDecoder);
