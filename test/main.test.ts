import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('main — shell configuration', () => {
  it('registers all six dapps with valid manifest paths', () => {
    const main = readFileSync(resolve(__dirname, '../src/main.ts'), 'utf-8');

    const manifestPaths = [...main.matchAll(/manifest:\s*'([^']+)'/g)].map((m) => m[1]);
    expect(manifestPaths).toEqual([
      'dapps/about/manifest.json',
      'dapps/projects/manifest.json',
      'dapps/support/manifest.json',
      'dapps/tpl/manifest.json',
      'dapps/cic/manifest.json',
      'dapps/settings/manifest.json',
    ]);
  });

  it('uses hash routing mode', () => {
    const main = readFileSync(resolve(__dirname, '../src/main.ts'), 'utf-8');
    expect(main).toContain("mode: 'hash'");
  });

  it('configures theme with three zorgz themes', () => {
    const main = readFileSync(resolve(__dirname, '../src/main.ts'), 'utf-8');
    const themes = main.match(/themes:\s*\[([^\]]+)\]/)?.[1];
    expect(themes).toBeDefined();
    const themeNames = themes!.match(/'([^']+)'/g)!.map((t) => t.replace(/'/g, ''));
    expect(themeNames).toHaveLength(3);
    expect(themeNames.every((t) => t.startsWith('zorgz-'))).toBe(true);
  });

  it('composes every plugin storage key from a single STORAGE_NS const', () => {
    const main = readFileSync(resolve(__dirname, '../src/main.ts'), 'utf-8');
    expect(main).toMatch(/STORAGE_NS\s*=\s*'dnzn:dotdev'/);
    expect(main).toMatch(/storageKey:\s*`\$\{STORAGE_NS\}:theme`/);
    expect(main).toMatch(/storageKey:\s*`\$\{STORAGE_NS\}:settings`/);
  });

  it('registers the ethereum plugin via DnznEthereum.createEthereumPlugin()', () => {
    const main = readFileSync(resolve(__dirname, '../src/main.ts'), 'utf-8');
    expect(main).toMatch(/ethereum:\s*DnznEthereum\.createEthereumPlugin\(\)/);
  });

  it('declares plugins in the order settings, theme, ethereum', () => {
    const main = readFileSync(resolve(__dirname, '../src/main.ts'), 'utf-8');
    const pluginsBlock = main.match(/plugins:\s*\{([\s\S]*?)\n {2}\},/)?.[1];
    expect(pluginsBlock).toBeDefined();
    const keys = [...pluginsBlock!.matchAll(/^\s{4}(\w+):/gm)].map((m) => m[1]);
    expect(keys).toEqual(['settings', 'theme', 'ethereum']);
  });
});
