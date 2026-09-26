import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// 05-05 Task 1: the two registry adapters and the multi-source resolver, all against a stubbed
// TransportPort — no test in this file performs a real request (D-32). Loads the compiled
// modules in dependency order, matching test/decode-eth-calldata.test.ts's own
// `new Function('window', code)(window)` idiom, reloaded fresh in beforeEach for full isolation.
function loadCompiled(relPath: string): void {
  const code = readFileSync(resolve(__dirname, relPath), 'utf-8');
  new Function('window', code)(window);
}

beforeEach(() => {
  loadCompiled('../src/dapps/decode/codecs.js');
  loadCompiled('../src/dapps/decode/keccak.js');
  loadCompiled('../src/dapps/decode/abi.js');
  loadCompiled('../src/dapps/decode/core.js');
  loadCompiled('../src/dapps/decode/transport.js');
  loadCompiled('../src/dapps/decode/signatures.js');
});

interface SignaturesModule {
  createLocalSignatureTable(): SignatureLookupPort;
  hasLocalSelector(selector: string): boolean;
  createOpenChainAdapter(transport: TransportPort): SignatureLookupPort;
  create4byteAdapter(transport: TransportPort): SignatureLookupPort;
  createSignatureResolver(sources: SignatureLookupPort[]): SignatureLookupPort;
}

function signatures(): SignaturesModule {
  return window.DxDecode!.signatures as unknown as SignaturesModule;
}

// A stubbed TransportPort — never reaches the network. `handler` receives the composed
// HttpRequest and returns whatever HttpResponse this test wants the adapter to see.
function stubTransport(handler: (req: HttpRequest) => HttpResponse): {
  transport: TransportPort;
  requests: HttpRequest[];
} {
  const requests: HttpRequest[] = [];
  return {
    requests,
    transport: {
      async request(req: HttpRequest): Promise<HttpResponse> {
        requests.push(req);
        return handler(req);
      },
    },
  };
}

function okResponse(json: unknown): HttpResponse {
  return { status: 200, body: JSON.stringify(json), json, attempts: 1, ok: true };
}

function failedResponse(error: string): HttpResponse {
  return { status: 0, body: '', json: null, attempts: 4, ok: false, error };
}

// RESEARCH.md §Code Examples — verified live this session, used verbatim as fixtures.
const OPENCHAIN_MISS_BODY = { ok: true, result: { function: { '0xac6695d1': null }, event: {} } };
const OPENCHAIN_HIT_BODY = {
  ok: true,
  result: {
    function: {
      '0xa9059cbb': [{ name: 'transfer(address,uint256)', filtered: false, hasVerifiedContract: true }],
    },
    event: {},
  },
};
const FOURBYTE_MISS_BODY = { count: 0, next: null, previous: null, results: [] };
const FOURBYTE_COLLISION_BODY = {
  count: 6,
  results: [
    { id: 1111734, text_signature: 'workMyDirefulOwner(uint256,uint256)' },
    { id: 844280, text_signature: 'join_tg_invmru_haha_fd06787(address,bool)' },
    { id: 313067, text_signature: 'func_2093253501(bytes)' },
    { id: 161159, text_signature: 'transfer(bytes4[9],bytes5[6],int48[11])' },
    { id: 31780, text_signature: 'many_msg_babbage(bytes1)' },
    { id: 145, text_signature: 'transfer(address,uint256)' },
  ],
};

describe('createOpenChainAdapter', () => {
  it('resolves a hit to a candidate whose signature is transfer(address,uint256) and whose source names OpenChain', async () => {
    const { transport } = stubTransport(() => okResponse(OPENCHAIN_HIT_BODY));
    const result = await signatures().createOpenChainAdapter(transport).lookup('0xa9059cbb');

    expect(result.unavailable).toBe(false);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].signature).toBe('transfer(address,uint256)');
    expect(result.candidates[0].source).toBe('openchain');
  });

  it('a miss (the value null under the selector key, not an empty array) resolves to empty candidates, unavailable false, without throwing', async () => {
    const { transport } = stubTransport(() => okResponse(OPENCHAIN_MISS_BODY));
    const result = await signatures().createOpenChainAdapter(transport).lookup('0xac6695d1');

    expect(result).toEqual({ candidates: [], unavailable: false });
  });

  it('given 4byte-shaped miss body: resolves to empty candidates rather than throwing (the two checks are independent)', async () => {
    const { transport } = stubTransport(() => okResponse(FOURBYTE_MISS_BODY));
    const result = await signatures().createOpenChainAdapter(transport).lookup('0xac6695d1');

    expect(() => result).not.toThrow();
    expect(result.candidates).toEqual([]);
  });

  it('a failed transport resolves to unavailable: true with a reason — NOT the same value as a genuine miss', async () => {
    const { transport } = stubTransport(() => failedResponse('rate limited'));
    const failed = await signatures().createOpenChainAdapter(transport).lookup('0xac6695d1');
    const { transport: missTransport } = stubTransport(() => okResponse(OPENCHAIN_MISS_BODY));
    const miss = await signatures().createOpenChainAdapter(missTransport).lookup('0xac6695d1');

    expect(failed.unavailable).toBe(true);
    expect(failed.reason).toBe('rate limited');
    expect(miss.unavailable).toBe(false);
    expect(failed.unavailable).not.toBe(miss.unavailable);
  });

  it('a syntactically valid but unexpectedly shaped response resolves with unavailable: true and a reason naming the malformed body', async () => {
    const malformed = { result: { function: { '0xac6695d1': 'not-an-array-or-null' } } };
    const { transport } = stubTransport(() => okResponse(malformed));
    const result = await signatures().createOpenChainAdapter(transport).lookup('0xac6695d1');

    expect(result.unavailable).toBe(true);
    expect(result.reason).toMatch(/unexpected shape/i);
  });

  it('passes only the selector to the transport — the composed url contains it and no fixture payload text', async () => {
    const { transport, requests } = stubTransport(() => okResponse(OPENCHAIN_MISS_BODY));
    await signatures().createOpenChainAdapter(transport).lookup('0xac6695d1');

    expect(requests).toHaveLength(1);
    expect(requests[0].url).toContain('0xac6695d1');
    expect(requests[0].url).not.toContain('claimTribute');
    expect(requests[0].url).not.toContain('deadbeef'.repeat(8));
  });
});

describe('create4byteAdapter', () => {
  it('a miss (count 0, empty results) resolves to empty candidates, unavailable false, without throwing', async () => {
    const { transport } = stubTransport(() => okResponse(FOURBYTE_MISS_BODY));
    const result = await signatures().create4byteAdapter(transport).lookup('0xac6695d1');

    expect(result).toEqual({ candidates: [], unavailable: false });
  });

  it('given OpenChain-shaped miss body: resolves to empty candidates rather than throwing (the two checks are independent)', async () => {
    const { transport } = stubTransport(() => okResponse(OPENCHAIN_MISS_BODY));
    const result = await signatures().create4byteAdapter(transport).lookup('0xac6695d1');

    expect(() => result).not.toThrow();
    expect(result.candidates).toEqual([]);
  });

  it('the six-result collision fixture orders candidates oldest-id-first — transfer(address,uint256) first, not the newest junk entry', async () => {
    const { transport } = stubTransport(() => okResponse(FOURBYTE_COLLISION_BODY));
    const result = await signatures().create4byteAdapter(transport).lookup('0xa9059cbb');

    expect(result.candidates[0].signature).toBe('transfer(address,uint256)');
    expect(result.candidates.map((c) => c.signature)).not.toContain(undefined);
  });

  it('a failed transport resolves to unavailable: true with a reason — NOT the same value as a genuine miss', async () => {
    const { transport } = stubTransport(() => failedResponse('network error'));
    const failed = await signatures().create4byteAdapter(transport).lookup('0xac6695d1');

    expect(failed.unavailable).toBe(true);
    expect(failed.reason).toBe('network error');
  });

  it('a syntactically valid but unexpectedly shaped response resolves with unavailable: true and a reason naming the malformed body', async () => {
    const malformed = { count: 'lots', results: 'not-an-array' };
    const { transport } = stubTransport(() => okResponse(malformed));
    const result = await signatures().create4byteAdapter(transport).lookup('0xac6695d1');

    expect(result.unavailable).toBe(true);
    expect(result.reason).toMatch(/unexpected shape/i);
  });

  it('passes only the selector to the transport — the composed url contains it and no fixture payload text', async () => {
    const { transport, requests } = stubTransport(() => okResponse(FOURBYTE_MISS_BODY));
    await signatures().create4byteAdapter(transport).lookup('0xac6695d1');

    expect(requests).toHaveLength(1);
    expect(requests[0].url).toContain('0xac6695d1');
    expect(requests[0].url).not.toContain('claimTribute');
  });
});

describe('createSignatureResolver — verify-before-advancing, D-21 order', () => {
  function fixedSource(result: SignatureLookupResult): {
    source: SignatureLookupPort;
    lookup: ReturnType<typeof vi.fn>;
  } {
    const lookup = vi.fn(async () => result);
    return { source: { lookup }, lookup };
  }

  it('keccak-verifies before deciding a source answered: a non-verifying OpenChain candidate does not stop the 4byte fallback', async () => {
    const openchain = fixedSource({
      candidates: [{ signature: 'notTheRealFunction(uint256)', source: 'openchain' }],
      unavailable: false,
    });
    const fourbyte = fixedSource({
      candidates: [{ signature: 'transfer(address,uint256)', source: '4byte' }],
      unavailable: false,
    });
    const resolver = signatures().createSignatureResolver([openchain.source, fourbyte.source]);

    const result = await resolver.lookup('0xa9059cbb');

    expect(result.candidates.map((c) => c.signature)).toContain('transfer(address,uint256)');
    expect(fourbyte.lookup).toHaveBeenCalledTimes(1);
  });

  it('stops at the first source producing a verifying candidate — 4byte is never invoked when OpenChain already verifies', async () => {
    const openchain = fixedSource({
      candidates: [{ signature: 'transfer(address,uint256)', source: 'openchain' }],
      unavailable: false,
    });
    const fourbyte = fixedSource({
      candidates: [{ signature: 'transfer(address,uint256)', source: '4byte' }],
      unavailable: false,
    });
    const resolver = signatures().createSignatureResolver([openchain.source, fourbyte.source]);

    await resolver.lookup('0xa9059cbb');

    expect(fourbyte.lookup).not.toHaveBeenCalled();
  });

  it('reports unavailable: true only when no source verified AND at least one source was unavailable; a clean miss from every source is unavailable: false', async () => {
    const openchain = fixedSource({ candidates: [], unavailable: false });
    const fourbyte = fixedSource({ candidates: [], unavailable: false });
    const resolver = signatures().createSignatureResolver([openchain.source, fourbyte.source]);

    const cleanMiss = await resolver.lookup('0xac6695d1');
    expect(cleanMiss.unavailable).toBe(false);

    const openchainDown = fixedSource({ candidates: [], unavailable: true, reason: 'rate limited' });
    const resolverWithFailure = signatures().createSignatureResolver([openchainDown.source, fourbyte.source]);
    const result = await resolverWithFailure.lookup('0xac6695d1');
    expect(result.unavailable).toBe(true);
    expect(result.reason).toBe('rate limited');
  });
});
