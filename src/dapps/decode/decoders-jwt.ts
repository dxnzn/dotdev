// window.DxDecode's jwt decoder — the third slice of Phase 4, and the one decoder in this
// phase with a real safety dimension rather than only a correctness one. Signature
// verification is an explicit non-goal (handoff §10), so a tidy-looking token must never read
// as one whose signature was checked: the not-verified caution is the root node's existing
// `warning` field (D-05), assigned before any segment is examined, so no return path below can
// reach a caller without it. Loads before decoders-abi-words.js/decoders-url.js/
// decoders-base64.js per manifest.json's more-specific-first ordering (D-03) — its shape
// (exactly three dot-separated base64url segments whose first decodes to a JSON object) is the
// narrowest of the four new decoders this phase adds.
//
// Top-level names in this directory must be unique — every file here is a global ambient
// script (no import, no export — D-08), and tsconfig.decode.json compiles them as ONE program,
// so two files sharing a top-level name collide with TS2451. Every top-level binding in this
// file is prefixed `jwt`, matching decoders-base64.ts's `b64` and decoders-url.ts's `url`
// conventions.
window.DxDecode ??= {};

const jwtCodecs = window.DxDecode.codecs as DxDecodeCodecsModule;
const jwtRegistry = window.DxDecode.registry as DecoderRegistry;
const jwtCore = window.DxDecode.core as DxDecodeCoreModule;

// A real JWT segment is unpadded base64url by RFC 7515 — no `+`, no `/`, no `=`. Deliberately
// narrower than Base64.decode, which accepts both alphabets and tolerates padding by design
// (codecs.ts:107-160) — that generosity is correct for a generic base64 decoder and wrong here:
// a padded or standard-alphabet segment is not a JWT segment, and reporting that is more useful
// than decoding it anyway. RegExp literal, never the constructor — the constructor form is not
// on the portability guard's allowlist.
const JWT_BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

// The three claim names that get a date annotation. A literal, not a computed set — this
// decoder is the only place claim-name knowledge lives (D-07); ui.ts acquires none of it.
const JWT_TIME_CLAIMS = ['exp', 'iat', 'nbf'];

// Worded to name both what was not done and what that means, and checked by hand against
// test/decode-portability.test.ts's NETWORK_IDENTIFIERS/STORAGE_IDENTIFIERS arrays before
// being committed — those scans retain string literals, so a caution containing one of their
// forbidden words (open, href, src, srcset, action, fetch, storage, cookie, caches, among
// others) would fail with a message about transmitting decoded data, a confusing false
// positive that reads as a real leak. No wording here suggests validity, authenticity or
// trust in the other direction either — decoding a token proves nothing about it.
const JWT_NOT_VERIFIED_WARNING =
  'signature not verified — this decoder never checks a signature, so nothing below confirms the token is genuine';

// Synchronous, in order, returning at the first match — canDecode never reaches the network
// (DEC-05) and this curve does not either.
function jwtCanDecode(input: string): number {
  const segments = jwtCodecs.Base64.splitSegments(input);
  if (segments.length !== 3) return 0;

  const [header, payload] = segments;
  if (!JWT_BASE64URL_RE.test(header) || !JWT_BASE64URL_RE.test(payload)) return 0;

  const decoded = jwtCodecs.Base64.decode(header);
  if (!decoded.ok) return 0;

  const text = jwtCodecs.Utf8.decode(decoded.bytes);
  if (text === null) return 0;

  try {
    const parsed = JSON.parse(text);
    return parsed !== null && typeof parsed === 'object' ? 0.9 : 0;
  } catch {
    // A damaged JWT header is still a JWT: the person pasting it wants the error node, not a
    // badge saying the input could not be identified (the same reasoning decoders.ts:37-41
    // gives for hex's odd-length score).
    //
    // The `{` gate below is load-bearing and the cross-AI review is why it exists. Without it,
    // the three-segment base64url shape alone scored here, and that shape is far more common
    // than a JWT: www.example.com, 1.2.3 and foo.bar.baz all split into three segments matching
    // JWT_BASE64URL_RE. Worse, nothing else competes for them — url scores 0 without a `%` or a
    // `://`, base64 scores 0 because `.` is outside its alphabet, hex scores 0 — so a bare
    // hostname resolved to jwt and got a not-verified caution over it. Requiring segment 0 to
    // decode to something that at least begins like a JSON object keeps the damaged-header
    // intent and drops the hostnames.
    return text.trim().startsWith('{') ? 0.6 : 0;
  }
}

// One local helper for both header and payload — its first step is the base64url pattern test,
// before the codec is called at all. This is the cross-AI review's one HIGH finding against
// this plan: Base64.decode deliberately accepts the standard `+/` alphabet and tolerates `=`
// padding, so without this test a manually-selected standard-base64 token decoded cleanly
// while canDecode had already refused the same input — the two enforced different rules about
// the same input. One pattern, tested in both places, is the fix.
function jwtDecodeSegment(segment: string, label: string): DecodeNode {
  if (!JWT_BASE64URL_RE.test(segment)) {
    return {
      label,
      error: 'segment is not base64url — a JWT segment carries no padding and no + or /',
      raw: segment,
    };
  }

  const decoded = jwtCodecs.Base64.decode(segment);
  if (!decoded.ok) {
    return { label, error: decoded.error, raw: segment };
  }

  const text = jwtCodecs.Utf8.decode(decoded.bytes);
  if (text === null) {
    return { label, error: 'segment bytes are not valid UTF-8', raw: segment };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // raw carries the decoded TEXT here, not the original segment — seeing what the segment
    // actually said is the most useful thing available when it will not parse.
    return { label, error: 'segment is not valid JSON', raw: text };
  }

  // D-06's both-ways node, the exact shape decoders-base64.ts established: raw is the
  // pretty-printed clipboard target, children are the walked, per-key addressable rows.
  // Reusing jsonToNode (core.ts, D-04) rather than inventing a second walker is what makes
  // this node indistinguishable from base64's own to the renderer.
  const walked = jwtCore.jsonToNode(label, parsed);
  const node: DecodeNode = { label, display: 'json' };
  // CR-01: jsonToNode's own recursion is bounded (JSON_WALK_MAX_DEPTH), but JSON.stringify on
  // the same parsed value is a SECOND, unbounded recursion — without this guard it throws on
  // pathological nesting, which previously reached the decode service's catch and replaced the
  // whole root node (losing the not-verified warning above). Degrading to a warning here, same
  // choice the walker makes at its cap, keeps the root's caution intact on that path.
  const raw = jwtCore.jsonToRaw(parsed);
  if (raw !== undefined) node.raw = raw;
  else node.warning = 'too deeply nested to pretty-print';
  if (walked.children !== undefined) {
    node.children = walked.children;
  } else {
    node.value = walked.value;
  }
  return node;
}

async function jwtDecode(input: string, _ctx: DecodeContext): Promise<DecodeOutput> {
  // T-04-11: assigned before any segment is examined, so no return path below can reach a
  // caller without it — the not-verified caution is the root node's existing `warning` field,
  // which renderNode already renders (.decode-tree-warning); no element is added to
  // template.html and no member is added to DecodeNode (D-05).
  const root: DecodeNode = {
    label: 'jwt',
    value: null,
    warning: JWT_NOT_VERIFIED_WARNING,
    children: [],
  };

  const segments = jwtCodecs.Base64.splitSegments(input);
  if (segments.length !== 3) {
    // The caution surviving a malformed token is itself a case in the suite.
    root.children = [
      {
        label: 'jwt',
        error: `not a JWT — expected three dot-separated segments, found ${segments.length}`,
        raw: input,
      },
    ];
    return {
      node: root,
      rawBytes: new TextEncoder().encode(input),
      rawView: 'hex-dump',
    };
  }

  const [headerSegment, payloadSegment, signatureSegment] = segments;

  const headerNode = jwtDecodeSegment(headerSegment, 'header');
  const payloadNode = jwtDecodeSegment(payloadSegment, 'payload');

  // Date annotation happens here, in the decoder, never in the renderer — ui.ts has no
  // claim-name knowledge and acquires none (D-07). No expired/not-yet-valid verdict is added:
  // a validity judgement beside an unverified signature would compound T-04-11's risk rather
  // than mitigate it.
  if (payloadNode.children) {
    for (const child of payloadNode.children) {
      if (!JWT_TIME_CLAIMS.includes(child.label)) continue;
      const existing = child.annotations ?? [];
      if (typeof child.value === 'number' && Number.isFinite(child.value)) {
        const formatted = jwtCore.formatUtcDate(child.value);
        // Never push the null, and never push a string assembled from it — an annotation
        // reading as a row of NaN components beside a claim someone is reasoning about is
        // worse than no annotation, because it looks like a date.
        child.annotations = [
          ...existing,
          formatted !== null ? formatted : 'claim value is outside the representable date range',
        ];
      } else {
        child.annotations = [...existing, 'claim is present but is not a number'];
      }
    }
  }

  root.children = [headerNode, payloadNode];

  const signatureAnnotations: string[] = [];
  if (signatureSegment.length === 0) {
    // Reported rather than looking like a rendering bug — an alg: none token's empty
    // signature is a real, valid shape, not a decode failure.
    signatureAnnotations.push('signature segment is empty');
  }
  // splitSegments strips ASCII whitespace before splitting, which is correct — a token pasted
  // out of a terminal or a header dump routinely arrives wrapped, and refusing it would be
  // worse. But it means the displayed signature is the NORMALIZED segment, not byte-for-byte
  // what was pasted, while TXT-04 and handoff §7.5 both say the signature is shown as-is. The
  // normalization stays; what changes is that it is reported instead of silent. segments.join
  // reconstructs exactly the whitespace-stripped form splitSegments produced, so comparing it
  // against the original input needs no second definition of "stripped".
  if (input !== segments.join('.')) {
    signatureAnnotations.push('whitespace was removed from the pasted token before splitting');
  }

  const signatureNode: DecodeNode = {
    label: 'signature',
    value: signatureSegment,
    display: 'text',
    raw: signatureSegment,
  };
  if (signatureAnnotations.length > 0) signatureNode.annotations = signatureAnnotations;
  root.children.push(signatureNode);

  return {
    node: root,
    rawBytes: new TextEncoder().encode(input),
    rawView: 'hex-dump',
  };
}

const jwtDecoder: DecoderPort = {
  id: 'jwt',
  label: 'Jwt',
  settings: [],
  canDecode: jwtCanDecode,
  decode: jwtDecode,
};

// D-05's self-registration — the final statement.
jwtRegistry.register(jwtDecoder);
