import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NET-01..NET-07/TST-04 — the transport suite. Every test here stubs the network primitive
// (`vi.stubGlobal('fetch', ...)`) and, where timing matters, the clock too (`vi.useFakeTimers`);
// no test performs a real request or waits on a real timer, per D-32/TST-04. Loads the compiled
// core.js first (transport.ts writes into the LogPort shape core.ts declares) then transport.js,
// matching test/decode-eth-calldata.test.ts's own `new Function('window', code)(window)` idiom.
function loadCompiled(relPath: string): void {
  const code = readFileSync(resolve(__dirname, relPath), 'utf-8');
  new Function('window', code)(window);
}

beforeEach(() => {
  loadCompiled('../src/dapps/decode/core.js');
  loadCompiled('../src/dapps/decode/transport.js');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function transportModule(): {
  createTransport: (options: { log: LogPort; rps?: number }) => TransportPort;
  NET_REDACTED: string;
  NET_DEFAULT_RPS: number;
  NET_MAX_CONCURRENCY: number;
  NET_BODY_LIMIT_BYTES: number;
  NET_MAX_ATTEMPTS: number;
  NET_BACKOFF_BASE_MS: number;
  NET_RETRY_AFTER_MIN_MS: number;
  NET_RETRY_AFTER_MAX_MS: number;
  netParseRetryAfter: (value: string) => number | null;
} {
  return window.DxDecode!.transport as unknown as ReturnType<typeof transportModule>;
}

function makeLog(): { log: LogPort; entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  const log: LogPort = {
    record(entry) {
      entries.push(entry);
    },
    subscribe(cb) {
      cb(entries);
      return () => undefined;
    },
    clear() {
      entries.length = 0;
    },
  };
  return { log, entries };
}

// Walks every value reachable from an object (own enumerable properties, recursively into
// plain objects) — used to prove a secret is absent from the WHOLE stored LogEntry, not just
// the field a naive test would think to check (D-24, Pitfall 5).
function collectAllValues(value: unknown, out: unknown[] = []): unknown[] {
  out.push(value);
  if (value !== null && typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) {
      collectAllValues(v, out);
    }
  }
  return out;
}

const REAL_API_KEY = 'sk-super-secret-key-value';

describe('transport — one successful GET (Task 1)', () => {
  it('resolves with status, body, json, attempts: 1, ok: true', async () => {
    const { log } = makeLog();
    const fetchMock = vi.fn(() => Promise.resolve(new Response('{"hello":"world"}', { status: 200 })));
    vi.stubGlobal('fetch', fetchMock);

    const transport = transportModule().createTransport({ log });
    const result = await transport.request({ method: 'GET', url: 'https://api.example.test/x' });

    expect(result.status).toBe(200);
    expect(result.body).toBe('{"hello":"world"}');
    expect(result.json).toEqual({ hello: 'world' });
    expect(result.attempts).toBe(1);
    expect(result.ok).toBe(true);
  });

  it('records exactly one LogEntry, with the api key redacted from every field of the stored object', async () => {
    const { log, entries } = makeLog();
    const fetchMock = vi.fn(() => Promise.resolve(new Response('{}', { status: 200 })));
    vi.stubGlobal('fetch', fetchMock);

    const transport = transportModule().createTransport({ log });
    await transport.request({
      method: 'GET',
      url: 'https://api.example.test/v2/api',
      query: { chainid: '1', apikey: REAL_API_KEY },
    });

    expect(entries).toHaveLength(1);
    const allValues = collectAllValues(entries[0]);
    expect(allValues).not.toContain(REAL_API_KEY);
    // The stored url is a valid, re-parseable URL — its apikey param decodes to the sentinel,
    // never the real key, regardless of how URLSearchParams percent-encodes the sentinel text.
    expect(new URL(entries[0].url!).searchParams.get('apikey')).toBe(transportModule().NET_REDACTED);
    expect(entries[0].query?.apikey).toBe(transportModule().NET_REDACTED);
  });

  it('an Authorization header is redacted by value, keeping the header name, absent from every field', async () => {
    const { log, entries } = makeLog();
    const fetchMock = vi.fn(() => Promise.resolve(new Response('{}', { status: 200 })));
    vi.stubGlobal('fetch', fetchMock);

    const transport = transportModule().createTransport({ log });
    // Synthetic — D-08 means no Phase 5 request actually sends this header; NET-07 names it
    // regardless, and this is what makes that promise checkable.
    await transport.request({
      method: 'GET',
      url: 'https://api.example.test/x',
      headers: { Authorization: `Bearer ${REAL_API_KEY}` },
    });

    expect(entries).toHaveLength(1);
    const allValues = collectAllValues(entries[0]);
    expect(allValues).not.toContain(`Bearer ${REAL_API_KEY}`);
    expect(entries[0].requestHeaders?.Authorization).toBe(transportModule().NET_REDACTED);
    expect(Object.keys(entries[0].requestHeaders ?? {})).toContain('Authorization');
  });

  it('a query with no api key records the url unchanged', async () => {
    const { log, entries } = makeLog();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('{}', { status: 200 }))),
    );

    const transport = transportModule().createTransport({ log });
    await transport.request({ method: 'GET', url: 'https://api.example.test/x', query: { foo: 'bar' } });

    expect(entries[0].url).toBe('https://api.example.test/x?foo=bar');
  });

  it('a request with no query parameters records a path with no question mark', async () => {
    const { log, entries } = makeLog();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('{}', { status: 200 }))),
    );

    const transport = transportModule().createTransport({ log });
    await transport.request({ method: 'GET', url: 'https://api.example.test/plain' });

    expect(entries[0].path).not.toContain('?');
    expect(entries[0].path).toBe('/plain');
  });

  it('a request with no headers at all leaves requestHeaders absent, never an empty object or "undefined"', async () => {
    const { log, entries } = makeLog();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('{}', { status: 200 }))),
    );

    const transport = transportModule().createTransport({ log });
    await transport.request({ method: 'GET', url: 'https://api.example.test/x' });

    expect(entries[0].requestHeaders).toBeUndefined();
  });

  it('a request with no body records requestBody as absent, never the string "undefined"', async () => {
    const { log, entries } = makeLog();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('{}', { status: 200 }))),
    );

    const transport = transportModule().createTransport({ log });
    await transport.request({ method: 'GET', url: 'https://api.example.test/x' });

    expect(entries[0].requestBody).toBeUndefined();
  });

  it('reads a truncated body through the bounded reader — a plain-object stub could never prove this', async () => {
    const { log, entries } = makeLog();
    const bigBody = 'x'.repeat(transportModule().NET_BODY_LIMIT_BYTES + 5000);
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(bigBody, { status: 200 }))),
    );

    const transport = transportModule().createTransport({ log });
    const result = await transport.request({ method: 'GET', url: 'https://api.example.test/big' });

    expect(result.body.length).toBeLessThan(bigBody.length);
    expect(entries[0].responseBody).toContain('truncated');
  });
});

describe('transport — rate limiting (NET-02)', () => {
  it('at 3 requests per second the 4th request inside one second is deferred', async () => {
    vi.useFakeTimers();
    const { log } = makeLog();
    const fetchMock = vi.fn(() => Promise.resolve(new Response('{}', { status: 200 })));
    vi.stubGlobal('fetch', fetchMock);

    const transport = transportModule().createTransport({ log, rps: 3 });
    const promises = [0, 1, 2, 3].map((n) =>
      transport.request({ method: 'GET', url: `https://api.example.test/rate/${n}` }),
    );

    await vi.advanceTimersByTimeAsync(10);
    expect(fetchMock.mock.calls.length).toBeLessThan(4);

    await vi.advanceTimersByTimeAsync(1000);
    await Promise.all(promises);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('at a configured rate of 1 the 2nd request is deferred', async () => {
    vi.useFakeTimers();
    const { log } = makeLog();
    const fetchMock = vi.fn(() => Promise.resolve(new Response('{}', { status: 200 })));
    vi.stubGlobal('fetch', fetchMock);

    const transport = transportModule().createTransport({ log, rps: 1 });
    const promises = [0, 1].map((n) => transport.request({ method: 'GET', url: `https://api.example.test/one/${n}` }));

    await vi.advanceTimersByTimeAsync(10);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000);
    await Promise.all(promises);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('transport — bounded concurrency (NET-02)', () => {
  it('never has more than NET_MAX_CONCURRENCY requests in flight under a larger burst', async () => {
    const { log } = makeLog();
    const NET_MAX_CONCURRENCY = transportModule().NET_MAX_CONCURRENCY;
    let active = 0;
    let maxActive = 0;
    const releasers: Array<() => void> = [];
    const fetchMock = vi.fn(() => {
      active++;
      maxActive = Math.max(maxActive, active);
      return new Promise<Response>((resolveFetch) => {
        releasers.push(() => {
          active--;
          resolveFetch(new Response('{}', { status: 200 }));
        });
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const transport = transportModule().createTransport({ log, rps: 1000 });
    const burstSize = NET_MAX_CONCURRENCY + 2;
    const promises = Array.from({ length: burstSize }, (_, i) =>
      transport.request({ method: 'GET', url: `https://api.example.test/burst/${i}` }),
    );

    for (let i = 0; i < 20 && fetchMock.mock.calls.length < NET_MAX_CONCURRENCY; i++) {
      await new Promise((r) => setTimeout(r, 0));
    }
    expect(fetchMock).toHaveBeenCalledTimes(NET_MAX_CONCURRENCY);

    while (releasers.length > 0) {
      const release = releasers.shift();
      release?.();
      await new Promise((r) => setTimeout(r, 0));
    }
    await Promise.all(promises);

    expect(maxActive).toBe(NET_MAX_CONCURRENCY);
    expect(fetchMock).toHaveBeenCalledTimes(burstSize);
  });
});

describe('transport — GET dedupe (NET-02)', () => {
  it('two identical in-flight GETs share one underlying request; a third after settle makes a fresh one', async () => {
    const { log } = makeLog();
    const fetchMock = vi.fn(() => Promise.resolve(new Response('{"n":1}', { status: 200 })));
    vi.stubGlobal('fetch', fetchMock);

    const transport = transportModule().createTransport({ log });
    const [a, b] = await Promise.all([
      transport.request({ method: 'GET', url: 'https://api.example.test/dedupe' }),
      transport.request({ method: 'GET', url: 'https://api.example.test/dedupe' }),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(a).toEqual(b);

    await transport.request({ method: 'GET', url: 'https://api.example.test/dedupe' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('transport — dedupe/abort attachment semantics (NET-02, NET-03)', () => {
  it('one of two callers on a deduplicated request aborting leaves the other intact; the stub is invoked once and its own signal never fires', async () => {
    const { log } = makeLog();
    let sawUnderlyingAbort = false;
    const fetchMock = vi.fn((_url: string, init: RequestInit) => {
      init.signal?.addEventListener('abort', () => {
        sawUnderlyingAbort = true;
      });
      return new Promise<Response>((resolveFetch) => {
        setTimeout(() => resolveFetch(new Response('{}', { status: 200 })), 10);
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const transport = transportModule().createTransport({ log });
    const controllerA = new AbortController();
    const controllerB = new AbortController();
    const pA = transport.request({
      method: 'GET',
      url: 'https://api.example.test/abort-one',
      signal: controllerA.signal,
    });
    const pB = transport.request({
      method: 'GET',
      url: 'https://api.example.test/abort-one',
      signal: controllerB.signal,
    });

    controllerA.abort();
    const resultA = await pA;
    expect(resultA.ok).toBe(false);

    const resultB = await pB;
    expect(resultB.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sawUnderlyingAbort).toBe(false);
  });

  it('both callers aborting a deduplicated request DOES fire the underlying signal', async () => {
    const { log } = makeLog();
    let sawUnderlyingAbort = false;
    const fetchMock = vi.fn((_url: string, init: RequestInit) => {
      init.signal?.addEventListener('abort', () => {
        sawUnderlyingAbort = true;
      });
      return new Promise<Response>((resolveFetch) => {
        setTimeout(() => resolveFetch(new Response('{}', { status: 200 })), 10);
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const transport = transportModule().createTransport({ log });
    const controllerA = new AbortController();
    const controllerB = new AbortController();
    const pA = transport.request({
      method: 'GET',
      url: 'https://api.example.test/abort-both',
      signal: controllerA.signal,
    });
    const pB = transport.request({
      method: 'GET',
      url: 'https://api.example.test/abort-both',
      signal: controllerB.signal,
    });

    // Let the shared request actually reach fetch() before aborting — this is the "both abort
    // WHILE the request is genuinely in flight" case the plan names, not a race against the
    // bucket/gate's own internal microtask resolution.
    for (let i = 0; i < 20 && fetchMock.mock.calls.length < 1; i++) {
      await new Promise((r) => setTimeout(r, 0));
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);

    controllerA.abort();
    controllerB.abort();
    const [resultA, resultB] = await Promise.all([pA, pB]);

    expect(resultA.ok).toBe(false);
    expect(resultB.ok).toBe(false);
    expect(sawUnderlyingAbort).toBe(true);
  });

  it('a caller attaching with an already-aborted signal never attaches at all', async () => {
    const { log } = makeLog();
    const fetchMock = vi.fn(() => Promise.resolve(new Response('{}', { status: 200 })));
    vi.stubGlobal('fetch', fetchMock);

    const transport = transportModule().createTransport({ log });
    const controller = new AbortController();
    controller.abort();
    const result = await transport.request({
      method: 'GET',
      url: 'https://api.example.test/pre-aborted',
      signal: controller.signal,
    });

    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('transport — retry, backoff, and Retry-After (Task 2, NET-03)', () => {
  it('retrying the same GET produces two log entries with attempt 1 and attempt 2, and never mutates the HttpRequest object', async () => {
    vi.useFakeTimers();
    const { log, entries } = makeLog();
    let call = 0;
    const fetchMock = vi.fn(() => {
      call++;
      return Promise.resolve(new Response('{}', { status: call < 2 ? 429 : 200 }));
    });
    vi.stubGlobal('fetch', fetchMock);

    const transport = transportModule().createTransport({ log });
    const query = { chainid: '1' };
    const headers = { 'x-trace': 'abc' };
    const req = { method: 'GET' as const, url: 'https://api.example.test/mutate-check', query, headers };
    const frozenReq = JSON.parse(JSON.stringify(req));

    const resultPromise = transport.request(req);
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(5000);
    }
    await resultPromise;

    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.attempt)).toEqual([1, 2]);
    expect(req.query).toBe(query);
    expect(req.headers).toBe(headers);
    expect(req).toEqual(frozenReq);
  });

  it('three 429s then a 200 resolves with attempts: 4, ok: true, and four LogEntry objects with attempt numbers 1..4', async () => {
    vi.useFakeTimers();
    const { log, entries } = makeLog();
    let call = 0;
    const fetchMock = vi.fn(() => {
      call++;
      return Promise.resolve(new Response('{}', { status: call < 4 ? 429 : 200 }));
    });
    vi.stubGlobal('fetch', fetchMock);

    const transport = transportModule().createTransport({ log });
    const resultPromise = transport.request({ method: 'GET', url: 'https://api.example.test/retry' });
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(5000);
    }
    const result = await resultPromise;

    expect(result.attempts).toBe(4);
    expect(result.ok).toBe(true);
    expect(entries).toHaveLength(4);
    expect(entries.map((e) => e.attempt)).toEqual([1, 2, 3, 4]);
  });

  it('four 429s resolves with ok: false, attempts: 4, a non-empty error, and never rejects; no 5th invocation', async () => {
    vi.useFakeTimers();
    const { log } = makeLog();
    const fetchMock = vi.fn(() => Promise.resolve(new Response('{}', { status: 429 })));
    vi.stubGlobal('fetch', fetchMock);

    const transport = transportModule().createTransport({ log });
    const resultPromise = transport.request({ method: 'GET', url: 'https://api.example.test/always-429' });
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(5000);
    }
    const result = await resultPromise;

    expect(result.ok).toBe(false);
    expect(result.attempts).toBe(4);
    expect(result.error).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('an Etherscan-shaped HTTP 200 rate-limit body is retried', async () => {
    vi.useFakeTimers();
    const { log } = makeLog();
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ status: '0', result: 'Max rate limit reached, please use API Key for higher rate limit' }),
          { status: 200 },
        ),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const transport = transportModule().createTransport({ log });
    const resultPromise = transport.request({ method: 'GET', url: 'https://api.example.test/etherscan-rate' });
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(5000);
    }
    const result = await resultPromise;

    expect(result.ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('an unrelated result string with status "0" is NOT retried', async () => {
    const { log } = makeLog();
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ status: '0', result: 'Contract source code not verified' }), { status: 200 }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const transport = transportModule().createTransport({ log });
    const result = await transport.request({ method: 'GET', url: 'https://api.example.test/etherscan-unverified' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.attempts).toBe(1);
  });

  it('the two D-10 wait-and-retry in-body strings are retried, and the message says to wait rather than that the key is wrong', async () => {
    vi.useFakeTimers();
    const { log } = makeLog();
    const waitAndRetryBodies = [
      'Too many invalid api key attempts, please try again later',
      'Free API access is not supported for this chain, contact us for a Growth plan subscription',
    ];
    for (const resultText of waitAndRetryBodies) {
      const fetchMock = vi.fn(() =>
        Promise.resolve(new Response(JSON.stringify({ status: '0', result: resultText }), { status: 200 })),
      );
      vi.stubGlobal('fetch', fetchMock);
      const transport = transportModule().createTransport({ log });
      const resultPromise = transport.request({ method: 'GET', url: 'https://api.example.test/wait-retry' });
      for (let i = 0; i < 4; i++) {
        await vi.advanceTimersByTimeAsync(5000);
      }
      const result = await resultPromise;

      expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
      expect(result.error?.toLowerCase()).toContain('wait');
      expect(result.error?.toLowerCase()).not.toContain('key is wrong');
      vi.unstubAllGlobals();
    }
  });

  it('an HTTP 500 is retried; an HTTP 404 is not', async () => {
    vi.useFakeTimers();
    const { log } = makeLog();
    const fetch500 = vi.fn(() => Promise.resolve(new Response('', { status: 500 })));
    vi.stubGlobal('fetch', fetch500);
    const transport500 = transportModule().createTransport({ log });
    const p500 = transport500.request({ method: 'GET', url: 'https://api.example.test/500' });
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(5000);
    }
    await p500;
    expect(fetch500).toHaveBeenCalledTimes(4);
    vi.unstubAllGlobals();

    const fetch404 = vi.fn(() => Promise.resolve(new Response('', { status: 404 })));
    vi.stubGlobal('fetch', fetch404);
    const transport404 = transportModule().createTransport({ log });
    const result404 = await transport404.request({ method: 'GET', url: 'https://api.example.test/404' });
    expect(fetch404).toHaveBeenCalledTimes(1);
    expect(result404.ok).toBe(false);
  });

  it('a rejected network primitive (CORS-refusal shape) is retried, and after the cap names the refusal rather than a generic network error', async () => {
    vi.useFakeTimers();
    const { log } = makeLog();
    const fetchMock = vi.fn(() => Promise.reject(new TypeError('Failed to fetch')));
    vi.stubGlobal('fetch', fetchMock);

    const transport = transportModule().createTransport({ log, rps: 1000 });
    const resultPromise = transport.request({ method: 'GET', url: 'https://user-rpc.example.test/' });
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(5000);
    }
    const result = await resultPromise;

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('refused a browser request');
  });

  it('netParseRetryAfter parses both allowed forms, rejects garbage, and clamps both boundaries', () => {
    const netParseRetryAfter = transportModule().netParseRetryAfter;

    expect(netParseRetryAfter('2')).toBe(2000);

    // HTTP-date is second-granularity (toUTCString() truncates sub-second precision), so the
    // parsed delta can be up to ~1s short of the nominal 2000ms depending on where within the
    // current second Date.now() falls — bounded below by 1s for that reason, not a precision bug.
    const twoSecondsFromNow = new Date(Date.now() + 2000).toUTCString();
    const parsedDate = netParseRetryAfter(twoSecondsFromNow)!;
    expect(parsedDate).toBeGreaterThanOrEqual(1000);
    expect(parsedDate).toBeLessThanOrEqual(2100);

    expect(netParseRetryAfter('not-a-number')).toBeNull();
    expect(netParseRetryAfter('0')).toBe(transportModule().NET_RETRY_AFTER_MIN_MS);
    expect(netParseRetryAfter('3600')).toBe(transportModule().NET_RETRY_AFTER_MAX_MS);
  });

  it('when Retry-After is absent — the production case for every host this project contacts — the wait comes from backoff and the log entry says it guessed', async () => {
    vi.useFakeTimers();
    const { log, entries } = makeLog();
    let call = 0;
    const fetchMock = vi.fn(() => {
      call++;
      return Promise.resolve(new Response('{}', { status: call < 2 ? 429 : 200 }));
    });
    vi.stubGlobal('fetch', fetchMock);

    const transport = transportModule().createTransport({ log });
    const resultPromise = transport.request({ method: 'GET', url: 'https://api.example.test/guessed-backoff' });
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(5000);
    }
    await resultPromise;

    expect(entries[0].error?.toLowerCase()).toContain('retry-after not exposed');
  });

  it('aborting the signal while a retry is sleeping resolves without invoking the stub again', async () => {
    vi.useFakeTimers();
    const { log } = makeLog();
    const fetchMock = vi.fn(() => Promise.resolve(new Response('{}', { status: 429 })));
    vi.stubGlobal('fetch', fetchMock);

    const transport = transportModule().createTransport({ log });
    const controller = new AbortController();
    const resultPromise = transport.request({
      method: 'GET',
      url: 'https://api.example.test/abort-during-sleep',
      signal: controller.signal,
    });

    await vi.advanceTimersByTimeAsync(10);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    controller.abort();
    const result = await resultPromise;
    expect(result.ok).toBe(false);

    await vi.advanceTimersByTimeAsync(5000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('transport — suite idempotency (TST-04)', () => {
  it('running the same assertions twice in this process yields identical results — no bucket/dedupe state leaks', async () => {
    for (let pass = 0; pass < 2; pass++) {
      loadCompiled('../src/dapps/decode/core.js');
      loadCompiled('../src/dapps/decode/transport.js');
      const { log } = makeLog();
      const fetchMock = vi.fn(() => Promise.resolve(new Response('{}', { status: 200 })));
      vi.stubGlobal('fetch', fetchMock);
      const transport = transportModule().createTransport({ log });
      const result = await transport.request({ method: 'GET', url: 'https://api.example.test/idempotent' });
      expect(result.ok).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      vi.unstubAllGlobals();
    }
  });
});
