import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

// Plan 05 Task 1 — the transaction-lookup adapter, entirely against a stubbed TransportPort. No
// test in this file performs a real request (D-32/TST-03). Loads the compiled modules in
// dependency order, matching test/decode-abi-source.test.ts's own idiom — abi-source.js is
// loaded too, purely so tx-source.js's feature-detected reuse of asrcNormalizeAddress and
// asrcIsFailureEnvelope resolves to the real helpers rather than the mirrored fallback.
function loadCompiled(relPath: string): void {
  const code = readFileSync(resolve(__dirname, relPath), 'utf-8');
  new Function('window', code)(window);
}

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
  loadCompiled('../src/dapps/decode/tx-source.js');
});

interface TxSourceModule {
  txsCreateAdapter(transport: TransportPort, settings: SettingsPort): TxSourcePort;
  txsIsUsableEndpoint(rpcUrl: unknown): boolean;
  txsComposeLogUrl(rpcUrl: string): string;
  txsNormalizeAddress(value: unknown): string | null;
  txsParseTransaction(result: unknown): unknown;
}

function txSource(): TxSourceModule {
  return window.DxDecode!.txSource as unknown as TxSourceModule;
}

// Mirrors test/decode-abi-source.test.ts's own stubTransport.
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

function failResponse(error: string): HttpResponse {
  return { status: 0, body: '', json: null, attempts: 1, ok: false, error };
}

function stubSettings(store: Record<string, unknown>): SettingsPort {
  return { get: (key: string) => store[key] };
}

const HASH = `0x${'ab'.repeat(32)}`;
const RECIPIENT_LOWER = '0x0000000000000000000000000000000000000001';
const RECIPIENT_CHECKSUMMED = '0x0000000000000000000000000000000000000001';
const SENDER_LOWER = '0x0000000000000000000000000000000000000002';
const RPC_URL = 'https://user-node.example.test/rpc';
const API_KEY = 'test-etherscan-key';

function rpcResult(overrides: Partial<{ to: string | null; from: string; input: string }> = {}) {
  return {
    jsonrpc: '2.0',
    id: 1,
    result: {
      to: RECIPIENT_LOWER,
      from: SENDER_LOWER,
      input: '0xa9059cbb',
      ...overrides,
    },
  };
}

describe('txsCreateAdapter — leg order and credential gating', () => {
  it('with neither an endpoint nor a key configured, issues zero transport calls and names both settings', async () => {
    const { transport, requests } = stubTransport(() => okResponse({}));
    const adapter = txSource().txsCreateAdapter(transport, stubSettings({}));

    const result = await adapter.getTransaction(HASH);

    expect(requests).toHaveLength(0);
    expect(result.unavailable).toBe(true);
    expect(result.reason).toContain('RPC endpoint');
    expect(result.reason).toContain('API key');
  });

  it('tries the endpoint leg first and the explorer leg second, by inspecting the call log', async () => {
    const { transport, requests } = stubTransportSequence([
      () => failResponse('endpoint refused'),
      () => okResponse(rpcResult()),
    ]);
    const adapter = txSource().txsCreateAdapter(
      transport,
      stubSettings({ rpcUrl: RPC_URL, etherscanApiKey: API_KEY, chainId: 1 }),
    );

    const result = await adapter.getTransaction(HASH);

    expect(requests).toHaveLength(2);
    expect(requests[0].url).toBe(RPC_URL);
    expect(requests[0].method).toBe('POST');
    expect(new URL(requests[1].url).host).toBe('api.etherscan.io');
    expect(result.unavailable).toBe(false);
    expect(result.transaction?.to).toBe(RECIPIENT_LOWER);
  });

  it('an endpoint-only configuration with no chain id anywhere returns the transaction in exactly one request', async () => {
    const { transport, requests } = stubTransport(() => okResponse(rpcResult()));
    const adapter = txSource().txsCreateAdapter(transport, stubSettings({ rpcUrl: RPC_URL }));

    const result = await adapter.getTransaction(HASH);

    expect(requests).toHaveLength(1);
    expect(result.unavailable).toBe(false);
  });

  it('an endpoint URL configured that fails, with a key also configured, tries the explorer second', async () => {
    const { transport, requests } = stubTransportSequence([
      () => failResponse('the endpoint refused a browser request (no status, no readable body)'),
      () => okResponse(rpcResult()),
    ]);
    const adapter = txSource().txsCreateAdapter(
      transport,
      stubSettings({ rpcUrl: RPC_URL, etherscanApiKey: API_KEY, chainId: 1 }),
    );

    const result = await adapter.getTransaction(HASH);

    expect(requests).toHaveLength(2);
    expect(result.unavailable).toBe(false);
  });
});

describe('txsCreateAdapter — the endpoint leg', () => {
  it('issues a POST whose body names the method and carries the hash as its single parameter, with a JSON content type', async () => {
    const { transport, requests } = stubTransport(() => okResponse(rpcResult()));
    const adapter = txSource().txsCreateAdapter(transport, stubSettings({ rpcUrl: RPC_URL }));

    await adapter.getTransaction(HASH);

    expect(requests).toHaveLength(1);
    const body = JSON.parse(requests[0].body!);
    expect(body.method).toBe('eth_getTransactionByHash');
    expect(body.params).toEqual([HASH]);
    expect(requests[0].headers?.['Content-Type']).toBe('application/json');
  });

  it("carries a logUrl containing the endpoint's origin and neither its query string nor its userinfo", async () => {
    // Built by concatenation rather than one literal — a fixture exercising the userinfo/query
    // masking path, not a real credential; see this suite's own REAL_API_KEY-shaped fixtures
    // elsewhere in this directory for the established convention.
    const userinfo = ['fixture-user', 'fixture-pass'].join(':');
    const secretUrl = `https://${userinfo}@user-node.example.test/v3/project-id?token=abc`;
    const { transport, requests } = stubTransport(() => okResponse(rpcResult()));
    const adapter = txSource().txsCreateAdapter(transport, stubSettings({ rpcUrl: secretUrl }));

    await adapter.getTransaction(HASH);

    const logUrl = requests[0].logUrl!;
    expect(logUrl).toContain('user-node.example.test');
    expect(logUrl).not.toContain('token=abc');
    expect(logUrl).not.toContain('fixture-pass');
    expect(logUrl).not.toContain('project-id');
  });

  it('a malformed configured endpoint skips the leg without a request and returns could-not-ask naming the setting when no explorer is available', async () => {
    const { transport, requests } = stubTransport(() => okResponse(rpcResult()));
    const adapter = txSource().txsCreateAdapter(transport, stubSettings({ rpcUrl: 'not a url' }));

    const result = await adapter.getTransaction(HASH);

    expect(requests).toHaveLength(0);
    expect(result.unavailable).toBe(true);
    expect(result.reason).toContain('endpoint URL');
  });

  it('a malformed configured endpoint falls through to the explorer when one is available', async () => {
    const { transport, requests } = stubTransport(() => okResponse(rpcResult()));
    const adapter = txSource().txsCreateAdapter(
      transport,
      stubSettings({ rpcUrl: 'not a url', etherscanApiKey: API_KEY, chainId: 1 }),
    );

    const result = await adapter.getTransaction(HASH);

    expect(requests).toHaveLength(1);
    expect(new URL(requests[0].url).host).toBe('api.etherscan.io');
    expect(result.unavailable).toBe(false);
  });

  it('a null result (asked and missed) is distinct from could-not-ask', async () => {
    const { transport } = stubTransport(() => okResponse({ jsonrpc: '2.0', id: 1, result: null }));
    const adapter = txSource().txsCreateAdapter(transport, stubSettings({ rpcUrl: RPC_URL }));

    const result = await adapter.getTransaction(HASH);

    expect(result.unavailable).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  // A 200 with no `result` member AND no `error` member is not a JSON-RPC answer at all — a
  // reverse-proxy health page, a JSON array, a bare envelope. Treated as 'missed' it was the FINAL
  // answer, so the configured explorer key was never consulted and a real transaction was reported
  // unknown.
  it('a 200 body with neither result nor error falls through to the explorer instead of missing', async () => {
    const { transport, requests } = stubTransportSequence([
      () => okResponse({ ok: true }),
      () => okResponse(rpcResult()),
    ]);
    const adapter = txSource().txsCreateAdapter(
      transport,
      stubSettings({ rpcUrl: RPC_URL, etherscanApiKey: API_KEY, chainId: 1 }),
    );

    const result = await adapter.getTransaction(HASH);

    expect(requests).toHaveLength(2);
    expect(new URL(requests[1].url).host).toBe('api.etherscan.io');
    expect(result.unavailable).toBe(false);
  });

  it('a resultless body with no explorer configured names the malformed response rather than reporting a miss', async () => {
    const { transport } = stubTransport(() => okResponse({ jsonrpc: '2.0', id: 1 }));
    const adapter = txSource().txsCreateAdapter(transport, stubSettings({ rpcUrl: RPC_URL }));

    const result = await adapter.getTransaction(HASH);

    expect(result.unavailable).toBe(true);
    expect(result.reason).toContain('malformed');
  });

  it('a transport-level failure reports could-not-ask with the transport error as the reason', async () => {
    const { transport } = stubTransport(() => failResponse('the endpoint refused a browser request'));
    const adapter = txSource().txsCreateAdapter(transport, stubSettings({ rpcUrl: RPC_URL }));

    const result = await adapter.getTransaction(HASH);

    expect(result.unavailable).toBe(true);
    expect(result.reason).toContain('refused');
  });

  it('a response that already resolved to a JSON-RPC error (ok: false, as Task 0s transport produces) reports could-not-ask with its message', async () => {
    const { transport } = stubTransport(() => failResponse('execution reverted'));
    const adapter = txSource().txsCreateAdapter(transport, stubSettings({ rpcUrl: RPC_URL }));

    const result = await adapter.getTransaction(HASH);

    expect(result.unavailable).toBe(true);
    expect(result.reason).toBe('execution reverted');
  });

  it('a malformed body returns could-not-ask and does not throw', async () => {
    const { transport } = stubTransport(() => ({
      status: 200,
      body: 'not json',
      json: 'not an object' as unknown,
      attempts: 1,
      ok: true,
    }));
    const adapter = txSource().txsCreateAdapter(transport, stubSettings({ rpcUrl: RPC_URL }));

    await expect(adapter.getTransaction(HASH)).resolves.toMatchObject({ unavailable: true });
  });
});

describe('txsCreateAdapter — the explorer leg', () => {
  it('sets no logUrl (its key is masked by the transport own query-name rule)', async () => {
    const { transport, requests } = stubTransport(() => okResponse(rpcResult()));
    const adapter = txSource().txsCreateAdapter(transport, stubSettings({ etherscanApiKey: API_KEY, chainId: 1 }));

    await adapter.getTransaction(HASH);

    expect(requests[0].logUrl).toBeUndefined();
  });

  it("maps the explorer's own in-body failure envelope (status '0', bare-string result) to could-not-ask with its message", async () => {
    const { transport } = stubTransport(() => okResponse({ status: '0', message: 'NOTOK', result: 'Invalid API Key' }));
    const adapter = txSource().txsCreateAdapter(transport, stubSettings({ etherscanApiKey: API_KEY, chainId: 1 }));

    const result = await adapter.getTransaction(HASH);

    expect(result.unavailable).toBe(true);
    expect(result.reason).toBe('Invalid API Key');
  });

  it('a null result (asked and missed) is distinct from could-not-ask', async () => {
    const { transport } = stubTransport(() => okResponse({ jsonrpc: '2.0', id: 1, result: null }));
    const adapter = txSource().txsCreateAdapter(transport, stubSettings({ etherscanApiKey: API_KEY, chainId: 1 }));

    const result = await adapter.getTransaction(HASH);

    expect(result.unavailable).toBe(true);
    expect(result.reason).toBeUndefined();
  });
});

describe('txsCreateAdapter — validation and normalisation', () => {
  it('a checksummed recipient and sender are accepted and lowercased', async () => {
    const { transport } = stubTransport(() => okResponse(rpcResult({ to: RECIPIENT_CHECKSUMMED, from: SENDER_LOWER })));
    const adapter = txSource().txsCreateAdapter(transport, stubSettings({ rpcUrl: RPC_URL }));

    const result = await adapter.getTransaction(HASH);

    expect(result.transaction?.to).toBe(RECIPIENT_LOWER);
    expect(result.transaction?.from).toBe(SENDER_LOWER);
  });

  it('a recipient failing a case-insensitive 20-byte hex test is rejected', async () => {
    const { transport } = stubTransport(() => okResponse(rpcResult({ to: '0xnothex' })));
    const adapter = txSource().txsCreateAdapter(transport, stubSettings({ rpcUrl: RPC_URL }));

    const result = await adapter.getTransaction(HASH);

    expect(result.unavailable).toBe(true);
  });

  it('a null recipient (contract creation) passes through as null rather than being rejected', async () => {
    const { transport } = stubTransport(() => okResponse(rpcResult({ to: null })));
    const adapter = txSource().txsCreateAdapter(transport, stubSettings({ rpcUrl: RPC_URL }));

    const result = await adapter.getTransaction(HASH);

    expect(result.unavailable).toBe(false);
    expect(result.transaction?.to).toBeNull();
  });

  it('a non-hex or odd-length input is rejected', async () => {
    const { transport } = stubTransport(() => okResponse(rpcResult({ input: '0xabc' })));
    const adapter = txSource().txsCreateAdapter(transport, stubSettings({ rpcUrl: RPC_URL }));

    const result = await adapter.getTransaction(HASH);

    expect(result.unavailable).toBe(true);
  });

  it('a supplied hash that is not 32-byte hex issues no request at all', async () => {
    const { transport, requests } = stubTransport(() => okResponse(rpcResult()));
    const adapter = txSource().txsCreateAdapter(transport, stubSettings({ rpcUrl: RPC_URL }));

    const result = await adapter.getTransaction('0xdead');

    expect(requests).toHaveLength(0);
    expect(result.unavailable).toBe(true);
  });
});

describe('txsCreateAdapter — cancellation', () => {
  it('every request carries the supplied signal', async () => {
    const { transport, requests } = stubTransportSequence([() => failResponse('nope'), () => okResponse(rpcResult())]);
    const adapter = txSource().txsCreateAdapter(
      transport,
      stubSettings({ rpcUrl: RPC_URL, etherscanApiKey: API_KEY, chainId: 1 }),
    );
    const controller = new AbortController();

    await adapter.getTransaction(HASH, { signal: controller.signal });

    expect(requests).toHaveLength(2);
    for (const req of requests) {
      expect(req.signal).toBe(controller.signal);
    }
  });

  it('an already-aborted signal issues no request at all', async () => {
    const { transport, requests } = stubTransport(() => okResponse(rpcResult()));
    const adapter = txSource().txsCreateAdapter(transport, stubSettings({ rpcUrl: RPC_URL }));
    const controller = new AbortController();
    controller.abort();

    const result = await adapter.getTransaction(HASH, { signal: controller.signal });

    expect(requests).toHaveLength(0);
    expect(result.unavailable).toBe(true);
  });
});

describe('tx-source.ts — directory conventions', () => {
  it('does not name this chain in its raw text and contains no import statement', () => {
    const source = readFileSync(resolve(__dirname, '../src/dapps/decode/tx-source.ts'), 'utf-8');
    expect(source).not.toMatch(/ethereum/i);
    expect(source).not.toMatch(/^import /m);
  });
});

// ── Plan 05 Task 3: the composition root wires txSource from the SAME transport as everything ─
// ── else — mirrors test/decode-abi-source.test.ts's own "composition root" describe block ─────
// ── exactly (Task 3 of Plan 06-03's own precedent), since ui.ts's createDecodeAdapters is not ──
// ── exposed on DxDecodeUiTestHooks and cannot be called and inspected directly. ────────────────

describe('composition root — txSource built from the ONE constructed transport, alongside signatures and abis (Plan 05 Task 3)', () => {
  function loadTemplate(): string {
    return readFileSync(resolve(__dirname, '../src/dapps/decode/template.html'), 'utf-8');
  }

  function loadManifestDependencies(): string[] {
    const manifest = JSON.parse(readFileSync(resolve(__dirname, '../src/dapps/decode/manifest.json'), 'utf-8')) as {
      dependencies: string[];
    };
    return manifest.dependencies.map((dep) => `../src/${dep}`);
  }

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

  it('exactly one transport is constructed, and the captured DecodeService options carry a txSource routed through it, alongside abis and signatures', async () => {
    for (const dep of loadManifestDependencies()) loadCompiled(dep);

    let transportConstructCount = 0;
    const requestLog: HttpRequest[] = [];
    const recognisableTransport: TransportPort = {
      async request(req: HttpRequest): Promise<HttpResponse> {
        requestLog.push(req);
        return {
          status: 200,
          body: '{}',
          json: { jsonrpc: '2.0', id: 1, result: null },
          attempts: 1,
          ok: true,
        };
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
    expect(capturedOptions?.txSource).toBeDefined();
    expect(capturedOptions?.abis).toBeDefined();
    expect(capturedOptions?.signatures).toBeDefined();

    // Routed through the SAME recognisable transport — proven by exercising the transaction
    // source and observing the stub's own request log grow, exactly as the abi-source
    // composition test proves it for `abis`.
    requestLog.length = 0;
    await capturedOptions!.txSource!.getTransaction(HASH);
    expect(requestLog.length).toBe(1);

    cleanup();
    container.remove();
  });
});
