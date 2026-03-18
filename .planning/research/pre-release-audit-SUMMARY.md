# Pre-Release Audit — Research Synthesis

**Synthesis Date:** 2026-03-18

## Executive Summary

Meitheal is approaching pre-release with a solid foundation: DDD monorepo with 5 domain packages, Astro 6 SSR, SQLite persistence via Drizzle ORM repos, 437+ passing tests, and deep HA integration via WebSocket. The 50-persona expert audit across ADHD/productivity, task management, life planning, HA integration, offline sync, bot orchestration, UX/design, security, gamification, and architecture identified 30 concrete requirements (PRA-01–PRA-30) to close before publication.

The codebase is architecturally sound but has specific infrastructure gaps that must be addressed before users trust it with real data: no auto-backup, no DB integrity checks, no schema versioning, a thin offline schema, and an incomplete bot handoff state machine. The HA integration has strong reconnect logic already, but lacks entity registration and Companion detection — both essential for the HA-native identity.

The recommended approach is a 6-phase sequential execution starting with Schema Hardening (the data safety net), then Bot Orchestration, Offline/PWA, HA Deep Integration, A11y/UX polish, and n8n/MCP connectivity.

## Key Findings

### From Codebase Mapping (STACK, ARCHITECTURE, STRUCTURE, CONVENTIONS)

- **Stack is mature:** Astro 6, TypeScript 5.9 strict, Playwright 1.58, Drizzle ORM — all actively maintained
- **DDD boundaries are clean:** 5 domain packages, 16 in-app domains, cross-context imports via public APIs
- **Memory safety established:** `managedListeners()`, `pageLifecycle.on()`, `AbortController` signals across settings controllers
- **Ingress patterns well-documented:** 3-layer normalization (serve.mjs → middleware → Layout.astro) with 4 E2E test suites covering HA behavior
- **CSS system uses partials:** 18 CSS partials with design tokens, but 30 `transition: all` anti-patterns remain

### From Concerns Mapping

- **Critical:** No auto-backup, no integrity check, no schema versioning — data is unprotected
- **High:** Thin IDB offline schema (5 fields), incomplete handoff state machine, no bot rate limiting
- **Medium:** 30 `transition: all` instances, oversized controllers (task-modal 2,484 LoC, kanban 2,025 LoC)
- **Low:** Dual schema source of truth (Drizzle vs store.ts), no standalone auth (by design)

### From Testing Analysis

- **437 tests pass** across 51 spec files (48 E2E + 2 governance + 1 unit)
- **Gap:** No unit tests for domain packages, no controller tests, no offline sync tests
- **Gap:** No coverage reporting configured

### From Integration Analysis

- **HA WebSocket:** Solid — reconnect with exponential backoff, event handling, service calls
- **HA Entities:** Missing — no sensors, no binary_sensors exposed to HA
- **n8n:** Webhook emitter exists but no outbound event triggers
- **MCP:** Endpoint exists (560 LoC) but no CRUD tool handlers

## Implications for Roadmap

### Phase Ordering Rationale

| Phase | Why This Order | Risk If Skipped |
|-------|---------------|-----------------|
| 05.1 Schema Hardening | Foundation — protects data before any schema changes | Data loss on migration failure |
| 05.2 Bot Orchestration | Depends on stable schema, unblocks review queue | Stuck proposals, no cleanup |
| 05.3 Offline/PWA | Depends on schema changes for expanded IDB fields | Thin offline = user frustration |
| 05.4 HA Deep Integration | Independent but validates entity registration | Not a "real" HA add-on without entities |
| 05.5 A11y/UX Polish | Visual improvements are safe to parallelize | WCAG compliance for publication |
| 05.6 n8n/MCP | External integration — lowest dependency | Missing automation hooks |

### Research Flags

- **Phase 05.1 (Schema):** Well-understood patterns — no research needed
- **Phase 05.3 (Offline):** Needs research — field-family merge patterns, IndexedDB migration strategies
- **Phase 05.4 (HA Entities):** Needs research — supervisor entity registration API, Companion WebView detection
- **Phase 05.6 (MCP):** Needs research — handoff protocol design for external agents

### Partially Implemented (Build On)

| PRA | What Exists | What's Missing |
|-----|-------------|---------------|
| PRA-07 | `stripScratchpad()` in TaskRepository | Verify 100% coverage across all SELECT paths |
| PRA-13 | Exponential backoff reconnect in ha-connection.ts | Sidebar status indicator, 30s heartbeat |
| PRA-19 | skip-to-content link in Layout.astro | Heading hierarchy audit, keyboard DnD alternative |
| PRA-26 | Settings controllers migrated to pageLifecycle | kanban, table, modal controllers still have raw listeners |

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Schema gaps | HIGH | Direct code scanning verified all claims |
| Bot handoff gaps | HIGH | accept-proposal.ts and store.ts inspected |
| Offline gaps | HIGH | offline-store.ts interface verified |
| HA entity gaps | HIGH | No entity registration code found |
| transition: all count | HIGH | grep returned exact file/line data |
| n8n/MCP gaps | MEDIUM | MCP endpoint exists, may have more tools than detected |
| A11y gaps | MEDIUM | skip-to-content found, but full WCAG audit requires runtime |

## Gaps to Address During Execution

1. **Test coverage:** Add unit tests for domain packages before schema changes
2. **Migration strategy:** Define schema_version values and migration ordering before Phase 05.1
3. **IDB migration:** Define upgrade path from IDB v2 → v3 without data loss
4. **Entity registration:** Research HA Supervisor entity registration API for Phase 05.4
5. **MCP handoff protocol:** Design claim → propose → await accept flow for external agents

---

*Research synthesis: 2026-03-18*
*Synthesized from: 50-persona audit, 7 codebase mapping docs, verification scan*
