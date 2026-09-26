// window.DxDecode's url decoder — the second slice of Phase 4, and the decoder that stresses
// the DecodeNode contract's ability to express a TABLE: a query-parameter node is a parent
// node with one child per parameter (D-05), not a <table> element and not a new renderNode
// branch. Loads before decoders-base64.js per manifest.json's more-specific-first ordering
// (D-03), after decoders.ts creates the registry this file's final statement calls into.
//
// Top-level names in this directory must be unique — every file here is a global ambient
// script (no import, no export — D-08), and tsconfig.decode.json compiles them as ONE
// program, so two files sharing a top-level name collide with TS2451. Every top-level binding
// in this file is prefixed `url`, matching decoders-base64.ts's `b64` convention.
window.DxDecode ??= {};

const urlCodecs = window.DxDecode.codecs as DxDecodeCodecsModule;
const urlRegistry = window.DxDecode.registry as DecoderRegistry;

// Well-formed escape: exactly two hex digits after a '%'. Used only as a scoring signal in
// canDecode — the actual decode always goes through urlCodecs.Percent.decode, which is what
// tells a well-formed escape from a malformed one authoritatively.
const URL_WELL_FORMED_ESCAPE_RE = /%[0-9a-fA-F]{2}/;

// A HIERARCHICAL absolute scheme — scheme immediately followed by '://'. This is a deliberate
// scope decision, not an accident of the pattern, and it needs recording here so nobody later
// "fixes" it to a bare ':' and quietly widens what the full-URL branch accepts:
//
// 1. TXT-03 asks for "a full URL" and means one with a host, a path and a query — the
//    components this decoder renders. A non-hierarchical scheme (mailto:, urn:, data:) has
//    none of those, so the full-URL branch would have nothing to do with one; it correctly
//    falls to the percent branch instead.
// 2. The exclusion is also a safety property worth keeping deliberately: a javascript: or
//    data: payload gets no privileged handling here at all — it falls to the percent branch
//    and renders as inert text like everything else, never specially parsed as a "URL".
//
// RegExp literal, never the constructor — the constructor form is not on the portability
// guard's allowlist.
const URL_HIERARCHICAL_SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;

function urlIsHierarchical(candidate: string): boolean {
  return URL_HIERARCHICAL_SCHEME_RE.test(candidate);
}

function urlConstructs(candidate: string): boolean {
  // The URL constructor throws on a malformed URL and nothing in this file may propagate a
  // throw (T-04-07) — wrapped here so a synchronous throw out of canDecode is never left to
  // core.resolve's per-decoder catch to swallow silently.
  try {
    new URL(candidate);
    return true;
  } catch {
    return false;
  }
}

// Synchronous, evaluated in order, returning at the first match. Requiring a '%' escape or a
// real hierarchical scheme — rather than "any text" — is D-10's rule for this decoder, and is
// what keeps the Phase 3 badge cases ('!!! not hex at all !!!', 'not hex at all') resolving to
// nothing. Both scores (0.85, 0.8) clear core.ts's AUTO_DETECT_THRESHOLD (0.5) and neither
// competes with hex (scores 0 for anything containing a non-hex character) or base64 (rejects
// '%' as outside both alphabets). `mailto:someone@example.test` scores 0 here for the same reason: the
// pattern requires '://', and there is no percent escape — the intended answer, pinned by a
// case in the suite.
function urlCanDecode(input: string): number {
  const trimmed = input.trim();
  if (trimmed.length === 0) return 0;
  if (urlIsHierarchical(trimmed) && urlConstructs(trimmed)) return 0.85;
  if (URL_WELL_FORMED_ESCAPE_RE.test(input)) return 0.8;
  return 0;
}

// Why NOT URLSearchParams: its iteration yields ALREADY-DECODED values, and it is lenient
// where Percent.decode is strict — a malformed escape such as %C3 comes back as the Unicode
// replacement character rather than as an error, so the same input would behave one way
// pasted bare and another way inside a URL (two decoders' worth of behaviour behind one
// badge, T-04-26). Decoding the raw query with the same primitive the percent branch uses is
// what makes the two branches agree, and it is also why there is no double-decode hazard
// here: this walk decodes exactly once, from text that was never decoded.
//
// Why '+' becomes a space HERE and not in the percent branch: '+' means space only under
// application/x-www-form-urlencoded, which is what a query string is; it is an ordinary
// literal character everywhere else, and decodeURIComponent('a+b') correctly returns 'a+b'.
// So this walk applies the form-encoding rule and urlBuildPercentBranchOutput does not. That
// is a real asymmetry, it is correct, and the suite pins both halves in one case so it reads
// as a decision rather than a bug.
function urlDecodeQueryComponent(raw: string): { ok: true; value: string } | { ok: false; error: string } {
  return urlCodecs.Percent.decode(raw.replace(/\+/g, '%20'));
}

// The query node is D-05's table, expressed as structure rather than as markup: a parent node
// with one child per parameter. Repeated parameter names produce sibling rows in source order
// — that is the adjacency behaviour the suite pins, correct because position is identity in
// this tree (03 D-03).
function urlBuildQueryNode(url: URL): DecodeNode {
  const rawQuery = url.search.startsWith('?') ? url.search.slice(1) : url.search;
  if (rawQuery.length === 0) {
    // Present either way, following decoders.ts's own rule — an omitted node would leave a
    // reader unable to tell "no query parameters" from "not checked".
    return { label: 'query', annotations: ['no query parameters'] };
  }

  const children: DecodeNode[] = [];
  for (const pair of rawQuery.split('&')) {
    if (pair.length === 0) continue;
    // Split on the FIRST '=' only — a value may legitimately contain more.
    const eqIndex = pair.indexOf('=');
    const rawName = eqIndex === -1 ? pair : pair.slice(0, eqIndex);
    const rawValue = eqIndex === -1 ? '' : pair.slice(eqIndex + 1);

    const nameResult = urlDecodeQueryComponent(rawName);
    const valueResult = urlDecodeQueryComponent(rawValue);
    if (nameResult.ok && valueResult.ok) {
      children.push({ label: nameResult.value, value: valueResult.value, display: 'text', raw: valueResult.value });
    } else {
      // The branch-consistency behaviour: a malformed escape (%C3) behaves the same inside a
      // URL as it does pasted bare — an error row, never a value containing U+FFFD. The other
      // rows in the same query still decode normally.
      const failure = !nameResult.ok ? nameResult : (valueResult as { ok: false; error: string });
      children.push({ label: rawName, error: failure.error, raw: rawValue });
    }
  }
  return { label: 'query', children };
}

// The full-URL branch's root carries the ORIGINAL input's bytes, never a re-composed
// half-decoded line — see the comment on urlBuildPercentBranchOutput's counterpart below for
// why both branches deliberately disagree on what Raw carries.
function urlBuildFullUrlOutput(originalInput: string, url: URL): DecodeOutput {
  const scheme: DecodeNode = { label: 'scheme', value: url.protocol, display: 'text', raw: url.protocol };
  // hostname, NOT host — url.host includes the port when one is present (x.test:8443), so a
  // row labelled 'host' valued from it would be ambiguous about what it contains. hostname is
  // unambiguous and the port gets its own row.
  const host: DecodeNode = { label: 'host', value: url.hostname, display: 'text', raw: url.hostname };
  const port: DecodeNode = { label: 'port', value: url.port, display: 'text', raw: url.port };
  if (url.port === '') {
    // url.port is the empty string when the scheme's default port applies. Present either way
    // — an omitted row leaves a reader unable to tell "no port" from "not checked".
    port.annotations = ["the scheme's default port is in use"];
  }
  const path: DecodeNode = { label: 'path', value: url.pathname, display: 'text', raw: url.pathname };
  const query = urlBuildQueryNode(url);

  // WR-02: the two components a phishing link hides — userinfo (the real host is the "host"
  // row, not whatever sits before '@') and fragment (this site's own share links carry their
  // parameters there — '#/tools/decode/?data=…' — so an omitted row here would hide the exact
  // mechanism a reader most needs decoded). Present either way, same rule as `port` above.
  const userinfo: DecodeNode = {
    label: 'userinfo',
    value: url.username,
    display: 'text',
    raw: url.username,
  };
  if (url.username === '' && url.password === '') {
    userinfo.annotations = ['no credentials in the authority'];
  } else {
    userinfo.warning = 'credentials embedded before the host — the real host is the "host" row';
  }
  if (url.password !== '') {
    userinfo.annotations = [...(userinfo.annotations ?? []), 'password present — not shown'];
  }

  const fragmentRaw = url.hash.startsWith('#') ? url.hash.slice(1) : url.hash;
  const fragment: DecodeNode = { label: 'fragment', value: fragmentRaw, display: 'text', raw: fragmentRaw };
  if (fragmentRaw === '') fragment.annotations = ['no fragment'];

  const node: DecodeNode = {
    label: 'url',
    value: null,
    raw: originalInput,
    children: [scheme, userinfo, host, port, path, query, fragment],
  };

  return {
    node,
    // A full URL has no single decoded byte string — each component decodes independently
    // and only the tree can show that, so re-composing a half-decoded line for the Raw tab
    // would invent a string that never existed. The original input is the one unambiguous
    // byte string a URL has, and it is also what a person clicking the root row wants on
    // their clipboard.
    rawBytes: new TextEncoder().encode(originalInput),
    rawView: 'hex-dump',
  };
}

// The percent branch's root carries the DECODED string's bytes — the deliberate mirror image
// of urlBuildFullUrlOutput's original-input choice, both pinned together by one suite case.
function urlBuildPercentBranchOutput(input: string): DecodeOutput {
  const result = urlCodecs.Percent.decode(input);
  if (!result.ok) {
    // DEC-12's concrete instance for this decoder: malformed input becomes a returned error
    // node, never a thrown exception or a rejected promise.
    return { node: { label: 'url', error: result.error, raw: input }, rawBytes: null };
  }

  const decoded: DecodeNode = { label: 'decoded', value: result.value, display: 'text', raw: result.value };
  if (result.value === input) {
    // A success that changed nothing and said nothing reads as a decode; saying so is the
    // difference between a result and a shrug — covers a mailto: input or plain text reaching
    // this branch with no percent escapes present.
    decoded.annotations = ['no percent escapes were present'];
  }

  const node: DecodeNode = { label: 'url', value: null, raw: result.value, children: [decoded] };
  return {
    node,
    rawBytes: new TextEncoder().encode(result.value),
    rawView: 'hex-dump',
  };
}

async function urlDecode(input: string, _ctx: DecodeContext): Promise<DecodeOutput> {
  const trimmed = input.trim();
  if (urlIsHierarchical(trimmed)) {
    try {
      const url = new URL(trimmed);
      return urlBuildFullUrlOutput(input, url);
    } catch {
      // A scheme-shaped string that will not parse is still worth percent-decoding — fall
      // through rather than erroring, mirroring canDecode's identical fallthrough.
    }
  }
  return urlBuildPercentBranchOutput(input);
}

const urlDecoder: DecoderPort = {
  id: 'url',
  label: 'Url',
  settings: [],
  canDecode: urlCanDecode,
  decode: urlDecode,
};

// D-05's self-registration — the final statement.
urlRegistry.register(urlDecoder);
