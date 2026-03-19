# Codebase Testing — Meitheal

> Last refreshed: 2026-03-19

## Test Infrastructure

| Component | Detail |
|-----------|--------|
| Framework | Node.js built-in test runner (`node:test`) |
| Location | `tests/` directory (separate workspace `@meitheal/tests`) |
| DB isolation | Temp SQLite (`file:${tmpdir}/...`) per test |
| HA simulation | Local HTTP server harness |
| Shared state | None — no external mocking framework |

## Commands

```bash
# Run all tests
pnpm --filter @meitheal/tests test

# Run specific spec
pnpm --filter @meitheal/tests test tests/e2e/today-shell.spec.ts

# Typecheck all packages
pnpm check
```

## Test Categories

### E2E Tests (60+ specs)

| Area | Specs | Key files |
|------|-------|-----------|
| Shell/UI | 7 | `today-shell.spec.ts`, `upcoming-shell.spec.ts`, `calendar-shell.spec.ts`, `kanban-shell.spec.ts`, `table-shell.spec.ts`, `dashboard-shell.spec.ts`, `habits-shell.spec.ts` |
| Task CRUD | 5 | `api.spec.ts`, `today-page.spec.ts`, `status-consistency.spec.ts`, `task-type-api.spec.ts`, `task-sync-*.spec.ts` |
| Hierarchy | 3 | `hierarchy-crud.spec.ts`, `hierarchy-model.spec.ts`, `subtask-hierarchy.spec.ts` |
| HA Integration | 4 | `ha-calendar-adapter.spec.ts`, `ha-llm-api.spec.ts`, `ha-security-hardening.spec.ts`, `ha-backup-platform.spec.ts` |
| Auth/Security | 4 | `ingress-header-validation.spec.ts`, `middleware-ingress-behavior.spec.ts`, `phase5-security.spec.ts`, `security-headers.spec.ts` |
| Integrations | 6 | `caldav-client.spec.ts`, `calendar-bridge.spec.ts`, `grocy-adapter.spec.ts`, `integrations.spec.ts`, `vikunja-compat*.spec.ts` |
| Offline/PWA | 3 | `pwa-offline.spec.ts`, `offline-sync.spec.ts`, `offline-attachments.spec.ts` |
| Search | 1 | `search-hub.spec.ts` |
| Settings | 2 | `settings-shell.spec.ts`, `theme-settings.spec.ts` |
| Navigation | 2 | `navigation.spec.ts`, `layout-ingress-client-router.spec.ts` |
| Other | 10+ | `branding.spec.ts`, `seo.spec.ts`, `export-service.spec.ts`, `accessibility.spec.ts`, etc. |

### Governance Tests (2 specs)

| Spec | Purpose |
|------|---------|
| `iqs-platinum.spec.ts` | Internal quality standards enforcement |
| `repo-standards.spec.ts` | Required files, naming, license compliance |

### Unit Tests (1 spec)

| Spec | Purpose |
|------|---------|
| `todo-status-mapper.spec.ts` | Status mapping between HA todo and Meitheal |

## Coverage Gaps

| Area | Gap | Severity |
|------|-----|----------|
| `unified-bar-controller.ts` | No direct tests | ⚠️ Medium |
| `page-shell-controller.ts` | No direct tests | ⚠️ Medium |
| `eisenhower-controller.ts` | No tests at all | 🔴 High |
| Client-side controllers | All tested indirectly via shell specs at best | ⚠️ Medium |
| Section registries | No dedicated tests | Low |
| Inline styles (Upcoming) | Not validated | Low |

> **Note:** Shell spec files (`*-shell.spec.ts`) test the integration of pages with their shells, but do not directly test the vanilla JS controller logic. The controllers run client-side and current tests are server-side only.

## Test Patterns

```typescript
// Typical test structure
import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"

describe("Feature", () => {
  let server: TestServer

  before(async () => {
    server = await startTestServer({ dbPath: `file:${tmpdir}/test.db` })
  })

  after(() => server.close())

  it("does something", async () => {
    const res = await server.fetch("/api/endpoint")
    assert.equal(res.status, 200)
  })
})
```

## Verification Tiers

| Tier | Scope | How |
|------|-------|-----|
| Tier 1 | CSS, layout, UI, client JS | `npm run dev` in `apps/web/` |
| Tier 2 | Ingress, middleware, HA API, WebSocket | `./scripts/devcontainer-up.sh` |
| Tier 3 | Final acceptance on real data | Production HA (`ha.internal`) |
