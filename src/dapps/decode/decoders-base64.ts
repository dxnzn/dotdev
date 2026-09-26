// window.DxDecode's base64 decoder — the tracer for Phase 4: proves adding a second decoder
// costs the three touchpoints README.md promises (one new file, one manifest line, one tsup
// line), and proves it on the thinnest real second decoder — COD-06 already ships
// Base64.decode/Utf8.decode, so this file writes no new byte-level codec at all. Loads after
// decoders.ts, before ui.ts, per manifest dependencies.
//
// Top-level names in this directory must be unique — every file here is a global ambient
// script (no import, no export — D-08), and tsconfig.decode.json compiles them as ONE
// program, so two files sharing a top-level name collide with TS2451. decoders.ts already
// owns codecs, registry, core, canDecode, decode, ODD_LENGTH_MARGIN, hexDecoder — this file
// prefixes every top-level binding with `b64` instead, and avoids `base64Decode` specifically
// since codecs.ts already declares a top-level function with that exact name.
window.DxDecode ??= {};

const b64Codecs = window.DxDecode.codecs as DxDecodeCodecsModule;
const b64Registry = window.DxDecode.registry as DecoderRegistry;
const b64Core = window.DxDecode.core as DxDecodeCoreModule;

// D-04: core.ts is jsonToNode's home — a function returning DecodeNodes is not a codec, and
// both this decoder and plan 04-03's jwt decoder need it. Attaching it to one decoder file and
// reading it from another would create a load-order dependency BETWEEN decoder files, breaking
// D-05's "one new file, no central list" story.
//
// D-10/positive-evidence rule: codec ACCEPTANCE of an input is not evidence it was intended as
// base64. codecs.ts:112 strips ASCII whitespace before any alphabet check, so an ordinary
// sentence of letters ("not hex at all", "hello world", "hellohello") becomes a run of
// characters inside /^[A-Za-z0-9+/]*$/ with no padding to mismatch — Base64.decode returns its
// SUCCESS branch for all three. A curve that scored on acceptance alone would put a Base64
// badge over text a person meant as text, and would turn the Phase 3 WR-04 case
// (test/decode-ui.test.ts:685) red. Require positive evidence of encoding instead: padding, a
// distinguishing alphabet character, or bytes that decode to valid UTF-8. Accepted cost: an
// unpadded, alphabet-ambiguous payload of binary data that is not valid UTF-8 scores 0 and
// needs manual selection — a real, deliberate false negative, strictly preferable to the false
// positive it replaces.
function b64CanDecode(input: string): number {
  const stripped = input.replace(/[\t\n\v\f\r ]+/g, '');
  if (stripped.length === 0) return 0;

  // D-10: a bare even-length string like `deadbeef` is valid in both alphabets and is
  // overwhelmingly more likely to be intended as hex. Scoring 0 (not "something below 0.6") is
  // the stronger form of the rule the suite asserts.
  if (b64Codecs.Hex.isHexLike(input)) return 0;

  const result = b64Codecs.Base64.decode(input);
  if (!result.ok) return 0;

  const hasPadding = stripped.endsWith('=');
  const hasDistinctChar = /[+/\-_]/.test(stripped);
  const decodesToText = result.bytes.length > 0 && b64Codecs.Utf8.isValid(result.bytes);

  if (!hasPadding && !hasDistinctChar && !decodesToText) return 0;

  if (decodesToText) {
    const text = b64Codecs.Utf8.decode(result.bytes);
    if (text !== null) {
      try {
        JSON.parse(text);
        return 0.85;
      } catch {
        // not JSON — falls through to the plain decodesToText score below
      }
    }
    return 0.8;
  }

  return 0.7;
}

// core.ts's jsonToNode home: a recursive JSON-to-DecodeNode walker bounded at
// JSON_WALK_MAX_DEPTH so a deeply nested attacker-controlled payload produces a truncated tree
// rather than a stack overflow — the decoder's own never-rejects claim holds without relying
// on the decode service's own catch at core.ts:181-186.
async function b64Decode(input: string, _ctx: DecodeContext): Promise<DecodeOutput> {
  const result = b64Codecs.Base64.decode(input);
  if (!result.ok) {
    // DEC-12's concrete instance: malformed input becomes a returned error node, never a
    // thrown exception or a rejected promise — reachable by construction, since the codec has
    // no throw branch.
    return {
      node: { label: 'base64', error: result.error, raw: input },
      rawBytes: null,
    };
  }

  const { bytes } = result;
  const children: DecodeNode[] = [
    { label: 'byte length', value: bytes.length, display: 'int', raw: String(bytes.length) },
  ];

  let rootRaw: string;
  const text = b64Codecs.Utf8.decode(bytes);
  let annotations: string[] | undefined;

  if (text === null) {
    // TXT-01's "otherwise hex" branch — present either way, following decoders.ts:63-70's
    // rule: an omitted child would leave a reader unable to tell a failed check from a check
    // that never ran.
    const hexEncoded = b64Codecs.Hex.encode(bytes);
    children.push({
      label: 'hex',
      value: null,
      display: 'hex',
      raw: hexEncoded,
      warning: 'bytes are not valid UTF-8 — shown as hex',
    });
    rootRaw = hexEncoded;
  } else {
    children.push({ label: 'text', value: text, display: 'text', raw: text });
    rootRaw = text;

    let parsed: unknown;
    let parses = true;
    try {
      parsed = JSON.parse(text);
    } catch {
      parses = false;
    }

    if (parses) {
      // D-06: both-ways — `raw` is the pretty-printed clipboard target, `children` are the
      // walked, per-key addressable rows. Neither substitutes for the other:
      // .decode-tree-value sets no white-space rule, so a pretty-printed string rendered as a
      // flat value collapses onto one line on screen; `raw` is still correct for the
      // clipboard (03 D-14).
      const walked = b64Core.jsonToNode('json', parsed);
      const jsonNode: DecodeNode = { label: 'json', display: 'json' };
      // CR-01: jsonToNode's own recursion is bounded (JSON_WALK_MAX_DEPTH), but JSON.stringify
      // on the same parsed value is a SECOND, unbounded recursion — without this guard it
      // reintroduces the RangeError the walker's cap exists to remove, breaking this decoder's
      // never-rejects claim. Degrade to a warning, same choice the walker makes at its cap.
      const raw = b64Core.jsonToRaw(parsed);
      if (raw !== undefined) jsonNode.raw = raw;
      else jsonNode.warning = 'too deeply nested to pretty-print';
      if (walked.children !== undefined) {
        jsonNode.children = walked.children;
      } else {
        jsonNode.value = walked.value;
      }
      children.push(jsonNode);
    } else {
      const trimmed = text.trim();
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        annotations = ['looks like JSON but did not parse'];
      }
    }
  }

  const node: DecodeNode = {
    label: 'base64',
    type: 'bytes',
    value: null,
    raw: rootRaw,
    children,
  };
  if (annotations) node.annotations = annotations;

  return {
    node,
    rawBytes: bytes,
    rawView: 'hex-dump',
  };
}

const base64Decoder: DecoderPort = {
  id: 'base64',
  label: 'Base64',
  settings: [],
  canDecode: b64CanDecode,
  decode: b64Decode,
};

// D-05's self-registration — the final statement.
b64Registry.register(base64Decoder);
