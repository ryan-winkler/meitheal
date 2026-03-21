# Integrations — Meitheal

**Mapped:** 2026-03-21 | **Confidence:** HIGH

## Home Assistant (Primary)

| Integration | Path | Protocol |
|-------------|------|----------|
| **Supervisor API** | `apps/web/src/lib/supervisor-fetch.ts` | REST (`SUPERVISOR_TOKEN`) |
| **WebSocket** | `apps/web/src/domains/ha/ha-connection.ts` | WS via `home-assistant-js-websocket` |
| **Events** | `apps/web/src/domains/ha/ha-events.ts` | State change subscriptions |
| **Services** | `apps/web/src/domains/ha/ha-services.ts` | HA service calls |
| **Users** | `apps/web/src/domains/ha/ha-users.ts` | HA user resolution |
| **Entities** | `apps/web/src/domains/ha/ha-entities.ts` | Entity state reading |
| **Calendar** | `apps/web/src/domains/calendar/calendar-bridge.ts` | HA calendar entity sync |
| **Todo** | `apps/web/src/domains/todo/todo-bridge.ts` | HA todo list sync |
| **Assist** | `apps/web/src/domains/ai/ha-assist-service.ts` | Voice assistant AI |
| **Custom Integration** | `integrations/home-assistant/` | Python — sensors, todo, backup, LLM API, MCP server |

### HA Custom Component Modules

| Module | Purpose |
|--------|---------|
| `__init__.py` | Integration setup + coordinator |
| `sensor.py` | Task count sensors |
| `todo.py` | Task ↔ HA todo entity bridge |
| `backup.py` | HA backup platform |
| `llm_api.py` | LLM conversation tool |
| `mcp_server.py` | MCP server for AI agents |
| `config_flow.py` | HA config flow UI |
| `intents.py` | Voice assistant intents |
| `device_trigger.py` | Automation triggers |
| `diagnostics.py` | HA diagnostics dump |
| `repairs.py` | HA repair issues |

## Calendar / CalDAV

| API Route | Service |
|-----------|---------|
| `/api/integrations/calendar/sync` | Calendar sync execution |
| `/api/integrations/calendar/status` | Sync status |
| `/api/integrations/calendar/caldav-credentials` | CalDAV credential management |
| `/api/integrations/calendar/confirmation` | Sync confirmation |

Implementation: `apps/web/src/domains/calendar/caldav-client.ts`

## Grocy

| API Route | Service |
|-----------|---------|
| `/api/grocy/sync` | Grocy ↔ Meitheal task sync |
| `/api/grocy/settings` | Grocy connection settings |
| `/api/grocy/test` | Connection test |
| `/api/grocy/auto-key` | Auto-discover API key |

Implementation: `apps/web/src/domains/grocy/grocy-bridge.ts`, `grocy-mapper.ts`

## n8n Workflows

| API Route | Service |
|-----------|---------|
| `/api/integrations/n8n/health` | n8n instance health |
| `/api/integrations/n8n/workflows` | Workflow listing |

Implementation: `apps/web/src/lib/n8n-fetch.ts`

## Node-RED

| API Route | Service |
|-----------|---------|
| `/api/integrations/nodered/status` | Node-RED status |
| `/api/integrations/nodered/flows` | Flow listing |
| `/api/integrations/nodered/deploy` | Flow deployment |

Implementation: `apps/web/src/lib/nodered-admin.ts`

## Webhooks

| Component | Path |
|-----------|------|
| Webhook emitter | `packages/integration-core/src/webhook-emitter.ts` |
| Webhook config | `packages/integration-core/src/webhook-config.ts` |
| Test webhook | `/api/integrations/test-webhook` |
| Test event | `/api/integrations/test-event` |

## Agent-to-Agent (A2A) Protocol

| API Route | Purpose |
|-----------|---------|
| `/api/a2a/agent-card` | Agent discovery (`.well-known/agent.json` redirects here) |
| `/api/a2a/message` | Agent message endpoint |
| `/api/a2a/tasks/[id]` | Task status for agents |

Implementation: `packages/integration-core/src/a2a-handler.ts`

## MCP (Model Context Protocol)

| Endpoint | Purpose |
|----------|---------|
| `/api/mcp` | MCP server endpoint |
| `public/.well-known/mcp.json` | MCP discovery |

## Vikunja v1 Compatibility

| API Route | Purpose |
|-----------|---------|
| `/api/v1/projects/` | Project CRUD (Vikunja compat) |
| `/api/v1/tasks/` | Task CRUD (Vikunja compat) |
| `/api/v1/labels/` | Label CRUD (Vikunja compat) |
| `/api/v1/users/` | User info (Vikunja compat) |

## Database

| Aspect | Detail |
|--------|--------|
| **Engine** | SQLite via `@libsql/client` |
| **File** | `data.db` (project root, gitignored) |
| **Migrations** | Runtime schema-ensure pattern in each service (`ensureSchema()`) |
| **Drift check** | `apps/web/scripts/schema-drift-check.mjs` |

## Authentication

| Mechanism | Implementation |
|-----------|---------------|
| **HA Ingress** | `X-Ingress-Path` header detection via `ingress-policy.ts` |
| **CSRF** | Token-based, managed by `domain-auth` |
| **License Key** | Ed25519 JWT — offline verification, no phone-home |
| **Passkey** | WebAuthn support (spec: `auth-passkey.spec.ts`) |
