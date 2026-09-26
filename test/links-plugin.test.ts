import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Reads the COMPILED src/plugins/links.js and executes it against a fresh window-like global,
// then inspects the attached window.DnznLinks namespace directly. Same compiled-JS execution
// pattern as test/ethereum-plugin.test.ts.
function loadCompiledLinksPlugin() {
  const code = readFileSync(resolve(__dirname, '../src/plugins/links.js'), 'utf-8');
  const fakeWindow: any = {};
  new Function('window', code)(fakeWindow);
  return fakeWindow.DnznLinks;
}

describe('links plugin (G-06-6/06-10, DEC-05 amendment)', () => {
  const DnznLinks = loadCompiledLinksPlugin();

  it('defines createLinksPlugin on window.DnznLinks', () => {
    expect(DnznLinks).toBeDefined();
    expect(typeof DnznLinks.createLinksPlugin).toBe('function');
  });

  describe('createLinksPlugin()', () => {
    const plugin = DnznLinks.createLinksPlugin();

    it('returns name "links"', () => {
      expect(plugin.name).toBe('links');
    });

    it('declares no init or destroy member (schema-only, same shape as the ethereum plugin)', () => {
      expect(plugin.init).toBeUndefined();
      expect(plugin.destroy).toBeUndefined();
    });

    it('declares exactly one setting: autoRunSharedLinks', () => {
      expect(plugin.settings).toHaveLength(1);
      expect(plugin.settings.map((s: any) => s.key)).toEqual(['autoRunSharedLinks']);
    });

    it('is a boolean field, defaulting to false — opt-in, never opt-out', () => {
      const def = plugin.settings[0];
      expect(def.type).toBe('boolean');
      expect(def.default).toBe(false);
    });

    it('describes the network cost in terms that hold even with no credentials configured', () => {
      const def = plugin.settings[0];
      expect(typeof def.description).toBe('string');
      // The keyless-registry cost (T-06-100) applies regardless of Etherscan/RPC credentials —
      // the description must not read as conditional on having configured them.
      expect(def.description.toLowerCase()).toContain('no credentials');
      expect(def.description.toLowerCase()).toMatch(/quota|registr/);
    });
  });
});
