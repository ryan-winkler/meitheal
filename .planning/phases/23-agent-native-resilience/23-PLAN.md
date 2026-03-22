# Phase 23: Agent-Native Resilience — Plan

**Goal:** Make all API errors self-correcting for agents (RFC 9457) and all rate limits IETF-standard for graceful backoff.

## Tasks

### Task 1: RFC 9457 Problem+JSON Error Helpers
**File:** `apps/web/src/lib/api-response.ts`

1. Add `ProblemDetail` interface matching RFC 9457 (`type`, `title`, `status`, `detail`, `instance`, `traceId`)
2. Add `InvalidParam` interface (`name`, `reason`)
3. Implement `apiProblem(opts)` → returns `application/problem+json` response
4. Implement `apiValidationError(zodError, instance)` → maps `ZodError.issues` to `invalidParams[]`
5. Implement `apiRateLimited(retryAfter, detail)` → problem+json 429
6. Refactor `apiError()` to wrap `apiProblem()` internally — keep signature stable
7. Include `error` alias in response body for backward compat (D3)
8. Include `traceId` in responses when available (D5)

### Task 2: OpenAPI ProblemDetail Schema
**File:** `apps/web/scripts/generate-openapi.mjs`

1. Add `ProblemDetail` component schema (RFC 9457 fields + `invalidParams` extension)
2. Add default `4xx`/`5xx` error response referencing `ProblemDetail` in OpenAPI components
3. The `additionalProperties: false` enforcement will auto-apply via existing `enforceStrictSchemas()`

### Task 3: IETF Rate Limit Headers
**File:** `apps/web/src/middleware.ts`

1. Update `applyRateLimitHeaders()`:
   - Keep `x-ratelimit-*` headers (backward compat, D1)
   - Add `RateLimit: limit=N, remaining=N, reset=N` (IETF structured field)
   - Add `RateLimit-Policy: N;w=60` (policy descriptor)
   - `reset` = seconds until reset (not epoch timestamp, D4)
2. Update general 429 response (line 263): use `apiRateLimited()` → problem+json
3. Update bot 429 response (line 286): use `apiRateLimited()` → problem+json
4. Ensure `Retry-After` header stays (already correct)

### Task 4: Documentation & Verification
1. Update OpenAPI spec — regenerate
2. Update KCS guide with problem+json and rate limit sections
3. Run `pnpm check` — must pass clean
4. Verify `application/problem+json` content-type in rate limit responses

## Acceptance Criteria
- [ ] `apiError("msg", 400)` returns `application/problem+json` with RFC 9457 fields
- [ ] `apiValidationError(zodErr)` maps `.issues[]` to `invalidParams[]`
- [ ] 429 responses are `problem+json` with `Retry-After` and IETF `RateLimit` headers
- [ ] `x-ratelimit-*` headers still present (backward compat)
- [ ] `pnpm check` passes
- [ ] OpenAPI spec includes `ProblemDetail` schema

## Dependencies
- None — standalone changes to api-response.ts and middleware.ts
