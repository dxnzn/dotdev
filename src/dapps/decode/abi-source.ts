// window.DxDecode.abiSource — the verified-ABI adapter for D-06's rung (06-03). Fetches a
// target's source-code entry through the SHARED transport (never `fetch` directly — D-15 confines
// that identifier to transport.ts), follows a proxy's implementation one level (D-11/NET-09), and
// hands the decoder a validated `{ name, abi }` pair or `null`. Loads immediately after cache.js
// and before annotators.js (manifest.json) — the recursion pass and the decoder both reach this
// module only through the DecodeContext.abis port, never by naming this file.
//
// 06-04: wraps every OUTER lookup in window.DxDecode.cache (feature-detected — a host shell
// without cache.js gets no caching, never a throw), so a repeated lookup for the same target and
// chain within a mounted session is served without a request. See asrcCachedLookup, below.
//
// Top-level names take the `asrc` prefix (D-14) — the directory is one TypeScript program and a
// collision with a `sig`, `net`, `eth`, `abi`, `ann`, `cch` or `ui` prefixed name will not
// compile.
window.DxDecode ??= {};

// D-09: the v2 endpoint takes `chainid` as a query parameter, never a per-chain subdomain — the
// v1 per-chain-subdomain form is deprecated and returns a migration notice on every call.
const ASRC_V2_BASE = 'https://api.etherscan.io/v2/api';

// D-09: `getsourcecode`, not the narrower `getabi` — one request must serve the ABI, the
// contract name (ETH-12) and the proxy fields (NET-09) together.
const ASRC_ACTION = 'getsourcecode';

// The query-parameter NAME this endpoint expects for the call above. The whole word is one of
// the portability guard's banned NETWORK_IDENTIFIERS (test/decode-portability.test.ts): a bare
// "action" reads as an HTML form's network-triggering attribute. This occurrence is a
// third-party query-parameter NAME, not a network primitive this directory is forbidden from
// naming — WR-05 (06-REVIEW.md) replaced the previous template-literal concatenation workaround
// (which the guard's own stripper could not see through, and which was ITSELF a worked example
// of the same evasion the guard now closes for `fetch`/`localStorage`) with this plain literal,
// audited as the guard's one explicit per-file exemption (ALLOWED_PROTOCOL_LITERALS).
const ASRC_ACTION_PARAM = 'action';

// T-06-08/D-10 (Pitfall 3, RESEARCH.md Assumption A2/A4): `getsourcecode` inlines the target's
// entire Solidity source in the same JSON object as its ABI, so the transport's global 64 KB body
// cap would silently resolve a real, non-trivial verified contract as "no ABI". 262144 bytes is a
// generous STARTING POINT tuned against illustrative large-contract sizes, not a documented
// ceiling — Task 1's `truncated` report exists precisely so this number can be diagnosed and
// raised later rather than guessed blind.
const ASRC_BODY_CEILING_BYTES = 262144;

// RESEARCH.md Assumption A1: the exact unverified-contract ABI text could not be confirmed live
// (no API key available during research). Matched defensively as a CONTAINMENT check beside the
// structural test below (`!text.startsWith('[')`), never instead of it — if this literal is
// wrong or has changed, the structural test alone still catches every unverified contract.
const ASRC_UNVERIFIED_SENTENCE = 'Contract source code not verified';

// NET-09: the exact separator between a proxy's own name and its implementation's — a single
// space, U+2192 RIGHTWARDS ARROW, a single space. Named so the composition below reads as "the
// one separator this requirement specifies" rather than a string literal repeated twice.
const ASRC_ARROW = '→';

// D-11/T-06-11: validated CASE-INSENSITIVELY, then NORMALISED to lowercase — never required to
// already be lowercase. decoders-eth-calldata.ts's own ETH_ADDRESS_HEX_RE is lowercase-only, and
// correctly so: it guards values abi.ts produced, which are lowercase by construction. A
// third-party explorer response is a DIFFERENT provenance and returns EIP-55 checksummed casing
// as a matter of course — reusing that lowercase-only regex here would reject legitimate data and
// silently drop the proxy follow on every real proxy, while looking like a security control. The
// two regexes are deliberately different for this reason; do not unify them. The same rule is
// meant to extend to every other third-party address this phase ingests (a later plan's
// transaction recipient/sender).
const ASRC_ADDRESS_HEX_RE = /^0x[0-9a-fA-F]{40}$/;

function asrcNormalizeAddress(value: unknown): string | null {
  if (typeof value !== 'string' || !ASRC_ADDRESS_HEX_RE.test(value)) return null;
  return value.toLowerCase();
}

// D-10 (this task): distinguishes "the ceiling was too small for this contract" from "this
// contract is not verified" — both would otherwise collapse into the same null parsed member.
// Exposed as a named predicate rather than folded into the unverified branch inline, so a test
// can prove the two are actually distinguishable rather than trusting a comment.
function asrcIsTruncatedResponse(response: HttpResponse): boolean {
  return response.truncated === true;
}

// D-13 (future never-cache trigger, Plan 04): the general in-body failure envelope — Etherscan's
// `result` arrives as a bare STRING rather than an array on every error (rate limit, invalid key,
// and any other in-body failure this adapter has not seen a specific shape for). Never folded
// into the unverified-contract branch: a failure to ASK is a different fact from having asked and
// found the contract unverified.
function asrcIsFailureEnvelope(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false;
  return typeof (body as { result?: unknown }).result === 'string';
}

// Recurses through `components` (a tuple's nested inputs) — an ABI item's own `inputs` array can
// nest arbitrarily deep, and a malformed entry at any depth must not pass as valid.
function asrcIsValidAbiInput(input: unknown): boolean {
  if (!input || typeof input !== 'object') return false;
  const candidate = input as { type?: unknown; components?: unknown };
  if (typeof candidate.type !== 'string') return false;
  if (candidate.components === undefined) return true;
  if (!Array.isArray(candidate.components)) return false;
  return candidate.components.every(asrcIsValidAbiInput);
}

function asrcIsValidFunctionItem(item: unknown): item is AbiItem {
  if (!item || typeof item !== 'object') return false;
  const candidate = item as { name?: unknown; type?: unknown; inputs?: unknown };
  if (typeof candidate.name !== 'string' || candidate.name.length === 0) return false;
  if (candidate.type !== undefined && candidate.type !== 'function') return false;
  if (!Array.isArray(candidate.inputs)) return false;
  return candidate.inputs.every(asrcIsValidAbiInput);
}

// T-06-09: FILTERS rather than aborts. decoders-eth-calldata.ts's selector walk
// (`ethResolveSelector`) iterates every returned item inside ONE try/catch around the whole loop
// — a single malformed item early in a hostile array would otherwise throw out of that loop and
// silently discard every valid item after it, removing the verified rung entirely with no
// message saying why. Returns the surviving items, or null when nothing survives (an empty
// survivor list is reported as an unverified contract, never as an empty success).
function asrcValidFunctionItems(parsed: unknown): AbiItem[] | null {
  if (!Array.isArray(parsed)) return null;
  const survivors = parsed.filter(asrcIsValidFunctionItem);
  return survivors.length > 0 ? survivors : null;
}

// D-08: resolved FIRST, before any other work — 06-04's cache key needs an effective chain id
// before its own read, and a lookup with no resolvable chain id must short-circuit to no request
// and no cache read/write rather than caching under an undefined key. Prefer the caller's own
// chain id (a proxy follow reuses the top lookup's already-resolved id) over the settings value;
// never guess one. Shared by the cache wrapper (asrcCachedLookup) and the lookup body itself
// (asrcLookupOutcome) so both agree on the same value from the same settings snapshot.
function asrcResolveChainId(
  settings: SettingsPort,
  options: AbiLookupOptions | undefined,
): number | string | undefined {
  const suppliedChainId = options?.chainId;
  const settingsChainId = settings.get('chainId');
  return suppliedChainId !== undefined && suppliedChainId !== null && suppliedChainId !== ''
    ? suppliedChainId
    : settingsChainId !== undefined && settingsChainId !== null && settingsChainId !== ''
      ? (settingsChainId as number | string)
      : undefined;
}

// 06-04: the three-way outcome the cache wrapper needs to tell apart, where the public
// AbiSourcePort.getAbi contract (a bare `{name,abi} | null`) cannot. 'not-verified' is a real
// answer — a contract that was asked about and IS genuinely not verified — never folded into
// 'error', which is an error about the LOOKUP (a transport failure, an in-body failure envelope,
// a truncated response, a parse or structural failure): D-13/NET-08 forbid caching the latter at
// all, and collapsing the two would mean re-fetching every ordinary wallet address on every
// decode (Plan 06's name walk looks up every distinct address in the tree).
type AsrcOutcome = { kind: 'verified'; name: string; abi: AbiItem[] } | { kind: 'not-verified' } | { kind: 'error' };

// The one recursive lookup body — `asrcCachedLookup`'s outer call passes followDepth 0; a proxy
// follow (below) calls it again with followDepth 1 and refuses to follow a second time, bounding
// NET-09's proxy chase to exactly one extra level so a self-referencing pair cannot loop. Never
// consults or writes the cache itself — that is `asrcCachedLookup`'s job, wrapping exactly this
// function's OUTER (followDepth 0) call. A proxy's implementation-address sub-lookup is therefore
// never separately cached under the implementation's own key; only the merged, proxy-keyed result
// the outer call returns is.
async function asrcLookupOutcome(
  transport: TransportPort,
  settings: SettingsPort,
  address: string,
  options: AbiLookupOptions | undefined,
  followDepth: number,
): Promise<AsrcOutcome> {
  const effectiveChainId = asrcResolveChainId(settings, options);
  if (effectiveChainId === undefined) return { kind: 'error' };

  const signal = options?.signal;
  if (signal?.aborted) return { kind: 'error' };

  // D-08: read per call, from the settings closure, never bound at construction —
  // createLiveExplorerLinks (ui.ts) is the established precedent for why: a mid-session key/chain
  // change must not keep using a stale value captured once at mount.
  const apiKey = settings.get('etherscanApiKey');
  if (typeof apiKey !== 'string' || apiKey.trim().length === 0) return { kind: 'error' };

  const url = new URL(ASRC_V2_BASE);
  url.searchParams.set('chainid', String(effectiveChainId));
  url.searchParams.set('module', 'contract');
  url.searchParams.set(ASRC_ACTION_PARAM, ASRC_ACTION);
  url.searchParams.set('address', address);
  url.searchParams.set('apikey', apiKey);

  // Every request this adapter issues carries the signal it was given — the transport's
  // per-caller detachment only fires when a signal is actually passed, and a recursive decode
  // can issue one of these per distinct nested target, so an abandoned decode that cannot detach
  // leaves a queue of requests holding tokens the next decode needs.
  const response = await transport.request({
    method: 'GET',
    url: url.toString(),
    maxBytes: ASRC_BODY_CEILING_BYTES,
    signal,
  });

  if (!response.ok) return { kind: 'error' };
  if (asrcIsTruncatedResponse(response)) return { kind: 'error' };

  const body = response.json as { status?: unknown; result?: unknown } | null;
  if (asrcIsFailureEnvelope(body)) return { kind: 'error' };

  const item = Array.isArray(body?.result) ? (body.result as unknown[])[0] : undefined;
  if (!item || typeof item !== 'object') return { kind: 'error' };
  const record = item as Record<string, unknown>;

  const abiText = record.ABI;
  if (typeof abiText !== 'string') return { kind: 'error' };
  const trimmed = abiText.trim();
  const looksLikeUnverifiedSentence = trimmed.includes(ASRC_UNVERIFIED_SENTENCE);
  // 06-04: a genuine, positive "not verified" answer — never folded into 'error'. This is what
  // the memory-tier negative cache (asrcCachedLookup, below) exists to remember.
  if (!trimmed.startsWith('[') || looksLikeUnverifiedSentence) return { kind: 'not-verified' };

  let parsedAbi: unknown;
  try {
    parsedAbi = JSON.parse(trimmed);
  } catch {
    return { kind: 'error' };
  }

  const validItems = asrcValidFunctionItems(parsedAbi);
  // No function item survived structural filtering — ambiguous rather than a confirmed negative
  // (the contract IS verified; it may simply expose no functions this decoder can use), so this
  // is kept in the 'error'/never-cache bucket rather than risked as a false negative.
  if (!validItems) return { kind: 'error' };

  const contractName = typeof record.ContractName === 'string' ? record.ContractName : '';

  // D-11/NET-09: proxy following, bounded to exactly one further level. Re-validate the
  // implementation address before it becomes a second request parameter — it comes from a third
  // party — and skip the follow entirely (no second lookup) when it is absent, malformed, or the
  // proxy's own address (a degenerate self-proxy that would cost a request to learn nothing).
  if (followDepth === 0 && record.Proxy === '1') {
    const normalizedImpl = asrcNormalizeAddress(record.Implementation);
    const normalizedSelf = asrcNormalizeAddress(address);
    if (normalizedImpl && normalizedImpl !== normalizedSelf) {
      const implOutcome = await asrcLookupOutcome(
        transport,
        settings,
        normalizedImpl,
        { chainId: effectiveChainId, signal },
        followDepth + 1,
      );
      if (implOutcome.kind === 'verified') {
        // Implementation entries FIRST: decoders-eth-calldata.ts's selector walk iterates the
        // returned array in order and returns the first keccak match, so putting the
        // implementation's own entries ahead of the proxy's own makes them win a selector
        // collision without a second, differently-shaped merge function.
        const mergedAbi = [...implOutcome.abi, ...validItems];
        const composedName =
          implOutcome.name.length > 0 ? `${contractName} ${ASRC_ARROW} ${implOutcome.name}` : contractName;
        return { kind: 'verified', name: composedName, abi: mergedAbi };
      }
      // CR-02: 'error' and 'not-verified' are NOT the same fall-through. 'error' means the
      // implementation sub-lookup could not be completed — a transport failure, an in-body
      // failure envelope, a truncated response, or the shared signal having fired (including via
      // CR-01's abort path) — an error about THIS LOOKUP, never an answer about the contract.
      // Falling through here would return the proxy's own (typically fallback/upgradeTo/admin-
      // only) ABI labelled 'verified', and asrcCachedLookup persists a 'verified' outcome to
      // BOTH tiers for the full 7-day TTL — silently degrading every later decode of this proxy
      // for a week over one transient failure. Propagate the error instead so the cache wrapper's
      // existing 'error' — never written to either tier — branch does the right thing.
      if (implOutcome.kind === 'error') return { kind: 'error' };
      // Only 'not-verified' reaches here: a genuine, positive answer that the implementation is
      // not verified — the proxy's own ABI IS the honest whole answer. Fall through to the
      // proxy's own ABI and name below, no further request. Its own outcome is never separately
      // cached under the implementation's key — only the merged result below is, under the
      // PROXY's own address (asrcCachedLookup).
    }
  }

  return { kind: 'verified', name: contractName, abi: validItems };
}

// 06-04/NET-08: the cache wrapper around the OUTER (followDepth 0) lookup only — a proxy's
// implementation sub-lookup (above) is never separately cached. Consults the cache for the
// target and effective chain BEFORE issuing any request; after the lookup settles, writes
// according to which of three outcomes it was:
//
//   - Never cached — a transport failure, the in-body failure envelope, a truncated response, or
//     a parse/structural failure ('error'). Each is an error about the LOOKUP, not an answer
//     about the CONTRACT, and D-13/NET-08 forbid caching them.
//   - Both tiers, the full time-to-live — a verified contract ('verified'). A contract's verified
//     ABI does not change, so this is the long-lived answer NET-08 is written for.
//   - Memory tier only, with its own short time-to-live — a contract asked about and genuinely
//     NOT verified ('not-verified'). Kept out of persistence because a contract can become
//     verified between sessions and a persisted "no" would outlive the fact; kept in memory (not
//     dropped entirely) because Plan 06's name walk looks up every distinct address in a decoded
//     tree, most of them ordinary wallets, and re-fetching each one per node (rather than once
//     per mounted session) would spend a token from the shared 3 req/s bucket on every one.
async function asrcCachedLookup(
  transport: TransportPort,
  settings: SettingsPort,
  cache: AsrcCacheInstance | undefined,
  address: string,
  options: AbiLookupOptions | undefined,
): Promise<{ name: string; abi: AbiItem[] } | null> {
  const effectiveChainId = asrcResolveChainId(settings, options);
  // D-08/06-04: resolved before the cache read — a lookup with no resolvable chain id never
  // reaches the cache at all.
  if (effectiveChainId === undefined) return null;

  const cacheAddress = asrcNormalizeAddress(address);

  if (cache && cacheAddress) {
    const cached = cache.read(String(effectiveChainId), cacheAddress);
    if (cached.hit) {
      return cached.kind === 'verified' ? { name: cached.name, abi: cached.abi } : null;
    }
  }

  const outcome = await asrcLookupOutcome(transport, settings, address, { ...options, chainId: effectiveChainId }, 0);

  if (cache && cacheAddress) {
    if (outcome.kind === 'verified') {
      cache.write(String(effectiveChainId), cacheAddress, { tier: 'both', name: outcome.name, abi: outcome.abi });
    } else if (outcome.kind === 'not-verified') {
      cache.write(String(effectiveChainId), cacheAddress, { tier: 'negative' });
    }
    // 'error' — never written to either tier.
  }

  return outcome.kind === 'verified' ? { name: outcome.name, abi: outcome.abi } : null;
}

// The cache module's public shape, as far as this file consumes it — WR-02-style local
// extension of the frozen `DxDecodeCacheModule` (`createCache?(): unknown`), matching
// decoders-eth-calldata.ts's own `EthSignaturesModuleWithLocalPeek` precedent for a real runtime
// member kept out of the module-shaped contract itself.
type AsrcCacheReadResult =
  | { hit: false }
  | { hit: true; kind: 'verified'; name: string; abi: AbiItem[] }
  | { hit: true; kind: 'negative' };

interface AsrcCacheInstance {
  read(chainId: string, address: string): AsrcCacheReadResult;
  write(
    chainId: string,
    address: string,
    value: { tier: 'both'; name: string; abi: AbiItem[] } | { tier: 'negative' },
  ): void;
}

interface CacheModuleWithFactory {
  createCache(): AsrcCacheInstance;
}

// Following createOpenChainAdapter's established factory shape (signatures.ts) — a
// TransportPort-consuming adapter that never throws. `settings` is this factory's own second
// parameter (D-08): the chain id and the api key are read from it per call, inside
// asrcLookupOutcome, never bound once at construction.
function asrcCreateAdapter(transport: TransportPort, settings: SettingsPort): AbiSourcePort {
  // 06-04: constructed ONCE here, at adapter-construction time — ui.ts's `createDecodeAdapters`
  // calls this factory once per mount, never per decode, so the memory tier (and its negative
  // answers) live for the whole mounted session. Feature-detected: a host shell that loads
  // abi-source.js without cache.js gets no caching and must not throw.
  const cacheFactory = window.DxDecode?.cache as CacheModuleWithFactory | undefined;
  const cache = cacheFactory?.createCache ? cacheFactory.createCache() : undefined;

  return {
    async getAbi(address: string, options?: AbiLookupOptions): Promise<{ name: string; abi: AbiItem[] } | null> {
      try {
        return await asrcCachedLookup(transport, settings, cache, address, options);
      } catch {
        // DEC-12's never-throw invariant, defensive: every branch above already degrades to
        // null rather than throwing, but this outer catch is the adapter's own promise to the
        // contract regardless of what a future edit adds above it.
        return null;
      }
    },
  };
}

// Attached via a named variable, not a fresh object literal typed against
// DxDecodeAbiSourceModule — signatures.ts's own established excess-property-check sidestep,
// since only createEtherscanAbiSource is a member of the frozen contract and the rest of this
// file's top-level functions are exposed here purely so the test suite can exercise them
// directly. Renamed at this one property, matching signatures.ts's own
// `hasLocalSelector: sigHasLocalSelector` precedent — the public contract name is
// `createEtherscanAbiSource`; the file's own top-level declaration keeps the `asrc` prefix.
const abiSourceModule = {
  createEtherscanAbiSource: asrcCreateAdapter,
  asrcIsTruncatedResponse,
  asrcIsFailureEnvelope,
  asrcValidFunctionItems,
  asrcNormalizeAddress,
};

window.DxDecode.abiSource = abiSourceModule;
