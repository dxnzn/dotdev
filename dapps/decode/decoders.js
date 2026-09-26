window.DxDecode ??= {};
const codecs = window.DxDecode.codecs;
const registry = window.DxDecode.registry;
const core = window.DxDecode.core;
const ODD_LENGTH_MARGIN = 0.05;
function canDecode(input) {
  if (!codecs.Hex.isHexLike(input)) return 0;
  const normalized = codecs.Hex.normalize(input);
  if (normalized.length === 0) return 0;
  if (normalized.length % 2 === 0) {
    const strippedOfWhitespace = input.replace(/[\t\n\v\f\r ]+/g, "");
    return /^0x/i.test(strippedOfWhitespace) ? 0.9 : 0.6;
  }
  return Math.min(1, core.AUTO_DETECT_THRESHOLD + ODD_LENGTH_MARGIN);
}
async function decode(input, _ctx) {
  const result = codecs.Hex.decode(input);
  if (!result.ok) {
    return {
      node: { label: "hex", error: result.error, raw: input },
      rawBytes: null
    };
  }
  const { bytes } = result;
  const normalized = codecs.Hex.normalize(input);
  const children = [
    { label: "byte length", value: bytes.length, display: "int", raw: String(bytes.length) }
  ];
  const utf8 = codecs.Utf8.decode(bytes);
  if (utf8 !== null) {
    children.push({ label: "utf8", value: utf8, display: "text", raw: utf8 });
  } else {
    children.push({ label: "utf8", warning: "bytes are not valid UTF-8" });
  }
  const node = {
    label: "hex",
    type: "bytes",
    value: null,
    raw: `0x${normalized}`,
    children
  };
  if (bytes.length <= 32) {
    const intValue = bytes.length === 0 ? 0n : BigInt(`0x${codecs.Hex.encode(bytes, { prefix: false })}`);
    children.push({ label: "int", value: intValue, display: "int", raw: intValue.toString() });
  } else {
    node.annotations = ["integer omitted \u2014 payload exceeds the 32-byte limit"];
  }
  return {
    node,
    rawBytes: bytes,
    rawView: "hex-dump"
  };
}
const hexDecoder = {
  id: "hex",
  label: "Hex",
  settings: [],
  canDecode,
  decode
};
registry.register(hexDecoder);
