// window.DxDecode.codecs — all of COD-06's pure, no-network codecs: Hex, Base64 (both
// alphabets, padding-tolerant) and Utf8 strict validity. Extended from the tracer's thin Hex
// and Utf8 (plan 03-01) to the full set; the namespace guard and the single `codecs` sub-key
// are unchanged.
//
// The uniform property every function in this file holds is the absence of a throw path —
// NOT a uniform return shape. Hex.decode and Base64.decode return a discriminated result
// ({ ok: true, bytes } | { ok: false, error }); Utf8.isValid returns a plain boolean and
// Utf8.decode returns a string or null, because a validity question has no error to report
// beyond its own answer. Where a platform primitive (atob, TextDecoder) can throw, the call is
// wrapped and the throw is converted at the boundary, so no signature here ever exposes one.
// This is what makes DEC-12 hold by construction: there is nothing for a later decoder author
// to forget to catch.
//
// Hex.normalize and Hex/Base64's own whitespace handling are declared here as HexCodec/
// Base64's own top-level functions (not object-literal methods calling `Hex.foo`/`Base64.foo`
// on themselves) deliberately: typing the assembled object against the global HexCodec
// interface would excess-property-check a literal carrying members (normalize, isHexLike)
// that interface does not declare, since types.d.ts is this phase's frozen, single-owner
// contract and this plan does not edit it. Assigning already-typed function values into a
// plain object sidesteps that check entirely — TypeScript only performs excess-property
// checks against a *fresh literal* assigned to a typed target, not against a named value
// structurally compatible with a wider shape.
window.DxDecode ??= {};

// ASCII whitespace only — never a Unicode-aware \s, which would also strip characters (NBSP,
// line/paragraph separators, …) that neither the hex nor the base64 alphabet ever produces and
// whose removal a reader would have no way to predict. Leading, trailing or embedded, in both
// codecs, per the stated whitespace policy: stripped, not rejected. A multi-line paste out of
// a terminal or a block explorer is the ordinary case, not the exotic one — and the platform's
// own base64 primitive already strips ASCII whitespace silently, so leaving this implicit
// would mean "reject anything outside the alphabet" was true of every character except the
// ones nobody thought about.
function stripAsciiWhitespace(input: string): string {
  return input.replace(/[\t\n\v\f\r ]+/g, '');
}

// ── Hex ───────────────────────────────────────────────────────────────────────────────────

function hexStrip0x(input: string): string {
  return /^0x/i.test(input) ? input.slice(2) : input;
}

// The single whitespace-and-prefix entry point. Both `decode` and the hex decoder's
// `canDecode` confidence curve (decoders.ts) route through this — sharing one normalizer is
// the fix for a real defect the review caught: with `decode` stripping whitespace and a
// separate scorer rejecting it, a multi-line hex paste scored zero on the Decode-click
// detection path and the badge said the input could not be identified, about a payload the
// decoder handles perfectly.
function hexNormalize(input: string): string {
  return hexStrip0x(stripAsciiWhitespace(input));
}

// A cheap predicate the decoder's confidence curve uses — true when normalize(input) consists
// only of hex digits (including the empty string; callers that care about non-empty input
// check that separately).
function hexIsHexLike(input: string): boolean {
  return /^[0-9a-fA-F]*$/.test(hexNormalize(input));
}

function hexDecode(input: string): { ok: true; bytes: Uint8Array } | { ok: false; error: string } {
  const normalized = hexNormalize(input);
  if (normalized.length === 0) {
    // An empty string and a bare `0x` prefix both normalize to '' — a defined success with a
    // zero-length byte array, not an error and not a crash.
    return { ok: true, bytes: new Uint8Array(0) };
  }
  if (normalized.length % 2 !== 0) {
    return { ok: false, error: `odd-length hex string — ${normalized.length} digits, cannot decode` };
  }
  const badChar = normalized.match(/[^0-9a-fA-F]/);
  if (badChar) {
    const position = normalized.indexOf(badChar[0]);
    return { ok: false, error: `invalid hex character '${badChar[0]}' at position ${position}` };
  }
  const bytes = new Uint8Array(normalized.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(normalized.slice(i * 2, i * 2 + 2), 16);
  }
  return { ok: true, bytes };
}

function hexEncode(bytes: Uint8Array, options?: { prefix?: boolean }): string {
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return options?.prefix === false ? hex : `0x${hex}`;
}

const Hex = {
  strip0x: hexStrip0x,
  normalize: hexNormalize,
  isHexLike: hexIsHexLike,
  decode: hexDecode,
  encode: hexEncode,
};

// ── Base64 ────────────────────────────────────────────────────────────────────────────────
//
// Order of operations, deliberately in this order: strip ASCII whitespace, reject a string
// mixing both alphabets' distinguishing characters, normalize the URL alphabet's two
// substituted characters back to the standard pair, reject a data length of exactly one past
// a multiple of four (an impossible encoding), reject internal or mismatched padding, then
// re-pad to a multiple of four and decode via the platform's own primitive — but the platform
// primitive is never relied on for validation, because its own leniency (silently accepting
// bad padding, silently truncating) is exactly what this ordering exists to pin down before
// atob ever sees the input.

const BASE64_STANDARD_CHARS = /[+/]/;
const BASE64_URL_CHARS = /[-_]/;
const BASE64_ALPHABET = /^[A-Za-z0-9+/]*$/;

function base64Decode(input: string): { ok: true; bytes: Uint8Array } | { ok: false; error: string } {
  const stripped = stripAsciiWhitespace(input);
  if (stripped.length === 0) {
    return { ok: true, bytes: new Uint8Array(0) };
  }

  const hasStandardChars = BASE64_STANDARD_CHARS.test(stripped);
  const hasUrlChars = BASE64_URL_CHARS.test(stripped);
  if (hasStandardChars && hasUrlChars) {
    return { ok: false, error: 'mixed base64 alphabets — standard and url-safe characters both present' };
  }

  const paddingStart = stripped.indexOf('=');
  const dataPart = paddingStart === -1 ? stripped : stripped.slice(0, paddingStart);
  const paddingPart = paddingStart === -1 ? '' : stripped.slice(paddingStart);

  // Padding is only ever valid as a suffix — '=' anywhere inside dataPart would have been
  // sliced out by paddingStart already; this catches a second run of data AFTER padding
  // began, i.e. padding that is not actually at the very end.
  if (!/^=*$/.test(paddingPart)) {
    return { ok: false, error: 'internal padding — "=" must only appear at the end of the payload' };
  }

  const normalizedData = dataPart.replace(/-/g, '+').replace(/_/g, '/');
  if (!BASE64_ALPHABET.test(normalizedData)) {
    return { ok: false, error: 'invalid base64 character' };
  }

  const remainder = normalizedData.length % 4;
  if (remainder === 1) {
    return { ok: false, error: 'invalid base64 length — one leftover character past a multiple of four' };
  }

  // Padding is tolerant of being ABSENT (the url-alphabet case) but not of being WRONG:
  // present-and-correct or absent are both fine, present-and-mismatched (including the
  // remainder-0 case, where the correct amount is none at all) is rejected outright rather
  // than left to atob's own leniency to decide silently.
  const requiredPadding = (4 - remainder) % 4;
  if (paddingPart.length > 0 && paddingPart.length !== requiredPadding) {
    return { ok: false, error: 'excess padding — "=" count does not match the required amount' };
  }

  const fullyPadded = normalizedData + '='.repeat(requiredPadding);
  try {
    const binary = atob(fullyPadded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return { ok: true, bytes };
  } catch {
    return { ok: false, error: 'invalid base64 encoding' };
  }
}

// Plan 03-06's compressed share link is this function's only consumer this phase — it lives
// in the codec layer because COD-06 says that is where it belongs, not because anything in
// this phase's decoders call it yet.
function base64EncodeUrl(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// 04-03: the base64url segment split, whitespace-tolerant, no throw path — this file's own
// stated invariant (the absence of a throw path) applied to one more primitive. Lives here,
// not in decoders-jwt.ts, per D-04: a whitespace-tolerant split over an alphabet this file
// already owns is a codec primitive, whereas a decoder's own interpretation of what it finds
// belongs to the decoder file (the plan's own <review_disposition> rejects moving this the
// other way for exactly that reason). A JWT pasted out of a terminal or a header dump
// routinely arrives wrapped, so whitespace tolerance here — not just alphabet tolerance in
// base64Decode — is what makes a wrapped token decodable at all.
function base64SplitSegments(input: string): string[] {
  return stripAsciiWhitespace(input).split('.');
}

const Base64 = {
  decode: base64Decode,
  encodeUrl: base64EncodeUrl,
  splitSegments: base64SplitSegments,
};

// ── Utf8 ──────────────────────────────────────────────────────────────────────────────────
//
// Delegated to the platform's own strict, fatal-mode decoder rather than a hand-rolled
// byte-pattern matcher — validity therefore means code-point validity (a lone surrogate, an
// overlong encoding and a truncated multi-byte sequence are each invalid), never a
// grapheme-cluster or normalized-form judgement.

const Utf8 = {
  isValid(bytes: Uint8Array): boolean {
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      return true;
    } catch {
      return false;
    }
  },

  decode(bytes: Uint8Array): string | null {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return null;
    }
  },
};

// ── Percent ───────────────────────────────────────────────────────────────────────────────
//
// 04-02: this file's own stated invariant (the absence of a throw path) applied to one more
// primitive. decodeURIComponent throws a URIError on a malformed escape — a bare '%', a
// trailing '%' with no two hex digits after it, a truncated multi-byte sequence — and the
// throw is converted at this boundary into the failure branch, so no signature here ever
// exposes one. Unlike hexNormalize/stripAsciiWhitespace, this function strips NO whitespace:
// a space is a meaningful character in a percent-encoded string, and removing it would be
// exactly the silent input mutation Phase 3's prohibitions forbid — stripAsciiWhitespace
// exists for the hex/base64 alphabets, which have no such character.
function percentDecode(input: string): { ok: true; value: string } | { ok: false; error: string } {
  try {
    return { ok: true, value: decodeURIComponent(input) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

const Percent = { decode: percentDecode };

window.DxDecode.codecs = { Hex, Base64, Utf8, Percent };
