---
phase: 04.2-pre-release-audit
verified: 2026-03-18T23:20:00Z
status: gaps_found
score: 15/30 PRA requirements have partial or full foundation
re_verification: false
gaps:
  - truth: "Schema startup is safe and versioned"
    status: failed
    reason: "No schema_version tracking, no PRAGMA integrity_check, no auto-backup"
    artifacts:
      - path: "apps/web/src/domains/tasks/persistence/store.ts"
        issue: "Migration block runs hasColumn checks on every startup without version gating"
    missing:
      - "PRA-23: schema_version column in app_settings"
      - "PRA-24: PRAGMA integrity_check on startup"
      - "PRA-25: Auto-backup to .data/backups/ on startup"
  - truth: "Bot handoff lifecycle is complete"
    status: partial
    reason: "Basic idle/proposed/accepted exists but lacks failure/timeout/override states and rate limiting"
    artifacts:
      - path: "apps/web/src/pages/api/tasks/[id]/accept-proposal.ts"
        issue: "Only handles accept/reject from proposed state"
      - path: "apps/web/src/domains/tasks/persistence/store.ts"
        issue: "handoff_state column only supports idle/proposed"
    missing:
      - "PRA-06: failed, timeout, human_override states + stale lock cleanup"
      - "PRA-08: Per-endpoint rate limiting for bot endpoints"
      - "PRA-05: Bot Review Queue page (/review)"
  - truth: "Offline mode provides useful experience"
    status: failed
    reason: "OfflineTask has only 5 fields (id, title, status, due_date, updated_at) — too thin for meaningful offline use"
    artifacts:
      - path: "apps/web/src/domains/offline/offline-store.ts"
        issue: "Missing priority, labels, project_id, task_kind, checklists, board_id, assigned_to"
    missing:
      - "PRA-03: Expand IDB schema to 14 fields, bump version to 3"
      - "PRA-09: Field-family merge strategy"
      - "PRA-10: Cursor pagination"
      - "PRA-11: Service Worker cache-first strategy"
      - "PRA-12: Tab-sync conflict prompt"
  - truth: "CSS transitions are performant"
    status: failed
    reason: "30 instances of transition: all across 15 files cause unnecessary GPU repaints"
    artifacts:
      - path: "apps/web/src/pages/kanban.astro"
        issue: "7 instances of transition: all"
      - path: "apps/web/src/components/settings/SettingsIntegrations.astro"
        issue: "4 instances of transition: all"
    missing:
      - "PRA-20: Replace all 30 instances with explicit property lists"
  - truth: "HA entities expose Meitheal data to automations"
    status: failed
    reason: "No HA entities registered — no sensors/binary_sensors exposed"
    missing:
      - "PRA-14: Register binary_sensor.meitheal_tasks_overdue, sensor.meitheal_active_tasks, sensor.meitheal_streak_days"
      - "PRA-15: LLM tools for hierarchy"
      - "PRA-16: Companion app detection"
  - truth: "n8n/MCP integration enables automation"
    status: failed
    reason: "Webhook emitter and MCP endpoint exist but n8n-specific triggers and core MCP tools not implemented"
    missing:
      - "PRA-17: task-created, task-completed, daily-summary webhook events"
      - "PRA-18: 5 MCP core tools with handoff protocol"
---

# Phase 04.2: Pre-Release Audit Verification Report

**Phase Goal:** Audit codebase readiness for pre-release and identify all gaps blocking publication quality
**Verified:** 2026-03-18T23:20:00Z
**Status:** gaps_found
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Quick capture kind exists | ❌ MISSING | No `quick_capture` kind in schema |
| 2 | Focus Stack on Today page | ❌ MISSING | No top-3 recommended task section |
| 3 | IDB schema is comprehensive | ❌ FAILED | Only 5 fields in OfflineTask |
| 4 | Kanban cards follow 3-line rule | ❌ MISSING | No max-height constraint |
| 5 | Bot Review Queue page exists | ❌ MISSING | No `/review` page |
| 6 | Handoff state machine is complete | ⚠️ PARTIAL | Missing failed/timeout/human_override |
| 7 | agent_scratchpad excluded from API | ✅ VERIFIED | `stripScratchpad()` in task-repository.ts L26-31 |
| 8 | Bot endpoints rate limited | ❌ MISSING | No per-endpoint limits |
| 9 | Field-family merge strategy | ❌ MISSING | LWW only in sync-engine.ts |
| 10 | IDB cursor pagination | ❌ MISSING | No getAllTasks(limit, offset) |
| 11 | Service Worker caching | ❌ MISSING | No cache-first strategy |
| 12 | Tab-sync conflict prompt | ❌ MISSING | No "modified elsewhere" prompt |
| 13 | WS reconnect with backoff | ✅ VERIFIED | ha-connection.ts: exponential backoff (L209), MAX_RECONNECT_DELAY_MS |
| 14 | HA entities registered | ❌ MISSING | No sensor/binary_sensor registration |
| 15 | Hierarchy LLM tools | ❌ MISSING | No list_areas/list_goals/move_task tools |
| 16 | Companion detection | ❌ MISSING | No detection logic |
| 17 | n8n webhook triggers | ❌ MISSING | No outbound event triggers |
| 18 | MCP core tools | ❌ MISSING | MCP endpoint exists but no CRUD tools |
| 19 | Skip-to-content link | ✅ VERIFIED | Layout.astro L448 + _utilities.css L11 |
| 20 | transition: all replaced | ❌ FAILED | 30 instances across 15 files |
| 21 | Mobile bottom tab bar | ❌ MISSING | No bottom nav component |
| 22 | Shadow token audit | ❌ MISSING | Hardcoded rgba() values remain |
| 23 | Schema version tracking | ❌ MISSING | No schema_version in app_settings |
| 24 | SQLite integrity check | ❌ MISSING | No PRAGMA integrity_check |
| 25 | Auto-backup on startup | ❌ MISSING | No backup mechanism |
| 26 | Event listener cleanup | ⚠️ PARTIAL | Settings controllers migrated, but kanban/table/modal still have raw listeners |
| 27 | Goal metrics columns | ❌ MISSING | No metric_type/target/current |
| 28 | Progress rings | ❌ MISSING | No SVG ring component |
| 29 | Weekly review endpoint | ❌ MISSING | No /api/review/weekly |
| 30 | Streak freeze | ❌ MISSING | No streak_freezes_used column |

**Score:** 3/30 truths fully verified, 2 partial

### Requirements Coverage

| Requirement | Status | Blocking Issue |
|-------------|--------|---------------|
| PRA-01 through PRA-30 | ❌ 27 not started, 2 partial, 1 verified | Phase 05.1–05.6 execution required |

### Anti-Patterns Found

| File | Pattern | Severity | Impact |
|------|---------|----------|--------|
| 15 files | `transition: all` (30 instances) | ⚠️ Warning | GPU jank on mobile |
| store.ts | No migration versioning | 🛑 Blocker | Startup latency, no skip path |
| offline-store.ts | 5-field OfflineTask | ⚠️ Warning | Degraded offline UX |
| accept-proposal.ts | No rate limiting | ⚠️ Warning | Bot abuse vector |

### Human Verification Required

| # | Test | Expected | Why Human |
|---|------|----------|-----------|
| 1 | Kanban card height on mobile | Cards ≤ 80px | Visual appearance |
| 2 | HA entity registration in Supervisor | Entities appear in HA Developer Tools | Tier 2 environment |
| 3 | Companion app detection | IDB features disabled in Companion | Requires real Companion app |
| 4 | Mobile bottom tab bar | Tab bar appears at < 768px | Device-specific layout |

### Gaps Summary

The pre-release audit identified **27 out of 30 requirements** as not started, with only `agent_scratchpad` isolation, WebSocket reconnect, and skip-to-content link already implemented. This is expected — the audit was designed to identify gaps, and the 6 roadmap phases (05.1–05.6) are the execution plan to close them.

**Critical path:** Phase 05.1 (Schema Hardening) is the foundation — schema_version, integrity_check, and auto-backup must ship before any other PRA work to protect data integrity.

---

_Verified: 2026-03-18T23:20:00Z_
_Verifier: Antigravity (gsd-verifier)_
