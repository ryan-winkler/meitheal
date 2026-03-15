# Coding Conventions

**Analysis Date:** 2026-03-15

## Naming Patterns

**Files:**
- kebab-case for all TypeScript/CSS: `task-modal-controller.ts`, `filter-engine.ts`
- PascalCase for Astro components: `FilterToolbar.astro`, `TaskTypeIcon.astro`
- Underscore prefix for CSS partials: `_kanban.css`, `_tokens.css`

**Functions:**
- camelCase: `createTask()`, `resolveIntegrationOutcome()`, `getHAConnectionStatus()`
- Prefix verbs: `get`, `create`, `update`, `delete`, `init`, `resolve`, `build`, `ensure`

**Variables:**
- camelCase: `rateLimitMap`, `ingressPath`
- UPPER_SNAKE for constants: `RATE_LIMIT`, `RATE_WINDOW_MS`, `INGRESS_PATH`

**Types/Interfaces:**
- PascalCase: `TaskAggregate`, `CalendarSyncState`, `MiddlewareHandler`
- Suffix patterns: `*Config`, `*State`, `*Options`, `*Result`
- Discriminated unions: `{ ok: true, data: T } | { ok: false, errorCode: string }`

## Code Style

**Formatting:**
- No semicolons
- Double quotes for strings
- 2-space indent
- Enforced by project convention (no Prettier/ESLint config files detected)

**Linting:**
- `astro check` (via `@astrojs/check`) — Astro-specific type checking
- `tsc --noEmit` in each package
- CSS brace balance check in CI (`ci.yml` governance job)

## Import Organization

**Order:**
1. Node builtins (`node:fs`, `node:http`)
2. Framework imports (`astro`, `astro/config`)
3. External packages (`date-fns`, `drizzle-orm`, `zod`)
4. Workspace packages (`@meitheal/domain-tasks`, `@meitheal/domain-observability`)
5. Path-aliased local imports (`@domains/ha/`, `@lib/`)
6. Relative imports (`./`, `../`)

**Path Aliases:**
- `@domains/*` → `apps/web/src/domains/*`
- `@lib/*` → `apps/web/src/lib/*`
- `@i18n/*` → `apps/web/src/i18n/*`

## Export Patterns

**Named exports only** — no default exports anywhere in the codebase.

**Barrel exports** via `index.ts` in each domain:
```typescript
// apps/web/src/domains/ha/index.ts
export { initHAIntegrations } from "./ha-startup"
export { getHAConnection, getHAConnectionStatus } from "./ha-connection"
```

## Error Handling

**API Routes:**
- Return discriminated unions, never throw:
```typescript
return new Response(JSON.stringify({ ok: false, errorCode: "VALIDATION_ERROR" }), { status: 400 })
```

**Client-side:**
- `@lib/safe-fetch.ts` wraps `fetch()` with error normalization
- `@lib/toast.ts` for user-visible error notifications
- Try/catch with structured logging in bridge services

## Logging

**Framework:** `@meitheal/domain-observability` (`createLogger()`)

**Patterns:**
- One JSON object per line to stdout (Loki-compatible)
- Schema: `{ ts, level, event, domain, component, request_id, message, metadata }`
- Redact secrets via `defaultRedactionPatterns`
- Do NOT use high-cardinality labels (user IDs, task IDs, URLs)

## Comments

**When to Comment:**
- KCS requirement: all domain boundaries, non-obvious patterns, workarounds
- `@kcs` tag for KCS-relevant documentation
- JSDoc for bridge services and utility functions
- `// Bounded context: {name}` label in domain files

**Style:**
- Line comments for inline explanations
- Block comments for module-level documentation
- CSS comments for section headers in partials

## Module Design

**Size guidance:**
- Controllers can be large (1,000–3,000 lines) — they're page-specific
- Domain services should be <500 lines
- Components should be <200 lines (favoring composition)

**Parameters:**
- Prefer options objects over positional parameters for >2 args
- Use Zod schemas for validation at API boundaries

---

*Convention analysis: 2026-03-15*
