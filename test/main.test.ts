import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('main — shell configuration', () => {
  it('registers all seven dapps with valid manifest paths', () => {
    const main = readFileSync(resolve(__dirname, '../src/main.ts'), 'utf-8');

    const manifestPaths = [...main.matchAll(/manifest:\s*'([^']+)'/g)].map((m) => m[1]);
    expect(manifestPaths).toEqual([
      'dapps/about/manifest.json',
      'dapps/projects/manifest.json',
      'dapps/support/manifest.json',
      'dapps/tpl/manifest.json',
      'dapps/cic/manifest.json',
      'dapps/decode/manifest.json',
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
    expect(main).toMatch(/storageKey:\s*`\$\{STORAGE_NS\}:wallet`/);
  });

  it('registers the ethereum plugin via DnznEthereum.createEthereumPlugin()', () => {
    const main = readFileSync(resolve(__dirname, '../src/main.ts'), 'utf-8');
    expect(main).toMatch(/ethereum:\s*DnznEthereum\.createEthereumPlugin\(\)/);
  });

  it('registers the wallet plugin with only the EIP-1193 provider (D-02)', () => {
    const main = readFileSync(resolve(__dirname, '../src/main.ts'), 'utf-8');
    expect(main).toMatch(/wallet:\s*DxWallet\.createWallet\(/);
    expect(main).toContain('DxWallet.createEIP1193Provider()');
  });

  it("clears the wallet plugin's persisted provider id before the shell is constructed", () => {
    const main = readFileSync(resolve(__dirname, '../src/main.ts'), 'utf-8');
    const clearAt = main.indexOf('removeItem');
    const createAt = main.indexOf('DxKit.createShell');
    expect(clearAt).toBeGreaterThan(-1);
    expect(createAt).toBeGreaterThan(-1);
    // BLOCKER-1: the plugin's restore path is awaited serially inside shell.init(), so the
    // clear is only load-bearing if it runs first.
    expect(clearAt).toBeLessThan(createAt);
  });

  // 02-09's one-way migration (T-02-45): a real Ethereum address sits in every returning
  // visitor's browser until this removal runs, so both removals must precede shell
  // construction and neither may be written as a literal that could drift from STORAGE_NS.
  it('also clears the retired wallet identity key before the shell is constructed, composed from STORAGE_NS', () => {
    const main = readFileSync(resolve(__dirname, '../src/main.ts'), 'utf-8');
    const createAt = main.indexOf('DxKit.createShell');
    // biome-ignore lint/suspicious/noTemplateCurlyInString: searching source text for the
    // literal template-literal syntax main.ts uses, not interpolating one here.
    const providerClearAt = main.indexOf('removeItem(`${STORAGE_NS}:wallet`)');
    // biome-ignore lint/suspicious/noTemplateCurlyInString: same — a literal to search for.
    const identityClearAt = main.indexOf('removeItem(`${STORAGE_NS}:wallet:identity`)');

    expect(providerClearAt).toBeGreaterThan(-1);
    expect(identityClearAt).toBeGreaterThan(-1);
    expect(providerClearAt).toBeLessThan(createAt);
    expect(identityClearAt).toBeLessThan(createAt);
  });

  it('declares plugins in the order settings, theme, ethereum, wallet', () => {
    const main = readFileSync(resolve(__dirname, '../src/main.ts'), 'utf-8');
    // A multi-line plugin value is safe here provided it closes at four-space indent
    // (`    }),`), as the theme and wallet entries do: the block regex is non-greedy and
    // terminates on the first newline followed by exactly two spaces and `},`, so only a
    // plugin value closing at two-space indent would truncate the capture. The key regex
    // sees four-space keys only, so a wrapped value's nested keys stay invisible to it.
    const pluginsBlock = main.match(/plugins:\s*\{([\s\S]*?)\n {2}\},/)?.[1];
    expect(pluginsBlock).toBeDefined();
    const keys = [...pluginsBlock!.matchAll(/^\s{4}(\w+):/gm)].map((m) => m[1]);
    expect(keys).toEqual(['settings', 'theme', 'ethereum', 'wallet']);
  });

  // SHARE-04 deviation (see .planning/quick/260905-ac3.../SUMMARY.md): decode cannot itself
  // reach window.DnznShareTarget — DEC-14's portability guard forbids any `Dnzn*`-prefixed
  // identifier in src/dapps/decode/ — so this wiring lives here instead. test/decode-url.test.ts
  // proves the CONTRACT (pressPlainShare/revealShareFailure via a real share-target.js) works;
  // these are source-string assertions that the wiring itself exists and is correctly scoped.
  it('registers a decode share-target builder on dx:mount and releases it on dx:unmount', () => {
    const main = readFileSync(resolve(__dirname, '../src/main.ts'), 'utf-8');
    expect(main).toMatch(/addEventListener\(\s*'dx:mount'/);
    expect(main).toMatch(/addEventListener\(\s*'dx:unmount'/);
    expect(main).toContain("e.detail.id !== 'decode'");
    expect(main).toContain('DnznShareTarget?.register(');
    expect(main).toContain('releaseDecodeShareTarget?.()');
  });

  it("reaches decode's plain share link only through its own exposed hooks, never a literal URL", () => {
    const main = readFileSync(resolve(__dirname, '../src/main.ts'), 'utf-8');
    expect(main).toContain('DxDecode?.activeUi?.pressPlainShare()');
    expect(main).toContain('DxDecode?.activeUi?.revealShareFailure(url)');
  });
});
