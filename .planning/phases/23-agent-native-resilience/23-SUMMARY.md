# Phase 23: Agent-Native Resilience — Summary

All tasks complete. RFC 9457 problem+json errors and IETF rate limit headers implemented.

## Changes

| File | Change |
|------|--------|
| `apps/web/src/lib/api-response.ts` | Rewritten: `apiProblem()`, `apiValidationError()`, `apiRateLimited()`, `apiError()` backward-compat |
| `apps/web/src/middleware.ts` | IETF `RateLimit`/`RateLimit-Policy` headers, 429s → problem+json |
| `apps/web/scripts/generate-openapi.mjs` | `ProblemDetail` schema replaces `ErrorResponse` |
| `apps/web/public/openapi.yaml` | Regenerated (12 schemas, 120 ops) |
| `docs/kcs/agent-automation-guide.md` | RFC 9457 + IETF rate limit docs |

## Verification

- `astro check`: 0 new errors
- `generate-openapi.mjs`: ProblemDetail schema in output YAML
- Backward compat: `apiError("msg", 400)` still works, returns problem+json
