# Panel 3: Bot Orchestration Experts — Human-Agent DDD Core

**Objective:** How should bot/AI agents interact with the task hierarchy safely and elegantly?

---

## 21. Multi-Agent Systems Architect

**Focus:** How do multiple bots (HA Assist, MCP tools, n8n) coordinate without conflicts?

**Recommendation:** Implement a **mutex-based soft lock** on tasks: `owner TEXT DEFAULT 'human'`, `lock_holder TEXT`, `lock_expires_at INTEGER`. When a bot claims a task, it sets `lock_holder` and `lock_expires_at` (5-minute TTL). Other bots receive a 423 Locked response. Humans can ALWAYS override — clicking a locked task shows "Bot X is working on this. Take over?" and force-releases the lock. Expired locks auto-release.

- **Impact:** 5 — prevents concurrent bot mutations on the same task
- **Effort:** 3 — 3 columns, lock/unlock API, TTL cleanup in periodic sync
- **Risk:** 3 — lock expiry timing is tricky; too short = bot interrupted, too long = tasks stuck

**Success Criterion:** Bot A locks task, Bot B gets 423. After 5 minutes, Bot B can claim it. Human clicks "Take over" immediately and gets it.

**Decision:** ✅ Accept

---

## 22. Conversational AI Designer

**Focus:** How does the HA Assist voice interface interact with the new model?

**Recommendation:** HA Assist should use natural language mapped to specific intents:
- "Add milk to my shopping list" → create task with `task_kind: shopping_item` in the project associated with the "Shopping" todo entity
- "What's my progress on fitness goals?" → query `goals` table where `area.name = 'Health'`
- "Show me what's on today" → existing Smart Today, unchanged

The LLM API (`llm_api.py`) needs new tool declarations for `create_goal`, `list_goals`, `create_project`, `link_task_to_project`. These are separate from the task CRUD tools.

- **Impact:** 4 — voice is a key HA differentiator
- **Effort:** 3 — extend existing LLM API tool declarations
- **Risk:** 2 — additive API, doesn't break existing intents

**Success Criterion:** HA Assist can respond to "Show my goals" with a formatted list from the goals table.

**Decision:** ⏸️ Defer — depends on schema being stable first.

---

## 23. Agent Handoff Protocol Designer *(Custom)*

**Focus:** How does a bot propose changes for human review?

**Recommendation:** Implement a 4-state handoff state machine stored as `handoff_state TEXT` on tasks:
1. `idle` — no bot activity (default)
2. `claimed` — bot holds the lock, actively working
3. `proposed` — bot finished, proposal ready for review
4. `accepted` / `rejected` — human reviewed the proposal

The `proposal_json TEXT` field stores the bot's suggested changes (title edit, status change, new subtasks, etc.) as a structured diff. The `agent_scratchpad TEXT` field stores ephemeral working notes (chain-of-thought) that are:
- Set on claim, cleared on release
- Never returned in API responses (excluded from SELECT)
- Cleaned up by a daily cron (TTL: 24h)

- **Impact:** 5 — the handoff protocol is the core bot interaction pattern
- **Effort:** 3 — columns + state machine validation in update handler
- **Risk:** 3 — state machine must be correct; invalid transitions corrupt data

**Success Criterion:** State transitions `idle→claimed→proposed→accepted` work. `idle→accepted` is rejected (400). Scratchpad is never in GET responses.

**Decision:** ✅ Accept

---

## 24. Audit & Compliance Specialist *(Custom)*

**Focus:** How do we track who changed what and when?

**Recommendation:** Every bot mutation must write to the `task_activity_log` with `actor = 'bot:<agent_name>'` (e.g., `bot:ha-assist`, `bot:mcp`, `bot:n8n`). Human mutations use `actor = 'user'` (or `user:<name>` when custom_users are assigned). The existing `task_activity_log` table already has `field`, `old_value`, `new_value`, `actor`, `created_at` — no schema changes needed, just enforce the actor format.

Additionally, proposal acceptance should write a special activity log entry: `field = 'proposal', old_value = '{proposal_json}', new_value = 'accepted', actor = 'user'`.

- **Impact:** 4 — complete audit trail for bot actions
- **Effort:** 1 — just enforce actor naming convention in API handlers
- **Risk:** 1 — write-only, no data model changes

**Success Criterion:** `SELECT * FROM task_activity_log WHERE actor LIKE 'bot:%'` returns all bot mutations. `SELECT * FROM task_activity_log WHERE field = 'proposal'` returns all proposal reviews.

**Decision:** ✅ Accept

---

## 25. n8n Workflow Designer *(Custom)*

**Focus:** How do n8n workflows interact with the new model?

**Recommendation:** Create n8n webhook endpoints for goal lifecycle events:
- `POST /api/webhooks/goal-progress` — triggered when goal progress crosses thresholds (25%, 50%, 75%, 100%)
- `POST /api/webhooks/project-completed` — triggered when all tasks in a project are complete
- `POST /api/webhooks/routine-streak` — triggered when a routine streak hits milestones (7, 30, 100 days)

These webhooks enable n8n automations like "When project X is complete, send me a Telegram message" or "When streak reaches 30 days, add a celebration entry to HA logbook."

- **Impact:** 3 — nice automation hooks but not core
- **Effort:** 3 — webhook infrastructure exists (settings already has webhook config), just new event triggers
- **Risk:** 2 — outbound webhooks, no data mutation risk

**Success Criterion:** n8n workflow receives a webhook when a project is completed.

**Decision:** ⏸️ Defer — implement after core schema and lifecycle events are stable.

---

## 26. MCP Tool Designer *(Custom)*

**Focus:** How should MCP tools expose the new hierarchy?

**Recommendation:** Add these MCP tools to the existing LLM API:
- `meitheal_list_areas` — returns areas with goal count
- `meitheal_list_goals` — returns goals with progress % and linked project count
- `meitheal_create_project` — creates a project under a goal in an area
- `meitheal_propose_changes` — bot submits a proposal (title, status, subtask changes) for human review
- `meitheal_get_scratchpad` — bot reads its own scratchpad for a task (only accessible by the lock holder)

Do NOT expose `meitheal_force_update` — bots should always go through the proposal flow for non-trivial changes. Simple status changes (pending→active) are allowed without proposals.

- **Impact:** 4 — MCP is the primary bot interface
- **Effort:** 3 — extend existing tool declarations in `llm_api.py`
- **Risk:** 2 — additive tools, no breaking changes

**Success Criterion:** MCP can call `meitheal_list_goals` and get a structured response. `meitheal_propose_changes` creates a proposal on the task.

**Decision:** ⏸️ Defer — depends on schema (04.1a) and handoff protocol (04.1b).

---

## 27. Trust & Safety Reviewer *(Custom)*

**Focus:** What guardrails prevent bot abuse?

**Recommendation:** Implement a **bot rate limiter** on the task mutation API:
- Max 10 task mutations per bot per minute (configurable via `app_settings`)
- Max 3 concurrent locks per bot
- Max 1 goal/project creation per bot per minute
- Proposal rejection increments a "trust score" counter; 5 consecutive rejections auto-suspends the bot for 1 hour

Store bot trust state in `app_settings` (key: `bot_trust:<agent_name>`, value: JSON with `mutations_this_minute`, `consecutive_rejections`, `suspended_until`).

- **Impact:** 4 — prevents runaway automation
- **Effort:** 3 — rate limiting middleware + trust score logic
- **Risk:** 2 — could block legitimate bot actions if limits too tight

**Success Criterion:** A bot hitting 11 mutations in 60 seconds gets a 429 response. A bot with 5 consecutive rejections is suspended.

**Decision:** ⏸️ Defer — design now, implement after core bot infrastructure is working.

---

## 28. State Machine Verification Expert *(Custom)*

**Focus:** Is the handoff state machine correct and complete?

**Recommendation:** The handoff state machine needs these valid transitions:
```
idle → claimed (by bot, sets lock)
claimed → proposed (by bot, writes proposal_json)
claimed → idle (by bot, releases lock without proposing)
claimed → idle (by timeout, auto-release expired lock)
proposed → accepted (by human, applies proposal)
proposed → rejected (by human, clears proposal)
proposed → idle (by timeout, human didn't respond in 24h)
accepted → idle (automatic, post-apply cleanup)
rejected → idle (automatic, post-reject cleanup)
```

Invalid transitions that must be blocked: `idle → proposed` (can't propose without claiming), `proposed → claimed` (can't re-claim after proposing), `accepted → rejected` (terminal).

Write a state machine test that covers all valid transitions and rejects all invalid ones.

- **Impact:** 5 — state machine bugs cause data corruption
- **Effort:** 2 — pure logic test, ~40 test cases
- **Risk:** 1 — test-only, no production side effects

**Success Criterion:** Test file covers all 9 valid transitions and rejects all invalid ones. `pnpm --filter @meitheal/tests test handoff-state-machine.spec.ts` passes.

**Decision:** ✅ Accept

---

## 29. Data Architect *(Custom)*

**Focus:** What indexes and queries does the new model need?

**Recommendation:** Define the query index requirements upfront:
- `goals`: index on `area_id`, index on `status`
- `projects`: index on `goal_id`, index on `status`, composite index on `(goal_id, status)`
- `tasks`: add index on `project_id` (will be a new FK column)
- `tasks`: add composite index on `(project_id, status)` for project-scoped board queries

Remove the existing `tasks_task_type_idx` index once `task_type` is migrated to `task_kind` — replace with `tasks_task_kind_idx`.

Keep the `board_id` column and index for backward compatibility during transition. Eventually `board_id` maps to `project_id` 1:1, but the migration should be gradual.

- **Impact:** 4 — query performance for project-scoped views
- **Effort:** 2 — CREATE INDEX statements in ensureSchema()
- **Risk:** 1 — additive indexes, no data changes

**Success Criterion:** `EXPLAIN QUERY PLAN SELECT * FROM tasks WHERE project_id = ? AND status = ?` shows index usage.

**Decision:** ✅ Accept

---

## 30. Event Sourcing Strategist *(Custom)*

**Focus:** How do domain events evolve with the new model?

**Recommendation:** Extend the `domain_events` table with a `entity_type TEXT DEFAULT 'task'` column. This allows goal and project events to share the same event infrastructure without creating separate event tables. The existing `task_id` column becomes overloaded (it stores goal_id or project_id depending on entity_type), so rename it to `entity_id` with an alias view for backward compatibility.

New event types:
- `goal.created`, `goal.updated`, `goal.archived`, `goal.progress_changed`
- `project.created`, `project.status_changed`, `project.completed`
- `task.linked_to_project`, `task.unlinked_from_project`
- `task.proposal_created`, `task.proposal_accepted`, `task.proposal_rejected`

- **Impact:** 4 — unified event model for the whole hierarchy
- **Effort:** 3 — column rename (via table rebuild), new event type enum, event handler updates
- **Risk:** 3 — renames `task_id` → `entity_id` which touches many queries

**Success Criterion:** `SELECT entity_type, event_type, entity_id FROM domain_events` shows events for goals, projects, and tasks.

**Decision:** ✅ Accept
