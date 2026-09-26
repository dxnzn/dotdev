// window.DxDecode.signatures — the local signature table (05-01). The registry adapters
// (OpenChain, 4byte) and the multi-source resolver are 05-05's; this file must not reach the
// network and contains no `fetch`-shaped identifier (D-15 confines that to transport.ts).
// Loads after core.js and before the decoder files (manifest.json) — decoders-eth-calldata.ts
// creates its own local table instance from this module's factory.
//
// Top-level names take the `sig` prefix (D-14).
window.DxDecode ??= {};

// D-05's discretion area, seeded with the signatures this phase's own vectors and handoff
// §5.4's Majeur list need — each selector independently verified against this file's own
// keccak port (see 05-01-SUMMARY.md), never guessed.
const SIG_LOCAL_TABLE: Record<string, string> = {
  '0xa9059cbb': 'transfer(address,uint256)',
  '0x095ea7b3': 'approve(address,uint256)',
  '0x70a08231': 'balanceOf(address)',
  '0x11c76fd9': 'batchCalls((address,uint256,bytes)[])',
  '0x22fab893': 'executeByVotes(uint256,address,uint256,bytes,bytes32)',
  '0x48215787': 'deployNext(bytes,bytes32)',
  '0x2806b0af': 'mintFromMoloch(address,uint256)',
  '0xac6695d1': 'claimTribute(address,address)',
  '0x329eb839': 'pull()',
};

// A plain object, no class (ORG.md's factory convention) — createLocalSignatureTable() is the
// interchangeable adapter; ethResolveSelector (decoders-eth-calldata.ts) is the consumer that
// never learns it is talking to a Record rather than a network-backed source.
function createLocalSignatureTable(): SignatureLookupPort {
  return {
    async lookup(selector: string): Promise<SignatureLookupResult> {
      const signature = SIG_LOCAL_TABLE[selector.toLowerCase()];
      // A miss here means "not in this table", never "we could not ask" — the local table is
      // always available, so `unavailable` stays false regardless of the outcome.
      return signature
        ? { candidates: [{ signature, source: 'local' }], unavailable: false }
        : { candidates: [], unavailable: false };
    },
  };
}

// A synchronous peek, deliberately NOT part of SignatureLookupPort — that port is async-only by
// contract (D-06), but ethCanDecode (decoders-eth-calldata.ts) needs a synchronous "is this
// selector in the local table" answer, since canDecode may never reach the network (D-23) and an
// async function's Promise cannot be unwrapped synchronously even when nothing inside it awaits.
// Attached to the module object below via a named variable, not a fresh literal typed against
// DxDecodeSignaturesModule, so it is not excess-property-checked — codecs.ts's own established
// pattern for a runtime member the frozen contract does not need to name.
function sigHasLocalSelector(selector: string): boolean {
  return selector.toLowerCase() in SIG_LOCAL_TABLE;
}

// ── The two registry adapters (05-05 Task 1) ─────────────────────────────────────────────

// D-21: OpenChain is preferred over 4byte and is consulted first by createSignatureResolver
// below; this adapter only reports what OpenChain itself said.
const SIG_OPENCHAIN_URL = 'https://api.openchain.xyz/signature-database/v1/lookup';
// RESEARCH.md: samczsun transferred the openchain.xyz domain and repos to Sourcify in 2026;
// api.4byte.sourcify.dev offers the same shape under the new operator. api.openchain.xyz is
// still live and returns exactly the shape this adapter expects (re-verified live), so nothing
// changes now — this is a note for whoever finds a 404 on this host one day.
const SIG_4BYTE_URL = 'https://www.4byte.directory/api/v1/signatures/';

interface SigOpenChainResponse {
  result?: {
    function?: Record<string, { name: string; filtered?: boolean; hasVerifiedContract?: boolean }[] | null>;
  };
}

interface SigFourByteEntry {
  id: number;
  text_signature: string;
}

interface SigFourByteResponse {
  count?: number;
  results?: SigFourByteEntry[];
}

// The one helper that builds every "could not ask" result — every adapter reports a failed
// transport or a malformed body through this, never through a hand-rolled object, so NET-04's
// "a rate limit never crashes a decode, and says so" starts from one place.
function sigUnavailable(reason: string): SignatureLookupResult {
  return { candidates: [], unavailable: true, reason };
}

// Pitfall 3 (RESEARCH.md): OpenChain's miss shape is the value `null` under the selector key —
// checked explicitly for THIS host, never through a shared "results.length === 0" helper that
// would misread 4byte's differently-shaped miss (or vice versa).
function sigOpenChainMiss(entry: unknown): boolean {
  return entry === null;
}

// 4byte's miss shape is a `count` of 0 with an empty `results` array — a different shape from
// OpenChain's, deliberately not sharing a check with sigOpenChainMiss above.
function sigFourByteMiss(body: SigFourByteResponse): boolean {
  return body.count === 0;
}

// Sorts descending by `rank` (ties keep the source's own order — Array#sort is a stable sort).
// OpenChain's rank is a trust hint (hasVerifiedContract/filtered); 4byte's rank is the negated
// id, which turns "sort descending by rank" into "sort ascending by id" — oldest wins (D-21)
// without a second, differently-shaped sort function.
function sigRankCandidates(candidates: SignatureCandidate[]): SignatureCandidate[] {
  return [...candidates].sort((a, b) => (b.rank ?? 0) - (a.rank ?? 0));
}

// The resolver's OWN verification — deliberately duplicating decoders-eth-calldata.ts's later
// check. This one decides WHICH SOURCE answered (so a source returning only junk can't
// permanently disable the next source); the decoder's decides WHICH CANDIDATE is true. Do not
// delete either thinking it is the same check twice — see createSignatureResolver's own
// comment for the failure mode this duplication prevents.
function sigVerifyCandidate(candidate: SignatureCandidate, selector: string): boolean {
  const keccak = window.DxDecode!.keccak as DxDecodeKeccakModule;
  return keccak.selector(candidate.signature) === selector;
}

// D-15: composes a url and calls transport.request(...) — never fetch directly. Only the
// selector leaves the browser: the composed request carries the 4-byte selector and nothing
// derived from the pasted payload, which is the product promise this whole dapp rests on.
function createOpenChainAdapter(transport: TransportPort): SignatureLookupPort {
  return {
    async lookup(selector: string): Promise<SignatureLookupResult> {
      const url = new URL(SIG_OPENCHAIN_URL);
      url.searchParams.set('function', selector);
      url.searchParams.set('filter', 'true');

      const response = await transport.request({ method: 'GET', url: url.toString() });
      if (!response.ok) return sigUnavailable(response.error ?? 'OpenChain request failed');

      const body = response.json as SigOpenChainResponse | null;
      const entry = body?.result?.function?.[selector];

      if (sigOpenChainMiss(entry)) return { candidates: [], unavailable: false };
      if (Array.isArray(entry)) {
        const candidates: SignatureCandidate[] = entry.map((item) => ({
          signature: item.name,
          source: 'openchain',
          rank: (item.hasVerifiedContract ? 2 : 0) + (item.filtered === false ? 1 : 0),
        }));
        return { candidates: sigRankCandidates(candidates), unavailable: false };
      }
      // `entry` is `undefined` when this response simply has no opinion about this selector at
      // all (including a genuinely different host's own shape fed in by mistake) — that is as
      // good as a miss, not an error. Anything else present but neither `null` nor an array is
      // a shape this adapter cannot make sense of.
      if (entry === undefined) return { candidates: [], unavailable: false };
      return sigUnavailable('OpenChain response had an unexpected shape');
    },
  };
}

function create4byteAdapter(transport: TransportPort): SignatureLookupPort {
  return {
    async lookup(selector: string): Promise<SignatureLookupResult> {
      const url = new URL(SIG_4BYTE_URL);
      url.searchParams.set('hex_signature', selector);

      const response = await transport.request({ method: 'GET', url: url.toString() });
      if (!response.ok) return sigUnavailable(response.error ?? '4byte request failed');

      const body = response.json as SigFourByteResponse | null;
      if (!body) return { candidates: [], unavailable: false };

      if (sigFourByteMiss(body)) return { candidates: [], unavailable: false };
      if (Array.isArray(body.results)) {
        // D-21: results arrive newest-id-first — the worst ordering, the junk is recent.
        // rank = -id turns sigRankCandidates' "descending by rank" into "ascending by id",
        // oldest wins, without a second sort function.
        const candidates: SignatureCandidate[] = body.results.map((item) => ({
          signature: item.text_signature,
          source: '4byte',
          rank: -item.id,
        }));
        return { candidates: sigRankCandidates(candidates), unavailable: false };
      }
      if (body.results === undefined) return { candidates: [], unavailable: false };
      return sigUnavailable('4byte response had an unexpected shape');
    },
  };
}

// D-21/D-22: composes OpenChain then 4byte, in that order — "prefer OpenChain over 4byte, and
// never present a single 4byte hit as authoritative". Both registries sit behind the SAME
// transport (the caller's, shared across sources), so both inherit its one token bucket and
// retry policy automatically — nothing here needs to know that.
//
// It keccak-verifies BEFORE deciding a source answered. The obvious composition — stop at the
// first source returning a non-empty candidate list — is wrong: verification happens later, in
// the decoder, so a source returning only candidates that do not hash to the selector would
// permanently prevent the next source from ever being consulted. OpenChain returning junk would
// silently disable the 4byte fallback, and the failure would look like "4byte does not know
// this selector" rather than "we never asked it" (T-05-31). Querying every source always and
// unioning the results was considered and rejected: it doubles the request count for every
// unknown selector against two hosts that publish no rate limit (D-22), on a page whose whole
// posture is that nothing leaves the browser unasked.
function createSignatureResolver(sources: SignatureLookupPort[]): SignatureLookupPort {
  return {
    async lookup(selector: string): Promise<SignatureLookupResult> {
      let unavailableReason: string | undefined;
      let sawUnavailable = false;

      for (const source of sources) {
        const result = await source.lookup(selector);
        if (result.unavailable) {
          sawUnavailable = true;
          if (unavailableReason === undefined) unavailableReason = result.reason;
          continue;
        }
        // Return the source's FULL candidate list (verified and unverified alike) once at
        // least one candidate verifies — the decoder re-verifies as defence in depth and still
        // needs the whole list to rank. This function's own check only decides which SOURCE
        // answered; it never discards a candidate.
        if (result.candidates.some((candidate) => sigVerifyCandidate(candidate, selector))) {
          return { candidates: result.candidates, unavailable: false };
        }
      }

      // Honest aggregation (D-21): unavailable only when nothing verified AND at least one
      // source could not be asked — a clean miss from every source is unavailable: false,
      // a different fact from "we could not ask".
      return sawUnavailable
        ? { candidates: [], unavailable: true, reason: unavailableReason }
        : { candidates: [], unavailable: false };
    },
  };
}

const signaturesModule = {
  createLocalSignatureTable,
  hasLocalSelector: sigHasLocalSelector,
  createOpenChainAdapter,
  create4byteAdapter,
  createSignatureResolver,
};

window.DxDecode.signatures = signaturesModule;
