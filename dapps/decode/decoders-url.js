window.DxDecode ??= {};
const urlCodecs = window.DxDecode.codecs;
const urlRegistry = window.DxDecode.registry;
const URL_WELL_FORMED_ESCAPE_RE = /%[0-9a-fA-F]{2}/;
const URL_HIERARCHICAL_SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;
function urlIsHierarchical(candidate) {
  return URL_HIERARCHICAL_SCHEME_RE.test(candidate);
}
function urlConstructs(candidate) {
  try {
    new URL(candidate);
    return true;
  } catch {
    return false;
  }
}
function urlCanDecode(input) {
  const trimmed = input.trim();
  if (trimmed.length === 0) return 0;
  if (urlIsHierarchical(trimmed) && urlConstructs(trimmed)) return 0.85;
  if (URL_WELL_FORMED_ESCAPE_RE.test(input)) return 0.8;
  return 0;
}
function urlDecodeQueryComponent(raw) {
  return urlCodecs.Percent.decode(raw.replace(/\+/g, "%20"));
}
function urlBuildQueryNode(url) {
  const rawQuery = url.search.startsWith("?") ? url.search.slice(1) : url.search;
  if (rawQuery.length === 0) {
    return { label: "query", annotations: ["no query parameters"] };
  }
  const children = [];
  for (const pair of rawQuery.split("&")) {
    if (pair.length === 0) continue;
    const eqIndex = pair.indexOf("=");
    const rawName = eqIndex === -1 ? pair : pair.slice(0, eqIndex);
    const rawValue = eqIndex === -1 ? "" : pair.slice(eqIndex + 1);
    const nameResult = urlDecodeQueryComponent(rawName);
    const valueResult = urlDecodeQueryComponent(rawValue);
    if (nameResult.ok && valueResult.ok) {
      children.push({ label: nameResult.value, value: valueResult.value, display: "text", raw: valueResult.value });
    } else {
      const failure = !nameResult.ok ? nameResult : valueResult;
      children.push({ label: rawName, error: failure.error, raw: rawValue });
    }
  }
  return { label: "query", children };
}
function urlBuildFullUrlOutput(originalInput, url) {
  const scheme = { label: "scheme", value: url.protocol, display: "text", raw: url.protocol };
  const host = { label: "host", value: url.hostname, display: "text", raw: url.hostname };
  const port = { label: "port", value: url.port, display: "text", raw: url.port };
  if (url.port === "") {
    port.annotations = ["the scheme's default port is in use"];
  }
  const path = { label: "path", value: url.pathname, display: "text", raw: url.pathname };
  const query = urlBuildQueryNode(url);
  const userinfo = {
    label: "userinfo",
    value: url.username,
    display: "text",
    raw: url.username
  };
  if (url.username === "" && url.password === "") {
    userinfo.annotations = ["no credentials in the authority"];
  } else {
    userinfo.warning = 'credentials embedded before the host \u2014 the real host is the "host" row';
  }
  if (url.password !== "") {
    userinfo.annotations = [...userinfo.annotations ?? [], "password present \u2014 not shown"];
  }
  const fragmentRaw = url.hash.startsWith("#") ? url.hash.slice(1) : url.hash;
  const fragment = { label: "fragment", value: fragmentRaw, display: "text", raw: fragmentRaw };
  if (fragmentRaw === "") fragment.annotations = ["no fragment"];
  const node = {
    label: "url",
    value: null,
    raw: originalInput,
    children: [scheme, userinfo, host, port, path, query, fragment]
  };
  return {
    node,
    // A full URL has no single decoded byte string — each component decodes independently
    // and only the tree can show that, so re-composing a half-decoded line for the Raw tab
    // would invent a string that never existed. The original input is the one unambiguous
    // byte string a URL has, and it is also what a person clicking the root row wants on
    // their clipboard.
    rawBytes: new TextEncoder().encode(originalInput),
    rawView: "hex-dump"
  };
}
function urlBuildPercentBranchOutput(input) {
  const result = urlCodecs.Percent.decode(input);
  if (!result.ok) {
    return { node: { label: "url", error: result.error, raw: input }, rawBytes: null };
  }
  const decoded = { label: "decoded", value: result.value, display: "text", raw: result.value };
  if (result.value === input) {
    decoded.annotations = ["no percent escapes were present"];
  }
  const node = { label: "url", value: null, raw: result.value, children: [decoded] };
  return {
    node,
    rawBytes: new TextEncoder().encode(result.value),
    rawView: "hex-dump"
  };
}
async function urlDecode(input, _ctx) {
  const trimmed = input.trim();
  if (urlIsHierarchical(trimmed)) {
    try {
      const url = new URL(trimmed);
      return urlBuildFullUrlOutput(input, url);
    } catch {
    }
  }
  return urlBuildPercentBranchOutput(input);
}
const urlDecoder = {
  id: "url",
  label: "Url",
  settings: [],
  canDecode: urlCanDecode,
  decode: urlDecode
};
urlRegistry.register(urlDecoder);
