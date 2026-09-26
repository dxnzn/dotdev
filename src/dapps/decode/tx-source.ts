// window.DxDecode.txSource — the transaction-lookup adapter (06-05). Prefers the user's own
// RPC endpoint (a JSON-RPC transaction-by-hash POST), falling back to the explorer's own proxy
// module when no endpoint is usable or the endpoint leg does not resolve to a transaction. Never
// reaches the network primitive directly — every request goes through the SHARED transport (D-15 confines that
// identifier to transport.ts). Loads immediately after abi-source.js and before ui.js
// (manifest.json) — the decoder reaches this module only through DecodeContext.txSource, never
// by naming this file.
//
// Top-level names take the `txs` prefix (D-14). Never write this chain's full name anywhere in
// this file, including comments (D-07) — every reference below says "this chain" or names a
// concrete method/query-parameter identifier instead.
window.DxDecode ??= {};

// The one JSON-RPC method both legs ask for — the endpoint leg sends it as the method name, the
// explorer leg sends it as the `action` value against its own `module=proxy` passthrough
// (plans/decoder-dapp-handoff.md §5.4).
const TXS_JSON_RPC_METHOD = 'eth_getTransactionByHash';

// D-09: the v2 endpoint takes `chainid` as a query parameter — the same base abi-source.ts uses.
const TXS_V2_BASE = 'https://api.etherscan.io/v2/api';

// The whole word is one of the portability guard's banned NETWORK_IDENTIFIERS
// (test/decode-portability.test.ts), and this occurrence is a third-party query-parameter NAME,
// not the network primitive the guard forbids. WR-05 (06-REVIEW.md) replaced the previous
// template-literal concatenation workaround — which the guard's own stripper could not see
// through — with this plain literal, matching abi-source.ts's own resolution, audited as the
// guard's one explicit per-file exemption (ALLOWED_PROTOCOL_LITERALS).
const TXS_ACTION_PARAM = 'action';

const TXS_HASH_HEX_RE = /^0x[0-9a-fA-F]{64}$/;
const TXS_INPUT_HEX_RE = /^0x([0-9a-fA-F]{2})*$/;

// A path this endpoint's log entry redacts to when it carries more than a well-known (empty or
// root) path — most providers hand out a credential-bearing path segment
// (`https://host/v3/<project-id>`), and no rule here can tell which segment that is. Marking the
// whole thing beyond the origin is the correct trade: the user can always read their own
// setting, and the Log tab exists to show what LEFT the browser, not to reproduce a credential.
const TXS_LOG_PATH_REDACTED = '/[redacted]';

// Load-bearing for the verify gate, not stylistic: the explorer leg below constructs a URL of
// its own regardless of whether the endpoint was ever checked, so a gate searching for a bare
// URL constructor would match either way. Only this NAME is a detectable property that the
// configured endpoint was actually validated before anything was composed from it. Two layers
// of defense are deliberate: Task 0 repaired the transport so a malformed url can no longer make
// it reject, and this adapter's job on top of that is to give the user a sentence about their
// own setting rather than spend a request and a log entry on one it can already see is unusable.
function txsIsUsableEndpoint(rpcUrl: unknown): rpcUrl is string {
  if (typeof rpcUrl !== 'string' || rpcUrl.trim().length === 0) return false;
  try {
    new URL(rpcUrl);
    return true;
  } catch {
    return false;
  }
}

// The endpoint is free text from a settings field — Round 2 established that the transport's own
// redaction masks only a known credential position (userinfo unconditionally, a widened but
// best-effort query-key set) and cannot catch a credential in a PATH SEGMENT, which is the shape
// most providers hand out. Composed from origin + pathname, with the whole query string dropped
// and any userinfo omitted (both simply absent from `origin`), and the path itself redacted
// beyond origin unless it is empty or root — deliberately NOT trying to guess which segment of a
// non-trivial path is the secret. An unparseable value degrades to the raw string rather than
// throwing; `txsIsUsableEndpoint` is what keeps this function's real input always parseable.
function txsComposeLogUrl(rpcUrl: string): string {
  try {
    const parsed = new URL(rpcUrl);
    const path = parsed.pathname === '' || parsed.pathname === '/' ? parsed.pathname : TXS_LOG_PATH_REDACTED;
    return `${parsed.origin}${path}`;
  } catch {
    return rpcUrl;
  }
}

// Reuses abi-source.ts's own named helper (D-11/T-06-11) rather than a second inline test, so
// this adapter, the cache and the decoder all agree on what a valid, third-party-supplied
// address looks like — case-insensitive 20-byte hex, normalised to lowercase. Feature-detected:
// abi-source.js loads before this file in the manifest, but the two modules are independently
// optional, so a mirrored fallback keeps this adapter working (with the identical rule) even if
// a host shell somehow loads tx-source.js alone.
function txsNormalizeAddress(value: unknown): string | null {
  const shared = window.DxDecode?.abiSource as { asrcNormalizeAddress?: (v: unknown) => string | null } | undefined;
  if (shared?.asrcNormalizeAddress) return shared.asrcNormalizeAddress(value);
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value)) return null;
  return value.toLowerCase();
}

// The three outcomes a single leg (endpoint or explorer) can produce — never collapsed. 'missed'
// is a clean miss (a null result: an unknown or pending hash), distinct from 'error' (a
// transport failure, a JSON-RPC error, the explorer's own in-body failure envelope, or a
// malformed body) — the caller decides what to do with an 'error' (fall through to the other
// leg, or surface the reason) but a 'missed' from a leg that genuinely asked is the FINAL answer.
type TxsLegOutcome =
  | { kind: 'found'; transaction: { to: string | null; input: string; from: string } }
  | { kind: 'missed' }
  | { kind: 'error'; reason: string };

// Validates and normalises a JSON-RPC transaction result — shared by both legs, since the
// endpoint leg's raw JSON-RPC result and the explorer leg's proxied `result` object are the same
// shape. A null `to` (contract creation) passes through as null rather than being rejected; a
// non-null `to`/`from` failing the 20-byte hex shape, or an `input` that is not `0x`-prefixed
// even-length hex, is reported as an unexpected shape rather than passed on unvalidated — every
// field here came from a third party about to become a decode target or a cache key.
function txsParseTransaction(result: unknown): TxsLegOutcome {
  if (!result || typeof result !== 'object') {
    return { kind: 'error', reason: 'the transaction response had an unexpected shape' };
  }
  const record = result as Record<string, unknown>;

  let to: string | null;
  if (record.to === null) {
    to = null;
  } else {
    const normalizedTo = txsNormalizeAddress(record.to);
    if (normalizedTo === null) {
      return { kind: 'error', reason: 'the transaction response had an unexpected shape' };
    }
    to = normalizedTo;
  }

  const from = txsNormalizeAddress(record.from);
  if (from === null) {
    return { kind: 'error', reason: 'the transaction response had an unexpected shape' };
  }

  const input = record.input;
  if (typeof input !== 'string' || !TXS_INPUT_HEX_RE.test(input)) {
    return { kind: 'error', reason: 'the transaction response had an unexpected shape' };
  }

  return { kind: 'found', transaction: { to, input, from } };
}

// The user's own endpoint, tried first (plans/decoder-dapp-handoff.md §5.4). A JSON-RPC
// transaction-by-hash call needs only the hash — no chain id, unlike the explorer leg below.
async function txsEndpointLeg(
  transport: TransportPort,
  rpcUrl: string,
  hash: string,
  signal: AbortSignal | undefined,
): Promise<TxsLegOutcome> {
  // A JSON content type is required — without it several hosted providers reject the body as
  // plain text with a 415 or a parse error, the kind of failure that passes every offline test
  // and appears on first contact with a real endpoint. Setting it also triggers a cross-origin
  // preflight, which every mainstream provider handles; worth saying so the browser-refused
  // mapping (transport.ts's TypeError check) is not mistaken for the wrong cause.
  const response = await transport.request({
    method: 'POST',
    url: rpcUrl,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: TXS_JSON_RPC_METHOD, params: [hash] }),
    // The endpoint is free text from a settings field — see txsComposeLogUrl. The body is a
    // JSON-RPC envelope carrying only the hash, so it needs no `logBody`; that absence is
    // deliberate, not an oversight.
    logUrl: txsComposeLogUrl(rpcUrl),
    signal,
  });

  // Task 0's transport already resolves a JSON-RPC error object (any code) to `ok: false` with
  // `error` set to the error's own message, and a rate-limited one to a retried, eventually-
  // surfaced failure — what arrives here, if `!response.ok`, is what survived that. Nothing left
  // to inspect on the body for this leg beyond the result member examined below.
  if (!response.ok) {
    return { kind: 'error', reason: response.error ?? 'the transaction request failed' };
  }

  const body = response.json as { result?: unknown } | null;
  if (!body || typeof body !== 'object') {
    return { kind: 'error', reason: 'the endpoint returned a malformed response' };
  }
  // `result: null` is the JSON-RPC answer for "no such transaction" — a real answer about the HASH,
  // and the only shape that earns 'missed' (the FINAL outcome, which suppresses the explorer leg).
  // No `result` member at all, with no `error` either (the transport would have mapped that to
  // `ok: false` above), is not an answer: it is a health page, a JSON array, or a bare envelope from
  // something that is not a JSON-RPC endpoint. Reporting that as 'missed' returned before the
  // configured explorer key was ever consulted, and called a real transaction unknown.
  if (body.result === undefined) {
    return { kind: 'error', reason: 'the endpoint returned a malformed response' };
  }
  if (body.result === null) {
    return { kind: 'missed' };
  }
  return txsParseTransaction(body.result);
}

// The explorer fallback, tried only when the endpoint leg is unusable, absent, or itself
// resolved to 'error'. Needs a chain id — the ONE requirement the endpoint leg above does not
// have — resolved lazily by the caller just before this is invoked.
async function txsExplorerLeg(
  transport: TransportPort,
  apiKey: string,
  chainId: number | string,
  hash: string,
  signal: AbortSignal | undefined,
): Promise<TxsLegOutcome> {
  const url = new URL(TXS_V2_BASE);
  url.searchParams.set('chainid', String(chainId));
  url.searchParams.set('module', 'proxy');
  url.searchParams.set(TXS_ACTION_PARAM, TXS_JSON_RPC_METHOD);
  url.searchParams.set('txhash', hash);
  url.searchParams.set('apikey', apiKey);

  // No `logUrl` needed here — the api key rides in the `apikey` query parameter, a KNOWN
  // position the transport's own redaction already masks by name, and every other component is
  // a chain id, a module name and a hash.
  const response = await transport.request({ method: 'GET', url: url.toString(), signal });

  if (!response.ok) {
    return { kind: 'error', reason: response.error ?? 'the transaction request failed' };
  }

  const body = response.json as { result?: unknown } | null;
  // T-06-39: reuses abi-source.ts's own named in-body-failure predicate (Plan 03) so the two
  // adapters agree on what this envelope looks like — an HTTP 200 whose `result` is a bare
  // string, which is what a missing or invalid key returns. Feature-detected like
  // txsNormalizeAddress above; absent, a string result still degrades safely to
  // txsParseTransaction's own "unexpected shape" branch below (a string is not an object).
  const shared = window.DxDecode?.abiSource as { asrcIsFailureEnvelope?: (b: unknown) => boolean } | undefined;
  if (shared?.asrcIsFailureEnvelope?.(body)) {
    const failureText = (body as { result?: unknown } | null)?.result;
    return {
      kind: 'error',
      reason: typeof failureText === 'string' ? failureText : 'the explorer reported a failure',
    };
  }

  if (!body || typeof body !== 'object') {
    return { kind: 'error', reason: 'the explorer returned a malformed response' };
  }
  // The same distinction the endpoint leg draws, for the same reason: `result: null` is a real
  // answer about the hash, a missing `result` member is not an answer at all — and a 'missed' here
  // reaches the person as "unknown or pending" with no reason attached, hiding the fact that what
  // answered was not speaking JSON-RPC.
  if (body.result === undefined) {
    return { kind: 'error', reason: 'the explorer returned a malformed response' };
  }
  if (body.result === null) {
    return { kind: 'missed' };
  }
  return txsParseTransaction(body.result);
}

// D-08, mirrored from abi-source.ts's asrcResolveChainId: prefer the caller's own chain id over
// the settings value; never guess one. Resolved only here, inside the explorer branch — the
// endpoint leg needs no chain id at all (see the module comment above `txsEndpointLeg`).
function txsResolveChainId(settings: SettingsPort, options: TxLookupOptions | undefined): number | string | undefined {
  const supplied = options?.chainId;
  const fromSettings = settings.get('chainId');
  return supplied !== undefined && supplied !== null && supplied !== ''
    ? supplied
    : fromSettings !== undefined && fromSettings !== null && fromSettings !== ''
      ? (fromSettings as number | string)
      : undefined;
}

// Following createEtherscanAbiSource's established factory shape (abi-source.ts, itself
// following createOpenChainAdapter's) — a TransportPort-consuming adapter that never throws.
// `settings` is read from per call, inside getTransaction, never bound at construction (D-08).
function txsCreateAdapter(transport: TransportPort, settings: SettingsPort): TxSourcePort {
  return {
    async getTransaction(hash: string, options?: TxLookupOptions): Promise<TxLookupResult> {
      try {
        // The hash is validated before any request is composed — a caller-supplied value that
        // is not 32-byte hex issues nothing.
        if (!TXS_HASH_HEX_RE.test(hash)) {
          return { unavailable: true, reason: 'not a 32-byte transaction hash' };
        }

        const signal = options?.signal;
        if (signal?.aborted) {
          return { unavailable: true, reason: 'aborted before the request started' };
        }

        const rpcUrl = settings.get('rpcUrl');
        const apiKey = settings.get('etherscanApiKey');
        const hasApiKey = typeof apiKey === 'string' && apiKey.trim().length > 0;
        const rpcUrlConfigured = typeof rpcUrl === 'string' && rpcUrl.trim().length > 0;
        const endpointUsable = rpcUrlConfigured && txsIsUsableEndpoint(rpcUrl);

        let lastFailureReason: string | undefined;

        if (endpointUsable) {
          const outcome = await txsEndpointLeg(transport, rpcUrl as string, hash, signal);
          if (outcome.kind === 'found') return { transaction: outcome.transaction, unavailable: false };
          if (outcome.kind === 'missed') return { unavailable: true };
          lastFailureReason = outcome.reason;
        } else if (rpcUrlConfigured) {
          // Configured but not usable — skip the leg without a request, remembered as the
          // fallback reason only if the explorer leg below is unavailable or also fails.
          lastFailureReason = 'the configured RPC endpoint URL is not a valid URL';
        }

        if (hasApiKey) {
          const chainId = txsResolveChainId(settings, options);
          if (chainId !== undefined) {
            const outcome = await txsExplorerLeg(transport, apiKey as string, chainId, hash, signal);
            if (outcome.kind === 'found') return { transaction: outcome.transaction, unavailable: false };
            if (outcome.kind === 'missed') return { unavailable: true };
            lastFailureReason = outcome.reason;
          } else {
            lastFailureReason ??= 'no chain id is configured for the explorer fallback';
          }
        }

        if (lastFailureReason) {
          return { unavailable: true, reason: lastFailureReason };
        }

        // Neither an endpoint nor a key configured at all — ETH-08's clear-error clause: name
        // both settings by their user-facing purpose.
        return {
          unavailable: true,
          reason: 'configure an RPC endpoint URL or an Etherscan API key to look up a transaction by hash',
        };
      } catch {
        // DEC-12's never-throw invariant, defensive — every branch above already degrades
        // rather than throwing, but this outer catch is the adapter's own promise regardless of
        // what a future edit adds above it.
        return { unavailable: true, reason: 'could not look up the transaction' };
      }
    },
  };
}

// Attached via a named variable, not a fresh object literal typed against
// DxDecodeTxSourceModule — abi-source.ts's own established excess-property-check sidestep.
const txSourceModule = {
  txsCreateAdapter,
  txsIsUsableEndpoint,
  txsComposeLogUrl,
  txsNormalizeAddress,
  txsParseTransaction,
};

window.DxDecode.txSource = txSourceModule;
