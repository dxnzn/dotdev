import { defineConfig } from 'tsup';

export default defineConfig({
  entry: [
    'src/main.ts',
    'src/shell.ts',
    'src/dapps/about/dapp.ts',
    'src/dapps/projects/dapp.ts',
    'src/dapps/support/dapp.ts',
    'src/dapps/tpl/dapp.ts',
    'src/dapps/cic/dapp.ts',
    'src/dapps/cic/cic.ts',
  ],
  // Transpile only — no bundling, no wrapping
  bundle: false,
  format: ['esm'],
  outDir: 'src',
  splitting: false,
  clean: false,
  platform: 'browser',
  target: 'es2022',
  // Output .js alongside .ts sources
  outExtension: () => ({ js: '.js' }),
});
