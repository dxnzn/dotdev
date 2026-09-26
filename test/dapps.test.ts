import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const DAPP_IDS = ['about', 'projects', 'support', 'tpl', 'cic', 'decode', 'settings'] as const;
const SRC = resolve(__dirname, '../src');

function loadManifest(id: string) {
  return JSON.parse(readFileSync(resolve(SRC, `dapps/${id}/manifest.json`), 'utf-8'));
}

function loadDappSource(id: string) {
  return readFileSync(resolve(SRC, `dapps/${id}/dapp.ts`), 'utf-8');
}

describe('dapp manifests', () => {
  const requiredKeys = ['id', 'name', 'description', 'version', 'route', 'entry', 'styles', 'nav'];

  for (const id of DAPP_IDS) {
    describe(id, () => {
      const manifest = loadManifest(id);

      it('has all required fields', () => {
        for (const key of requiredKeys) {
          expect(manifest, `missing "${key}"`).toHaveProperty(key);
        }
      });

      it('id matches directory name', () => {
        expect(manifest.id).toBe(id);
      });

      it('entry and styles point to existing files', () => {
        // entry references the compiled .js — check the .ts source exists
        const tsEntry = manifest.entry.replace('.js', '.ts');
        expect(existsSync(resolve(SRC, tsEntry)), `missing ${tsEntry}`).toBe(true);
        expect(existsSync(resolve(SRC, manifest.styles)), `missing ${manifest.styles}`).toBe(true);
      });

      it('has a template.html', () => {
        expect(existsSync(resolve(SRC, `dapps/${id}/template.html`))).toBe(true);
      });

      it('every dependency entry resolves to an existing TypeScript source file', () => {
        // Skip: entry/styles/template.html above already cover the two-file dapp pattern
        // (CIC, settings) fully — only a manifest with a dependencies array (a multi-module
        // dapp) has anything for this case to walk. Covers decode's four modules and
        // retroactively covers CIC's and settings' own dependencies too.
        if (!manifest.dependencies || manifest.dependencies.length === 0) return;
        for (const dependency of manifest.dependencies) {
          const tsDependency = dependency.replace('.js', '.ts');
          expect(existsSync(resolve(SRC, tsDependency)), `missing ${tsDependency}`).toBe(true);
        }
      });

      it('nav has label, group, and order', () => {
        expect(manifest.nav).toHaveProperty('label');
        expect(manifest.nav).toHaveProperty('group');
        expect(typeof manifest.nav.order).toBe('number');
      });
    });
  }
});

describe('dapp lifecycle wiring', () => {
  for (const id of DAPP_IDS) {
    describe(id, () => {
      const src = loadDappSource(id);

      it('listens for dx:mount and filters on its own id', () => {
        expect(src).toContain('dx:mount');
        expect(src).toContain(`e.detail.id !== '${id}'`);
      });

      it('listens for dx:unmount', () => {
        expect(src).toContain('dx:unmount');
      });

      it('declares its own template.html in manifest', () => {
        const manifest = loadManifest(id);
        expect(manifest.template).toBe(`dapps/${id}/template.html`);
      });
    });
  }
});

describe('decode dapp — DEC-15 (a licence and a README, both present)', () => {
  // Scoped to decode alone, not walked over DAPP_IDS: the existing dapps do not all ship a
  // LICENSE or a README of their own (CIC's LICENSE is the precedent decode follows; the others
  // have neither) — asserting this for every id would fail retroactively for dapps that never
  // promised either. Plan 03-04 shipped the licence and asserted its content; this closes the
  // loop by asserting BOTH files are present for the one dapp DEC-15 actually names.

  it('ships a LICENSE file', () => {
    expect(existsSync(resolve(SRC, 'dapps/decode/LICENSE'))).toBe(true);
  });

  it('ships a README.md file', () => {
    expect(existsSync(resolve(SRC, 'dapps/decode/README.md'))).toBe(true);
  });
});

describe('decode dapp — G-06-10 (the About tab version label matches the manifest)', () => {
  // The version lives twice on purpose: once as the runtime source of truth (manifest.json),
  // once as copy inside template.html for the About tab (there is no runtime read — see
  // ui.ts's setActiveTab, which never touches manifest.json). This test is the only thing
  // that keeps the two in step; reading both from disk here, rather than restating the number
  // as a literal, is what stops the assertion itself going stale.

  it("the template's version-label text contains the manifest's version field", () => {
    const manifest = loadManifest('decode');
    const template = readFileSync(resolve(SRC, 'dapps/decode/template.html'), 'utf-8');
    const match = /class="version-label"[^>]*>([^<]+)</.exec(template);
    expect(match, 'no .version-label element found in decode/template.html').not.toBeNull();
    expect(match![1]).toContain(manifest.version);
  });
});

describe('cic dapp — manifest dependencies', () => {
  const src = loadDappSource('cic');
  const manifest = loadManifest('cic');

  it('declares cic.js as a manifest dependency', () => {
    expect(manifest.dependencies).toContain('dapps/cic/cic.js');
  });

  it('supports report mode via sub-path parsing', () => {
    expect(src).toContain('isReport');
    expect(src).toContain("'report'");
  });

  it('calls window.CIC.init with container and isReport', () => {
    expect(src).toContain('window.CIC.init');
  });
});
