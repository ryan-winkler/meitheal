---
type: "Decision"
title: "ADR-0009: Rate Limiting Strategy"
description: "Records the request rate-limiting strategy."
---

# ADR-0009: Rate Limiting Strategy

- **Status**: Accepted
- **Date**: 2026-02-28
- **Context**: Phase 29 security hardening, Persona audit #3/#5/#6

## Decision

### Implementation

- **In-memory rate limiter** in middleware.ts — 300 API requests per minute per IP
- **IP extraction**: `x-forwarded-for` → `x-real-ip` → `127.0.0.1` fallback
- **Scope**: API routes only (`/api/*`)
- **Response**: 429 with `retry-after` header and rate limit headers
- **Cleanup**: Periodic 5-minute sweep of expired entries

### Headers

All API responses include:

```
x-ratelimit-limit: 300
x-ratelimit-remaining: N
x-ratelimit-reset: Unix timestamp
```

### Trade-offs

- Per-isolate: resets on server restart (acceptable for HA add-on)
- No IP hashing (low risk — IPs are ephemeral in memory, not persisted)
- No IP allowlisting for internal HA traffic (future Phase 5)

## Consequences

- All API routes protected against burst abuse
- Rate limit headers visible to clients for self-throttling
- No persistent storage overhead

Only requests to `/api/` spend the shared API allowance. HTML navigation and other routes do not change its remaining count. Bot endpoints have their additional route-specific limit.
