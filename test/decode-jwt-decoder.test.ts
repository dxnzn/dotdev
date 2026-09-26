import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

// TXT-04's offline vector suite — same compiled-load idiom as test/decode-codecs.test.ts,
// test/decode-base64-decoder.test.ts and test/decode-url-decoder.test.ts:
// `new Function('window', code)(window)` against the real jsdom `window`, then access through
// window.DxDecode.registry.get('jwt'). `make test`/CI build before they test for exactly this
// reason (Makefile `test: lint build`).
function loadCompiled(relPath: string): void {
  const code = readFileSync(resolve(__dirname, relPath), 'utf-8');
  new Function('window', code)(window);
}

beforeAll(() => {
  loadCompiled('../src/dapps/decode/codecs.js');
  loadCompiled('../src/dapps/decode/core.js');
  loadCompiled('../src/dapps/decode/decoders.js');
  loadCompiled('../src/dapps/decode/decoders-jwt.js');
  loadCompiled('../src/dapps/decode/decoders-url.js');
  loadCompiled('../src/dapps/decode/decoders-base64.js');
  // Task 2: loaded here (this suite's own explicit list, not the manifest-derived one
  // test/decode-ui.test.ts uses) so the renderNode test hook is reachable.
  loadCompiled('../src/dapps/decode/ui.js');
});

// biome's noExplicitAny is disabled repo-wide (biome.json) — matches the cast every other
// compiled-module-boundary test in this repo already uses.
const codecs = () => (window as any).DxDecode.codecs;
const core = () => (window as any).DxDecode.core;
const registry = () => (window as any).DxDecode.registry;
const ui = () => (window as any).DxDecode.ui;
const jwtDecoder = () => registry().get('jwt');

// Node's own base64url encoder — test-only, not a decoder-side primitive. Never padded, never
// using the standard alphabet, matching RFC 7515's real JWT segment shape.
function b64url(input: string): string {
  return Buffer.from(input, 'utf-8').toString('base64url');
}

function makeToken(header: unknown, payload: unknown, signature = 'sig'): string {
  return `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}.${signature}`;
}

// handoff §7.5's exact vector.
const HANDOFF_VECTOR = 'eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjE3MDAwMDAwMDB9.sig';

describe('codecs.Base64.splitSegments', () => {
  it("splits 'a.b.c' into three segments", () => {
    expect(codecs().Base64.splitSegments('a.b.c')).toEqual(['a', 'b', 'c']);
  });

  it('strips embedded whitespace before splitting, matching the whitespace-free form', () => {
    expect(codecs().Base64.splitSegments('a.\n b .\tc')).toEqual(['a', 'b', 'c']);
  });

  it('returns one segment for a dot-free string', () => {
    expect(codecs().Base64.splitSegments('abc')).toEqual(['abc']);
  });

  it('returns one empty segment for the empty string, and never throws', () => {
    expect(() => codecs().Base64.splitSegments('')).not.toThrow();
    expect(codecs().Base64.splitSegments('')).toEqual(['']);
  });
});

describe('core.formatUtcDate', () => {
  it('formats the handoff vector epoch by exact string equality — no fractional seconds', () => {
    // Exact equality, not a regex or substring check: the failure this pins is a trailing
    // fractional part from Date.prototype.toISOString(), which this function never calls.
    expect(core().formatUtcDate(1700000000)).toBe('2023-11-14T22:13:20Z');
  });

  it('formats epoch zero exactly', () => {
    expect(core().formatUtcDate(0)).toBe('1970-01-01T00:00:00Z');
  });

  it('zero-pads every single-digit position to two characters', () => {
    const ts = Date.UTC(2001, 0, 2, 3, 4, 5) / 1000;
    expect(core().formatUtcDate(ts)).toBe('2001-01-02T03:04:05Z');
  });

  it('returns null for a value whose Date is invalid, never a string of NaN components', () => {
    // 1e13 seconds is 1e16 ms, past the representable boundary of 8.64e15 ms.
    expect(core().formatUtcDate(1e13)).toBeNull();
    expect(core().formatUtcDate(Number.NaN)).toBeNull();
  });
});

describe('jwt decoder — handoff §7.5 vector', () => {
  it('resolves to a root with a non-empty warning and header/payload/signature children in order', async () => {
    const output = await jwtDecoder().decode(HANDOFF_VECTOR, {});
    expect(typeof output.node.warning).toBe('string');
    expect(output.node.warning.length).toBeGreaterThan(0);
    expect(output.node.children.map((c: any) => c.label)).toEqual(['header', 'payload', 'signature']);
  });

  it('the header node\'s raw is the pretty-printed {"alg": "HS256"} form with one child row', async () => {
    const output = await jwtDecoder().decode(HANDOFF_VECTOR, {});
    const header = output.node.children[0];
    expect(header.raw).toBe(JSON.stringify({ alg: 'HS256' }, null, 2));
    expect(header.children).toHaveLength(1);
    expect(header.children[0]).toMatchObject({ label: 'alg', value: 'HS256' });
  });

  it("the payload's exp row carries the exact date annotation", async () => {
    const output = await jwtDecoder().decode(HANDOFF_VECTOR, {});
    const payload = output.node.children[1];
    const expRow = payload.children.find((c: any) => c.label === 'exp');
    expect(expRow.value).toBe(1700000000);
    expect(expRow.annotations).toEqual(['2023-11-14T22:13:20Z']);
  });

  it("the signature node's value is exactly 'sig'", async () => {
    const output = await jwtDecoder().decode(HANDOFF_VECTOR, {});
    expect(output.node.children[2].value).toBe('sig');
  });
});

describe('jwt decoder — date annotations across exp/iat/nbf', () => {
  it('iat and nbf each get the same date annotation exp gets', async () => {
    const token = makeToken({ alg: 'HS256' }, { iat: 1700000000, nbf: 1700000000 });
    const output = await jwtDecoder().decode(token, {});
    const payload = output.node.children[1];
    for (const label of ['iat', 'nbf']) {
      const row = payload.children.find((c: any) => c.label === label);
      expect(row.annotations).toEqual(['2023-11-14T22:13:20Z']);
    }
  });

  it('a string-valued exp gets no date annotation, and an annotation naming the type problem instead', async () => {
    const token = makeToken({ alg: 'HS256' }, { exp: 'soon' });
    const output = await jwtDecoder().decode(token, {});
    const expRow = output.node.children[1].children.find((c: any) => c.label === 'exp');
    expect(expRow.annotations).toHaveLength(1);
    expect(expRow.annotations[0]).not.toContain('NaN');
    expect(expRow.annotations[0]).toMatch(/not a number/);
  });

  it('an exp outside the representable date range is annotated as such, never with NaN components', async () => {
    const token = makeToken({ alg: 'HS256' }, { exp: 1e13 });
    const output = await jwtDecoder().decode(token, {});
    const expRow = output.node.children[1].children.find((c: any) => c.label === 'exp');
    expect(expRow.annotations).toHaveLength(1);
    expect(expRow.annotations[0]).not.toContain('NaN');
    expect(expRow.annotations[0]).toMatch(/representable/);
  });

  it('a payload carrying email_verified: true renders it as a bool-display row valued the string "true"', async () => {
    const token = makeToken({ alg: 'HS256' }, { email_verified: true, exp: 1700000000 });
    const output = await jwtDecoder().decode(token, {});
    const row = output.node.children[1].children.find((c: any) => c.label === 'email_verified');
    expect(row.display).toBe('bool');
    expect(typeof row.value).toBe('string');
    expect(row.value).toBe('true');
  });

  it('every key in the parsed payload appears as its own row, in parsed-object order', async () => {
    const token = makeToken({ alg: 'HS256' }, { foo: 'bar', exp: 1700000000 });
    const output = await jwtDecoder().decode(token, {});
    expect(output.node.children[1].children.map((c: any) => c.label)).toEqual(['foo', 'exp']);
  });
});

describe('jwt decoder — malformed segments, and the caution surviving all of them', () => {
  const VALID_HEADER = b64url(JSON.stringify({ alg: 'HS256' }));

  it('a payload segment that is not base64url yields a payload-only error, header and signature still render', async () => {
    const token = `${VALID_HEADER}.!!!not-base64url!!!.sig`;
    const output = await jwtDecoder().decode(token, {});
    expect(output.node.warning.length).toBeGreaterThan(0);
    expect(output.node.children[0].error).toBeUndefined();
    expect(output.node.children[1].error).toMatch(/base64url/);
    expect(output.node.children[2].error).toBeUndefined();
  });

  it('a payload segment whose bytes are not valid UTF-8 yields a payload-only error', async () => {
    const invalidUtf8 = Buffer.from([0xff, 0xfe]).toString('base64url');
    const token = `${VALID_HEADER}.${invalidUtf8}.sig`;
    const output = await jwtDecoder().decode(token, {});
    expect(output.node.warning.length).toBeGreaterThan(0);
    expect(output.node.children[0].error).toBeUndefined();
    expect(output.node.children[1].error).toMatch(/UTF-8/);
    expect(output.node.children[2].error).toBeUndefined();
  });

  it('a payload segment that does not parse as JSON yields a payload-only error', async () => {
    const notJson = b64url('hello world');
    const token = `${VALID_HEADER}.${notJson}.sig`;
    const output = await jwtDecoder().decode(token, {});
    expect(output.node.warning.length).toBeGreaterThan(0);
    expect(output.node.children[0].error).toBeUndefined();
    expect(output.node.children[1].error).toMatch(/JSON/);
    expect(output.node.children[2].error).toBeUndefined();
  });

  it('two segments instead of three yields a single error child, the caution still present', async () => {
    const output = await jwtDecoder().decode('a.b', {});
    expect(output.node.warning.length).toBeGreaterThan(0);
    expect(output.node.children).toHaveLength(1);
    expect(output.node.children[0].error).toMatch(/found 2/);
  });

  it('a standard-alphabet, padded header segment yields a per-segment "not base64url" error from decode() itself', async () => {
    // eyJzdWIiOiI+Pj4+In0= is the STANDARD-alphabet, padded encoding of {"sub":">>>>"} — it
    // contains "+" and "=", so it would pass trivially if the base64url pattern test were
    // removed from canDecode alone; this calls decode() directly.
    const standardHeader = 'eyJzdWIiOiI+Pj4+In0=';
    const token = `${standardHeader}.${b64url(JSON.stringify({ exp: 1700000000 }))}.sig`;
    const output = await jwtDecoder().decode(token, {});
    expect(output.node.children[0].error).toMatch(/base64url/);
  });
});

describe('jwt decoder — canDecode scoring and auto-detect', () => {
  it('scores 0 for the empty string, a two-segment string, and a three-segment string whose first segment is not base64url', () => {
    expect(jwtDecoder().canDecode('')).toBe(0);
    expect(jwtDecoder().canDecode('a.b')).toBe(0);
    expect(jwtDecoder().canDecode('!!!.b.c')).toBe(0);
  });

  it('scores above AUTO_DETECT_THRESHOLD for the handoff vector', () => {
    expect(jwtDecoder().canDecode(HANDOFF_VECTOR)).toBeGreaterThan(core().AUTO_DETECT_THRESHOLD);
  });

  it('scores exactly 0 for ordinary dotted strings that are not JWTs', () => {
    // WR-03 (04-review): none of these three actually reach the `{`-gate's try/catch — traced
    // against the compiled decoder, 'www' and 'foo' decode to invalid UTF-8 (returns 0 before
    // the gate) and '1' is remainder-1 base64 (Base64.decode itself refuses it). They still
    // belong here as a scoring pin, but the gate's own negative branch is exercised by the two
    // cases below instead.
    expect(jwtDecoder().canDecode('www.example.com')).toBe(0);
    expect(jwtDecoder().canDecode('1.2.3')).toBe(0);
    expect(jwtDecoder().canDecode('foo.bar.baz')).toBe(0);
  });

  it('WR-03 (04-review): pins both branches of the `{`-gate itself, with a case that actually reaches it', () => {
    // 'aGk' decodes to valid UTF-8 ('hi') that is not JSON and does not start with '{' — the
    // ONLY case in this suite that reaches the gate's negative branch.
    expect(jwtDecoder().canDecode('aGk.aGk.aGk')).toBe(0);
    // 'ew' decodes to '{' — valid UTF-8, not JSON, but DOES start with '{' — the gate's
    // positive (0.6) branch.
    expect(jwtDecoder().canDecode('ew.ew.ew')).toBe(0.6);
  });

  it('core.resolve refuses to resolve a bare hostname to jwt', () => {
    expect(core().resolve('www.example.com').decoderId).toBeNull();
  });

  it('core.resolve of the handoff vector resolves to jwt, and hex/base64/url vectors are unaffected', () => {
    expect(core().resolve(HANDOFF_VECTOR).decoderId).toBe('jwt');
    expect(core().resolve('0x68656c6c6f').decoderId).toBe('hex');
    expect(core().resolve('aGVsbG8gd29ybGQ=').decoderId).toBe('base64');
    expect(core().resolve('https://x.test/p?a=1').decoderId).toBe('url');
  });
});

describe('jwt decoder — pasted-token whitespace normalization is reported, not silent', () => {
  it('a token with embedded newlines decodes identically to the unwrapped form, with a whitespace annotation on the signature', async () => {
    const unwrapped = HANDOFF_VECTOR;
    const wrapped = HANDOFF_VECTOR.replace(/\./g, '.\n');
    const unwrappedOutput = await jwtDecoder().decode(unwrapped, {});
    const wrappedOutput = await jwtDecoder().decode(wrapped, {});

    expect(wrappedOutput.node.children[0]).toEqual(unwrappedOutput.node.children[0]);
    expect(wrappedOutput.node.children[1]).toEqual(unwrappedOutput.node.children[1]);
    expect(wrappedOutput.node.children[2].value).toBe(unwrappedOutput.node.children[2].value);
    expect(wrappedOutput.node.children[2].annotations).toContain(
      'whitespace was removed from the pasted token before splitting',
    );
    expect(unwrappedOutput.node.children[2].annotations ?? []).not.toContain(
      'whitespace was removed from the pasted token before splitting',
    );
  });
});
describe('jwt decoder — degenerate tokens (Task 2)', () => {
  it('a real alg: none token with an empty signature decodes with alg visible, a dated exp, and an empty-signature annotation', async () => {
    // A real alg:none token — {"alg":"none","typ":"JWT"} header, a real payload, and a
    // genuinely empty third segment — built via makeToken rather than a hardcoded literal so
    // this fixture cannot be mistaken for a live credential by a secret scanner. NOT "a.b.":
    // one-character segments are length-remainder-1 and fail the codec's own length check,
    // which would exercise a malformed segment instead of this decoder's most
    // safety-relevant degenerate vector.
    const token = makeToken({ alg: 'none', typ: 'JWT' }, { sub: '1234567890', exp: 1700000000 }, '');
    const output = await jwtDecoder().decode(token, {});
    expect(output.node.warning.length).toBeGreaterThan(0);
    const header = output.node.children[0];
    expect(header.children.find((c: any) => c.label === 'alg').value).toBe('none');
    const payload = output.node.children[1];
    expect(payload.children.find((c: any) => c.label === 'exp').annotations).toEqual(['2023-11-14T22:13:20Z']);
    const signature = output.node.children[2];
    expect(signature.annotations).toContain('signature segment is empty');
  });

  it('a header that decodes to a JSON array still renders, the caution still present', async () => {
    const token = `${b64url(JSON.stringify([1, 2, 3]))}.${b64url(JSON.stringify({ exp: 1700000000 }))}.sig`;
    const output = await jwtDecoder().decode(token, {});
    expect(output.node.warning.length).toBeGreaterThan(0);
    const header = output.node.children[0];
    expect(header.error).toBeUndefined();
    expect(header.children.map((c: any) => c.value)).toEqual([1, 2, 3]);
  });

  it('a payload that decodes to a JSON scalar still renders, the caution still present', async () => {
    const token = `${b64url(JSON.stringify({ alg: 'HS256' }))}.${b64url(JSON.stringify(42))}.sig`;
    const output = await jwtDecoder().decode(token, {});
    expect(output.node.warning.length).toBeGreaterThan(0);
    const payload = output.node.children[1];
    expect(payload.error).toBeUndefined();
    expect(payload.value).toBe(42);
  });

  it('a payload nested within JSON_WALK_MAX_DEPTH is reachable at its innermost value', async () => {
    let value: unknown = 'leaf-value';
    for (let i = 0; i < 5; i++) value = { level: value };
    const token = `${b64url(JSON.stringify({ alg: 'HS256' }))}.${b64url(JSON.stringify(value))}.sig`;
    const output = await jwtDecoder().decode(token, {});
    let node = output.node.children[1];
    for (let i = 0; i < 5; i++) {
      node = node.children.find((c: any) => c.label === 'level');
      expect(node).toBeDefined();
    }
    expect(node.value).toBe('leaf-value');
  });

  it('a payload nested past JSON_WALK_MAX_DEPTH returns a tree whose deepest node carries the cap warning, not a throw', async () => {
    let value: unknown = 'leaf-value';
    for (let i = 0; i < 40; i++) value = { level: value };
    const token = `${b64url(JSON.stringify({ alg: 'HS256' }))}.${b64url(JSON.stringify(value))}.sig`;
    // Never rejects (DEC-12) — a throw or rejection here would fail this `await` itself,
    // so no separate not.toThrow() assertion is needed.
    const output = await jwtDecoder().decode(token, {});
    expect(output.node.warning.length).toBeGreaterThan(0);

    let node = output.node.children[1];
    let sawCapWarning = false;
    for (let i = 0; i < 40; i++) {
      if (!node) break;
      if (typeof node.warning === 'string' && /nested deeper than 32 levels/.test(node.warning)) {
        sawCapWarning = true;
        break;
      }
      node = node.children?.find((c: any) => c.label === 'level');
    }
    expect(sawCapWarning).toBe(true);
  });

  it('CR-01: a payload nested 100,000 levels deep resolves (never rejects) with the root caution intact and a warning in place of raw', async () => {
    // Built as raw JSON TEXT, not via JSON.stringify(value, null, 2) on a real nested object —
    // JSON.stringify is exactly the unbounded recursion under test, so constructing the vector
    // through it here would defeat the point. JSON.parse (iterative) accepts this depth; the
    // sibling JSON.stringify used to build `raw` (recursive) used to throw RangeError on it,
    // reaching the decode service's catch and replacing the WHOLE root node — losing the
    // not-verified caution the review calls out as the safety-relevant part of this bug.
    const deepPayloadJson = `${'['.repeat(100000)}1${']'.repeat(100000)}`;
    const token = `${b64url(JSON.stringify({ alg: 'HS256' }))}.${b64url(deepPayloadJson)}.sig`;

    // Never rejects (DEC-12) — a throw or rejection here would fail this `await` itself.
    const output = await jwtDecoder().decode(token, {});

    expect(output.node.warning).toBe(
      'signature not verified — this decoder never checks a signature, so nothing below confirms the token is genuine',
    );
    const payload = output.node.children[1];
    expect(payload.raw).toBeUndefined();
    expect(payload.warning).toMatch(/too deeply nested to pretty-print/);
  });

  it('claim names differing only by case survive as separate rows', async () => {
    const token = `${b64url(JSON.stringify({ alg: 'HS256' }))}.${b64url(JSON.stringify({ exp: 1, Exp: 2 }))}.sig`;
    const output = await jwtDecoder().decode(token, {});
    const labels = output.node.children[1].children.map((c: any) => c.label);
    expect(labels).toEqual(['exp', 'Exp']);
  });
});

describe('jwt decoder — hostile content and prototype safety (Task 2)', () => {
  it('a claim string spelling an element with an inline handler renders as text, creates no element', async () => {
    const spelled = '<img src=x onerror=alert(1)>';
    const token = `${b64url(JSON.stringify({ alg: 'HS256' }))}.${b64url(JSON.stringify({ note: spelled }))}.sig`;
    const output = await jwtDecoder().decode(token, {});
    const rendered = ui().renderNode(output.node);
    expect(rendered.querySelector('img')).toBeNull();
    expect(rendered.textContent).toContain(spelled);
  });

  it('a __proto__ claim key renders as an ordinary row and leaves Object.prototype unchanged', async () => {
    const payloadJson = '{"__proto__":{"polluted":true},"exp":1700000000}';
    const token = `${b64url(JSON.stringify({ alg: 'HS256' }))}.${b64url(payloadJson)}.sig`;
    const output = await jwtDecoder().decode(token, {});
    const row = output.node.children[1].children.find((c: any) => c.label === '__proto__');
    expect(row).toBeDefined();
    expect(row.children.find((c: any) => c.label === 'polluted').value).toBe('true');
    expect((Object.prototype as any).polluted).toBeUndefined();
  });

  it('a constructor claim key renders as an ordinary row', async () => {
    const payloadJson = '{"constructor":{"foo":1},"exp":1700000000}';
    const token = `${b64url(JSON.stringify({ alg: 'HS256' }))}.${b64url(payloadJson)}.sig`;
    const output = await jwtDecoder().decode(token, {});
    const row = output.node.children[1].children.find((c: any) => c.label === 'constructor');
    expect(row).toBeDefined();
    expect(row.children.find((c: any) => c.label === 'foo').value).toBe(1);
  });
});

describe('jwt decoder — the caution, rendered (Task 2)', () => {
  it('renders a .decode-tree-warning element with non-empty text for a successful decode', async () => {
    const output = await jwtDecoder().decode(HANDOFF_VECTOR, {});
    const rendered = ui().renderNode(output.node);
    const warnEl = rendered.querySelector('.decode-tree-warning');
    expect(warnEl).not.toBeNull();
    expect((warnEl!.textContent ?? '').length).toBeGreaterThan(0);
  });

  it('renders a .decode-tree-warning element with non-empty text for the shortest failure path (wrong segment count)', async () => {
    const output = await jwtDecoder().decode('a.b', {});
    const rendered = ui().renderNode(output.node);
    const warnEl = rendered.querySelector('.decode-tree-warning');
    expect(warnEl).not.toBeNull();
    expect((warnEl!.textContent ?? '').length).toBeGreaterThan(0);
  });
});
