# Agent & Automation Infrastructure Guide

> KCS runbook for the build-time OpenAPI, AsyncAPI, llms.txt, MCP, and observability pipeline.

## Build Pipeline

```bash
# Runs automatically during `pnpm build`:
npm run generate:openapi   # → public/openapi.yaml (120 ops, 12 schemas)
npm run generate:llms      # → public/llms.txt + llms-full.txt
npm run generate:asyncapi  # → public/asyncapi.yaml (5 SSE + 6 webhook channels)
astro build                # → dist/
```

## Adding a New API Route

1. Create the Astro API route in `apps/web/src/pages/api/`
2. Add the route to the `paths` object in `apps/web/scripts/generate-openapi.mjs`
3. If the route introduces a new domain object, add it to the `schemas` object
4. Run `npm run generate:openapi` to verify
5. The MCP server picks up new tools automatically (no `mcp.ts` changes needed)

## Adding a New Event

1. For SSE events: add a channel under `sse/` in `generate-asyncapi.mjs`
2. For webhook events: add a channel under `webhook/` in `generate-asyncapi.mjs`
3. Run `npm run generate:asyncapi` to verify

## Adding a Custom MCP Tool

For tools that need special logic beyond simple CRUD dispatch:

1. Add a handler to the `customHandlers` Map in `apps/web/src/pages/api/mcp.ts`
2. Add the tool's description to `getCustomToolDescription()`
3. Add the tool's input schema to `getCustomToolSchema()`

## Agent Traceability

External systems should include these headers for observability:

```bash
curl -X POST http://localhost:4321/api/tasks/create \
  -H "Content-Type: application/json" \
  -H "X-Automation-Source: n8n" \
  -H "X-Agent-Id: morning-briefing-workflow" \
  -H "traceparent: 00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01" \
  -d '{"title": "Review weekly goals"}'
```

Valid `X-Automation-Source` values: `browser`, `n8n`, `nodered`, `mcp`, `agent`, `a2a`, `ha`, `api`, `webhook`, `cron`.

### W3C Traceparent

The `traceparent` header follows W3C Trace Context: `{version}-{traceId}-{spanId}-{traceFlags}`. When absent, middleware generates a new trace context. Trace IDs appear in structured logs (`trace_id`, `span_id`) for Grafana Alloy correlation.

### CloudEvents

All outbound webhooks include CNCF CloudEvents 1.0 headers (binary content mode): `ce-specversion`, `ce-id`, `ce-type` (e.g., `io.meitheal.task.created`), `ce-source`, `ce-time`, `ce-subject`. n8n/Node-RED parse these natively.

### JSON-LD

`<JsonLd>` component injects `<script type="application/ld+json">` with `SoftwareApplication` schema by default. Pages can pass custom schemas via the `jsonLd` prop on Layout.

### Strict Schemas

OpenAPI schemas enforce `additionalProperties: false` via post-processing in `generate-openapi.mjs`. The spec root has `x-strict: true`. This enables 100% deterministic LLM structured outputs.

### RFC 9457 Problem+JSON Errors

All API errors return `application/problem+json` (RFC 9457). Agents can self-correct by reading `invalidParams`:

```json
{
  "type": "https://meitheal.local/problems/validation-error",
  "title": "Validation Error",
  "status": 400,
  "detail": "2 fields failed validation",
  "traceId": "0af7651916cd43dd8448eb211c80319c",
  "invalidParams": [
    { "name": "title", "reason": "Required" },
    { "name": "priority", "reason": "Must be between 1 and 5" }
  ]
}
```

Helpers: `apiError()` (backward-compat), `apiProblem()` (full control), `apiValidationError(zodError)` (Zod mapping), `apiRateLimited()` (429s).

### IETF Rate Limit Headers

All API responses include dual rate limit headers:

| Header | Standard | Example |
|--------|----------|---------|
| `RateLimit` | IETF draft-10 | `limit=300, remaining=299, reset=60` |
| `RateLimit-Policy` | IETF draft-10 | `300;w=60` |
| `x-ratelimit-limit` | Legacy | `300` |
| `x-ratelimit-remaining` | Legacy | `299` |
| `x-ratelimit-reset` | Legacy | `1711133880` (epoch) |
| `Retry-After` | RFC 7231 (on 429) | `60` |

429 responses return problem+json. Two tiers: 300/min general, 60/min bot endpoints.

## Discovery Endpoints

| URL | Purpose |
|-----|---------|
| `GET /openapi.yaml` | Full OpenAPI 3.1 spec |
| `GET /asyncapi.yaml` | AsyncAPI 2.6 event spec |
| `GET /llms.txt` | Token-optimized router for LLMs |
| `GET /llms-full.txt` | Full system context for agents |
| `GET /.well-known/ai-plugin.json` | AI Studio plugin manifest |
| `POST /api/mcp` | JSON-RPC 2.0 MCP server |
| `GET /api/a2a/agent-card` | Agent-to-Agent discovery |

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| MCP returns empty tools list | `openapi.yaml` not found | Run `npm run generate:openapi` |
| Tool definitions stale in dev | 30s cache TTL | Wait or restart dev server |
| `X-Automation-Source` logged as `unknown` | Value not in allowlist | Use one of the documented values above |
| Build fails on `generate:llms` | Malformed `openapi.yaml` | Fix the spec, `generate-llms.mjs` wraps parsing in try/catch |
| CloudEvents headers missing | Old `webhook-emitter.ts` | Rebuild; headers are always emitted |
| `trace_id` missing in logs | No `traceparent` header | Middleware auto-generates; check log schema |

## Agentic Evaluation Tests

LLM-in-the-loop E2E tests in `tests/e2e/agentic-eval.spec.ts` prove the API stays AI-readable:

```bash
# Requires running Meitheal + Gemini API key
E2E_BASE_URL=http://localhost:4500 GEMINI_API_KEY=... pnpm --filter @meitheal/tests test e2e/agentic-eval.spec.ts
```

| Test | What it proves |
|------|---------------|
| Creates task from spec | LLM parses OpenAPI, identifies correct endpoint, formats valid JSON |
| Self-corrects after error | RFC 9457 `invalidParams` enables autonomous payload fixing |
| Discovers search endpoint | LLM navigates 120+ ops to find and use search with query params |

**Env vars:** `GEMINI_API_KEY` (required), `E2E_BASE_URL` (required), `AGENTIC_EVAL_MODEL` (optional, default: `gemini-2.0-flash`).
