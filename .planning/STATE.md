---
gsd_state_version: 1.0
current_phase: 1
current_phase_name: Global Settings & Ethereum Credentials
status: planning
stopped_at: Phase 1 context gathered
last_updated: "2026-08-20T16:57:43.924Z"
last_activity: 2026-08-19
last_activity_desc: ROADMAP.md created, 75 v1 requirements mapped across 6 phases
state_head: 5d24317f28a0f5a04c5122615db07b35d1f97578
progress:
  total_phases: 6
  completed_phases: 0
  total_plans: 0
  completed_plans: 0
  percent: 0
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-08-19)

**Core value:** A person can paste nested ABI-encoded calldata and read what it actually does, all
the way down, in a browser that sends nothing to DNZN.
**Current focus:** Phase 1 — Global Settings & Ethereum Credentials

## Current Position

Phase: 1 of 6 (Global Settings & Ethereum Credentials)
Plan: 0 of TBD in current phase
Status: Ready to plan
Last activity: 2026-08-19 — ROADMAP.md created, 75 v1 requirements mapped across 6 phases

Progress: [░░░░░░░░░░] 0%

## Performance Metrics

**Velocity:**

- Total plans completed: 0
- Average duration: - min
- Total execution time: 0 hours

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| - | - | - | - |

**Recent Trend:**

- Last 5 plans: -
- Trend: -

*Updated after each plan completion*

## Accumulated Context

### Decisions

Full decision log lives in PROJECT.md Key Decisions. Load-bearing for this milestone:

- Ethereum credentials (`etherscanApiKey`, `rpcUrl`, `chainId`, `etherscanRps`) are **global**, owned
  by a new dotdev-local `ethereum` DxKit plugin — not the decode dapp's manifest `settings`

- Decode has no settings form of its own; it reads global settings and links to `/settings`
- "Standalone" is reframed as portability *between* DxKit shells (`requires.plugins: ['settings']`,
  `standalone: false`) — no `standalone.html`, no `LocalStorageSettingsAdapter`

- Wallet is connect + identity only in this milestone; no signing anywhere
- Creation-code awareness and the Majeur proposal-id annotator are v2, not v1

### Pending Todos

None yet.

### Blockers/Concerns

- DEC-16 caps the decode dapp at <60 KB uncompressed JS with all six first-wave decoders. keccak-256
  + the full ABI decoder + 6 decoders + log UI inside that budget is tight — track as a running total
  starting in Phase 3, confirmed against the full catalogue at the close of Phase 6.

- Phase 5 (single-call Ethereum decoding) depends on both Phase 1 (ethereum plugin credentials) and
  Phase 3 (decode framework) — do not start it until both have landed.

## Deferred Items

Items acknowledged and deferred at milestone close, most recent first:

| Category | Item | Status | Deferred At | Milestone |
|----------|------|--------|-------------|-----------|
| *(none)* | | | | |

## Session Continuity

Last session: 2026-08-20T16:57:43.912Z
Stopped at: Phase 1 context gathered
approval, then `/gsd-plan-phase 1`.
Resume file: .planning/phases/01-global-settings-ethereum-credentials/01-CONTEXT.md
</content>
