# Phase 23: Agent-Native Resilience — Research

## Scope

**RFC 9457 (`problem+json`)** self-correcting errors + **IETF RateLimit headers** for graceful agent backoff.

---

## 1. Current State: `api-response.ts`

```typescript
export function apiError(error: string, status: number = 500): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "content-type": "application/json" },
  })
}
```

- **21 lines**, simple `{ error: string }` shape
- ~50+ call sites across `apps/web/src/pages/api/`
- No structured validation errors — LLMs get a flat string and have to _guess_ what went wrong
- **No Zod `safeParse` usage at API layer** — most routes do manual field checks via `if (!name) return apiError("name is required", 400)`

### Key Insight

The existing pattern means most API errors are manual string checks, not Zod schemas. So we need:
1. A new `apiProblem()` helper that produces RFC 9457 responses
2. A Zod-aware variant `apiValidationError()` that maps `ZodError.issues` to `invalidParams[]`
3. The existing `apiError()` stays — it becomes a thin wrapper around `apiProblem()` for backward compat
4. API routes can gradually adopt Zod schemas and use `apiValidationError()` when ready

---

## 2. Current State: Rate Limiter

Located in `middleware.ts` (lines 50-123):

### Two-Tier Architecture
| Tier | Limit | Window | Scope |
|------|-------|--------|-------|
| General | 300/min | 60s | All `/api/` requests per IP |
| Bot | 60/min | 60s | Bot mutation endpoints (`/accept-proposal`, `/api/mcp`) per IP |

### Current Headers (Non-Standard)
```
x-ratelimit-limit: 300
x-ratelimit-remaining: 299
x-ratelimit-reset: 1711133880  (unix epoch seconds)
```

Plus `retry-after` on 429 responses (already IETF compliant ✅).

### IETF Draft v10 (Sept 2025): Structured Fields
The latest draft (`draft-ietf-httpapi-ratelimit-headers-10`) uses:

```
RateLimit: limit=300, remaining=299, reset=60
RateLimit-Policy: 300;w=60
```

Key differences from current:
- **`reset`** = seconds until reset (not epoch timestamp)
- **Consolidated** into single `RateLimit` header using RFC 8941 structured fields
- **`RateLimit-Policy`** describes the quota policy
- `Retry-After` on 429 is still the primary backoff signal

### Migration Strategy
1. Emit BOTH old `x-ratelimit-*` and new `RateLimit`/`RateLimit-Policy` headers (dual-write)
2. Existing consumers (n8n, custom scripts) won't break
3. New IETF-aware consumers (Gemini, OpenAI, agent frameworks) will use the standard headers
4. Log deprecation notice for `x-ratelimit-*` — can remove in v1.0

---

## 3. RFC 9457 Problem Details Format

```json
{
  "type": "https://meitheal.local/problems/validation-error",
  "title": "Validation Error",
  "status": 400,
  "detail": "2 fields failed validation",
  "instance": "/api/tasks/create",
  "invalidParams": [
    { "name": "title", "reason": "Required" },
    { "name": "priority", "reason": "Must be between 1 and 5" }
  ]
}
```

Standard fields: `type`, `title`, `status`, `detail`, `instance`
Extension fields: `invalidParams[]` (for Zod), `traceId` (for correlation)

### Content-Type
Must return `application/problem+json` (not `application/json`).

---

## 4. Impact Analysis

### Files to Modify
| File | Change |
|------|--------|
| `apps/web/src/lib/api-response.ts` | Add `apiProblem()`, `apiValidationError()`, `apiRateLimited()` |
| `apps/web/src/middleware.ts` | Update `applyRateLimitHeaders()`, update 429 responses to problem+json |
| `apps/web/scripts/generate-openapi.mjs` | Add `ProblemDetail` schema, update error response schemas |

### Files NOT Modified (Yet)
- Individual API routes — they keep using `apiError()` which now wraps `apiProblem()` internally
- The Zod integration is opt-in — routes can adopt `apiValidationError()` gradually

### Backward Compatibility
- `apiError("message", 400)` still works — internally returns `problem+json` with the string as `detail`
- Response shape changes from `{ error: "..." }` to `{ type, title, status, detail }` — **BREAKING for clients parsing `.error`**
- Mitigation: keep `error` as a legacy alias field in the response

---

## 5. Decision Log

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | Dual-write rate limit headers (old + IETF) | Zero-break migration |
| D2 | Keep `apiError()` as public API | 50+ call sites, no mass refactor |
| D3 | Add `error` alias in problem+json responses | Backward compat for existing consumers |
| D4 | `reset` as seconds-remaining (IETF) not epoch | Spec compliance, simpler for agents |
| D5 | `traceId` in problem responses | Enables agent → log correlation |
| D6 | `invalidParams` not `errors` | Matches RFC 9457 validation extension pattern |
