# Panel 1: Frontier Experts — Human-Agent DDD Core

**Objective:** Replace Epic→Story→Task with Area→Goal→Project→Task→Routine, add bot-safe orchestration primitives, and define offline-safe merge + compatibility translation.

---

## 1. Platform Architect

**Focus:** Are the new bounded contexts clean? Will the schema scale?

**Recommendation:** Introduce `areas`, `goals`, and `projects` as **separate SQLite tables** — NOT as `task_type` values crammed into the existing `tasks` table. Use FK relationships (`project.goal_id`, `task.project_id`) and keep `tasks` as the atomic unit. Do NOT add `area_id` to tasks — let Area→Goal→Project be a navigation hierarchy, and tasks belong to projects only.

- **Impact:** 5 — prevents Jira-fication where every concept becomes a task row with a type label
- **Effort:** 4 — 3 new tables, FK indexes, migration for existing `endeavor_id` column
- **Risk:** 3 — touches schema bootstrap but existing data doesn't need migration (new tables start empty)

**Success Criterion:** `pragma table_info(areas)`, `pragma table_info(goals)`, `pragma table_info(projects)` each return well-typed columns. No `task_type` values of `area`, `goal`, or `project` exist in the tasks table.

**Decision:** ✅ Accept

---

## 2. OSS Integrations Specialist

**Focus:** Are we reinventing something that exists? Ecosystem alignment?

**Recommendation:** For `task_kind` (standard_action, shopping_item, checklist), adopt a discriminated-union approach in TypeScript but store as a simple TEXT column in SQLite. Do NOT create a separate `task_kinds` lookup table — the set is intentionally small and code-enforced. Map the existing `task_type` values (`task`, `story`, `epic`) to the new `task_kind` column with a one-time migration: `epic` → delete or convert to projects, `story` → delete or convert to goals, `task` → `standard_action`.

- **Impact:** 4 — eliminates confusion between hierarchy level and behavioral kind
- **Effort:** 3 — one ALTER TABLE + one UPDATE + TypeScript union type
- **Risk:** 3 — needs careful consideration of what happens to existing `task_type='epic'` and `task_type='story'` rows

**Success Criterion:** `SELECT DISTINCT task_kind FROM tasks` returns only `standard_action | shopping_item | checklist | habit`. No rows have `task_type` of `epic` or `story`.

**Decision:** ✅ Accept

---

## 3. Reliability Engineer

**Focus:** Can we detect and recover from failures in the new hierarchy?

**Recommendation:** Replace the sync engine's whole-row last-write-wins (LWW) with **field-family merge**. Define 3 conflict-resolution families: (1) `user_content` — title, description, checklists → LWW by `updated_at`, (2) `system_state` — status, calendar_sync_state → state-machine rules (complete > active > pending), (3) `bot_fields` — owner, lock_holder, proposal_json → server-authoritative (bot mutations always accepted when lock held). This prevents the bot overwriting user title edits and vice versa.

- **Impact:** 5 — currently a user editing a title while offline will silently lose changes if the server has a newer `updated_at`
- **Effort:** 4 — requires refactoring `sync-engine.ts` conflict handler and `todo-bridge.ts` merge logic
- **Risk:** 4 — field-family merge is more complex than LWW; needs thorough test coverage

**Success Criterion:** A test scenario where user edits title offline while bot updates status server-side → both changes survive after sync. Currently this fails (server wins all fields).

**Decision:** ⏸️ Defer — high impact but also high effort. Define the field families now in the domain model; implement the merge in a later execution phase.

---

## 4. Security Engineer

**Focus:** What attack surfaces does bot orchestration expose?

**Recommendation:** Bot handoff must use a **hash-verified proposal model**: the bot writes a `proposal_json` field with a SHA-256 content hash. When a human accepts, the API verifies the content hash matches before applying. This prevents TOCTOU (time-of-check-time-of-use) attacks where a malicious bot could swap proposal content between preview and accept. The `agent_scratchpad` field must be **ephemeral** (TTL-based cleanup) and never exposed via the Vikunja-compat API or MCP.

- **Impact:** 4 — bot proposals are a new trust boundary
- **Effort:** 2 — add `proposal_hash` TEXT column, compute SHA-256 on write, verify on accept
- **Risk:** 2 — isolated to the proposal acceptance path

**Success Criterion:** `POST /api/tasks/:id/accept-proposal` rejects with 409 if the stored hash doesn't match the proposal content. Agent scratchpad never appears in `GET /api/v1/tasks/:id` (Vikunja compat).

**Decision:** ✅ Accept

---

## 5. Product Architect

**Focus:** Does the naming and structure match the domain? Ubiquitous language?

**Recommendation:** Enforce the ubiquitous language in the codebase:
- `Area` = domain of life (not "category" or "tag")
- `Goal` = outcome you're pursuing (not "objective" or "milestone")
- `Project` = time-bounded container of tasks toward a goal (not "board" or "list")
- `Task` = atomic action item (not "item" or "todo")
- `Routine` = recurring task template with streak tracking (not "habit" — rename `is_habit` to `is_routine` in `task_templates`)
- `task_kind` = behavioral variant (not `task_type` which was a hierarchy role)

Rename `task_type` column to `task_kind` with migration. Update all UI strings, API responses, and docs.

- **Impact:** 5 — the whole point of the project is to establish clear domain language
- **Effort:** 3 — column rename + find-and-replace across codebase
- **Risk:** 3 — Vikunja compat API must translate back to `task_type` for external consumers

**Success Criterion:** `grep -r "task_type" apps/web/src/` returns zero hits outside of vikunja-compat translation layer. `grep -r "habit" apps/web/src/` returns zero hits outside of template migration comments.

**Decision:** ✅ Accept

---

## 6. DDD Domain Modeler *(Custom)*

**Focus:** Aggregate root boundaries and event contracts

**Recommendation:** Make `Goal` and `Project` aggregate roots with their own domain events:
- `goal.created`, `goal.archived`, `goal.progress_updated`
- `project.created`, `project.status_changed`, `project.completed`
- Tasks emit `task.linked_to_project`, `task.unlinked_from_project`

Do NOT make `Area` an aggregate root — it's a classification tag, not an entity with lifecycle events. Store it as a table with `id`, `name`, `icon`, `color`, `position` but don't emit events for area changes.

- **Impact:** 4 — clear aggregate root boundaries prevent god-object anti-patterns
- **Effort:** 3 — extend `domain_events` table with new event types, add domain functions
- **Risk:** 2 — additive changes, existing events untouched

**Success Criterion:** `SELECT DISTINCT event_type FROM domain_events` includes `goal.*` and `project.*` event types after creating a goal and project.

**Decision:** ✅ Accept

---

## 7. Data Migration Specialist *(Custom)*

**Focus:** How do we migrate existing data without breaking production?

**Recommendation:** Use the existing `ensureSchema()` pattern of idempotent `hasColumn()` checks + `ALTER TABLE`. Migration steps:
1. Add `task_kind TEXT DEFAULT 'standard_action'` (coexists with `task_type` temporarily)
2. Create `areas`, `goals`, `projects` tables
3. Migrate existing `task_type='epic'` rows → create corresponding `goals` rows, then update `tasks.project_id` for children
4. Drop `task_type` column by creating `tasks_v2` and copying (SQLite doesn't support DROP COLUMN in all versions)
5. Rename `is_habit` → `is_routine` in `task_templates`

All steps must be idempotent so re-running `ensureSchema()` is safe.

- **Impact:** 5 — data migration is the riskiest part of the entire project
- **Effort:** 5 — multi-step migration touching the core table
- **Risk:** 5 — data loss if migration is wrong

**Success Criterion:** Run `ensureSchema()` 3 times consecutively — no errors, no duplicate data, no schema drift.

**Decision:** ⏸️ Defer — plan now, execute after discuss-phase approval. The migration order is critical and needs a dedicated execution phase.

---

## 8. Home Assistant Integration Expert *(Custom)*

**Focus:** How do new concepts map to HA entities?

**Recommendation:** Map the new hierarchy to HA natively:
- `Area` → HA Area (or a custom entity attribute, NOT a separate entity)
- `Goal` → Exposed as a `sensor` entity (`sensor.meitheal_goal_<id>`) with progress % as state
- `Project` → Exposed as a `todo` list entity (`todo.meitheal_project_<id>`) where tasks are the items
- `Routine` → Exposed as a `binary_sensor` entity for streak tracking (on/off for "completed today")
- `Task` → Remains in the existing `todo` list entity

This means each Meitheal project becomes a separate HA todo list, enabling per-project voice commands: "Hey Google, add milk to my shopping project."

- **Impact:** 5 — native HA entity exposure is the killer feature that differentiates from Vikunja/Todoist
- **Effort:** 4 — requires HA entity registration via Supervisor API
- **Risk:** 3 — entity registration has specific requirements per HA docs

**Success Criterion:** `hassio.supervisor.api/addons/.../info` reports the new entities. HA can show project completion progress on a dashboard card.

**Decision:** ⏸️ Defer — design now, validate entity registration approach in research phase, implement after core schema is stable.

---

## 9. API Compatibility Specialist *(Custom)*

**Focus:** How do Vikunja, Trello, and MCP consumers see the new hierarchy?

**Recommendation:** Translate the new model into each consumer's language at the edge, never in the core:
- **Vikunja compat:** `area` → ignored (Vikunja has no concept), `goal` → `project` (Vikunja v1), `project` → `project` (Vikunja v1), `task_kind` → mapped back to `task_type` for response body
- **MCP/LLM API:** Full access to the new model — areas, goals, projects, task_kind, bot handoff primitives
- **HA todo bridge:** Only syncs `tasks` (not goals/projects) via the existing todo entity

Create a `TranslationLayer` interface in `integration-core` with `toVikunja()`, `toMCP()`, `toHATodo()` methods.

- **Impact:** 4 — prevents breaking existing integrations while enabling new ones
- **Effort:** 3 — adapter pattern is well-understood, vikunja-compat already exists to extend
- **Risk:** 2 — pure mapping layer, no data transformation

**Success Criterion:** Existing Vikunja API tests pass unchanged. New MCP tool calls can create goals and projects. HA todo sync only touches tasks.

**Decision:** ✅ Accept

---

## 10. Offline/PWA Specialist *(Custom)*

**Focus:** How do new entities work in offline mode?

**Recommendation:** Do NOT add goals, projects, or areas to the IndexedDB offline store initially. They are server-side planning constructs. Offline mode should only cache `tasks` (the atomic action items users interact with on-the-go). If a user creates a task offline, the `project_id` field should be nullable — the server assigns it post-sync based on board context.

- **Impact:** 3 — keeps offline complexity bounded
- **Effort:** 1 — literally don't build it
- **Risk:** 1 — no risk in not doing something

**Success Criterion:** `offline-store.ts` has no references to `areas`, `goals`, or `projects`. Tasks created offline have `project_id: null` until synced.

**Decision:** ✅ Accept
