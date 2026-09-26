// REF-01's §7.4 slice — handoff §6.5 step 7. Offline throughout: creation-code detection is pure
// byte analysis, so nothing here needs a stub for the network, the clock or storage.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

function loadDecodeModules(): void {
  const dir = resolve(__dirname, '../src/dapps/decode');
  for (const name of [
    'codecs',
    'keccak',
    'abi',
    'creation-code',
    'core',
    'transport',
    'signatures',
    'annotators',
    'decoders',
    'decoders-eth-calldata',
    'decoders-abi-words',
  ]) {
    // The directory ships IIFEs with no module system, so each built .js is run against a shared
    // `window` — decode-ui.test.ts's own loader shape, not a second way of doing the same thing.
    new Function('window', readFileSync(resolve(dir, `${name}.js`), 'utf-8'))(window);
  }
}

const cc = () => window.DxDecode!.creationCode!;
const decoder = () => window.DxDecode!.registry!.list().find((d) => d.id === 'eth-calldata')!;

function bytesOf(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/, '');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// The solc CBOR metadata tail, exactly as it appears in the real §7.4 payload:
// `64736f6c6343` + version `000824` + length `0033`, preceded by the ipfs hash entry.
const SOLC_METADATA = `a26469706673582212${'38'.repeat(32)}64736f6c63430008240033`;
const ADDRESSES = [
  '5e58ba0e06ed0f5558f83be732a4b899a674053e',
  '00000095643cffa7d9fae407a84dfcb6406456c6',
  'e8a6e96efa3a5e8b06f072936a5b7dc1278944ab',
  '67f406e883bc9cd05d7b618b5ec16ba83ee09f5b',
];

function word(hexNoPrefix: string): string {
  return hexNoPrefix.padStart(64, '0');
}

// handoff §7.4's own instruction: "Test with a synthetic short payload: prologue + padding +
// metadata marker + 4 address words".
function syntheticDeployPayload(bodyBytes = 64, addresses = ADDRESSES): string {
  const body = `61024060405234610309${'ab'.repeat(bodyBytes)}`;
  return `0x${body}${SOLC_METADATA}${addresses.map(word).join('')}`;
}

function makeCtx(): DecodeContext {
  return {
    settings: {},
    links: { address: (a: string) => `https://explorer.example/address/${a}`, tx: () => null },
  } as unknown as DecodeContext;
}

describe('creation-code detection (handoff §6.5 step 7)', () => {
  beforeAll(() => {
    loadDecodeModules();
  });

  it('recognises the solc metadata tail wherever it sits, and reports where the code ends', () => {
    const payload = bytesOf(syntheticDeployPayload());
    const match = cc().match(payload)!;

    expect(match).not.toBeNull();
    expect(match.metadataAt).not.toBeNull();
    // codeEnd is the marker plus its own eleven fixed bytes; everything after is arguments.
    expect(payload.length - match.codeEnd).toBe(ADDRESSES.length * 32);
  });

  it('recognises a known init prologue with no metadata tail, and then offers no split', () => {
    const payload = bytesOf(`0x6080604052${'00'.repeat(64)}`);
    const match = cc().match(payload)!;

    expect(match).not.toBeNull();
    expect(match.metadataAt).toBeNull();
    expect(match.codeEnd).toBe(payload.length);
    expect(cc().constructorArgs(payload, match.codeEnd)).toBeNull();
  });

  it('does not fire on a CALL that merely carries a deploy payload as an argument', () => {
    // The failure handoff §6.5 step 7's wording does not survive on its own: a
    // deployNext(bytes,bytes32) call contains the payload, marker and all, so a marker-only test
    // would summarise the call itself as creation code instead of decoding it.
    const payload = syntheticDeployPayload().replace(/^0x/, '');
    const call = bytesOf(`0x48215787${word('40')}${word('ab'.repeat(32))}${payload}`);
    expect(cc().looksLikeCreationCode(call)).toBe(false);
  });

  it('does not fire on ordinary calldata', () => {
    const calldata = bytesOf(`0x095ea7b3${word('1'.repeat(40))}${word('de0b6b3a7640000')}`);
    expect(cc().looksLikeCreationCode(calldata)).toBe(false);
    expect(cc().match(calldata)).toBeNull();
  });

  it('splits at the LAST metadata tail, not the first — a factory embeds the blob it deploys', () => {
    const inner = `61024060405234610309${'cd'.repeat(32)}${SOLC_METADATA}`;
    const outer = `0x${inner}${'ef'.repeat(32)}${SOLC_METADATA}${ADDRESSES.map(word).join('')}`;
    const payload = bytesOf(outer);
    const match = cc().match(payload)!;

    // Splitting at the first marker would hand back the outer blob's remaining bytecode as
    // "constructor arguments" and label chunks of it as addresses.
    expect(payload.length - match.codeEnd).toBe(ADDRESSES.length * 32);
  });

  it('labels a 12-zero-byte + 20-non-zero-byte word as an address, and a fully zero word as not one', () => {
    const payload = bytesOf(`0x61024060${SOLC_METADATA}${word(ADDRESSES[0])}${word('0')}`);
    const match = cc().match(payload)!;
    const args = cc().constructorArgs(payload, match.codeEnd)!;

    expect(args[0].type).toBe('address');
    expect(args[0].value).toBe(`0x${ADDRESSES[0]}`);
    // address(0) is a fully zero word — labelling it an address would make every zero-padded
    // numeric argument an address too.
    expect(args[1].type).toBe('bytes32');
    expect(args[1].annotations).toEqual(['= 0']);
  });

  it('refuses to split a tail that is not a whole number of words', () => {
    const payload = bytesOf(`0x61024060${SOLC_METADATA}${'ab'.repeat(64)}`);
    expect(cc().constructorArgs(payload, payload.length - 33)).toBeNull();
  });

  // The THIRD corroborating signal. First byte plus marker alone made any well-formed calldata
  // whose selector begins 0x60/0x61 — 2 of every 256 — a deploy payload as soon as one of its
  // arguments carried compiled bytecode, which is exactly what a proxy-factory call carries.
  it('does not fire on a createProxy-shaped call whose bytes argument embeds compiled bytecode', () => {
    // createProxy(address,bytes): selector 0x61b69abd, an address head word, the bytes offset, the
    // bytes length, then the blob itself with its metadata tail and one padding byte.
    const blob = `60806040523480156100${'ab'.repeat(20)}${SOLC_METADATA}`;
    const blobBytes = blob.length / 2;
    const padded = `${blob}${'00'.repeat(32 - (blobBytes % 32))}`;
    const call = bytesOf(`0x61b69abd${word(ADDRESSES[0])}${word('40')}${word(blobBytes.toString(16))}${padded}`);

    expect(cc().looksLikeCreationCode(call)).toBe(false);
    expect(cc().match(call)).toBeNull();
  });

  it('still recognises the real payload shape the same test would otherwise have excluded', () => {
    // The discriminator is the tail AFTER the marker, so §7.4's own payload — marker followed by a
    // whole number of argument words — is untouched by it.
    const payload = bytesOf(syntheticDeployPayload());
    expect(cc().looksLikeCreationCode(payload)).toBe(true);
    expect(cc().looksLikeCreationCode(bytesOf(`0x61024060${'ab'.repeat(32)}${SOLC_METADATA}`))).toBe(true);
  });
});

describe('the deploy-payload branch end to end (§7.4)', () => {
  beforeAll(() => {
    loadDecodeModules();
  });

  it('auto-detect scores creation code above every other rung on the published ladder', () => {
    const score = decoder().canDecode(syntheticDeployPayload());
    expect(score).toBe(0.98);
    // Above abi-words's 0.95, which is what a deploy payload used to resolve to.
    const abiWords = window.DxDecode!.registry!.list().find((d) => d.id === 'abi-words')!;
    expect(score).toBeGreaterThan(abiWords.canDecode(syntheticDeployPayload()));
  });

  it('a pasted deploy payload decodes to a summary plus its constructor addresses, not an unresolved selector', async () => {
    const output = await decoder().decode(syntheticDeployPayload(), makeCtx());

    expect(output.node.label).toContain('contract creation code');
    expect(String(output.node.value)).toMatch(/solc metadata at byte \d+/);
    // The old behaviour: the blob's first four bytes read as a selector nobody knows.
    expect(output.node.error).toBeUndefined();

    const [code, args] = output.node.children!;
    expect(code.label).toBe('creation code');
    expect(args.label).toBe(`constructor args (${ADDRESSES.length} words)`);
    expect(args.children).toHaveLength(ADDRESSES.length);
  });

  it('the constructor addresses are decorated by the existing pass — shortened, linked, full value in raw', async () => {
    const output = await decoder().decode(syntheticDeployPayload(), makeCtx());
    const args = output.node.children![1].children!;

    expect(args[0].display).toBe('address');
    expect(args[0].raw).toBe(`0x${ADDRESSES[0]}`);
    expect(args[0].value).not.toBe(args[0].raw);
    expect(args[0].link).toBe(`https://explorer.example/address/0x${ADDRESSES[0]}`);
  });

  it('click-to-copy still yields the whole payload — the summary replaces the display, never raw', async () => {
    const payload = syntheticDeployPayload();
    const output = await decoder().decode(payload, makeCtx());
    expect(output.node.raw).toBe(payload);
    // Without display: 'text' the renderer's raw-wins rule would put the whole blob back where
    // the summary goes.
    expect(output.node.display).toBe('text');
  });

  it("fires even when the blob's length happens to satisfy 4 + 32k (§7.4's own must-have)", async () => {
    // Pad the body until the total length lands exactly on the calldata congruence, which is the
    // one case an order-of-checks mistake would silently mis-decode.
    let body = 64;
    let payload = syntheticDeployPayload(body);
    while ((payload.replace(/^0x/, '').length / 2 - 4) % 32 !== 0) {
      body += 1;
      payload = syntheticDeployPayload(body);
    }
    expect((payload.replace(/^0x/, '').length / 2 - 4) % 32).toBe(0);

    const output = await decoder().decode(payload, makeCtx());
    expect(output.node.label).toContain('contract creation code');
  });
});

describe('the recursion pass treats a nested deploy payload as creation code, never as calldata', () => {
  beforeAll(() => {
    loadDecodeModules();
  });

  it('a bytes argument holding creation code is expanded, and its selector is never looked up', async () => {
    const keccak = window.DxDecode!.keccak!;
    const sig = 'deployNext(bytes,bytes32)';
    const payloadHex = syntheticDeployPayload().replace(/^0x/, '');
    const payloadBytes = payloadHex.length / 2;
    const padded = payloadHex.padEnd(Math.ceil(payloadBytes / 32) * 64, '0');
    const calldata =
      keccak.selector(sig) + word('40') + word('ab'.repeat(32)) + word(payloadBytes.toString(16)) + padded;

    const asked: string[] = [];
    const ctx = {
      ...makeCtx(),
      signatures: {
        lookup: async (selector: string) => {
          asked.push(selector);
          return {
            candidates: [{ signature: sig, source: 'openchain' }].filter(
              (c) => keccak.selector(c.signature) === selector,
            ),
          };
        },
      },
    } as unknown as DecodeContext;

    // keccak.selector already returns a 0x-prefixed string — prefixing again is malformed hex.
    const output = await decoder().decode(calldata, ctx);
    const bytesArg = output.node.children![0];

    expect(bytesArg.label).toContain('contract creation code');
    expect(bytesArg.children![1].children).toHaveLength(ADDRESSES.length);
    // The point of the guard: the blob's opening bytes are never offered to the resolver as a
    // selector. (`deployNext` itself resolves from the local table, so `asked` may be empty —
    // asserting its exact contents would pin which rung answered, not the behaviour under test.)
    expect(asked).not.toContain('0x61024060');
  });
});
