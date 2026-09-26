window.DxDecode ??= {};
const TXS_JSON_RPC_METHOD = "eth_getTransactionByHash";
const TXS_V2_BASE = "https://api.etherscan.io/v2/api";
const TXS_ACTION_PARAM = "action";
const TXS_HASH_HEX_RE = /^0x[0-9a-fA-F]{64}$/;
const TXS_INPUT_HEX_RE = /^0x([0-9a-fA-F]{2})*$/;
const TXS_LOG_PATH_REDACTED = "/[redacted]";
function txsIsUsableEndpoint(rpcUrl) {
  if (typeof rpcUrl !== "string" || rpcUrl.trim().length === 0) return false;
  try {
    new URL(rpcUrl);
    return true;
  } catch {
    return false;
  }
}
function txsComposeLogUrl(rpcUrl) {
  try {
    const parsed = new URL(rpcUrl);
    const path = parsed.pathname === "" || parsed.pathname === "/" ? parsed.pathname : TXS_LOG_PATH_REDACTED;
    return `${parsed.origin}${path}`;
  } catch {
    return rpcUrl;
  }
}
function txsNormalizeAddress(value) {
  const shared = window.DxDecode?.abiSource;
  if (shared?.asrcNormalizeAddress) return shared.asrcNormalizeAddress(value);
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) return null;
  return value.toLowerCase();
}
function txsParseTransaction(result) {
  if (!result || typeof result !== "object") {
    return { kind: "error", reason: "the transaction response had an unexpected shape" };
  }
  const record = result;
  let to;
  if (record.to === null) {
    to = null;
  } else {
    const normalizedTo = txsNormalizeAddress(record.to);
    if (normalizedTo === null) {
      return { kind: "error", reason: "the transaction response had an unexpected shape" };
    }
    to = normalizedTo;
  }
  const from = txsNormalizeAddress(record.from);
  if (from === null) {
    return { kind: "error", reason: "the transaction response had an unexpected shape" };
  }
  const input = record.input;
  if (typeof input !== "string" || !TXS_INPUT_HEX_RE.test(input)) {
    return { kind: "error", reason: "the transaction response had an unexpected shape" };
  }
  return { kind: "found", transaction: { to, input, from } };
}
async function txsEndpointLeg(transport, rpcUrl, hash, signal) {
  const response = await transport.request({
    method: "POST",
    url: rpcUrl,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: TXS_JSON_RPC_METHOD, params: [hash] }),
    // The endpoint is free text from a settings field — see txsComposeLogUrl. The body is a
    // JSON-RPC envelope carrying only the hash, so it needs no `logBody`; that absence is
    // deliberate, not an oversight.
    logUrl: txsComposeLogUrl(rpcUrl),
    signal
  });
  if (!response.ok) {
    return { kind: "error", reason: response.error ?? "the transaction request failed" };
  }
  const body = response.json;
  if (!body || typeof body !== "object") {
    return { kind: "error", reason: "the endpoint returned a malformed response" };
  }
  if (body.result === void 0) {
    return { kind: "error", reason: "the endpoint returned a malformed response" };
  }
  if (body.result === null) {
    return { kind: "missed" };
  }
  return txsParseTransaction(body.result);
}
async function txsExplorerLeg(transport, apiKey, chainId, hash, signal) {
  const url = new URL(TXS_V2_BASE);
  url.searchParams.set("chainid", String(chainId));
  url.searchParams.set("module", "proxy");
  url.searchParams.set(TXS_ACTION_PARAM, TXS_JSON_RPC_METHOD);
  url.searchParams.set("txhash", hash);
  url.searchParams.set("apikey", apiKey);
  const response = await transport.request({ method: "GET", url: url.toString(), signal });
  if (!response.ok) {
    return { kind: "error", reason: response.error ?? "the transaction request failed" };
  }
  const body = response.json;
  const shared = window.DxDecode?.abiSource;
  if (shared?.asrcIsFailureEnvelope?.(body)) {
    const failureText = body?.result;
    return {
      kind: "error",
      reason: typeof failureText === "string" ? failureText : "the explorer reported a failure"
    };
  }
  if (!body || typeof body !== "object") {
    return { kind: "error", reason: "the explorer returned a malformed response" };
  }
  if (body.result === void 0) {
    return { kind: "error", reason: "the explorer returned a malformed response" };
  }
  if (body.result === null) {
    return { kind: "missed" };
  }
  return txsParseTransaction(body.result);
}
function txsResolveChainId(settings, options) {
  const supplied = options?.chainId;
  const fromSettings = settings.get("chainId");
  return supplied !== void 0 && supplied !== null && supplied !== "" ? supplied : fromSettings !== void 0 && fromSettings !== null && fromSettings !== "" ? fromSettings : void 0;
}
function txsCreateAdapter(transport, settings) {
  return {
    async getTransaction(hash, options) {
      try {
        if (!TXS_HASH_HEX_RE.test(hash)) {
          return { unavailable: true, reason: "not a 32-byte transaction hash" };
        }
        const signal = options?.signal;
        if (signal?.aborted) {
          return { unavailable: true, reason: "aborted before the request started" };
        }
        const rpcUrl = settings.get("rpcUrl");
        const apiKey = settings.get("etherscanApiKey");
        const hasApiKey = typeof apiKey === "string" && apiKey.trim().length > 0;
        const rpcUrlConfigured = typeof rpcUrl === "string" && rpcUrl.trim().length > 0;
        const endpointUsable = rpcUrlConfigured && txsIsUsableEndpoint(rpcUrl);
        let lastFailureReason;
        if (endpointUsable) {
          const outcome = await txsEndpointLeg(transport, rpcUrl, hash, signal);
          if (outcome.kind === "found") return { transaction: outcome.transaction, unavailable: false };
          if (outcome.kind === "missed") return { unavailable: true };
          lastFailureReason = outcome.reason;
        } else if (rpcUrlConfigured) {
          lastFailureReason = "the configured RPC endpoint URL is not a valid URL";
        }
        if (hasApiKey) {
          const chainId = txsResolveChainId(settings, options);
          if (chainId !== void 0) {
            const outcome = await txsExplorerLeg(transport, apiKey, chainId, hash, signal);
            if (outcome.kind === "found") return { transaction: outcome.transaction, unavailable: false };
            if (outcome.kind === "missed") return { unavailable: true };
            lastFailureReason = outcome.reason;
          } else {
            lastFailureReason ??= "no chain id is configured for the explorer fallback";
          }
        }
        if (lastFailureReason) {
          return { unavailable: true, reason: lastFailureReason };
        }
        return {
          unavailable: true,
          reason: "configure an RPC endpoint URL or an Etherscan API key to look up a transaction by hash"
        };
      } catch {
        return { unavailable: true, reason: "could not look up the transaction" };
      }
    }
  };
}
const txSourceModule = {
  txsCreateAdapter,
  txsIsUsableEndpoint,
  txsComposeLogUrl,
  txsNormalizeAddress,
  txsParseTransaction
};
window.DxDecode.txSource = txSourceModule;
