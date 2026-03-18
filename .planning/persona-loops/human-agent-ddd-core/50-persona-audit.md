# 50-Persona Audit — Human-Agent DDD Core

**Scope:** Replace `Epic -> Story -> Task` with `Area -> Goal -> Project -> Task -> Routine`, introduce bot-safe orchestration primitives, preserve Home Assistant/PWA/offline/Vikunja compatibility, and avoid Jira-fication.
**Date:** 2026-03-18
**Constraint Frame:** Pre-release hard cuts are allowed. Favor semantic clarity over migration preservation.

---

## Audit Method

10 passes x 5 personas = 50 expert lenses across:
1. ADHD capture and cognitive load
2. Task-management systems
3. Life-planning and behavior design
4. DDD and information architecture
5. Human-agent orchestration and trust
6. Offline sync and distributed systems
7. Home Assistant and ambient computing
8. External integration and compatibility
9. UI/UX and workflow ergonomics
10. Release strategy, KCS, and observability

Each persona gives one concrete recommendation.

---

## Pass 1: ADHD Capture and Cognitive Load

### Persona 1 — ADHD Diagnostic Clinician
**Finding:** Capture flows that ask for hierarchy too early create abandonment.
**Action:** Default every new capture to `Task` with optional routing into `Project`, `Goal`, or `Routine` after save.
- I:5 | E:2 | R:1

### Persona 2 — Executive Function Coach
**Finding:** Strategic nouns on the daily surface increase guilt and reduce completion.
**Action:** Keep `Goal` and `Project` off the Today page entirely. Show only actionable `Task` and `Routine` instances there.
- I:5 | E:2 | R:1

### Persona 3 — ADHD Product Designer
**Finding:** Users need one obvious "what is this?" choice, not hierarchy plus behavior plus scoring at once.
**Action:** Split creation into two axes:
- Axis 1: container (`Goal`, `Project`, `Task`, `Routine`)
- Axis 2: execution kind (`standard_action`, `shopping_item`, `checklist`)
- I:5 | E:3 | R:2

### Persona 4 — Occupational Therapist
**Finding:** Routines succeed when they feel like anchors, not obligations.
**Action:** Model `Routine` as a reusable cadence/template that spawns or validates tasks, not as a subtype of strategic work.
- I:4 | E:3 | R:1

### Persona 5 — Attention Researcher
**Finding:** "Epic" and "Story" are work-jargon, not life-planning language.
**Action:** Hard-cut those labels and replace them with plain-language nouns: `Goal`, `Project`, `Task`, `Routine`.
- I:5 | E:1 | R:1

---

## Pass 2: Task-Management Systems

### Persona 6 — GTD Practitioner
**Finding:** Projects are outcomes with multiple next actions, not just bigger tasks.
**Action:** Make `Project` its own aggregate root with completion state and linked tasks, rather than another `task_type`.
- I:5 | E:4 | R:2

### Persona 7 — PARA Information Architect
**Finding:** Areas and projects solve different problems and should not be collapsed.
**Action:** Introduce `Area` as the durable life domain and make `Project` finite work inside an area.
- I:5 | E:3 | R:2

### Persona 8 — Bullet Journal Designer
**Finding:** Checklists are excellent for procedure execution but poor as permanent hierarchy.
**Action:** Reserve checklist payloads for procedural work and routines, not for representing every external subtask tree.
- I:4 | E:2 | R:2

### Persona 9 — Kanban Coach
**Finding:** Boards are good visualizations, not necessarily the true business entity.
**Action:** Let `Project` own board-like workflow behavior, but keep `Area` as the top-level semantic grouping.
- I:4 | E:4 | R:3

### Persona 10 — Personal Knowledge Systems Designer
**Finding:** Goals should collect evidence and scoring, not daily checkbox noise.
**Action:** Attach strategic lenses and roll-up scoring to `Goal` and optionally `Project`, not to routine execution tasks by default.
- I:5 | E:3 | R:2

---

## Pass 3: Life Planning and Behavior Design

### Persona 11 — Habit Formation Specialist
**Finding:** Habits fail when they inherit the same UX as one-off tasks.
**Action:** Give `Routine` dedicated cadence/template fields and spawn state, even if it reuses task templates under the hood.
- I:4 | E:3 | R:1

### Persona 12 — Family Operations Planner
**Finding:** Household systems need persistent domains like `Health`, `Home`, `Village`, `Work`.
**Action:** Make `Area` first-class and visible in navigation, filters, and reporting.
- I:5 | E:3 | R:1

### Persona 13 — Long-Horizon Goal Coach
**Finding:** Goals can be continuous and may never be "done" in the same sense as projects.
**Action:** Give `Goal` states like `active`, `paused`, `archived`, not strict completion semantics only.
- I:4 | E:2 | R:1

### Persona 14 — Ritual Design Researcher
**Finding:** Routines need evidence that they happened, not only task closure.
**Action:** Allow routines to either spawn tasks or validate a completion event against a cadence window.
- I:4 | E:4 | R:2

### Persona 15 — Energy-Aware Planner
**Finding:** Daily surfaces should optimize "what can I do now?" not "how does this ladder upward?"
**Action:** Keep upward rollups available as secondary context chips, never as the primary sort/group mode on Today.
- I:5 | E:2 | R:1

---

## Pass 4: DDD and Information Architecture

### Persona 16 — Strategic DDD Architect
**Finding:** The current `task_type` mixes hierarchy semantics with execution semantics.
**Action:** Move hierarchy into relationships (`goal_id`, `project_id`, `routine_id`, `parent_task_id`) and reserve `task_kind` for behavior.
- I:5 | E:4 | R:2

### Persona 17 — Bounded Context Reviewer
**Finding:** Bot handoff, checklist execution, and strategic planning are different subdomains.
**Action:** Keep orchestration metadata on `Task`, but isolate scoring logic in `domain-strategy` and audit/ledger logic in `domain-observability`.
- I:4 | E:3 | R:2

### Persona 18 — Ubiquitous Language Editor
**Finding:** `Board` is overloaded across UI, persistence, and compatibility.
**Action:** Adopt one of two clear terms:
- `Area` for durable grouping
- `Project Board` for project workflow surface
- I:5 | E:3 | R:3

### Persona 19 — Domain Aggregate Designer
**Finding:** Goals, projects, routines, and tasks each have different invariants and lifecycles.
**Action:** Make them separate aggregate roots instead of emulating them via one `tasks` table with overloaded `task_type`.
- I:5 | E:5 | R:2

### Persona 20 — Schema Minimalist
**Finding:** Rich behavior does not require unbounded relational bloat.
**Action:** Keep procedural substructure in a few JSON payloads on `Task` and `Routine`, but do not hide aggregate identity inside JSON.
- I:4 | E:2 | R:1

---

## Pass 5: Human-Agent Orchestration and Trust

### Persona 21 — Multi-Agent Workflow Designer
**Finding:** `owner_type` alone is not enough to explain handoff progress.
**Action:** Add both `owner_type` and a separate `handoff_state` / `orchestration_state` machine.
- I:5 | E:3 | R:1

### Persona 22 — Human-in-the-Loop Safety Engineer
**Finding:** Bots should not silently close risky work.
**Action:** Add `proposed_artifact` for staged outputs and require explicit human approval before destructive completion.
- I:5 | E:3 | R:1

### Persona 23 — Cooperative AI UX Researcher
**Finding:** Trust collapses when humans cannot see what the bot is doing right now.
**Action:** Surface `working`, `blocked`, `pending_review`, and lock ownership directly in task cards/detail views.
- I:5 | E:3 | R:1

### Persona 24 — Resume-and-Recovery Engineer
**Finding:** Bots need resumable context that is not mixed into human prose.
**Action:** Store machine-facing notes in `agent_context`, distinct from `description`, with its own revision field.
- I:5 | E:2 | R:1

### Persona 25 — Auditability Specialist
**Finding:** The ledger is more important than the summary if you want durable trust.
**Action:** Add an append-only `task_audit_ledger` that records actor, action, payload, and timestamp for every agent/human/engine transition.
- I:5 | E:4 | R:1

---

## Pass 6: Offline Sync and Distributed Systems

### Persona 26 — CRDT Researcher
**Finding:** A single `updated_at` timestamp is too coarse for human/bot split-brain.
**Action:** Track revision timestamps per mutable family: core task fields, checklist state, agent context, proposed artifact, orchestration state.
- I:5 | E:4 | R:2

### Persona 27 — SQLite Sync Engineer
**Finding:** SQLite has JSON text, not native JSONB conflict semantics.
**Action:** Use multiple JSON text columns with clear ownership rather than one mega metadata blob.
- I:5 | E:2 | R:1

### Persona 28 — PWA Reliability Engineer
**Finding:** Queue deduplication at row level will drop intent when two actors edit different parts of the same task.
**Action:** Queue patch families plus `changed_fields`, not only whole-row payload snapshots.
- I:5 | E:4 | R:2

### Persona 29 — Conflict Resolution Designer
**Finding:** Most human/bot conflicts are actually disjoint-field merges.
**Action:** Auto-merge disjoint families, escalate overlapping families to `pending_human_review`, and never discard either side silently.
- I:5 | E:4 | R:2

### Persona 30 — Service Worker Specialist
**Finding:** Offline support must target the canonical API surface or it will drift.
**Action:** Ensure the offline sync engine talks to the same rich `/api/tasks` contract that supports optimistic locking and the new orchestration fields.
- I:5 | E:3 | R:2

---

## Pass 7: Home Assistant and Ambient Computing

### Persona 31 — Home Assistant Integration Architect
**Finding:** HA voice and automations care about intent, not internal hierarchy jargon.
**Action:** Accept commands like "add milk" or "start morning routine" and route them into `shopping_item` and `routine` semantics automatically.
- I:5 | E:3 | R:1

### Persona 32 — Supervisor Add-on Maintainer
**Finding:** Ingress safety and add-on compatibility are more fragile than schema work.
**Action:** Keep all new navigation and handoff surfaces hash-safe and ingress-safe, and avoid redirect-dependent UX.
- I:4 | E:2 | R:1

### Persona 33 — Ambient Voice UX Designer
**Finding:** Voice assistants should not have to speak "epic" or "story."
**Action:** Expose `Goal`, `Project`, `Task`, and `Routine` in voice/NLP prompts and compat docs.
- I:4 | E:2 | R:1

### Persona 34 — HA Todo Domain Expert
**Finding:** Some inbound todo items are better modeled as checklist items than full child tasks.
**Action:** Build a normalization layer that can flatten simple external subtasks into checklist payloads before they hit the main UI.
- I:4 | E:3 | R:2

### Persona 35 — Companion App UX Reviewer
**Finding:** Force-takeover flows need to work cleanly on mobile and companion surfaces.
**Action:** Add a small lock banner with actor, age, and a `Force Takeover` action that stays ingress-safe.
- I:4 | E:3 | R:1

---

## Pass 8: External Integration and Compatibility

### Persona 36 — Vikunja Compatibility Engineer
**Finding:** Vikunja `project` is closer to Meitheal `Project` than to `Area`.
**Action:** Keep a dedicated translation layer that maps external Vikunja projects to internal `Project`, not to the top-level domain grouping.
- I:5 | E:3 | R:2

### Persona 37 — Trello Migration Designer
**Finding:** Trello boards are finite work containers, not life domains.
**Action:** Map Trello boards to `Project` and let `Area` remain internal or optional during import.
- I:4 | E:3 | R:2

### Persona 38 — Grocy Workflow Architect
**Finding:** Shopping items should skip generic kanban choreography.
**Action:** Mark them as `shopping_item` tasks and let integration code sync them directly to Grocy while the UI uses a lightweight list surface.
- I:5 | E:3 | R:1

### Persona 39 — External Subtask Mapper
**Finding:** Not every external subtask deserves an internal aggregate root.
**Action:** Flatten simple external subtasks into checklist items when they have no independent due date, assignee, comments, or automation lifecycle.
- I:5 | E:3 | R:2

### Persona 40 — API Contract Steward
**Finding:** Compat layers must not leak internal naming churn.
**Action:** Preserve `vikunja-compat` and HA bridges behind translation adapters, even if internal nouns change completely.
- I:5 | E:2 | R:1

---

## Pass 9: UI/UX and Workflow Ergonomics

### Persona 41 — Information Architecture Lead
**Finding:** One selector should not force users to mentally translate every noun.
**Action:** Update the selection UI to offer separate pills/filters for `Area`, `Goal`, `Project`, `Routine`, and `Task kind`.
- I:4 | E:3 | R:2

### Persona 42 — Interaction Designer
**Finding:** Bot ownership needs pessimistic locking cues, not just subtle text.
**Action:** Use read-only states, dimmed controls, and explicit override CTA when `locked_by` is set.
- I:5 | E:3 | R:1

### Persona 43 — Kanban UX Specialist
**Finding:** Strategic entities clutter kanban if treated like actionable cards.
**Action:** Keep kanban for `Project`-scoped tasks. Show goals in strategic views and projects in navigation/filters instead of dumping them into the board lanes.
- I:5 | E:4 | R:2

### Persona 44 — Checklist UX Reviewer
**Finding:** Checklists are most powerful when progress can update incrementally without closing the parent task.
**Action:** Let agents and humans tick checklist items independently, and show checklist progress on task cards as a first-class execution signal.
- I:4 | E:2 | R:1

### Persona 45 — Search/Navigation Designer
**Finding:** Search should respect the new semantic hierarchy.
**Action:** Return `Area`, `Goal`, `Project`, `Routine`, `Task`, and `Action` as distinct result types with clear icons and scope-safe deep links.
- I:4 | E:3 | R:1

---

## Pass 10: Release Strategy, KCS, and Observability

### Persona 46 — Pre-Release Product Strategist
**Finding:** Pre-release is the right moment to hard-cut overloaded nouns.
**Action:** Remove `Epic` and `Story` everywhere in one coordinated sweep rather than maintaining hybrid semantics.
- I:5 | E:3 | R:2

### Persona 47 — KCS Program Lead
**Finding:** New orchestration states without docs will create support debt instantly.
**Action:** Add KCS touchpoints for lock states, human review, conflict resolution, and bot handoff expectations in the same change set.
- I:5 | E:2 | R:1

### Persona 48 — Observability Engineer
**Finding:** Without event-level telemetry, orchestration bugs will look like random task corruption.
**Action:** Emit structured events for handoff transitions, lock acquisition, conflict auto-merges, escalations, and approvals.
- I:5 | E:3 | R:1

### Persona 49 — QA Lead
**Finding:** The highest-risk regressions are semantic, not visual.
**Action:** Test matrix must cover:
- strategic items excluded from Today
- offline merge of bot vs human edits
- HA todo flattening to checklist
- Vikunja project mapping
- force-takeover lock flow
- I:5 | E:4 | R:2

### Persona 50 — Release Train Engineer
**Finding:** This work is too foundational to blend with incidental polish.
**Action:** Treat it as one named planning phase with explicit research, discussion, and approval gates before execution.
- I:5 | E:1 | R:1

---

## Cross-Persona Synthesis

### 1. Hard Cut the Hierarchy
- Remove `Epic` and `Story` entirely.
- Do not rename them in place as `Goal` and `Project` inside `task_type`.
- Make `Goal` and `Project` real aggregate roots.

### 2. Separate Structure from Behavior
- Structure: `Area`, `Goal`, `Project`, `Task`, `Routine`
- Behavior: `standard_action`, `shopping_item`, `checklist`
- A task belongs to structure and also has an execution kind.

### 3. Keep the Today Surface Pure
- Today should only show actionable tasks and spawned routine work.
- Goals and projects can appear as context chips, filters, or roll-up links, but never as primary daily work items.

### 4. Treat Bot Work as First-Class State
- Minimum primitives:
- `owner_type`
- `orchestration_state`
- `handoff_state`
- `locked_by`
- `locked_at`
- `agent_context`
- `proposed_artifact`
- `task_audit_ledger`

### 5. Avoid One Big Metadata Blob
- Use multiple JSON text columns for independent sandboxes.
- Give each mutable family its own revision timestamp.
- Auto-merge disjoint edits, escalate overlapping edits.

### 6. Preserve Compatibility by Translating at the Edge
- Vikunja/Trello boards map to internal `Project`.
- HA/Grocy intents map by `task_kind`.
- Checklist flattening belongs in the bridge layer, not in the UI layer.

### 7. Favor Pre-Release Clarity over Backward Compatibility
- Rename aggressively now.
- Clean up type icons, settings rules, search, filters, docs, compat types, and API copy in the same semantic sweep.

---

## Recommended Inputs for Step 1

These recommendations should shape the planning/research phase:

1. The future hierarchy should be `Area -> Goal -> Project -> Task`, with `Routine` as a parallel cyclical root.
2. `task_type` should stop representing hierarchy and become execution behavior, preferably renamed to `task_kind`.
3. Bot handoff state should be modeled directly on `Task`, with an immutable ledger table for trust.
4. Offline merge strategy must be field-family aware before bot scratchpads and checklist payloads are safe.
5. `vikunja-compat` should translate external `project` to internal `Project`, while trivial subtasks can flatten into checklist items.

---

*Step 0 complete: audit written, no implementation performed.*
