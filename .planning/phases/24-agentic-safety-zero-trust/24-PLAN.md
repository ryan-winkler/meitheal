# Phase 24: Agentic Safety & Zero-Trust — Plan

**Status:** Ready for execution

## Wave 1: Domain Types & Shared Infrastructure (Foundation)

### T1: Agent Token Domain Types
**File**: `packages/domain-auth/src/agent-tokens.ts`
- `AgentScope` type (discriminated union of scope strings)
- `AVAILABLE_SCOPES` constant array with labels + descriptions
- `AgentTokenRecord` interface (id, name, tokenHash, tokenPrefix, scopes, createdAt, expiresAt, lastUsedAt, revoked)
- `generateAgentToken()` — creates `mth_` prefixed token + SHA-256 hash
- `validateScopes()` — validates scope array against known scopes
- `hasScope()` — checks if a token's scopes include a required scope
- Re-export from `packages/domain-auth/src/index.ts`

### T2: Idempotency Cache
**File**: `apps/web/src/lib/idempotency-cache.ts`
- `IdempotencyCache` class — in-memory Map with TTL + LRU eviction
- `CachedResponse` type: `{ status, headers, body, processedAt }`
- `get()`, `set()`, `markInFlight()`, `isInFlight()`, `remove()` methods
- Configurable: `maxEntries` (10,000), `ttlMs` (24h)
- Export singleton instance for middleware use

### T3: Agent Token Persistence
**File**: `apps/web/src/domains/auth/agent-token-store.ts`
- SQLite table: `agent_tokens` (schema from RESEARCH.md)
- `ensureAgentTokenSchema()` — idempotent table creation
- `createToken()`, `listTokens()`, `getTokenByHash()`, `revokeToken()`, `updateLastUsed()`, `deleteToken()`
- Called from `ensureSchema()` on startup

**Depends on:** T1

## Wave 2: Middleware Integration

### T4: Agent Token Guard
**File**: `apps/web/src/lib/agent-token-guard.ts`
- `resolveAgentAuth()` — extracts Bearer token, hashes, looks up, returns scopes or null
- `requireScope(scope: AgentScope)` — returns problem+json 403 if scope missing
- HA ingress bypass: if `X-Hass-User-Id` header present, skip token auth
- Attach resolved scopes to `Astro.locals.agentScopes` for route access

### T5: Idempotency Middleware
**File**: `apps/web/src/middleware.ts` (additions)
- For `POST`/`PATCH`/`DELETE` requests to `/api/`:
  - Read `Idempotency-Key` header
  - If present + cached: return cached response + `Idempotency-Key-Status: cached`
  - If present + in-flight: return `409 Conflict` problem+json
  - If present + new: mark in-flight, process, cache response
  - If absent on POST: log warning (don't block — gradual adoption)
- Import from `idempotency-cache.ts`

**Depends on:** T2, T4

## Wave 3: API Routes

### T6: Agent Token CRUD API
**Files**: `apps/web/src/pages/api/agent-tokens/`
- `POST /api/agent-tokens` — create token, return plaintext once
- `GET /api/agent-tokens` — list tokens (prefix + metadata, no hash)
- `DELETE /api/agent-tokens/[id]` — revoke/delete token
- `PATCH /api/agent-tokens/[id]` — update name or scopes
- All routes require HA admin (`X-Hass-Is-Admin: true`) or existing admin token
- Returns RFC 9457 problem+json on errors

### T7: OpenAPI + Docs Update
**Files**: `apps/web/scripts/generate-openapi.mjs`, `docs/kcs/agent-automation-guide.md`
- Add `AgentToken`, `AgentTokenCreate` schemas
- Add `/api/agent-tokens` CRUD paths
- Add `Idempotency-Key` header parameter to mutating operations
- Document scoped token auth in KCS guide

**Depends on:** T3, T6

## Wave 4: Settings UI & Registry

### T8: Settings Registry Update
**File**: `apps/web/src/lib/settings-registry.ts`
- Add `field-agent-tokens` entry in `automation-ai-settings` section
- Keywords: agent, token, scope, api key, bot, authorization, bearer

### T9: Agent Tokens Settings Component
**File**: `apps/web/src/components/settings/SettingsAgentTokens.astro`
- Create token form: name input, scope checkboxes, optional expiry
- Token list table: name, prefix, scopes (pills), created, last used, delete button
- Show-once modal: display full token with copy button after creation
- Scope add/remove per token via inline editing
- Reuse existing settings styling patterns

**Depends on:** T6, T8

## Wave 5: Testing & Verification

### T10: E2E Tests
**File**: `tests/e2e/agent-tokens.spec.ts`
- Token CRUD lifecycle (create → list → use → revoke → verify rejected)
- Scope enforcement (token with `tasks:read` can GET but not POST)
- Idempotency-Key caching (duplicate POST returns same response)
- HA ingress bypass (requests with `X-Hass-User-Id` don't need token)

### T11: Idempotency E2E Tests
**File**: `tests/e2e/idempotency.spec.ts`
- Same key, same response (cached round-trip)
- 409 on concurrent in-flight request
- Expired key processes as new
- POST without key still works (just logs warning)

**Depends on:** T4, T5, T6

## Acceptance Criteria

- [ ] `packages/domain-auth/` exports token types + generation + scope validation
- [ ] `idempotency-cache.ts` is shared infrastructure in `lib/` — reusable by any domain
- [ ] Agent tokens are opt-in — system functions identically without any tokens created
- [ ] HA ingress sessions bypass token auth (no perceived negative)
- [ ] Token plaintext shown only once; SHA-256 hash stored
- [ ] Settings UI shows token management under Automation & AI section
- [ ] Multiple scopes per token, granular add/remove
- [ ] Idempotency-Key returns cached response for duplicates
- [ ] All E2E tests pass
- [ ] `pnpm check` clean
- [ ] OpenAPI updated with new schemas
- [ ] KCS docs updated

---

*Phase: 24-agentic-safety-zero-trust*
*Plan created: 2026-03-22*
