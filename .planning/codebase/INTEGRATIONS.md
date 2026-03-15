# External Integrations

**Analysis Date:** 2026-03-15

## APIs & External Services

**Home Assistant (Primary):**
- WebSocket API — Real-time entity state, events, service calls
  - Client: `home-assistant-js-websocket` via `@domains/ha/ha-connection.ts`
  - Auth: `SUPERVISOR_TOKEN` (auto-injected by HA Supervisor)
  - Services: `@domains/ha/ha-services.ts` (533 lines)
  - Startup: `@domains/ha/ha-startup.ts` (592 lines)
  - Users: `@domains/ha/ha-users.ts`
  - Events: `@domains/ha/ha-events.ts`

- Supervisor REST API — Add-on info, ingress path discovery
  - Client: `@lib/supervisor-fetch.ts` + `undici`
  - Auth: `SUPERVISOR_TOKEN` header
  - Endpoints used: `/addons/self/info`, `/core/api`

**HA Todo Lists:**
- Bidirectional sync with HA todo entities
  - Bridge: `@domains/todo/todo-bridge.ts` (596 lines)
  - Status mapping: `@domains/todo/todo-status-mapper.ts`

**HA Calendar:**
- Calendar entity sync for task scheduling
  - Bridge: `@domains/calendar/calendar-bridge.ts` (1,028 lines)
  - CalDAV: `@domains/calendar/caldav-client.ts`
  - Entity resolver: `@domains/calendar/resolve-calendar-entities.ts`

**Grocy (Optional):**
- Chore/task import from Grocy homelab manager
  - Bridge: `@domains/grocy/grocy-bridge.ts` (738 lines)
  - Mapper: `@domains/grocy/grocy-mapper.ts`
  - API routes: `apps/web/src/pages/api/grocy/`

**AI / LLM:**
- HA Assist integration for natural language task parsing
  - Service: `@domains/ai/ha-assist-service.ts`
  - Context: `@domains/ai/ai-context-service.ts`
  - Python API: `meitheal-hub/llm_api.py`
  - API route: `apps/web/src/pages/api/parse-task.ts`

**Vikunja v1 Compatibility:**
- Drop-in compatible REST API for Vikunja clients
  - Store: `@domains/integrations/vikunja-compat/store.ts` (596 lines)
  - API routes: `apps/web/src/pages/api/v1/`

## Data Storage

**Database:**
- SQLite via libsql (`@libsql/client`)
  - Schema: `apps/web/drizzle/` (Drizzle ORM migrations)
  - Store: `@domains/tasks/persistence/store.ts` (905 lines)
  - Repository: `@domains/tasks/persistence/task-repository.ts` (892 lines)
  - Connection: File-based, path configured via environment

**Offline Storage:**
- IndexedDB (browser-side) via `@domains/offline/offline-store.ts`
- Sync engine: `@domains/offline/sync-engine.ts`
- Tab sync: `@domains/offline/tab-sync.ts`

**File Storage:**
- Local filesystem only (SQLite DB file)
- Backup: `apps/web/src/pages/api/backup/`
- Export: `apps/web/src/pages/api/export/` (JSON, CSV, iCal)

## Authentication & Identity

**Auth Provider:**
- Home Assistant Ingress (primary) — `@domains/auth/ingress.ts`, `@domains/auth/ingress-policy.ts`
  - `SUPERVISOR_TOKEN` + `X-Ingress-Path` header
  - User resolved from HA via `getHassUserId()`
  - Admin check via `isHassAdmin()`
- CSRF protection in `ingress-policy.ts` via `buildSecurityHeaders()`
- No standalone auth (HA-first design)

## Monitoring & Observability

**Logging:**
- `@meitheal/domain-observability` package
  - `createLogger()` — structured JSON to stdout (Loki-compatible)
  - Schema: `{ ts, level, event, domain, component, request_id, message, metadata }`
  - Secret redaction via `defaultRedactionPatterns`

**Health:**
- `apps/web/src/pages/api/health.ts` — Health check endpoint

**Error Tracking:**
- No external service — errors logged to stdout

## CI/CD & Deployment

**CI Pipeline:**
- GitHub Actions (`.github/workflows/ci.yml`)
  - `governance` job: Required files, CSS brace balance, version sync
  - `typecheck-and-tests` job: `pnpm check` + `pnpm test`

**Deployment:**
- Push `v*` tag → triggers Docker build
  - Image: `ghcr.io/coolock-village/meitheal-{arch}`
  - HA Supervisor auto-updates from GHCR

**Code Review:**
- CodeRabbitAI enabled via `.coderabbit.yaml`

## Webhooks & Callbacks

**Incoming:**
- WebMCP: `apps/web/src/pages/api/mcp.ts` (560 lines)
- A2A (Agent-to-Agent): `apps/web/src/pages/api/a2a/`
- NFC: `apps/web/src/pages/api/nfc/`
- Node-RED: `apps/web/src/pages/api/integrations/nodered/`

**Outgoing:**
- Webhook emitter: `packages/integration-core/src/webhook-emitter.ts`
- Config: `packages/integration-core/src/webhook-config.ts`
- Dispatcher: `@lib/webhook-dispatcher.ts`

## SSE (Server-Sent Events)

- `apps/web/src/pages/api/sse.ts` — Real-time task updates to browser

---

*Integration audit: 2026-03-15*
