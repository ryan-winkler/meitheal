# Panel 4: Testing & Verification Experts — Human-Agent DDD Core

**Objective:** How do we verify the new hierarchy, bot orchestration, and integration translation are correct?

---

## 31. Test Architecture Specialist

**Focus:** What test strategy covers the new domain model?

**Recommendation:** Create a 3-tier test strategy for Phase 04.1:
1. **Unit tests** (domain-tasks package): goal/project CRUD, task_kind validation, handoff state machine transitions — pure logic, no DB
2. **Integration tests** (tests/e2e): schema validation, CRUD API for goals/projects, handoff flow (claim→propose→accept), vikunja-compat translation
3. **E2E browser tests** (deferred to Phase 04.2): navigation tree, breadcrumbs, project-scoped boards

The test infrastructure already uses temp SQLite (`file:${tmpdir}/...`) — extend for new tables. Tests import domain logic directly from workspace packages.

- **Impact:** 5 — no tests = no confidence in migration correctness
- **Effort:** 3 — ~10 new test files across unit and integration
- **Risk:** 1 — tests are safe

**Success Criterion:** `pnpm --filter @meitheal/tests test` includes tests for goals, projects, task_kind, handoff state machine.

**Decision:** ✅ Accept

---

## 32. Migration Test Engineer *(Custom)*

**Focus:** How do we test data migration safety?

**Recommendation:** Create a migration test that:
1. Seeds a temp DB with the pre-migration schema (tasks with `task_type='epic'`, `task_type='story'`)
2. Runs `ensureSchema()` which should auto-migrate
3. Asserts: no `task_type` column exists, `task_kind` has correct values, goals/projects tables are populated from former epics/stories, parent_id references are preserved

This is the highest-priority test for the entire project.

- **Impact:** 5 — migration bugs = data loss in production
- **Effort:** 3 — 1 test file, ~100 lines, but complex assertions
- **Risk:** 1 — test-only

**Success Criterion:** Test creates a pre-migration DB, runs schema bootstrap, and verifies all data is correctly migrated.

**Decision:** ✅ Accept

---

## 33. API Contract Tester *(Custom)*

**Focus:** How do we verify backward compatibility?

**Recommendation:** The existing `vikunja-compat.spec.ts` and `vikunja-compat-auth.spec.ts` tests must continue passing after the migration. The compat layer should translate the new model back to Vikunja v1 format. Add new assertions:
- `GET /api/v1/tasks/:id` returns `task_type` (not `task_kind`) for backward compat
- `GET /api/v1/projects` returns projects (new table) mapped to Vikunja project format
- `POST /api/v1/tasks` accepts both `task_type` (legacy) and `task_kind` (new) fields

- **Impact:** 4 — breaking Vikunja compat blocks HA voice assistant integration
- **Effort:** 2 — extend existing test files
- **Risk:** 2 — compat layer changes could regress

**Success Criterion:** All existing Vikunja compat tests pass. New tests cover `task_kind` → `task_type` translation.

**Decision:** ✅ Accept

---

## 34. Offline Sync Tester *(Custom)*

**Focus:** How do we verify offline sync with the new model?

**Recommendation:** Add a sync-engine test that verifies:
1. Task created offline with `project_id: null` syncs correctly
2. Server assigns `project_id` based on board context on sync
3. Field-family merge (when implemented) handles independent edits correctly
4. Bot-locked tasks are skipped during offline sync (don't overwrite bot work)

For now, test the simple case: tasks without project_id sync as before.

- **Impact:** 3 — offline is a key feature for PWA
- **Effort:** 2 — extend existing sync tests
- **Risk:** 1 — test-only

**Success Criterion:** Offline-created task syncs and gets a `project_id` from the server.

**Decision:** ✅ Accept

---

## 35. Performance Test Engineer *(Custom)*

**Focus:** Does the new model introduce query performance degradation?

**Recommendation:** Benchmark the core queries before and after adding the new tables and indexes:
1. Kanban board query (`SELECT * FROM tasks WHERE board_id = ? AND status = ?`)
2. Smart Today query (overdue + due today + routines)
3. Project task list query (`SELECT * FROM tasks WHERE project_id = ?`)
4. Goal progress query (join goals → projects → tasks, count by status)

Use `EXPLAIN QUERY PLAN` to verify index usage. For a DB with 10,000 tasks, 100 projects, 20 goals, and 5 areas, all queries should complete in < 50ms.

- **Impact:** 3 — performance regression would be visible to users
- **Effort:** 2 — benchmark script, ~50 lines
- **Risk:** 1 — read-only

**Success Criterion:** All core queries use indexes. No full table scans on `tasks` table.

**Decision:** ⏸️ Defer — write benchmark after schema is implemented.

---

## 36. Regression Safety Analyst *(Custom)*

**Focus:** What could break in the existing system?

**Recommendation:** Create a regression risk matrix before execution:

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| `task_type` column removed before all code migrated | 5 | 3 | Grep for `task_type` references before dropping column |
| `board_id` → `project_id` mismatch | 4 | 2 | Keep both columns during transition, map lazily |
| Vikunja compat API returns wrong fields | 4 | 3 | Run full compat test suite after each change |
| HA todo sync creates duplicates | 3 | 2 | Todo bridge only syncs tasks, ignore goals/projects |
| Index bloat from new indexes | 2 | 2 | Use composite indexes where possible |

This matrix should live in the research artifacts and guide execution order.

- **Impact:** 3 — risk awareness, not risk elimination
- **Effort:** 1 — documentation
- **Risk:** 1 — no code changes

**Success Criterion:** Regression risk matrix exists in research artifacts, referenced by the execution plan.

**Decision:** ✅ Accept

---

## 37. TypeScript Type Safety Expert *(Custom)*

**Focus:** How do we enforce type safety for the new model?

**Recommendation:** Define discriminated union types for the domain model in `domain-tasks` package:

```typescript
type TaskKind = 'standard_action' | 'shopping_item' | 'checklist' | 'routine_instance'
type HandoffState = 'idle' | 'claimed' | 'proposed' | 'accepted' | 'rejected'
type EntityType = 'task' | 'goal' | 'project'

interface Goal { id: string; areaId: string; title: string; status: GoalStatus; ... }
interface Project { id: string; goalId: string | null; title: string; status: ProjectStatus; ... }
```

All API handlers must use these types — no `string` for `task_kind` or `handoff_state`. Add runtime validation at the API boundary using a simple validator function (no external validation library).

- **Impact:** 4 — type safety prevents entire classes of bugs
- **Effort:** 2 — type definitions + validation helpers
- **Risk:** 1 — type-only, no runtime behavior changes

**Success Criterion:** `pnpm check` passes with zero type errors. No `as string` casts on task_kind or handoff_state fields.

**Decision:** ✅ Accept

---

## 38. Database Schema Reviewer *(Custom)*

**Focus:** Is the schema well-normalized and future-proof?

**Recommendation:** The 3 new tables should follow this schema:

```sql
-- Areas: classification (not aggregate root)
CREATE TABLE areas (id TEXT PK, name TEXT NOT NULL, icon TEXT DEFAULT '📁', color TEXT DEFAULT '#6366F1', position INTEGER DEFAULT 0, created_at INTEGER, updated_at INTEGER)

-- Goals: aggregate root
CREATE TABLE goals (id TEXT PK, area_id TEXT REFERENCES areas(id), title TEXT NOT NULL, description TEXT, status TEXT DEFAULT 'active', target_date TEXT, created_at INTEGER, updated_at INTEGER)

-- Projects: aggregate root  
CREATE TABLE projects (id TEXT PK, goal_id TEXT REFERENCES goals(id), title TEXT NOT NULL, description TEXT, status TEXT DEFAULT 'active', icon TEXT DEFAULT '📋', color TEXT DEFAULT '#6366F1', position INTEGER DEFAULT 0, created_at INTEGER, updated_at INTEGER)
```

Tasks get: `project_id TEXT REFERENCES projects(id)`, `task_kind TEXT DEFAULT 'standard_action'`.
Bot fields: `owner TEXT DEFAULT 'human'`, `lock_holder TEXT`, `lock_expires_at INTEGER`, `handoff_state TEXT DEFAULT 'idle'`, `proposal_json TEXT`, `proposal_hash TEXT`, `agent_scratchpad TEXT`.

- **Impact:** 5 — schema is the foundation; wrong schema = wrong product
- **Effort:** 1 — schema design, not implementation
- **Risk:** 1 — design artifact

**Success Criterion:** Schema document reviewed and approved before execution.

**Decision:** ✅ Accept

---

## 39. Backward Compatibility Guardian *(Custom)*

**Focus:** What must NOT change for existing users?

**Recommendation:** Preserve these invariants during migration:
1. `board_id` column stays — projects initially map 1:1 to boards
2. Existing tasks without a project get `project_id = NULL` (not force-assigned)
3. All kanban views work unchanged — `board_id` is still the query key
4. Settings page works unchanged — no new settings required
5. Today/Upcoming views work unchanged — they query tasks, not goals/projects
6. API endpoints `/api/tasks/*` response shape unchanged — new fields are additive

- **Impact:** 5 — breaking existing functionality is unacceptable
- **Effort:** 1 — defining constraints, not building features
- **Risk:** 1 — constraint documentation

**Success Criterion:** All existing E2E tests pass after Phase 04.1 execution.

**Decision:** ✅ Accept

---

## 40. Capacity Planning Analyst *(Custom)*

**Focus:** How much data volume can the new model handle?

**Recommendation:** Design for these capacity targets on a Home Assistant add-on (Raspberry Pi 4 minimum hardware):
- 10,000 tasks, 500 projects, 50 goals, 10 areas
- Write throughput: 50 task creates/minute (batch import scenario)
- Read throughput: 10 concurrent board queries (multi-user HA household)
- SQLite WAL mode handles this fine — no Postgres needed
- Indexes must be precise; avoid over-indexing (each index adds write overhead)

The current schema has ~20 indexes on the tasks table. Adding 3 more (project_id, task_kind, project_id+status) is acceptable. Beyond that, evaluate if existing indexes can be consolidated.

- **Impact:** 2 — RPi4 capacity is not a current blocker
- **Effort:** 1 — analysis only
- **Risk:** 1 — no changes

**Success Criterion:** `PRAGMA index_list(tasks)` shows ≤ 25 indexes.

**Decision:** ✅ Accept
