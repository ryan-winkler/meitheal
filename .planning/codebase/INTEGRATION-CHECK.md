# API Route Audit — Orphaned Routes

> Last audited: 2026-03-20
> Method: `grep -rn` cross-reference against all `fetch()` calls in `lib/`, `pages/`, `components/`, `domains/`

## ❌ Zero Frontend Consumers (14 routes)

Routes with no discovered frontend `fetch()` call. Candidates for removal or documentation as external-only.

| Route | Purpose | Recommendation |
|-------|---------|---------------|
| `a2a/message` | A2A protocol message handler | 🟡 Keep — external protocol endpoint |
| `a2a/tasks/[id]` | A2A task operations | 🟡 Keep — external protocol endpoint |
| `backup/complete` | Backup completion | 🔴 Remove — stub, no backup UI |
| `backup/prepare` | Backup preparation | 🔴 Remove — stub, no backup UI |
| `export/tasks.ics` | iCal export | 🟡 Keep — useful for calendar integration |
| `grocy/stock` | Grocy stock levels | 🔴 Remove — no Grocy stock UI |
| `ha/status` | HA status check | 🔴 Remove — redundant with `ha/connection` |
| `integrations/calendar/confirmation` | CalDAV handshake | 🟡 Keep — may be called from CalDAV flow |
| `nfc/complete` | NFC task completion | 🔴 Remove — no NFC UI exists |
| `parse-task` | NLP task parsing | 🔴 Remove — stub, no NLP UI |
| `review/velocity` | Velocity metrics | 🟡 Keep — review page may use SSR |
| `review/weekly` | Weekly review data | 🟡 Keep — review page may use SSR |
| `tasks/proposals` | AI task proposals | 🔴 Remove — stub, no proposals UI |
| `tasks/[id]/accept-proposal` | Accept AI proposal | 🔴 Remove — stub, no proposals UI |
| `today-summary` | LLM-generated summary | 🔴 Remove — stub, no summary UI |
| `todo/items` | HA todo list items | 🟡 Keep — may be called by HA integration |

### Summary: 8 routes recommended for removal, 8 recommended to keep with documentation

## ✅ Consumed Routes (active frontend references)

| Route | Consumers | Status |
|-------|-----------|--------|
| All `tasks/*` CRUD | `task-api-client.ts` | Active |
| `areas/*`, `goals/*`, `projects/*` | `task-api-client.ts`, controllers | Active |
| `lanes/*` | `kanban-controller.ts` | Active |
| `labels/*` | Controllers + components | Active |
| `settings`, `features` | Settings page | Active |
| `search` | `search-hub-controller.ts` | Active |
| `ha/*` (connection, calendars, agents, etc.) | HA integration controllers | Active |
| `integrations/*` | Settings integrations panel | Active |
| `grocy/*` (settings, sync, test, auto-key) | Grocy integration panel | Active |
| `frameworks/*` | Framework wizard | Active |
| `gamification` | Gamification page | Active |
| `habits` | Habits controller | Active |
| `pomodoro` | Pomodoro controller | Active |
| `rules/*` | Rules engine | Active |
| `reminders` | Reminder system (33 refs) | Active |
| `sse` | Server-sent events (139 refs) | Active |
| `templates` | Task templates (50 refs) | Active |
| `export/database.sqlite`, `settings.json`, `tasks.json`, `tasks.csv` | Export/import UI | Active |
| `saved-filters` | Filter presets | Active |
| `users/*` | User management | Active |
| `unfurl` | Link unfurling | Active |
| `mcp` | MCP protocol endpoint | Active — external |
| `v1/*` | Vikunja v1 compat | Active — external |

## External-Only Routes (no frontend consumer expected)

| Route | Protocol |
|-------|---------|
| `v1/*` (8 routes) | Vikunja v1 API compatibility |
| `a2a/*` (3 routes) | Agent-to-Agent protocol |
| `mcp` | Model Context Protocol |
| `health` | Health check (monitoring) |
