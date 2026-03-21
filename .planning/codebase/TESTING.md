# Testing — Meitheal

**Mapped:** 2026-03-21 | **Confidence:** HIGH

## Framework

| Aspect | Detail |
|--------|--------|
| **Runner** | Node.js built-in test runner (`node:test`) |
| **Assertions** | `node:assert` (strict) |
| **E2E harness** | Custom HTTP server harness simulating HA API |
| **Browser testing** | Playwright (configured but not primary) |
| **Location** | `tests/` directory at monorepo root |

## Test Structure

```
tests/
├── e2e/                        # 75+ integration/E2E specs
│   ├── _helpers.ts             # Shared test utilities
│   ├── pillars.spec.ts         # Pillar CRUD, principles, associations (15 tests)
│   ├── api.spec.ts             # Core API tests
│   ├── ingress-*.spec.ts       # HA ingress behavior tests
│   ├── ha-*.spec.ts            # HA integration tests
│   └── ...
├── governance/
│   ├── iqs-platinum.spec.ts    # Quality standards checks
│   └── repo-standards.spec.ts  # Required files, naming, structure
├── unit/
│   ├── recurrence.spec.ts      # Recurrence calculation
│   └── todo-status-mapper.spec.ts # Status mapping
├── types/                      # Test type declarations
└── playwright.config.ts        # Playwright config
```

## Running Tests

```bash
# All tests
pnpm --filter @meitheal/tests test

# Specific spec
pnpm --filter @meitheal/tests test tests/e2e/pillars.spec.ts

# Type check all packages
pnpm check
```

## Key Test Files for Phase 19

| File | Tests | Focus |
|------|-------|-------|
| `tests/e2e/pillars.spec.ts` | 15 | Pillar CRUD, principles, associations, validation |
| `tests/e2e/parent-page-shell.spec.ts` | N/A | ParentPageShell behavior (progress/planning tabs) |
| `tests/e2e/search-hub.spec.ts` | N/A | Unified search functionality |
| `tests/e2e/navigation.spec.ts` | N/A | Page navigation, routing |

## Testing Conventions

| Rule | Detail |
|------|--------|
| No shared state | Each spec is independent — no cross-test contamination |
| No external mocks | Tests use real SQLite (temp files) and local HTTP harness |
| Temp DB pattern | `file:${tmpdir}/test-${Date.now()}.db` |
| Import pattern | Direct workspace package imports, not HTTP |
| HA simulation | Local HTTP server returns canned responses |

## Test Patterns

### Domain Service Tests
```typescript
import { describe, it } from "node:test"
import { strict as assert } from "node:assert"
import { createPillar, getPillars } from "@meitheal/domains/pillars/pillar-service"

describe("pillars", () => {
  it("creates a pillar", async () => {
    const p = await createPillar({ name: "Health" })
    assert.ok(p.id)
    assert.equal(p.name, "Health")
  })
})
```

### Governance Tests
```typescript
// Verify required files exist
it("has AGENTS.md", () => {
  assert.ok(fs.existsSync("AGENTS.md"))
})

// Verify naming conventions
it("all domain files use kebab-case", () => { ... })
```

## Coverage

No formal coverage tooling configured. Quality is enforced through:
- 75+ E2E specs covering all major features
- Governance specs enforcing repo standards
- `astro check` for type safety
- CodeRabbitAI for PR review
