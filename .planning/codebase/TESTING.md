# Testing Patterns

**Analysis Date:** 2026-03-15

## Test Framework

**Runner:**
- Playwright 1.58.2
- Config: `tests/playwright.config.ts`
- Package: `@meitheal/tests` (separate workspace package)

**Assertion Library:**
- Playwright's built-in `expect()` + custom matchers

**Accessibility:**
- `@axe-core/playwright` 4.11.1 for automated a11y validation

**Run Commands:**
```bash
pnpm --filter @meitheal/tests test          # Run all tests
pnpm --filter @meitheal/tests test <file>   # Specific spec
pnpm check                                  # Typecheck all packages
```

## Test File Organization

**Location:**
- All tests in dedicated `tests/` package (NOT co-located with source)
- Separate from app code to maintain clean domain boundaries

**Naming:**
- Pattern: `{feature}.spec.ts`
- Helpers: `_helpers.ts` (underscore prefix)

**Structure:**
```
tests/
├── e2e/                    # 49 integration/E2E specs
│   ├── _helpers.ts         # Shared test utilities
│   ├── pages.spec.ts
│   ├── api.spec.ts
│   ├── kanban-backlog-mode.spec.ts
│   ├── ha-calendar-adapter.spec.ts
│   └── ... (46 more)
├── governance/             # 2 governance/standards specs
│   ├── iqs-platinum.spec.ts
│   └── repo-standards.spec.ts
├── unit/                   # 1 unit spec
│   └── todo-status-mapper.spec.ts
├── scripts/                # Test utilities
├── types/                  # Test type definitions
├── playwright.config.ts
├── package.json
└── tsconfig.json
```

## Test Structure

**Suite Organization:**
```typescript
import { test, expect } from "@playwright/test"

test.describe("Feature Name", () => {
  test("should do expected behavior", async ({ request }) => {
    const response = await request.get("/api/endpoint")
    expect(response.ok()).toBe(true)
    const body = await response.json()
    expect(body.ok).toBe(true)
  })
})
```

**Patterns:**
- Tests import domain logic directly from workspace packages when testing pure logic
- HA tests use local HTTP server harness to simulate HA API
- Persistence tests use temp SQLite databases (`file:${tmpdir}/...`)
- No shared state between specs

## Mocking

**Framework:** No external mocking framework — custom harnesses only

**Patterns:**
- Local HTTP servers for HA API simulation (in `_helpers.ts`)
- Temp SQLite databases for persistence isolation
- Environment variable manipulation for config testing

**What to Mock:**
- External APIs (HA Supervisor, Grocy)
- Database connections (use temp files)
- Time-dependent operations

**What NOT to Mock:**
- Domain logic — test directly
- Astro rendering — test via HTTP requests to running server
- File system operations in persistence layer

## Fixtures and Factories

**Test Data:**
- Inline task objects in each test
- No centralized factory/faker pattern
- `_helpers.ts` provides utility functions (server setup, auth headers)

## Coverage

**Requirements:** Not enforced via configuration
**Current state:** No coverage report tooling configured

## Test Types

**E2E / Integration Tests (49 specs):**
- Test against running Astro server via Playwright's `request` API
- Cover: pages, API endpoints, security headers, SEO, ingress behavior, Vikunja compat, webhooks, offline sync, accessibility
- Examples: `pages.spec.ts`, `api.spec.ts`, `security-headers.spec.ts`, `vikunja-compat.spec.ts`

**Governance Tests (2 specs):**
- Validate repository standards (required files, naming conventions)
- `iqs-platinum.spec.ts` — Internal Quality Score checks
- `repo-standards.spec.ts` — File existence, structure validation

**Unit Tests (1 spec):**
- `todo-status-mapper.spec.ts` — Pure function testing
- Tests import directly from source, no server needed

## Common Patterns

**API Testing:**
```typescript
test("POST /api/tasks creates a task", async ({ request }) => {
  const response = await request.post("/api/tasks", {
    data: { title: "Test task", status: "todo" }
  })
  expect(response.status()).toBe(200)
  const body = await response.json()
  expect(body.ok).toBe(true)
})
```

**Header Testing:**
```typescript
test("CSP header present", async ({ request }) => {
  const response = await request.get("/")
  const csp = response.headers()["content-security-policy"]
  expect(csp).toContain("default-src 'self'")
})
```

## Verification Tiers (from AGENTS.md)

| Change Type | Required Tier | How |
|-------------|---------------|-----|
| CSS, layout, UI, client JS | 🔧 Tier 1 | `npm run dev` in `apps/web/` |
| Ingress, middleware, serve.mjs | 🏠 Tier 2 | `./scripts/devcontainer-up.sh` |
| HA API, WebSocket, domains/ha/ | 🏠 Tier 2 | HA devcontainer |
| Final acceptance | 🌐 Tier 3 | Production HA (`ha.internal`) |

---

*Testing analysis: 2026-03-15*
