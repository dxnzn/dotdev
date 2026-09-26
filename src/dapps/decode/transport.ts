// window.DxDecode.transport — the SINGLE file in this directory allowed to name `fetch`
// (D-03, D-15). test/decode-portability.test.ts's NETWORK_EXEMPT_FILES lists exactly this file,
// and its own positive assertion (D-03.2) requires every INVOCATION of `fetch` to sit inside the
// body of `netRequest` below — that is not a style preference, it is the property the guard now
// asserts. Every adapter that reaches the network (signatures.ts's OpenChain/4byte adapters,
// Phase 6's Etherscan adapter) goes through `createTransport(...).request(...)`; none of them
// may ever import or reference `fetch` themselves.
//
// Top-level names take the `net` prefix (D-14's directory-wide uniqueness rule — no
// import/export anywhere here, so the whole directory compiles as one TS program and every
// top-level `let`/`const`/`class` also shares one runtime lexical scope across script tags).
//
// Loads between core.js and signatures.js (manifest.json) — signatures.ts's OpenChain/4byte
// adapters (05-05) take a TransportPort as a constructor argument rather than reaching for this
// module's globals directly, but the load order keeps every adapter file able to assume
// window.DxDecode.transport already exists.
//
// 06-03 (Task 1): every caller in this directory MUST inline its request object literal in the
// `transport.request({ ... })` call rather than building it into a variable first. The
// per-call-site signal-presence gate (test/decode-abi-source.test.ts and the plan's own verify
// step) scans a fixed window after each `transport.request(` for `signal` — a request assembled
// into a `const req` beforehand would fail the gate with otherwise-correct code. Inlining is
// also this directory's existing style; stated here once so it is discoverable from the file the
// gates guard, not only from the plans that wrote them.
window.DxDecode ??= {};

// ── Tunables (D-05's discretion area, this file's own named constants) ──────────────────────

// D-08/D-12: Etherscan's free tier is 3 requests/second, enforced per account and shared across
// every chain — one bucket, not one per host or per chain (01 D-28's open question, settled).
const NET_DEFAULT_RPS = 3;

// Bounded concurrency independent of the rate limiter — the bucket paces REQUEST STARTS over
// time, this caps how many can be simultaneously IN FLIGHT (a slow host could otherwise let an
// unbounded number of started-but-not-yet-settled requests pile up).
const NET_MAX_CONCURRENCY = 4;

// T-05-14: a hostile or runaway response body is refused mid-stream, before it is ever fully
// buffered — copying the DxKit provider's own bounded-reader technique
// (/dnznlabs/dxkit/plugins/web3/src/provider.ts, D-13). 64 KB comfortably covers every JSON
// response this phase's own hosts (OpenChain, 4byte) return for a single-selector lookup.
const NET_BODY_LIMIT_BYTES = 65536;

// D-24/NET-07: the sentinel written in place of a redacted value. The header NAME survives
// redaction (an Authorization header having been SENT is information worth keeping); only the
// VALUE is replaced.
const NET_REDACTED = '[redacted]';

// NET-03: the hard cap on total attempts (the first try plus up to three retries). Attempt 4 is
// the last attempt a permanently failing request ever sees; a 5th is never made.
const NET_MAX_ATTEMPTS = 4;

// Exponential backoff base, per handoff §5.4's own shape (`500ms * 2^n +/- 20%`); base,
// multiplier and jitter distribution are this file's own discretion (D-05/D-11) within NET-03's
// 4-attempt cap.
const NET_BACKOFF_BASE_MS = 500;

// D-11: `Retry-After` is not on the CORS safelist and none of this phase's three hosts exposes
// it, so it reads as null on every real call — read opportunistically anyway, and clamp
// whatever IS read into this range so a broken or hostile value can never hang a decode (a
// value of 0 clamps up to the floor; a value of 3600 clamps down to the ceiling).
const NET_RETRY_AFTER_MIN_MS = 1000;
const NET_RETRY_AFTER_MAX_MS = 60000;

// Plan 05 Task 0: `HttpRequest.timeoutMs` was declared in the contract (types.d.ts) and used
// nowhere in this file — a non-responsive endpoint waited forever. 30000ms is sized against the
// two request shapes it has to cover: a 256 KB source-code body over a slow connection, paced
// behind the 3 requests-per-second bucket (D-10's `maxBytes` override exists for exactly this
// body); and a JSON-RPC call to a user's own node, which may be a home machine or a free-tier
// provider and is routinely slower than a commercial explorer. Thirty seconds is long enough
// that neither is cut short in normal use and short enough that a dead endpoint does not look
// like a hung tab.
const NET_DEFAULT_TIMEOUT_MS = 30000;

// D-10: Etherscan reports its own rate-limit and invalid-key failures as HTTP 200 with an
// in-body `{"status":"0","result":"…"}` — matched on CONTAINMENT, never equality, because the
// live string is longer than any fixture. All three are wait-and-retry, not hard failures; the
// surfaced message for the second says to wait, never that the key itself is wrong.
const NET_RATE_LIMIT_BODY_MARKERS = [
  'Max rate limit reached',
  'Too many invalid api key attempts',
  'Free API access is not supported for this chain',
];

// Plan 05 Task 0: an HTTP 200 carrying a JSON-RPC error object was previously read as `ok: true`
// — a rate-limit refusal from a user's own endpoint resolved as a successful lookup with no
// transaction. These are the two standard JSON-RPC rate-limit codes; `NET_RATE_LIMIT_BODY_MARKERS`
// above is also matched against the error's own message, for a provider that words a limit
// without a standard code.
const NET_JSON_RPC_RATE_LIMIT_CODES = [-32005, -32029];

// D-08: the api key rides in this query parameter, never a header (Etherscan's own CORS
// preflight rejects an api-key-shaped header) — matched case-insensitively since query parameter
// casing is not something this file controls for every future host.
const NET_API_KEY_QUERY_PARAM = 'apikey';

// Plan 05 Task 0 (T-06-37, defense in depth — NOT the guarantee): a widened, best-effort set of
// credential-shaped query-key names beyond `apikey`, compared case-insensitively. This is open-set
// pattern matching over a name a future host might choose — it catches nothing a provider names
// something else. The actual guarantee for an arbitrary user-supplied URL is `HttpRequest.logUrl`
// (see the `logUrl`/`logBody` honouring in `netRequest` below), which an adapter that knows its
// URL is arbitrary free text supplies explicitly; this list is only ever a second line of defense.
const NET_CREDENTIAL_QUERY_KEYS = [NET_API_KEY_QUERY_PARAM, 'api_key', 'key', 'token', 'access_token', 'auth'];

// NET-07 names `Authorization` explicitly; the second form covers an `x-...-key`-shaped header
// (e.g. `x-api-key`) without hardcoding every host's own name for it. D-08 means no Phase 5
// request actually sends either — see netRedactHeaders' own comment.
const NET_CREDENTIAL_HEADER_NAMES = ['authorization'];
const NET_API_KEY_HEADER_RE = /^x-.*-key$/i;

function netIsCredentialHeaderName(name: string): boolean {
  const lower = name.toLowerCase();
  return NET_CREDENTIAL_HEADER_NAMES.includes(lower) || NET_API_KEY_HEADER_RE.test(lower);
}

// ── Redaction (D-24) — pure string/object transforms, no network primitive named here ───────

// Masks a credential-shaped query parameter's VALUE with NET_REDACTED and returns the redacted
// string. Never called on a value already destined for display without having been through
// this function first — netRequest below composes the real url, then redacts before it ever
// reaches log.record(...).
//
// Plan 05 Task 0 (T-06-37): userinfo — a credential embedded in the URL authority before the
// `@` — is masked UNCONDITIONALLY, for every url: that position needs no inference to identify
// as a credential, so it is done for all callers rather than left to one. This is a GUARANTEE,
// unlike the query-key set below,
// which is best-effort pattern matching over an open set (NET_CREDENTIAL_QUERY_KEYS) and cannot
// catch a credential in a PATH SEGMENT (`https://host/v3/<project-id>`) at all — that is what
// `HttpRequest.logUrl` exists for; see its honouring in `netRequest`.
function netRedactUrl(url: string): string {
  const parsed = new URL(url);
  if (parsed.username || parsed.password) {
    parsed.username = NET_REDACTED;
    parsed.password = NET_REDACTED;
  }
  for (const key of Array.from(parsed.searchParams.keys())) {
    if (NET_CREDENTIAL_QUERY_KEYS.includes(key.toLowerCase())) {
      parsed.searchParams.set(key, NET_REDACTED);
    }
  }
  return parsed.toString();
}

// Returns a COPY — never mutates the caller's headers object — in which every credential-shaped
// header's VALUE is replaced by NET_REDACTED while its NAME is kept.
//
// `requestHeaders` exists for a path this phase does not actually take, and this comment says
// so: D-08 puts the Etherscan key in the query parameter precisely because an Authorization
// header triggers a preflight the server rejects, and neither OpenChain nor 4byte takes a
// credential at all — so no Phase 5 request sends one. NET-07 names Authorization regardless,
// and this function plus the LogEntry.requestHeaders member (05-01 Task 0) is what makes that
// promise true rather than vacuous the first time a Phase 6 adapter or a user's own RPC endpoint
// needs one. The test suite exercises this with a synthetic header, stated as synthetic.
function netRedactHeaders(headers: Record<string, string>): Record<string, string> {
  const redacted: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    redacted[name] = netIsCredentialHeaderName(name) ? NET_REDACTED : value;
  }
  return redacted;
}

// Merges `query` onto `url`'s own query string and returns the full absolute url. A request
// with no query at all is returned unchanged — no trailing "?" is ever introduced.
function netComposeUrl(url: string, query?: Record<string, string>): string {
  if (!query || Object.keys(query).length === 0) return url;
  const parsed = new URL(url);
  for (const [key, value] of Object.entries(query)) {
    parsed.searchParams.set(key, value);
  }
  return parsed.toString();
}

// method + composed url + effective byte ceiling + effective timeout is the dedupe key (NET-02,
// T-06-28). The ceiling and the timeout are both CORRECTNESS fixes, not tuning knobs: dedupe is
// only sound when the shared request satisfies every attached caller's contract, and a caller
// that asked to give up after five seconds has not agreed to wait thirty for a request someone
// else started. This is why the shared-versus-attempt controller split (see `netRequest` below)
// does not make the timeout a per-caller property — the timer runs inside the shared work, so
// the key is what keeps callers with different timeouts apart.
function netDedupeKey(req: HttpRequest): string {
  const effectiveLimit = req.maxBytes ?? NET_BODY_LIMIT_BYTES;
  const effectiveTimeoutMs = req.timeoutMs ?? NET_DEFAULT_TIMEOUT_MS;
  return `${req.method}:${netComposeUrl(req.url, req.query)}:${effectiveLimit}:${effectiveTimeoutMs}`;
}

// ── Retry policy (NET-03) — trigger detection, backoff, Retry-After parsing ─────────────────

// D-10: match on CONTAINMENT, never equality — the live Etherscan string is longer than any
// fixture, and an equality check silently stops retrying against the real service the moment it
// changes a word.
function netIsRateLimitBody(json: unknown): boolean {
  if (!json || typeof json !== 'object') return false;
  const body = json as { status?: unknown; result?: unknown };
  if (body.status !== '0' || typeof body.result !== 'string') return false;
  const result = body.result;
  return NET_RATE_LIMIT_BODY_MARKERS.some((marker) => result.includes(marker));
}

// Plan 05 Task 0: recognises a JSON-RPC error object — `{ error: { code, message } }` — as a
// SEPARATE shape from the explorer's own in-body envelope above; kept beside it, not replacing
// it. Rate-limit status is decided by either a recognised numeric code
// (NET_JSON_RPC_RATE_LIMIT_CODES) or the same marker strings matched against the error's own
// message, for a provider that words a limit without a standard code. A non-rate-limit error
// still returns a message here — it must stop being reported as a success even though it is not
// retried (see `ok`'s computation in `netRequest`).
function netJsonRpcError(json: unknown): { message: string; rateLimited: boolean } | undefined {
  if (!json || typeof json !== 'object') return undefined;
  const error = (json as { error?: unknown }).error;
  if (!error || typeof error !== 'object') return undefined;
  const code = (error as { code?: unknown }).code;
  const rawMessage = (error as { message?: unknown }).message;
  const message = typeof rawMessage === 'string' ? rawMessage : 'JSON-RPC error';
  const rateLimitedByCode = typeof code === 'number' && NET_JSON_RPC_RATE_LIMIT_CODES.includes(code);
  const rateLimitedByMessage = NET_RATE_LIMIT_BODY_MARKERS.some((marker) => message.includes(marker));
  return { message, rateLimited: rateLimitedByCode || rateLimitedByMessage };
}

// Never branches on HTTP status alone for a body that might be Etherscan-shaped (D-10: those
// arrive as HTTP 200) — `networkError` is a THIRD, orthogonal trigger for a rejected fetch
// (a network error, which is also what a browser's CORS refusal looks like from JS). A 4xx that
// is not 429 is never retried.
function netShouldRetry(status: number, json: unknown, networkError: boolean): boolean {
  if (networkError) return true;
  if (status === 429) return true;
  if (status >= 500 && status <= 599) return true;
  if (status === 200 && netIsRateLimitBody(json)) return true;
  if (status === 200 && netJsonRpcError(json)?.rateLimited) return true;
  return false;
}

// Exponential with full jitter, base NET_BACKOFF_BASE_MS, per handoff §5.4's own shape. Jitter
// from Math.random(), timing from Date.now() — `performance` and `crypto` are deliberately off
// the portability guard's allowlist and must not be reached for (D-05).
function netBackoffDelay(attempt: number): number {
  const exponential = NET_BACKOFF_BASE_MS * 2 ** (attempt - 1);
  const jitter = 1 + (Math.random() * 2 - 1) * 0.2;
  return Math.round(exponential * jitter);
}

function netClampRetryAfterMs(ms: number): number {
  return Math.min(NET_RETRY_AFTER_MAX_MS, Math.max(NET_RETRY_AFTER_MIN_MS, ms));
}

// D-11: the header is unreadable through CORS on every host this project contacts — none of the
// three sends Access-Control-Expose-Headers, so `response.headers.get('retry-after')` is null on
// every real call. Read it anyway (it costs nothing when absent) and parse BOTH allowed forms —
// delta-seconds and HTTP-date — because a naive integer parse yields NaN on the date form, and
// NaN must never become a zero-length wait. Unparseable input returns null so the caller falls
// back to backoff, which is the normal production path, not the exception.
function netParseRetryAfter(value: string): number | null {
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    return netClampRetryAfterMs(Number(trimmed) * 1000);
  }
  const dateMs = Date.parse(trimmed);
  if (!Number.isNaN(dateMs)) {
    return netClampRetryAfterMs(dateMs - Date.now());
  }
  return null;
}

// An abortable sleep — resolves immediately if already aborted, and resolves early (without
// throwing) the moment the signal fires mid-sleep, so a retry that is sleeping when the caller's
// last attachment detaches never issues the next attempt.
function netSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolveSleep) => {
    if (signal?.aborted) {
      resolveSleep();
      return;
    }
    function cleanup(): void {
      signal?.removeEventListener('abort', onAbort);
    }
    function onAbort(): void {
      cleanup();
      clearTimeout(timer);
      resolveSleep();
    }
    const timer = setTimeout(() => {
      cleanup();
      resolveSleep();
    }, ms);
    signal?.addEventListener('abort', onAbort);
  });
}

// Plan 05 Task 0: arms a timer that aborts `attemptController` — the PER-ATTEMPT controller,
// never the shared one — after `timeoutMs` elapses, and returns a disarm closure the caller
// invokes in that same attempt's `finally` so a completed attempt's timer cannot fire late and
// abort a LATER attempt's fresh controller.
//
// Both this function's name and NET_DEFAULT_TIMEOUT_MS's are load-bearing, not stylistic. This
// module already arms two other timers (the token bucket's refill and the backoff sleep above),
// one of them a few lines from an abort listener — any gate phrased as "a timer exists" or "a
// timer near an abort exists" would match those and falsely certify the timeout as implemented.
// Only an identifier absent from the file before this task is a detectable property.
//
// Callers MUST arm this only after `bucket.take()` and `gate.acquire()` have both resolved, and
// disarm it in the same attempt's `finally` — never around the queued wait. A request that sits
// in the rate-limiter queue longer than its own timeout and then responds promptly is not a
// timeout, and the transport suite already advances fake timers by 5000ms while requests queue;
// a timer armed across that wait would fire spuriously against tests that are correct today.
function netArmRequestTimeout(attemptController: AbortController, timeoutMs: number): () => void {
  const timer = setTimeout(() => {
    attemptController.abort();
  }, timeoutMs);
  return () => clearTimeout(timer);
}

// ── Bounded body reading (T-05-14, ported technique from the DxKit provider, D-13) ──────────

// Reads the response body through its own stream with a running byte count, refusing (not
// draining) the moment it exceeds `limitBytes` — before the text is ever handed to JSON.parse. A
// `null` body (a 204, or a test double built without a stream) degrades to response.text() with
// nothing to bound.
//
// D-10 (06-03 Task 1): `limitBytes` defaults to NET_BODY_LIMIT_BYTES so every existing caller is
// byte-for-byte unchanged; a caller with a larger per-request ceiling (`HttpRequest.maxBytes`)
// passes its own effective limit instead. The global constant stays the DEFAULT rather than
// being raised, so a caller that never opts in keeps today's behaviour exactly.
//
// Test-double shape, stated once here because every stub in the test suite must honour it: this
// function calls response.body.getReader() — a REAL Response object
// (`new Response(body, init)`), never a plain object carrying only a `.text()` method, exercises
// this path. This project's own Vitest+jsdom environment implements Response's stream and not
// Blob's (core.ts:426-429 records the same finding for compressForShare), which is why Response
// is the shape every stub in this file's test suite must use.
async function netReadBoundedBody(
  response: Response,
  limitBytes: number = NET_BODY_LIMIT_BYTES,
): Promise<{ text: string; truncated: boolean }> {
  const body = response.body;
  if (!body) {
    return { text: await response.text(), truncated: false };
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = '';
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limitBytes) {
      truncated = true;
      await reader.cancel().catch(() => {});
      break;
    }
    text += decoder.decode(value, { stream: true });
  }
  if (!truncated) text += decoder.decode();
  return { text, truncated };
}

// T-06-27: the log's own copy of a response body is bounded at the GLOBAL limit INDEPENDENTLY of
// whatever ceiling the caller asked for — a caller raising its own request to 256 KB must never
// grow the 500-entry ring buffer's worst case, or the Copy as JSON clipboard payload, by the same
// factor. `text` here is already bounded by the caller's own effective limit (netReadBoundedBody
// above); this re-caps it a second, INDEPENDENT time at NET_BODY_LIMIT_BYTES specifically for the
// log's own consumers — the ring buffer's memory and the untruncated Copy as JSON path — which is
// why the two consumers are named here rather than left to whoever "simplifies" this later.
// Re-encodes and slices by UTF-8 byte length (not JS string length, which does not track bytes
// for multi-byte text); a slice landing mid-codepoint decodes its partial tail as U+FFFD, which
// is acceptable for a display/log copy that is never fed back into JSON.parse.
function netCapTextForLog(text: string, limitBytes: number): { text: string; truncated: boolean } {
  const encoded = new TextEncoder().encode(text);
  if (encoded.byteLength <= limitBytes) return { text, truncated: false };
  return { text: new TextDecoder().decode(encoded.slice(0, limitBytes)), truncated: true };
}

// ── Rate limiting (NET-02) — a small closure, not a class (ORG.md's factory convention) ─────

interface NetTokenBucket {
  take(): Promise<void>;
}

// A leaky/token bucket: `capacity` tokens available up front, refilled continuously at
// `ratePerSecond`. `take()` resolves immediately if a whole token is available, otherwise queues
// and is granted in arrival order once one refills.
//
// Backstop invariant (must_haves): refill arithmetic reads Date.now() deltas (always a whole
// number of milliseconds) and accumulates a REAL number of tokens — a fractional token can
// exist in `tokens`, but schedule() only ever grants while `tokens >= 1`, so a fractional token
// can never itself permit an extra request.
function createTokenBucket(ratePerSecond: number): NetTokenBucket {
  const capacity = Math.max(1, ratePerSecond);
  let tokens = capacity;
  let lastRefillMs = Date.now();
  const queue: Array<() => void> = [];
  let timer: ReturnType<typeof setTimeout> | null = null;

  function refill(): void {
    const now = Date.now();
    const elapsedMs = now - lastRefillMs;
    if (elapsedMs <= 0) return;
    tokens = Math.min(capacity, tokens + (elapsedMs / 1000) * ratePerSecond);
    lastRefillMs = now;
  }

  function schedule(): void {
    if (timer !== null) return;
    refill();
    while (tokens >= 1 && queue.length > 0) {
      tokens -= 1;
      const grant = queue.shift();
      grant?.();
    }
    if (queue.length > 0) {
      const waitMs = Math.max(0, ((1 - tokens) / ratePerSecond) * 1000);
      timer = setTimeout(() => {
        timer = null;
        schedule();
      }, waitMs);
    }
  }

  return {
    take() {
      return new Promise<void>((resolveTake) => {
        queue.push(resolveTake);
        schedule();
      });
    },
  };
}

// ── Bounded concurrency — independent of the rate limiter ────────────────────────────────────

interface NetConcurrencyGate {
  acquire(): Promise<() => void>;
}

function createConcurrencyGate(limit: number): NetConcurrencyGate {
  let active = 0;
  const queue: Array<() => void> = [];

  function release(): void {
    active--;
    const next = queue.shift();
    if (next) {
      active++;
      next();
    }
  }

  return {
    acquire() {
      return new Promise<() => void>((resolveAcquire) => {
        if (active < limit) {
          active++;
          resolveAcquire(release);
        } else {
          queue.push(() => resolveAcquire(release));
        }
      });
    },
  };
}

// ── Dedupe + abort attachment (NET-02, NET-03 concurrency edge) ─────────────────────────────
//
// THE WHOLE OF THE SEMANTICS, stated once: the shared, possibly-retried network work for a
// dedupe key runs under the TRANSPORT'S OWN AbortController — never under any single caller's
// `req.signal`. The obvious implementation (pass the first caller's signal through) is wrong in
// a way that only shows up under load: one superseded decode aborting would kill an identical
// request another decode is still waiting on.
//   - Every caller (deduped or not — a solo caller is "attachedCount 1") attaches to the SAME
//     shared promise via netAttachToShared and registers its OWN req.signal listener.
//   - A caller's signal firing detaches THAT CALLER ONLY: its own returned promise resolves with
//     ok:false/status:0/error naming the abort (never rejects — NET-04), while the shared
//     request continues for everyone still attached.
//   - The shared AbortController is aborted only when the attached-caller count reaches zero,
//     which is also when the dedupe map entry is removed so a later identical GET starts fresh.
//   - A caller attaching with an ALREADY-aborted signal never attaches at all.

interface NetDedupeEntry {
  controller: AbortController;
  attachedCount: number;
  promise: Promise<HttpResponse>;
}

function netAbortedResponse(message: string): HttpResponse {
  return { status: 0, body: '', json: null, attempts: 0, ok: false, error: message };
}

// Plan 05 Task 0: a contract REPAIR, not a convenience — every port in this directory promises
// never to reject (NET-04), and the url compose-and-redact step (`netComposeUrl`/`netRedactUrl`,
// both calling `new URL`) was the one path where the transport could. A user-typed endpoint
// setting is free text reachable from the settings form, so this is genuinely reachable, not
// theoretical.
function netMalformedUrlResponse(err: unknown): HttpResponse {
  const message = err instanceof Error ? err.message : String(err);
  return { status: 0, body: '', json: null, attempts: 0, ok: false, error: `malformed url: ${message}` };
}

// Plan 05 Task 0: derives the LOG's url/host/path/query from `req.logUrl` (when the caller
// supplied one) instead of the composed-and-redacted real url — computed ONCE per shared
// request, since `logUrl` does not vary across attempts. A caller's `logUrl` is expected to be a
// fully-composed absolute URL (an adapter's own safe representation of its arbitrary endpoint);
// if it somehow is not parseable, degrade to recording it as an opaque host/path rather than
// throwing — this function participates in the never-reject contract too.
function netParseLogUrl(logUrlValue: string): {
  url: string;
  host: string;
  path: string;
  query?: Record<string, string>;
} {
  try {
    const parsed = new URL(logUrlValue);
    return {
      url: parsed.toString(),
      host: parsed.host,
      path: parsed.search ? `${parsed.pathname}${parsed.search}` : parsed.pathname,
      query:
        Array.from(parsed.searchParams.keys()).length > 0
          ? Object.fromEntries(parsed.searchParams.entries())
          : undefined,
    };
  } catch {
    return { url: logUrlValue, host: logUrlValue, path: '' };
  }
}

// CR-01: takes `instance`/`key` (not just `entry`) so the LAST caller detaching can remove the
// dedupe map entry at the exact moment it aborts the shared controller — `runShared.finally`
// removes it too, but only after the in-flight `fetch` rejects (a later task), and a second
// decode's identical GET issued synchronously in that window would otherwise find and attach to
// an entry whose controller is already aborted, deterministically receiving `aborted`. Both
// removal sites share the same identity guard (`dedupeMap.get(key) === entry`) so neither can
// ever delete a newer entry that has since replaced this one under the same key.
function netAttachToShared(
  instance: NetTransportInstance,
  key: string | null,
  entry: NetDedupeEntry,
  callerSignal?: AbortSignal,
): Promise<HttpResponse> {
  if (callerSignal?.aborted) {
    // Never attaches at all — this caller was never counted as attached, so it cannot be the
    // one whose detachment brings the count to zero.
    entry.attachedCount--;
    return Promise.resolve(netAbortedResponse('aborted before the request started'));
  }

  return new Promise<HttpResponse>((resolveCaller) => {
    let settled = false;

    function onAbort(): void {
      if (settled) return;
      settled = true;
      callerSignal?.removeEventListener('abort', onAbort);
      entry.attachedCount--;
      if (entry.attachedCount <= 0) {
        if (key && instance.dedupeMap.get(key) === entry) instance.dedupeMap.delete(key);
        entry.controller.abort();
      }
      resolveCaller(netAbortedResponse('aborted by caller'));
    }

    callerSignal?.addEventListener('abort', onAbort);

    entry.promise.then((result) => {
      if (settled) return;
      settled = true;
      callerSignal?.removeEventListener('abort', onAbort);
      entry.attachedCount--;
      resolveCaller(result);
    });
  });
}

// ── The transport instance and its one network-touching function ────────────────────────────

interface NetTransportInstance {
  log: LogPort;
  bucket: NetTokenBucket;
  gate: NetConcurrencyGate;
  dedupeMap: Map<string, NetDedupeEntry>;
}

// The one function that touches the network, and the one that writes the LogEntry (D-03.2).
// Task 2 adds the retry loop here rather than restructuring the function: the per-attempt body
// (fetch, bounded read, log) is unchanged in shape from Task 1, now run inside a
// `while (attempt < NET_MAX_ATTEMPTS)` loop that decides after each attempt whether to sleep and
// try again. Every branch resolves — never rejects (NET-04) — and the network primitive is
// invoked only from inside this one function, at this one call site, on every iteration.
async function netRequest(instance: NetTransportInstance, req: HttpRequest): Promise<HttpResponse> {
  if (req.signal?.aborted) {
    return netAbortedResponse('aborted before the request started');
  }

  // D-10: resolved ONCE here, from the request's own optional ceiling, and reused for every
  // attempt below — the default stays NET_BODY_LIMIT_BYTES so a caller that never sets
  // `maxBytes` is byte-for-byte unchanged from before this task.
  const effectiveLimit = req.maxBytes ?? NET_BODY_LIMIT_BYTES;
  // Plan 05 Task 0: resolved ONCE, from the request's own declared timeout or the module
  // default — reused for every attempt below, and joins `effectiveLimit` in the dedupe key.
  const effectiveTimeoutMs = req.timeoutMs ?? NET_DEFAULT_TIMEOUT_MS;

  const dedupeEnabled = req.method === 'GET' && req.dedupe !== false;
  // Plan 05 Task 0: `netDedupeKey` calls `netComposeUrl`, which calls `new URL` when a query is
  // present — a malformed `req.url` can throw here, before any request is even attempted. The
  // never-reject contract has to hold at this call site too, not only at the one below.
  let key: string | null;
  try {
    key = dedupeEnabled ? netDedupeKey(req) : null;
  } catch (err) {
    return netMalformedUrlResponse(err);
  }
  let entry = key ? instance.dedupeMap.get(key) : undefined;
  // CR-01 defense-in-depth: an entry whose shared controller has already been aborted must never
  // be handed to a new attacher, even if some future change leaves a stale map entry behind the
  // primary removal above. Treat it as though no entry were found — a fresh shared request starts
  // instead of joining a dying one.
  if (entry?.controller.signal.aborted) entry = undefined;

  if (!entry) {
    // Plan 05 Task 0: the compose-and-redact step both call `new URL` and both ran outside any
    // try block before this task — a malformed, user-typed endpoint setting could make the
    // transport reject out of its own never-reject contract. See netMalformedUrlResponse.
    let composedUrl: string;
    let redactedUrl: string;
    try {
      composedUrl = netComposeUrl(req.url, req.query);
      redactedUrl = netRedactUrl(composedUrl);
    } catch (err) {
      return netMalformedUrlResponse(err);
    }
    const redactedHeaders = req.headers ? netRedactHeaders(req.headers) : undefined;
    // Plan 05 Task 0: `logUrl`/`logBody` are the actual redaction GUARANTEE for an arbitrary
    // user-supplied URL and POST body — the transport cannot know which parts of a stranger's
    // URL are secret, but the adapter that read it out of a settings field knows it is arbitrary
    // free text. Computed once, reused by both log.record calls below (success and catch).
    const logParts = netParseLogUrl(req.logUrl ?? redactedUrl);
    const loggedRequestBody = req.logBody ?? req.body;

    const controller = new AbortController();

    const runShared: Promise<HttpResponse> = (async (): Promise<HttpResponse> => {
      let attempt = 0;
      let result: HttpResponse = netAbortedResponse('no attempt made');

      while (attempt < NET_MAX_ATTEMPTS) {
        if (controller.signal.aborted) {
          result = { ...netAbortedResponse('aborted while waiting to retry'), attempts: attempt };
          break;
        }
        attempt++;

        await instance.bucket.take();
        const release = await instance.gate.acquire();
        // Re-checked AFTER both queue waits, and this is the only place it can be caught: the
        // loop-top check above runs BEFORE them, and the attempt's own 'abort' listener is armed
        // AFTER them — adding a listener to an already-aborted signal never replays the event. A
        // shared abort landing in that window (every attached caller detaching, which is what a
        // cleared or superseded decode does to a queue of ABI lookups) therefore reached `fetch`
        // with a fresh, un-aborted attempt signal: a request nobody wanted still went out, spending
        // a token and holding a concurrency slot the next decode was waiting for, and writing an
        // orphan Log entry. The slot is released explicitly, since the `finally` that normally does
        // it belongs to the try block below.
        if (controller.signal.aborted) {
          release();
          result = { ...netAbortedResponse('aborted while queued'), attempts: attempt };
          break;
        }
        const startedAt = Date.now();
        let willRetry = false;
        let waitMs = 0;

        // Plan 05 Task 0: a FRESH controller per attempt, composed with the shared one by an
        // `abort` listener removed in this attempt's own `finally` — never the shared controller
        // itself. The shared controller belongs to every attached caller; aborting it for one
        // attempt's timeout would end the request for everyone still waiting on it, and the
        // retry loop above breaks on `controller.signal.aborted`, so a shared-controller timeout
        // could never be retried. The request primitive below receives THIS signal, not the
        // shared one.
        const attemptController = new AbortController();
        function onSharedAbort(): void {
          attemptController.abort();
        }
        controller.signal.addEventListener('abort', onSharedAbort);
        // Armed AFTER bucket.take() and gate.acquire() have both resolved — never around the
        // queued wait — and disarmed in this attempt's own `finally`.
        const disarmTimeout = netArmRequestTimeout(attemptController, effectiveTimeoutMs);

        try {
          const response = await fetch(composedUrl, {
            method: req.method,
            headers: req.headers,
            body: req.body,
            signal: attemptController.signal,
          });
          const { text, truncated } = await netReadBoundedBody(response, effectiveLimit);
          let json: unknown = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {
            json = null;
          }
          const durationMs = Date.now() - startedAt;
          const jsonRpc = netJsonRpcError(json);
          const rateLimited = netIsRateLimitBody(json) || jsonRpc?.rateLimited === true;
          const ok = response.status >= 200 && response.status < 300 && !rateLimited && !jsonRpc;
          // The CALLER-facing body: text up to its OWN ceiling, with a notice naming that
          // ceiling when it cut the body short — this is what lets the adapter tell "the
          // ceiling was too small" from "this body was malformed" (D-10).
          const callerBody = truncated ? `${text}… [truncated at ${effectiveLimit} bytes]` : text;
          // The LOG's own copy: capped at the GLOBAL limit independently of the caller's own
          // ceiling (T-06-27) — reusing `callerBody` verbatim (including its own notice, if any)
          // whenever it already fits within the global cap, so a default caller's log entry is
          // unchanged from before this task.
          const logCap = netCapTextForLog(text, NET_BODY_LIMIT_BYTES);
          const loggedBody = logCap.truncated
            ? `${logCap.text}… [truncated at ${NET_BODY_LIMIT_BYTES} bytes]`
            : callerBody;

          // D-11: read opportunistically — this is null on every real call for the three hosts
          // this phase contacts, and that is the expected, non-exceptional case.
          const rawRetryAfter = response.headers.get('retry-after');
          const parsedRetryAfter = rawRetryAfter ? netParseRetryAfter(rawRetryAfter) : null;
          const retryAfterServerSpecified = parsedRetryAfter !== null;

          willRetry = !ok && attempt < NET_MAX_ATTEMPTS && netShouldRetry(response.status, json, false);
          waitMs = willRetry ? (parsedRetryAfter ?? netBackoffDelay(attempt)) : 0;

          const baseError = ok
            ? undefined
            : rateLimited
              ? 'rate limited — please wait and retry'
              : jsonRpc
                ? jsonRpc.message
                : `HTTP ${response.status}`;
          // "We were told" vs "we guessed" (NET-06) — stated once here so 05-04's Log tab
          // renders it rather than re-deriving it.
          const error =
            willRetry && baseError
              ? `${baseError} — retrying (${
                  retryAfterServerSpecified
                    ? 'server-specified wait via Retry-After'
                    : 'backoff; Retry-After not exposed by this origin'
                })`
              : baseError;

          // Phase 6 Task 0/Task 1: `truncated` is carried onto the COMPOSED RESPONSE — the
          // reader's own local flag is not enough; the adapter that told a caller's ceiling from
          // a malformed body needs it on the value it actually receives.
          result = { status: response.status, body: text, json, attempts: attempt, ok, error, truncated };

          instance.log.record({
            timestamp: startedAt,
            method: req.method,
            host: logParts.host,
            path: logParts.path,
            status: response.status,
            duration: durationMs,
            attempt,
            url: logParts.url,
            query: logParts.query,
            requestHeaders: redactedHeaders,
            requestBody: loggedRequestBody,
            responseBody: loggedBody,
            error,
          });
        } catch (err) {
          const durationMs = Date.now() - startedAt;
          // Plan 05 Task 0: the two abort causes visible to this catch block are distinguished
          // separately — a SHARED abort (the last attached caller detaching) still ends the
          // request with no retry, exactly as before this task; an attempt aborted only by its
          // own timer (attemptController aborted, but the shared controller was not) is
          // retryable like any other network error, subject to the same attempt cap and backoff.
          // A caller detaching while other callers remain attached never reaches this function at
          // all — `netAttachToShared` resolves that caller's own promise directly with its own
          // distinguishable message ('aborted before the request started' / 'aborted by caller').
          const sharedAborted = controller.signal.aborted;
          const attemptAborted = attemptController.signal.aborted;
          const timedOut = attemptAborted && !sharedAborted;
          // D-09: detect a browser-refused request by `instanceof TypeError`, never by matching
          // the platform's own refusal message text — that message is engine-dependent, and
          // putting it in a string literal outside this function would place the network
          // identifier outside the one function the portability guard permits it in.
          const refused = !attemptAborted && err instanceof TypeError;
          const message = sharedAborted
            ? 'aborted'
            : timedOut
              ? `request timed out after ${effectiveTimeoutMs}ms`
              : refused
                ? 'the endpoint refused a browser request (no status, no readable body)'
                : err instanceof Error
                  ? err.message
                  : String(err);
          willRetry = !sharedAborted && attempt < NET_MAX_ATTEMPTS && netShouldRetry(0, null, true);
          waitMs = willRetry ? netBackoffDelay(attempt) : 0;

          result = { status: 0, body: '', json: null, attempts: attempt, ok: false, error: message };
          instance.log.record({
            timestamp: startedAt,
            method: req.method,
            host: logParts.host,
            path: logParts.path,
            status: 0,
            duration: durationMs,
            attempt,
            url: logParts.url,
            query: logParts.query,
            requestHeaders: redactedHeaders,
            requestBody: loggedRequestBody,
            error: message,
          });
        } finally {
          controller.signal.removeEventListener('abort', onSharedAbort);
          disarmTimeout();
          release();
        }

        if (!willRetry) break;
        await netSleep(waitMs, controller.signal);
      }

      return result;
    })();

    entry = { controller, attachedCount: 0, promise: runShared };
    if (key) {
      const dedupeKey = key;
      instance.dedupeMap.set(dedupeKey, entry);
      runShared.finally(() => {
        if (instance.dedupeMap.get(dedupeKey) === entry) instance.dedupeMap.delete(dedupeKey);
      });
    }
  }

  entry.attachedCount++;
  return netAttachToShared(instance, key, entry, req.signal);
}

// ── The adapter (ORG.md § Modular Architecture: factory returns a plain object, no class) ───

interface NetCreateTransportOptions {
  log: LogPort;
  rps?: number;
}

function createTransport(options: NetCreateTransportOptions): TransportPort {
  const instance: NetTransportInstance = {
    log: options.log,
    bucket: createTokenBucket(options.rps ?? NET_DEFAULT_RPS),
    gate: createConcurrencyGate(NET_MAX_CONCURRENCY),
    dedupeMap: new Map(),
  };
  return {
    request(req: HttpRequest): Promise<HttpResponse> {
      return netRequest(instance, req);
    },
  };
}

// Attached via a named variable, not a fresh object literal typed against
// DxDecodeTransportModule — codecs.ts/signatures.ts's own established excess-property-check
// sidestep, since only createTransport is a member of the frozen contract and the rest of this
// file's top-level functions/constants are exposed here purely so the test suite can exercise
// them directly without a second, parallel export surface.
const transportModule = {
  createTransport,
  netRequest,
  createTokenBucket,
  netRedactUrl,
  netRedactHeaders,
  netComposeUrl,
  netDedupeKey,
  netBackoffDelay,
  netParseRetryAfter,
  netShouldRetry,
  netIsRateLimitBody,
  netJsonRpcError,
  netReadBoundedBody,
  netCapTextForLog,
  netArmRequestTimeout,
  netParseLogUrl,
  NET_REDACTED,
  NET_DEFAULT_RPS,
  NET_MAX_CONCURRENCY,
  NET_BODY_LIMIT_BYTES,
  NET_CREDENTIAL_HEADER_NAMES,
  NET_CREDENTIAL_QUERY_KEYS,
  NET_MAX_ATTEMPTS,
  NET_BACKOFF_BASE_MS,
  NET_RETRY_AFTER_MIN_MS,
  NET_RETRY_AFTER_MAX_MS,
  NET_DEFAULT_TIMEOUT_MS,
  NET_JSON_RPC_RATE_LIMIT_CODES,
};

window.DxDecode.transport = transportModule;
