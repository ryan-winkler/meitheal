# Codebase Integrations — Meitheal

> Last refreshed: 2026-03-19

## Home Assistant (Primary Integration)

| Layer | Protocol | File |
|-------|----------|------|
| WebSocket API | `home-assistant-js-websocket` | `domains/ha/ha-connection.ts` |
| Entity discovery | WebSocket subscribe | `domains/ha/ha-entities.ts` |
| Event bus | WebSocket events | `domains/ha/ha-events.ts` |
| Service calls | WebSocket | `domains/ha/ha-services.ts` |
| User resolution | HA Supervisor API | `domains/ha/ha-users.ts` |
| Startup | Singleton init | `domains/ha/ha-startup.ts` |
| Calendar adapter | Collection API | `integration-core/src/home-assistant-calendar.ts` |
| Todo sync | HA todo entities | `domains/todo/todo-bridge.ts` |
| Assist/LLM | Conversation API | `domains/ai/ha-assist-service.ts` |
| Backup platform | Supervisor API | API: `/api/backup/*` |

**Ingress:** All traffic proxied through HA ingress iframe
- `domains/auth/ingress-policy.ts` — detects ingress context from `X-Ingress-Path`
- `middleware.ts` — rewrites HTML attributes with ingress prefix
- `Layout.astro` — monkey-patches `fetch()` for API calls
- `scripts/serve.mjs` — normalizes `//` paths

## CalDAV Calendar Sync

| Component | File |
|-----------|------|
| CalDAV client | `domains/calendar/caldav-client.ts` |
| Calendar bridge | `domains/calendar/calendar-bridge.ts` |
| Entity resolver | `domains/calendar/resolve-calendar-entities.ts` |
| API routes | `/api/integrations/calendar/sync`, `/status`, `/caldav-credentials`, `/confirmation` |

## Grocy (Grocery Management)

| Component | File |
|-----------|------|
| Grocy bridge | `domains/grocy/grocy-bridge.ts` |
| Grocy mapper | `domains/grocy/grocy-mapper.ts` |
| Adapter | `integration-core/src/grocy-adapter.ts` (539 lines) |
| API routes | `/api/grocy/stock`, `/sync`, `/settings`, `/test`, `/auto-key` |

## N8N Workflow Automation

| Component | File |
|-----------|------|
| API routes | `/api/integrations/n8n/health`, `/workflows` |
| Settings UI | `settings-integrations-n8n-controller.ts` (402 lines) |

## Node-RED

| Component | File |
|-----------|------|
| API routes | `/api/integrations/nodered/flows`, `/deploy`, `/status` |
| License | Apache-2.0 (API boundary) |

## A2A (Agent-to-Agent Protocol)

| Component | File |
|-----------|------|
| Agent card | `/api/a2a/agent-card.ts` |
| Message handler | `/api/a2a/message.ts` |
| Task handler | `/api/a2a/tasks/[id].ts` |
| Core handler | `integration-core/src/a2a-handler.ts` (379 lines) |

## Webhooks & Events

| Component | File |
|-----------|------|
| Webhook emitter | `integration-core/src/webhook-emitter.ts` (181 lines) |
| Webhook config | `integration-core/src/webhook-config.ts` (116 lines) |
| SSE endpoint | `/api/sse.ts` |
| Test endpoints | `/api/integrations/test-event.ts`, `/test-webhook.ts` |

## Vikunja Compatibility

| Component | File |
|-----------|------|
| Auth compat | `domains/integrations/vikunja-compat/auth.ts` |
| HTTP compat | `domains/integrations/vikunja-compat/http.ts` |
| Store | `domains/integrations/vikunja-compat/store.ts` |
| V1 API routes | `/api/v1/tasks.ts`, `/projects/`, `/labels/`, `/users/` |
| License | AGPL-3.0 only (cannot be commercially relicensed) |

## MCP & WebMCP

| Component | File |
|-----------|------|
| MCP endpoint | `/api/mcp.ts` |
| Well-known | `public/.well-known/mcp.json`, `jsondoc.json` |

## Export/Import

| Format | Route |
|--------|-------|
| CSV | `/api/export/tasks.csv.ts` |
| JSON | `/api/export/tasks.json.ts` |
| iCalendar | `/api/export/tasks.ics.ts` |
| SQLite backup | `/api/export/database.sqlite.ts` |
| Settings JSON | `/api/export/settings.json.ts`, `/api/import/settings.ts` |

## Offline/PWA

| Component | File |
|-----------|------|
| Service worker | `public/sw.js` |
| SW registration | `domains/offline/sw-register.ts` |
| Offline store | `domains/offline/offline-store.ts` |
| Sync engine | `domains/offline/sync-engine.ts` |
| Connectivity | `domains/offline/connectivity.ts` |
| Tab sync | `domains/offline/tab-sync.ts` |
