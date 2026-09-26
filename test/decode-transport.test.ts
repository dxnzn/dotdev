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
  NET_DEFAULT_TIMEOUT_MS: number;
  NET_JSON_RPC_RATE_LIMIT_CODES: number[];
  NET_CREDENTIAL_QUERY_KEYS: string[];
  netParseRetryAfter: (value: string) => number | null;
} {
  return window.DxDecode!.transport as unknown as ReturnType<typeof transportModule>;
}

// Plan 05 Task 0: a fetch stub for the timeout tests below — never resolves on its own, but
// (like a real `fetch`) REJECTS the moment the signal it was handed aborts. A plain
// `new Promise<Response>(() => {})` — used elsewhere in this suite for "aborting a sleeping
// retry" — never settles even after abort, which is correct there (nothing awaits that promise
// again) but would hang a test whose whole point is that the timeout's abort causes the
// in-flight `fetch` call itself to reject.
function neverSettlingFetch(): (url: string, init?: RequestInit) => Promise<Response> {
  return (_url, init) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(new DOMException('The operation was aborted', 'AbortError'));
      });
    });
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

describe('transport — a shared abort taken while queued (CR, PR #1 review)', () => {
  // The loop-top abort check runs BEFORE bucket.take()/gate.acquire(), and the attempt's own abort
  // listener is armed AFTER them — and arming a listener on an already-aborted signal never replays
  // the event. So an abort landing in that window used to be invisible: the request went out with a
  // fresh, un-aborted attempt signal, spent a token, held a concurrency slot, and wrote a Log entry
  // for work every caller had detached from. Clearing or superseding a decode does exactly that to
  // a queue of ABI lookups.
  it('never reaches fetch, and writes no log entry, for a request aborted while waiting on the bucket', async () => {
    vi.useFakeTimers();
    const { log, entries } = makeLog();
    const fetchMock = vi.fn(() => Promise.resolve(new Response('{}', { status: 200 })));
    vi.stubGlobal('fetch', fetchMock);

    const transport = transportModule().createTransport({ log, rps: 1 });
    const first = transport.request({ method: 'GET', url: 'https://api.example.test/queued/0' });
    await vi.advanceTimersByTimeAsync(10);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const controller = new AbortController();
    const queued = transport.request({
      method: 'GET',
      url: 'https://api.example.test/queued/1',
      signal: controller.signal,
    });
    // The only attached caller detaches while the attempt sits in bucket.take().
    controller.abort();
    const aborted = await queued;
    expect(aborted.ok).toBe(false);

    // Tokens arrive. Nothing more may go out.
    await vi.advanceTimersByTimeAsync(3000);
    await first;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(entries.filter((entry) => entry.path.includes('/queued/1'))).toHaveLength(0);
  });

  it('a request whose caller stays attached still goes out after the same wait', async () => {
    vi.useFakeTimers();
    const { log } = makeLog();
    const fetchMock = vi.fn(() => Promise.resolve(new Response('{}', { status: 200 })));
    vi.stubGlobal('fetch', fetchMock);

    const transport = transportModule().createTransport({ log, rps: 1 });
    const first = transport.request({ method: 'GET', url: 'https://api.example.test/kept/0' });
    await vi.advanceTimersByTimeAsync(10);

    const controller = new AbortController();
    const queued = transport.request({
      method: 'GET',
      url: 'https://api.example.test/kept/1',
      signal: controller.signal,
    });

    await vi.advanceTimersByTimeAsync(3000);
    await Promise.all([first, queued]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
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

  // CR-01 (06-REVIEW.md): the map entry used to be removed only inside `runShared.finally`,
  // after the in-flight fetch's rejection landed — a later task. In the window between the last
  // caller's abort (which synchronously aborts the shared controller) and that rejection, a
  // second, identical GET issued in the SAME synchronous turn found and attached to the dying
  // entry, deterministically resolving `aborted`. The fix removes the entry the moment the
  // attached-caller count reaches zero, so a same-turn re-request starts fresh instead.
  it('CR-01: a same-turn identical GET after the sole caller aborts to zero starts a fresh request rather than attaching to the dying one', async () => {
    const { log } = makeLog();
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolveFetch) => {
          setTimeout(() => resolveFetch(new Response('{}', { status: 200 })), 10);
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const transport = transportModule().createTransport({ log });
    const controllerA = new AbortController();
    const pA = transport.request({
      method: 'GET',
      url: 'https://api.example.test/cr-01-same-turn',
      signal: controllerA.signal,
    });

    // The sole attached caller detaches — attachedCount reaches zero synchronously inside abort().
    controllerA.abort();

    // Issued in the SAME synchronous turn as the abort above, before the first shared request's
    // underlying fetch rejection has had any chance to run `runShared.finally`.
    const pB = transport.request({ method: 'GET', url: 'https://api.example.test/cr-01-same-turn' });

    const [resultA, resultB] = await Promise.all([pA, pB]);

    expect(resultA.ok).toBe(false);
    expect(resultB.ok).toBe(true);
    // ONE call, B's own — not two. A's attempt was still waiting on bucket.take() when its sole
    // caller detached, and the queued-abort check added for PR #1's review now catches exactly that
    // window, so A's request is never issued at all. CR-01's property is unchanged and is what the
    // two assertions above state: B started fresh instead of attaching to the dying entry.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toContain('/cr-01-same-turn');
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

describe('transport — request timeout (Plan 05 Task 0, T-06-20)', () => {
  it('a request whose response never settles resolves with a transport-level failure rather than hanging', async () => {
    vi.useFakeTimers();
    const { log } = makeLog();
    const fetchMock = vi.fn(neverSettlingFetch());
    vi.stubGlobal('fetch', fetchMock);

    const transport = transportModule().createTransport({ log });
    const resultPromise = transport.request({
      method: 'GET',
      url: 'https://api.example.test/never-settles',
      timeoutMs: 1000,
    });

    for (let i = 0; i < 8; i++) {
      await vi.advanceTimersByTimeAsync(2000);
    }
    const result = await resultPromise;

    expect(result.ok).toBe(false);
    expect(result.error).toContain('timed out');
  });

  it('a first attempt that times out and a second that responds resolves successfully with attempts: 2', async () => {
    vi.useFakeTimers();
    const { log, entries } = makeLog();
    let call = 0;
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      call++;
      if (call === 1) return neverSettlingFetch()(url, init);
      return Promise.resolve(new Response('{"ok":true}', { status: 200 }));
    });
    vi.stubGlobal('fetch', fetchMock);

    const transport = transportModule().createTransport({ log });
    const resultPromise = transport.request({
      method: 'GET',
      url: 'https://api.example.test/timeout-then-ok',
      timeoutMs: 1000,
    });

    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(2000);
    }
    const result = await resultPromise;

    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(2);
    expect(entries).toHaveLength(2);
  });

  it('a request timing out on every attempt reports the full attempt cap, not 1', async () => {
    vi.useFakeTimers();
    const { log } = makeLog();
    const fetchMock = vi.fn(neverSettlingFetch());
    vi.stubGlobal('fetch', fetchMock);

    const transport = transportModule().createTransport({ log });
    const resultPromise = transport.request({
      method: 'GET',
      url: 'https://api.example.test/always-times-out',
      timeoutMs: 1000,
    });

    for (let i = 0; i < 8; i++) {
      await vi.advanceTimersByTimeAsync(2000);
    }
    const result = await resultPromise;

    expect(result.ok).toBe(false);
    expect(result.attempts).toBe(transportModule().NET_MAX_ATTEMPTS);
  });

  it('a request that waits in the rate-limiter queue longer than its own timeout still succeeds once dequeued', async () => {
    vi.useFakeTimers();
    const { log } = makeLog();
    const fetchMock = vi.fn(() => Promise.resolve(new Response('{}', { status: 200 })));
    vi.stubGlobal('fetch', fetchMock);

    const transport = transportModule().createTransport({ log, rps: 1 });
    const first = transport.request({
      method: 'GET',
      url: 'https://api.example.test/queue-first',
      timeoutMs: 500,
    });
    const second = transport.request({
      method: 'GET',
      url: 'https://api.example.test/queue-second',
      timeoutMs: 500,
    });

    await vi.advanceTimersByTimeAsync(1000);
    const [r1, r2] = await Promise.all([first, second]);

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
  });

  it('the timeout error text is distinguishable from a caller-abort error text and from the plain "aborted" shared text', async () => {
    vi.useFakeTimers();
    const { log } = makeLog();
    const fetchMock = vi.fn(neverSettlingFetch());
    vi.stubGlobal('fetch', fetchMock);

    const transport = transportModule().createTransport({ log });
    const timedOutPromise = transport.request({
      method: 'GET',
      url: 'https://api.example.test/distinguish-timeout',
      timeoutMs: 1000,
    });
    for (let i = 0; i < 8; i++) {
      await vi.advanceTimersByTimeAsync(2000);
    }
    const timedOut = await timedOutPromise;

    const controller = new AbortController();
    const callerAbortPromise = transport.request({
      method: 'GET',
      url: 'https://api.example.test/distinguish-caller-abort',
      signal: controller.signal,
    });
    controller.abort();
    const callerAborted = await callerAbortPromise;
    await vi.advanceTimersByTimeAsync(2000);

    expect(timedOut.error).toContain('timed out');
    expect(timedOut.error).not.toBe(callerAborted.error);
    expect(timedOut.error).not.toBe('aborted');
    expect(callerAborted.error).not.toContain('timed out');
  });

  it('a request with no declared timeout uses the module default of 30000ms', async () => {
    expect(transportModule().NET_DEFAULT_TIMEOUT_MS).toBe(30000);

    vi.useFakeTimers();
    const { log } = makeLog();
    const fetchMock = vi.fn(neverSettlingFetch());
    vi.stubGlobal('fetch', fetchMock);

    const transport = transportModule().createTransport({ log });
    const resultPromise = transport.request({ method: 'GET', url: 'https://api.example.test/default-timeout' });

    await vi.advanceTimersByTimeAsync(29000);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Every attempt gets the full 30000ms default, and the attempt cap is 4 — advance well past
    // the worst case (4 * 30000ms plus backoff) rather than only past the first attempt's timeout.
    for (let i = 0; i < 20; i++) {
      await vi.advanceTimersByTimeAsync(10000);
    }
    const result = await resultPromise;
    expect(result.error).toContain('timed out');
  });

  it('two concurrent GETs to the same url with equal byte ceilings but different timeouts do not share one request', async () => {
    const { log } = makeLog();
    const fetchMock = vi.fn(() => Promise.resolve(new Response('{}', { status: 200 })));
    vi.stubGlobal('fetch', fetchMock);

    const transport = transportModule().createTransport({ log });
    await Promise.all([
      transport.request({ method: 'GET', url: 'https://api.example.test/timeout-dedupe-diff', timeoutMs: 1000 }),
      transport.request({ method: 'GET', url: 'https://api.example.test/timeout-dedupe-diff', timeoutMs: 2000 }),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('two concurrent GETs to the same url with equal byte ceilings and equal timeouts share one request', async () => {
    const { log } = makeLog();
    const fetchMock = vi.fn(() => Promise.resolve(new Response('{}', { status: 200 })));
    vi.stubGlobal('fetch', fetchMock);

    const transport = transportModule().createTransport({ log });
    await Promise.all([
      transport.request({ method: 'GET', url: 'https://api.example.test/timeout-dedupe-same', timeoutMs: 1000 }),
      transport.request({ method: 'GET', url: 'https://api.example.test/timeout-dedupe-same', timeoutMs: 1000 }),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('transport — userinfo/query-key redaction and logUrl/logBody honouring (Plan 05 Task 0, T-06-37, T-06-38)', () => {
  it('a URL carrying userinfo is recorded with the userinfo masked, for every caller', async () => {
    const { log, entries } = makeLog();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('{}', { status: 200 }))),
    );

    const transport = transportModule().createTransport({ log });
    await transport.request({ method: 'GET', url: `https://user:${REAL_API_KEY}@api.example.test/x` });

    expect(entries).toHaveLength(1);
    const allValues = collectAllValues(entries[0]);
    expect(allValues).not.toContain(REAL_API_KEY);
    expect(entries[0].url).not.toContain(REAL_API_KEY);
    // URL's username/password setters percent-encode `[`/`]`, so the stored url does not
    // literally contain "[redacted]" — decode the parsed username to prove the real marker
    // landed there, the same discipline the pre-existing apikey test uses for searchParams.
    const parsedStoredUrl = new URL(entries[0].url!);
    expect(decodeURIComponent(parsedStoredUrl.username)).toBe(transportModule().NET_REDACTED);
  });

  it('a credential-shaped query key beyond apikey (e.g. token) is masked', async () => {
    const { log, entries } = makeLog();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('{}', { status: 200 }))),
    );

    const transport = transportModule().createTransport({ log });
    await transport.request({
      method: 'GET',
      url: 'https://api.example.test/x',
      query: { token: REAL_API_KEY },
    });

    expect(new URL(entries[0].url!).searchParams.get('token')).toBe(transportModule().NET_REDACTED);
  });

  it('a request supplying logUrl has that value recorded in place of the composed URL, with host/path/query all derived from it', async () => {
    const { log, entries } = makeLog();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('{}', { status: 200 }))),
    );

    const transport = transportModule().createTransport({ log });
    await transport.request({
      method: 'POST',
      url: 'https://real-endpoint.example.test/v3/secret-project-id?foo=bar',
      logUrl: 'https://real-endpoint.example.test/[redacted]',
      body: '{"hash":"0x1"}',
    });

    expect(entries).toHaveLength(1);
    expect(entries[0].url).toBe('https://real-endpoint.example.test/[redacted]');
    expect(entries[0].host).toBe('real-endpoint.example.test');
    expect(entries[0].path).not.toContain('secret-project-id');
    expect(entries[0].query).toBeUndefined();
  });

  it('the explorer leg (no logUrl supplied) records the composed, query-key-redacted url unchanged', async () => {
    const { log, entries } = makeLog();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('{}', { status: 200 }))),
    );

    const transport = transportModule().createTransport({ log });
    await transport.request({
      method: 'GET',
      url: 'https://api.example.test/x',
      query: { apikey: REAL_API_KEY },
    });

    expect(new URL(entries[0].url!).searchParams.get('apikey')).toBe(transportModule().NET_REDACTED);
    expect(entries[0].url).not.toContain(REAL_API_KEY);
  });

  it('a request supplying logBody has that value recorded in place of req.body', async () => {
    const { log, entries } = makeLog();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('{}', { status: 200 }))),
    );

    const transport = transportModule().createTransport({ log });
    await transport.request({
      method: 'POST',
      url: 'https://api.example.test/x',
      body: `{"secret":"${REAL_API_KEY}"}`,
      logBody: '{"hash":"0x1"}',
    });

    expect(entries[0].requestBody).toBe('{"hash":"0x1"}');
    expect(entries[0].requestBody).not.toContain(REAL_API_KEY);
  });

  it('a request with no logBody records the body verbatim — pinned by a test, not left to a comment', async () => {
    const { log, entries } = makeLog();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('{}', { status: 200 }))),
    );

    const transport = transportModule().createTransport({ log });
    const body = '{"hash":"0x1"}';
    await transport.request({ method: 'POST', url: 'https://api.example.test/x', body });

    expect(entries[0].requestBody).toBe(body);
  });
});

describe('transport — JSON-RPC rate-limit recognition (Plan 05 Task 0, T-06-30)', () => {
  it('an HTTP 200 carrying a JSON-RPC error with code -32005 is retried', async () => {
    vi.useFakeTimers();
    const { log, entries } = makeLog();
    let call = 0;
    const fetchMock = vi.fn(() => {
      call++;
      const body =
        call < 2
          ? JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32005, message: 'rate limit exceeded' } })
          : JSON.stringify({ jsonrpc: '2.0', id: 1, result: { hash: '0x1' } });
      return Promise.resolve(new Response(body, { status: 200 }));
    });
    vi.stubGlobal('fetch', fetchMock);

    const transport = transportModule().createTransport({ log });
    const resultPromise = transport.request({ method: 'GET', url: 'https://api.example.test/jsonrpc-rate-limit' });
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(5000);
    }
    const result = await resultPromise;

    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(2);
    expect(entries).toHaveLength(2);
  });

  it('an HTTP 200 carrying a JSON-RPC error with a non-rate-limit code is not retried and is reported as a failure rather than a success', async () => {
    const { log } = makeLog();
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'invalid params' } });
    const fetchMock = vi.fn(() => Promise.resolve(new Response(body, { status: 200 })));
    vi.stubGlobal('fetch', fetchMock);

    const transport = transportModule().createTransport({ log });
    const result = await transport.request({ method: 'GET', url: 'https://api.example.test/jsonrpc-error' });

    expect(result.ok).toBe(false);
    expect(result.attempts).toBe(1);
    expect(result.error).toContain('invalid params');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('transport — malformed URL cannot make the transport reject (Plan 05 Task 0, T-06-31)', () => {
  it('a request with an unparseable url resolves with a transport-level failure and does not reject', async () => {
    const { log } = makeLog();
    const fetchMock = vi.fn(() => Promise.resolve(new Response('{}', { status: 200 })));
    vi.stubGlobal('fetch', fetchMock);

    const transport = transportModule().createTransport({ log });
    await expect(transport.request({ method: 'GET', url: 'not a url at all' })).resolves.toMatchObject({
      ok: false,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('an unparseable url reports a failure naming the problem', async () => {
    const { log } = makeLog();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('{}', { status: 200 }))),
    );

    const transport = transportModule().createTransport({ log });
    const result = await transport.request({ method: 'GET', url: '::::not-a-url::::' });

    expect(result.error).toContain('malformed url');
  });
});

describe('transport — per-request byte ceiling and its truncation report (Task 1, D-10)', () => {
  it('a request with a 262144-byte ceiling reads a body larger than the global 65536-byte limit in full, and its JSON parses to a non-null value', async () => {
    const { log } = makeLog();
    const bigBody = JSON.stringify({ data: 'x'.repeat(100000) });
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(bigBody, { status: 200 }))),
    );

    const transport = transportModule().createTransport({ log });
    const result = await transport.request({
      method: 'GET',
      url: 'https://api.example.test/big-ceiling',
      maxBytes: 262144,
    });

    expect(result.body.length).toBeGreaterThan(transportModule().NET_BODY_LIMIT_BYTES);
    expect(result.json).not.toBeNull();
    expect(result.truncated).toBeFalsy();
  });

  it('a request carrying no ceiling is still capped at the global 65536-byte limit, exactly as before this task', async () => {
    const { log } = makeLog();
    const bigBody = 'x'.repeat(transportModule().NET_BODY_LIMIT_BYTES + 5000);
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(bigBody, { status: 200 }))),
    );

    const transport = transportModule().createTransport({ log });
    const result = await transport.request({ method: 'GET', url: 'https://api.example.test/no-ceiling' });

    expect(result.body.length).toBeLessThan(bigBody.length);
    expect(result.truncated).toBe(true);
  });

  it('a body exceeding its own request ceiling reports truncated: true', async () => {
    const { log } = makeLog();
    const overBody = 'x'.repeat(2000);
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(overBody, { status: 200 }))),
    );

    const transport = transportModule().createTransport({ log });
    const result = await transport.request({
      method: 'GET',
      url: 'https://api.example.test/over-ceiling',
      maxBytes: 1000,
    });

    expect(result.truncated).toBe(true);
  });

  it('a well-formed body within its own request ceiling reports truncated as absent or false', async () => {
    const { log } = makeLog();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('{"ok":true}', { status: 200 }))),
    );

    const transport = transportModule().createTransport({ log });
    const result = await transport.request({
      method: 'GET',
      url: 'https://api.example.test/within-ceiling',
      maxBytes: 1000,
    });

    expect(result.truncated).toBeFalsy();
  });

  it('two concurrent GETs to the same url with DIFFERENT ceilings do not share one request', async () => {
    const { log } = makeLog();
    const fetchMock = vi.fn(() => Promise.resolve(new Response('{}', { status: 200 })));
    vi.stubGlobal('fetch', fetchMock);

    const transport = transportModule().createTransport({ log });
    await Promise.all([
      transport.request({ method: 'GET', url: 'https://api.example.test/ceiling-dedupe-diff', maxBytes: 1000 }),
      transport.request({ method: 'GET', url: 'https://api.example.test/ceiling-dedupe-diff', maxBytes: 2000 }),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('two concurrent GETs to the same url with the SAME ceiling share one request', async () => {
    const { log } = makeLog();
    const fetchMock = vi.fn(() => Promise.resolve(new Response('{}', { status: 200 })));
    vi.stubGlobal('fetch', fetchMock);

    const transport = transportModule().createTransport({ log });
    await Promise.all([
      transport.request({ method: 'GET', url: 'https://api.example.test/ceiling-dedupe-same', maxBytes: 5000 }),
      transport.request({ method: 'GET', url: 'https://api.example.test/ceiling-dedupe-same', maxBytes: 5000 }),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("the recorded log entry's response body for an oversized response is no larger than the global limit plus its truncation notice, while the body returned to the caller is larger", async () => {
    const { log, entries } = makeLog();
    const NET_BODY_LIMIT_BYTES = transportModule().NET_BODY_LIMIT_BYTES;
    // Larger than the global 64 KB limit, well within the 256 KB caller ceiling below — so the
    // CALLER's own copy is not truncated at all, and only the log's independent cap should cut it.
    const bigBody = JSON.stringify({ data: 'x'.repeat(NET_BODY_LIMIT_BYTES) });
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(bigBody, { status: 200 }))),
    );

    const transport = transportModule().createTransport({ log });
    const result = await transport.request({
      method: 'GET',
      url: 'https://api.example.test/log-cap',
      maxBytes: 262144,
    });

    expect(result.body.length).toBeGreaterThan(NET_BODY_LIMIT_BYTES);
    expect(result.truncated).toBeFalsy();
    expect(entries[0].responseBody).toContain('truncated');
    // The global limit plus a generous allowance for the truncation notice's own text.
    expect(entries[0].responseBody!.length).toBeLessThanOrEqual(NET_BODY_LIMIT_BYTES + 60);
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
