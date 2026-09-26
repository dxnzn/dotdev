// window.DxDecode's hex decoder — deliberately the simplest possible real decoder. It exists
// to prove the contracts (D-05's self-registration, the DecodeOutput shape, DEC-12's
// never-throw guarantee), not to be impressive. Loads third, after core.ts creates the
// registry this file's final statement calls into.
window.DxDecode ??= {};

// WR-02: HexCodec (types.d.ts) now declares normalize/isHexLike directly — the local extension
// that used to live here was a global ambient declaration the moment it was written (D-08), not
// actually confined to this file, and has been folded into the single-owner contract instead.
const codecs = window.DxDecode.codecs as DxDecodeCodecsModule;
const registry = window.DxDecode.registry as DecoderRegistry;
const core = window.DxDecode.core as DxDecodeCoreModule;

// A malformed hex payload should still score above the auto-detect threshold — see
// canDecode() below for why. Read live off core.ts's own constant rather than restating its
// number, so a later change to the threshold can't silently drop this back under it.
const ODD_LENGTH_MARGIN = 0.05;

// A simple curve, Claude's discretion per CONTEXT.md. Normalize first — the scorer's first
// move is codecs.Hex.normalize, the exact call decode() makes. This is not a refinement; it
// is the fix for a defect the review caught: with the scorer rejecting any non-hex character
// while decode() stripped whitespace, a multi-line hex paste scored zero and D-24's
// Decode-click trigger scores the raw textarea, so the badge would have said "couldn't
// identify this input" about a payload the hex decoder decodes perfectly.
function canDecode(input: string): number {
  if (!codecs.Hex.isHexLike(input)) return 0;
  const normalized = codecs.Hex.normalize(input);
  if (normalized.length === 0) return 0;

  if (normalized.length % 2 === 0) {
    // Prefixed even-length hex scores highest; bare even-length hex scores lower, since a
    // bare even-length string is genuinely ambiguous with base64 and will compete in Phase 4.
    const strippedOfWhitespace = input.replace(/[\t\n\v\f\r ]+/g, '');
    return /^0x/i.test(strippedOfWhitespace) ? 0.9 : 0.6;
  }

  // Odd-length-but-otherwise-hex scores deliberately ABOVE the auto-detect threshold rather
  // than below it: a malformed hex payload should resolve to the hex decoder and render the
  // error node (DEC-12), not fall through to the badge saying the input could not be
  // identified.
  return Math.min(1, core.AUTO_DETECT_THRESHOLD + ODD_LENGTH_MARGIN);
}

async function decode(input: string, _ctx: DecodeContext): Promise<DecodeOutput> {
  const result = codecs.Hex.decode(input);
  if (!result.ok) {
    // DEC-12's concrete instance: malformed input becomes a returned error node, never a
    // thrown exception or a rejected promise — reachable by construction, since the codec
    // this calls has no throw branch to begin with.
    return {
      node: { label: 'hex', error: result.error, raw: input },
      rawBytes: null,
    };
  }

  const { bytes } = result;
  const normalized = codecs.Hex.normalize(input);

  const children: DecodeNode[] = [
    { label: 'byte length', value: bytes.length, display: 'int', raw: String(bytes.length) },
  ];

  // Present either way — omitting this child on invalid UTF-8 would leave a reader unable to
  // tell a failed check from a check that never ran.
  const utf8 = codecs.Utf8.decode(bytes);
  if (utf8 !== null) {
    children.push({ label: 'utf8', value: utf8, display: 'text', raw: utf8 });
  } else {
    children.push({ label: 'utf8', warning: 'bytes are not valid UTF-8' });
  }

  const node: DecodeNode = {
    label: 'hex',
    type: 'bytes',
    value: null,
    raw: `0x${normalized}`,
    children,
  };

  if (bytes.length <= 32) {
    // D-02: a real bigint per the published contract — not a lossy number, not a
    // pre-formatted string. `raw` carries the decimal string so copy/display need no
    // serializer. BigInt('0x') throws on an empty hex digit string, so the zero-byte case is
    // its own branch rather than falling through to the template literal.
    const intValue = bytes.length === 0 ? 0n : BigInt(`0x${codecs.Hex.encode(bytes, { prefix: false })}`);
    children.push({ label: 'int', value: intValue, display: 'int', raw: intValue.toString() });
  } else {
    // An unexplained absence is the failure mode to avoid — state the omission on the root
    // rather than silently dropping the integer child.
    node.annotations = ['integer omitted — payload exceeds the 32-byte limit'];
  }

  return {
    node,
    rawBytes: bytes,
    rawView: 'hex-dump',
  };
}

const hexDecoder: DecoderPort = {
  id: 'hex',
  label: 'Hex',
  settings: [],
  canDecode,
  decode,
};

// D-05's self-registration — the final statement, and what makes DEC-15's "how to add a
// decoder" story true: one new file, one manifest line, one tsup.config.ts entry.
registry.register(hexDecoder);
