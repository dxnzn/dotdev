import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

// Pure-function coverage of diffAndReplay: no DOM fixture, no storage event, no DxKit
// shell. Loads only the compiled sync.js and calls window.DnznSettingsSync.diffAndReplay
// directly with plain objects, following the compiled-JS-in-jsdom pattern established in
// test/settings-render.test.ts.
function loadCompiled(relPath: string) {
  const code = readFileSync(resolve(__dirname, relPath), 'utf-8');
  new Function('window', code)(window);
}

beforeAll(() => {
  loadCompiled('../src/dapps/settings/sync.js');
});

type Store = Record<string, Record<string, unknown>>;

function makeReadCurrent(store: Store) {
  return (sectionId: string, key: string) => store[sectionId]?.[key];
}

function makeIsDirty(dirtyPairs: string[]) {
  const set = new Set(dirtyPairs);
  return (sectionId: string, key: string) => set.has(`${sectionId}\0${key}`);
}

function diff(readCurrent: any, incoming: any, isDirty: any) {
  return window.DnznSettingsSync!.diffAndReplay(readCurrent, incoming, isDirty);
}

describe('DnznSettingsSync.diffAndReplay', () => {
  it('returns exactly one record for a single differing key', () => {
    const current: Store = { ethereum: { rpcUrl: 'https://old' } };
    const incoming = { ethereum: { rpcUrl: 'https://new' } };
    const records = diff(makeReadCurrent(current), incoming, makeIsDirty([]));
    expect(records).toEqual([{ sectionId: 'ethereum', key: 'rpcUrl', value: 'https://new', repaint: true }]);
  });

  it('returns no record when the incoming value strictly equals the current value', () => {
    const current: Store = { ethereum: { rpcUrl: 'https://same' } };
    const incoming = { ethereum: { rpcUrl: 'https://same' } };
    const records = diff(makeReadCurrent(current), incoming, makeIsDirty([]));
    expect(records).toEqual([]);
  });

  it('a dirty differing key yields repaint:false; a clean sibling key yields repaint:true', () => {
    const current: Store = { ethereum: { rpcUrl: 'https://old', chainId: 1 } };
    const incoming = { ethereum: { rpcUrl: 'https://new', chainId: 11155111 } };
    const records = diff(makeReadCurrent(current), incoming, makeIsDirty(['ethereum\0rpcUrl'])) as any[];

    expect(records).toHaveLength(2);
    const rpc = records.find((r) => r.key === 'rpcUrl');
    const chain = records.find((r) => r.key === 'chainId');
    expect(rpc).toEqual({ sectionId: 'ethereum', key: 'rpcUrl', value: 'https://new', repaint: false });
    expect(chain).toEqual({ sectionId: 'ethereum', key: 'chainId', value: 11155111, repaint: true });
  });

  it('a dirty key whose incoming value already equals the current value yields no record at all', () => {
    const current: Store = { ethereum: { rpcUrl: 'https://same' } };
    const incoming = { ethereum: { rpcUrl: 'https://same' } };
    const records = diff(makeReadCurrent(current), incoming, makeIsDirty(['ethereum\0rpcUrl']));
    expect(records).toEqual([]);
  });

  it('a key present in incoming but absent from readCurrent (undefined) returns a record', () => {
    const current: Store = {};
    const incoming = { ethereum: { rpcUrl: 'https://new' } };
    const records = diff(makeReadCurrent(current), incoming, makeIsDirty([]));
    expect(records).toEqual([{ sectionId: 'ethereum', key: 'rpcUrl', value: 'https://new', repaint: true }]);
  });

  it('diffAndReplay(readCurrent, {}, isDirty) returns an empty array', () => {
    const records = diff(makeReadCurrent({}), {}, makeIsDirty([]));
    expect(records).toEqual([]);
  });

  it.each([
    null,
    undefined,
    [],
    'string',
    42,
  ])('a non-record incoming payload (%p) returns an empty array and does not throw', (bad) => {
    let records: unknown;
    expect(() => {
      records = diff(makeReadCurrent({}), bad as any, makeIsDirty([]));
    }).not.toThrow();
    expect(records).toEqual([]);
  });

  it.each([
    ['null section', { ethereum: null }],
    ['array section', { ethereum: [] }],
    ['primitive section', { ethereum: 'x' }],
  ])('a payload shaped %s returns an empty array and does not throw', (_label, incoming) => {
    let records: unknown;
    expect(() => {
      records = diff(makeReadCurrent({}), incoming, makeIsDirty([]));
    }).not.toThrow();
    expect(records).toEqual([]);
  });

  it('a valid section alongside an invalid one still yields the valid section records', () => {
    const current: Store = { theme: { mode: 'light' } };
    const incoming = { ethereum: null, theme: { mode: 'dark' } };
    const records = diff(makeReadCurrent(current), incoming, makeIsDirty([]));
    expect(records).toEqual([{ sectionId: 'theme', key: 'mode', value: 'dark', repaint: true }]);
  });

  it('applying the returned records (including repaint:false ones) makes a second identical call return empty — self-terminating', () => {
    const current: Store = { ethereum: { rpcUrl: 'https://old', chainId: 1 } };
    const incoming = { ethereum: { rpcUrl: 'https://new', chainId: 11155111 } };
    const isDirty = makeIsDirty(['ethereum\0rpcUrl']);

    const first = diff(makeReadCurrent(current), incoming, isDirty) as any[];
    expect(first.length).toBeGreaterThan(0);

    for (const record of first) {
      current[record.sectionId] = current[record.sectionId] || {};
      current[record.sectionId][record.key] = record.value;
    }

    const second = diff(makeReadCurrent(current), incoming, isDirty);
    expect(second).toEqual([]);
  });

  it('a multiselect array equal element-wise but not by reference returns no record; a differing array returns one', () => {
    const current: Store = { decode: { chains: ['1', '11155111'] } };
    const sameIncoming = { decode: { chains: ['1', '11155111'] } };
    expect(diff(makeReadCurrent(current), sameIncoming, makeIsDirty([]))).toEqual([]);

    const diffIncoming = { decode: { chains: ['1', '5'] } };
    expect(diff(makeReadCurrent(current), diffIncoming, makeIsDirty([]))).toEqual([
      { sectionId: 'decode', key: 'chains', value: ['1', '5'], repaint: true },
    ]);
  });

  it('does not mutate the incoming argument', () => {
    const incoming = { ethereum: { rpcUrl: 'https://new', chainId: 11155111 } };
    const clone = JSON.parse(JSON.stringify(incoming));
    diff(makeReadCurrent({}), incoming, makeIsDirty([]));
    expect(incoming).toEqual(clone);
  });
});
