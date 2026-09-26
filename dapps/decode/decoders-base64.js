window.DxDecode ??= {};
const b64Codecs = window.DxDecode.codecs;
const b64Registry = window.DxDecode.registry;
const b64Core = window.DxDecode.core;
function b64CanDecode(input) {
  const stripped = input.replace(/[\t\n\v\f\r ]+/g, "");
  if (stripped.length === 0) return 0;
  if (b64Codecs.Hex.isHexLike(input)) return 0;
  const result = b64Codecs.Base64.decode(input);
  if (!result.ok) return 0;
  const hasPadding = stripped.endsWith("=");
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
      }
    }
    return 0.8;
  }
  return 0.7;
}
async function b64Decode(input, _ctx) {
  const result = b64Codecs.Base64.decode(input);
  if (!result.ok) {
    return {
      node: { label: "base64", error: result.error, raw: input },
      rawBytes: null
    };
  }
  const { bytes } = result;
  const children = [
    { label: "byte length", value: bytes.length, display: "int", raw: String(bytes.length) }
  ];
  let rootRaw;
  const text = b64Codecs.Utf8.decode(bytes);
  let annotations;
  if (text === null) {
    const hexEncoded = b64Codecs.Hex.encode(bytes);
    children.push({
      label: "hex",
      value: null,
      display: "hex",
      raw: hexEncoded,
      warning: "bytes are not valid UTF-8 \u2014 shown as hex"
    });
    rootRaw = hexEncoded;
  } else {
    children.push({ label: "text", value: text, display: "text", raw: text });
    rootRaw = text;
    let parsed;
    let parses = true;
    try {
      parsed = JSON.parse(text);
    } catch {
      parses = false;
    }
    if (parses) {
      const walked = b64Core.jsonToNode("json", parsed);
      const jsonNode = { label: "json", display: "json" };
      const raw = b64Core.jsonToRaw(parsed);
      if (raw !== void 0) jsonNode.raw = raw;
      else jsonNode.warning = "too deeply nested to pretty-print";
      if (walked.children !== void 0) {
        jsonNode.children = walked.children;
      } else {
        jsonNode.value = walked.value;
      }
      children.push(jsonNode);
    } else {
      const trimmed = text.trim();
      if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        annotations = ["looks like JSON but did not parse"];
      }
    }
  }
  const node = {
    label: "base64",
    type: "bytes",
    value: null,
    raw: rootRaw,
    children
  };
  if (annotations) node.annotations = annotations;
  return {
    node,
    rawBytes: bytes,
    rawView: "hex-dump"
  };
}
const base64Decoder = {
  id: "base64",
  label: "Base64",
  settings: [],
  canDecode: b64CanDecode,
  decode: b64Decode
};
b64Registry.register(base64Decoder);
