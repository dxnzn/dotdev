# External Integrations

**Analysis Date:** 2026-08-19

## APIs & External Services

**Not Used**

No external APIs or third-party services are integrated. The application is entirely self-contained.

## Data Storage

**Databases:**
- None - Application is stateless
- No server-side persistence

**File Storage:**
- Local filesystem only
- Static assets served via HTTP

**Client-Side Persistence:**
- `localStorage` - Theme and mode settings
  - Key: `dxkit:theme`
  - Format: JSON object (`{ theme: 'zorgz-2625', mode: 'dark' }`)
  - Managed by: DxKit theme plugin

**Caching:**
- Browser HTTP cache (for static assets)
- No runtime caching service

## Authentication & Identity

**Auth Provider:**
- None
- No user authentication system
- Public, read-only application

**Wallet/Web3:**
- Wallet button present in shell header (`src/shell.ts`, line 105)
- Button currently disabled
- No active Web3/blockchain integration

## Monitoring & Observability

**Error Tracking:**
- None - No error tracking service configured

**Logs:**
- Browser console only
- No centralized logging

**Performance Monitoring:**
- None - No analytics or performance tracking

## CI/CD & Deployment

**Hosting:**
- GitHub Pages (`gh-pages` branch)
- Deployed via GitHub Actions workflow

**CI Pipeline:**
- GitHub Actions (`.github/workflows/deploy.yml`)
- Trigger: Push to main, pull requests against main
- Runs on: ubuntu-latest, Node.js 20
- Steps: Install → Lint (biome) → Test (vitest)

**Deployment Process:**
- Automatic on every push to `main` branch
- Makefile `deploy` target manages gh-pages worktree
- No manual approval required

## Environment Configuration

**Required env vars:**
- None - Application uses no environment variables

**Secrets location:**
- Not applicable - No secrets or credentials used

## Webhooks & Callbacks

**Incoming:**
- None

**Outgoing:**
- None

## Domain Features

**Compound Interest Calculator (CIC):**
- Pure client-side calculation engine (`src/dapps/cic/cic.ts`)
- No external data sources
- URL-based state sharing (query parameters)
- Share button copies `window.location.href` to clipboard

**Theme System:**
- DxKit theme plugin handles theme/mode switching
- localStorage persistence
- 3 themes: zorgz-2625 (cyan), zorgz-156 (red), zorgz-4065 (gray)
- Light/dark mode support

**Dapps (Pluggable Pages):**
- About page (`src/dapps/about/`)
- Projects showcase (`src/dapps/projects/`)
- Support page (`src/dapps/support/`)
- CIC tool (`src/dapps/cic/`)
- TPL tool optional (`src/dapps/tpl/`)
- All load content from static manifest + template files

## Asset Dependencies

**External CDNs:**
- None - All assets self-hosted

**Fonts:**
- System fonts only (no Google Fonts, Typekit, etc.)
- CSS fallback chain: IBM Plex Mono → Courier New → monospace

**Icons/Images:**
- Theme SVG assets: `src/assets/zorgz-*.svg`
- Self-hosted in repository

## Cross-Origin Requests (CORS)

**CORS Requirements:**
- Not applicable - Application makes no cross-origin HTTP requests
- No fetch calls to external domains detected

---

*Integration audit: 2026-08-19*
