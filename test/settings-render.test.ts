import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// This suite executes COMPILED src/dapps/settings/*.js against the jsdom `window`
// (`new Function('window', code)(window)`, then calls the attached namespace members
// directly), rather than doing static string/JSON inspection like the rest of this
// repo's tests. The renderer builds real DOM via document.createElement and reads
// window.__DXKIT__ at call time, so exercising the actual runtime behaviour (attribute-
// break payloads, numeric coercion, cleanup ordering) requires running the real code,
// not asserting against its source text. This is also why `make test`/CI now build
// before they test (see Makefile `test: lint build` and .github/workflows/deploy.yml) —
// this file's target does not exist until `npx tsup` has run.
function loadCompiled(relPath: string) {
  const code = readFileSync(resolve(__dirname, relPath), 'utf-8');
  new Function('window', code)(window);
}

beforeAll(() => {
  loadCompiled('../src/dapps/settings/fields.js');
  loadCompiled('../src/dapps/settings/sync.js');
  loadCompiled('../src/dapps/settings/settings.js');
});

afterEach(() => {
  delete (window as any).__DXKIT__;
  // Test hygiene prerequisite for WR-05 (quick-260827-l29): the persistence round-trip test
  // below installs a Map-backed localStorage stand-in and leaves a real
  // `dnzn:dotdev:settings` blob behind (etherscanApiKey: 'abc123', etc). Once mounting
  // reconciles against localStorage on every init(), that leftover would bleed into every
  // later mount in this file and break dx._setCalls count assertions that assume no prior
  // state. Guarded because a test may have swapped in a broken/absent localStorage, and
  // cleanup must never throw.
  try {
    (window.localStorage as any)?.removeItem?.('dnzn:dotdev:settings');
  } catch {
    // best-effort only
  }
});

function makeCtx(sectionId: string, commit = vi.fn(), readSibling = vi.fn(() => true)) {
  return { sectionId, commit, markDirty: vi.fn(), readSibling };
}

// events.on/emit mirror the real EventBus shape attachExternalSync depends on
// (01-05): `on()` returns a disposable Listener, `set()` emits synchronously exactly
// as the real settings plugin does. Every pre-01-05 test in this file still passes
// unmodified: a same-tab commit's own event fires while the field is still marked
// dirty (text/number) or already visually agrees (select/boolean/multiselect,
// revert), so the real attachExternalSync's own guards silently no-op for every
// existing commit path — see 01-05-SUMMARY.md for the full argument.
function makeStubDx(sections: any[]) {
  const store = new Map<string, Map<string, unknown>>();
  const setCalls: { sectionId: string; key: string; value: unknown }[] = [];
  for (const section of sections) {
    const values = new Map<string, unknown>();
    for (const def of section.definitions) values.set(def.key, def.default);
    store.set(section.id, values);
  }
  const listeners: Record<string, Array<(detail: any) => void>> = {};
  function on(event: string, handler: (detail: any) => void) {
    if (!listeners[event]) listeners[event] = [];
    listeners[event].push(handler);
    return {
      off: () => {
        listeners[event] = (listeners[event] || []).filter((h) => h !== handler);
      },
    };
  }
  function emit(event: string, detail: any) {
    for (const handler of listeners[event] || []) handler(detail);
  }
  return {
    settings: {
      getSections: () => sections,
      get: (sectionId: string, key: string) => store.get(sectionId)?.get(key),
      set: (sectionId: string, key: string, value: unknown) => {
        store.get(sectionId)?.set(key, value);
        setCalls.push({ sectionId, key, value });
        emit('dx:plugin:settings:changed', { dappId: sectionId, key, value });
      },
    },
    events: { on, emit },
    _setCalls: setCalls,
  };
}

describe('DnznSettingsFields.renderField', () => {
  it('renders a working control for every one of the five setting types', () => {
    const textDef = { key: 'a', label: 'A', type: 'text', default: '' };
    const numberDef = { key: 'b', label: 'B', type: 'number', default: 0, validation: { min: 1, max: 5 } };
    const boolDef = { key: 'c', label: 'C', type: 'boolean', default: false };
    const selectDef = {
      key: 'd',
      label: 'D',
      type: 'select',
      default: 1,
      options: [
        { label: 'One', value: '1' },
        { label: 'Two', value: '2' },
      ],
    };
    const multiDef = {
      key: 'e',
      label: 'E',
      type: 'multiselect',
      default: [],
      options: [
        { label: 'X', value: 'x' },
        { label: 'Y', value: 'y' },
        { label: 'Z', value: 'z' },
      ],
    };

    const textHandle = window.DnznSettingsFields!.renderField(textDef as any, '', makeCtx('s'));
    expect(textHandle.element.querySelectorAll('input[type="text"]')).toHaveLength(1);

    const numberHandle = window.DnznSettingsFields!.renderField(numberDef as any, 0, makeCtx('s'));
    expect(numberHandle.element.querySelectorAll('input[type="number"]')).toHaveLength(1);

    const boolHandle = window.DnznSettingsFields!.renderField(boolDef as any, false, makeCtx('s'));
    expect(boolHandle.element.querySelectorAll('button[role="switch"]')).toHaveLength(1);

    const selectHandle = window.DnznSettingsFields!.renderField(selectDef as any, 1, makeCtx('s'));
    expect(selectHandle.element.querySelectorAll('select > option')).toHaveLength(2);

    const multiHandle = window.DnznSettingsFields!.renderField(multiDef as any, [], makeCtx('s'));
    expect(multiHandle.element.querySelectorAll('input[type="checkbox"]')).toHaveLength(3);
  });

  it('a select control is wrapped in .select-wrap so the themed chevron has a positioned parent', () => {
    const selectDef = {
      key: 'd',
      label: 'D',
      type: 'select',
      default: 1,
      options: [
        { label: 'One', value: '1' },
        { label: 'Two', value: '2' },
      ],
    };
    const handle: any = window.DnznSettingsFields!.renderField(selectDef as any, 1, makeCtx('s'));
    expect(handle.element.querySelector('.select-wrap > select')).not.toBeNull();
    expect(handle.getSemanticValue()).toBe(1);
  });

  it('the boolean switch is a native button, so Space and Enter activate it without a keydown handler', () => {
    const boolDef = { key: 'c', label: 'C', type: 'boolean', default: false };
    const handle = window.DnznSettingsFields!.renderField(boolDef as any, false, makeCtx('s'));
    const switchBtn = handle.element.querySelector('button[role="switch"]') as HTMLButtonElement;
    expect(switchBtn.tagName).toBe('BUTTON');
    expect(switchBtn.getAttribute('type')).toBe('button');
    // The old control is gone entirely, not merely hidden.
    expect(handle.element.querySelectorAll('button[role="radio"]')).toHaveLength(0);
    expect(handle.element.querySelectorAll('.btn-group')).toHaveLength(0);
  });

  it('a boolean with a description renders the switch on the name row and the description beneath', () => {
    const boolDef = { key: 'c', label: 'C', type: 'boolean', default: false, description: 'A helpful hint' };
    const handle = window.DnznSettingsFields!.renderField(boolDef as any, false, makeCtx('s'));
    const row = handle.element.querySelector('.settings-switch-row')!;
    expect(row.querySelector('.settings-switch-label')).not.toBeNull();
    expect(row.querySelector('button[role="switch"]')).not.toBeNull();
    const hint = row.nextElementSibling as HTMLElement;
    expect(hint).not.toBeNull();
    expect(hint.classList.contains('settings-switch-hint')).toBe(true);
    expect(hint.textContent).toBe('A helpful hint');
    // The hint is a sibling of the row, not a child of it.
    expect(row.contains(hint)).toBe(false);
  });

  it('returns a field handle exposing the full contract', () => {
    const def = { key: 'a', label: 'A', type: 'text', default: '' };
    const handle: any = window.DnznSettingsFields!.renderField(def as any, '', makeCtx('s'));
    expect(handle).toHaveProperty('element');
    expect(handle).toHaveProperty('sectionId');
    expect(handle).toHaveProperty('key');
    for (const fn of ['setValue', 'setDisabled', 'getSemanticValue', 'isDirty', 'destroy']) {
      expect(typeof handle[fn]).toBe('function');
    }
  });

  it('setValue changes the control value and setDisabled disables the control', () => {
    const def = { key: 'a', label: 'A', type: 'text', default: '' };
    const handle = window.DnznSettingsFields!.renderField(def as any, '', makeCtx('s'));
    const input = handle.element.querySelector('input') as HTMLInputElement;

    handle.setValue('x');
    expect(input.value).toBe('x');

    handle.setDisabled(true);
    expect(input.disabled).toBe(true);
  });

  it('getSemanticValue on a numeric select returns a number, not the DOM string', () => {
    const def = {
      key: 'chainId',
      label: 'Chain',
      type: 'select',
      default: 1,
      options: [
        { label: 'Mainnet', value: '1' },
        { label: 'Sepolia', value: '11155111' },
      ],
    };
    const handle = window.DnznSettingsFields!.renderField(def as any, 1, makeCtx('s'));
    expect(typeof handle.getSemanticValue()).toBe('number');
    expect(handle.getSemanticValue()).toBe(1);
  });

  it('renders an attribute-break payload inert — live property, no injected attribute', () => {
    const def = { key: 'apiKey', label: 'API Key', type: 'text', default: '' };
    const payload = ' onfocus=alert(1) x=';
    const handle = window.DnznSettingsFields!.renderField(def as any, payload, makeCtx('s'));
    const input = handle.element.querySelector('input') as HTMLInputElement;
    expect(input.value).toBe(payload);
    expect(input.outerHTML).not.toMatch(/onfocus/);
  });
});

describe('DnznSettingsDapp.init', () => {
  it('appends one .card with a matching .card-title per section', () => {
    // Non-empty definitions: 01-04's D-24 omits a section whose definitions array is
    // empty, so this pre-01-04 fixture (both sections empty) no longer produces any card.
    const sections = [
      { id: 'sectionA', label: 'Section A', definitions: [{ key: 'a', label: 'A', type: 'text', default: '' }] },
      { id: 'sectionB', label: 'Section B', definitions: [{ key: 'b', label: 'B', type: 'text', default: '' }] },
    ];
    (window as any).__DXKIT__ = makeStubDx(sections);
    const container = document.createElement('div');
    const cleanup = window.DnznSettingsDapp!.init(container);

    const cards = container.querySelectorAll('.card');
    expect(cards).toHaveLength(2);
    expect(cards[0].querySelector('.card-title')?.textContent).toBe('Section A');
    expect(cards[1].querySelector('.card-title')?.textContent).toBe('Section B');

    cleanup();
  });

  it('getField/isDirty/repaintField expose the registry built during init', () => {
    const chainIdDef = {
      key: 'chainId',
      label: 'Chain',
      type: 'select',
      default: 1,
      options: [
        { label: 'Mainnet', value: '1' },
        { label: 'Sepolia', value: '11155111' },
      ],
    };
    const sections = [{ id: 'ethereum', label: 'Ethereum', definitions: [chainIdDef] }];
    (window as any).__DXKIT__ = makeStubDx(sections);
    const container = document.createElement('div');
    const cleanup = window.DnznSettingsDapp!.init(container);

    const handle = window.DnznSettingsDapp!.getField('ethereum', 'chainId');
    expect(handle).toBeDefined();
    expect(window.DnznSettingsDapp!.isDirty('ethereum', 'chainId')).toBe(false);
    expect(window.DnznSettingsDapp!.isDirty('nope', 'nope')).toBe(false);

    window.DnznSettingsDapp!.repaintField('ethereum', 'chainId', '11155111');
    const select = container.querySelector('select') as HTMLSelectElement;
    expect(select.value).toBe('11155111');

    expect(() => window.DnznSettingsDapp!.repaintField('nope', 'nope', 'v')).not.toThrow();
    expect(select.value).toBe('11155111');

    cleanup();
  });

  it('commits a select whose default is numeric as a number via dx.settings.set', () => {
    const chainIdDef = {
      key: 'chainId',
      label: 'Chain',
      type: 'select',
      default: 1,
      options: [
        { label: 'Mainnet', value: '1' },
        { label: 'Sepolia', value: '11155111' },
      ],
    };
    const sections = [{ id: 'ethereum', label: 'Ethereum', definitions: [chainIdDef] }];
    const dx = makeStubDx(sections);
    (window as any).__DXKIT__ = dx;
    const container = document.createElement('div');
    const cleanup = window.DnznSettingsDapp!.init(container);

    const select = container.querySelector('select') as HTMLSelectElement;
    select.value = '11155111';
    select.dispatchEvent(new Event('change'));

    expect(dx._setCalls).toHaveLength(1);
    expect(dx._setCalls[0].sectionId).toBe('ethereum');
    expect(dx._setCalls[0].key).toBe('chainId');
    expect(typeof dx._setCalls[0].value).toBe('number');
    expect(dx._setCalls[0].value).toBe(11155111);

    cleanup();
  });

  it('cleanup empties the container, destroys every handle, clears the registry, and detaches sync exactly once', () => {
    const def = { key: 'etherscanApiKey', label: 'Key', type: 'text', default: '' };
    const sections = [{ id: 'ethereum', label: 'Ethereum', definitions: [def] }];
    (window as any).__DXKIT__ = makeStubDx(sections);

    const detachSpy = vi.fn();
    const originalAttach = window.DnznSettingsSync!.attachExternalSync;
    window.DnznSettingsSync!.attachExternalSync = () => detachSpy;

    const container = document.createElement('div');
    const cleanup = window.DnznSettingsDapp!.init(container);

    const handle = window.DnznSettingsDapp!.getField('ethereum', 'etherscanApiKey')!;
    const destroySpy = vi.fn(handle.destroy);
    (handle as any).destroy = destroySpy;

    cleanup();

    expect(container.innerHTML).toBe('');
    expect(destroySpy).toHaveBeenCalledTimes(1);
    expect(window.DnznSettingsDapp!.getField('ethereum', 'etherscanApiKey')).toBeUndefined();
    expect(detachSpy).toHaveBeenCalledTimes(1);

    window.DnznSettingsSync!.attachExternalSync = originalAttach;
  });
});

describe('Task 1: five-type dispatch upgrades (boolean switch, multiselect, coercion, order)', () => {
  it('renders a number control carrying min/max attributes mirrored from validation', () => {
    const numberDef = { key: 'b', label: 'B', type: 'number', default: 0, validation: { min: 1, max: 5 } };
    const handle = window.DnznSettingsFields!.renderField(numberDef as any, 0, makeCtx('s'));
    const input = handle.element.querySelector('input[type="number"]') as HTMLInputElement;
    expect(input.getAttribute('min')).toBe('1');
    expect(input.getAttribute('max')).toBe('5');
  });

  it('renders a boolean field as exactly one role="switch" button', () => {
    const boolDef = { key: 'c', label: 'C', type: 'boolean', default: false };
    const handle = window.DnznSettingsFields!.renderField(boolDef as any, false, makeCtx('s'));
    const switches = handle.element.querySelectorAll('button[role="switch"]');
    expect(switches).toHaveLength(1);
    const switchBtn = switches[0] as HTMLButtonElement;
    expect(switchBtn.tagName).toBe('BUTTON');
    expect(switchBtn.getAttribute('type')).toBe('button');
  });

  it('clicking the boolean switch commits exactly once with the flipped value and syncs aria-checked', () => {
    const boolDef = { key: 'c', label: 'C', type: 'boolean', default: false };
    const commit = vi.fn();
    const handle = window.DnznSettingsFields!.renderField(boolDef as any, false, makeCtx('s', commit));
    const switchBtn = handle.element.querySelector('button[role="switch"]') as HTMLButtonElement;

    switchBtn.dispatchEvent(new Event('click', { bubbles: true }));

    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledWith(true);
    expect(switchBtn.getAttribute('aria-checked')).toBe('true');

    switchBtn.dispatchEvent(new Event('click', { bubbles: true }));

    expect(commit).toHaveBeenCalledTimes(2);
    expect(commit).toHaveBeenCalledWith(false);
    expect(switchBtn.getAttribute('aria-checked')).toBe('false');
  });

  it('the switch resolves a non-empty accessible name from an element inside the field', () => {
    const boolDef = { key: 'c', label: 'Enable thing', type: 'boolean', default: false };
    const handle = window.DnznSettingsFields!.renderField(boolDef as any, false, makeCtx('s'));
    const switchBtn = handle.element.querySelector('button[role="switch"]')!;
    const labelledBy = switchBtn.getAttribute('aria-labelledby');
    expect(labelledBy).toBeTruthy();
    const labelEl = handle.element.querySelector(`#${labelledBy}`);
    expect(labelEl).not.toBeNull();
    expect((labelEl!.textContent || '').trim().length).toBeGreaterThan(0);
  });

  it('the field handle still exposes all eight members and they work against the boolean switch and checkbox-list multiselect', () => {
    const boolDef = { key: 'c', label: 'C', type: 'boolean', default: false };
    const boolHandle: any = window.DnznSettingsFields!.renderField(boolDef as any, false, makeCtx('s'));
    for (const member of [
      'element',
      'sectionId',
      'key',
      'def',
      'setValue',
      'setDisabled',
      'getSemanticValue',
      'isDirty',
      'destroy',
    ]) {
      expect(boolHandle).toHaveProperty(member);
    }
    boolHandle.setValue(true);
    expect(boolHandle.getSemanticValue()).toBe(true);
    const switchBtn = boolHandle.element.querySelector('button[role="switch"]') as HTMLButtonElement;
    expect(switchBtn.getAttribute('aria-checked')).toBe('true');
    boolHandle.setDisabled(true);
    expect(switchBtn.disabled).toBe(true);

    const multiDef = {
      key: 'e',
      label: 'E',
      type: 'multiselect',
      default: [],
      options: [
        { label: 'X', value: 'x' },
        { label: 'Y', value: 'y' },
      ],
    };
    const multiHandle: any = window.DnznSettingsFields!.renderField(multiDef as any, [], makeCtx('s'));
    multiHandle.setValue(['x']);
    const checkboxes = Array.from(multiHandle.element.querySelectorAll('input[type="checkbox"]')) as HTMLInputElement[];
    expect(checkboxes[0].checked).toBe(true);
    expect(checkboxes[1].checked).toBe(false);
    expect(multiHandle.getSemanticValue()).toEqual(['x']);
    multiHandle.setDisabled(true);
    for (const cb of checkboxes) expect(cb.disabled).toBe(true);
  });

  it('a text field no longer commits on change — 01-03 replaces the tracer blur-save path with a commit control', () => {
    const def = { key: 'apiKey', label: 'Key', type: 'text', default: '' };
    const commit = vi.fn();
    const handle = window.DnznSettingsFields!.renderField(def as any, '', makeCtx('s', commit));
    const input = handle.element.querySelector('input[type="text"]') as HTMLInputElement;
    input.value = 'abc';
    input.dispatchEvent(new Event('change'));
    expect(commit).toHaveBeenCalledTimes(0);
  });

  it('changing the select control commits exactly once, synchronously, with no intervening dirty state', () => {
    const def = {
      key: 'd',
      label: 'D',
      type: 'select',
      default: 1,
      options: [
        { label: 'One', value: '1' },
        { label: 'Two', value: '2' },
      ],
    };
    const commit = vi.fn();
    const markDirty = vi.fn();
    const handle = window.DnznSettingsFields!.renderField(def as any, 1, { sectionId: 's', commit, markDirty });
    const select = handle.element.querySelector('select') as HTMLSelectElement;
    select.value = '2';
    select.dispatchEvent(new Event('change'));
    expect(commit).toHaveBeenCalledTimes(1);
    expect(markDirty).not.toHaveBeenCalled();
  });

  it('checking two boxes in a multiselect commits an array of the two option value strings', () => {
    const def = {
      key: 'e',
      label: 'E',
      type: 'multiselect',
      default: [],
      options: [
        { label: 'X', value: 'x' },
        { label: 'Y', value: 'y' },
        { label: 'Z', value: 'z' },
      ],
    };
    const commit = vi.fn();
    const handle = window.DnznSettingsFields!.renderField(def as any, [], makeCtx('s', commit));
    const checkboxes = Array.from(handle.element.querySelectorAll('input[type="checkbox"]')) as HTMLInputElement[];
    checkboxes[0].checked = true;
    checkboxes[0].dispatchEvent(new Event('change'));
    checkboxes[2].checked = true;
    checkboxes[2].dispatchEvent(new Event('change'));
    expect(commit).toHaveBeenLastCalledWith(['x', 'z']);
  });

  it('coerceForCommit keys off typeof def.default, not def.type alone', () => {
    expect(window.DnznSettingsFields!.coerceForCommit({ type: 'select', default: 1 } as any, '11155111')).toBe(
      11155111,
    );
    expect(window.DnznSettingsFields!.coerceForCommit({ type: 'text', default: '' } as any, '1')).toBe('1');
  });

  it('renders a section of three definitions twice with identical declaration order both times', () => {
    const defs = [
      { key: 'a', label: 'Alpha', type: 'text', default: '' },
      { key: 'b', label: 'Beta', type: 'text', default: '' },
      { key: 'c', label: 'Gamma', type: 'text', default: '' },
    ];
    const sections = [{ id: 'ordered', label: 'Ordered', definitions: defs }];

    (window as any).__DXKIT__ = makeStubDx(sections);
    const containerA = document.createElement('div');
    const cleanupA = window.DnznSettingsDapp!.init(containerA);
    const labelsA = Array.from(containerA.querySelectorAll('.input-group label span:first-child')).map(
      (el) => el.textContent,
    );
    cleanupA();

    (window as any).__DXKIT__ = makeStubDx(sections);
    const containerB = document.createElement('div');
    const cleanupB = window.DnznSettingsDapp!.init(containerB);
    const labelsB = Array.from(containerB.querySelectorAll('.input-group label span:first-child')).map(
      (el) => el.textContent,
    );
    cleanupB();

    expect(labelsA).toEqual(['Alpha', 'Beta', 'Gamma']);
    expect(labelsB).toEqual(['Alpha', 'Beta', 'Gamma']);
  });
});

describe('DnznSettingsFields.validate', () => {
  it('treats min/max as inclusive bounds', () => {
    expect(window.DnznSettingsFields!.validate({ validation: { min: 1, max: 5 } } as any, 1).ok).toBe(true);
    expect(window.DnznSettingsFields!.validate({ validation: { min: 1, max: 5 } } as any, 5).ok).toBe(true);
    const below = window.DnznSettingsFields!.validate({ validation: { min: 1, max: 5 } } as any, 0);
    expect(below.ok).toBe(false);
    expect(below.message).toBeTruthy();
    const above = window.DnznSettingsFields!.validate({ validation: { min: 1, max: 5 } } as any, 6);
    expect(above.ok).toBe(false);
    expect(above.message).toBeTruthy();
  });

  it('required fails on empty string; a definition with no validation object always passes', () => {
    expect(window.DnznSettingsFields!.validate({ validation: { required: true } } as any, '').ok).toBe(false);
    expect(window.DnznSettingsFields!.validate({ default: '' } as any, '').ok).toBe(true);
  });

  it('a non-finite number fails before any bounds comparison, independent of a bound being declared', () => {
    const withBounds = window.DnznSettingsFields!.validate(
      { type: 'number', validation: { min: 1, max: 5 } } as any,
      Number.NaN,
    );
    expect(withBounds.ok).toBe(false);
    const withoutBounds = window.DnznSettingsFields!.validate({ type: 'number', validation: {} } as any, Number.NaN);
    expect(withoutBounds.ok).toBe(false);
  });

  it('required fails on an empty multiselect array and passes with a member', () => {
    expect(
      window.DnznSettingsFields!.validate({ type: 'multiselect', validation: { required: true } } as any, []).ok,
    ).toBe(false);
    expect(
      window.DnznSettingsFields!.validate({ type: 'multiselect', validation: { required: true } } as any, ['a']).ok,
    ).toBe(true);
  });

  it('required fails for undefined, null, empty string and empty array', () => {
    const def = { validation: { required: true } };
    for (const value of [undefined, null, '', []]) {
      expect(window.DnznSettingsFields!.validate(def as any, value).ok).toBe(false);
    }
  });

  it('an uncompilable pattern fails visibly instead of throwing', () => {
    const def = { validation: { pattern: '(' } };
    expect(() => window.DnznSettingsFields!.validate(def as any, 'x')).not.toThrow();
    const result = window.DnznSettingsFields!.validate(def as any, 'x');
    expect(result.ok).toBe(false);
    expect(result.message).toBeTruthy();
  });
});

describe('Task 2: commit-time validation UI and dependsOn disabling', () => {
  it('a failed commit attempt does not call ctx.commit, shows a .settings-field-error and marks .input-wrap.has-error', () => {
    // Updated by 01-03 Task 2: number no longer commits on `change` (the tracer's transitional
    // path is gone) — a commit attempt is now driven by the commit button, same as text.
    const def = { key: 'rps', label: 'RPS', type: 'number', default: 5, validation: { min: 1, max: 5 } };
    const commit = vi.fn();
    const handle = window.DnznSettingsFields!.renderField(def as any, 5, makeCtx('s', commit));
    const input = handle.element.querySelector('input[type="number"]') as HTMLInputElement;
    const commitBtn = handle.element.querySelector('.controls button') as HTMLButtonElement;

    input.value = '0';
    input.dispatchEvent(new Event('input'));
    commitBtn.click();

    expect(commit).not.toHaveBeenCalled();
    const errorEl = handle.element.querySelector('.settings-field-error');
    expect(errorEl).not.toBeNull();
    expect((errorEl!.textContent || '').length).toBeGreaterThan(0);
    expect(handle.element.querySelector('.input-wrap')!.classList.contains('has-error')).toBe(true);
  });

  it('the error state clears on the next input event', () => {
    const def = { key: 'rps', label: 'RPS', type: 'number', default: 5, validation: { min: 1, max: 5 } };
    const handle = window.DnznSettingsFields!.renderField(def as any, 5, makeCtx('s'));
    const input = handle.element.querySelector('input[type="number"]') as HTMLInputElement;
    const commitBtn = handle.element.querySelector('.controls button') as HTMLButtonElement;

    input.value = '0';
    input.dispatchEvent(new Event('input'));
    commitBtn.click();
    expect(handle.element.querySelector('.settings-field-error')).not.toBeNull();

    input.value = '3';
    input.dispatchEvent(new Event('input'));

    expect(handle.element.querySelector('.settings-field-error')).toBeNull();
    expect(handle.element.querySelector('.input-wrap')!.classList.contains('has-error')).toBe(false);
  });

  it('a definition declaring dependsOn renders disabled/enabled from ctx.readSibling', () => {
    const def = { key: 'child', label: 'Child', type: 'text', default: '', dependsOn: 'enabled' };

    const disabledHandle = window.DnznSettingsFields!.renderField(
      def as any,
      '',
      makeCtx(
        's',
        vi.fn(),
        vi.fn(() => false),
      ),
    );
    const disabledInput = disabledHandle.element.querySelector('input') as HTMLInputElement;
    expect(disabledInput.disabled).toBe(true);

    const enabledHandle = window.DnznSettingsFields!.renderField(
      def as any,
      '',
      makeCtx(
        's',
        vi.fn(),
        vi.fn(() => true),
      ),
    );
    const enabledInput = enabledHandle.element.querySelector('input') as HTMLInputElement;
    expect(enabledInput.disabled).toBe(false);
  });

  it('refreshDependants enables/disables the SAME control instance in place, both directions, without remounting', () => {
    const enabledDef = { key: 'enabled', label: 'Enabled', type: 'boolean', default: false };
    const childDef = { key: 'child', label: 'Child', type: 'text', default: '', dependsOn: 'enabled' };
    const sections = [{ id: 'sect', label: 'Sect', definitions: [enabledDef, childDef] }];
    (window as any).__DXKIT__ = makeStubDx(sections);
    const container = document.createElement('div');
    const cleanup = window.DnznSettingsDapp!.init(container);

    const childHandle = window.DnznSettingsDapp!.getField('sect', 'child')!;
    const childInput = childHandle.element.querySelector('input') as HTMLInputElement;
    const childGroup = childHandle.element as HTMLElement;

    expect(childInput.disabled).toBe(true);
    expect(childGroup.classList.contains('is-disabled')).toBe(true);

    const enabledHandle = window.DnznSettingsDapp!.getField('sect', 'enabled')!;
    const switchBtn = enabledHandle.element.querySelector('button[role="switch"]') as HTMLButtonElement;
    switchBtn.dispatchEvent(new Event('click', { bubbles: true }));

    expect(childInput.disabled).toBe(false);
    expect(childGroup.classList.contains('is-disabled')).toBe(false);
    // Same element identity — the field was re-enabled in place, not remounted.
    expect(window.DnznSettingsDapp!.getField('sect', 'child')!.element.querySelector('input')).toBe(childInput);

    switchBtn.dispatchEvent(new Event('click', { bubbles: true }));

    expect(childInput.disabled).toBe(true);
    expect(childGroup.classList.contains('is-disabled')).toBe(true);

    cleanup();
  });

  it('a section whose every field is dependsOn-disabled still renders all of its fields', () => {
    const enabledDef = { key: 'enabled', label: 'Enabled', type: 'boolean', default: false };
    const childDef = { key: 'child', label: 'Child', type: 'text', default: '', dependsOn: 'enabled' };
    const sections = [{ id: 'sect', label: 'Sect', definitions: [enabledDef, childDef] }];
    (window as any).__DXKIT__ = makeStubDx(sections);
    const container = document.createElement('div');
    const cleanup = window.DnznSettingsDapp!.init(container);

    expect(container.querySelectorAll('.input-group')).toHaveLength(2);

    cleanup();
  });

  it('a failed out-of-bounds commit never reaches dx.settings.set — no invalid value can be persisted', () => {
    const rpsDef = { key: 'etherscanRps', label: 'RPS', type: 'number', default: 5, validation: { min: 1, max: 5 } };
    const sections = [{ id: 'ethereum', label: 'Ethereum', definitions: [rpsDef] }];
    const dx = makeStubDx(sections);
    (window as any).__DXKIT__ = dx;
    const container = document.createElement('div');
    const cleanup = window.DnznSettingsDapp!.init(container);

    const input = container.querySelector('input[type="number"]') as HTMLInputElement;
    const commitBtn = container.querySelector('.controls button') as HTMLButtonElement;
    input.value = '0';
    input.dispatchEvent(new Event('input'));
    commitBtn.click();

    expect(dx._setCalls).toHaveLength(0);

    cleanup();
  });
});

describe('Task 2 (01-03): per-field commit/revert control strip and real dirty tracking', () => {
  it('a text field carries .has-controls-2 with exactly two labelled buttons in .controls', () => {
    const def = { key: 'apiKey', label: 'Key', type: 'text', default: '' };
    const handle = window.DnznSettingsFields!.renderField(def as any, '', makeCtx('s'));
    const wrap = handle.element.querySelector('.input-wrap')!;
    expect(wrap.classList.contains('has-controls-2')).toBe(true);
    const buttons = wrap.querySelectorAll('.controls button');
    expect(buttons).toHaveLength(2);
    for (const btn of Array.from(buttons)) {
      expect((btn as HTMLElement).getAttribute('aria-label')).toBeTruthy();
    }
  });

  it('an input event marks the wrap dirty and the commit button active', () => {
    const def = { key: 'apiKey', label: 'Key', type: 'text', default: '' };
    const handle = window.DnznSettingsFields!.renderField(def as any, '', makeCtx('s'));
    const input = handle.element.querySelector('input') as HTMLInputElement;
    const wrap = handle.element.querySelector('.input-wrap')!;

    input.value = 'x';
    input.dispatchEvent(new Event('input'));

    expect(wrap.classList.contains('is-dirty')).toBe(true);
    const commitBtn = wrap.querySelectorAll('.controls button')[0] as HTMLElement;
    expect(commitBtn.classList.contains('is-active')).toBe(true);
  });

  it('clicking commit with a valid value calls ctx.commit once with the coerced value and clears dirty', () => {
    const def = { key: 'rpcUrl', label: 'RPC', type: 'text', default: '' };
    const commit = vi.fn();
    const handle = window.DnznSettingsFields!.renderField(def as any, '', makeCtx('s', commit));
    const input = handle.element.querySelector('input') as HTMLInputElement;
    const wrap = handle.element.querySelector('.input-wrap')!;

    input.value = 'https://example.com';
    input.dispatchEvent(new Event('input'));
    const [commitBtn] = Array.from(wrap.querySelectorAll('.controls button')) as HTMLButtonElement[];
    commitBtn.click();

    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledWith('https://example.com');
    expect(wrap.classList.contains('is-dirty')).toBe(false);
  });

  it('clicking commit with a value failing validate does not call ctx.commit and leaves dirty in place', () => {
    const def = { key: 'rps', label: 'RPS', type: 'number', default: 5, validation: { min: 1, max: 5 } };
    const commit = vi.fn();
    const handle = window.DnznSettingsFields!.renderField(def as any, 5, makeCtx('s', commit));
    const input = handle.element.querySelector('input') as HTMLInputElement;
    const wrap = handle.element.querySelector('.input-wrap')!;

    input.value = '9';
    input.dispatchEvent(new Event('input'));
    const [commitBtn] = Array.from(wrap.querySelectorAll('.controls button')) as HTMLButtonElement[];
    commitBtn.click();

    expect(commit).not.toHaveBeenCalled();
    expect(wrap.classList.contains('is-dirty')).toBe(true);
  });

  it('pressing Enter in the field produces exactly the same commit call as clicking the commit button', () => {
    const def = { key: 'rpcUrl', label: 'RPC', type: 'text', default: '' };
    const commit = vi.fn();
    const handle = window.DnznSettingsFields!.renderField(def as any, '', makeCtx('s', commit));
    const input = handle.element.querySelector('input') as HTMLInputElement;

    input.value = 'https://example.com';
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));

    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledWith('https://example.com');
  });

  it('clicking revert on a field whose default is empty commits "" and clears the input, even when never edited', () => {
    const def = { key: 'etherscanApiKey', label: 'Key', type: 'text', default: '' };
    const commit = vi.fn();
    const handle = window.DnznSettingsFields!.renderField(def as any, 'already-set', makeCtx('s', commit));
    const input = handle.element.querySelector('input') as HTMLInputElement;
    const wrap = handle.element.querySelector('.input-wrap')!;
    const buttons = Array.from(wrap.querySelectorAll('.controls button')) as HTMLButtonElement[];
    const revertBtn = buttons[1];

    revertBtn.click();

    expect(commit).toHaveBeenCalledWith('');
    expect(input.value).toBe('');
  });

  it('committing the same value twice through the real store leaves it identical after each commit', () => {
    const def = { key: 'a', label: 'A', type: 'text', default: '' };
    const sections = [{ id: 'sect', label: 'Sect', definitions: [def] }];
    const dx = makeStubDx(sections);
    (window as any).__DXKIT__ = dx;
    const container = document.createElement('div');
    const cleanup = window.DnznSettingsDapp!.init(container);
    const input = container.querySelector('input') as HTMLInputElement;
    const commitBtn = container.querySelector('.controls button') as HTMLButtonElement;

    input.value = 'x';
    input.dispatchEvent(new Event('input'));
    commitBtn.click();
    input.value = 'x';
    input.dispatchEvent(new Event('input'));
    commitBtn.click();

    expect(dx._setCalls).toHaveLength(2);
    expect(dx.settings.get('sect', 'a')).toBe('x');
    cleanup();
  });

  it('committing field A then field B persists both — neither write erases the other', () => {
    const defA = { key: 'a', label: 'A', type: 'text', default: '' };
    const defB = { key: 'b', label: 'B', type: 'text', default: '' };
    const sections = [{ id: 'sect', label: 'Sect', definitions: [defA, defB] }];
    const dx = makeStubDx(sections);
    (window as any).__DXKIT__ = dx;
    const container = document.createElement('div');
    const cleanup = window.DnznSettingsDapp!.init(container);
    const inputs = Array.from(container.querySelectorAll('input')) as HTMLInputElement[];
    const commitBtns = Array.from(container.querySelectorAll('.controls button:first-child')) as HTMLButtonElement[];

    inputs[0].value = 'valueA';
    inputs[0].dispatchEvent(new Event('input'));
    commitBtns[0].click();
    inputs[1].value = 'valueB';
    inputs[1].dispatchEvent(new Event('input'));
    commitBtns[1].click();

    expect(dx.settings.get('sect', 'a')).toBe('valueA');
    expect(dx.settings.get('sect', 'b')).toBe('valueB');
    cleanup();
  });

  it('handle.isDirty() reflects real state across input, commit and revert', () => {
    const def = { key: 'apiKey', label: 'Key', type: 'text', default: '' };
    const commit = vi.fn();
    const handle = window.DnznSettingsFields!.renderField(def as any, '', makeCtx('s', commit));
    const input = handle.element.querySelector('input') as HTMLInputElement;
    const wrap = handle.element.querySelector('.input-wrap')!;
    const buttons = Array.from(wrap.querySelectorAll('.controls button')) as HTMLButtonElement[];

    expect(handle.isDirty()).toBe(false);
    input.value = 'x';
    input.dispatchEvent(new Event('input'));
    expect(handle.isDirty()).toBe(true);
    buttons[0].click();
    expect(handle.isDirty()).toBe(false);

    input.value = 'y';
    input.dispatchEvent(new Event('input'));
    expect(handle.isDirty()).toBe(true);
    buttons[1].click();
    expect(handle.isDirty()).toBe(false);
  });

  it('DnznSettingsDapp.isDirty mirrors the field handle for a rendered field and stays false for an unrendered key', () => {
    const def = { key: 'apiKey', label: 'Key', type: 'text', default: '' };
    const sections = [{ id: 'ethereum', label: 'Ethereum', definitions: [def] }];
    (window as any).__DXKIT__ = makeStubDx(sections);
    const container = document.createElement('div');
    const cleanup = window.DnznSettingsDapp!.init(container);
    const input = container.querySelector('input') as HTMLInputElement;

    expect(window.DnznSettingsDapp!.isDirty('ethereum', 'apiKey')).toBe(false);
    input.value = 'x';
    input.dispatchEvent(new Event('input'));
    expect(window.DnznSettingsDapp!.isDirty('ethereum', 'apiKey')).toBe(true);
    expect(window.DnznSettingsDapp!.isDirty('nope', 'nope')).toBe(false);

    cleanup();
  });

  it('a mount/unmount/mount cycle results in each field carrying exactly one commit handler', () => {
    const def = { key: 'apiKey', label: 'Key', type: 'text', default: '' };
    const sections = [{ id: 'ethereum', label: 'Ethereum', definitions: [def] }];
    const dx = makeStubDx(sections);
    (window as any).__DXKIT__ = dx;

    const container = document.createElement('div');
    let cleanup = window.DnznSettingsDapp!.init(container);
    cleanup();
    cleanup = window.DnznSettingsDapp!.init(container);

    const input = container.querySelector('input') as HTMLInputElement;
    const commitBtn = container.querySelector('.controls button') as HTMLButtonElement;
    input.value = 'x';
    input.dispatchEvent(new Event('input'));
    commitBtn.click();

    expect(dx._setCalls).toHaveLength(1);
    cleanup();
  });

  it('no page-unload confirmation listener is registered in fields.ts', () => {
    const source = readFileSync(resolve(__dirname, '../src/dapps/settings/fields.ts'), 'utf-8');
    const withoutComments = source
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n');
    expect((withoutComments.match(/beforeunload/g) || []).length).toBe(0);
  });
});

describe('Task 2 (quick-260827-l29): a dependsOn-disabled text/number field is fully inert (WR-02)', () => {
  it('every button in the control strip carries disabled, alongside the input', () => {
    const def = { key: 'child', label: 'Child', type: 'text', default: '', dependsOn: 'enabled' };
    const handle = window.DnznSettingsFields!.renderField(
      def as any,
      '',
      makeCtx(
        's',
        vi.fn(),
        vi.fn(() => false),
      ),
    );
    const input = handle.element.querySelector('input') as HTMLInputElement;
    const buttons = Array.from(handle.element.querySelectorAll('.controls button')) as HTMLButtonElement[];

    expect(input.disabled).toBe(true);
    expect(buttons.length).toBeGreaterThan(0);
    for (const btn of buttons) {
      expect(btn.disabled).toBe(true);
    }
  });

  it('clicking the commit button on a disabled field does not call ctx.commit', () => {
    const def = { key: 'child', label: 'Child', type: 'text', default: 'orig', dependsOn: 'enabled' };
    const commit = vi.fn();
    const handle = window.DnznSettingsFields!.renderField(
      def as any,
      'orig',
      makeCtx(
        's',
        commit,
        vi.fn(() => false),
      ),
    );
    const commitBtn = handle.element.querySelectorAll('.controls button')[0] as HTMLButtonElement;

    commitBtn.click();

    expect(commit).not.toHaveBeenCalled();
  });

  it('clicking the revert button on a disabled field does not call ctx.commit', () => {
    const def = { key: 'child', label: 'Child', type: 'text', default: 'default-value', dependsOn: 'enabled' };
    const commit = vi.fn();
    const handle = window.DnznSettingsFields!.renderField(
      def as any,
      'orig',
      makeCtx(
        's',
        commit,
        vi.fn(() => false),
      ),
    );
    const buttons = Array.from(handle.element.querySelectorAll('.controls button')) as HTMLButtonElement[];
    const revertBtn = buttons[buttons.length - 1];

    revertBtn.click();

    expect(commit).not.toHaveBeenCalled();
  });

  it('clicking reveal on a disabled secret field leaves input.type unchanged', () => {
    const def = { key: 'etherscanApiKey', label: 'Key', type: 'text', default: '', dependsOn: 'enabled' };
    const handle = window.DnznSettingsFields!.renderField(
      def as any,
      's3cr3t',
      makeCtx(
        'ethereum',
        vi.fn(),
        vi.fn(() => false),
      ),
    );
    const input = handle.element.querySelector('input') as HTMLInputElement;
    const revealBtn = handle.element.querySelector('.controls button') as HTMLButtonElement;

    expect(input.type).toBe('password');
    revealBtn.click();
    expect(input.type).toBe('password');
  });

  it('after setDisabled(false), the strip is live again and a commit reaches ctx.commit', () => {
    const def = { key: 'child', label: 'Child', type: 'text', default: '', dependsOn: 'enabled' };
    const commit = vi.fn();
    const handle = window.DnznSettingsFields!.renderField(
      def as any,
      '',
      makeCtx(
        's',
        commit,
        vi.fn(() => false),
      ),
    );
    const input = handle.element.querySelector('input') as HTMLInputElement;
    const buttons = Array.from(handle.element.querySelectorAll('.controls button')) as HTMLButtonElement[];

    handle.setDisabled(false);

    expect(input.disabled).toBe(false);
    for (const btn of buttons) expect(btn.disabled).toBe(false);

    input.value = 'now-live';
    input.dispatchEvent(new Event('input'));
    buttons[0].click();

    expect(commit).toHaveBeenCalledWith('now-live');
  });
});

describe('Task 2 (quick-260827-l29): a rejected live commit rolls the control back to the store (WR-04)', () => {
  it('select: a rejected change is not committed and the visible value reverts to the last committed one', () => {
    const def = {
      key: 'chainId',
      label: 'Chain',
      type: 'select',
      default: 2,
      options: [
        { label: 'One', value: '1' },
        { label: 'Two', value: '2' },
        { label: 'Three', value: '3' },
      ],
      validation: { min: 2, max: 3 },
    };
    const commit = vi.fn();
    const handle = window.DnznSettingsFields!.renderField(def as any, 2, makeCtx('s', commit));
    const select = handle.element.querySelector('select') as HTMLSelectElement;

    expect(select.value).toBe('2');
    select.value = '1';
    select.dispatchEvent(new Event('change'));

    expect(commit).not.toHaveBeenCalled();
    expect(handle.element.querySelector('.settings-field-error')).not.toBeNull();
    expect(select.value).toBe('2');
    expect(handle.isDirty()).toBe(false);
    expect(handle.getSemanticValue()).toBe(2);

    // A passing change on the same definition still commits normally.
    select.value = '3';
    select.dispatchEvent(new Event('change'));
    expect(commit).toHaveBeenCalledWith(3);
    expect(select.value).toBe('3');
  });

  it('multiselect required: unchecking the last box is not committed and the checkbox reverts to checked', () => {
    const def = {
      key: 'opts',
      label: 'Opts',
      type: 'multiselect',
      default: ['a'],
      options: [
        { label: 'A', value: 'a' },
        { label: 'B', value: 'b' },
      ],
      validation: { required: true },
    };
    const commit = vi.fn();
    const handle = window.DnznSettingsFields!.renderField(def as any, ['a'], makeCtx('s', commit));
    const checkboxes = Array.from(handle.element.querySelectorAll('input[type="checkbox"]')) as HTMLInputElement[];
    const aBox = checkboxes.find((cb) => cb.value === 'a')!;
    const bBox = checkboxes.find((cb) => cb.value === 'b')!;

    expect(aBox.checked).toBe(true);
    aBox.checked = false;
    aBox.dispatchEvent(new Event('change'));

    expect(commit).not.toHaveBeenCalled();
    expect(handle.element.querySelector('.settings-field-error')).not.toBeNull();
    expect(aBox.checked).toBe(true);
    expect(handle.isDirty()).toBe(false);
    expect(handle.getSemanticValue()).toEqual(['a']);

    // A passing change on the same definition still commits normally.
    bBox.checked = true;
    bBox.dispatchEvent(new Event('change'));
    expect(commit).toHaveBeenCalledWith(['a', 'b']);
  });

  it('boolean: a rejected click is not committed and rolls aria-checked back; a subsequent passing click still commits', () => {
    // validation: { min: 1 } means Number(true) === 1 passes and Number(false) === 0 fails —
    // so from `true` a click always attempts (and is rejected as) `false`. Reaching the
    // "a passing click still commits" half therefore requires repainting to `false` via
    // setValue (an external repaint, not a click) before clicking again — clicking cannot
    // get there on its own with a single switch, unlike the old two-button version.
    const def = { key: 'flag', label: 'Flag', type: 'boolean', default: true, validation: { min: 1 } };
    const commit = vi.fn();
    const handle = window.DnznSettingsFields!.renderField(def as any, true, makeCtx('s', commit));
    const switchBtn = handle.element.querySelector('button[role="switch"]') as HTMLButtonElement;

    expect(switchBtn.getAttribute('aria-checked')).toBe('true');
    switchBtn.click();

    expect(commit).not.toHaveBeenCalled();
    expect(handle.element.querySelector('.settings-field-error')).not.toBeNull();
    expect(switchBtn.getAttribute('aria-checked')).toBe('true');
    expect(handle.isDirty()).toBe(false);
    expect(handle.getSemanticValue()).toBe(true);

    // Repaint to false without committing (external sync / setValue path, not a click).
    handle.setValue(false);
    expect(switchBtn.getAttribute('aria-checked')).toBe('false');

    // Now a click attempts `true`, which passes validation and commits.
    switchBtn.click();
    expect(commit).toHaveBeenCalledWith(true);
  });
});

// SET-06's "survive a page reload" half, exercised against the REAL vendored settings plugin's
// persist()/restore() through real jsdom localStorage — the stub store used elsewhere in this file
// cannot prove this (it never touches localStorage). `src/vendor/` is gitignored and CI has no
// `../dxkit` checkout to vendor from (see Makefile `vendor`), so this suite runs locally and in
// `make deploy` but is SKIPPED in CI — a reader should not mistake the skip for a pass.
const VENDORED_SETTINGS_PATH = resolve(__dirname, '../src/vendor/dxkit/settings/index.global.js');
const hasVendoredSettings = existsSync(VENDORED_SETTINGS_PATH);

function loadVendoredSettingsFactory() {
  const code = readFileSync(VENDORED_SETTINGS_PATH, 'utf-8');
  // The vendored file is a real browser-global IIFE build (`var DxSettings = ...`), meant to run as
  // an actual <script> tag where a top-level `var` attaches to the global object. `new Function`
  // does NOT do that for us — `var` stays local to the generated function body — so the factory is
  // recovered via an explicit trailing `return`, not by reading a `window` property afterward (the
  // pattern `loadCompiled()` above uses works only because OUR OWN modules explicitly assign
  // `window.X = ...`; this vendored file never references `window` at all).
  return new Function(`${code}\nreturn DxSettings;`)();
}

function makeMinimalDxContext() {
  return {
    events: { emit: vi.fn(), on: vi.fn(() => ({ off: vi.fn() })) },
    eventRegistry: { registerEvent: vi.fn() },
    getManifests: () => [],
    getPlugins: () => ({}),
    enableDapp: vi.fn(),
    disableDapp: vi.fn(),
    isDappEnabled: () => true,
  };
}

// This Node runtime exposes an experimental native `globalThis.localStorage` (Node 22+, gated
// behind `--localstorage-file`) that shadows jsdom's simulated Storage and is non-functional
// without a configured backing file (its prototype is a plain Object — no setItem/getItem/clear).
// A minimal, Storage-shaped Map-backed stand-in restores a real getItem/setItem/removeItem surface
// so the plugin's actual persist()/restore() JSON round-trip is what's under test here, not a
// broken host global. `window.localStorage` is a configurable accessor, so this is a clean
// replace-in-place, not a monkeypatch of a data property.
function installFakeLocalStorage() {
  const map = new Map<string, string>();
  const storage = {
    getItem: (k: string) => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k: string, v: string) => {
      map.set(k, String(v));
    },
    removeItem: (k: string) => {
      map.delete(k);
    },
    clear: () => {
      map.clear();
    },
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    get length() {
      return map.size;
    },
  };
  Object.defineProperty(window, 'localStorage', { configurable: true, value: storage });
}

describe.skipIf(!hasVendoredSettings)(
  'Task 2 (01-03): real persistence round-trip through the vendored settings plugin (skipped — src/vendor/ absent, no ../dxkit checkout to vendor from in this environment/CI)',
  () => {
    it('a second plugin instance sharing storageKey reads back values set by the first', async () => {
      installFakeLocalStorage();
      const DxSettings = loadVendoredSettingsFactory();

      const first = DxSettings.createSettings({ storageKey: 'dnzn:dotdev:settings' });
      await first.init(makeMinimalDxContext());
      const api1 = first.getSettingsAPI();
      api1.set('ethereum', 'etherscanApiKey', 'abc123');
      api1.set('theme', 'mode', 'dark');

      const second = DxSettings.createSettings({ storageKey: 'dnzn:dotdev:settings' });
      await second.init(makeMinimalDxContext());
      const api2 = second.getSettingsAPI();

      expect(api2.get('ethereum', 'etherscanApiKey')).toBe('abc123');
      expect(api2.get('theme', 'mode')).toBe('dark');
    });
  },
);

describe('Task 3 (01-03): mask credential fields with a sticky reveal toggle', () => {
  it('isSecret is true only for the registered ethereum.etherscanApiKey pair', () => {
    expect(window.DnznSettingsFields!.isSecret('ethereum', 'etherscanApiKey')).toBe(true);
    expect(window.DnznSettingsFields!.isSecret('ethereum', 'rpcUrl')).toBe(false);
    expect(window.DnznSettingsFields!.isSecret('theme', 'mode')).toBe(false);
  });

  it('a secret definition renders input[type=password] inside a .has-controls-3 wrap with three buttons', () => {
    const def = { key: 'etherscanApiKey', label: 'Key', type: 'text', default: '' };
    const handle = window.DnznSettingsFields!.renderField(def as any, '', makeCtx('ethereum'));
    const input = handle.element.querySelector('input') as HTMLInputElement;
    const wrap = handle.element.querySelector('.input-wrap')!;

    expect(input.type).toBe('password');
    expect(wrap.classList.contains('has-controls-3')).toBe(true);
    expect(wrap.querySelectorAll('.controls button')).toHaveLength(3);
  });

  it('clicking reveal flips input.type to text, and a second click flips it back to password', () => {
    const def = { key: 'etherscanApiKey', label: 'Key', type: 'text', default: '' };
    const handle = window.DnznSettingsFields!.renderField(def as any, '', makeCtx('ethereum'));
    const input = handle.element.querySelector('input') as HTMLInputElement;
    const revealBtn = handle.element.querySelector('.controls button') as HTMLButtonElement;

    revealBtn.click();
    expect(input.type).toBe('text');
    revealBtn.click();
    expect(input.type).toBe('password');

    window.DnznSettingsFields!.resetRevealState();
  });

  it('reveal state survives a re-render of the same mounted instance, and re-masks after cleanup + re-init', () => {
    const def = { key: 'etherscanApiKey', label: 'Key', type: 'text', default: '' };
    const sections = [{ id: 'ethereum', label: 'Ethereum', definitions: [def] }];
    (window as any).__DXKIT__ = makeStubDx(sections);
    const container = document.createElement('div');
    let cleanup = window.DnznSettingsDapp!.init(container);

    let input = container.querySelector('input') as HTMLInputElement;
    const revealBtn = container.querySelector('.controls button') as HTMLButtonElement;
    revealBtn.click();
    expect(input.type).toBe('text');

    // A re-render of the same mounted instance (e.g. a sibling field's commit repainting this
    // section) — renderField called again for the same section/key while still mounted.
    const rerendered = window.DnznSettingsFields!.renderField(def as any, '', makeCtx('ethereum'));
    const rerenderedInput = rerendered.element.querySelector('input') as HTMLInputElement;
    expect(rerenderedInput.type).toBe('text');

    cleanup();
    cleanup = window.DnznSettingsDapp!.init(container);
    input = container.querySelector('input') as HTMLInputElement;
    expect(input.type).toBe('password');
    cleanup();
  });

  it('a secret value appears in input.value and nowhere in container.innerHTML', () => {
    const def = { key: 'etherscanApiKey', label: 'Key', type: 'text', default: '' };
    const handle = window.DnznSettingsFields!.renderField(def as any, 's3cr3t-value', makeCtx('ethereum'));
    const input = handle.element.querySelector('input') as HTMLInputElement;

    expect(input.value).toBe('s3cr3t-value');
    expect(handle.element.innerHTML).not.toMatch(/s3cr3t-value/);

    window.DnznSettingsFields!.resetRevealState();
  });

  it('a failed validation message on a secret field never contains the field value', () => {
    const def = {
      key: 'etherscanApiKey',
      label: 'Key',
      type: 'text',
      default: '',
      validation: { pattern: '^0x[0-9a-f]+$' },
    };
    const handle = window.DnznSettingsFields!.renderField(def as any, '', makeCtx('ethereum'));
    const input = handle.element.querySelector('input') as HTMLInputElement;
    const commitBtn = handle.element.querySelector('.controls button:nth-child(2)') as HTMLButtonElement;

    input.value = 'totally-not-hex-topsecret';
    input.dispatchEvent(new Event('input'));
    commitBtn.click();

    const errorEl = handle.element.querySelector('.settings-field-error');
    expect(errorEl).not.toBeNull();
    expect(errorEl!.textContent || '').not.toContain('totally-not-hex-topsecret');

    window.DnznSettingsFields!.resetRevealState();
  });

  it('a secret input and the rpcUrl input both carry autocomplete=off, spellcheck=false, autocapitalize=off', () => {
    const secretDef = { key: 'etherscanApiKey', label: 'Key', type: 'text', default: '' };
    const secretHandle = window.DnznSettingsFields!.renderField(secretDef as any, '', makeCtx('ethereum'));
    const secretInput = secretHandle.element.querySelector('input') as HTMLInputElement;
    expect(secretInput.getAttribute('autocomplete')).toBe('off');
    expect(secretInput.getAttribute('spellcheck')).toBe('false');
    expect(secretInput.getAttribute('autocapitalize')).toBe('off');

    const rpcDef = { key: 'rpcUrl', label: 'RPC', type: 'text', default: '' };
    const rpcHandle = window.DnznSettingsFields!.renderField(rpcDef as any, '', makeCtx('ethereum'));
    const rpcInput = rpcHandle.element.querySelector('input') as HTMLInputElement;
    expect(rpcInput.getAttribute('autocomplete')).toBe('off');
    expect(rpcInput.getAttribute('spellcheck')).toBe('false');
    expect(rpcInput.getAttribute('autocapitalize')).toBe('off');

    window.DnznSettingsFields!.resetRevealState();
  });

  it('no rendered input carries a name attribute resembling password, username or email', () => {
    const defs = [
      { key: 'etherscanApiKey', label: 'Key', type: 'text', default: '' },
      { key: 'rpcUrl', label: 'RPC', type: 'text', default: '' },
      { key: 'etherscanRps', label: 'RPS', type: 'number', default: 5 },
    ];
    for (const def of defs) {
      const handle = window.DnznSettingsFields!.renderField(def as any, '', makeCtx('ethereum'));
      const input = handle.element.querySelector('input') as HTMLInputElement;
      expect(input.getAttribute('name') || '').not.toMatch(/password|username|email/i);
    }
    window.DnznSettingsFields!.resetRevealState();
  });

  it('resetRevealState() directly re-masks a revealed field on the next render', () => {
    const def = { key: 'etherscanApiKey', label: 'Key', type: 'text', default: '' };
    const first = window.DnznSettingsFields!.renderField(def as any, '', makeCtx('ethereum'));
    const revealBtn = first.element.querySelector('.controls button') as HTMLButtonElement;
    revealBtn.click();
    expect((first.element.querySelector('input') as HTMLInputElement).type).toBe('text');

    window.DnznSettingsFields!.resetRevealState();

    const second = window.DnznSettingsFields!.renderField(def as any, '', makeCtx('ethereum'));
    expect((second.element.querySelector('input') as HTMLInputElement).type).toBe('password');
  });

  it('no logging sink is called from the field renderer', () => {
    const source = readFileSync(resolve(__dirname, '../src/dapps/settings/fields.ts'), 'utf-8');
    const withoutComments = source
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n');
    expect((withoutComments.match(/console\./g) || []).length).toBe(0);
  });

  it('SECRET_FIELDS is declared and used at least twice in fields.ts', () => {
    const source = readFileSync(resolve(__dirname, '../src/dapps/settings/fields.ts'), 'utf-8');
    expect((source.match(/SECRET_FIELDS/g) || []).length).toBeGreaterThanOrEqual(2);
  });
});

describe('Task 1 (01-04): SECTION_ORDER, empty-section omission, card layout', () => {
  it('orderSections pins ethereum first and _shell last, given _shell, theme, ethereum', () => {
    const ids = window
      .DnznSettingsDapp!.orderSections([{ id: '_shell' }, { id: 'theme' }, { id: 'ethereum' }] as any)
      .map((s: any) => s.id);
    expect(ids).toEqual(['ethereum', 'theme', '_shell']);
  });

  it('unnamed sections keep their relative input order between the named head and the shell tail', () => {
    const ids = window
      .DnznSettingsDapp!.orderSections([{ id: '_shell' }, { id: 'alpha' }, { id: 'beta' }, { id: 'ethereum' }] as any)
      .map((s: any) => s.id);
    expect(ids).toEqual(['ethereum', 'alpha', 'beta', '_shell']);
  });

  it('does not throw and returns every input section exactly once when ethereum is absent', () => {
    const input = [{ id: '_shell' }, { id: 'theme' }, { id: 'alpha' }];
    expect(() => window.DnznSettingsDapp!.orderSections(input as any)).not.toThrow();
    const ids = window.DnznSettingsDapp!.orderSections(input as any).map((s: any) => s.id);
    expect(ids.sort()).toEqual(['_shell', 'alpha', 'theme'].sort());
    expect(ids).toHaveLength(3);
  });

  it('returns every input section exactly once when _shell is absent', () => {
    const input = [{ id: 'theme' }, { id: 'ethereum' }, { id: 'alpha' }];
    const ids = window.DnznSettingsDapp!.orderSections(input as any).map((s: any) => s.id);
    expect(ids).toHaveLength(3);
    expect(new Set(ids)).toEqual(new Set(['theme', 'ethereum', 'alpha']));
  });

  it('is idempotent — calling it twice on the same input yields identical id sequences', () => {
    const input = [{ id: '_shell' }, { id: 'theme' }, { id: 'ethereum' }, { id: 'alpha' }];
    const first = window.DnznSettingsDapp!.orderSections(input as any).map((s: any) => s.id);
    const second = window.DnznSettingsDapp!.orderSections(input as any).map((s: any) => s.id);
    expect(second).toEqual(first);
  });

  it('a section with an empty definitions array produces no .card', () => {
    const emptyDef = { id: 'empty', label: 'Empty', definitions: [] };
    const realDef = { key: 'a', label: 'A', type: 'text', default: '' };
    const sections = [emptyDef, { id: 'ethereum', label: 'Ethereum', definitions: [realDef] }];
    (window as any).__DXKIT__ = makeStubDx(sections);
    const container = document.createElement('div');
    const cleanup = window.DnznSettingsDapp!.init(container);

    const cards = container.querySelectorAll('.card');
    expect(cards).toHaveLength(1);
    expect(cards[0].querySelector('.card-title')?.textContent).toBe('Ethereum');

    cleanup();
  });

  it('a section whose every definition has a falsy dependsOn still produces a .card containing all of them', () => {
    const enabledDef = { key: 'enabled', label: 'Enabled', type: 'boolean', default: false };
    const childDef = { key: 'child', label: 'Child', type: 'text', default: '', dependsOn: 'enabled' };
    const sections = [{ id: 'sect', label: 'Sect', definitions: [enabledDef, childDef] }];
    (window as any).__DXKIT__ = makeStubDx(sections);
    const container = document.createElement('div');
    const cleanup = window.DnznSettingsDapp!.init(container);

    const cards = container.querySelectorAll('.card');
    expect(cards).toHaveLength(1);
    expect(cards[0].querySelectorAll('.input-group')).toHaveLength(2);

    cleanup();
  });

  it('two sections with distinct ids produce two distinct .card elements with no field crossover', () => {
    const defA = { key: 'a', label: 'A', type: 'text', default: '' };
    const defB = { key: 'b', label: 'B', type: 'text', default: '' };
    const sections = [
      { id: 'sectionA', label: 'Section A', definitions: [defA] },
      { id: 'sectionB', label: 'Section B', definitions: [defB] },
    ];
    (window as any).__DXKIT__ = makeStubDx(sections);
    const container = document.createElement('div');
    const cleanup = window.DnznSettingsDapp!.init(container);

    const cards = container.querySelectorAll('.card');
    expect(cards).toHaveLength(2);
    expect(cards[0].querySelectorAll('.input-group')).toHaveLength(1);
    expect(cards[1].querySelectorAll('.input-group')).toHaveLength(1);
    expect(cards[0].contains(cards[1])).toBe(false);
    expect(cards[1].contains(cards[0])).toBe(false);

    cleanup();
  });

  it('init against a three-section stub (_shell, theme, ethereum) produces exactly three cards', () => {
    const shellDef = { key: 'tpl', label: 'TPL', type: 'boolean', default: false };
    const themeDef = {
      key: 'theme',
      label: 'Theme',
      type: 'select',
      default: 'a',
      options: [{ label: 'A', value: 'a' }],
    };
    const ethDef = { key: 'etherscanApiKey', label: 'Key', type: 'text', default: '' };
    const sections = [
      { id: '_shell', label: 'Dapps', definitions: [shellDef] },
      { id: 'theme', label: 'Theme', definitions: [themeDef] },
      { id: 'ethereum', label: 'Ethereum', definitions: [ethDef] },
    ];
    (window as any).__DXKIT__ = makeStubDx(sections);
    const container = document.createElement('div');
    const cleanup = window.DnznSettingsDapp!.init(container);

    const cards = container.querySelectorAll('.card');
    expect(cards).toHaveLength(3);
    const titles = Array.from(cards).map((c) => c.querySelector('.card-title')?.textContent);
    expect(titles).toEqual(['Ethereum', 'Theme', 'Dapps']);

    cleanup();
  });

  it('writes no layout override from the dapp', () => {
    const source = readFileSync(resolve(__dirname, '../src/dapps/settings/settings.ts'), 'utf-8');
    const withoutComments = source
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n');
    expect((withoutComments.match(/data-layout/g) || []).length).toBe(0);
  });
});

describe('Task 2 (01-04): privacy notice at the top of the page', () => {
  function makeEthereumSections() {
    const ethDef = { key: 'etherscanApiKey', label: 'Key', type: 'text', default: '' };
    return [{ id: 'ethereum', label: 'Ethereum', definitions: [ethDef] }];
  }

  it('renders exactly one .settings-privacy-notice, preceding the first .card in document order', () => {
    (window as any).__DXKIT__ = makeStubDx(makeEthereumSections());
    const container = document.createElement('div');
    const cleanup = window.DnznSettingsDapp!.init(container);

    const notices = container.querySelectorAll('.settings-privacy-notice');
    expect(notices).toHaveLength(1);

    const children = Array.from(container.children);
    const noticeIndex = children.indexOf(notices[0]);
    const firstCardIndex = children.findIndex((el) => el.classList.contains('card'));
    expect(noticeIndex).toBeGreaterThanOrEqual(0);
    expect(firstCardIndex).toBeGreaterThan(noticeIndex);

    cleanup();
  });

  it('names the storage key dnzn:dotdev:settings', () => {
    (window as any).__DXKIT__ = makeStubDx(makeEthereumSections());
    const container = document.createElement('div');
    const cleanup = window.DnznSettingsDapp!.init(container);

    const notice = container.querySelector('.settings-privacy-notice')!;
    expect(notice.textContent).toContain('dnzn:dotdev:settings');

    cleanup();
  });

  it('mentions plaintext, this browser, no backend, and devtools (case-insensitive)', () => {
    (window as any).__DXKIT__ = makeStubDx(makeEthereumSections());
    const container = document.createElement('div');
    const cleanup = window.DnznSettingsDapp!.init(container);

    const text = (container.querySelector('.settings-privacy-notice')!.textContent || '').toLowerCase();
    for (const phrase of ['plaintext', 'this browser', 'no backend', 'devtools']) {
      expect(text).toContain(phrase);
    }

    cleanup();
  });

  it('names the third-party-provider case: a provider word and a sending word in the same sentence', () => {
    (window as any).__DXKIT__ = makeStubDx(makeEthereumSections());
    const container = document.createElement('div');
    const cleanup = window.DnznSettingsDapp!.init(container);

    const text = container.querySelector('.settings-privacy-notice')!.textContent || '';
    const sentences = text.split(/(?<=[.!?])\s+/);
    const matchingSentence = sentences.find((s) => /(provider|rpc|etherscan)/i.test(s) && /(sent|sends)/i.test(s));
    expect(matchingSentence).toBeDefined();

    cleanup();
  });

  it('does not contain any reassurance phrase, including a bare "unencrypted" disclosure', () => {
    (window as any).__DXKIT__ = makeStubDx(makeEthereumSections());
    const container = document.createElement('div');
    const cleanup = window.DnznSettingsDapp!.init(container);

    const text = (container.querySelector('.settings-privacy-notice')!.textContent || '').toLowerCase();
    for (const phrase of ['is encrypted', 'are encrypted', 'stored securely', 'kept safe', 'your data is protected']) {
      expect(text).not.toContain(phrase);
    }

    cleanup();
  });

  it('style.css has no colour literals and references settings-privacy-notice', () => {
    const css = readFileSync(resolve(__dirname, '../src/dapps/settings/style.css'), 'utf-8');
    expect(/#[0-9a-fA-F]{3,6}\b/.test(css)).toBe(false);
    expect((css.match(/settings-privacy-notice/g) || []).length).toBeGreaterThanOrEqual(1);
  });

  it('the control-strip icon rule paints via stroke, not the SVG default fill', () => {
    const css = readFileSync(resolve(__dirname, '../src/styles/components.css'), 'utf-8');
    // Scoped to this one rule body — a whole-file grep would also pass on shell.css-style
    // rules that are not this one.
    const match = css.match(/\.input-wrap \.controls button svg\s*\{([^}]*)\}/);
    expect(match).not.toBeNull();
    const body = match![1];
    expect(body).toContain('stroke: currentColor');
    expect(body).toContain('fill: none');
  });

  it('settings style.css owns no card spacing — the layout flex gap does', () => {
    const css = readFileSync(resolve(__dirname, '../src/dapps/settings/style.css'), 'utf-8');
    // Any rule the dapp writes against the settings root id stacks a margin on top of the
    // inherited .layout-content flex gap, which is exactly the WR-01-adjacent bug this
    // task fixes — so the dapp must not declare that selector at all.
    // <!-- planner-discipline-allow: #settings-root -->
    expect(css.includes('#settings-root')).toBe(false);
  });

  it('the select chevron is tinted by currentColor, not baked into the image', () => {
    const css = readFileSync(resolve(__dirname, '../src/styles/components.css'), 'utf-8');
    const match = css.match(/\.select-wrap::after\s*\{([^}]*)\}/);
    expect(match).not.toBeNull();
    const body = match![1];
    expect(body).toContain('background-color: currentColor');
    expect(body).toContain('mask-image');
    // The tint must come from CSS, not the SVG — the data URI itself carries no paint
    // attribute, relying purely on the default fill for mask alpha.
    expect(/fill=/.test(body)).toBe(false);
    expect(/stroke=/.test(body)).toBe(false);
  });
});

describe('Task 3 (01-04): _shell toggle renders through the ordinary boolean branch', () => {
  function makeShellSections() {
    const tplDef = { key: 'tpl', label: 'TPL', type: 'boolean', default: false };
    const tplDef2 = { key: 'tpl2', label: 'TPL2', type: 'boolean', default: true };
    return [{ id: '_shell', label: 'Dapps', definitions: [tplDef, tplDef2] }];
  }

  it('renders a card titled Dapps containing two role="switch" controls', () => {
    (window as any).__DXKIT__ = makeStubDx(makeShellSections());
    const container = document.createElement('div');
    const cleanup = window.DnznSettingsDapp!.init(container);

    const cards = Array.from(container.querySelectorAll('.card'));
    const dappsCard = cards.find((c) => c.querySelector('.card-title')?.textContent === 'Dapps');
    expect(dappsCard).toBeDefined();
    expect(dappsCard!.querySelectorAll('button[role="switch"]')).toHaveLength(2);

    cleanup();
  });

  it('clicking a _shell boolean calls dx.settings.set exactly once, synchronously, with (_shell, dappId, boolean) — no commit control, no dirty state', () => {
    const sections = makeShellSections();
    const dx = makeStubDx(sections);
    (window as any).__DXKIT__ = dx;
    const container = document.createElement('div');
    const cleanup = window.DnznSettingsDapp!.init(container);

    const dappsCard = Array.from(container.querySelectorAll('.card')).find(
      (c) => c.querySelector('.card-title')?.textContent === 'Dapps',
    )!;
    // tpl defaults false, so one click commits true.
    const switchBtn = dappsCard.querySelectorAll('button[role="switch"]')[0] as HTMLButtonElement;
    switchBtn.dispatchEvent(new Event('click', { bubbles: true }));

    expect(dx._setCalls).toHaveLength(1);
    expect(dx._setCalls[0]).toEqual({ sectionId: '_shell', key: 'tpl', value: true });
    expect(dappsCard.querySelectorAll('.controls')).toHaveLength(0);
    expect(dappsCard.querySelectorAll('.is-dirty')).toHaveLength(0);

    cleanup();
  });

  it('the settings dapp never invokes the shell dapp-toggling methods itself', () => {
    const source = readFileSync(resolve(__dirname, '../src/dapps/settings/settings.ts'), 'utf-8');
    const withoutComments = source
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n');
    expect((withoutComments.match(/dx\.(enable|disable)Dapp/g) || []).length).toBe(0);
  });

  it('no code path outside orderSections special-cases the _shell id — identical stub sections produce structurally identical cards', () => {
    const defA = { key: 'x', label: 'X', type: 'boolean', default: false };
    const sections = [
      { id: '_shell', label: 'Shell', definitions: [defA] },
      { id: 'zzz', label: 'Zzz', definitions: [{ ...defA }] },
    ];
    (window as any).__DXKIT__ = makeStubDx(sections);
    const container = document.createElement('div');
    const cleanup = window.DnznSettingsDapp!.init(container);

    const cards = Array.from(container.querySelectorAll('.card'));
    const shellCard = cards.find((c) => c.querySelector('.card-title')?.textContent === 'Shell')!;
    const zzzCard = cards.find((c) => c.querySelector('.card-title')?.textContent === 'Zzz')!;

    expect(shellCard.querySelectorAll('button[role="switch"]').length).toBe(
      zzzCard.querySelectorAll('button[role="switch"]').length,
    );
    expect(shellCard.querySelectorAll('.controls').length).toBe(zzzCard.querySelectorAll('.controls').length);
    expect(shellCard.querySelectorAll('button').length).toBe(zzzCard.querySelectorAll('button').length);

    cleanup();
  });
});

// Stub `dx` scoped to the attachExternalSync suite below: exposes settings.get/set over
// a plain object store (not the Map-based makeStubDx, since diffAndReplay's readCurrent
// closure just needs get/set) and a real on/off/emit EventBus, with an opt-in
// emitOnSet to model the real plugin's synchronous dx:plugin:settings:changed emission
// from set() (see Pattern 4 in 01-RESEARCH.md).
function makeSyncDx(
  initial: Record<string, Record<string, unknown>>,
  options: { emitOnSet?: boolean; sections?: any[] } = {},
) {
  const store: Record<string, Record<string, unknown>> = JSON.parse(JSON.stringify(initial));
  const setCalls: { sectionId: string; key: string; value: unknown }[] = [];
  const listeners: Record<string, Array<(detail: any) => void>> = {};
  let offCalls = 0;

  function on(event: string, handler: (detail: any) => void) {
    if (!listeners[event]) listeners[event] = [];
    listeners[event].push(handler);
    return {
      off: () => {
        offCalls += 1;
        listeners[event] = (listeners[event] || []).filter((h) => h !== handler);
      },
    };
  }
  function emit(event: string, detail: any) {
    for (const handler of listeners[event] || []) handler(detail);
  }

  return {
    settings: {
      get: (sectionId: string, key: string) => store[sectionId]?.[key],
      set: (sectionId: string, key: string, value: unknown) => {
        if (!store[sectionId]) store[sectionId] = {};
        store[sectionId][key] = value;
        setCalls.push({ sectionId, key, value });
        if (options.emitOnSet) emit('dx:plugin:settings:changed', { dappId: sectionId, key, value });
      },
      // WR-03: intentionally OMITTED unless a test opts in via `options.sections` — every
      // pre-existing test in this describe block calls makeSyncDx with no `getSections` at
      // all, which is exactly what proves sync.ts's optional-call default doesn't regress.
      ...(options.sections ? { getSections: () => options.sections } : {}),
    },
    events: { on, emit },
    _setCalls: setCalls,
    get _offCalls() {
      return offCalls;
    },
  };
}

function makeSyncOpts(overrides: Partial<{ isDirty: any; repaintField: any; getSemanticValue: any }> = {}) {
  return {
    isDirty: vi.fn(() => false),
    repaintField: vi.fn(),
    getSemanticValue: vi.fn(),
    ...overrides,
  };
}

function dispatchStorage(key: string, newValue: string | null) {
  window.dispatchEvent(new StorageEvent('storage', { key, newValue: newValue as any }));
}

const SETTINGS_STORAGE_KEY = 'dnzn:dotdev:settings';

describe('Task 2 (01-05): attachExternalSync — cross-tab storage listener', () => {
  it('replays a diff through dx.settings.set for a valid JSON payload', () => {
    const dx = makeSyncDx({ ethereum: { rpcUrl: 'https://old' } });
    const opts = makeSyncOpts();
    const detach = window.DnznSettingsSync!.attachExternalSync(dx, opts);

    dispatchStorage(SETTINGS_STORAGE_KEY, JSON.stringify({ ethereum: { rpcUrl: 'https://new' } }));

    expect(dx._setCalls).toEqual([{ sectionId: 'ethereum', key: 'rpcUrl', value: 'https://new' }]);
    detach();
  });

  it('ignores a storage event for an unrelated key', () => {
    const dx = makeSyncDx({ ethereum: { rpcUrl: 'https://old' } });
    const detach = window.DnznSettingsSync!.attachExternalSync(dx, makeSyncOpts());

    dispatchStorage('some-other-key', JSON.stringify({ ethereum: { rpcUrl: 'https://new' } }));

    expect(dx._setCalls).toHaveLength(0);
    detach();
  });

  it('ignores a storage event whose newValue is not valid JSON, without throwing, and writes nothing', () => {
    const dx = makeSyncDx({});
    const detach = window.DnznSettingsSync!.attachExternalSync(dx, makeSyncOpts());

    expect(() => dispatchStorage(SETTINGS_STORAGE_KEY, 'not json')).not.toThrow();
    expect(dx._setCalls).toHaveLength(0);
    detach();
  });

  it('ignores a storage event whose newValue is null, without throwing', () => {
    const dx = makeSyncDx({});
    const detach = window.DnznSettingsSync!.attachExternalSync(dx, makeSyncOpts());

    expect(() => dispatchStorage(SETTINGS_STORAGE_KEY, null)).not.toThrow();
    expect(dx._setCalls).toHaveLength(0);
    detach();
  });

  it('ignores valid JSON of the wrong shape — an array, or a payload with a null section — without throwing or writing', () => {
    const dx = makeSyncDx({});
    const detach = window.DnznSettingsSync!.attachExternalSync(dx, makeSyncOpts());

    expect(() => dispatchStorage(SETTINGS_STORAGE_KEY, '[1,2]')).not.toThrow();
    expect(() => dispatchStorage(SETTINGS_STORAGE_KEY, JSON.stringify({ ethereum: null }))).not.toThrow();
    expect(dx._setCalls).toHaveLength(0);
    detach();
  });

  it('a clean differing key is repainted exactly once — write and repaint are the same round trip, not two', () => {
    const dx = makeSyncDx({ ethereum: { rpcUrl: 'https://old' } }, { emitOnSet: true });
    const opts = makeSyncOpts({ getSemanticValue: vi.fn(() => 'https://old') });
    const detach = window.DnznSettingsSync!.attachExternalSync(dx, opts);

    dispatchStorage(SETTINGS_STORAGE_KEY, JSON.stringify({ ethereum: { rpcUrl: 'https://new' } }));

    expect(opts.repaintField).toHaveBeenCalledTimes(1);
    expect(opts.repaintField).toHaveBeenCalledWith('ethereum', 'rpcUrl', 'https://new');
    detach();
  });

  it('the storage handler itself never calls repaintField', () => {
    const dx = makeSyncDx({ ethereum: { rpcUrl: 'https://old' } }, { emitOnSet: false });
    const opts = makeSyncOpts();
    const detach = window.DnznSettingsSync!.attachExternalSync(dx, opts);

    dispatchStorage(SETTINGS_STORAGE_KEY, JSON.stringify({ ethereum: { rpcUrl: 'https://new' } }));

    expect(opts.repaintField).toHaveBeenCalledTimes(0);
    detach();
  });

  it('a dirty key writes but is not repainted; a clean sibling in the same payload writes and repaints exactly once', () => {
    const dx = makeSyncDx({ ethereum: { rpcUrl: 'https://old', etherscanRps: 1 } }, { emitOnSet: true });
    const opts = makeSyncOpts({
      isDirty: vi.fn((_sectionId: string, key: string) => key === 'rpcUrl'),
      getSemanticValue: vi.fn(() => undefined),
    });
    const detach = window.DnznSettingsSync!.attachExternalSync(dx, opts);

    dispatchStorage(SETTINGS_STORAGE_KEY, JSON.stringify({ ethereum: { rpcUrl: 'https://new', etherscanRps: 5 } }));

    expect(dx._setCalls).toHaveLength(2);
    expect(opts.repaintField).toHaveBeenCalledTimes(1);
    expect(opts.repaintField).toHaveBeenCalledWith('ethereum', 'etherscanRps', 5);
    detach();
  });

  it('calling the returned detach removes the window storage listener and calls off() on the bus listener exactly once', () => {
    const dx = makeSyncDx({ ethereum: { rpcUrl: 'https://old' } });
    const detach = window.DnznSettingsSync!.attachExternalSync(dx, makeSyncOpts());

    detach();
    expect(dx._offCalls).toBe(1);

    dispatchStorage(SETTINGS_STORAGE_KEY, JSON.stringify({ ethereum: { rpcUrl: 'https://newer' } }));
    expect(dx._setCalls).toHaveLength(0);
  });

  it('a mount/unmount/mount cycle leaves exactly one storage listener attached — no double-binding across a remount', () => {
    const dx = makeSyncDx({ ethereum: { rpcUrl: 'https://old' } });
    const opts = makeSyncOpts();

    const detach1 = window.DnznSettingsSync!.attachExternalSync(dx, opts);
    detach1();
    const detach2 = window.DnznSettingsSync!.attachExternalSync(dx, opts);

    dispatchStorage(SETTINGS_STORAGE_KEY, JSON.stringify({ ethereum: { rpcUrl: 'https://newer' } }));
    expect(dx._setCalls).toHaveLength(1);
    detach2();
  });
});

describe('Task 2 (01-05): attachExternalSync — same-tab dx:plugin:settings:changed listener', () => {
  it('repaints the field once, and not when isDirty is true for it', () => {
    const dx = makeSyncDx({});
    const isDirtyMock = vi.fn(() => false);
    const opts = makeSyncOpts({ isDirty: isDirtyMock, getSemanticValue: vi.fn(() => 'old') });
    const detach = window.DnznSettingsSync!.attachExternalSync(dx, opts);

    dx.events.emit('dx:plugin:settings:changed', { dappId: 'ethereum', key: 'rpcUrl', value: 'new' });
    expect(opts.repaintField).toHaveBeenCalledTimes(1);
    expect(opts.repaintField).toHaveBeenCalledWith('ethereum', 'rpcUrl', 'new');

    isDirtyMock.mockReturnValue(true);
    dx.events.emit('dx:plugin:settings:changed', { dappId: 'ethereum', key: 'rpcUrl', value: 'new2' });
    expect(opts.repaintField).toHaveBeenCalledTimes(1);

    detach();
  });

  it('the coerced-equality guard compares getSemanticValue, not the raw event value against a DOM string', () => {
    const dx = makeSyncDx({});
    const getSemanticValue = vi.fn(() => 1);
    const opts = makeSyncOpts({ getSemanticValue });
    const detach = window.DnznSettingsSync!.attachExternalSync(dx, opts);

    dx.events.emit('dx:plugin:settings:changed', { dappId: 'ethereum', key: 'chainId', value: 1 });
    expect(opts.repaintField).toHaveBeenCalledTimes(0);

    dx.events.emit('dx:plugin:settings:changed', { dappId: 'ethereum', key: 'chainId', value: 11155111 });
    expect(opts.repaintField).toHaveBeenCalledTimes(1);
    expect(opts.repaintField).toHaveBeenCalledWith('ethereum', 'chainId', 11155111);

    detach();
  });
});

describe('Task 2 (01-05): settings.ts wires the real field registry into attachExternalSync', () => {
  it('a clean external storage change repaints the visible field and corrects the store', () => {
    const rpcDef = { key: 'rpcUrl', label: 'RPC URL', type: 'text', default: '' };
    const sections = [{ id: 'ethereum', label: 'Ethereum', definitions: [rpcDef] }];
    const dx = makeStubDx(sections);
    (window as any).__DXKIT__ = dx;
    const container = document.createElement('div');
    const cleanup = window.DnznSettingsDapp!.init(container);

    const input = container.querySelector('input') as HTMLInputElement;
    expect(input.value).toBe('');

    dispatchStorage(SETTINGS_STORAGE_KEY, JSON.stringify({ ethereum: { rpcUrl: 'https://from-other-tab' } }));

    expect(input.value).toBe('https://from-other-tab');
    expect(window.DnznSettingsDapp!.getSemanticValue('ethereum', 'rpcUrl')).toBe('https://from-other-tab');

    cleanup();
  });

  it('a dirty field is corrected in the store by an external change but its visible input is left alone', () => {
    const rpcDef = { key: 'rpcUrl', label: 'RPC URL', type: 'text', default: '' };
    const sections = [{ id: 'ethereum', label: 'Ethereum', definitions: [rpcDef] }];
    const dx = makeStubDx(sections);
    (window as any).__DXKIT__ = dx;
    const container = document.createElement('div');
    const cleanup = window.DnznSettingsDapp!.init(container);

    const input = container.querySelector('input') as HTMLInputElement;
    input.value = 'https://in-progress-edit';
    input.dispatchEvent(new Event('input'));
    expect(window.DnznSettingsDapp!.isDirty('ethereum', 'rpcUrl')).toBe(true);

    dispatchStorage(SETTINGS_STORAGE_KEY, JSON.stringify({ ethereum: { rpcUrl: 'https://from-other-tab' } }));

    expect(input.value).toBe('https://in-progress-edit');
    expect(dx.settings.get('ethereum', 'rpcUrl')).toBe('https://from-other-tab');

    cleanup();
  });

  it('DnznSettingsDapp.getSemanticValue delegates to the field handle and returns undefined for an unrendered key', () => {
    const rpcDef = { key: 'rpcUrl', label: 'RPC URL', type: 'text', default: 'https://default' };
    const sections = [{ id: 'ethereum', label: 'Ethereum', definitions: [rpcDef] }];
    (window as any).__DXKIT__ = makeStubDx(sections);
    const container = document.createElement('div');
    const cleanup = window.DnznSettingsDapp!.init(container);

    expect(window.DnznSettingsDapp!.getSemanticValue('ethereum', 'rpcUrl')).toBe('https://default');
    expect(window.DnznSettingsDapp!.getSemanticValue('nope', 'nope')).toBeUndefined();

    cleanup();
  });
});

describe('Task 3 (quick-260827-l29): external-sync replay is validated against the definition (WR-03)', () => {
  function makeRpsSections() {
    const rpsDef = { key: 'etherscanRps', label: 'RPS', type: 'number', default: 1, validation: { min: 1, max: 5 } };
    return [{ id: 'ethereum', label: 'Ethereum', definitions: [rpsDef] }];
  }

  it('a value outside a declared numeric bound is neither written nor repainted', () => {
    const dx = makeSyncDx({ ethereum: { etherscanRps: 1 } }, { emitOnSet: true, sections: makeRpsSections() });
    const opts = makeSyncOpts();
    const detach = window.DnznSettingsSync!.attachExternalSync(dx, opts);

    dispatchStorage(SETTINGS_STORAGE_KEY, JSON.stringify({ ethereum: { etherscanRps: 999 } }));

    expect(dx._setCalls).toHaveLength(0);
    expect(opts.repaintField).toHaveBeenCalledTimes(0);
    detach();
  });

  it('the same payload with an in-bounds value is written and repainted exactly once', () => {
    const dx = makeSyncDx({ ethereum: { etherscanRps: 1 } }, { emitOnSet: true, sections: makeRpsSections() });
    const opts = makeSyncOpts({ getSemanticValue: vi.fn(() => 1) });
    const detach = window.DnznSettingsSync!.attachExternalSync(dx, opts);

    dispatchStorage(SETTINGS_STORAGE_KEY, JSON.stringify({ ethereum: { etherscanRps: 3 } }));

    expect(dx._setCalls).toEqual([{ sectionId: 'ethereum', key: 'etherscanRps', value: 3 }]);
    expect(opts.repaintField).toHaveBeenCalledTimes(1);
    expect(opts.repaintField).toHaveBeenCalledWith('ethereum', 'etherscanRps', 3);
    detach();
  });

  it('a key with no matching definition is still written — an unknown section must not be dropped', () => {
    const dx = makeSyncDx({ ethereum: { futureKey: 'old' } }, { sections: makeRpsSections() });
    const opts = makeSyncOpts();
    const detach = window.DnznSettingsSync!.attachExternalSync(dx, opts);

    dispatchStorage(SETTINGS_STORAGE_KEY, JSON.stringify({ ethereum: { futureKey: 'new' } }));

    expect(dx._setCalls).toEqual([{ sectionId: 'ethereum', key: 'futureKey', value: 'new' }]);
    detach();
  });

  it('every existing sync test still passes against a stub with no getSections at all', () => {
    const dx = makeSyncDx({ ethereum: { rpcUrl: 'https://old' } });
    expect((dx.settings as any).getSections).toBeUndefined();
    const detach = window.DnznSettingsSync!.attachExternalSync(dx, makeSyncOpts());

    dispatchStorage(SETTINGS_STORAGE_KEY, JSON.stringify({ ethereum: { rpcUrl: 'https://new' } }));

    expect(dx._setCalls).toEqual([{ sectionId: 'ethereum', key: 'rpcUrl', value: 'https://new' }]);
    detach();
  });
});

describe('Task 3 (quick-260827-l29): mounting reconciles against the current localStorage snapshot (WR-05)', () => {
  it('a differing key is written through dx.settings.set and, with the stub emitting on set, repainted exactly once', () => {
    installFakeLocalStorage();
    window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ ethereum: { rpcUrl: 'https://newer' } }));

    const dx = makeSyncDx({ ethereum: { rpcUrl: 'https://old' } }, { emitOnSet: true });
    const opts = makeSyncOpts({ getSemanticValue: vi.fn(() => 'https://old') });
    const detach = window.DnznSettingsSync!.attachExternalSync(dx, opts);

    expect(dx._setCalls).toEqual([{ sectionId: 'ethereum', key: 'rpcUrl', value: 'https://newer' }]);
    expect(opts.repaintField).toHaveBeenCalledTimes(1);
    expect(opts.repaintField).toHaveBeenCalledWith('ethereum', 'rpcUrl', 'https://newer');
    detach();
  });

  it('a key already agreeing with the snapshot produces no write', () => {
    installFakeLocalStorage();
    window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ ethereum: { rpcUrl: 'https://same' } }));

    const dx = makeSyncDx({ ethereum: { rpcUrl: 'https://same' } });
    const detach = window.DnznSettingsSync!.attachExternalSync(dx, makeSyncOpts());

    expect(dx._setCalls).toHaveLength(0);
    detach();
  });

  it('no stored entry produces no write and no exception', () => {
    installFakeLocalStorage();
    const dx = makeSyncDx({ ethereum: { rpcUrl: 'https://old' } });

    let detach: () => void = () => {};
    expect(() => {
      detach = window.DnznSettingsSync!.attachExternalSync(dx, makeSyncOpts());
    }).not.toThrow();
    expect(dx._setCalls).toHaveLength(0);
    detach();
  });

  it('invalid JSON in the snapshot produces no write and no exception', () => {
    installFakeLocalStorage();
    window.localStorage.setItem(SETTINGS_STORAGE_KEY, 'not json');

    const dx = makeSyncDx({ ethereum: { rpcUrl: 'https://old' } });
    let detach: () => void = () => {};
    expect(() => {
      detach = window.DnznSettingsSync!.attachExternalSync(dx, makeSyncOpts());
    }).not.toThrow();
    expect(dx._setCalls).toHaveLength(0);
    detach();
  });

  it('a non-object snapshot payload (an array) produces no write and no exception', () => {
    installFakeLocalStorage();
    window.localStorage.setItem(SETTINGS_STORAGE_KEY, '[1,2,3]');

    const dx = makeSyncDx({ ethereum: { rpcUrl: 'https://old' } });
    let detach: () => void = () => {};
    expect(() => {
      detach = window.DnznSettingsSync!.attachExternalSync(dx, makeSyncOpts());
    }).not.toThrow();
    expect(dx._setCalls).toHaveLength(0);
    detach();
  });

  it('a getItem that throws produces no write and no exception', () => {
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem: () => {
          throw new Error('boom');
        },
      },
    });

    const dx = makeSyncDx({ ethereum: { rpcUrl: 'https://old' } });
    let detach: () => void = () => {};
    expect(() => {
      detach = window.DnznSettingsSync!.attachExternalSync(dx, makeSyncOpts());
    }).not.toThrow();
    expect(dx._setCalls).toHaveLength(0);
    detach();
  });

  it('end to end: a stale-tab mount reconciles the visible input to the localStorage snapshot', () => {
    installFakeLocalStorage();
    window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ ethereum: { rpcUrl: 'https://from-storage' } }));

    const rpcDef = { key: 'rpcUrl', label: 'RPC URL', type: 'text', default: '' };
    const sections = [{ id: 'ethereum', label: 'Ethereum', definitions: [rpcDef] }];
    const dx = makeStubDx(sections);
    (window as any).__DXKIT__ = dx;
    const container = document.createElement('div');
    const cleanup = window.DnznSettingsDapp!.init(container);

    const input = container.querySelector('input') as HTMLInputElement;
    expect(input.value).toBe('https://from-storage');
    expect(dx.settings.get('ethereum', 'rpcUrl')).toBe('https://from-storage');

    cleanup();
  });
});

// WR-01 regression coverage (quick-260827-l29): every test above seeds a bare
// `document.createElement('div')` as the mount container, which is exactly why 184
// green tests never caught settings.ts appending its content BESIDE #settings-root
// instead of inside it. This block seeds the real compiled template.html so the
// direct-child relationship `#settings-root`'s children depend on (`.layout-content`'s
// flex gap in components.css) is actually under test, not just `querySelectorAll`
// (which passes whether the nodes are children or siblings of the root — that blind
// spot is how the bug hid).
describe('Task 1 (quick-260827-l29): mount settings content inside #settings-root, not beside it (WR-01)', () => {
  const TEMPLATE_HTML = readFileSync(resolve(__dirname, '../src/dapps/settings/template.html'), 'utf-8');

  function makeTwoSectionSections() {
    const defA = { key: 'a', label: 'A', type: 'text', default: '' };
    const defB = { key: 'b', label: 'B', type: 'text', default: '' };
    return [
      { id: 'sectionA', label: 'Section A', definitions: [defA] },
      { id: 'sectionB', label: 'Section B', definitions: [defB] },
    ];
  }

  it('with the real template seeded, the privacy notice and every card are direct children of #settings-root, never siblings of it', () => {
    (window as any).__DXKIT__ = makeStubDx(makeTwoSectionSections());
    const container = document.createElement('div');
    container.innerHTML = TEMPLATE_HTML;
    const cleanup = window.DnznSettingsDapp!.init(container);

    // The only thing DxKit hands init() beyond the template wrapper — if content lands
    // beside #settings-root, container ends up with 4 children instead of 1.
    expect(container.children).toHaveLength(1);
    const root = container.children[0] as HTMLElement;
    expect(root.id).toBe('settings-root');

    const rootChildren = Array.from(root.children);
    expect(rootChildren).toHaveLength(3);
    expect(rootChildren[0].classList.contains('settings-privacy-notice')).toBe(true);
    expect(rootChildren[1].classList.contains('card')).toBe(true);
    expect(rootChildren[2].classList.contains('card')).toBe(true);
    for (const el of rootChildren.slice(1)) {
      expect(el.parentElement).toBe(root);
    }

    cleanup();
  });

  it('cleanup empties #settings-root, not the outer container — dapp.ts owns clearing that', () => {
    (window as any).__DXKIT__ = makeStubDx(makeTwoSectionSections());
    const container = document.createElement('div');
    container.innerHTML = TEMPLATE_HTML;
    const cleanup = window.DnznSettingsDapp!.init(container);

    cleanup();

    const root = container.querySelector('#settings-root');
    expect(root).not.toBeNull();
    expect(root!.children).toHaveLength(0);
  });

  it('falls back to the bare container when no #settings-root exists — the path all 184 pre-existing tests take', () => {
    (window as any).__DXKIT__ = makeStubDx(makeTwoSectionSections());
    const container = document.createElement('div');
    const cleanup = window.DnznSettingsDapp!.init(container);

    const children = Array.from(container.children);
    expect(children).toHaveLength(3);
    expect(children[0].classList.contains('settings-privacy-notice')).toBe(true);
    expect(children[1].classList.contains('card')).toBe(true);
    expect(children[2].classList.contains('card')).toBe(true);

    cleanup();
  });

  it('template.html declares the settings-root id the renderer looks up, so renaming one without the other fails here', () => {
    expect(TEMPLATE_HTML).toContain('id="settings-root"');
  });
});
