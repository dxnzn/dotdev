import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Reads the COMPILED src/plugins/ethereum.js and executes it against a fresh
// window-like global, then inspects the attached window.DnznEthereum namespace
// directly. This is the same compiled-JS execution pattern used by
// test/settings-render.test.ts — see the head comment there for why.
function loadCompiledEthereumPlugin() {
  const code = readFileSync(resolve(__dirname, '../src/plugins/ethereum.js'), 'utf-8');
  const fakeWindow: any = {};
  new Function('window', code)(fakeWindow);
  return fakeWindow.DnznEthereum;
}

describe('ethereum plugin', () => {
  const DnznEthereum = loadCompiledEthereumPlugin();

  it('defines createEthereumPlugin and CHAINS on window.DnznEthereum', () => {
    expect(DnznEthereum).toBeDefined();
    expect(typeof DnznEthereum.createEthereumPlugin).toBe('function');
    expect(Array.isArray(DnznEthereum.CHAINS)).toBe(true);
  });

  describe('createEthereumPlugin()', () => {
    const plugin = DnznEthereum.createEthereumPlugin();

    it('returns name "ethereum"', () => {
      expect(plugin.name).toBe('ethereum');
    });

    it('declares no init or destroy member', () => {
      expect(plugin.init).toBeUndefined();
      expect(plugin.destroy).toBeUndefined();
    });

    it('declares exactly four settings with the expected keys', () => {
      expect(plugin.settings).toHaveLength(4);
      expect(plugin.settings.map((s: any) => s.key)).toEqual(['etherscanApiKey', 'rpcUrl', 'chainId', 'etherscanRps']);
    });

    it('sets the documented defaults', () => {
      const byKey = Object.fromEntries(plugin.settings.map((s: any) => [s.key, s]));
      expect(byKey.etherscanApiKey.default).toBe('');
      expect(byKey.rpcUrl.default).toBe('');
      expect(byKey.chainId.default).toBe(1);
      expect(byKey.etherscanRps.default).toBe(5);
    });

    it('sets etherscanRps validation bounds to 1..5', () => {
      const byKey = Object.fromEntries(plugin.settings.map((s: any) => [s.key, s]));
      expect(byKey.etherscanRps.validation.min).toBe(1);
      expect(byKey.etherscanRps.validation.max).toBe(5);
    });

    it('marks no definition as required', () => {
      for (const def of plugin.settings) {
        expect(def.validation?.required).not.toBe(true);
      }
    });
  });

  describe('CHAINS', () => {
    it('has exactly two entries — mainnet and Sepolia — each with a non-empty explorer', () => {
      expect(DnznEthereum.CHAINS).toHaveLength(2);
      const chainIds = DnznEthereum.CHAINS.map((c: any) => c.chainId);
      expect(chainIds).toEqual([1, 11155111]);
      for (const chain of DnznEthereum.CHAINS) {
        expect(typeof chain.explorer).toBe('string');
        expect(chain.explorer.length).toBeGreaterThan(0);
      }
    });

    it('is the source of truth for chainId select options', () => {
      const plugin = DnznEthereum.createEthereumPlugin();
      const chainIdDef = plugin.settings.find((s: any) => s.key === 'chainId');
      expect(chainIdDef.options.map((o: any) => o.value)).toEqual(['1', '11155111']);
    });
  });
});
