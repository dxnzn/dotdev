window.DxDecode ??= {};
const SIG_LOCAL_TABLE = {
  "0xa9059cbb": "transfer(address,uint256)",
  "0x095ea7b3": "approve(address,uint256)",
  "0x70a08231": "balanceOf(address)",
  "0x11c76fd9": "batchCalls((address,uint256,bytes)[])",
  // 06-01 (Round 2 review, D-07): replaces the superseded uint256 form — the real deployed
  // contract's op argument is uint8 (`0x36cde4af…656ba`, block 23875426), and the shipped
  // uint256 entry was internally consistent but wrong for it, which is why the real proposal-7
  // outer calldata resolved UNRESOLVED before this plan. Re-derived with this repo's own
  // keccak port before being written (06-01-SUMMARY.md's nine-selector reference block).
  "0xee5b2895": "executeByVotes(uint8,address,uint256,bytes,bytes32)",
  "0x48215787": "deployNext(bytes,bytes32)",
  "0x2806b0af": "mintFromMoloch(address,uint256)",
  "0xac6695d1": "claimTribute(address,address)",
  "0x329eb839": "pull()",
  // 06-01: five further Majeur/Safe entries, each keccak-verified the same way.
  "0x12374b04": "setPermit(uint8,address,uint256,bytes,bytes32,address,uint256)",
  "0xa8841366": "spendPermit(uint8,address,uint256,bytes,bytes32)",
  "0xac9650d8": "multicall(bytes[])",
  "0x252dba42": "aggregate((address,bytes)[])",
  "0x6a761202": "execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes)"
};
function createLocalSignatureTable() {
  return {
    async lookup(selector) {
      const signature = SIG_LOCAL_TABLE[selector.toLowerCase()];
      return signature ? { candidates: [{ signature, source: "local" }], unavailable: false } : { candidates: [], unavailable: false };
    }
  };
}
function sigHasLocalSelector(selector) {
  return selector.toLowerCase() in SIG_LOCAL_TABLE;
}
const SIG_OPENCHAIN_URL = "https://api.openchain.xyz/signature-database/v1/lookup";
const SIG_4BYTE_URL = "https://www.4byte.directory/api/v1/signatures/";
function sigUnavailable(reason) {
  return { candidates: [], unavailable: true, reason };
}
function sigOpenChainMiss(entry) {
  return entry === null;
}
function sigFourByteMiss(body) {
  return body.count === 0;
}
function sigRankCandidates(candidates) {
  return [...candidates].sort((a, b) => (b.rank ?? 0) - (a.rank ?? 0));
}
function sigVerifyCandidate(candidate, selector) {
  const keccak = window.DxDecode.keccak;
  return keccak.selector(candidate.signature) === selector;
}
function createOpenChainAdapter(transport) {
  return {
    async lookup(selector) {
      const url = new URL(SIG_OPENCHAIN_URL);
      url.searchParams.set("function", selector);
      url.searchParams.set("filter", "true");
      const response = await transport.request({ method: "GET", url: url.toString() });
      if (!response.ok) return sigUnavailable(response.error ?? "OpenChain request failed");
      const body = response.json;
      const entry = body?.result?.function?.[selector];
      if (sigOpenChainMiss(entry)) return { candidates: [], unavailable: false };
      if (Array.isArray(entry)) {
        const candidates = entry.map((item) => ({
          signature: item.name,
          source: "openchain",
          rank: (item.hasVerifiedContract ? 2 : 0) + (item.filtered === false ? 1 : 0)
        }));
        return { candidates: sigRankCandidates(candidates), unavailable: false };
      }
      if (entry === void 0) return { candidates: [], unavailable: false };
      return sigUnavailable("OpenChain response had an unexpected shape");
    }
  };
}
function create4byteAdapter(transport) {
  return {
    async lookup(selector) {
      const url = new URL(SIG_4BYTE_URL);
      url.searchParams.set("hex_signature", selector);
      const response = await transport.request({ method: "GET", url: url.toString() });
      if (!response.ok) return sigUnavailable(response.error ?? "4byte request failed");
      const body = response.json;
      if (!body) return { candidates: [], unavailable: false };
      if (sigFourByteMiss(body)) return { candidates: [], unavailable: false };
      if (Array.isArray(body.results)) {
        const candidates = body.results.map((item) => ({
          signature: item.text_signature,
          source: "4byte",
          rank: -item.id
        }));
        return { candidates: sigRankCandidates(candidates), unavailable: false };
      }
      if (body.results === void 0) return { candidates: [], unavailable: false };
      return sigUnavailable("4byte response had an unexpected shape");
    }
  };
}
function createSignatureResolver(sources) {
  return {
    async lookup(selector) {
      let unavailableReason;
      let sawUnavailable = false;
      for (const source of sources) {
        const result = await source.lookup(selector);
        if (result.unavailable) {
          sawUnavailable = true;
          if (unavailableReason === void 0) unavailableReason = result.reason;
          continue;
        }
        if (result.candidates.some((candidate) => sigVerifyCandidate(candidate, selector))) {
          return { candidates: result.candidates, unavailable: false };
        }
      }
      return sawUnavailable ? { candidates: [], unavailable: true, reason: unavailableReason } : { candidates: [], unavailable: false };
    }
  };
}
const signaturesModule = {
  createLocalSignatureTable,
  hasLocalSelector: sigHasLocalSelector,
  createOpenChainAdapter,
  create4byteAdapter,
  createSignatureResolver
};
window.DxDecode.signatures = signaturesModule;
