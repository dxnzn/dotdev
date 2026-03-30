# DNZN // DEV

by **Denizen.** // dnzn.wei

## Dapps

| Route | Dapp | Description |
|-------|------|-------------|
| `/` | About | About, FAQS, etc |
| `/projects` | Projects | Projects we created and/or contribute to |
| `/support` | Support | Projects we support |
| `/tools/cic` | CIC | Compound Interest Calculator |
| `/tools/tpl` | TPL | Template tool (optional, disabled by default) |

## Development

```bash
make setup          # Install npm dependencies (tsup, typescript, serve)
make vendor         # Build DxKit and vendor IIFE + .d.ts files
make build          # Compile TypeScript → JavaScript via tsup
make serve          # Build + serve on localhost:3000
make watch          # Build in watch mode (recompile on change)
make dist           # Build + create versioned dist/dnzn.dev-YYYYMMDD.ITER/
make dist-history-stubs  # Same + generate index.html stubs for history-mode routing
make clean          # Remove dist/
```

## Architecture

- **IIFE script tags** — no bundler at runtime; DxKit loaded via `<script>` tags
- **Hash routing** — `#/about`, `#/tools/cic`, etc. Works on GitHub Pages and IPFS
- **Fetch-template pattern** — HTML in `.html` template files, JS wires behavior
- **TypeScript** — source in `.ts`, compiled to `.js` by tsup
- **DxKit vendored** — built from `../vendor/dxkit/`, copied to `src/vendor/dxkit/`
- **3 zorgs themes** — zorgz-2625 (cyan), zorgz-156 (red), zorgz-4065 (gray) × light/dark

## Build Versioning

`BUILD_VERSION` file tracks an auto-incrementing counter (starts at 1001). Each `make dist` or `make dist-history-stubs` bumps it. Dist folders are named `dnzn.dev-YYYYMMDD.ITER`.
