// window.DxDecode.abi — the head/tail ABI decoder and the signature parser (COD-02/COD-03/
// COD-04). Loads after keccak.js and before core.js (manifest.json) — abi.ts needs no shared
// helper from either at load time itself, but the load order keeps the directory's own
// dependency story (keccak before anything that could eventually need it) simple to state.
//
// D-20: abi.ts upholds codecs.ts's no-throw invariant even though it is a separate module —
// COD-05 IS that invariant restated. A scanner error (malformed signature) or a malformed
// calldata offset/length never throws out of a public function here; each becomes an `error`
// field on the returned node/result instead. Internally, the signature scanner below uses
// exceptions purely as flow control (thrown by nested scan helpers, caught at the two public
// entry points, abiParseTypeString and — indirectly, since it never throws itself —
// abiParseAbiInputs) — nothing here ever lets one escape to a caller.
//
// 05-02: ONE OWNER PER NODE FIELD. Every function below sets only `label`, `type`, `value`,
// `raw`, `children` and, on a failure, `error` or `warning` — NEVER `display`, `annotations`,
// `link`, `linkKind`, `collapsed` or `provenance`. Those six belong to whichever decoder wraps
// this module's output (decoders-eth-calldata.ts today; Phase 6's recursive caller later) —
// D-30's decoder-decides-what-a-value-looks-like rule. This is what keeps 05-06's hover title
// and 03 D-14's click-to-copy reading the exact same `underlyingText(node)`: if this file also
// shortened a value into `value` while a decoder wrote the full one into `raw`, the two
// affordances would have two producers and would drift. Asserted directly in
// test/decode-abi.test.ts.
//
// 05-02: address rendering convention — lowercase hex, no EIP-55 checksum casing. Chosen once,
// here: `abiDecodeStaticElementary`'s `address` branch and every test comparing an address
// value in this plan's own suite compare against the lowercase form.
//
// Top-level names take the `abi` prefix (D-14 — no import/export anywhere in this directory,
// so it compiles as one TS program and every top-level name must be unique across it).
window.DxDecode ??= {};

const abiCodecs = window.DxDecode.codecs as DxDecodeCodecsModule;

const ABI_WORD_BYTES = 32;
// Copies core.ts's JSON_WALK_MAX_DEPTH precedent (D-20/T-05-11) — ABI types can in principle
// nest arbitrarily, and a hostile signature string or a hostile nested tuple/array could
// otherwise stack-overflow the parser or the decoder. Bounds BOTH: abiParseOneType/
// abiParseTypeList's own tuple recursion, and abiDecodeValue's tuple/array recursion.
const ABI_MAX_DEPTH = 32;

// CR-02: the T[] branch below (line ~560) bounds a DYNAMIC array's length word against the
// remaining payload before ever looping — but a FIXED-size array (`T[k]`) loops `t.length`
// times with no such gate, and `t.length` comes from `Number(digits)` in the signature parser
// with no ceiling. A per-array byte bound closes most of that (see abiDecodeArray), but
// nesting `[k][k][k]` shapes can each individually pass a byte bound while multiplying out to
// millions of nodes overall, and a fixed array of a zero-width element (`T[0]`) makes ANY
// byte-length bound vacuous regardless of `t.length`. This is the backstop: a total node
// count across one decodeParameters() call, decremented in abiDecodeValue and checked before
// any further per-element work is attempted.
const ABI_MAX_NODES = 10_000;
// Reset once per top-level decodeParameters() call (abiDecodeParameters is the only public
// entry point — see DxDecodeAbiModule) — never mid-tree, so a budget spent on one argument
// cannot starve a sibling argument's own decode.
let abiNodesRemaining = ABI_MAX_NODES;

// CR-02: called BEFORE each loop iteration in every array-count loop below, never after —
// a byte bound alone still lets a `[k][k][k]` shape whose every level individually fits the
// payload multiply out past the budget, so the loop itself must stop appending children the
// moment the budget is spent rather than spend it and keep iterating anyway (which would still
// allocate one — now-trivial — node per remaining index, defeating the point of a cap).
function abiBudgetExhausted(): boolean {
  return abiNodesRemaining <= 0;
}

// D-19: directional and asymmetric. `uint`/`int` bare aliases normalise to the 256-bit form;
// `address` and `bool` are NEVER rewritten (the spec names them as the selector forms — this is
// the single most likely silent failure D-19 names, so do not "simplify" this table into a
// blanket uintN/int replacement).
const ABI_TYPE_ALIASES: Record<string, string> = {
  uint: 'uint256',
  int: 'int256',
  fixed: 'fixed128x18',
  ufixed: 'ufixed128x18',
};

// D-19/COD-05: the explicit elementary set the parser accepts and the decoder must therefore
// say SOMETHING about — an accepted-but-undecoded type must never fall through to a silently
// empty node. Regex-shaped members (uintN/intN/bytesN/fixedMxN/ufixedMxN) are listed by family
// since they carry a parameter; abiClassifyElementary only ever classifies a token into one of
// these. Dispositions, each stated where implemented: `function` DECODES (24 bytes, nearly free
// to render); `fixedMxN`/`ufixedMxN` ERROR, naming the type (vanishingly rare in real calldata,
// Solidity does not yet emit them) — never a node with no value and no error.
const ABI_SUPPORTED_ELEMENTARY = [
  'uintN',
  'intN',
  'address',
  'bool',
  'bytesN',
  'bytes',
  'string',
  'function',
  'fixedMxN',
  'ufixedMxN',
] as const;

function abiNormalizeAlias(type: string): string {
  return ABI_TYPE_ALIASES[type] ?? type;
}

function abiSkipWs(s: string, pos: number): number {
  let p = pos;
  while (p < s.length && /\s/.test(s[p])) p++;
  return p;
}

// Recognizes exactly the elementary base types Pattern 2's grammar names (uint/int with an
// optional bit width, address, bool, bytes with an optional fixed size, string, function, and
// the fixed/ufixed family) — never `tuple`, which only ever appears in the JSON-ABI form's
// `type` field (D-19), never in a canonical signature string this scanner parses.
function abiClassifyElementary(token: string): TypeNode | undefined {
  let m = /^uint([0-9]*)$/.exec(token);
  if (m) {
    const bits = m[1] ? Number(m[1]) : 256;
    return { kind: 'elementary', type: `uint${bits}`, bits };
  }
  m = /^int([0-9]*)$/.exec(token);
  if (m) {
    const bits = m[1] ? Number(m[1]) : 256;
    return { kind: 'elementary', type: `int${bits}`, bits };
  }
  if (token === 'address') return { kind: 'elementary', type: 'address' };
  if (token === 'bool') return { kind: 'elementary', type: 'bool' };
  m = /^bytes([0-9]*)$/.exec(token);
  if (m) {
    if (m[1]) {
      const size = Number(m[1]);
      return { kind: 'elementary', type: `bytes${size}`, size };
    }
    return { kind: 'elementary', type: 'bytes' };
  }
  if (token === 'string') return { kind: 'elementary', type: 'string' };
  // `function` is a real ABI elementary type (24 bytes, decoded below); `fixed`/`ufixed` are
  // accepted here because D-19's canonicalisation table already normalises the bare forms — the
  // parser must accept every name the canonicaliser and ABI_SUPPORTED_ELEMENTARY both know
  // about, or an accepted-name/decoded-name mismatch reopens the silent-empty-node hole this
  // plan closes.
  if (token === 'function') return { kind: 'elementary', type: 'function' };
  m = /^u?fixed[0-9]+x[0-9]+$/.exec(token);
  if (m) return { kind: 'elementary', type: token };
  if (token === 'fixed' || token === 'ufixed') return { kind: 'elementary', type: token };
  return undefined;
}

// Parses one type starting at `pos`: a tuple `(...)`, or an elementary base type, then zero or
// more greedy `[...]` array suffixes, then strips a trailing argument name and/or data-location
// keyword (memory/calldata/storage) up to the next ',' or ')' — D-19's requirement for a
// hand-typed signature, harmless no-op on an already-canonical one. `depth` counts tuple
// nesting only (array-suffix nesting below is iterative, not recursive, so it costs nothing
// against ABI_MAX_DEPTH) and is checked before ever recursing into a nested `(...)`.
function abiParseOneType(s: string, pos: number, depth: number): { type: TypeNode; nextPos: number } {
  let p = abiSkipWs(s, pos);
  let node: TypeNode;

  if (s[p] === '(') {
    if (depth >= ABI_MAX_DEPTH) {
      throw new Error(`tuple nesting exceeds ${ABI_MAX_DEPTH} levels at position ${p} in "${s}"`);
    }
    const { types: components, nextPos: afterList } = abiParseTypeList(s, p + 1, depth + 1);
    let q = abiSkipWs(s, afterList);
    if (s[q] !== ')') throw new Error(`expected ')' closing a tuple at position ${q} in "${s}"`);
    q++;
    node = { kind: 'tuple', type: `(${components.map(abiCanonicalType).join(',')})`, components };
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

  for (;;) {
    if (s[p] !== '[') break;
    let q = p + 1;
    const start = q;
    while (q < s.length && /[0-9]/.test(s[q])) q++;
    if (s[q] !== ']') throw new Error(`malformed array suffix at position ${p} in "${s}"`);
    const digits = s.slice(start, q);
    // "[0]" is syntactically valid and must not be rejected (a degenerate fixed-size array).
    const length = digits.length > 0 ? Number(digits) : undefined;
    node = {
      kind: 'array',
      type: abiCanonicalType(node) + (digits.length > 0 ? `[${digits}]` : '[]'),
      element: node,
      length,
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

function abiParseTypeList(s: string, pos: number, depth: number): { types: TypeNode[]; nextPos: number } {
  let p = abiSkipWs(s, pos);
  if (s[p] === ')') return { types: [], nextPos: p };

  const types: TypeNode[] = [];
  for (;;) {
    const { type, nextPos } = abiParseOneType(s, p, depth);
    types.push(type);
    p = abiSkipWs(s, nextPos);
    if (s[p] === ',') {
      p = abiSkipWs(s, p + 1);
      continue;
    }
    if (s[p] === ')') return { types, nextPos: p };
    throw new Error(`expected ',' or ')' at position ${p} in "${s}"`);
  }
}

// The one public parser entry point that can fail — a malformed signature returns `{ error }`,
// never a thrown exception (D-20).
function abiParseTypeString(sig: string): { name: string; types: TypeNode[] } | { error: string } {
  try {
    const trimmed = sig.trim();
    const parenIdx = trimmed.indexOf('(');
    if (parenIdx === -1) return { error: `expected '(' in signature "${sig}"` };
    const name = trimmed.slice(0, parenIdx).trim();
    const { types, nextPos } = abiParseTypeList(trimmed, parenIdx + 1, 0);
    const afterList = abiSkipWs(trimmed, nextPos);
    if (trimmed[afterList] !== ')') {
      return { error: `expected ')' closing the argument list in signature "${sig}"` };
    }
    return { name, types };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

// Splits a JSON-ABI `type` string ("uint256[]", "tuple[3]") into its base keyword and its
// bracket suffix, string-only — no live scan position, since this is a second, independent
// front door onto the same TypeNode tree (Pattern 2), not a recursive descent over `sig`.
function abiSplitBaseAndSuffix(typeStr: string): { base: string; suffix: string } {
  const idx = typeStr.indexOf('[');
  return idx === -1 ? { base: typeStr, suffix: '' } : { base: typeStr.slice(0, idx), suffix: typeStr.slice(idx) };
}

function abiApplyArraySuffixString(suffix: string, baseNode: TypeNode): TypeNode {
  if (!suffix) return baseNode;
  let node = baseNode;
  for (const m of suffix.matchAll(/\[([0-9]*)\]/g)) {
    const digits = m[1];
    const length = digits.length > 0 ? Number(digits) : undefined;
    node = {
      kind: 'array',
      type: abiCanonicalType(node) + (digits.length > 0 ? `[${digits}]` : '[]'),
      element: node,
      length,
    };
  }
  return node;
}

// `depth` guards the same hostile-nesting hazard as the string parser's own cap — a JSON-ABI
// `components` array can in principle nest as deep as a signature string can. Past the cap, a
// tuple degrades to a componentless `()` rather than recursing further; never a throw (this
// front door has no error return to report one through).
function abiParseAbiInput(input: AbiInput, depth = 0): TypeNode {
  const { base, suffix } = abiSplitBaseAndSuffix(input.type);
  let node: TypeNode;
  if (base === 'tuple') {
    const components = depth >= ABI_MAX_DEPTH ? [] : abiParseAbiInputs(input.components ?? [], depth + 1);
    node = {
      kind: 'tuple',
      type: `(${components.map(abiCanonicalType).join(',')})`,
      components,
      name: input.name || undefined,
    };
  } else {
    const elementary = abiClassifyElementary(base) ?? { kind: 'elementary', type: base };
    node = { ...elementary, name: input.name || undefined };
  }
  return abiApplyArraySuffixString(suffix, node);
}

// The second front door onto the same TypeNode tree (Pattern 2) — the shape an AbiSourcePort
// returns. Always succeeds structurally: an unrecognized elementary `type` string still becomes
// a node (decode-time dispatch, not this function, is what reports it can't be decoded), which
// is what lets this signature stay a bare `TypeNode[]` rather than a discriminated result.
function abiParseAbiInputs(inputs: AbiInput[], depth = 0): TypeNode[] {
  return inputs.map((input) => abiParseAbiInput(input, depth));
}

// COD-04/D-19: the literal word `tuple` is never hashed — wherever a JSON-ABI type begins with
// `tuple`, this expands it into the parenthesised component list, preserving the array suffix
// verbatim and adjacent (no inserted space: `tuple[]` -> `(...)[]`, never `(...) []`). Pure
// function of the TypeNode tree, independent of how the node was built, so it is the single
// canonicalizer both parser front doors and the decoder's own dispatch share — decode dispatch
// below always matches on THIS string, never on a node's raw, possibly-unnormalised `type`.
function abiCanonicalType(node: TypeNode): string {
  if (node.kind === 'tuple') {
    return `(${(node.components ?? []).map(abiCanonicalType).join(',')})`;
  }
  if (node.kind === 'array') {
    const elementType = node.element ? abiCanonicalType(node.element) : '';
    return elementType + (node.length === undefined ? '[]' : `[${node.length}]`);
  }
  // INVERSION HAZARD (D-19): normalizeAlias only ever touches uint/int/fixed/ufixed — never
  // rewrite `address` to `uint160` or `bool` to `uint8` here. The spec names `address`/`bool`
  // as the selector forms; doing so produces a wrong selector with no error at all.
  return abiNormalizeAlias(node.type);
}

function abiCanonicalSignature(name: string, types: TypeNode[]): string {
  return `${name}(${types.map(abiCanonicalType).join(',')})`;
}

// RESEARCH.md Pattern 1's own dynamic-type list: `bytes`/`string`, a dynamic array (`T[]`), a
// fixed-size array of a dynamic element, and a tuple with any dynamic member.
function abiIsDynamic(node: TypeNode): boolean {
  if (node.kind === 'elementary') {
    return node.type === 'bytes' || node.type === 'string';
  }
  if (node.kind === 'array') {
    if (node.length === undefined) return true;
    return node.element ? abiIsDynamic(node.element) : false;
  }
  if (node.kind === 'tuple') {
    return (node.components ?? []).some(abiIsDynamic);
  }
  return false;
}

// D-19/RESEARCH Pattern 1: 32 for everything except a static fixed array (`length *
// headWidth(element)`) and a static tuple (the sum of its own components' head widths). A
// hardcoded 32-byte stride silently misreads every head slot after the first static
// array/tuple argument — verified against the Solidity spec's own
// `f(uint256,uint32[],bytes10,bytes)` example.
function abiHeadWidth(t: TypeNode): number {
  if (!abiIsDynamic(t)) {
    if (t.kind === 'array' && t.length !== undefined && t.element) {
      return t.length * abiHeadWidth(t.element);
    }
    if (t.kind === 'tuple') {
      return (t.components ?? []).reduce((sum, c) => sum + abiHeadWidth(c), 0);
    }
  }
  return ABI_WORD_BYTES;
}

// COD-05/D-20: bounds-checked BEFORE any slice is taken — a Uint8Array.slice that runs off the
// end returns a short array rather than erroring, so "did the slice come back short" is never
// the check.
function abiWordAt(data: Uint8Array, offset: number): Uint8Array | null {
  if (offset < 0 || offset + ABI_WORD_BYTES > data.length) return null;
  return data.slice(offset, offset + ABI_WORD_BYTES);
}

function abiWordBigEndianValue(word: Uint8Array): bigint {
  let value = 0n;
  for (const b of word) value = (value << 8n) | BigInt(b);
  return value;
}

// RESEARCH Pitfall 2: sign-extend on the FULL 256-bit word before narrowing — a valid encoding
// already sign-extends the whole word regardless of the declared N, so treating the word as a
// plain int256 (sign bit = bit 255) gives the correct signed value for any intN. Not
// range-checked against N bits afterward, by design (RESEARCH assumption A1's sibling): a
// malformed high-order-byte int is rare and not worth an error node for a read-only tool.
function abiToSignedBigInt(word: Uint8Array): bigint {
  const unsigned = abiWordBigEndianValue(word);
  const signBit = 1n << 255n;
  return (unsigned & signBit) === 0n ? unsigned : unsigned - (1n << 256n);
}

// Decodes one STATIC ELEMENTARY value already known to occupy exactly one head word, dispatched
// on `canonical` (abiCanonicalType(t)) — never on a possibly-unnormalised raw `t.type` — so a
// bare "fixed"/"ufixed" token from a hand-typed signature and an explicit "fixed128x18" from
// JSON both resolve to the same disposition. Returns null for anything else (a tuple, an array,
// or a dynamic elementary type) — the caller decides what an unhandled shape means; nothing
// ever falls through to a silent empty node (ABI_SUPPORTED_ELEMENTARY).
function abiDecodeStaticElementary(
  canonical: string,
  data: Uint8Array,
  offset: number,
  label: string,
): DecodeNode | null {
  const word = abiWordAt(data, offset);
  if (!word) {
    return { label, type: canonical, error: `truncated calldata — no word at byte ${offset}` };
  }

  const uintMatch = /^uint([0-9]+)$/.exec(canonical);
  if (uintMatch) {
    const bits = Number(uintMatch[1]);
    const full = abiWordBigEndianValue(word);
    // RESEARCH assumption A1: mask to N bits SILENTLY — a rogue encoder can set the high bits
    // and Solidity itself does not reject this on decode, so this never errors on it.
    const masked = bits >= 256 ? full : full & ((1n << BigInt(bits)) - 1n);
    return { label, type: canonical, value: masked, raw: masked.toString() };
  }

  const intMatch = /^int([0-9]+)$/.exec(canonical);
  if (intMatch) {
    const signed = abiToSignedBigInt(word);
    return { label, type: canonical, value: signed, raw: signed.toString() };
  }

  if (canonical === 'address') {
    // Lowercase hex, no checksum casing — this plan's own stated convention.
    const hex = abiCodecs.Hex.encode(word.slice(12));
    return { label, type: canonical, value: hex, raw: hex };
  }

  if (canonical === 'bool') {
    // RESEARCH assumption A2: any non-zero is true, with a warning when the word is neither
    // exactly 0 nor exactly 1 — informative, never an error.
    const isZero = word.every((b) => b === 0);
    const isOne = word.slice(0, -1).every((b) => b === 0) && word[word.length - 1] === 1;
    const value = !isZero;
    const node: DecodeNode = { label, type: canonical, value: String(value), raw: String(value) };
    if (!isZero && !isOne) {
      node.warning = 'word is neither exactly 0 nor exactly 1 — treated as true per its non-zero value';
    }
    return node;
  }

  const bytesNMatch = /^bytes([0-9]+)$/.exec(canonical);
  if (bytesNMatch) {
    const size = Number(bytesNMatch[1]);
    // Left-aligned, unlike numbers — RESEARCH Pattern 1's own bytesN rule.
    const hex = abiCodecs.Hex.encode(word.slice(0, size));
    return { label, type: canonical, value: hex, raw: hex };
  }

  if (canonical === 'function') {
    // 20-byte address + 4-byte selector, left-aligned in its word, like bytesN — DECODED, not
    // errored: rendering 24 bytes of hex is nearly free (ABI_SUPPORTED_ELEMENTARY disposition).
    const hex = abiCodecs.Hex.encode(word.slice(0, 24));
    return { label, type: canonical, value: hex, raw: hex };
  }

  if (/^u?fixed[0-9]+x[0-9]+$/.test(canonical) || canonical === 'fixed' || canonical === 'ufixed') {
    // fixed/ufixed are vanishingly rare in real calldata and Solidity does not yet emit them —
    // an error node naming the type is the defensible choice (ABI_SUPPORTED_ELEMENTARY
    // disposition), never a silent empty node.
    return { label, type: canonical, error: `fixed-point type "${canonical}" is not decoded` };
  }

  return null;
}

// `bytes`/`string` tail layout: one length word (in BYTES, not words), then the data
// right-padded to a multiple of 32 — RESEARCH.md Pattern 1. `base` is always already the tail
// start; this elementary kind is always dynamic, so a caller always resolved an offset first.
function abiDecodeDynamic(canonical: string, data: Uint8Array, base: number, label: string): DecodeNode {
  const lengthWord = abiWordAt(data, base);
  if (!lengthWord) return { label, type: canonical, error: `truncated calldata — no length word at byte ${base}` };

  const lengthValue = abiWordBigEndianValue(lengthWord);
  if (lengthValue > BigInt(Number.MAX_SAFE_INTEGER)) {
    return { label, type: canonical, error: 'dynamic length exceeds a safe integer — refusing to allocate' };
  }
  const length = Number(lengthValue);
  const dataStart = base + ABI_WORD_BYTES;
  // Bounds-checked BEFORE any slice — a Uint8Array.slice past the end silently truncates rather
  // than erroring (COD-05/D-20), so this check, not the slice result, is the real gate.
  if (length < 0 || dataStart + length > data.length) {
    return { label, type: canonical, error: `dynamic length ${length} at byte ${base} exceeds remaining payload` };
  }

  const bytes = data.slice(dataStart, dataStart + length);
  const hex = abiCodecs.Hex.encode(bytes);
  if (canonical === 'bytes') {
    return { label, type: canonical, value: hex, raw: hex };
  }

  // string: codecs.Utf8.decode, never reimplemented here (Don't Hand-Roll) — invalid UTF-8
  // returns the raw bytes (as hex) with a warning, never a throw (D-20's project-wide
  // invariant, inherited from codecs.ts).
  const text = abiCodecs.Utf8.decode(bytes);
  if (text === null) {
    return { label, type: canonical, value: hex, raw: hex, warning: 'invalid UTF-8 — showing raw bytes as hex' };
  }
  return { label, type: canonical, value: text, raw: hex };
}

// Reads `count` offset-word slots starting at `elementHeadBase`, each resolved RELATIVE TO
// THAT POSITION — never to any enclosing tuple/array/argument-list base — and decodes the
// value each one resolves to. Shared by T[k]-of-dynamic-T (no length word: elementHeadBase is
// the array's own tail start) and T[]-of-dynamic-T (elementHeadBase is the tail start PLUS one
// word, skipping the length word) — the only difference between those two callers is how
// `elementHeadBase` and `count` were computed; see abiDecodeArray.
function abiDecodeElementOffsetRegion(
  element: TypeNode,
  data: Uint8Array,
  elementHeadBase: number,
  count: number,
  depth: number,
  label: string,
  canonical: string,
): DecodeNode {
  const elementCanonical = abiCanonicalType(element);
  const children: DecodeNode[] = [];
  let cursor = elementHeadBase;

  for (let i = 0; i < count; i++) {
    if (abiBudgetExhausted()) {
      children.push({
        label: `[${i}]`,
        type: elementCanonical,
        error: `decode output exceeds ${ABI_MAX_NODES} nodes — truncated`,
      });
      break;
    }
    const offsetWord = abiWordAt(data, cursor);
    if (!offsetWord) {
      children.push({
        label: `[${i}]`,
        type: elementCanonical,
        error: `truncated calldata — no element offset word at byte ${cursor}`,
      });
    } else {
      const offsetValue = abiWordBigEndianValue(offsetWord);
      if (offsetValue > BigInt(Number.MAX_SAFE_INTEGER)) {
        children.push({
          label: `[${i}]`,
          type: elementCanonical,
          error: 'element offset exceeds a safe integer — refusing to follow it',
        });
      } else {
        // Relative to elementHeadBase — NOT to the length word, and NOT to the enclosing
        // tuple/array — the off-by-one-word hazard RESEARCH.md and this function's own header
        // name explicitly.
        const elementStart = elementHeadBase + Number(offsetValue);
        if (elementStart < elementHeadBase || elementStart > data.length) {
          children.push({
            label: `[${i}]`,
            type: elementCanonical,
            error: `element offset ${offsetValue.toString()} points outside the payload`,
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

// RESEARCH.md Pattern 1's four array shapes. `base` is the position this value's OWN
// representation begins: for `T[k]` with T static (the array is static as a whole, RESEARCH
// Pattern 1), that is the inline head position; for every other shape (`T[k]` with T dynamic,
// or any `T[]`) the array itself is dynamic and `base` is the tail start abiDecodeValue's
// caller already resolved from an offset word.
function abiDecodeArray(t: TypeNode, data: Uint8Array, base: number, depth: number, label: string): DecodeNode {
  const canonical = abiCanonicalType(t);
  const element = t.element;
  if (!element) return { label, type: canonical, error: 'array type missing its element definition' };

  const elementDynamic = abiIsDynamic(element);

  if (t.length !== undefined) {
    if (!elementDynamic) {
      // T[k], T static: k head-shaped slots inline, no offset.
      const elementWidth = abiHeadWidth(element);
      // CR-02: bounds-checked BEFORE any allocation or loop, mirroring the T[] length gate
      // below — `t.length` comes from `Number(digits)` in the signature parser with no
      // ceiling, and is reachable from an unauthenticated registry response (only a 4-byte
      // selector match is checked) or, from Phase 6, a JSON ABI. `elementWidth === 0` (a
      // fixed array of a zero-width static element, e.g. `T[0]`) makes ANY byte-length bound
      // vacuous — `t.length * 0` is always `0` — so it is rejected outright rather than
      // treated as "fits in zero bytes".
      if (elementWidth === 0 || base + t.length * elementWidth > data.length) {
        return {
          label,
          type: canonical,
          error: `fixed array length ${t.length} at byte ${base} exceeds remaining payload`,
        };
      }
      const children: DecodeNode[] = [];
      let cursor = base;
      for (let i = 0; i < t.length; i++) {
        if (abiBudgetExhausted()) {
          children.push({
            label: `[${i}]`,
            type: abiCanonicalType(element),
            error: `decode output exceeds ${ABI_MAX_NODES} nodes — truncated`,
          });
          break;
        }
        children.push(abiDecodeValue(element, data, cursor, depth + 1, `[${i}]`));
        cursor += elementWidth;
      }
      return { label, type: canonical, children };
    }
    // T[k], T dynamic: `base` is this array's own tail region (no length word — the size is
    // fixed) holding k element-offset slots directly, each relative to THAT region's own start.
    // CR-02: each slot is one offset WORD (ABI_WORD_BYTES), regardless of the dynamic
    // element's own eventual size — bound `t.length` against that before ever looping, same
    // reasoning as the static branch above.
    if (base + t.length * ABI_WORD_BYTES > data.length) {
      return {
        label,
        type: canonical,
        error: `fixed array length ${t.length} at byte ${base} exceeds remaining payload`,
      };
    }
    return abiDecodeElementOffsetRegion(element, data, base, t.length, depth, label, canonical);
  }

  // T[]: `base` is this array's own tail region — a length word, then either k inline static
  // elements or an element-offset region, per whether T is dynamic.
  const lengthWord = abiWordAt(data, base);
  if (!lengthWord) return { label, type: canonical, error: `truncated calldata — no length word at byte ${base}` };
  const lengthValue = abiWordBigEndianValue(lengthWord);
  if (lengthValue > BigInt(Number.MAX_SAFE_INTEGER)) {
    return { label, type: canonical, error: 'array length exceeds a safe integer — refusing to allocate' };
  }
  const length = Number(lengthValue);
  const elementHeadBase = base + ABI_WORD_BYTES;
  // Bounds-checked BEFORE any allocation or loop of any kind — a plausible-but-huge length
  // (e.g. 2^40) must fail HERE, not after an Array(length) or an unbounded loop is attempted.
  if (length < 0 || elementHeadBase + length * ABI_WORD_BYTES > data.length) {
    return { label, type: canonical, error: `array length ${length} at byte ${base} exceeds remaining payload` };
  }

  if (!elementDynamic) {
    const children: DecodeNode[] = [];
    const elementWidth = abiHeadWidth(element);
    let cursor = elementHeadBase;
    for (let i = 0; i < length; i++) {
      // CR-02: same total-node backstop as the fixed-length branches above — a dynamic-length
      // `T[]` of a static, itself-nested element (e.g. `uint256[2][]`) can still multiply out
      // past the budget across depths even though this particular loop's own count is already
      // byte-bounded above.
      if (abiBudgetExhausted()) {
        children.push({
          label: `[${i}]`,
          type: abiCanonicalType(element),
          error: `decode output exceeds ${ABI_MAX_NODES} nodes — truncated`,
        });
        break;
      }
      children.push(abiDecodeValue(element, data, cursor, depth + 1, `[${i}]`));
      cursor += elementWidth;
    }
    return { label, type: canonical, children };
  }

  // T[] of dynamic T (e.g. bytes[]): element offsets are relative to elementHeadBase — the
  // byte AFTER the length word — never to `base` itself (which still points at the length
  // word) and never to the enclosing tuple/argument list.
  return abiDecodeElementOffsetRegion(element, data, elementHeadBase, length, depth, label, canonical);
}

function abiDecodeTuple(t: TypeNode, data: Uint8Array, base: number, depth: number, label: string): DecodeNode {
  const canonical = abiCanonicalType(t);
  const children = abiDecodeHeadTailRegion(t.components ?? [], data, base, depth + 1);
  return { label, type: canonical, children };
}

// Decodes ONE value of type `t` whose own representation begins at `base` — inline head bytes
// for a static value, an already-resolved tail start for a dynamic one; the caller
// (abiDecodeHeadTailRegion / abiDecodeArray) is the only place that distinguishes those two
// cases, so from here on the dispatch is uniform regardless of how `base` was derived.
// `depth` counts tuple/array nesting only — copies core.ts's JSON_WALK_MAX_DEPTH pattern
// (T-05-11): exceeding ABI_MAX_DEPTH returns an error node rather than recursing further.
function abiDecodeValue(t: TypeNode, data: Uint8Array, base: number, depth: number, label: string): DecodeNode {
  const canonical = abiCanonicalType(t);
  if (depth > ABI_MAX_DEPTH) {
    return { label, type: canonical, error: `nested deeper than ${ABI_MAX_DEPTH} levels — not decoded` };
  }
  // CR-02: checked BEFORE any further dispatch — an exhausted budget must not recurse into
  // another array/tuple's own loop, or the multiplicative nested-array hazard this exists to
  // stop would just resume one level down.
  if (abiNodesRemaining <= 0) {
    return { label, type: canonical, error: `decode output exceeds ${ABI_MAX_NODES} nodes — truncated` };
  }
  abiNodesRemaining--;
  if (t.kind === 'tuple') return abiDecodeTuple(t, data, base, depth, label);
  if (t.kind === 'array') return abiDecodeArray(t, data, base, depth, label);
  if (canonical === 'bytes' || canonical === 'string') return abiDecodeDynamic(canonical, data, base, label);
  return (
    abiDecodeStaticElementary(canonical, data, base, label) ?? {
      label,
      type: canonical,
      error: `type "${canonical}" is not decoded`,
    }
  );
}

// The head/tail interpreter (RESEARCH.md Pattern 1), used for the top-level argument list AND
// recursively for every tuple's own members — a tuple's body IS a head/tail region with its own
// base. `regionBase` is THIS region's own start; an offset in a dynamic member's head slot is
// relative to it, never to the calldata start (RESEARCH Pitfall 1) and never to any enclosing
// region.
function abiDecodeHeadTailRegion(types: TypeNode[], data: Uint8Array, regionBase: number, depth: number): DecodeNode[] {
  const nodes: DecodeNode[] = [];
  let headCursor = regionBase;

  for (let i = 0; i < types.length; i++) {
    const t = types[i];
    const label = t.name || `arg${i}`;
    const canonical = abiCanonicalType(t);
    const width = abiHeadWidth(t);

    if (abiIsDynamic(t)) {
      const offsetWord = abiWordAt(data, headCursor);
      if (!offsetWord) {
        nodes.push({ label, type: canonical, error: `truncated calldata — no offset word at byte ${headCursor}` });
      } else {
        const offsetValue = abiWordBigEndianValue(offsetWord);
        if (offsetValue > BigInt(Number.MAX_SAFE_INTEGER)) {
          nodes.push({
            label,
            type: canonical,
            error: 'dynamic offset exceeds a safe integer — refusing to follow it',
          });
        } else {
          const tailStart = regionBase + Number(offsetValue);
          if (tailStart < regionBase || tailStart > data.length) {
            nodes.push({
              label,
              type: canonical,
              error: `dynamic offset ${offsetValue.toString()} points outside the payload`,
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

function abiDecodeParameters(types: TypeNode[], data: Uint8Array, base: number, depth: number): DecodeNode[] {
  // CR-02: the one public entry point (DxDecodeAbiModule.decodeParameters) — reset the node
  // budget HERE, once per call, never inside the recursive tree itself, so a budget spent
  // decoding one top-level argument cannot starve a sibling argument's own decode.
  abiNodesRemaining = ABI_MAX_NODES;
  return abiDecodeHeadTailRegion(types, data, base, depth);
}

// supportedElementary is documentation data (ABI_SUPPORTED_ELEMENTARY), not part of the frozen
// DxDecodeAbiModule contract — attached via a named variable rather than a fresh literal typed
// against the interface, so it is not excess-property-checked (signatures.ts's own established
// pattern for a runtime member the frozen contract does not need to name). TypeScript still
// checks every REQUIRED member of DxDecodeAbiModule is present at the assignment below —
// freshness only suppresses the EXCESS-property check, never the missing-property one.
const abiModule = {
  parseTypeString: abiParseTypeString,
  parseAbiInputs: abiParseAbiInputs,
  canonicalType: abiCanonicalType,
  canonicalSignature: abiCanonicalSignature,
  decodeParameters: abiDecodeParameters,
  isDynamic: abiIsDynamic,
  headWidth: abiHeadWidth,
  supportedElementary: ABI_SUPPORTED_ELEMENTARY,
};

window.DxDecode.abi = abiModule;
