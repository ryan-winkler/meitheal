# Codebase Concerns

**Analysis Date:** 2026-03-15

## Tech Debt

**`@ts-nocheck` in `kanban-controller.ts`:**
- Issue: Entire 2,019-line controller has `@ts-nocheck` — extracted from inline `<script>` (PGD-01) without progressive typing
- Files: `apps/web/src/lib/kanban-controller.ts`
- Impact: No type safety on the most complex client controller. Refactoring risks runtime errors.
- Fix approach: Gradually add types file-section-by-file-section, removing `@ts-nocheck` when 100% typed

**Oversized Controllers:**
- Issue: Several client controllers are >2,000 lines with mixed concerns
- Files: `apps/web/src/lib/settings-controller.ts` (3,205 LoC), `apps/web/src/lib/task-modal-controller.ts` (2,417 LoC), `apps/web/src/lib/kanban-controller.ts` (2,019 LoC)
- Impact: Difficult to navigate, test, and maintain. High cognitive load for contributors.
- Fix approach: Decompose into focused sub-modules per domain concern (e.g., `settings-integrations-controller.ts`, `kanban-drag-controller.ts`)

**Duplicated Type Icon Config:**
- Issue: SVG path data for task types (epic, story, task, bug) is duplicated across `TaskTypeIcon.astro`, `kanban-controller.ts`, and `task-modal-controller.ts`
- Files: `apps/web/src/components/ui/TaskTypeIcon.astro`, `apps/web/src/lib/task-modal-controller.ts`
- Impact: Inconsistency risk when updating icons. Maintenance burden.
- Fix approach: Extract shared `TYPE_ICON_CONFIG` to a single `@lib/type-icon-config.ts` module

## Known Bugs

**Manage Swimlanes Modal Blocking:**
- Symptoms: Swimlanes modal can get stuck, blocking UI interaction with other modals
- Files: `apps/web/src/lib/kanban-controller.ts`, `apps/web/src/pages/kanban.astro`
- Trigger: Opening swimlane management when another modal overlay is active
- Workaround: Page reload

## Security Considerations

**Rate Limiter Memory Growth:**
- Risk: In-memory rate limit map grows unbounded under distributed attacks from many IPs
- Files: `apps/web/src/middleware.ts`
- Current mitigation: `MAX_ENTRIES` cap with FIFO eviction
- Recommendations: Consider external rate limiting (HA proxy, Cloudflare) for production

**No Standalone Auth:**
- Risk: Application has no standalone authentication — relies entirely on HA Supervisor token
- Files: `apps/web/src/domains/auth/ingress.ts`
- Current mitigation: Only accessible behind HA ingress (by design)
- Recommendations: Document clearly that standalone deployment is NOT supported

## Performance Bottlenecks

**Large Page Initial Renders:**
- Problem: `kanban.astro` (1,404 LoC) and `Layout.astro` (1,255 LoC) are SSR-heavy
- Files: `apps/web/src/pages/kanban.astro`, `apps/web/src/layouts/Layout.astro`
- Cause: Many conditional blocks, inline component rendering, large CSS injection
- Improvement path: Further component extraction, lazy loading non-critical sections

**Client Bundle Size (Controllers):**
- Problem: 3 controllers total ~7,600 LoC of client-side JS shipped on page load
- Files: `apps/web/src/lib/kanban-controller.ts`, `apps/web/src/lib/table-controller.ts`, `apps/web/src/lib/task-modal-controller.ts`
- Cause: Monolithic controllers with all features loaded upfront
- Improvement path: Dynamic imports, code splitting per interaction mode

## Fragile Areas

**Ingress Path Handling:**
- Files: `apps/web/scripts/serve.mjs`, `apps/web/src/middleware.ts`, `apps/web/src/layouts/Layout.astro`
- Why fragile: Three separate layers all handle path rewriting — `serve.mjs` normalizes URLs, middleware rewrites HTML attributes, `Layout.astro` monkey-patches `fetch()`. A change in any one layer can break the others.
- Safe modification: Always test all three layers together (Tier 2 devcontainer required)
- Test coverage: `tests/e2e/middleware-ingress-behavior.spec.ts`, `tests/e2e/ingress-header-validation.spec.ts`, `tests/e2e/ingress-state-persistence.spec.ts`

**CSS Partial System:**
- Files: `apps/web/src/styles/*.css` (18 files, some >500 LoC)
- Why fragile: No CSS scoping — all partials are global. Class name collisions possible. CI only checks brace balance.
- Safe modification: Use unique prefixes per partial domain (e.g., `.kanban-`, `.table-`)
- Test coverage: CSS brace balance check in CI only

## Scaling Limits

**SQLite:**
- Current capacity: Single-user homelab usage (hundreds to low thousands of tasks)
- Limit: Concurrent writes (SQLite WAL mode), no multi-instance support
- Scaling path: Designed for single HA instance — acceptable tradeoff per product scope

## Dependencies at Risk

**No critical risks identified.** All dependencies are actively maintained. Security overrides in root `package.json` mitigate known vulnerabilities.

## Test Coverage Gaps

**Unit Tests:**
- What's not tested: Only 1 unit test file (`todo-status-mapper.spec.ts`). Core domain logic in `domain-tasks`, `domain-strategy`, `domain-auth` packages have NO unit tests.
- Files: `packages/domain-tasks/src/`, `packages/domain-strategy/src/rice.ts`
- Risk: Business rule regressions undetected
- Priority: Medium — E2E tests provide some coverage but miss edge cases

**Client Controllers:**
- What's not tested: `kanban-controller.ts`, `table-controller.ts`, `task-modal-controller.ts` have NO test coverage
- Files: `apps/web/src/lib/*-controller.ts`
- Risk: UI regressions in drag-and-drop, filtering, modal behavior
- Priority: Medium — these are the most complex client-side modules

**Offline/Sync:**
- What's not tested: `offline-store.ts`, `sync-engine.ts`, `tab-sync.ts` have basic E2E coverage but no unit tests for conflict resolution logic
- Files: `apps/web/src/domains/offline/`
- Risk: Data loss during sync conflicts
- Priority: High

---

*Concerns audit: 2026-03-15*
