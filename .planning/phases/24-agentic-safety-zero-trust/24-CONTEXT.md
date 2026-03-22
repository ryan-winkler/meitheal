# Phase 24: Agentic Safety & Zero-Trust — Context

**Gathered:** 2026-03-22
**Status:** Ready for research

<domain>
## Phase Boundary

Deliver HTTP-level Idempotency-Key middleware for exactly-once execution guarantees, and a scoped agent token system for zero-trust agent authorization. LLM-in-the-loop E2E testing is already complete (Phase 23).

This phase does NOT add new API endpoints or domain features. It adds a security and reliability layer to ALL existing API routes.

</domain>

<decisions>
## Implementation Decisions

### Idempotency-Key Middleware
- IETF-style `Idempotency-Key` HTTP header for `POST`, `PATCH`, `DELETE` routes
- Response caching in-memory (Map) with TTL — not DB-backed (lightweight, no schema migration)
- Return cached response for duplicate keys within TTL window
- DB already has `idempotency_key` columns + `findByIdempotencyKey()` — middleware layer complements but doesn't replace
- Return `409 Conflict` with RFC 9457 problem+json for concurrent duplicate processing
- Include `Idempotency-Key-Status: cached|processed` response header

### Zero-Trust Agent Tokens
- Agent tokens: opaque hex strings stored in SQLite (hashed with SHA-256)
- Token scopes: resource-type + action granularity (e.g., `tasks:read`, `tasks:write`, `projects:read`)
- Multiple scopes per token (array)
- Tokens validated in middleware via `Authorization: Bearer <token>` header
- HA ingress sessions bypass token auth (existing behavior preserved)
- Settings UI for creating/editing/deleting agent tokens with scope checkboxes
- Tokens display only once on creation (hash stored, plaintext not persisted)
- Each token has a name/label for identification (e.g., "n8n morning workflow")
- Optional expiry date per token

### User-Specified Positive Outcomes
- Bots can still multi-step handle tickets without issue
- Bots are not blocked from handling multiple tickets at once
- Bots can do multiple different kinds of tasks within scope
- Home Assistant APIs function without disruption
- No perceived negative to the user

### Settings UI
- Token management section in existing Settings page (hash-based nav: `#agent-tokens`)
- Create token flow: name → select scopes → generate → show once
- Table of existing tokens: name, created date, last used, scopes, delete action
- Granular scope add/remove per token
- Existing agent protocol toggles (a2a, mcp, webmcp) remain unchanged

### Claude's Discretion
- Token format (length, prefix conventions)
- Cache eviction strategy for idempotency (LRU vs. TTL-only)
- Exactly which scopes to define (derived from OpenAPI operation groupings)

</decisions>

<specifics>
## Specific Ideas

- "We already do some scoping in the settings, so ensuring this is updated and displayed and functioning in a mature sense"
- "Give bots and connections multiple scopes and remove or add in a granular fashion"
- Macaroons or OAuth 2.1 RAR were mentioned as inspiration but NOT required — simpler scoped tokens preferred for homelab context
- Rate limiting already exists (Phase 23) — tokens should integrate with per-token rate limits as a future enhancement

</specifics>

<deferred>
## Deferred Ideas

- Macaroon-style caveats (contextual restrictions like "only Project 123") — future phase
- OAuth 2.1 Rich Authorization Requests — overkill for homelab, defer
- Per-token rate limit overrides — enhancement on top of existing rate limiter
- Token rotation/refresh — future security hardening
- Agent audit log (who did what with which token) — future observability phase

</deferred>

---

*Phase: 24-agentic-safety-zero-trust*
*Context gathered: 2026-03-22*
