# External Integrations

**Analysis Date:** 2026-03-20

## AI Integration Surfaces (3 Protocols)

### MCP — Model Context Protocol

**Astro TS Server** (`apps/web/src/pages/api/mcp.ts`):
- 17 tools via JSON-RPC 2.0 over HTTP POST
- Protocol version: `2024-11-05`
- Discovery: `/.well-known/mcp.json`
- Tools: createTask, searchTasks, completeTask, updateTask, deleteTask, getTask, getCalendarEvents, getUpcoming, syncCalendar, getOverdueTasks, getTodaysTasks, getTaskSummary, batchComplete, assignTask, listUsers, linkTask, unlinkTask, getTaskLinks
- Delegates to internal REST API (thin adapter pattern)

**HA Python MCP Server** (`integrations/home-assistant/custom_components/meitheal/mcp_server.py`):
- 524 lines, runs inside HA custom component
- Additional tools not in TS: `meitheal_list_areas`, `meitheal_list_goals`, `meitheal_move_task`, `meitheal_set_goal_progress`
- Uses coordinator data directly (no HTTP intermediary)

### A2A — Agent-to-Agent Protocol

**Handler** (`packages/integration-core/src/a2a-handler.ts`):
- HTTP+JSON binding, protocol version 1.0
- 11 skills: task-management, task-search, framework-scoring, data-export, areas, labels, today-summary, habits, review-weekly, ha-calendar-sync, ha-entity-state
- Agent card: `/api/a2a/agent-card`
- Message endpoint: `/api/a2a/message`
- Skill routing via keyword extraction (no LLM-based intent)
- ⚠️ Skill handlers not fully wired — discovery works, execution is partial

### HA LLM API

**LLM Tools** (`integrations/home-assistant/custom_components/meitheal/llm_api.py`):
- 21 tools registered as HA LLM API provider
- Rich descriptions with voice-optimized trigger phrases
- Unique tools: `meitheal_daily_briefing` (weather + people + tasks), `meitheal_remove_from_todo_list`, `meitheal_list_areas`, `meitheal_list_goals`, `meitheal_move_task`, `meitheal_set_goal_progress`
- Uses coordinator data directly (in-process, no HTTP)

## Tool Coverage Matrix

| Tool | MCP TS | MCP Python | LLM API | A2A |
|------|--------|------------|---------|-----|
| Search Tasks | ✅ | ✅ | ✅ | ✅ |
| Create Task | ✅ | ✅ | ✅ | ✅ |
| Complete Task | ✅ | ✅ | ✅ | ✅ |
| Update Task | ✅ | ✅ | ✅ | ✅ |
| Delete Task | ✅ | ✅ | ✅ | ❌ |
| Get Task | ✅ | ✅ | ✅ | ❌ |
| Get Overdue | ✅ | ✅ | ✅ | ❌ |
| Get Today | ✅ | ✅ | ✅ | ✅ |
| Task Summary | ✅ | ✅ | ✅ | ❌ |
| Calendar Events | ✅ | ✅ | ✅ | ✅ |
| Upcoming | ✅ | ✅ | ✅ | ❌ |
| Sync Calendar | ✅ | ✅ | ❌ | ✅ |
| Batch Complete | ✅ | ✅ | ✅ | ❌ |
| Assign Task | ✅ | ❌ | ❌ | ❌ |
| List Users | ✅ | ❌ | ❌ | ❌ |
| Link/Unlink Tasks | ✅ | ✅ | ✅ | ❌ |
| List Areas | ❌ | ✅ | ✅ | ✅ |
| List Goals | ❌ | ✅ | ✅ | ❌ |
| Move Task | ❌ | ✅ | ✅ | ❌ |
| Set Goal Progress | ❌ | ✅ | ✅ | ❌ |
| Daily Briefing | ❌ | ❌ | ✅ | ❌ |
| Framework Scoring | ❌ | ❌ | ❌ | ✅ |
| Data Export | ❌ | ❌ | ❌ | ✅ |
| Habits | ❌ | ❌ | ❌ | ✅ |
| Weekly Review | ❌ | ❌ | ❌ | ✅ |

## Home Assistant Integration

**Custom Component** (`integrations/home-assistant/custom_components/meitheal/`):
- Config flow: `config_flow.py`
- Coordinator: `coordinator.py` (data update, HTTP client to Astro)
- Entities: `todo.py` (TodoListEntity), `sensor.py`
- Services: `services.yaml` (create_task, complete_task)
- Device Triggers: `device_trigger.py`
- Intents: `intents.py` + `custom_sentences/`
- Diagnostics: `diagnostics.py`
- Backup: `backup.py`
- Repairs: `repairs.py`
- Manifest: `integration_type: "hub"`, `quality_scale: "platinum"`

**HA WebSocket**: 9 references — connection status, entity state reads
**Ingress**: 336 references — deep embedding, fetch monkey-patch, CSP headers
**Supervisor API**: 57 references — add-on lifecycle, info, discovery

## External Services

**Grocy** (`apps/web/src/domains/grocy/`):
- Stock management, meal planning
- API proxy through Meitheal

**CalDAV** (`apps/web/src/domains/calendar/`):
- External calendar sync
- Tested in settings controller

**n8n** (webhook integration):
- Outbound webhooks for automation
- Configured in settings

---

*Integration audit: 2026-03-20*
