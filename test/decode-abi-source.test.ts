import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

// 06-03 Task 2 — the verified-ABI adapter, entirely against a stubbed TransportPort. No test in
// this file performs a real request (D-32/TST-03). Loads the compiled modules in dependency
// order, matching test/decode-signatures.test.ts's own idiom.
function loadCompiled(relPath: string): void {
  const code = readFileSync(resolve(__dirname, relPath), 'utf-8');
  new Function('window', code)(window);
}

// Copied from test/decode-url.test.ts's own installFakeStorage — this Node runtime exposes an
// experimental native globalThis.localStorage that shadows jsdom's simulated Storage and has no
// setItem/getItem/clear. 06-04: cache.js is now in the load order (below), and abi-source.ts's
// own adapter constructs a real cache instance at adapter-construction time, so a working
// persistence stand-in is what lets the new three-way-caching tests below assert on the
// persistent tier's actual contents rather than only on request counts.
function installFakeStorage() {
  const map = new Map<string, string>();
  const storage = {
    getItem: (k: string) => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k: string, v: string) => {
      map.set(k, String(v));
    },
    removeItem: (k: string) => {
      map.delete(k);
    },
    clear: () => {
      map.clear();
    },
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    get length() {
      return map.size;
    },
  };
  Object.defineProperty(window, 'localStorage', { configurable: true, value: storage });
}

beforeEach(() => {
  installFakeStorage();
  loadCompiled('../src/dapps/decode/codecs.js');
  loadCompiled('../src/dapps/decode/keccak.js');
  loadCompiled('../src/dapps/decode/abi.js');
  loadCompiled('../src/dapps/decode/core.js');
  loadCompiled('../src/dapps/decode/transport.js');
  loadCompiled('../src/dapps/decode/signatures.js');
  loadCompiled('../src/dapps/decode/cache.js');
  loadCompiled('../src/dapps/decode/abi-source.js');
});

interface AbiSourceModule {
  createEtherscanAbiSource(transport: TransportPort, settings: SettingsPort): AbiSourcePort;
  asrcIsTruncatedResponse(response: HttpResponse): boolean;
  asrcIsFailureEnvelope(body: unknown): boolean;
  asrcValidFunctionItems(parsed: unknown): AbiItem[] | null;
  asrcNormalizeAddress(value: unknown): string | null;
}

function abiSource(): AbiSourceModule {
  return window.DxDecode!.abiSource as unknown as AbiSourceModule;
}

// Mirrors test/decode-signatures.test.ts's own stubTransport — never reaches the network.
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

// A sequenced stub — each call consumes the next handler in order, for a proxy follow's two (or
// more) distinct requests.
function stubTransportSequence(handlers: Array<(req: HttpRequest) => HttpResponse>): {
  transport: TransportPort;
  requests: HttpRequest[];
} {
  const requests: HttpRequest[] = [];
  let call = 0;
  return {
    requests,
    transport: {
      async request(req: HttpRequest): Promise<HttpResponse> {
        requests.push(req);
        const handler = handlers[Math.min(call, handlers.length - 1)];
        call++;
        return handler(req);
      },
    },
  };
}

function okResponse(json: unknown): HttpResponse {
  return { status: 200, body: JSON.stringify(json), json, attempts: 1, ok: true };
}

function truncatedResponse(): HttpResponse {
  return { status: 200, body: '{"result":[{"ABI":"[', json: null, attempts: 1, ok: true, truncated: true };
}

function stubSettings(store: Record<string, unknown>): SettingsPort {
  return { get: (key: string) => store[key] };
}

function requestAddressParam(req: HttpRequest): string | null {
  return new URL(req.url).searchParams.get('address');
}

const API_KEY = 'test-etherscan-key';
// 06-04: a genuine 20-byte (40 hex char) address — the pre-06-04 literal here was one byte
// short (38 hex chars), invisible until asrcNormalizeAddress started validating the OUTER
// target too (for the cache key) rather than only a proxy's third-party Implementation field.
const TARGET = '0x0000000000000000000000000000000000000001';

const VALID_ABI_ITEM = {
  name: 'transfer',
  type: 'function',
  inputs: [
    { name: 'to', type: 'address' },
    { name: 'amount', type: 'uint256' },
  ],
};

function sourceCodeBody(overrides: Record<string, unknown> = {}): unknown {
  return {
    status: '1',
    message: 'OK',
    result: [
      {
        SourceCode: 'contract X {}',
        ABI: JSON.stringify([VALID_ABI_ITEM]),
        ContractName: 'TestContract',
        Proxy: '0',
        Implementation: '',
        ...overrides,
      },
    ],
  };
}

describe('createEtherscanAbiSource — the happy path and every distinct null branch', () => {
  it('a well-formed stubbed response returns the contract name and the parsed ABI array', async () => {
    const { transport } = stubTransport(() => okResponse(sourceCodeBody()));
    const adapter = abiSource().createEtherscanAbiSource(
      transport,
      stubSettings({ etherscanApiKey: API_KEY, chainId: 1 }),
    );

    const result = await adapter.getAbi(TARGET);

    expect(result).toEqual({ name: 'TestContract', abi: [VALID_ABI_ITEM] });
  });

  it('a bare-string `result` (the general in-body failure envelope) returns null', async () => {
    const { transport } = stubTransport(() =>
      okResponse({ status: '0', message: 'NOTOK', result: 'Missing/Invalid API Key' }),
    );
    const adapter = abiSource().createEtherscanAbiSource(
      transport,
      stubSettings({ etherscanApiKey: API_KEY, chainId: 1 }),
    );

    expect(await adapter.getAbi(TARGET)).toBeNull();
  });

  it('a response the transport reports as TRUNCATED returns null', async () => {
    const { transport } = stubTransport(() => truncatedResponse());
    const adapter = abiSource().createEtherscanAbiSource(
      transport,
      stubSettings({ etherscanApiKey: API_KEY, chainId: 1 }),
    );

    expect(await adapter.getAbi(TARGET)).toBeNull();
  });

  it('an ABI text that is not a JSON array (an unverified contract) returns null', async () => {
    const { transport } = stubTransport(() => okResponse(sourceCodeBody({ ABI: 'Contract source code not verified' })));
    const adapter = abiSource().createEtherscanAbiSource(
      transport,
      stubSettings({ etherscanApiKey: API_KEY, chainId: 1 }),
    );

    expect(await adapter.getAbi(TARGET)).toBeNull();
  });

  it('malformed JSON in the ABI field returns null rather than throwing', async () => {
    const { transport } = stubTransport(() => okResponse(sourceCodeBody({ ABI: '[not valid json' })));
    const adapter = abiSource().createEtherscanAbiSource(
      transport,
      stubSettings({ etherscanApiKey: API_KEY, chainId: 1 }),
    );

    await expect(adapter.getAbi(TARGET)).resolves.toBeNull();
  });

  it('the lookup never rejects for a transport-level failure', async () => {
    const { transport } = stubTransport(() => ({
      status: 0,
      body: '',
      json: null,
      attempts: 4,
      ok: false,
      error: 'boom',
    }));
    const adapter = abiSource().createEtherscanAbiSource(
      transport,
      stubSettings({ etherscanApiKey: API_KEY, chainId: 1 }),
    );

    await expect(adapter.getAbi(TARGET)).resolves.toBeNull();
  });
});

describe('the truncation branch is distinguishable from the unverified branch (D-10)', () => {
  it('asrcIsTruncatedResponse and asrcIsFailureEnvelope disagree on a truncated response vs. a bare-string failure body', () => {
    const truncated = truncatedResponse();
    const failureBody = { status: '0', result: 'Missing/Invalid API Key' };
    const failureResponse = okResponse(failureBody);

    // The truncated response is flagged truncated, and its (failed-to-parse) json is not a
    // failure envelope — the two predicates disagree here.
    expect(abiSource().asrcIsTruncatedResponse(truncated)).toBe(true);
    expect(abiSource().asrcIsFailureEnvelope(truncated.json)).toBe(false);

    // The bare-string-result response is a failure envelope but was never truncated — the two
    // predicates disagree the other way here.
    expect(abiSource().asrcIsTruncatedResponse(failureResponse)).toBe(false);
    expect(abiSource().asrcIsFailureEnvelope(failureBody)).toBe(true);
  });
});

describe('structural ABI validation filters rather than aborts (T-06-09)', () => {
  it('an ABI array whose FIRST item is malformed still returns every later valid item', async () => {
    const malformedFirst = [{ name: 'bad', inputs: 'not-an-array' }, VALID_ABI_ITEM];
    const { transport } = stubTransport(() => okResponse(sourceCodeBody({ ABI: JSON.stringify(malformedFirst) })));
    const adapter = abiSource().createEtherscanAbiSource(
      transport,
      stubSettings({ etherscanApiKey: API_KEY, chainId: 1 }),
    );

    const result = await adapter.getAbi(TARGET);
    expect(result?.abi).toEqual([VALID_ABI_ITEM]);
  });

  it('an item declaring a non-function type is filtered out', async () => {
    const withEvent = [
      { name: 'Transfer', type: 'event', inputs: [{ name: 'from', type: 'address' }] },
      VALID_ABI_ITEM,
    ];
    const { transport } = stubTransport(() => okResponse(sourceCodeBody({ ABI: JSON.stringify(withEvent) })));
    const adapter = abiSource().createEtherscanAbiSource(
      transport,
      stubSettings({ etherscanApiKey: API_KEY, chainId: 1 }),
    );

    const result = await adapter.getAbi(TARGET);
    expect(result?.abi).toEqual([VALID_ABI_ITEM]);
  });

  it('an ABI with no surviving function items returns null rather than an empty success', async () => {
    const onlyEvents = [{ name: 'Transfer', type: 'event', inputs: [] }];
    const { transport } = stubTransport(() => okResponse(sourceCodeBody({ ABI: JSON.stringify(onlyEvents) })));
    const adapter = abiSource().createEtherscanAbiSource(
      transport,
      stubSettings({ etherscanApiKey: API_KEY, chainId: 1 }),
    );

    expect(await adapter.getAbi(TARGET)).toBeNull();
  });
});

// 06-04: the three-way caching policy (NET-08) — a deliberate reading of the requirement's own
// "error-shaped responses are never cached" wording. A verified contract is cached in both
// tiers for the full time-to-live; a lookup ERROR (transport failure, in-body failure envelope,
// truncated response, parse/structural failure) is never cached at all, because it is a fact
// about the LOOKUP, not an answer about the CONTRACT; and a contract that was asked about and is
// GENUINELY not verified is a real answer, not an error, so it is cached in the MEMORY tier only,
// with its own five-minute time-to-live distinct from a verified entry's seven days — long
// enough that one decode and its name walk (Plan 06) share a single lookup per ordinary wallet
// address, short enough that a contract verified mid-session is re-asked before the mount ends.
describe('06-04: the three-way caching policy', () => {
  it('a second lookup for the same target and chain, on the same adapter instance, issues no further transport request', async () => {
    const { transport, requests } = stubTransport(() => okResponse(sourceCodeBody()));
    const adapter = abiSource().createEtherscanAbiSource(
      transport,
      stubSettings({ etherscanApiKey: API_KEY, chainId: 1 }),
    );

    await adapter.getAbi(TARGET);
    await adapter.getAbi(TARGET);

    expect(requests).toHaveLength(1);
  });

  it('an in-body-failure response and a truncated response each leave both tiers empty — a second lookup still issues a fresh request', async () => {
    const { transport: failureTransport, requests: failureRequests } = stubTransport(() =>
      okResponse({ status: '0', message: 'NOTOK', result: 'Missing/Invalid API Key' }),
    );
    const failureAdapter = abiSource().createEtherscanAbiSource(
      failureTransport,
      stubSettings({ etherscanApiKey: API_KEY, chainId: 1 }),
    );
    await failureAdapter.getAbi(TARGET);
    await failureAdapter.getAbi(TARGET);
    expect(failureRequests).toHaveLength(2);
    expect(window.localStorage.getItem(`dxdecode:abi:1:${TARGET}`)).toBeNull();

    const { transport: truncatedTransport, requests: truncatedRequests } = stubTransport(() => truncatedResponse());
    const truncatedAdapter = abiSource().createEtherscanAbiSource(
      truncatedTransport,
      stubSettings({ etherscanApiKey: API_KEY, chainId: 1 }),
    );
    await truncatedAdapter.getAbi(TARGET);
    await truncatedAdapter.getAbi(TARGET);
    expect(truncatedRequests).toHaveLength(2);
  });

  it('an unverified-contract response writes the memory tier only, leaves the persistent tier empty, and prevents a second request from a LATER decode on the same adapter instance', async () => {
    const { transport, requests } = stubTransport(() =>
      okResponse(sourceCodeBody({ ABI: 'Contract source code not verified' })),
    );
    const adapter = abiSource().createEtherscanAbiSource(
      transport,
      stubSettings({ etherscanApiKey: API_KEY, chainId: 1 }),
    );

    expect(await adapter.getAbi(TARGET)).toBeNull(); // first decode's lookup
    expect(await adapter.getAbi(TARGET)).toBeNull(); // a LATER decode, same adapter instance
    expect(requests).toHaveLength(1);

    // Never persisted — a contract can become verified between sessions, and a persisted "no"
    // would outlive the fact.
    expect(window.localStorage.getItem(`dxdecode:abi:1:${TARGET}`)).toBeNull();

    // A fresh adapter (its own fresh memory tier, simulating a new mount) reading the SAME
    // underlying persistence finds nothing and must ask again.
    const { transport: freshTransport, requests: freshRequests } = stubTransport(() =>
      okResponse(sourceCodeBody({ ABI: 'Contract source code not verified' })),
    );
    const freshAdapter = abiSource().createEtherscanAbiSource(
      freshTransport,
      stubSettings({ etherscanApiKey: API_KEY, chainId: 1 }),
    );
    expect(await freshAdapter.getAbi(TARGET)).toBeNull();
    expect(freshRequests).toHaveLength(1);
  });

  it('a verified contract is written to both tiers — a fresh adapter instance serves it from persistence with no request', async () => {
    const { transport } = stubTransport(() => okResponse(sourceCodeBody()));
    const adapter = abiSource().createEtherscanAbiSource(
      transport,
      stubSettings({ etherscanApiKey: API_KEY, chainId: 1 }),
    );
    await adapter.getAbi(TARGET);
    expect(window.localStorage.getItem(`dxdecode:abi:1:${TARGET}`)).not.toBeNull();

    const { transport: freshTransport, requests: freshRequests } = stubTransport(() => okResponse(sourceCodeBody()));
    const freshAdapter = abiSource().createEtherscanAbiSource(
      freshTransport,
      stubSettings({ etherscanApiKey: API_KEY, chainId: 1 }),
    );
    expect(await freshAdapter.getAbi(TARGET)).toEqual({ name: 'TestContract', abi: [VALID_ABI_ITEM] });
    expect(freshRequests).toHaveLength(0);
  });
});

describe('the port shape: getAbi(address, options?) — no positional chain id, no positional signal', () => {
  it('reads chainId from the options object, preferring it over the settings value', async () => {
    const { transport, requests } = stubTransport(() => okResponse(sourceCodeBody()));
    const adapter = abiSource().createEtherscanAbiSource(
      transport,
      stubSettings({ etherscanApiKey: API_KEY, chainId: 1 }),
    );

    await adapter.getAbi(TARGET, { chainId: 42 });

    expect(new URL(requests[0].url).searchParams.get('chainid')).toBe('42');
  });

  it('falls back to the settings chainId when the caller supplies none', async () => {
    const { transport, requests } = stubTransport(() => okResponse(sourceCodeBody()));
    const adapter = abiSource().createEtherscanAbiSource(
      transport,
      stubSettings({ etherscanApiKey: API_KEY, chainId: 5 }),
    );

    await adapter.getAbi(TARGET);

    expect(new URL(requests[0].url).searchParams.get('chainid')).toBe('5');
  });

  it('with no resolvable chain id at all, issues no request and returns null', async () => {
    const { transport, requests } = stubTransport(() => okResponse(sourceCodeBody()));
    const adapter = abiSource().createEtherscanAbiSource(transport, stubSettings({ etherscanApiKey: API_KEY }));

    expect(await adapter.getAbi(TARGET)).toBeNull();
    expect(requests).toHaveLength(0);
  });

  it('with no key configured, the stubbed transport is never called', async () => {
    const { transport, requests } = stubTransport(() => okResponse(sourceCodeBody()));
    const adapter = abiSource().createEtherscanAbiSource(transport, stubSettings({ chainId: 1 }));

    expect(await adapter.getAbi(TARGET)).toBeNull();
    expect(requests).toHaveLength(0);
  });

  it('with an already-aborted signal, the stubbed transport is never called', async () => {
    const { transport, requests } = stubTransport(() => okResponse(sourceCodeBody()));
    const adapter = abiSource().createEtherscanAbiSource(
      transport,
      stubSettings({ etherscanApiKey: API_KEY, chainId: 1 }),
    );
    const controller = new AbortController();
    controller.abort();

    expect(await adapter.getAbi(TARGET, { signal: controller.signal })).toBeNull();
    expect(requests).toHaveLength(0);
  });

  it('every request the adapter issues carries the supplied signal', async () => {
    const { transport, requests } = stubTransport(() => okResponse(sourceCodeBody()));
    const adapter = abiSource().createEtherscanAbiSource(
      transport,
      stubSettings({ etherscanApiKey: API_KEY, chainId: 1 }),
    );
    const controller = new AbortController();

    await adapter.getAbi(TARGET, { signal: controller.signal });

    expect(requests[0].signal).toBe(controller.signal);
  });
});

describe('the proxy follow (D-11, NET-09) — bounded to exactly one further level', () => {
  // 06-04: same fix as TARGET above — a genuine 20-byte address.
  const PROXY = '0x0000000000000000000000000000000000000002';
  const IMPL_LOWER = '0x1234567890abcdef1234567890abcdef12345678';
  const IMPL_MIXED = '0x1234567890ABCDEF1234567890abcdef12345678';

  function proxyBody(implementation: string, overrides: Record<string, unknown> = {}): unknown {
    return sourceCodeBody({ Proxy: '1', Implementation: implementation, ContractName: 'ProxyContract', ...overrides });
  }

  function implBody(overrides: Record<string, unknown> = {}): unknown {
    return sourceCodeBody({
      ContractName: 'ImplContract',
      ABI: JSON.stringify([{ name: 'onlyOnImpl', type: 'function', inputs: [] }]),
      ...overrides,
    });
  }

  it('a checksummed (mixed-case) implementation address is accepted, lowercased before it becomes the second request address parameter, and the stubbed transport receives exactly two requests', async () => {
    const { transport, requests } = stubTransportSequence([
      () => okResponse(proxyBody(IMPL_MIXED)),
      () => okResponse(implBody()),
    ]);
    const adapter = abiSource().createEtherscanAbiSource(
      transport,
      stubSettings({ etherscanApiKey: API_KEY, chainId: 1 }),
    );

    const result = await adapter.getAbi(PROXY);

    expect(requests).toHaveLength(2);
    expect(requestAddressParam(requests[1])).toBe(IMPL_LOWER);
    expect(result).not.toBeNull();
  });

  it('the proxy follow carries the same signal as the outer lookup', async () => {
    const { transport, requests } = stubTransportSequence([
      () => okResponse(proxyBody(IMPL_MIXED)),
      () => okResponse(implBody()),
    ]);
    const adapter = abiSource().createEtherscanAbiSource(
      transport,
      stubSettings({ etherscanApiKey: API_KEY, chainId: 1 }),
    );
    const controller = new AbortController();

    await adapter.getAbi(PROXY, { signal: controller.signal });

    expect(requests[0].signal).toBe(controller.signal);
    expect(requests[1].signal).toBe(controller.signal);
  });

  it('the merged ABI resolves a selector defined only by the implementation, and the implementation wins a selector collision', async () => {
    const collisionName = { name: 'transfer', type: 'function', inputs: [{ name: 'onlyOnImpl', type: 'bool' }] };
    const { transport } = stubTransportSequence([
      () => okResponse(proxyBody(IMPL_MIXED)),
      () => okResponse(implBody({ ABI: JSON.stringify([collisionName]) })),
    ]);
    const adapter = abiSource().createEtherscanAbiSource(
      transport,
      stubSettings({ etherscanApiKey: API_KEY, chainId: 1 }),
    );

    const result = await adapter.getAbi(PROXY);

    // implementation's own colliding entry appears BEFORE the proxy's — the decoder's selector
    // walk returns the first keccak match, so ordering IS precedence.
    const transferIndex = result!.abi.findIndex((item) => item.name === 'transfer');
    // toEqual, not toBe — the returned item was produced by JSON.parse on the ABI text, so it
    // is a structurally-equal but distinct object from the fixture literal.
    expect(result!.abi[transferIndex]).toEqual(collisionName);
  });

  it('the composed name is exactly the proxy name, a space, U+2192, a space, and the implementation name', async () => {
    const { transport } = stubTransportSequence([
      () => okResponse(proxyBody(IMPL_MIXED)),
      () => okResponse(implBody()),
    ]);
    const adapter = abiSource().createEtherscanAbiSource(
      transport,
      stubSettings({ etherscanApiKey: API_KEY, chainId: 1 }),
    );

    const result = await adapter.getAbi(PROXY);

    expect(result?.name).toBe('ProxyContract → ImplContract');
  });

  it('an implementation lookup that succeeds but yields an empty implementation name returns the proxy name alone, with no arrow', async () => {
    const { transport } = stubTransportSequence([
      () => okResponse(proxyBody(IMPL_MIXED)),
      () => okResponse(implBody({ ContractName: '' })),
    ]);
    const adapter = abiSource().createEtherscanAbiSource(
      transport,
      stubSettings({ etherscanApiKey: API_KEY, chainId: 1 }),
    );

    const result = await adapter.getAbi(PROXY);

    expect(result?.name).toBe('ProxyContract');
    expect(result?.name).not.toContain('→');
  });

  it('a proxy with no implementation address returns the proxy own ABI and name, with exactly one request', async () => {
    const { transport, requests } = stubTransport(() => okResponse(proxyBody('')));
    const adapter = abiSource().createEtherscanAbiSource(
      transport,
      stubSettings({ etherscanApiKey: API_KEY, chainId: 1 }),
    );

    const result = await adapter.getAbi(PROXY);

    expect(requests).toHaveLength(1);
    expect(result).toEqual({ name: 'ProxyContract', abi: [VALID_ABI_ITEM] });
  });

  it('a proxy with a malformed implementation address returns the proxy own ABI and name, with exactly one request', async () => {
    const { transport, requests } = stubTransport(() => okResponse(proxyBody('not-an-address')));
    const adapter = abiSource().createEtherscanAbiSource(
      transport,
      stubSettings({ etherscanApiKey: API_KEY, chainId: 1 }),
    );

    await adapter.getAbi(PROXY);

    expect(requests).toHaveLength(1);
  });

  it('a proxy whose implementation address equals its own (a different casing of the same address) returns the proxy own ABI and name, with exactly one request', async () => {
    const proxyMixedCase = '0x0000000000000000000000000000000000000A';
    const proxyLowerCase = proxyMixedCase.toLowerCase();
    const { transport, requests } = stubTransport(() => okResponse(proxyBody(proxyLowerCase)));
    const adapter = abiSource().createEtherscanAbiSource(
      transport,
      stubSettings({ etherscanApiKey: API_KEY, chainId: 1 }),
    );

    await adapter.getAbi(proxyMixedCase);

    expect(requests).toHaveLength(1);
  });

  // CR-02 (06-REVIEW.md): before the fix, an implementation follow that ERRORED (as opposed to
  // genuinely resolving as not-verified) fell through to the proxy's own ABI, labelled
  // 'verified' — and asrcCachedLookup then persisted that partial answer to BOTH tiers for the
  // full 7-day TTL over what was only a transient failure. A transport failure on the follow is
  // an error about the LOOKUP, not an answer about the contract (D-13/NET-08): the outer result
  // must be null, and nothing may reach either cache tier under the proxy's own key.
  it('CR-02: an implementation follow that returns a transport failure makes the outer result null, and writes nothing to either cache tier', async () => {
    const { transport, requests } = stubTransportSequence([
      () => okResponse(proxyBody(IMPL_MIXED)),
      () => ({ status: 0, body: '', json: null, attempts: 4, ok: false, error: 'boom' }),
    ]);
    const adapter = abiSource().createEtherscanAbiSource(
      transport,
      stubSettings({ etherscanApiKey: API_KEY, chainId: 1 }),
    );

    const result = await adapter.getAbi(PROXY);

    expect(requests).toHaveLength(2);
    expect(result).toBeNull();
    expect(window.localStorage.getItem(`dxdecode:abi:1:${PROXY}`)).toBeNull();

    // A second lookup on the SAME adapter instance (its memory tier) must ask again — an
    // 'error' outcome is never written to the memory tier, unlike a genuine 'not-verified'
    // answer (06-04's own three-way caching policy tests, above).
    await adapter.getAbi(PROXY);
    expect(requests.length).toBeGreaterThan(2);
  });

  // The genuine positive case stays exactly as it was: a follow that resolves as NOT verified
  // (as opposed to erroring) is a real answer, and the proxy's own ABI IS the honest whole
  // answer — falls through, gets cached as 'verified' under the proxy's own key, same as before
  // CR-02's fix.
  it('an implementation follow that resolves as not-verified (a real answer, not a lookup error) still falls through to the proxy own ABI and name, with exactly two requests', async () => {
    const { transport, requests } = stubTransportSequence([
      () => okResponse(proxyBody(IMPL_MIXED)),
      () => okResponse(implBody({ ABI: 'Contract source code not verified' })),
    ]);
    const adapter = abiSource().createEtherscanAbiSource(
      transport,
      stubSettings({ etherscanApiKey: API_KEY, chainId: 1 }),
    );

    const result = await adapter.getAbi(PROXY);

    expect(requests).toHaveLength(2);
    expect(result).toEqual({ name: 'ProxyContract', abi: [VALID_ABI_ITEM] });
    expect(window.localStorage.getItem(`dxdecode:abi:1:${PROXY}`)).not.toBeNull();
  });

  // CR-02: the implementation follow's own signal firing (the abort scenario CR-01 makes
  // deterministic — a same-turn second decode press) is one concrete way the follow reports
  // 'error' rather than 'not-verified'; asserted here directly against an already-aborted
  // signal so the test does not depend on CR-01's timing fix to prove this half of CR-02.
  it('CR-02: an implementation follow whose signal is already aborted also makes the outer result null, never a proxy-only verified answer', async () => {
    const controller = new AbortController();
    const { transport, requests } = stubTransportSequence([
      () => okResponse(proxyBody(IMPL_MIXED)),
      () => {
        controller.abort();
        return { status: 0, body: '', json: null, attempts: 0, ok: false, error: 'aborted' };
      },
    ]);
    const adapter = abiSource().createEtherscanAbiSource(
      transport,
      stubSettings({ etherscanApiKey: API_KEY, chainId: 1 }),
    );

    const result = await adapter.getAbi(PROXY, { signal: controller.signal });

    expect(requests).toHaveLength(2);
    expect(result).toBeNull();
    expect(window.localStorage.getItem(`dxdecode:abi:1:${PROXY}`)).toBeNull();
  });

  it('a proxy chain two levels deep issues at most two requests total — the implementation is itself reported as a proxy but is not followed again', async () => {
    const IMPL_2 = '0x0000000000000000000000000000000000000b';
    const { transport, requests } = stubTransportSequence([
      () => okResponse(proxyBody(IMPL_LOWER)),
      () => okResponse(proxyBody(IMPL_2, { ContractName: 'ImplAlsoProxy' })),
    ]);
    const adapter = abiSource().createEtherscanAbiSource(
      transport,
      stubSettings({ etherscanApiKey: API_KEY, chainId: 1 }),
    );

    await adapter.getAbi(PROXY);

    expect(requests).toHaveLength(2);
  });
});

describe('asrcNormalizeAddress and asrcValidFunctionItems — direct unit coverage', () => {
  it('accepts a case-insensitive 20-byte hex address and normalises it to lowercase', () => {
    expect(abiSource().asrcNormalizeAddress('0xABCDEF1234567890ABCDEF1234567890ABCDEF12')).toBe(
      '0xabcdef1234567890abcdef1234567890abcdef12',
    );
  });

  it('rejects a value that is not 20-byte hex', () => {
    expect(abiSource().asrcNormalizeAddress('not-an-address')).toBeNull();
    expect(abiSource().asrcNormalizeAddress('0x1234')).toBeNull();
    expect(abiSource().asrcNormalizeAddress(undefined)).toBeNull();
  });

  it('recurses through components when validating a tuple-shaped input', () => {
    const withValidTuple = [
      {
        name: 'f',
        type: 'function',
        inputs: [{ name: 't', type: 'tuple', components: [{ name: 'x', type: 'uint256' }] }],
      },
    ];
    expect(abiSource().asrcValidFunctionItems(withValidTuple)).toEqual(withValidTuple);

    const withInvalidTuple = [
      {
        name: 'f',
        type: 'function',
        inputs: [{ name: 't', type: 'tuple', components: [{ name: 'x' }] }],
      },
    ];
    expect(abiSource().asrcValidFunctionItems(withInvalidTuple)).toBeNull();
  });
});

// ── Task 3: the composition root wires abis from the SAME transport as signatures ────────────
//
// The composition root (ui.ts's createDecodeAdapters) is not exposed on DxDecodeUiTestHooks, so
// it cannot be called and inspected directly (types.d.ts's own comment on that interface).
// Asserted by stubbing instead: window.DxDecode.transport.createTransport is replaced with a
// counting stub that returns one recognisable transport object, and
// window.DxDecode.core.createDecodeService is replaced with a stub that captures its options
// argument — then the mount is driven for real, through init(), exactly as the shipped app
// would.
describe('composition root — abis and signatures both built from the ONE constructed transport (Task 3)', () => {
  function loadTemplate(): string {
    return readFileSync(resolve(__dirname, '../src/dapps/decode/template.html'), 'utf-8');
  }

  function loadManifestDependencies(): string[] {
    const manifest = JSON.parse(readFileSync(resolve(__dirname, '../src/dapps/decode/manifest.json'), 'utf-8')) as {
      dependencies: string[];
    };
    return manifest.dependencies.map((dep) => `../src/${dep}`);
  }

  // A dx double supplying BOTH settings this adapter needs, via the same
  // getSections()/get(sectionId, key) shape test/decode-ui.test.ts's own stubDx uses — enough
  // for the real (unstubbed) createEtherscanAbiSource to actually issue a request through
  // whatever transport it was built from.
  function stubDxWithCredentials(): unknown {
    const store: Record<string, unknown> = {
      'probe-section\0etherscanApiKey': 'composition-test-key',
      'probe-section\0chainId': 1,
    };
    return {
      settings: {
        getSections: () => [{ id: 'probe-section', definitions: [{ key: 'etherscanApiKey' }, { key: 'chainId' }] }],
        get: (sectionId: string, key: string) => store[`${sectionId}\0${key}`],
      },
    };
  }

  it('exactly one transport is constructed, and the captured DecodeService options carry an abis and a signatures both routed through it', async () => {
    for (const dep of loadManifestDependencies()) loadCompiled(dep);

    let transportConstructCount = 0;
    const requestLog: HttpRequest[] = [];
    const recognisableTransport: TransportPort = {
      async request(req: HttpRequest): Promise<HttpResponse> {
        requestLog.push(req);
        return { status: 200, body: '{}', json: {}, attempts: 1, ok: true };
      },
    };
    window.DxDecode!.transport!.createTransport = ((..._args: unknown[]) => {
      transportConstructCount++;
      return recognisableTransport;
    }) as typeof window.DxDecode.transport.createTransport;

    let capturedOptions: DecodeServiceOptions | undefined;
    window.DxDecode!.core!.createDecodeService = ((options: DecodeServiceOptions) => {
      capturedOptions = options;
      return { decode: async () => ({ node: { label: 'composition-stub' } }) };
    }) as typeof window.DxDecode.core.createDecodeService;

    const container = document.createElement('div');
    container.innerHTML = loadTemplate();
    document.body.append(container);
    const cleanup = (window.DxDecode!.ui!.init as (c: HTMLElement, dx: unknown) => () => void)(
      container,
      stubDxWithCredentials(),
    );

    expect(transportConstructCount).toBe(1);
    expect(capturedOptions?.abis).toBeDefined();
    expect(capturedOptions?.signatures).toBeDefined();

    // Both routed through the SAME recognisable transport — proven by actually exercising each
    // and observing the stub's own request log grow, rather than only asserting each is truthy.
    requestLog.length = 0;
    await capturedOptions!.signatures!.lookup('0x00000000');
    expect(requestLog.length).toBeGreaterThan(0);

    requestLog.length = 0;
    await capturedOptions!.abis!.getAbi('0x0000000000000000000000000000000000000001');
    expect(requestLog.length).toBe(1);

    cleanup();
    container.remove();
  });
});
