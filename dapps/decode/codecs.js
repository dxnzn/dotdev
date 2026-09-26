window.DxDecode ??= {};
function stripAsciiWhitespace(input) {
  return input.replace(/[\t\n\v\f\r ]+/g, "");
}
function hexStrip0x(input) {
  return /^0x/i.test(input) ? input.slice(2) : input;
}
function hexNormalize(input) {
  return hexStrip0x(stripAsciiWhitespace(input));
}
function hexIsHexLike(input) {
  return /^[0-9a-fA-F]*$/.test(hexNormalize(input));
}
function hexDecode(input) {
  const normalized = hexNormalize(input);
  if (normalized.length === 0) {
    return { ok: true, bytes: new Uint8Array(0) };
  }
  if (normalized.length % 2 !== 0) {
    return { ok: false, error: `odd-length hex string \u2014 ${normalized.length} digits, cannot decode` };
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
function hexEncode(bytes, options) {
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return options?.prefix === false ? hex : `0x${hex}`;
}
const Hex = {
  strip0x: hexStrip0x,
  normalize: hexNormalize,
  isHexLike: hexIsHexLike,
  decode: hexDecode,
  encode: hexEncode
};
const BASE64_STANDARD_CHARS = /[+/]/;
const BASE64_URL_CHARS = /[-_]/;
const BASE64_ALPHABET = /^[A-Za-z0-9+/]*$/;
function base64Decode(input) {
  const stripped = stripAsciiWhitespace(input);
  if (stripped.length === 0) {
    return { ok: true, bytes: new Uint8Array(0) };
  }
  const hasStandardChars = BASE64_STANDARD_CHARS.test(stripped);
  const hasUrlChars = BASE64_URL_CHARS.test(stripped);
  if (hasStandardChars && hasUrlChars) {
    return { ok: false, error: "mixed base64 alphabets \u2014 standard and url-safe characters both present" };
  }
  const paddingStart = stripped.indexOf("=");
  const dataPart = paddingStart === -1 ? stripped : stripped.slice(0, paddingStart);
  const paddingPart = paddingStart === -1 ? "" : stripped.slice(paddingStart);
  if (!/^=*$/.test(paddingPart)) {
    return { ok: false, error: 'internal padding \u2014 "=" must only appear at the end of the payload' };
  }
  const normalizedData = dataPart.replace(/-/g, "+").replace(/_/g, "/");
  if (!BASE64_ALPHABET.test(normalizedData)) {
    return { ok: false, error: "invalid base64 character" };
  }
  const remainder = normalizedData.length % 4;
  if (remainder === 1) {
    return { ok: false, error: "invalid base64 length \u2014 one leftover character past a multiple of four" };
  }
  const requiredPadding = (4 - remainder) % 4;
  if (paddingPart.length > 0 && paddingPart.length !== requiredPadding) {
    return { ok: false, error: 'excess padding \u2014 "=" count does not match the required amount' };
  }
  const fullyPadded = normalizedData + "=".repeat(requiredPadding);
  try {
    const binary = atob(fullyPadded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return { ok: true, bytes };
  } catch {
    return { ok: false, error: "invalid base64 encoding" };
  }
}
function base64EncodeUrl(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function base64SplitSegments(input) {
  return stripAsciiWhitespace(input).split(".");
}
const Base64 = {
  decode: base64Decode,
  encodeUrl: base64EncodeUrl,
  splitSegments: base64SplitSegments
};
const Utf8 = {
  isValid(bytes) {
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      return true;
    } catch {
      return false;
    }
  },
  decode(bytes) {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return null;
    }
  }
};
function percentDecode(input) {
  try {
    return { ok: true, value: decodeURIComponent(input) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
const Percent = { decode: percentDecode };
window.DxDecode.codecs = { Hex, Base64, Utf8, Percent };
