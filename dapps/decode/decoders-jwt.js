window.DxDecode ??= {};
const jwtCodecs = window.DxDecode.codecs;
const jwtRegistry = window.DxDecode.registry;
const jwtCore = window.DxDecode.core;
const JWT_BASE64URL_RE = /^[A-Za-z0-9_-]+$/;
const JWT_TIME_CLAIMS = ["exp", "iat", "nbf"];
const JWT_NOT_VERIFIED_WARNING = "signature not verified \u2014 this decoder never checks a signature, so nothing below confirms the token is genuine";
function jwtCanDecode(input) {
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
    return parsed !== null && typeof parsed === "object" ? 0.9 : 0;
  } catch {
    return text.trim().startsWith("{") ? 0.6 : 0;
  }
}
function jwtDecodeSegment(segment, label) {
  if (!JWT_BASE64URL_RE.test(segment)) {
    return {
      label,
      error: "segment is not base64url \u2014 a JWT segment carries no padding and no + or /",
      raw: segment
    };
  }
  const decoded = jwtCodecs.Base64.decode(segment);
  if (!decoded.ok) {
    return { label, error: decoded.error, raw: segment };
  }
  const text = jwtCodecs.Utf8.decode(decoded.bytes);
  if (text === null) {
    return { label, error: "segment bytes are not valid UTF-8", raw: segment };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { label, error: "segment is not valid JSON", raw: text };
  }
  const walked = jwtCore.jsonToNode(label, parsed);
  const node = { label, display: "json" };
  const raw = jwtCore.jsonToRaw(parsed);
  if (raw !== void 0) node.raw = raw;
  else node.warning = "too deeply nested to pretty-print";
  if (walked.children !== void 0) {
    node.children = walked.children;
  } else {
    node.value = walked.value;
  }
  return node;
}
async function jwtDecode(input, _ctx) {
  const root = {
    label: "jwt",
    value: null,
    warning: JWT_NOT_VERIFIED_WARNING,
    children: []
  };
  const segments = jwtCodecs.Base64.splitSegments(input);
  if (segments.length !== 3) {
    root.children = [
      {
        label: "jwt",
        error: `not a JWT \u2014 expected three dot-separated segments, found ${segments.length}`,
        raw: input
      }
    ];
    return {
      node: root,
      rawBytes: new TextEncoder().encode(input),
      rawView: "hex-dump"
    };
  }
  const [headerSegment, payloadSegment, signatureSegment] = segments;
  const headerNode = jwtDecodeSegment(headerSegment, "header");
  const payloadNode = jwtDecodeSegment(payloadSegment, "payload");
  if (payloadNode.children) {
    for (const child of payloadNode.children) {
      if (!JWT_TIME_CLAIMS.includes(child.label)) continue;
      const existing = child.annotations ?? [];
      if (typeof child.value === "number" && Number.isFinite(child.value)) {
        const formatted = jwtCore.formatUtcDate(child.value);
        child.annotations = [
          ...existing,
          formatted !== null ? formatted : "claim value is outside the representable date range"
        ];
      } else {
        child.annotations = [...existing, "claim is present but is not a number"];
      }
    }
  }
  root.children = [headerNode, payloadNode];
  const signatureAnnotations = [];
  if (signatureSegment.length === 0) {
    signatureAnnotations.push("signature segment is empty");
  }
  if (input !== segments.join(".")) {
    signatureAnnotations.push("whitespace was removed from the pasted token before splitting");
  }
  const signatureNode = {
    label: "signature",
    value: signatureSegment,
    display: "text",
    raw: signatureSegment
  };
  if (signatureAnnotations.length > 0) signatureNode.annotations = signatureAnnotations;
  root.children.push(signatureNode);
  return {
    node: root,
    rawBytes: new TextEncoder().encode(input),
    rawView: "hex-dump"
  };
}
const jwtDecoder = {
  id: "jwt",
  label: "Jwt",
  settings: [],
  canDecode: jwtCanDecode,
  decode: jwtDecode
};
jwtRegistry.register(jwtDecoder);
