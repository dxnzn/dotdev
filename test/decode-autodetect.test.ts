import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

// TST-02/D-10's whole-registry suite. Plans 04-01 through 04-04 each proved their own
// decoder's vector resolves correctly and does not steal a sibling's — necessary, but not
// sufficient: a per-decoder suite can be green while the COMBINATION is wrong. This file is
// the one place that grades auto-detect resolution against the full five-decoder registry at
// once, following test/decode-registry.test.ts's DOM-free, compiled-module-loading shape.
function loadCompiled(relPath: string): void {
  const code = readFileSync(resolve(__dirname, relPath), 'utf-8');
  new Function('window', code)(window);
}

// The manifest's own `dependencies` array is the load order AND, filtered to decoder modules,
// the expected registration order (D-03) — deriving it here rather than restating it as a
// literal means this suite never needs editing as a later phase adds a sixth decoder.
const manifest = JSON.parse(readFileSync(resolve(__dirname, '../src/dapps/decode/manifest.json'), 'utf-8')) as {
  dependencies: string[];
};
const DECODER_MODULE_PATHS = manifest.dependencies.filter((dep) => dep.includes('/decoders'));

// Every decoder module reads window.DxDecode.codecs at load time (D-01's per-file convention),
// so codecs.js must load before core.js, and core.js (which creates the registry every
// decoder's final statement calls into) before any decoder file — spelled out explicitly here
// rather than assumed, since test/decode-registry.test.ts's own beforeEach only loads core.js
// and would throw on an undefined namespace if a decoder module were loaded against it.
function loadFullRegistry(): void {
  loadCompiled('../src/dapps/decode/codecs.js');
  loadCompiled('../src/dapps/decode/core.js');
  for (const path of DECODER_MODULE_PATHS) {
    loadCompiled(`../src/${path}`);
  }
}

beforeEach(() => {
  loadFullRegistry();
});

function core(): DxDecodeCoreModule {
  return window.DxDecode!.core as DxDecodeCoreModule;
}

function registry(): DecoderRegistry {
  return window.DxDecode!.registry as DecoderRegistry;
}

// Matches test/decode-registry.test.ts's makeStubDecoder shape exactly — no real decoder
// module is needed for the tie-break proof below, only core.js's registry.
function makeStubDecoder(overrides: { id: string } & Partial<DecoderPort>): DecoderPort {
  return {
    id: overrides.id,
    label: overrides.label ?? overrides.id,
    settings: overrides.settings ?? [],
    canDecode: overrides.canDecode ?? (() => 0),
    decode: overrides.decode ?? (async () => ({ node: { label: overrides.id } })),
  };
}

// <resolution_matrix> — handoff §7.5's five text vectors (hex, padded base64, unpadded
// base64url JSON, percent-encoded url, jwt) plus §7.1's mintFromMoloch inner-call literal, the
// only §7.1 vector short enough to double as abi-words' real-calldata positive case. Every
// vector here is the exact string a preceding plan's own per-decoder suite already decodes —
// this table is about which decoder WINS the competition, not about re-proving what each one
// decodes to.
const RESOLUTION_MATRIX: { name: string; input: string; expectedId: string }[] = [
  { name: 'hex — handoff §7.5', input: '0x68656c6c6f', expectedId: 'hex' },
  { name: 'base64, padded — handoff §7.5', input: 'aGVsbG8gd29ybGQ=', expectedId: 'base64' },
  { name: 'base64url, unpadded JSON — handoff §7.5', input: 'eyJhIjoxfQ', expectedId: 'base64' },
  { name: 'url, percent-encoded — handoff §7.5', input: 'a%20b%26c=1', expectedId: 'url' },
  {
    name: 'jwt — handoff §7.5',
    input: 'eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjE3MDAwMDAwMDB9.sig',
    expectedId: 'jwt',
  },
  {
    name: 'abi-words — handoff §7.1, the mintFromMoloch inner call',
    input:
      '0x2806b0af' +
      '0000000000000000000000005e58ba0e06ed0f5558f83be732a4b899a674053e' +
      '0000000000000000000000000000000000000000000000000de0b6b3a7640000',
    expectedId: 'abi-words',
  },
];

describe('the resolution matrix — every handoff vector against the whole five-decoder registry (TST-02, D-10)', () => {
  it.each(RESOLUTION_MATRIX)('$name resolves to $expectedId', ({ input, expectedId }) => {
    expect(core().resolve(input).decoderId).toBe(expectedId);
  });

  // A tie would still resolve via the registry's own order — the point here is that no §7.5
  // vector actually produces one. Scoring every decoder directly (not just trusting resolve's
  // answer) fails informatively at the scoring pass, not only at resolve, if a curve is ever
  // widened to overlap a sibling's.
  it.each(
    RESOLUTION_MATRIX,
  )('$name: the winner ($expectedId) scores strictly higher than every other registered decoder — no tie', ({
    input,
    expectedId,
  }) => {
    const scored = registry()
      .list()
      .map((decoder) => ({ id: decoder.id, score: decoder.canDecode(input) }))
      .sort((a, b) => b.score - a.score);

    expect(scored[0].id).toBe(expectedId);
    expect(scored.length).toBeGreaterThan(1);
    expect(scored[0].score).toBeGreaterThan(scored[1].score);
  });
});

describe('the tie-break rule, proven directly (D-03)', () => {
  // A fresh, empty registry — deliberately NOT the full five-decoder one beforeEach just
  // built, since this proof needs to control exactly what is registered and in what order.
  function freshEmptyRegistry(): void {
    loadCompiled('../src/dapps/decode/codecs.js');
    loadCompiled('../src/dapps/decode/core.js');
  }

  it('two decoders scoring the same above-threshold score: the first-registered one wins', () => {
    freshEmptyRegistry();
    registry().register(makeStubDecoder({ id: 'first', canDecode: () => 0.7 }));
    registry().register(makeStubDecoder({ id: 'second', canDecode: () => 0.7 }));

    expect(core().resolve('anything').decoderId).toBe('first');
  });

  it('registering the identical pair in the opposite order flips the winner', () => {
    freshEmptyRegistry();
    registry().register(makeStubDecoder({ id: 'second', canDecode: () => 0.7 }));
    registry().register(makeStubDecoder({ id: 'first', canDecode: () => 0.7 }));

    expect(core().resolve('anything').decoderId).toBe('second');
  });
});

describe('registration order equals manifest order (D-03, TST-02 ordering edge)', () => {
  // Declared explicitly rather than derived from what gets observed — comparing an observed
  // sequence with itself proves only that the registry preserves insertion order (already
  // test/decode-registry.test.ts's job); it says nothing about which FILE produces which
  // decoder id, and that mapping is what D-03's tie-break actually rests on.
  const DECODER_FILE_TO_ID: [file: string, id: string][] = [
    ['decoders.js', 'hex'],
    ['decoders-jwt.js', 'jwt'],
    ['decoders-abi-words.js', 'abi-words'],
    ['decoders-url.js', 'url'],
    ['decoders-base64.js', 'base64'],
  ];

  it("the declared map's keys, in order, equal manifest.json's decoder-module dependencies", () => {
    const manifestBasenames = DECODER_MODULE_PATHS.map((path) => path.split('/').pop());
    expect(DECODER_FILE_TO_ID.map(([file]) => file)).toEqual(manifestBasenames);
  });

  it('loading each decoder module one at a time, in manifest order, adds exactly the id the map pairs it with', () => {
    // The explicit load prelude — codecs.js, then core.js (a fresh, empty registry) — before
    // touching a single decoder file. Every decoder module reads window.DxDecode.codecs at
    // load time; skipping this would throw on an undefined namespace and report a registry
    // failure that has nothing to do with ordering.
    loadCompiled('../src/dapps/decode/codecs.js');
    loadCompiled('../src/dapps/decode/core.js');

    let previousIds: string[] = [];
    for (const [file, expectedId] of DECODER_FILE_TO_ID) {
      loadCompiled(`../src/dapps/decode/${file}`);
      const currentIds = registry()
        .list()
        .map((d) => d.id);
      const added = currentIds.filter((id) => !previousIds.includes(id));
      expect(added).toEqual([expectedId]);
      previousIds = currentIds;
    }

    // Guard against vacuity: the matrix above must have graded against a complete registry,
    // not a partial one that failed to load a later module.
    expect(previousIds).toHaveLength(5);
    expect([...previousIds].sort()).toEqual(['abi-words', 'base64', 'hex', 'jwt', 'url']);
  });
});

describe('the empty-input rule', () => {
  it("core.resolve('') returns a null decoder id and the resolver's own reason string", () => {
    const result = core().resolve('');
    expect(result.decoderId).toBeNull();
    expect(result.reason).toBe("couldn't identify this input");
  });

  it("every registered decoder's canDecode('') is 0 — looped, not named, so a Phase 5/6 decoder inherits this for free", () => {
    for (const decoder of registry().list()) {
      expect(decoder.canDecode('')).toBe(0);
    }
  });
});

// Five rows, not one — a single case worded as "prose with characters outside the base64
// alphabet" would be a case written to pass: the punctuation is what makes IT safe, and it
// dodges the exact gap this suite is the last place to catch. Each row's comment names the
// curve it guards, so a later reader does not delete it as duplicated.
const NEGATIVE_TABLE: { input: string; guards: string }[] = [
  // base64 — the control row: this is the one negative case the punctuation actually
  // protects. Kept for contrast with the four rows below, which the codec accepts anyway.
  { input: '!!! not hex at all !!!', guards: 'base64 (control row)' },
  // base64 — codecs.ts:112 strips whitespace before any alphabet check, so the codec
  // ACCEPTS "nothexatall" as valid base64; only the 04-01 positive-evidence rule scores it 0.
  { input: 'not hex at all', guards: 'base64 (positive-evidence rule)' },
  // base64 — same shape, same reason as the row above.
  { input: 'hello world', guards: 'base64 (positive-evidence rule)' },
  // jwt — three segments matching the base64url pattern, but 'www' decodes to invalid UTF-8
  // (c3 0c) and returns 0 before the `{`-gate's try/catch is ever reached (WR-03, 04-review:
  // traced against the compiled decoder — this row does not exercise the gate at all).
  { input: 'www.example.com', guards: 'jwt (Utf8.decode returns null, before the `{`-gate)' },
  // jwt — three segments matching the pattern, but '1' is remainder-1 base64 and Base64.decode
  // itself refuses it, again before the `{`-gate (WR-03, 04-review).
  { input: '1.2.3', guards: 'jwt (Base64.decode rejects a remainder-1 segment, before the `{`-gate)' },
  // jwt — the ONE row in this table that actually reaches the `{`-gate: 'aGk' decodes to
  // valid UTF-8 ('hi') that is not JSON and does not start with '{', so this pins the gate's
  // negative branch (WR-03, 04-review). Without the gate, `text.trim().startsWith('{') ? 0.6
  // : 0` could be replaced by `return 0.6` and every OTHER row above would still pass.
  { input: 'aGk.aGk.aGk', guards: 'jwt (the `{`-gate, negative branch)' },
];

describe('the negative table — ordinary prose and ordinary dotted strings resolve to no decoder (TST-02, D-10)', () => {
  it.each(NEGATIVE_TABLE)('resolves to no decoder: "$input" — guards $guards', ({ input }) => {
    expect(core().resolve(input).decoderId).toBeNull();
  });
});
