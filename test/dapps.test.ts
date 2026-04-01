import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const DAPP_IDS = ['about', 'projects', 'support', 'tpl', 'cic'] as const;
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
