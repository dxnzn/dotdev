window.DxDecode ??= {};
const abiCodecs = window.DxDecode.codecs;
const ABI_WORD_BYTES = 32;
const ABI_MAX_DEPTH = 32;
const ABI_MAX_NODES = 1e4;
let abiNodesRemaining = ABI_MAX_NODES;
function abiBudgetExhausted() {
  return abiNodesRemaining <= 0;
}
const ABI_TYPE_ALIASES = {
  uint: "uint256",
  int: "int256",
  fixed: "fixed128x18",
  ufixed: "ufixed128x18"
};
const ABI_SUPPORTED_ELEMENTARY = [
  "uintN",
  "intN",
  "address",
  "bool",
  "bytesN",
  "bytes",
  "string",
  "function",
  "fixedMxN",
  "ufixedMxN"
];
function abiNormalizeAlias(type) {
  return ABI_TYPE_ALIASES[type] ?? type;
}
function abiSkipWs(s, pos) {
  let p = pos;
  while (p < s.length && /\s/.test(s[p])) p++;
  return p;
}
function abiClassifyElementary(token) {
  let m = /^uint([0-9]*)$/.exec(token);
  if (m) {
    const bits = m[1] ? Number(m[1]) : 256;
    return { kind: "elementary", type: `uint${bits}`, bits };
  }
  m = /^int([0-9]*)$/.exec(token);
  if (m) {
    const bits = m[1] ? Number(m[1]) : 256;
    return { kind: "elementary", type: `int${bits}`, bits };
  }
  if (token === "address") return { kind: "elementary", type: "address" };
  if (token === "bool") return { kind: "elementary", type: "bool" };
  m = /^bytes([0-9]*)$/.exec(token);
  if (m) {
    if (m[1]) {
      const size = Number(m[1]);
      return { kind: "elementary", type: `bytes${size}`, size };
    }
    return { kind: "elementary", type: "bytes" };
  }
  if (token === "string") return { kind: "elementary", type: "string" };
  if (token === "function") return { kind: "elementary", type: "function" };
  m = /^u?fixed[0-9]+x[0-9]+$/.exec(token);
  if (m) return { kind: "elementary", type: token };
  if (token === "fixed" || token === "ufixed") return { kind: "elementary", type: token };
  return void 0;
}
function abiParseOneType(s, pos, depth) {
  let p = abiSkipWs(s, pos);
  let node;
  if (s[p] === "(") {
    if (depth >= ABI_MAX_DEPTH) {
      throw new Error(`tuple nesting exceeds ${ABI_MAX_DEPTH} levels at position ${p} in "${s}"`);
    }
    const { types: components, nextPos: afterList } = abiParseTypeList(s, p + 1, depth + 1);
    let q = abiSkipWs(s, afterList);
    if (s[q] !== ")") throw new Error(`expected ')' closing a tuple at position ${q} in "${s}"`);
    q++;
    node = { kind: "tuple", type: `(${components.map(abiCanonicalType).join(",")})`, components };
    p = q;
  } else {
    const match = /^[A-Za-z][A-Za-z0-9]*/.exec(s.slice(p));
    if (!match) throw new Error(`expected a type at position ${p} in "${s}"`);
    const token = match[0];
    const elementary = abiClassifyElementary(token);
    if (!elementary) throw new Error(`unrecognized type "${token}" at position ${p} in "${s}"`);
    node = elementary;
    p += token.length;
  }
  for (; ; ) {
    if (s[p] !== "[") break;
    let q = p + 1;
    const start = q;
    while (q < s.length && /[0-9]/.test(s[q])) q++;
    if (s[q] !== "]") throw new Error(`malformed array suffix at position ${p} in "${s}"`);
    const digits = s.slice(start, q);
    const length = digits.length > 0 ? Number(digits) : void 0;
    node = {
      kind: "array",
      type: abiCanonicalType(node) + (digits.length > 0 ? `[${digits}]` : "[]"),
      element: node,
      length
    };
    p = q + 1;
  }
  p = abiSkipWs(s, p);
  while (p < s.length && /[A-Za-z0-9_]/.test(s[p])) {
    p++;
    p = abiSkipWs(s, p);
  }
  return { type: node, nextPos: p };
}
function abiParseTypeList(s, pos, depth) {
  let p = abiSkipWs(s, pos);
  if (s[p] === ")") return { types: [], nextPos: p };
  const types = [];
  for (; ; ) {
    const { type, nextPos } = abiParseOneType(s, p, depth);
    types.push(type);
    p = abiSkipWs(s, nextPos);
    if (s[p] === ",") {
      p = abiSkipWs(s, p + 1);
      continue;
    }
    if (s[p] === ")") return { types, nextPos: p };
    throw new Error(`expected ',' or ')' at position ${p} in "${s}"`);
  }
}
function abiParseTypeString(sig) {
  try {
    const trimmed = sig.trim();
    const parenIdx = trimmed.indexOf("(");
    if (parenIdx === -1) return { error: `expected '(' in signature "${sig}"` };
    const name = trimmed.slice(0, parenIdx).trim();
    const { types, nextPos } = abiParseTypeList(trimmed, parenIdx + 1, 0);
    const afterList = abiSkipWs(trimmed, nextPos);
    if (trimmed[afterList] !== ")") {
      return { error: `expected ')' closing the argument list in signature "${sig}"` };
    }
    return { name, types };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
function abiSplitBaseAndSuffix(typeStr) {
  const idx = typeStr.indexOf("[");
  return idx === -1 ? { base: typeStr, suffix: "" } : { base: typeStr.slice(0, idx), suffix: typeStr.slice(idx) };
}
function abiApplyArraySuffixString(suffix, baseNode) {
  if (!suffix) return baseNode;
  let node = baseNode;
  for (const m of suffix.matchAll(/\[([0-9]*)\]/g)) {
    const digits = m[1];
    const length = digits.length > 0 ? Number(digits) : void 0;
    node = {
      kind: "array",
      type: abiCanonicalType(node) + (digits.length > 0 ? `[${digits}]` : "[]"),
      element: node,
      length
    };
  }
  return node;
}
function abiParseAbiInput(input, depth = 0) {
  const { base, suffix } = abiSplitBaseAndSuffix(input.type);
  let node;
  if (base === "tuple") {
    const components = depth >= ABI_MAX_DEPTH ? [] : abiParseAbiInputs(input.components ?? [], depth + 1);
    node = {
      kind: "tuple",
      type: `(${components.map(abiCanonicalType).join(",")})`,
      components,
      name: input.name || void 0
    };
  } else {
    const elementary = abiClassifyElementary(base) ?? { kind: "elementary", type: base };
    node = { ...elementary, name: input.name || void 0 };
  }
  return abiApplyArraySuffixString(suffix, node);
}
function abiParseAbiInputs(inputs, depth = 0) {
  return inputs.map((input) => abiParseAbiInput(input, depth));
}
function abiCanonicalType(node) {
  if (node.kind === "tuple") {
    return `(${(node.components ?? []).map(abiCanonicalType).join(",")})`;
  }
  if (node.kind === "array") {
    const elementType = node.element ? abiCanonicalType(node.element) : "";
    return elementType + (node.length === void 0 ? "[]" : `[${node.length}]`);
  }
  return abiNormalizeAlias(node.type);
}
function abiCanonicalSignature(name, types) {
  return `${name}(${types.map(abiCanonicalType).join(",")})`;
}
function abiIsDynamic(node) {
  if (node.kind === "elementary") {
    return node.type === "bytes" || node.type === "string";
  }
  if (node.kind === "array") {
    if (node.length === void 0) return true;
    return node.element ? abiIsDynamic(node.element) : false;
  }
  if (node.kind === "tuple") {
    return (node.components ?? []).some(abiIsDynamic);
  }
  return false;
}
function abiHeadWidth(t) {
  if (!abiIsDynamic(t)) {
    if (t.kind === "array" && t.length !== void 0 && t.element) {
      return t.length * abiHeadWidth(t.element);
    }
    if (t.kind === "tuple") {
      return (t.components ?? []).reduce((sum, c) => sum + abiHeadWidth(c), 0);
    }
  }
  return ABI_WORD_BYTES;
}
function abiWordAt(data, offset) {
  if (offset < 0 || offset + ABI_WORD_BYTES > data.length) return null;
  return data.slice(offset, offset + ABI_WORD_BYTES);
}
function abiWordBigEndianValue(word) {
  let value = 0n;
  for (const b of word) value = value << 8n | BigInt(b);
  return value;
}
function abiToSignedBigInt(word) {
  const unsigned = abiWordBigEndianValue(word);
  const signBit = 1n << 255n;
  return (unsigned & signBit) === 0n ? unsigned : unsigned - (1n << 256n);
}
function abiDecodeStaticElementary(canonical, data, offset, label) {
  const word = abiWordAt(data, offset);
  if (!word) {
    return { label, type: canonical, error: `truncated calldata \u2014 no word at byte ${offset}` };
  }
  const uintMatch = /^uint([0-9]+)$/.exec(canonical);
  if (uintMatch) {
    const bits = Number(uintMatch[1]);
    const full = abiWordBigEndianValue(word);
    const masked = bits >= 256 ? full : full & (1n << BigInt(bits)) - 1n;
    return { label, type: canonical, value: masked, raw: masked.toString() };
  }
  const intMatch = /^int([0-9]+)$/.exec(canonical);
  if (intMatch) {
    const signed = abiToSignedBigInt(word);
    return { label, type: canonical, value: signed, raw: signed.toString() };
  }
  if (canonical === "address") {
    const hex = abiCodecs.Hex.encode(word.slice(12));
    return { label, type: canonical, value: hex, raw: hex };
  }
  if (canonical === "bool") {
    const isZero = word.every((b) => b === 0);
    const isOne = word.slice(0, -1).every((b) => b === 0) && word[word.length - 1] === 1;
    const value = !isZero;
    const node = { label, type: canonical, value: String(value), raw: String(value) };
    if (!isZero && !isOne) {
      node.warning = "word is neither exactly 0 nor exactly 1 \u2014 treated as true per its non-zero value";
    }
    return node;
  }
  const bytesNMatch = /^bytes([0-9]+)$/.exec(canonical);
  if (bytesNMatch) {
    const size = Number(bytesNMatch[1]);
    const hex = abiCodecs.Hex.encode(word.slice(0, size));
    return { label, type: canonical, value: hex, raw: hex };
  }
  if (canonical === "function") {
    const hex = abiCodecs.Hex.encode(word.slice(0, 24));
    return { label, type: canonical, value: hex, raw: hex };
  }
  if (/^u?fixed[0-9]+x[0-9]+$/.test(canonical) || canonical === "fixed" || canonical === "ufixed") {
    return { label, type: canonical, error: `fixed-point type "${canonical}" is not decoded` };
  }
  return null;
}
function abiDecodeDynamic(canonical, data, base, label) {
  const lengthWord = abiWordAt(data, base);
  if (!lengthWord) return { label, type: canonical, error: `truncated calldata \u2014 no length word at byte ${base}` };
  const lengthValue = abiWordBigEndianValue(lengthWord);
  if (lengthValue > BigInt(Number.MAX_SAFE_INTEGER)) {
    return { label, type: canonical, error: "dynamic length exceeds a safe integer \u2014 refusing to allocate" };
  }
  const length = Number(lengthValue);
  const dataStart = base + ABI_WORD_BYTES;
  if (length < 0 || dataStart + length > data.length) {
    return { label, type: canonical, error: `dynamic length ${length} at byte ${base} exceeds remaining payload` };
  }
  const bytes = data.slice(dataStart, dataStart + length);
  const hex = abiCodecs.Hex.encode(bytes);
  if (canonical === "bytes") {
    return { label, type: canonical, value: hex, raw: hex };
  }
  const text = abiCodecs.Utf8.decode(bytes);
  if (text === null) {
    return { label, type: canonical, value: hex, raw: hex, warning: "invalid UTF-8 \u2014 showing raw bytes as hex" };
  }
  return { label, type: canonical, value: text, raw: hex };
}
function abiDecodeElementOffsetRegion(element, data, elementHeadBase, count, depth, label, canonical) {
  const elementCanonical = abiCanonicalType(element);
  const children = [];
  let cursor = elementHeadBase;
  for (let i = 0; i < count; i++) {
    if (abiBudgetExhausted()) {
      children.push({
        label: `[${i}]`,
        type: elementCanonical,
        error: `decode output exceeds ${ABI_MAX_NODES} nodes \u2014 truncated`
      });
      break;
    }
    const offsetWord = abiWordAt(data, cursor);
    if (!offsetWord) {
      children.push({
        label: `[${i}]`,
        type: elementCanonical,
        error: `truncated calldata \u2014 no element offset word at byte ${cursor}`
      });
    } else {
      const offsetValue = abiWordBigEndianValue(offsetWord);
      if (offsetValue > BigInt(Number.MAX_SAFE_INTEGER)) {
        children.push({
          label: `[${i}]`,
          type: elementCanonical,
          error: "element offset exceeds a safe integer \u2014 refusing to follow it"
        });
      } else {
        const elementStart = elementHeadBase + Number(offsetValue);
        if (elementStart < elementHeadBase || elementStart > data.length) {
          children.push({
            label: `[${i}]`,
            type: elementCanonical,
            error: `element offset ${offsetValue.toString()} points outside the payload`
          });
        } else {
          children.push(abiDecodeValue(element, data, elementStart, depth + 1, `[${i}]`));
        }
      }
    }
    cursor += ABI_WORD_BYTES;
  }
  return { label, type: canonical, children };
}
function abiDecodeArray(t, data, base, depth, label) {
  const canonical = abiCanonicalType(t);
  const element = t.element;
  if (!element) return { label, type: canonical, error: "array type missing its element definition" };
  const elementDynamic = abiIsDynamic(element);
  if (t.length !== void 0) {
    if (!elementDynamic) {
      const elementWidth = abiHeadWidth(element);
      if (elementWidth === 0 || base + t.length * elementWidth > data.length) {
        return {
          label,
          type: canonical,
          error: `fixed array length ${t.length} at byte ${base} exceeds remaining payload`
        };
      }
      const children = [];
      let cursor = base;
      for (let i = 0; i < t.length; i++) {
        if (abiBudgetExhausted()) {
          children.push({
            label: `[${i}]`,
            type: abiCanonicalType(element),
            error: `decode output exceeds ${ABI_MAX_NODES} nodes \u2014 truncated`
          });
          break;
        }
        children.push(abiDecodeValue(element, data, cursor, depth + 1, `[${i}]`));
        cursor += elementWidth;
      }
      return { label, type: canonical, children };
    }
    if (base + t.length * ABI_WORD_BYTES > data.length) {
      return {
        label,
        type: canonical,
        error: `fixed array length ${t.length} at byte ${base} exceeds remaining payload`
      };
    }
    return abiDecodeElementOffsetRegion(element, data, base, t.length, depth, label, canonical);
  }
  const lengthWord = abiWordAt(data, base);
  if (!lengthWord) return { label, type: canonical, error: `truncated calldata \u2014 no length word at byte ${base}` };
  const lengthValue = abiWordBigEndianValue(lengthWord);
  if (lengthValue > BigInt(Number.MAX_SAFE_INTEGER)) {
    return { label, type: canonical, error: "array length exceeds a safe integer \u2014 refusing to allocate" };
  }
  const length = Number(lengthValue);
  const elementHeadBase = base + ABI_WORD_BYTES;
  if (length < 0 || elementHeadBase + length * ABI_WORD_BYTES > data.length) {
    return { label, type: canonical, error: `array length ${length} at byte ${base} exceeds remaining payload` };
  }
  if (!elementDynamic) {
    const children = [];
    const elementWidth = abiHeadWidth(element);
    let cursor = elementHeadBase;
    for (let i = 0; i < length; i++) {
      if (abiBudgetExhausted()) {
        children.push({
          label: `[${i}]`,
          type: abiCanonicalType(element),
          error: `decode output exceeds ${ABI_MAX_NODES} nodes \u2014 truncated`
        });
        break;
      }
      children.push(abiDecodeValue(element, data, cursor, depth + 1, `[${i}]`));
      cursor += elementWidth;
    }
    return { label, type: canonical, children };
  }
  return abiDecodeElementOffsetRegion(element, data, elementHeadBase, length, depth, label, canonical);
}
function abiDecodeTuple(t, data, base, depth, label) {
  const canonical = abiCanonicalType(t);
  const children = abiDecodeHeadTailRegion(t.components ?? [], data, base, depth + 1);
  return { label, type: canonical, children };
}
function abiDecodeValue(t, data, base, depth, label) {
  const canonical = abiCanonicalType(t);
  if (depth > ABI_MAX_DEPTH) {
    return { label, type: canonical, error: `nested deeper than ${ABI_MAX_DEPTH} levels \u2014 not decoded` };
  }
  if (abiNodesRemaining <= 0) {
    return { label, type: canonical, error: `decode output exceeds ${ABI_MAX_NODES} nodes \u2014 truncated` };
  }
  abiNodesRemaining--;
  if (t.kind === "tuple") return abiDecodeTuple(t, data, base, depth, label);
  if (t.kind === "array") return abiDecodeArray(t, data, base, depth, label);
  if (canonical === "bytes" || canonical === "string") return abiDecodeDynamic(canonical, data, base, label);
  return abiDecodeStaticElementary(canonical, data, base, label) ?? {
    label,
    type: canonical,
    error: `type "${canonical}" is not decoded`
  };
}
function abiDecodeHeadTailRegion(types, data, regionBase, depth) {
  const nodes = [];
  let headCursor = regionBase;
  for (let i = 0; i < types.length; i++) {
    const t = types[i];
    const label = t.name || `arg${i}`;
    const canonical = abiCanonicalType(t);
    const width = abiHeadWidth(t);
    if (abiIsDynamic(t)) {
      const offsetWord = abiWordAt(data, headCursor);
      if (!offsetWord) {
        nodes.push({ label, type: canonical, error: `truncated calldata \u2014 no offset word at byte ${headCursor}` });
      } else {
        const offsetValue = abiWordBigEndianValue(offsetWord);
        if (offsetValue > BigInt(Number.MAX_SAFE_INTEGER)) {
          nodes.push({
            label,
            type: canonical,
            error: "dynamic offset exceeds a safe integer \u2014 refusing to follow it"
          });
        } else {
          const tailStart = regionBase + Number(offsetValue);
          if (tailStart < regionBase || tailStart > data.length) {
            nodes.push({
              label,
              type: canonical,
              error: `dynamic offset ${offsetValue.toString()} points outside the payload`
            });
          } else {
            nodes.push(abiDecodeValue(t, data, tailStart, depth, label));
          }
        }
      }
    } else {
      nodes.push(abiDecodeValue(t, data, headCursor, depth, label));
    }
    headCursor += width;
  }
  return nodes;
}
function abiDecodeParameters(types, data, base, depth) {
  abiNodesRemaining = ABI_MAX_NODES;
  return abiDecodeHeadTailRegion(types, data, base, depth);
}
const abiModule = {
  parseTypeString: abiParseTypeString,
  parseAbiInputs: abiParseAbiInputs,
  canonicalType: abiCanonicalType,
  canonicalSignature: abiCanonicalSignature,
  decodeParameters: abiDecodeParameters,
  isDynamic: abiIsDynamic,
  headWidth: abiHeadWidth,
  supportedElementary: ABI_SUPPORTED_ELEMENTARY
};
window.DxDecode.abi = abiModule;
