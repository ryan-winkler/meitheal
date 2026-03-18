# 50-Persona Expert Audit — Meitheal Pre-Release

**Date:** 2026-03-18
**Scope:** Full product audit — schema, UX, HA integration, offline, bot orchestration, accessibility, gamification, n8n
**Mode:** Ideation only — no implementation. Hard cuts permitted (pre-release, no migrations).

---

## Panel 1: ADHD & Executive Function (Personas 1–5)

### 1. Dr. Kara Mitchell — ADHD Clinical Psychologist

**Focus:** Does the task hierarchy create cognitive overload?

**Recommendation:** The `task_kind` column currently allows 4 values (`standard_action`, `shopping_item`, `checklist`, `routine_instance`). Add `quick_capture` as a fifth kind — a zero-friction task that auto-assigns to inbox with no required fields except title. ADHD brains need a "dump it and forget" entry point. The NLP parser should attempt to classify quick-captures into proper kinds asynchronously (bot proposal), but the user should never be forced to classify on creation.

- **Impact:** 5 — removes the #1 adoption barrier for ADHD users
- **Effort:** 1 — one new enum value, default to inbox status
- **Risk:** 1 — additive, no breaking changes

**Success Criterion:** Creating a task with only a title via `/api/tasks` results in `task_kind = 'quick_capture'` and `status = 'backlog'`.

---

### 2. James Torres — Neurodivergent Productivity Coach

**Focus:** Does the morning triage reduce decision fatigue?

**Recommendation:** Smart Today should generate a **3-item "Focus Stack"** — the top 3 tasks Meitheal recommends for the day. Algorithm: (1) any overdue task, (2) highest-priority task due today, (3) next routine due. Present these as a card carousel above the full list with a "Start day" button that marks all 3 as active. For ADHD, 3 is the magic number — more causes paralysis, fewer feels too easy.

- **Impact:** 5 — transforms today from a list into a decision engine
- **Effort:** 3 — new API endpoint + UI card component
- **Risk:** 1 — additive feature

**Success Criterion:** `/api/today-summary` returns a `focus_stack: Task[3]` array. Today page shows the stack above the existing sections.

---

### 3. Dr. Alina Kovacs — Working Memory Researcher

**Focus:** How does the offline store handle context loss?

**Recommendation:** The `OfflineTask` type in IndexedDB stores only 7 fields (`id, title, description, status, dueDate, updatedAt, createdAt`). This makes offline mode useless for any meaningful work — you can't see labels, priority, project, assignee, or checklists. **Hard cut: expand `OfflineTask` to mirror the full task row** — add `priority`, `labels`, `project_id`, `task_kind`, `checklists`, `assigned_to`, and `board_id`. Without this, going offline means losing context, which is the worst possible state for a working-memory-challenged brain.

- **Impact:** 5 — offline mode is currently broken for real use
- **Effort:** 3 — expand IDB schema, bump version, update sync payloads
- **Risk:** 2 — needs IDB migration (version 2→3), but pre-release so no users affected

**Success Criterion:** `OfflineTask` interface includes all 14 essential task fields. IDB version = 3.

---

### 4. Marcus Li — Executive Function Coach

**Focus:** Does the bot handoff model respect focus states?

**Recommendation:** Bot proposals should batch into a **"Review Queue"** accessible from the sidebar (icon: 📬), not appear as real-time events. The queue should show: pending count badge on the sidebar icon, grouped by bot (HA Assist, MCP, n8n), with accept-all/reject-all actions per bot. During work sessions, no toast, no notification, no interruption. The bot settings already have "Allow Proposals" — but there's no UI to review them. Add a `/review` page.

- **Impact:** 4 — prevents bot-induced context switching
- **Effort:** 3 — new page, sidebar item, queue query
- **Risk:** 1 — additive

**Success Criterion:** `/review` page shows grouped bot proposals. Sidebar shows 📬 with count badge. Zero bot-related CustomEvents fire on task pages.

---

### 5. Sofia Petrov — ADHD App Designer

**Focus:** Is the visual hierarchy ADHD-friendly?

**Recommendation:** Kanban cards are currently too information-dense. Apply the **"3-line rule"**: each card shows max 3 lines of content — title (line 1), due date + priority (line 2), labels + assignee (line 3). Everything else (checklist, description, bot status) hides behind expand or click-to-open. Cards should have a left-border color strip matching priority (P1=red, P2=orange, P3=blue, P4=gray). This gives instant visual scanning without reading.

- **Impact:** 4 — reduces visual noise across all board views
- **Effort:** 2 — CSS refactor on card components
- **Risk:** 1 — visual only

**Success Criterion:** Kanban card height is ≤80px in default state. Priority strip is visible. Card expand reveals full details.

---

## Panel 2: Task Management Systems (Personas 6–10)

### 6. Rachel Kim — GTD Methodology Expert

**Focus:** Does the Area→Goal→Project model support GTD?

**Recommendation:** GTD requires a clear "Inbox → Process → Organize → Review" pipeline. Meitheal has inbox (backlog) and organize (projects) but lacks explicit **Weekly Review** support. Add a `/review/weekly` endpoint that: (1) lists all tasks not touched in 7+ days, (2) shows all projects with zero active tasks, (3) highlights goals with no progress. This is the missing GTD Review step. The bot could even auto-generate a weekly review prompt every Sunday.

- **Impact:** 4 — completes the GTD pipeline
- **Effort:** 2 — SQL query + simple page
- **Risk:** 1 — read-only analysis

**Success Criterion:** `/api/review/weekly` returns stale tasks, dormant projects, and stagnant goals.

---

### 7. David Osterhaus — Kanban Expert

**Focus:** Are WIP limits enforced?

**Recommendation:** Add a `wip_limit` column to `boards` (or use `app_settings` with key `wip_limit_{status}`). When active count exceeds the limit, the kanban column header turns amber and blocks drag-in (with override). ADHD users especially need WIP limits — starting 20 tasks and finishing 0 is the pattern. Default: 5 active tasks per board.

- **Impact:** 4 — prevents the #1 ADHD failure mode
- **Effort:** 2 — one setting + kanban UI change
- **Risk:** 1 — soft limit with override

**Success Criterion:** Kanban column shows amber WIP warning when limit exceeded. Setting configurable in Workflow settings.

---

### 8. Yuki Tanaka — Task Dependency Specialist

**Focus:** Are task links functional or decorative?

**Recommendation:** `task_links` table exists but has zero UI and zero API routes reading it. Either implement it or drop it. Currently it's dead schema weight. **Hard cut: add `blocked_by` enforcement.** If task A has a `blocked_by` link to task B, and B is not `complete`, then A should show a 🚫 badge and cannot be moved to `active`. This makes dependencies real, not decorative.

- **Impact:** 3 — prevents out-of-order execution
- **Effort:** 3 — query on status change, badge in UI
- **Risk:** 2 — could frustrate users if over-applied

**Success Criterion:** Moving a blocked task to `active` returns 409. Card shows blocker badge with link to blocking task.

---

### 9. Maria Santos — Todoist/TickTick Migration Expert

**Focus:** Is the import path frictionless?

**Recommendation:** The export page supports JSON/CSV/SQLite backup but there's no **import** beyond restore. For pre-release adoption, add CSV import that maps: `title, description, status, priority, due_date, labels, project_name`. Auto-create projects on import. Support Todoist CSV format specifically (it's the #1 source for ADHD tool-hoppers). The Vikunja compat layer already handles V1 import — extend it.

- **Impact:** 3 — removes adoption friction
- **Effort:** 3 — CSV parser, mapping, project auto-creation
- **Risk:** 2 — data quality varies wildly in csvs

**Success Criterion:** `/api/import/csv` accepts Todoist-format CSV and creates tasks with correct labels and projects.

---

### 10. Ahmed Hassan — Task Analytics Expert

**Focus:** Is there visibility into completion patterns?

**Recommendation:** Add a simple `/api/analytics/velocity` endpoint that returns: tasks completed per day (7d rolling), average time-to-complete, completion rate by project. Display on the dashboard. This closes the feedback loop — ADHD brains need proof that they're making progress, not just "here's your list."

- **Impact:** 3 — motivation through data
- **Effort:** 2 — SQL aggregation queries
- **Risk:** 1 — read-only

**Success Criterion:** Dashboard shows a 7-day velocity sparkline and completion percentage.

---

## Panel 3: Life Planning & Strategy (Personas 11–15)

### 11. Christine Lee — OKR/Goal-Setting Coach

**Focus:** Do Goals have measurable outcomes?

**Recommendation:** Goals currently have: `title, description, status, target_date`. Add `metric_type` (count, percentage, currency, boolean) and `metric_target` (number) + `metric_current` (number). Example: "Read 12 books" → metric_type=count, target=12, current=3. Progress becomes computed: `(current/target)*100`. This makes goals measurable instead of aspirational.

- **Impact:** 4 — transforms goals from labels into OKRs
- **Effort:** 2 — 3 columns on goals table
- **Risk:** 1 — nullable columns, fully optional

**Success Criterion:** `/api/goals/:id` returns `progress_pct` computed from `metric_current / metric_target`.

---

### 12. Dr. Michael Chen — Habit Formation Researcher

**Focus:** Is routine tracking scientifically sound?

**Recommendation:** The streak model (streak_current, streak_best) is simplistic. Add `completion_history` as a JSON column on `task_templates` — a rolling 90-day bitfield (or array of dates). This enables: completion heatmaps, "X of last 7 days" style tracking, and streak freezes (skipping weekends). Without history, you lose context on a missed day.

- **Impact:** 3 — enables richer habit analytics without a separate table
- **Effort:** 2 — JSON column + update logic
- **Risk:** 1 — pre-release, no migration concern

**Success Criterion:** `task_templates` has `completion_history` TEXT column. Completing a routine appends the date.

---

### 13. Laura Jennings — Time-Blocking Expert

**Focus:** Does the calendar integration support time blocking?

**Recommendation:** Calendar bridge syncs tasks ↔ events, but there's no concept of **time blocks** — dedicated focus windows. Add `time_block_start` and `time_block_end` (ISO datetime) columns to tasks. When set, the task appears as a calendar event in the synced HA calendar. Smart Today should sort time-blocked tasks by start time. This bridges the gap between "what to do" and "when to do it."

- **Impact:** 4 — the most requested feature in ADHD task tools
- **Effort:** 2 — 2 columns + calendar sync logic update
- **Risk:** 2 — calendar sync complexity

**Success Criterion:** Setting time_block_start on a task creates/updates a calendar event. Today page sorts time-blocked tasks by start time.

---

### 14. Tom Richardson — Area-of-Life Framework Expert

**Focus:** Are Areas useful or just labels?

**Recommendation:** Areas currently have `name, icon, color, position`. Add `energy_budget` (INTEGER, default null) — how many active tasks the user wants in this area at any time. And `review_cadence` (e.g., "weekly", "monthly") for area-level reviews. This makes Areas part of the planning system, not just color-coded folders. The weekly review endpoint (from #6) should respect area review cadence.

- **Impact:** 3 — makes Areas strategic, not decorative
- **Effort:** 2 — 2 columns
- **Risk:** 1 — nullable, fully optional

**Success Criterion:** Areas table has `energy_budget` and `review_cadence` columns. Weekly review groups by area.

---

### 15. Priya Sharma — Eisenhower Matrix Specialist

**Focus:** Can priority be visually mapped to urgency/importance?

**Recommendation:** The 4-level priority (1-4) maps perfectly to Eisenhower. Name them explicitly in the UI: P1 = "🔴 Do Now" (urgent+important), P2 = "🟠 Schedule" (important not urgent), P3 = "🔵 Delegate" (urgent not important), P4 = "⚪ Consider" (neither). Add a `/eisenhower` view that renders a 2x2 grid of tasks by priority. This reuses existing data with zero schema changes.

- **Impact:** 3 — zero-cost view leveraging existing priority field
- **Effort:** 2 — new page with CSS grid
- **Risk:** 1 — additive view

**Success Criterion:** `/eisenhower` page renders 4 quadrants. Each quadrant is a droppable zone. Drag changes priority.

---

## Panel 4: Home Assistant Integration (Personas 16–20)

### 16. HA Core Developer (Anonymous)

**Focus:** Is the add-on publishing-ready?

**Recommendation:** The add-on is missing `panel_admin: true` in `config.yaml`. Without it, non-admin HA users can't see the sidebar entry. Also missing: `auth_api: true` for future HA auth token forwarding. The `ingress_entry` should point to `/` not `/index.html`. Verify against https://developers.home-assistant.io/docs/add-ons/configuration.

- **Impact:** 4 — blocks HA store submission
- **Effort:** 1 — config.yaml fields
- **Risk:** 1 — config only

**Success Criterion:** `config.yaml` has `panel_admin`, `auth_api`, correct `ingress_entry`.

---

### 17. Sarah O'Brien — HA Automation Designer

**Focus:** Are entities exposable for automations?

**Recommendation:** Meitheal exposes zero HA entities. For automation integration, register: (1) `binary_sensor.meitheal_tasks_overdue` — true when any task is past due, (2) `sensor.meitheal_active_tasks` — count of active tasks, (3) `sensor.meitheal_streak_days` — current routine streak. These enable HA automations like "dim living room lights red when tasks are overdue" or "announce streak milestone on smart speaker."

- **Impact:** 4 — unlocks HA ecosystem value
- **Effort:** 3 — entity registration via Supervisor API
- **Risk:** 2 — Supervisor entity API is complex

**Success Criterion:** `GET /api/ha/states` returns Meitheal sensor entities. HA automations can trigger on state changes.

---

### 18. Carlos Rivera — HA WebSocket Expert

**Focus:** Is the WebSocket connection resilient?

**Recommendation:** `ha-connection.ts` connects once on startup but has no **heartbeat or reconnect backoff**. If the HA core restarts or the network blips, the WebSocket dies silently. Add: (1) 30s ping/pong heartbeat, (2) exponential backoff reconnect (1s, 2s, 4s, 8s, max 30s), (3) connection state events that the sidebar can display ("HA disconnected, reconnecting..."). The passive `getHAConnectionStatus()` should reflect actual WebSocket readyState, not cached isConnected.

- **Impact:** 4 — prevents silent integration failure
- **Effort:** 2 — standard WebSocket patterns
- **Risk:** 1 — hardening, not new behavior

**Success Criterion:** WebSocket auto-reconnects within 30s of connection loss. Sidebar shows real-time connection status.

---

### 19. Emma Walsh — HA Companion App Expert

**Focus:** Does ingress work in the Companion app?

**Recommendation:** The Companion app on iOS wraps the HA web view in a WKWebView. Two known issues: (1) `window.open()` is intercepted and doesn't work — all links must use in-page navigation, (2) IndexedDB persistence is unreliable in WKWebView on iOS 17+. **Hard cut: detect Companion app via user-agent and disable IndexedDB-based offline features.** Use `navigator.userAgent.includes('Home Assistant')` to detect. Show a "Companion mode" indicator instead of "PWA offline ready."

- **Impact:** 3 — prevents data loss on iOS Companion
- **Effort:** 2 — user-agent detection + conditional
- **Risk:** 1 — graceful degradation

**Success Criterion:** Companion app shows "Companion mode" badge. No IndexedDB writes in Companion context.

---

### 20. Donal Murphy — HA LLM API Developer

**Focus:** Is the Conversation Agent implementation complete?

**Recommendation:** The LLM API (`llm_api.py`) currently registers tools but doesn't expose the hierarchy model. Add tools: `list_areas`, `list_goals`, `list_projects`, `move_task_to_project`, `set_goal_progress`. This lets users say "Hey Google, move the groceries task to my health project" via HA Assist. Without hierarchy-aware tools, the voice interface doesn't know about the new model.

- **Impact:** 4 — completes voice-first interface
- **Effort:** 3 — 5 new LLM tools
- **Risk:** 1 — additive tools

**Success Criterion:** `llm_api.py` registers hierarchy tools. "List my goals" via Assist returns goal titles.

---

## Panel 5: Offline & Sync (Personas 21–25)

### 21. Jake Wilson — Offline-First Architecture Expert

**Focus:** Is the sync strategy production-ready?

**Recommendation:** The sync engine uses **whole-row last-write-wins** (LWW). This means: if a bot updates `handoff_state` via API while a human edits `title` offline, the human's sync overwrites the bot's change OR vice versa. **Hard cut: implement field-family merge.** Define 3 families: (1) `user_fields` (title, description, status, priority, labels, checklists, due_date), (2) `bot_fields` (owner, lock_holder, handoff_state, proposal_json, agent_scratchpad), (3) `meta_fields` (updated_at, created_at). Only merge within the same family — user edits don't clobber bot state and vice versa.

- **Impact:** 5 — prevents data loss between human and bot
- **Effort:** 4 — requires per-field timestamp tracking
- **Risk:** 3 — fundamental sync model change

**Success Criterion:** Offline sync resolves conflicts per field-family, not per row. Concurrent human title edit + bot status change both persist.

---

### 22. Dr. Yun Wei — IndexedDB Performance Engineer

**Focus:** Will IDB scale to 10K tasks?

**Recommendation:** `getAllTasks()` returns all tasks in a single IDB transaction. At 10K tasks with the expanded schema (14+ fields per task), this will cause UI jank. Add **cursor-based pagination** to `getAllTasks(limit, offset)` and an `getTasksByStatus(status)` query that uses the existing status index. The offline page should paginate, not load all. Also add a `taskCount()` method that uses `store.count()` for the badge without reading rows.

- **Impact:** 3 — prevents performance cliff
- **Effort:** 2 — cursor pagination
- **Risk:** 1 — additive optimization

**Success Criterion:** `getAllTasks(100, 0)` returns first 100 tasks. Offline page paginates.

---

### 23. Nadia Sokolov — PWA Service Worker Expert

**Focus:** Is the service worker cache strategy optimal?

**Recommendation:** Current SW registers background sync but doesn't implement a **cache-first strategy for static assets** or a **network-first strategy for API calls**. For PWA reliability, the SW should: (1) cache all Astro-generated static assets (CSS, JS, fonts) on install, (2) serve cached versions when offline, (3) use network-first for `/api/` routes with fallback to IDB. Without this, the app shows a blank page when offline.

- **Impact:** 4 — offline mode currently shows nothing
- **Effort:** 3 — SW rewrite with proper cache strategies
- **Risk:** 2 — cache invalidation is hard

**Success Criterion:** App loads in airplane mode. Static assets served from cache. API calls fall back to IDB.

---

### 24. Tomás García — Conflict Resolution Expert

**Focus:** What happens when two tabs edit the same task?

**Recommendation:** `tab-sync.ts` exists but uses BroadcastChannel for tab-to-tab communication. It doesn't handle **concurrent edits to the same task across tabs**. Add an `updatedAt` check before saving: if the task's `updated_at` is newer than when the tab loaded it, show a "Task was modified in another tab. Reload?" prompt instead of silently overwriting. This is the same 409 pattern the server uses.

- **Impact:** 3 — prevents data loss between tabs
- **Effort:** 2 — version check on save
- **Risk:** 1 — defensive check

**Success Criterion:** Editing a task in tab A, then saving in tab B after A saves, shows a conflict prompt.

---

### 25. Olivia Park — Data Migration Architect

**Focus:** Is the schema migration strategy sound?

**Recommendation:** `ensureSchema()` uses `hasColumn()` checks and `ALTER TABLE ADD COLUMN` for every new column. This is the correct approach for SQLite (which doesn't support `ALTER TABLE MODIFY`). But there's no **schema version tracking**. Add an `app_settings` row with key `schema_version` and set it after each migration block. This enables: (1) skipping completed migrations on startup (faster boot), (2) detecting downgrade attempts, (3) reporting version in health endpoint.

- **Impact:** 3 — faster startup, better diagnostics
- **Effort:** 1 — one setting key + conditional blocks
- **Risk:** 1 — additive

**Success Criterion:** `GET /api/health` returns `schema_version: N`. Startup skips migrations when version matches.

---

## Panel 6: Bot Orchestration & AI (Personas 26–30)

### 26. Dr. Ethan Brooks — Multi-Agent Systems Researcher

**Focus:** Is the handoff state machine complete?

**Recommendation:** The state machine has 5 states: `idle → claimed → proposed → accepted/rejected`. Missing: `failed` (bot crashes mid-work), `timeout` (lock expired without proposal), `human_override` (human edits a claimed task). Add these as valid transitions with automatic cleanup. A CRON-style endpoint `/api/tasks/cleanup-stale-locks` should run every 5 minutes to release expired locks and transition to `timeout`.

- **Impact:** 4 — prevents stuck tasks
- **Effort:** 2 — state transitions + cleanup endpoint
- **Risk:** 1 — defensive logic

**Success Criterion:** Lock cleanup runs on a timer. Stuck locks auto-release after `bot_lock_timeout` minutes.

---

### 27. Isabella Romano — n8n Workflow Architect

**Focus:** How does Meitheal integrate with n8n?

**Recommendation:** Meitheal has zero n8n integration despite `n8n` being a configured MCP server. Add **3 webhook endpoints**: (1) `POST /api/webhooks/n8n/task-created` — fires when a task is created, (2) `POST /api/webhooks/n8n/task-completed` — fires on completion, (3) `POST /api/webhooks/n8n/daily-summary` — fires at midnight with today's stats. These use the existing `app_settings` webhook URL configuration. n8n picks up the webhooks to trigger downstream automations.

- **Impact:** 4 — unlocks n8n automation ecosystem
- **Effort:** 3 — 3 webhook triggers + payload contracts
- **Risk:** 1 — outbound-only

**Success Criterion:** Completing a task triggers a configurable webhook. n8n catches the event and runs a workflow.

---

### 28. Alex Kim — MCP Protocol Implementer

**Focus:** Are MCP tools functional?

**Recommendation:** `/.well-known/mcp.json` serves tool declarations but `/api/mcp.ts` is a stub. Implement the 5 core tools: `create_task`, `list_tasks`, `update_task`, `search_tasks`, `get_task`. Each tool should validate against the `bot_allow_proposals` setting — if proposals are disabled, tools return `403`. Tools should use the handoff protocol: claim → propose → await human accept. This makes Meitheal a real MCP server, not just a manifest.

- **Impact:** 4 — enables AI agent integration
- **Effort:** 3 — 5 tool implementations
- **Risk:** 2 — security surface

**Success Criterion:** MCP client can create a task via the tool endpoint. Task appears with `handoff_state: proposed`.

---

### 29. Dr. Lena Fischer — AI Safety Researcher

**Focus:** What are the security boundaries for bots?

**Recommendation:** The `agent_scratchpad` column stores ephemeral bot notes but is never filtered from API responses. **Hard cut: add `agent_scratchpad` to the SQL SELECT exclusion list** in all task query functions. Also: the `accept-proposal.ts` endpoint should rate-limit to 10 accepts/minute to prevent a runaway bot flood. Add the same rate limit to bot claim and propose endpoints.

- **Impact:** 4 — prevents data leakage and abuse
- **Effort:** 2 — SELECT exclusion + rate limiting
- **Risk:** 1 — defensive

**Success Criterion:** `agent_scratchpad` never appears in any API response. Bot endpoints are rate-limited.

---

### 30. Ryan Chen — A2A Protocol Specialist

**Focus:** Is the Agent Card spec-compliant?

**Recommendation:** The A2A agent card at `/api/a2a/agent-card` should include: `agent_name`, `version`, `capabilities` (create_task, search, update), `auth_required: true`, `rate_limit`, `contact_url`. Currently it's a basic JSON blob. Align with the Google A2A spec: https://google-a2a.github.io/A2A/. Add `supported_content_types: ["application/json"]` and `skills` array.

- **Impact:** 2 — spec compliance
- **Effort:** 1 — JSON updates
- **Risk:** 1 — metadata only

**Success Criterion:** Agent card validates against A2A JSON schema. `skills` array lists available tools.

---

## Panel 7: UX & Visual Design (Personas 31–35)

### 31. Natasha Volkov — Mobile-First Designer

**Focus:** Does the UI work on phones behind HA Companion?

**Recommendation:** The sidebar is 240px fixed width. On phones (<480px), it should collapse to a bottom tab bar with 5 icons: 📋 Tasks, 📅 Today, 📊 Kanban, ⚙️ Settings, 📬 Review. The HA Companion app already has its own sidebar, so Meitheal's sidebar inside the ingress iframe creates double-sidebar confusion. **Hard cut: hide Meitheal sidebar when `window.innerWidth < 768` and show bottom nav instead.**

- **Impact:** 4 — mobile HA Companion is unusable with two sidebars
- **Effort:** 3 — responsive breakpoint + bottom nav component
- **Risk:** 2 — significant layout change

**Success Criterion:** Mobile viewport shows bottom nav. Sidebar hidden. All views accessible via bottom tabs.

---

### 32. Henrik Larsson — Dark Mode Specialist

**Focus:** Are color tokens consistent?

**Recommendation:** The CSS uses both `var(--bg-card)` and hardcoded `rgba(0,0,0,0.18)` shadows. Audit all hardcoded opacity values and replace with theme-aware tokens. Create `--shadow-sm`, `--shadow-md`, `--shadow-lg` tokens that adapt to light/dark mode. Shadow opacity should be lower in light mode (0.08) and higher in dark mode (0.25).

- **Impact:** 2 — visual consistency
- **Effort:** 2 — CSS token extraction
- **Risk:** 1 — visual only

**Success Criterion:** Zero hardcoded `rgba()` shadow values in components. All shadows use `var(--shadow-*)`.

---

### 33. Dr. Ana Costa — Accessibility Expert

**Focus:** Does the app meet WCAG 2.2 AA?

**Recommendation:** Critical gaps: (1) No `skip-to-content` link, (2) Kanban column headers are `div` not `h2`, (3) Drag-and-drop has no keyboard alternative, (4) Color contrast on muted text (<4.5:1 ratio), (5) No visible focus styles on custom components (toggles, chips). **Hard cut: add `skip-to-content`, fix heading hierarchy, add keyboard DnD alternative (move menu), check all muted text contrast.**

- **Impact:** 4 — legal requirement in many jurisdictions
- **Effort:** 3 — systematic a11y pass
- **Risk:** 1 — improvements only

**Success Criterion:** Lighthouse accessibility score ≥90. Skip link visible on tab. All interactive elements keyboard-accessible.

---

### 34. Paolo Bianchi — Motion Design Expert

**Focus:** Are animations performant?

**Recommendation:** Several components use `transition: all 200ms` which animates layout properties (width, height, padding) causing layout thrash. **Hard cut: replace all `transition: all` with explicit property lists** (`transition: background 200ms, color 200ms, border-color 200ms`). This is a free performance win. Also ensure all animations respect `prefers-reduced-motion` (partially done, needs full audit).

- **Impact:** 3 — smoother animations, less jank
- **Effort:** 1 — find-and-replace
- **Risk:** 1 — CSS only

**Success Criterion:** Zero `transition: all` in codebase. All transitions list explicit properties.

---

### 35. Li Wei — Data Visualization Expert

**Focus:** Are progress indicators informative?

**Recommendation:** Goal and project progress is computed but never shown. Add a **progress ring** (SVG circle) to: (1) sidebar project list items, (2) project cards on index page, (3) goal detail page. The ring should be 24px, using stroke-dasharray/dashoffset for percentage. Color: green ≥75%, amber 25-75%, red <25%. This provides at-a-glance progress without opening any page.

- **Impact:** 3 — visual feedback on planning entities
- **Effort:** 2 — SVG component + inline computation
- **Risk:** 1 — visual only

**Success Criterion:** Sidebar shows progress rings next to each project. Ring fills to match completion percentage.

---

## Panel 8: Security & Reliability (Personas 36–40)

### 36. Dr. Sarah Hughes — AppSec Engineer

**Focus:** Are API inputs validated?

**Recommendation:** Several API routes parse JSON bodies without schema validation. Add a lightweight `validateBody(schema)` utility that checks required fields and types before processing. The `accept-proposal.ts` already validates `action` — extend this pattern to all task mutation endpoints. Block: (1) XSS in title/description (already sanitized on output), (2) SQL injection via param interpolation (already using parameterized queries), (3) Prototype pollution via `JSON.parse` of user-controlled objects.

- **Impact:** 3 — defensive hardening
- **Effort:** 2 — shared validation utility
- **Risk:** 1 — additive

**Success Criterion:** All POST/PUT endpoints validate body schema before processing. Invalid bodies return 400.

---

### 37. Martin Gruber — Crash Prevention Engineer

**Focus:** What happens when the DB is corrupted?

**Recommendation:** `ensureSchema()` runs ALTER TABLE statements that can fail silently on corrupt databases. Add a startup health check: after schema bootstrap, run `PRAGMA integrity_check` on SQLite. If it fails, (1) log a critical error, (2) attempt to read from a backup if `backupEnabled`, (3) surface "Database corruption detected" in the UI health panel. Don't silently serve stale data.

- **Impact:** 4 — prevents silent data corruption
- **Effort:** 2 — PRAGMA check + error handling
- **Risk:** 1 — read-only diagnostic

**Success Criterion:** Startup runs integrity check. Corruption triggers log + UI warning.

---

### 38. Elena Popov — Memory Leak Hunter

**Focus:** Are there memory leaks in long-running components?

**Recommendation:** The sidebar tree, kanban board, and settings page all create event listeners in `<script>` tags but none remove them on navigation. In Astro's MPA model with `ClientRouter`, this causes listener accumulation. **Hard cut: wrap all `addEventListener` calls in a `pageLifecycle.onCleanup()` callback** or use `{ once: true }` where appropriate. The `sync-engine.ts` periodic timer leaks if the page navigates (`beforeunload` is unreliable in SPAs).

- **Impact:** 4 — prevents memory bloat over time
- **Effort:** 3 — systematic cleanup pass
- **Risk:** 1 — defensive

**Success Criterion:** No orphan event listeners after 10 page navigations. Periodic timers properly cleaned.

---

### 39. Ahmad Khalil — Rate Limiting Expert

**Focus:** Are public endpoints protected?

**Recommendation:** The middleware has CSRF protection but no rate limiting on API endpoints. A malicious bot could flood `/api/tasks` with thousands of creates. Add a **simple in-memory rate limiter**: 60 requests/minute per IP for write operations, 200/minute for reads. Store counters in a `Map<string, {count, resetAt}>`. Reset every 60 seconds. This is sufficient for a single-user add-on.

- **Impact:** 3 — prevents resource exhaustion
- **Effort:** 2 — middleware addition
- **Risk:** 1 — rate limiter can be tuned up if too restrictive

**Success Criterion:** 61st write request in 60 seconds returns 429. Rate limit header `X-RateLimit-Remaining` returned.

---

### 40. Jenny Park — Backup & Recovery Expert

**Focus:** Is data recoverable?

**Recommendation:** The backup endpoint (`/api/backup`) creates a SQLite dump but it's manual-only. Add **auto-backup on startup**: before `ensureSchema()` runs, copy the current DB file to `.data/backups/meitheal-{timestamp}.db`. Keep max 5 backups (FIFO delete). This means: if a migration corrupts data, the previous version is always available. The HA Supervisor backup API already backs up the add-on data directory.

- **Impact:** 3 — safety net for schema migrations
- **Effort:** 2 — file copy + rotation
- **Risk:** 1 — disk space (5 copies)

**Success Criterion:** `/api/health` shows last backup time. `.data/backups/` has ≤5 files. Files rotate on startup.

---

## Panel 9: Gamification & Motivation (Personas 41–45)

### 41. Dr. Yu Yamamoto — Gamification Psychologist

**Focus:** Is the gamification system motivating or punishing?

**Recommendation:** The current streak system resets to 0 on a single missed day. This is **punishing** and known to cause ADHD avoidance loops ("I already broke my streak, why bother?"). Implement a **streak freeze**: allow 1 grace day per week where the streak doesn't reset. Track in `task_templates.streak_freezes_used` (INTEGER DEFAULT 0, resets weekly). This is how Duolingo maintains engagement.

- **Impact:** 4 — prevents streak-anxiety spiral
- **Effort:** 2 — conditional in streak logic
- **Risk:** 1 — more forgiving, never punishing

**Success Criterion:** Missing 1 day per week doesn't reset streak. Streak badge shows ❄️ when freeze was used.

---

### 42. Daniela Russo — Achievement System Designer

**Focus:** Are achievements earned or hollow?

**Recommendation:** The achievement engine exists (`achievement-engine.ts`) but needs progression tiers: Bronze (easy), Silver (moderate), Gold (hard), Platinum (mastery). Example: "Complete 1 task" → Bronze. "Complete 100 tasks" → Silver. "Complete 1000" → Gold. "Complete 10,000" → Platinum. Add a `tier` column to achievements and show tier-appropriate styling (color, icon size) in the gamification page.

- **Impact:** 2 — deeper engagement loop
- **Effort:** 2 — tier data + styling
- **Risk:** 1 — additive

**Success Criterion:** Achievements display with tier styling. Progress toward next tier visible.

---

### 43. Ben Cooper — Points Economy Designer

**Focus:** Is there a point system?

**Recommendation:** Meitheal has XP but no **spend mechanism**. Add cosmetic rewards: custom themes, sidebar accent colors, card style variants. Unlock at XP thresholds (100 XP = new theme, 500 XP = custom accent, 1000 XP = card animation style). This gives XP purpose beyond a number. Store unlocks in `app_settings` with key `unlocked_rewards`.

- **Impact:** 2 — gives XP meaning
- **Effort:** 2 — unlock logic + theme variants
- **Risk:** 1 — cosmetic only

**Success Criterion:** Reaching 100 XP unlocks a theme selectable in Personal settings.

---

### 44. Hannah Brooks — Social Accountability Expert

**Focus:** Can Meitheal support multiple users?

**Recommendation:** The `custom_users` table and `assigned_to` column exist but there's no **user switching or multi-user dashboard**. For household task sharing (the HA use case), add a `/api/users/dashboard` endpoint that shows task counts by assignee. Display on the dashboard as an "Assignee Overview" widget. This enables family task management without building full auth.

- **Impact:** 3 — core HA household use case
- **Effort:** 2 — query + widget
- **Risk:** 1 — read-only

**Success Criterion:** Dashboard shows assignee cards with pending/active/complete counts per user.

---

### 45. Oscar Reyes — Reward Schedule Expert

**Focus:** Is the celebration feedback satisfying?

**Recommendation:** Task completion currently updates the status and closes the modal. Add a **micro-celebration**: confetti burst (canvas or CSS) on completing a task, streak milestone toasts, and a "🎯 Daily goal reached!" banner when all Smart Today tasks are done. These should respect `prefers-reduced-motion` (show text-only celebration instead). The celebration intensity should scale with task importance (P1 = big confetti, P4 = subtle checkmark).

- **Impact:** 3 — dopamine reinforcement
- **Effort:** 2 — canvas confetti + conditional triggers
- **Risk:** 1 — optional, motion-safe

**Success Criterion:** Completing a P1 task shows confetti. Completing all daily tasks shows banner. Reduced motion shows text-only.

---

## Panel 10: Technical Architecture & Performance (Personas 46–50)

### 46. Dr. Klaus Weber — SQLite Performance Expert

**Focus:** Will the schema scale to 100K tasks?

**Recommendation:** The `ensureSchema()` function runs 50+ `CREATE INDEX IF NOT EXISTS` statements on every startup. On a 100K-row database, this takes measurable time even though the indexes already exist. **Hard cut: gate the entire migration block behind a schema version check** (see #25). Also: the `tasks` table has 30+ columns — some queries fetch `SELECT *` which includes `agent_scratchpad` (potentially large JSON). Add explicit column lists to all SELECT statements.

- **Impact:** 3 — faster boot, less memory
- **Effort:** 2 — schema versioning + SELECT refinement
- **Risk:** 1 — optimization only

**Success Criterion:** Boot time with 100K tasks is <2 seconds. No `SELECT *` on tasks table.

---

### 47. Mei Lin — Astro Framework Expert

**Focus:** Is the app Astro-native?

**Recommendation:** Several components use `<script>` with inline DOM manipulation that could be Astro actions or server islands. For Astro 6, consider: (1) Replace settings `fetch()/PUT` patterns with Astro Actions (type-safe server functions), (2) Use Server Islands for the dashboard stats section (stream slow data), (3) Move toast/notification logic to a shared Astro middleware response header pattern. This is a progressive modernization — not a rewrite.

- **Impact:** 3 — unlocks Astro 6 benefits
- **Effort:** 4 — incremental migration
- **Risk:** 2 — framework API surface

**Success Criterion:** At least 3 API routes converted to Astro Actions. Dashboard uses Server Islands for stats.

---

### 48. Robert Keller — TypeScript Strict Mode Advocate

**Focus:** Is type safety comprehensive?

**Recommendation:** The codebase uses `Record<string, unknown>` extensively for database rows. Create proper typed interfaces for each table: `TaskRow`, `AreaRow`, `GoalRow`, `ProjectRow`, `TemplateRow`. Use Drizzle ORM's type inference (already partially set up) instead of manual `toTask()` mappers. This catches column name typos at compile time, not runtime.

- **Impact:** 3 — catches bugs before deployment
- **Effort:** 3 — type definitions + query updates
- **Risk:** 1 — type-only changes

**Success Criterion:** Zero `Record<string, unknown>` casts in persistence layer. All DB rows have typed interfaces.

---

### 49. Samantha Lee — n8n Native Integration Expert

**Focus:** How should Meitheal expose data to n8n natively?

**Recommendation:** Beyond webhooks (#27), Meitheal should be an **n8n community node** — a native node package that n8n users install to interact with Meitheal. The node would live in `integrations/n8n/` (Apache 2.0 license) and provide: Trigger (task created/completed), Action (create task, update task, search tasks). It communicates via Meitheal's REST API. This is the n8n-native way to integrate (vs. generic HTTP Request nodes).

- **Impact:** 3 — native n8n ecosystem presence
- **Effort:** 4 — separate npm package + n8n SDK
- **Risk:** 2 — maintenance burden of separate package

**Success Criterion:** `integrations/n8n/` contains a functional n8n community node. Installable in n8n instance.

---

### 50. Dr. James O'Sullivan — DevOps & Reliability Engineer

**Focus:** Is the deployment pipeline production-ready?

**Recommendation:** CI currently builds Docker images on version tags but has no: (1) Automated E2E tests in the pipeline, (2) Image size optimization (multi-stage build?), (3) Health check in Dockerfile (`HEALTHCHECK CMD`), (4) Graceful shutdown handling in `run.sh`. Add: (1) `pnpm test` step before Docker build, (2) Multi-stage Dockerfile (build in node:22, run in node:22-slim), (3) `HEALTHCHECK` instruction, (4) `SIGTERM` trap in `run.sh` for clean shutdown.

- **Impact:** 3 — deployment reliability
- **Effort:** 2 — Dockerfile + CI improvements
- **Risk:** 1 — infrastructure hardening

**Success Criterion:** CI runs tests before build. Docker image has HEALTHCHECK. `run.sh` handles SIGTERM gracefully.

---

## Summary — Top 10 Priorities

| Rank | # | Persona | Recommendation | Impact | Effort |
|------|---|---------|---------------|--------|--------|
| 1 | 21 | Offline Architect | Field-family merge strategy | 5 | 4 |
| 2 | 3 | Working Memory | Expand OfflineTask to full schema | 5 | 3 |
| 3 | 1 | ADHD Psychologist | `quick_capture` task kind | 5 | 1 |
| 4 | 2 | Productivity Coach | Focus Stack (top 3 tasks) | 5 | 3 |
| 5 | 18 | HA WebSocket | Reconnect + heartbeat hardening | 4 | 2 |
| 6 | 4 | Executive Function | Bot review queue page | 4 | 3 |
| 7 | 26 | Multi-Agent | Handoff state machine completion | 4 | 2 |
| 8 | 33 | Accessibility | WCAG 2.2 AA compliance pass | 4 | 3 |
| 9 | 17 | HA Automation | Entity registration (sensors) | 4 | 3 |
| 10 | 27 | n8n Architect | Webhook triggers for n8n | 4 | 3 |
