# Panel 2: ADHD/Productivity Specialists — Human-Agent DDD Core

**Objective:** Reduce cognitive load and improve execution velocity for the new hierarchy model.

---

## 11. Workflow Coach

**Focus:** Can someone orient themselves in the new hierarchy in < 2 minutes?

**Recommendation:** The sidebar navigation should show **Area → Goal → Project → Board** as a tree. When a user clicks a Project, they see the board (kanban/table/today) scoped to that project's tasks. The critical UX insight: **don't make the user think about which level they're on.** The URL should be human-readable: `/project/grocery-shopping` not `/tasks?project_id=abc123`. The breadcrumb should always show `Area > Goal > Project > View`.

- **Impact:** 5 — the entire UX hinges on navigation clarity
- **Effort:** 4 — sidebar tree, breadcrumb component, URL routing
- **Risk:** 3 — ingress rewriting must handle nested paths

**Success Criterion:** A new user can navigate from the dashboard to a specific project's kanban board in ≤ 3 clicks. Breadcrumb shows full path.

**Decision:** ⏸️ Defer — design now, implement in the UI phase after schema is stable.

---

## 12. Execution Coach

**Focus:** Are standards enforced automatically, not manually?

**Recommendation:** Add a **schema validation test** that runs in CI: it loads `ensureSchema()` against an in-memory SQLite, then asserts the expected tables exist with the correct columns. This catches schema drift before deployment. Currently there's no test that validates the schema bootstrap produces the expected structure.

- **Impact:** 4 — prevents "works on my machine" schema issues
- **Effort:** 2 — one test file, ~50 lines
- **Risk:** 1 — read-only test, no side effects

**Success Criterion:** `pnpm --filter @meitheal/tests test schema-validation.spec.ts` passes and fails correctly when a column is removed.

**Decision:** ✅ Accept

---

## 13. Knowledge Coach

**Focus:** Can future-me understand the new model without asking?

**Recommendation:** Create `docs/decisions/ADR-007-hierarchy-model.md` documenting:
- Why Area/Goal/Project replaces Epic/Story
- Why `task_kind` replaces `task_type`
- The 3-tiered model (navigation hierarchy, aggregate roots, atomic units)
- What is NOT modeled (no areas in offline, no chain-of-thought in DB)
- Ubiquitous language glossary

Without this ADR, the next person (or future-Ryan) will wonder why `task_type` disappeared and what `task_kind` means.

- **Impact:** 4 — critical for KCS compliance and onboarding
- **Effort:** 1 — pure documentation, ~100 lines
- **Risk:** 1 — no code changes

**Success Criterion:** `docs/decisions/ADR-007-hierarchy-model.md` exists against the template format, linked from AGENTS.md.

**Decision:** ✅ Accept

---

## 14. Focus Optimizer

**Focus:** Is this iteration doing ONE thing well?

**Recommendation:** Phase 04.1 must be split into **3 clear sub-phases**:
1. **04.1a: Schema Foundation** — new tables (areas, goals, projects), `task_kind` column, column rename. No UI changes.
2. **04.1b: Bot Orchestration Core** — owner, lock, proposal, scratchpad columns on tasks. Handoff state machine. No UI changes.
3. **04.1c: Integration Translation** — update vikunja-compat, todo-bridge, MCP to handle new model. No UI changes.

UI changes should be a separate phase (04.2). Mixing schema, bot logic, integration translation, AND UI in one phase guarantees scope creep and context-switching thrash.

- **Impact:** 5 — prevents ADHD-hostile scope creep
- **Effort:** 1 — just phase structure, no code
- **Risk:** 1 — organizational, no risk

**Success Criterion:** ROADMAP.md shows 04.1a, 04.1b, 04.1c as separate sub-phases with distinct success criteria.

**Decision:** ✅ Accept

---

## 15. Automation Coach

**Focus:** What manual step can be eliminated?

**Recommendation:** Create a `scripts/validate-domain-language.mjs` script that greps the codebase for deprecated terms (`task_type`, `epic`, `story`, `habit` outside of migration contexts) and fails if found. Run it in CI. This enforces the ubiquitous language without relying on PR reviews to catch regressions.

- **Impact:** 3 — catches language drift automatically
- **Effort:** 2 — ~30 line script
- **Risk:** 1 — read-only linting

**Success Criterion:** `node scripts/validate-domain-language.mjs` exits 0 on a clean codebase and exits 1 when a deprecated term is introduced.

**Decision:** ✅ Accept

---

## 16. ADHD Task Design Expert *(Custom)*

**Focus:** How does the new model reduce daily cognitive load for ADHD users?

**Recommendation:** The today/upcoming views must **never show goals or projects** — only tasks and routines. Goals and projects are planning constructs; they should only appear in the sidebar tree and dedicated planning views. The ADHD brain needs a flat, actionable list for daily execution. Mixing planning-level items with action items causes decision paralysis.

Smart Today algorithm should pull from: (1) overdue tasks from any project, (2) tasks due today, (3) routines due today, (4) suggested high-priority tasks. It should NOT surface "Goal: Lose 10kg" next to "Task: Buy groceries."

- **Impact:** 5 — core ADHD-friendly design principle
- **Effort:** 1 — it's about NOT adding goals/projects to today queries, which is the default
- **Risk:** 1 — preserving current behavior is zero-risk

**Success Criterion:** Smart Today query only joins on `tasks` table, never on `goals` or `projects` tables.

**Decision:** ✅ Accept

---

## 17. Cognitive Load Reducer *(Custom)*

**Focus:** How many new concepts does the user need to learn?

**Recommendation:** Areas and Goals should be **opt-in progressive disclosure**, not mandatory upfront setup. When a user first uses Meitheal, they see only: Tasks + Projects (boards). If they never create an Area or set a Goal, nothing changes in their experience. The hierarchy enriches when they want it. Default project = "default" (renamed from board_id="default"). Default area = "Uncategorized" (auto-created). Default goal = none (tasks can exist without goals, projects can exist without goals).

- **Impact:** 4 — prevents "blank canvas paralysis" on first use
- **Effort:** 2 — ensure FKs are nullable, auto-create defaults
- **Risk:** 1 — additive, doesn't break existing users

**Success Criterion:** A fresh install creates one Area ("Uncategorized") and one Project ("Default"). Zero goals required. All existing features work without touching Areas or Goals.

**Decision:** ✅ Accept

---

## 18. Context-Switching Guard *(Custom)*

**Focus:** How does the bot handoff model respect human focus states?

**Recommendation:** Bot proposals should NEVER trigger push notifications or visual interruptions during user "focus mode." Implement a `bot_proposal_queue` that batches proposals and presents them during:
1. Morning triage (daily migration prompt — already exists)
2. Evening review (Smart Today's "Review" section)
3. Explicit "Review Bot Suggestions" action

The bot should write to a staging area visible in a dedicated "Bot Activity" section, not pop up in the user's current view.

- **Impact:** 4 — prevents ADHD task-switching from bot interruptions
- **Effort:** 2 — proposals are already write-only; just don't surface them in real-time UI
- **Risk:** 1 — UI-level suppression, no data model impact

**Success Criterion:** A bot proposal created via MCP does not trigger any `CustomEvent` or toast notification on the client. User sees it only in the morning triage or "Bot Activity" view.

**Decision:** ✅ Accept

---

## 19. Habit System Designer *(Custom)*

**Focus:** How does the Routine concept evolve from the existing Habits system?

**Recommendation:** Rename existing `is_habit` → `is_routine` and `frequency` → `cadence` in `task_templates`. Add `streak_current INTEGER DEFAULT 0` and `streak_best INTEGER DEFAULT 0` to `task_templates` for streak tracking. When a routine's spawned task is completed, increment the streak. When a day is missed, reset `streak_current` to 0. The binary_sensor entity in HA exposes `completed_today` state with `streak` as an attribute.

- **Impact:** 3 — builds on existing habit system, natural evolution
- **Effort:** 2 — column renames + streak logic
- **Risk:** 2 — must migrate existing habit data

**Success Criterion:** `SELECT * FROM task_templates WHERE is_routine = 1` returns existing habits with correct cadence and streak data.

**Decision:** ✅ Accept

---

## 20. Gamification Psychologist *(Custom)*

**Focus:** How does the new hierarchy support motivation loops?

**Recommendation:** Add a `progress_pct REAL DEFAULT 0.0` computed field to `goals` and `projects`:
- `project.progress_pct` = (completed tasks / total tasks) * 100
- `goal.progress_pct` = average of linked project progress percentages

These should be computed on read (not stored), using a SQL view or computed column approach. Display as progress rings in the sidebar tree next to each goal/project name.

- **Impact:** 3 — visual progress is motivating for ADHD brains
- **Effort:** 2 — SQL view + sidebar UI component
- **Risk:** 1 — computed on read, no data integrity risk

**Success Criterion:** `SELECT goal_id, progress_pct FROM v_goal_progress` returns correct percentages. Sidebar shows progress rings.

**Decision:** ⏸️ Defer — design the SQL view now, implement the UI in Phase 04.2.
