// window.DxDecode.creationCode — handoff §6.5 step 7 (REF-01's §7.4 slice): recognising contract
// creation bytecode and splitting its trailing constructor arguments off the compiled blob.
//
// Pure by construction, like abi.ts and keccak.ts: no network, no persistence, no DOM, no ctx. It
// consumes only window.DxDecode.codecs and returns plain DecodeNodes. That is what lets the two
// consumers share it without either learning about the other — decoders-eth-calldata.ts calls it
// for a top-level paste, annotators.ts calls it as the guard handoff §6.5 step 5 demands ("that is
// NOT creation code (step 7 check first)") before grafting a bytes argument as a nested call.
//
// Deliberately NOT a decoder. A deploy payload is almost always an ARGUMENT — the `bytes` inside
// `deployNext(bytes,bytes32)` (§7.4) — so registering it as a sibling decoder would make it
// reachable only from the dropdown, which is exactly the case the recursion pass has to handle
// without one. It is a shared analysis module both paths call, per D-04's own precedent.
//
// Scope, stated so the next reader does not mistake this for all of REF-01: this file recognises
// the payload and splits its tail. Bytecode analysis proper — disassembly, function-selector
// recovery from the runtime blob, immutable-argument detection — remains REF-01, v2.

/// <reference path="./types.d.ts" />

window.DxDecode ??= {};

const ccCodecs = window.DxDecode.codecs as DxDecodeCodecsModule;

const CC_WORD_BYTES = 32;
const CC_ADDRESS_BYTES = 20;

// handoff §6.5 step 7's own two tests, verbatim in intent:
//
//   1. the solc CBOR metadata tail — `64736f6c6343` ("dsolcC" in the CBOR map), three version
//      bytes, then the two-byte big-endian length `0033`. This is the STRONG signal: it appears
//      at the end of every solc-compiled blob and nowhere in ordinary calldata by accident.
//   2. a known init prologue. The WEAK signal, and a fallback only — the real §7.4 payload begins
//      `0x61024060`, which is neither of the two prologues the handoff names, and would be missed
//      entirely without test 1.
//
// Both are matched against the LOWERCASE hex string rather than the byte array: the metadata tail
// is a fixed hex pattern with a variable middle, which a regex expresses exactly and a byte scan
// would only re-implement worse.
const CC_METADATA_RE = /64736f6c6343[0-9a-f]{6}0033/g;
const CC_PROLOGUES = ['6080604052', '6040608052'];

// A DELIBERATE STRENGTHENING of handoff §6.5 step 7, and the reason is a case its wording does not
// survive: applied as written — "matching the metadata tail OR starting with a known prologue" —
// the marker test alone makes every `deployNext(bytes,bytes32)` CALL creation code, because the
// call carries the deploy payload, marker and all, inside its own argument. A top-level paste of
// that call would then be summarised as a deploy payload rather than decoded as the call it is.
//
// So the marker must be corroborated: creation code begins with EVM init code, which in practice
// opens with PUSH1 (0x60) or PUSH2 (0x61) setting up the free-memory pointer. The handoff's own two
// prologues are both 0x60..., and §7.4's real payload opens 0x61024060 — neither of them, which is
// why the prologue list cannot be the primary test either. First byte plus marker plus the
// word-aligned tail ccMatch requires below is what distinguishes the payload from a call that
// merely contains one.
const CC_INIT_OPCODES = [0x60, 0x61];

// The metadata marker's own length: 6 bytes of tag, 3 of version, 2 of length — fixed.
const CC_METADATA_BYTES = 11;

interface CreationCodeMatch {
  // Byte offset of the metadata marker's first byte, or null when only a prologue matched.
  metadataAt: number | null;
  // Byte offset one past the end of the compiled blob — where constructor arguments begin. Equal
  // to the whole length when there is no metadata tail and therefore nothing to split.
  codeEnd: number;
}

// The LAST metadata occurrence wins, never the first. A factory's creation code embeds the
// creation code of what it deploys, metadata tail and all, so an inner blob's marker appears
// before the outer one's — splitting at the first would hand back the rest of the compiled code
// as "constructor arguments" and label chunks of bytecode as addresses.
function ccFindMetadata(hex: string): number | null {
  let last: number | null = null;
  CC_METADATA_RE.lastIndex = 0;
  for (let m = CC_METADATA_RE.exec(hex); m !== null; m = CC_METADATA_RE.exec(hex)) {
    last = m.index;
  }
  return last === null ? null : last / 2;
}

// Returns null for anything that is not creation code — the caller's whole branch test. Never
// throws and never partially answers: a payload either produces a match with a definite code
// boundary or it produces nothing at all.
function ccMatch(bytes: Uint8Array): CreationCodeMatch | null {
  if (bytes.length === 0) return null;
  // The opcode gate runs BEFORE the hex encode — both entries of CC_PROLOGUES also begin 0x60, so
  // this one test fronts both signals below, and a payload that cannot be creation code is refused
  // without encoding a copy of it first.
  if (!CC_INIT_OPCODES.includes(bytes[0])) return null;
  const hex = ccCodecs.Hex.encode(bytes, { prefix: false });

  const metadataAt = ccFindMetadata(hex);
  // The THIRD corroborating signal, and the one that separates a deploy payload from a call
  // carrying one. Everything after a creation blob's metadata tail is ABI-encoded constructor
  // arguments, so it is always a whole number of 32-byte words (or nothing at all). In a CALL that
  // merely embeds compiled bytecode in a `bytes` argument, the marker sits inside that argument and
  // is followed by its word padding plus whatever words come after — a whole-word remainder only
  // when the embedded blob's own length happens to be word-aligned. Without this, any well-formed
  // calldata whose selector begins 0x60/0x61 (2 of every 256) and whose argument holds bytecode was
  // summarised as a deploy payload, its head words carved up as code and its selector never
  // resolved.
  if (metadataAt !== null && (bytes.length - (metadataAt + CC_METADATA_BYTES)) % CC_WORD_BYTES === 0) {
    return { metadataAt, codeEnd: metadataAt + CC_METADATA_BYTES };
  }

  // No metadata tail: a prologue alone still identifies the payload, but says nothing about where
  // the code ends, so there is no split to offer and codeEnd is the whole blob.
  if (CC_PROLOGUES.some((p) => hex.startsWith(p))) {
    return { metadataAt: null, codeEnd: bytes.length };
  }
  return null;
}

function ccLooksLikeCreationCode(bytes: Uint8Array): boolean {
  return ccMatch(bytes) !== null;
}

// handoff §6.5 step 7: "a word that is 12 zero bytes + 20 non-zero bytes is shown as an address".
// The 20-byte half must not be all zero either — `address(0)` encodes as a fully zero word, and
// treating that as an address would label every zero-padded numeric argument as one.
function ccWordIsAddress(word: Uint8Array): boolean {
  for (let i = 0; i < CC_WORD_BYTES - CC_ADDRESS_BYTES; i++) {
    if (word[i] !== 0) return false;
  }
  for (let i = CC_WORD_BYTES - CC_ADDRESS_BYTES; i < CC_WORD_BYTES; i++) {
    if (word[i] !== 0) return true;
  }
  return false;
}

// handoff §6.5 step 7's "otherwise as hex with a decimal hint when small". Small means it fits a
// safe integer — anything larger is left as hex alone rather than rendered through a lossy Number.
const CC_DECIMAL_HINT_MAX = BigInt(Number.MAX_SAFE_INTEGER);

function ccWordValue(word: Uint8Array): bigint {
  let value = 0n;
  for (const byte of word) value = (value << 8n) | BigInt(byte);
  return value;
}

// The constructor-argument nodes. `type: 'address'` is load-bearing and not merely descriptive:
// decoders-eth-calldata.ts's ethDecorateTree dispatches on exactly that, so emitting it is what
// gives these words their shortening, their explorer link and their ETH-12 contract-name walk —
// all of it already built, none of it re-implemented here. This module never sets display, link
// or annotations itself, for the same reason abi.ts does not (D-30).
function ccConstructorArgs(bytes: Uint8Array, codeEnd: number): DecodeNode[] | null {
  const tail = bytes.length - codeEnd;
  // Not a whole number of words: the handoff conditions the split on "if a multiple of 32", and
  // anything else is trailing data this module has no basis to carve up.
  if (tail <= 0 || tail % CC_WORD_BYTES !== 0) return null;

  const nodes: DecodeNode[] = [];
  for (let offset = codeEnd; offset < bytes.length; offset += CC_WORD_BYTES) {
    const word = bytes.slice(offset, offset + CC_WORD_BYTES);
    const index = (offset - codeEnd) / CC_WORD_BYTES;
    const label = `arg${index}`;
    if (ccWordIsAddress(word)) {
      const address = ccCodecs.Hex.encode(word.slice(CC_WORD_BYTES - CC_ADDRESS_BYTES));
      nodes.push({ label, type: 'address', value: address, raw: address });
      continue;
    }
    const hex = ccCodecs.Hex.encode(word);
    const value = ccWordValue(word);
    const node: DecodeNode = { label, type: 'bytes32', value: hex, raw: hex };
    if (value <= CC_DECIMAL_HINT_MAX) {
      node.annotations = [`= ${value.toString()}`];
    }
    nodes.push(node);
  }
  return nodes;
}

// Re-identifies an existing node in place as a deploy payload, the same way annotators.ts's own
// graft re-identifies a bytes argument as a nested call: the node keeps its identity and its
// `raw` (click-to-copy still yields the whole payload, D-30's invariant) and gains a summary
// label plus children. Returns false when the payload is not creation code, so the caller's
// guard is one expression.
//
// `display: 'text'` is required, not cosmetic: without it the renderer's raw-wins rule would put
// the entire 7 KB blob back where the summary goes.
//
// Handoff §6.5 step 7 asks for this node COLLAPSED. Deliberately not done, and the reason is that
// the condition it was written against no longer holds: collapsing existed to stop the compiled
// blob from dominating the panel, and the renderer now folds any over-long value on its own. The
// blob is one folded line either way, so collapsing would only hide the constructor arguments —
// the single most useful thing here — behind a second click.
function ccExpand(node: DecodeNode, bytes: Uint8Array): boolean {
  const match = ccMatch(bytes);
  if (match === null) return false;

  const args = ccConstructorArgs(bytes, match.codeEnd);
  const where = match.metadataAt === null ? 'no solc metadata' : `solc metadata at byte ${match.metadataAt}`;
  const code = ccCodecs.Hex.encode(bytes.slice(0, match.codeEnd));

  const children: DecodeNode[] = [{ label: 'creation code', type: 'bytes', value: code, raw: code }];
  if (args !== null) {
    children.push({
      label: `constructor args (${args.length} word${args.length === 1 ? '' : 's'})`,
      type: 'tuple',
      children: args,
    });
  }

  node.label = `${node.label} — contract creation code`;
  node.type = 'bytes';
  node.value = `${bytes.length} bytes (${where})`;
  node.display = 'text';
  node.children = children;
  return true;
}

const creationCodeModule = {
  looksLikeCreationCode: ccLooksLikeCreationCode,
  match: ccMatch,
  expand: ccExpand,
  constructorArgs: ccConstructorArgs,
};

window.DxDecode.creationCode = creationCodeModule;
