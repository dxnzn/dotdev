window.DxDecode ??= {};
const ASRC_V2_BASE = "https://api.etherscan.io/v2/api";
const ASRC_ACTION = "getsourcecode";
const ASRC_ACTION_PARAM = "action";
const ASRC_BODY_CEILING_BYTES = 262144;
const ASRC_UNVERIFIED_SENTENCE = "Contract source code not verified";
const ASRC_ARROW = "\u2192";
const ASRC_ADDRESS_HEX_RE = /^0x[0-9a-fA-F]{40}$/;
function asrcNormalizeAddress(value) {
  if (typeof value !== "string" || !ASRC_ADDRESS_HEX_RE.test(value)) return null;
  return value.toLowerCase();
}
function asrcIsTruncatedResponse(response) {
  return response.truncated === true;
}
function asrcIsFailureEnvelope(body) {
  if (!body || typeof body !== "object") return false;
  return typeof body.result === "string";
}
function asrcIsValidAbiInput(input) {
  if (!input || typeof input !== "object") return false;
  const candidate = input;
  if (typeof candidate.type !== "string") return false;
  if (candidate.components === void 0) return true;
  if (!Array.isArray(candidate.components)) return false;
  return candidate.components.every(asrcIsValidAbiInput);
}
function asrcIsValidFunctionItem(item) {
  if (!item || typeof item !== "object") return false;
  const candidate = item;
  if (typeof candidate.name !== "string" || candidate.name.length === 0) return false;
  if (candidate.type !== void 0 && candidate.type !== "function") return false;
  if (!Array.isArray(candidate.inputs)) return false;
  return candidate.inputs.every(asrcIsValidAbiInput);
}
function asrcValidFunctionItems(parsed) {
  if (!Array.isArray(parsed)) return null;
  const survivors = parsed.filter(asrcIsValidFunctionItem);
  return survivors.length > 0 ? survivors : null;
}
function asrcResolveChainId(settings, options) {
  const suppliedChainId = options?.chainId;
  const settingsChainId = settings.get("chainId");
  return suppliedChainId !== void 0 && suppliedChainId !== null && suppliedChainId !== "" ? suppliedChainId : settingsChainId !== void 0 && settingsChainId !== null && settingsChainId !== "" ? settingsChainId : void 0;
}
async function asrcLookupOutcome(transport, settings, address, options, followDepth) {
  const effectiveChainId = asrcResolveChainId(settings, options);
  if (effectiveChainId === void 0) return { kind: "error" };
  const signal = options?.signal;
  if (signal?.aborted) return { kind: "error" };
  const apiKey = settings.get("etherscanApiKey");
  if (typeof apiKey !== "string" || apiKey.trim().length === 0) return { kind: "error" };
  const url = new URL(ASRC_V2_BASE);
  url.searchParams.set("chainid", String(effectiveChainId));
  url.searchParams.set("module", "contract");
  url.searchParams.set(ASRC_ACTION_PARAM, ASRC_ACTION);
  url.searchParams.set("address", address);
  url.searchParams.set("apikey", apiKey);
  const response = await transport.request({
    method: "GET",
    url: url.toString(),
    maxBytes: ASRC_BODY_CEILING_BYTES,
    signal
  });
  if (!response.ok) return { kind: "error" };
  if (asrcIsTruncatedResponse(response)) return { kind: "error" };
  const body = response.json;
  if (asrcIsFailureEnvelope(body)) return { kind: "error" };
  const item = Array.isArray(body?.result) ? body.result[0] : void 0;
  if (!item || typeof item !== "object") return { kind: "error" };
  const record = item;
  const abiText = record.ABI;
  if (typeof abiText !== "string") return { kind: "error" };
  const trimmed = abiText.trim();
  const looksLikeUnverifiedSentence = trimmed.includes(ASRC_UNVERIFIED_SENTENCE);
  if (!trimmed.startsWith("[") || looksLikeUnverifiedSentence) return { kind: "not-verified" };
  let parsedAbi;
  try {
    parsedAbi = JSON.parse(trimmed);
  } catch {
    return { kind: "error" };
  }
  const validItems = asrcValidFunctionItems(parsedAbi);
  const ownItems = validItems ?? [];
  const contractName = typeof record.ContractName === "string" ? record.ContractName : "";
  if (followDepth === 0 && record.Proxy === "1") {
    const normalizedImpl = asrcNormalizeAddress(record.Implementation);
    const normalizedSelf = asrcNormalizeAddress(address);
    if (normalizedImpl && normalizedImpl !== normalizedSelf) {
      const implOutcome = await asrcLookupOutcome(
        transport,
        settings,
        normalizedImpl,
        { chainId: effectiveChainId, signal },
        followDepth + 1
      );
      if (implOutcome.kind === "verified") {
        const mergedAbi = [...implOutcome.abi, ...ownItems];
        const composedName = implOutcome.name.length > 0 ? `${contractName} ${ASRC_ARROW} ${implOutcome.name}` : contractName;
        return { kind: "verified", name: composedName, abi: mergedAbi, proxied: true };
      }
      if (implOutcome.kind === "error") return { kind: "error" };
    }
  }
  if (ownItems.length === 0) return { kind: "error" };
  return { kind: "verified", name: contractName, abi: ownItems };
}
async function asrcCachedLookup(transport, settings, cache, address, options) {
  const effectiveChainId = asrcResolveChainId(settings, options);
  if (effectiveChainId === void 0) return null;
  const cacheAddress = asrcNormalizeAddress(address);
  if (cache && cacheAddress) {
    const cached = cache.read(String(effectiveChainId), cacheAddress);
    if (cached.hit) {
      return cached.kind === "verified" ? { name: cached.name, abi: cached.abi } : null;
    }
  }
  const outcome = await asrcLookupOutcome(transport, settings, address, { ...options, chainId: effectiveChainId }, 0);
  if (cache && cacheAddress) {
    if (outcome.kind === "verified") {
      const tier = outcome.proxied ? "memory" : "both";
      cache.write(String(effectiveChainId), cacheAddress, { tier, name: outcome.name, abi: outcome.abi });
    } else if (outcome.kind === "not-verified") {
      cache.write(String(effectiveChainId), cacheAddress, { tier: "negative" });
    }
  }
  return outcome.kind === "verified" ? { name: outcome.name, abi: outcome.abi } : null;
}
function asrcCreateAdapter(transport, settings) {
  const cacheFactory = window.DxDecode?.cache;
  const cache = cacheFactory?.createCache ? cacheFactory.createCache() : void 0;
  return {
    async getAbi(address, options) {
      try {
        return await asrcCachedLookup(transport, settings, cache, address, options);
      } catch {
        return null;
      }
    }
  };
}
const abiSourceModule = {
  createEtherscanAbiSource: asrcCreateAdapter,
  asrcIsTruncatedResponse,
  asrcIsFailureEnvelope,
  asrcValidFunctionItems,
  asrcNormalizeAddress
};
window.DxDecode.abiSource = abiSourceModule;
