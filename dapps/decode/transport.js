window.DxDecode ??= {};
const NET_DEFAULT_RPS = 3;
const NET_MAX_CONCURRENCY = 4;
const NET_BODY_LIMIT_BYTES = 65536;
const NET_REDACTED = "[redacted]";
const NET_MAX_ATTEMPTS = 4;
const NET_BACKOFF_BASE_MS = 500;
const NET_RETRY_AFTER_MIN_MS = 1e3;
const NET_RETRY_AFTER_MAX_MS = 6e4;
const NET_DEFAULT_TIMEOUT_MS = 3e4;
const NET_RATE_LIMIT_BODY_MARKERS = [
  "Max rate limit reached",
  "Too many invalid api key attempts",
  "Free API access is not supported for this chain"
];
const NET_JSON_RPC_RATE_LIMIT_CODES = [-32005, -32029];
const NET_API_KEY_QUERY_PARAM = "apikey";
const NET_CREDENTIAL_QUERY_KEYS = [NET_API_KEY_QUERY_PARAM, "api_key", "key", "token", "access_token", "auth"];
const NET_CREDENTIAL_HEADER_NAMES = ["authorization"];
const NET_API_KEY_HEADER_RE = /^x-.*-key$/i;
function netIsCredentialHeaderName(name) {
  const lower = name.toLowerCase();
  return NET_CREDENTIAL_HEADER_NAMES.includes(lower) || NET_API_KEY_HEADER_RE.test(lower);
}
function netRedactUrl(url) {
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
function netRedactHeaders(headers) {
  const redacted = {};
  for (const [name, value] of Object.entries(headers)) {
    redacted[name] = netIsCredentialHeaderName(name) ? NET_REDACTED : value;
  }
  return redacted;
}
function netComposeUrl(url, query) {
  if (!query || Object.keys(query).length === 0) return url;
  const parsed = new URL(url);
  for (const [key, value] of Object.entries(query)) {
    parsed.searchParams.set(key, value);
  }
  return parsed.toString();
}
function netDedupeKey(req) {
  const effectiveLimit = req.maxBytes ?? NET_BODY_LIMIT_BYTES;
  const effectiveTimeoutMs = req.timeoutMs ?? NET_DEFAULT_TIMEOUT_MS;
  return `${req.method}:${netComposeUrl(req.url, req.query)}:${effectiveLimit}:${effectiveTimeoutMs}`;
}
function netIsRateLimitBody(json) {
  if (!json || typeof json !== "object") return false;
  const body = json;
  if (body.status !== "0" || typeof body.result !== "string") return false;
  const result = body.result;
  return NET_RATE_LIMIT_BODY_MARKERS.some((marker) => result.includes(marker));
}
function netJsonRpcError(json) {
  if (!json || typeof json !== "object") return void 0;
  const error = json.error;
  if (!error || typeof error !== "object") return void 0;
  const code = error.code;
  const rawMessage = error.message;
  const message = typeof rawMessage === "string" ? rawMessage : "JSON-RPC error";
  const rateLimitedByCode = typeof code === "number" && NET_JSON_RPC_RATE_LIMIT_CODES.includes(code);
  const rateLimitedByMessage = NET_RATE_LIMIT_BODY_MARKERS.some((marker) => message.includes(marker));
  return { message, rateLimited: rateLimitedByCode || rateLimitedByMessage };
}
function netShouldRetry(status, json, networkError) {
  if (networkError) return true;
  if (status === 429) return true;
  if (status >= 500 && status <= 599) return true;
  if (status === 200 && netIsRateLimitBody(json)) return true;
  if (status === 200 && netJsonRpcError(json)?.rateLimited) return true;
  return false;
}
function netBackoffDelay(attempt) {
  const exponential = NET_BACKOFF_BASE_MS * 2 ** (attempt - 1);
  const jitter = 1 + (Math.random() * 2 - 1) * 0.2;
  return Math.round(exponential * jitter);
}
function netClampRetryAfterMs(ms) {
  return Math.min(NET_RETRY_AFTER_MAX_MS, Math.max(NET_RETRY_AFTER_MIN_MS, ms));
}
function netParseRetryAfter(value) {
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    return netClampRetryAfterMs(Number(trimmed) * 1e3);
  }
  const dateMs = Date.parse(trimmed);
  if (!Number.isNaN(dateMs)) {
    return netClampRetryAfterMs(dateMs - Date.now());
  }
  return null;
}
function netSleep(ms, signal) {
  return new Promise((resolveSleep) => {
    if (signal?.aborted) {
      resolveSleep();
      return;
    }
    function cleanup() {
      signal?.removeEventListener("abort", onAbort);
    }
    function onAbort() {
      cleanup();
      clearTimeout(timer);
      resolveSleep();
    }
    const timer = setTimeout(() => {
      cleanup();
      resolveSleep();
    }, ms);
    signal?.addEventListener("abort", onAbort);
  });
}
function netArmRequestTimeout(attemptController, timeoutMs) {
  const timer = setTimeout(() => {
    attemptController.abort();
  }, timeoutMs);
  return () => clearTimeout(timer);
}
async function netReadBoundedBody(response, limitBytes = NET_BODY_LIMIT_BYTES) {
  const body = response.body;
  if (!body) {
    return { text: await response.text(), truncated: false };
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  let truncated = false;
  for (; ; ) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limitBytes) {
      truncated = true;
      await reader.cancel().catch(() => {
      });
      break;
    }
    text += decoder.decode(value, { stream: true });
  }
  if (!truncated) text += decoder.decode();
  return { text, truncated };
}
function netCapTextForLog(text, limitBytes) {
  const encoded = new TextEncoder().encode(text);
  if (encoded.byteLength <= limitBytes) return { text, truncated: false };
  return { text: new TextDecoder().decode(encoded.slice(0, limitBytes)), truncated: true };
}
function createTokenBucket(ratePerSecond) {
  const capacity = Math.max(1, ratePerSecond);
  let tokens = capacity;
  let lastRefillMs = Date.now();
  const queue = [];
  let timer = null;
  function refill() {
    const now = Date.now();
    const elapsedMs = now - lastRefillMs;
    if (elapsedMs <= 0) return;
    tokens = Math.min(capacity, tokens + elapsedMs / 1e3 * ratePerSecond);
    lastRefillMs = now;
  }
  function schedule() {
    if (timer !== null) return;
    refill();
    while (tokens >= 1 && queue.length > 0) {
      tokens -= 1;
      const grant = queue.shift();
      grant?.();
    }
    if (queue.length > 0) {
      const waitMs = Math.max(0, (1 - tokens) / ratePerSecond * 1e3);
      timer = setTimeout(() => {
        timer = null;
        schedule();
      }, waitMs);
    }
  }
  return {
    take() {
      return new Promise((resolveTake) => {
        queue.push(resolveTake);
        schedule();
      });
    }
  };
}
function createConcurrencyGate(limit) {
  let active = 0;
  const queue = [];
  function release() {
    active--;
    const next = queue.shift();
    if (next) {
      active++;
      next();
    }
  }
  return {
    acquire() {
      return new Promise((resolveAcquire) => {
        if (active < limit) {
          active++;
          resolveAcquire(release);
        } else {
          queue.push(() => resolveAcquire(release));
        }
      });
    }
  };
}
function netAbortedResponse(message) {
  return { status: 0, body: "", json: null, attempts: 0, ok: false, error: message };
}
function netMalformedUrlResponse(err) {
  const message = err instanceof Error ? err.message : String(err);
  return { status: 0, body: "", json: null, attempts: 0, ok: false, error: `malformed url: ${message}` };
}
function netParseLogUrl(logUrlValue) {
  try {
    const parsed = new URL(logUrlValue);
    return {
      url: parsed.toString(),
      host: parsed.host,
      path: parsed.search ? `${parsed.pathname}${parsed.search}` : parsed.pathname,
      query: Array.from(parsed.searchParams.keys()).length > 0 ? Object.fromEntries(parsed.searchParams.entries()) : void 0
    };
  } catch {
    return { url: logUrlValue, host: logUrlValue, path: "" };
  }
}
function netAttachToShared(instance, key, entry, callerSignal) {
  if (callerSignal?.aborted) {
    entry.attachedCount--;
    return Promise.resolve(netAbortedResponse("aborted before the request started"));
  }
  return new Promise((resolveCaller) => {
    let settled = false;
    function onAbort() {
      if (settled) return;
      settled = true;
      callerSignal?.removeEventListener("abort", onAbort);
      entry.attachedCount--;
      if (entry.attachedCount <= 0) {
        if (key && instance.dedupeMap.get(key) === entry) instance.dedupeMap.delete(key);
        entry.controller.abort();
      }
      resolveCaller(netAbortedResponse("aborted by caller"));
    }
    callerSignal?.addEventListener("abort", onAbort);
    entry.promise.then((result) => {
      if (settled) return;
      settled = true;
      callerSignal?.removeEventListener("abort", onAbort);
      entry.attachedCount--;
      resolveCaller(result);
    });
  });
}
async function netRequest(instance, req) {
  if (req.signal?.aborted) {
    return netAbortedResponse("aborted before the request started");
  }
  const effectiveLimit = req.maxBytes ?? NET_BODY_LIMIT_BYTES;
  const effectiveTimeoutMs = req.timeoutMs ?? NET_DEFAULT_TIMEOUT_MS;
  const dedupeEnabled = req.method === "GET" && req.dedupe !== false;
  let key;
  try {
    key = dedupeEnabled ? netDedupeKey(req) : null;
  } catch (err) {
    return netMalformedUrlResponse(err);
  }
  let entry = key ? instance.dedupeMap.get(key) : void 0;
  if (entry?.controller.signal.aborted) entry = void 0;
  if (!entry) {
    let composedUrl;
    let redactedUrl;
    try {
      composedUrl = netComposeUrl(req.url, req.query);
      redactedUrl = netRedactUrl(composedUrl);
    } catch (err) {
      return netMalformedUrlResponse(err);
    }
    const redactedHeaders = req.headers ? netRedactHeaders(req.headers) : void 0;
    const logParts = netParseLogUrl(req.logUrl ?? redactedUrl);
    const loggedRequestBody = req.logBody ?? req.body;
    const controller = new AbortController();
    const runShared = (async () => {
      let attempt = 0;
      let result = netAbortedResponse("no attempt made");
      while (attempt < NET_MAX_ATTEMPTS) {
        let onSharedAbort2 = function() {
          attemptController.abort();
        };
        var onSharedAbort = onSharedAbort2;
        if (controller.signal.aborted) {
          result = { ...netAbortedResponse("aborted while waiting to retry"), attempts: attempt };
          break;
        }
        attempt++;
        await instance.bucket.take();
        const release = await instance.gate.acquire();
        if (controller.signal.aborted) {
          release();
          result = { ...netAbortedResponse("aborted while queued"), attempts: attempt };
          break;
        }
        const startedAt = Date.now();
        let willRetry = false;
        let waitMs = 0;
        const attemptController = new AbortController();
        controller.signal.addEventListener("abort", onSharedAbort2);
        const disarmTimeout = netArmRequestTimeout(attemptController, effectiveTimeoutMs);
        try {
          const response = await fetch(composedUrl, {
            method: req.method,
            headers: req.headers,
            body: req.body,
            signal: attemptController.signal
          });
          const { text, truncated } = await netReadBoundedBody(response, effectiveLimit);
          let json = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {
            json = null;
          }
          const durationMs = Date.now() - startedAt;
          const jsonRpc = netJsonRpcError(json);
          const rateLimited = netIsRateLimitBody(json) || jsonRpc?.rateLimited === true;
          const ok = response.status >= 200 && response.status < 300 && !rateLimited && !jsonRpc;
          const callerBody = truncated ? `${text}\u2026 [truncated at ${effectiveLimit} bytes]` : text;
          const logCap = netCapTextForLog(text, NET_BODY_LIMIT_BYTES);
          const loggedBody = logCap.truncated ? `${logCap.text}\u2026 [truncated at ${NET_BODY_LIMIT_BYTES} bytes]` : callerBody;
          const rawRetryAfter = response.headers.get("retry-after");
          const parsedRetryAfter = rawRetryAfter ? netParseRetryAfter(rawRetryAfter) : null;
          const retryAfterServerSpecified = parsedRetryAfter !== null;
          willRetry = !ok && attempt < NET_MAX_ATTEMPTS && netShouldRetry(response.status, json, false);
          waitMs = willRetry ? parsedRetryAfter ?? netBackoffDelay(attempt) : 0;
          const baseError = ok ? void 0 : rateLimited ? "rate limited \u2014 please wait and retry" : jsonRpc ? jsonRpc.message : `HTTP ${response.status}`;
          const error = willRetry && baseError ? `${baseError} \u2014 retrying (${retryAfterServerSpecified ? "server-specified wait via Retry-After" : "backoff; Retry-After not exposed by this origin"})` : baseError;
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
            error
          });
        } catch (err) {
          const durationMs = Date.now() - startedAt;
          const sharedAborted = controller.signal.aborted;
          const attemptAborted = attemptController.signal.aborted;
          const timedOut = attemptAborted && !sharedAborted;
          const refused = !attemptAborted && err instanceof TypeError;
          const message = sharedAborted ? "aborted" : timedOut ? `request timed out after ${effectiveTimeoutMs}ms` : refused ? "the endpoint refused a browser request (no status, no readable body)" : err instanceof Error ? err.message : String(err);
          willRetry = !sharedAborted && attempt < NET_MAX_ATTEMPTS && netShouldRetry(0, null, true);
          waitMs = willRetry ? netBackoffDelay(attempt) : 0;
          result = { status: 0, body: "", json: null, attempts: attempt, ok: false, error: message };
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
            error: message
          });
        } finally {
          controller.signal.removeEventListener("abort", onSharedAbort2);
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
function createTransport(options) {
  const instance = {
    log: options.log,
    bucket: createTokenBucket(options.rps ?? NET_DEFAULT_RPS),
    gate: createConcurrencyGate(NET_MAX_CONCURRENCY),
    dedupeMap: /* @__PURE__ */ new Map()
  };
  return {
    request(req) {
      return netRequest(instance, req);
    }
  };
}
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
  NET_JSON_RPC_RATE_LIMIT_CODES
};
window.DxDecode.transport = transportModule;
