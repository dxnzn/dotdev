import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('main — shell configuration', () => {
  it('registers all five dapps with valid manifest paths', () => {
    const main = readFileSync(resolve(__dirname, '../src/main.ts'), 'utf-8');

    const manifestPaths = [...main.matchAll(/manifest:\s*'([^']+)'/g)].map((m) => m[1]);
    expect(manifestPaths).toEqual([
      'dapps/about/manifest.json',
      'dapps/projects/manifest.json',
      'dapps/support/manifest.json',
      'dapps/tpl/manifest.json',
      'dapps/cic/manifest.json',
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
});
