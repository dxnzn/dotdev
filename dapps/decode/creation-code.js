window.DxDecode ??= {};
const ccCodecs = window.DxDecode.codecs;
const CC_WORD_BYTES = 32;
const CC_ADDRESS_BYTES = 20;
const CC_METADATA_RE = /64736f6c6343[0-9a-f]{6}0033/g;
const CC_PROLOGUES = ["6080604052", "6040608052"];
const CC_INIT_OPCODES = [96, 97];
const CC_METADATA_BYTES = 11;
function ccFindMetadata(hex) {
  let last = null;
  CC_METADATA_RE.lastIndex = 0;
  for (let m = CC_METADATA_RE.exec(hex); m !== null; m = CC_METADATA_RE.exec(hex)) {
    last = m.index;
  }
  return last === null ? null : last / 2;
}
function ccMatch(bytes) {
  if (bytes.length === 0) return null;
  if (!CC_INIT_OPCODES.includes(bytes[0])) return null;
  const hex = ccCodecs.Hex.encode(bytes, { prefix: false });
  const metadataAt = ccFindMetadata(hex);
  if (metadataAt !== null && (bytes.length - (metadataAt + CC_METADATA_BYTES)) % CC_WORD_BYTES === 0) {
    return { metadataAt, codeEnd: metadataAt + CC_METADATA_BYTES };
  }
  if (CC_PROLOGUES.some((p) => hex.startsWith(p))) {
    return { metadataAt: null, codeEnd: bytes.length };
  }
  return null;
}
function ccLooksLikeCreationCode(bytes) {
  return ccMatch(bytes) !== null;
}
function ccWordIsAddress(word) {
  for (let i = 0; i < CC_WORD_BYTES - CC_ADDRESS_BYTES; i++) {
    if (word[i] !== 0) return false;
  }
  for (let i = CC_WORD_BYTES - CC_ADDRESS_BYTES; i < CC_WORD_BYTES; i++) {
    if (word[i] !== 0) return true;
  }
  return false;
}
const CC_DECIMAL_HINT_MAX = BigInt(Number.MAX_SAFE_INTEGER);
function ccWordValue(word) {
  let value = 0n;
  for (const byte of word) value = value << 8n | BigInt(byte);
  return value;
}
function ccConstructorArgs(bytes, codeEnd) {
  const tail = bytes.length - codeEnd;
  if (tail <= 0 || tail % CC_WORD_BYTES !== 0) return null;
  const nodes = [];
  for (let offset = codeEnd; offset < bytes.length; offset += CC_WORD_BYTES) {
    const word = bytes.slice(offset, offset + CC_WORD_BYTES);
    const index = (offset - codeEnd) / CC_WORD_BYTES;
    const label = `arg${index}`;
    if (ccWordIsAddress(word)) {
      const address = ccCodecs.Hex.encode(word.slice(CC_WORD_BYTES - CC_ADDRESS_BYTES));
      nodes.push({ label, type: "address", value: address, raw: address });
      continue;
    }
    const hex = ccCodecs.Hex.encode(word);
    const value = ccWordValue(word);
    const node = { label, type: "bytes32", value: hex, raw: hex };
    if (value <= CC_DECIMAL_HINT_MAX) {
      node.annotations = [`= ${value.toString()}`];
    }
    nodes.push(node);
  }
  return nodes;
}
function ccExpand(node, bytes) {
  const match = ccMatch(bytes);
  if (match === null) return false;
  const args = ccConstructorArgs(bytes, match.codeEnd);
  const where = match.metadataAt === null ? "no solc metadata" : `solc metadata at byte ${match.metadataAt}`;
  const code = ccCodecs.Hex.encode(bytes.slice(0, match.codeEnd));
  const children = [{ label: "creation code", type: "bytes", value: code, raw: code }];
  if (args !== null) {
    children.push({
      label: `constructor args (${args.length} word${args.length === 1 ? "" : "s"})`,
      type: "tuple",
      children: args
    });
  }
  node.label = `${node.label} \u2014 contract creation code`;
  node.type = "bytes";
  node.value = `${bytes.length} bytes (${where})`;
  node.display = "text";
  node.children = children;
  return true;
}
const creationCodeModule = {
  looksLikeCreationCode: ccLooksLikeCreationCode,
  match: ccMatch,
  expand: ccExpand,
  constructorArgs: ccConstructorArgs
};
window.DxDecode.creationCode = creationCodeModule;
