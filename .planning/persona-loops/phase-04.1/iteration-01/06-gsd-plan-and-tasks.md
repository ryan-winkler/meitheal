# GSD Plan & Tasks — Synthesized from 50-Persona Audit

**Phase:** 04.1 Human-Agent DDD Core
**Iteration:** 01

---

## Accepted Recommendations → Tasks

### Phase 04.1a: Schema Foundation

| # | Task | Source | GSD Command |
|---|------|--------|-------------|
| T1 | Create `areas` table (id, name, icon, color, position, created_at, updated_at) | #1 Platform Architect, #38 DB Schema Reviewer | `/gsd-execute-phase` |
| T2 | Create `goals` table (id, area_id FK, title, description, status, target_date, created_at, updated_at) | #1, #6 DDD Modeler, #38 | `/gsd-execute-phase` |
| T3 | Create `projects` table (id, goal_id FK, title, description, status, icon, color, position, created_at, updated_at) | #1, #38 | `/gsd-execute-phase` |
| T4 | Add `task_kind TEXT DEFAULT 'standard_action'` to tasks (coexists with task_type during transition) | #2 OSS Integrations, #5 Product Architect | `/gsd-execute-phase` |
| T5 | Add `project_id TEXT` FK to tasks | #29 Data Architect | `/gsd-execute-phase` |
| T6 | Create indexes: `goals(area_id)`, `goals(status)`, `projects(goal_id)`, `projects(status)`, `projects(goal_id, status)`, `tasks(project_id)`, `tasks(project_id, status)`, `tasks(task_kind)` | #29 | `/gsd-execute-phase` |
| T7 | Add `entity_type TEXT DEFAULT 'task'` to domain_events, alias `task_id` as `entity_id` | #30 Event Sourcing | `/gsd-execute-phase` |
| T8 | Auto-create default Area ("Uncategorized") in ensureSchema() | #17 Cognitive Load Reducer | `/gsd-execute-phase` |
| T9 | Rename `is_habit` → `is_routine`, `frequency` → `cadence` in task_templates. Add `streak_current`, `streak_best` | #19 Habit System Designer | `/gsd-execute-phase` |
| T10 | Migrate `task_type` values: epic→goals, story→goals/projects, task→standard_action in task_kind | #2, #7 Data Migration | `/gsd-execute-phase` |

### Phase 04.1b: Bot Orchestration Core

| # | Task | Source | GSD Command |
|---|------|--------|-------------|
| T11 | Add bot columns to tasks: `owner TEXT DEFAULT 'human'`, `lock_holder TEXT`, `lock_expires_at INTEGER`, `handoff_state TEXT DEFAULT 'idle'`, `proposal_json TEXT`, `proposal_hash TEXT`, `agent_scratchpad TEXT` | #21 Multi-Agent, #23 Handoff Designer, #4 Security | `/gsd-execute-phase` |
| T12 | Implement handoff state machine validation (9 valid transitions, reject invalid) | #28 State Machine Expert | `/gsd-execute-phase` |
| T13 | Add `proposal_hash` verification on accept API | #4 Security Engineer | `/gsd-execute-phase` |
| T14 | Enforce `actor = 'bot:<name>'` format in task_activity_log for bot mutations | #24 Audit Specialist | `/gsd-execute-phase` |
| T15 | Exclude `agent_scratchpad` from all SELECT queries and API responses | #23, #4 | `/gsd-execute-phase` |

### Phase 04.1c: Integration Translation

| # | Task | Source | GSD Command |
|---|------|--------|-------------|
| T16 | Update vikunja-compat to translate `task_kind` → `task_type` in responses | #9 API Compat, #33 API Contract Tester | `/gsd-execute-phase` |
| T17 | Update vikunja-compat to expose projects table via `/api/v1/projects` | #9 | `/gsd-execute-phase` |
| T18 | Update todo-bridge to only sync tasks (ignore goals/projects entities) | #9, #10 Offline Specialist | `/gsd-execute-phase` |
| T19 | Ensure offline-store.ts has no references to areas/goals/projects | #10 | `/gsd-execute-phase` |

### Documentation & Testing

| # | Task | Source | GSD Command |
|---|------|--------|-------------|
| T20 | Create `docs/decisions/ADR-007-hierarchy-model.md` | #13 Knowledge Coach | `/gsd-execute-phase` |
| T21 | Create schema validation test (ensureSchema → assert expected tables/columns) | #12 Execution Coach, #31 Test Architecture | `/gsd-execute-phase` |
| T22 | Create migration safety test (pre-migration seed → ensureSchema → assertions) | #32 Migration Test Engineer | `/gsd-execute-phase` |
| T23 | Create handoff state machine test (all valid/invalid transitions) | #28, #31 | `/gsd-execute-phase` |
| T24 | Extend vikunja-compat test with `task_kind` → `task_type` assertions | #33 API Contract Tester | `/gsd-execute-phase` |
| T25 | Create regression risk matrix document | #36 Regression Analyst | `/gsd-research-phase` |
| T26 | Define TypeScript discriminated unions for TaskKind, HandoffState, EntityType | #37 Type Safety Expert | `/gsd-execute-phase` |
| T27 | Create `scripts/validate-domain-language.mjs` (lint for deprecated terms) | #15 Automation Coach | `/gsd-execute-phase` |
| T28 | Update ROADMAP.md with sub-phases 04.1a, 04.1b, 04.1c | #14 Focus Optimizer | `/gsd-plan-phase` |
| T29 | Add bot settings to "Automation & AI" section (allow proposals, auto-accept, lock timeout) | #46 Settings Integration | `/gsd-execute-phase` |

### Accepted Design Constraints (No Implementation)

| # | Constraint | Source |
|---|-----------|--------|
| C1 | Today/Upcoming views show only tasks and routines, never goals/projects | #16 ADHD Task Design |
| C2 | Bot proposals never trigger push notifications during focus mode | #18 Context-Switching Guard |
| C3 | New elements use existing CSS custom properties only | #45 Dark Mode Designer |
| C4 | Backward compat: board_id stays, existing tasks get project_id=NULL | #39 Backward Compat |
| C5 | Index count on tasks table ≤ 25 | #40 Capacity Planning |
| C6 | Fresh installs look identical to current Meitheal | #48 Onboarding |

---

## Deferred Recommendations (Phase 04.2+ / Later)

| # | Item | Source | Trigger |
|---|------|--------|---------|
| D1 | Field-family merge for offline sync | #3 Reliability | After core schema stable |
| D2 | HA entity registration (sensors for goals, todo lists for projects) | #8 HA Integration | After schema + API stable |
| D3 | HA Assist voice intent mapping | #22 Conversational AI, #50 Voice UX | After MCP tools stable |
| D4 | n8n webhook endpoints for lifecycle events | #25 n8n Designer | After event model stable |
| D5 | MCP tool declarations for new model | #26 MCP Tool Designer | After schema stable |
| D6 | Bot rate limiter | #27 Trust & Safety | After core bot infra working |
| D7 | Performance benchmarks | #35 Performance | After schema implemented |
| D8 | Sidebar tree navigation | #11 Workflow Coach, #41 IA Specialist | Phase 04.2 (UI) |
| D9 | Bot micro-interactions (pulse, badges, confetti) | #42 Micro-Interaction | Phase 04.2 (UI) |
| D10 | Accessibility ARIA tree | #43 Accessibility | Phase 04.2 (UI) |
| D11 | Mobile breadcrumb drill-down | #44 Mobile UX | Phase 04.2 (UI) |
| D12 | Search hub extension for goals/projects | #47 Search Integration | Search polish phase |
| D13 | Onboarding progressive disclosure | #48 Onboarding | Phase 04.2 (UI) |
| D14 | HA dashboard cards (goal progress, daily summary, bot activity) | #49 HA Dashboard | Separate phase |
| D15 | Goal/project progress rings in sidebar | #20 Gamification | Phase 04.2 (UI) |
