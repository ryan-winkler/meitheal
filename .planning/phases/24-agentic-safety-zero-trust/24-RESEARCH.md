# Phase 24: Agentic Safety & Zero-Trust — Research

## 1. Current State Analysis

### Auth Domain Architecture
- **Package**: `packages/domain-auth/` — license key verification (Ed25519), WebAuthn mock, ingress context types
- **In-app**: `apps/web/src/domains/auth/` — HA ingress detection (`ingress.ts`, `ingress-policy.ts`)
- **No bearer tokens**, API keys, or scope mechanisms exist today
- All auth relies on HA Supervisor injecting `X-Hass-User-Id` and `X-Hass-Is-Admin` headers

### Existing Idempotency
- **DB-level**: `idempotency_key TEXT NOT NULL` columns in tasks, domain_events, sync_attempts
- **Service-level**: `findByIdempotencyKey()`, `isIdempotencyConflict()` in task-sync-service
- **Missing**: HTTP-level `Idempotency-Key` header middleware (response caching layer)
- Grocy bridge and todo bridge both use idempotency keys from source systems

### Middleware Architecture
- Two in-memory Maps for rate limiting (general + bot)
- Settings cache with TTL
- traceparent parsing for OTel
- Automation source header validation
- All state-mutating logic is in `middleware.ts` (monolithic)

### Settings UI Patterns
- `settings-registry.ts`: sections (7) + fields (20) with search keywords
- Hash-based navigation (`#section-id`)
- `SettingsSectionId` union type for section IDs
- Agent protocol toggles already exist in `automation-ai-settings` section

## 2. DDD Domain Mapping

### Option A: Extend `domain-auth` package (Recommended)
- Token types, scope definitions, verification logic → `packages/domain-auth/src/`
- Token CRUD (SQLite storage) → `apps/web/src/domains/auth/agent-tokens.ts`
- API routes → `apps/web/src/pages/api/agent-tokens/`
- Settings UI → `apps/web/src/components/settings/SettingsAgentTokens.astro`
- **Why**: tokens are an auth concern; keeps bounded context tight

### Option B: New `domain-agent-security` package
- Overkill for current scope; fragments auth concepts across packages

### Idempotency: Shared Infrastructure
- `apps/web/src/lib/idempotency-cache.ts` — reusable service (not domain-specific)
- Middleware integration in `middleware.ts`
- Follows existing pattern: `rate-limit.ts`, `api-response.ts` are in `lib/`

## 3. Scoped Token Design

### Token Format
- `mth_` prefix + 32 bytes hex = 68 chars (e.g., `mth_a1b2c3...`)
- SHA-256 hash stored in SQLite (plaintext never persisted)
- Display once on creation, then only show prefix + last 4 chars

### Scope Grammar
Resource-action pairs following OpenAPI operation groups:
```
tasks:read     tasks:write     tasks:delete
projects:read  projects:write
search:read
settings:read  settings:write
webhooks:write
mcp:execute    a2a:execute
```

### Token Table Schema
```sql
CREATE TABLE agent_tokens (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  token_prefix TEXT NOT NULL,        -- "mth_a1b2...ef01" (first 12 chars)
  scopes TEXT NOT NULL DEFAULT '[]', -- JSON array of scope strings
  created_at TEXT NOT NULL,
  expires_at TEXT,                    -- NULL = no expiry
  last_used_at TEXT,
  revoked INTEGER NOT NULL DEFAULT 0
);
```

### Middleware Flow
1. Check `Authorization: Bearer mth_...` header
2. Hash provided token with SHA-256
3. Look up `token_hash` in SQLite
4. Check `revoked = 0` and `expires_at` not past
5. Extract `scopes` array
6. Route-level scope check: `requireScope("tasks:write")` guard
7. HA ingress sessions bypass all of the above (existing behavior)

## 4. Idempotency-Key Design

### IETF Draft Pattern
- Header: `Idempotency-Key: <client-supplied UUID>`
- Required for `POST`, optional for `PATCH`/`DELETE`
- In-memory cache: `Map<string, { status: number, headers: Headers, body: string, expiresAt: number }>`
- TTL: 24 hours (configurable)
- Max entries: 10,000 (LRU eviction)

### Response Behavior
| Scenario | Response |
|----------|----------|
| First request with key | Process normally, cache response |
| Duplicate key (cached) | Return cached response + `Idempotency-Key-Status: cached` |
| Duplicate key (in-flight) | `409 Conflict` problem+json |
| Missing key on POST | `400 Bad Request` problem+json (configurable: warn vs require) |
| Expired/evicted key | Process as new request |

### Module: `apps/web/src/lib/idempotency-cache.ts`
Shared infrastructure, not domain-specific. Exports:
- `IdempotencyCache` class (in-memory, configurable TTL/max)
- `idempotencyMiddleware()` function for middleware integration

## 5. Positive Outcome Guarantees

| User Requirement | How We Ensure It |
|------------------|------------------|
| Bots multi-step handle tickets | Multiple scopes per token, wide scope grants |
| Bots handle multiple tickets | Token scopes are type-based, not instance-based |
| Multiple task types | Scope grammar covers all resource types |
| HA APIs unaffected | HA ingress sessions bypass token auth entirely |
| No perceived negative | Token auth is opt-in; system works without tokens |

## 6. Modularization Strategy

| Component | Location | Responsibility |
|-----------|----------|---------------|
| Token types + scope validation | `packages/domain-auth/src/agent-tokens.ts` | Pure domain logic, no I/O |
| Token persistence (SQLite) | `apps/web/src/domains/auth/agent-token-store.ts` | CRUD operations |
| Token API routes | `apps/web/src/pages/api/agent-tokens/` | REST endpoints |
| Token middleware guard | `apps/web/src/lib/agent-token-guard.ts` | Shared middleware helper |
| Idempotency cache | `apps/web/src/lib/idempotency-cache.ts` | Shared infrastructure |
| Settings UI | `apps/web/src/components/settings/SettingsAgentTokens.astro` | UI component |
| Settings registry entry | `apps/web/src/lib/settings-registry.ts` | Section + fields |
| OpenAPI schemas | `apps/web/scripts/generate-openapi.mjs` | AgentToken, AgentTokenCreate |

---

*Phase: 24-agentic-safety-zero-trust*
*Research completed: 2026-03-22*
