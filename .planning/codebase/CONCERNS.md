# Codebase Concerns

**Analysis Date:** 2026-03-16

## Tech Debt

**`@ts-nocheck` in `kanban-controller.ts`:**
- Issue: Entire 2,025-line controller has `@ts-nocheck` — extracted from inline `<script>` without progressive typing
- Files: `apps/web/src/lib/kanban-controller.ts`
- Impact: No type safety on the most complex client controller. Refactoring risks runtime errors.
- Fix approach: Remove `@ts-nocheck`, add explicit types section-by-section, fix revealed errors

**Oversized Controllers:**
- Issue: Several client controllers are >2,000 lines with mixed concerns
- Files: `apps/web/src/lib/settings-controller.ts` (3,218 LoC), `apps/web/src/lib/task-modal-controller.ts` (2,414 LoC), `apps/web/src/lib/kanban-controller.ts` (2,025 LoC)
- Impact: Difficult to navigate, test, and maintain. High cognitive load.
- Fix approach: Decompose into focused sub-modules per domain concern

**Raw `console.*` Calls (67 total):**
- Issue: 67 raw `console.log/warn/error` calls instead of structured `createLogger()` from `@meitheal/domain-observability`
- Files: `apps/web/src/lib/task-modal-controller.ts` (8), `apps/web/src/lib/settings-controller.ts` (7), `apps/web/src/components/settings/SettingsGeneral.astro` (6), `apps/web/src/domains/offline/*.ts` (10), `apps/web/src/lib/kanban-controller.ts` (4), plus 32 across other files
- Impact: Inconsistent logging, no structured output for Loki, no redaction
- Fix approach: Replace with domain-aware `createLogger()` calls

**`(window as any)` Global Casts (29 total):**
- Issue: 29 uses of `(window as any)` for cross-component communication instead of typed patterns
- Files: `apps/web/src/lib/dashboard-controller.ts` (9), `apps/web/src/lib/page-lifecycle.ts` (3), `apps/web/src/components/tasks/NewTaskModal.astro` (2), plus 15 across other files
- Impact: No type safety for inter-component contracts. Prone to silent failures.
- Fix approach: Typed CustomEvent bus + proper `env.d.ts` declarations for legitimate globals like `__ingress_path`, `__featureFlags`

**`window.location.reload()` Anti-Pattern (32 total):**
- Issue: 32 calls to `window.location.reload()` instead of DOM/state updates
- Files: `apps/web/src/pages/tasks.astro` (2), `apps/web/src/pages/today.astro` (2), `apps/web/src/pages/upcoming.astro` (2), `apps/web/src/pages/calendar.astro` (2), `apps/web/src/components/tasks/NewTaskModal.astro` (1), plus 23 across other files
- Impact: Full page reloads disrupt user context, cause iframe reload behind HA ingress, waste bandwidth
- Fix approach: Replace with targeted DOM updates, re-fetch data, or dispatch custom events

## Known Bugs

**Manage Swimlanes Modal Blocking:**
- Symptoms: Swimlanes modal can get stuck, blocking UI interaction
- Files: `apps/web/src/lib/kanban-controller.ts`, `apps/web/src/pages/kanban.astro`
- Trigger: Opening swimlane management when another modal overlay is active
- Workaround: Page reload

## Security Considerations

**Rate Limiter Memory Growth:**
- Risk: In-memory rate limit map grows unbounded under distributed attacks
- Files: `apps/web/src/middleware.ts`
- Current mitigation: `MAX_ENTRIES` cap with FIFO eviction
- Recommendations: Consider external rate limiting for production

**No Standalone Auth:**
- Risk: No standalone authentication — relies entirely on HA Supervisor token
- Files: `apps/web/src/domains/auth/ingress.ts`
- Current mitigation: Only accessible behind HA ingress (by design)
- Recommendations: Document clearly that standalone deployment is NOT supported

## Performance Bottlenecks

**Large Page Initial Renders:**
- Problem: `kanban.astro` (1,423 LoC) and `Layout.astro` (777 LoC) are SSR-heavy
- Files: `apps/web/src/pages/kanban.astro`, `apps/web/src/layouts/Layout.astro`
- Cause: Many conditional blocks, inline component rendering, large CSS injection
- Improvement path: Component extraction, lazy loading non-critical sections

**Client Bundle Size (Controllers):**
- Problem: 3 controllers total ~7,600 LoC of client-side JS shipped on page load
- Files: `apps/web/src/lib/kanban-controller.ts`, `apps/web/src/lib/table-controller.ts`, `apps/web/src/lib/task-modal-controller.ts`
- Cause: Monolithic controllers with all features loaded upfront
- Improvement path: Dynamic imports, code splitting per interaction mode

**Large Settings Components:**
- Problem: `SettingsIntegrations.astro` (2,552 LoC), `SettingsGeneral.astro` (1,497 LoC), `SettingsSystem.astro` (1,288 LoC) cause slow initial renders
- Files: `apps/web/src/components/settings/Settings*.astro`
- Improvement path: Lazy-load settings sections, code-split per tab

## Fragile Areas

**Ingress Path Handling:**
- Files: `apps/web/scripts/serve.mjs`, `apps/web/src/middleware.ts`, `apps/web/src/layouts/Layout.astro`
- Why fragile: Three separate layers all handle path rewriting. A change in any one layer can break the others.
- Safe modification: Always test all three layers together (Tier 2 devcontainer required)
- Test coverage: `tests/e2e/middleware-ingress-behavior.spec.ts`, `tests/e2e/ingress-*`

**CSS Partial System:**
- Files: `apps/web/src/styles/*.css` (19 files, 5,300 LoC)
- Why fragile: No CSS scoping — all partials are global. Class name collisions possible.
- Safe modification: Use unique prefixes per partial domain (e.g., `.kanban-`, `.table-`)
- Test coverage: CSS brace balance check in CI only

## Scaling Limits

**SQLite:**
- Current capacity: Single-user homelab usage (hundreds to low thousands of tasks)
- Limit: Concurrent writes (SQLite WAL mode), no multi-instance support
- Scaling path: By design for single HA instance — acceptable per product scope

## Dependencies at Risk

**No critical risks identified.** All dependencies are actively maintained. Security overrides in root `package.json` mitigate known vulnerabilities.

## Test Coverage Gaps

**Unit Tests:**
- What's not tested: Core domain logic in `domain-tasks`, `domain-strategy`, `domain-auth` packages has NO unit tests (only 1 unit test file: `todo-status-mapper.spec.ts`)
- Files: `packages/domain-tasks/src/`, `packages/domain-strategy/src/rice.ts`
- Risk: Business rule regressions undetected
- Priority: Medium — E2E tests provide some coverage but miss edge cases

**Client Controllers:**
- What's not tested: `kanban-controller.ts`, `table-controller.ts`, `task-modal-controller.ts` have NO test coverage
- Files: `apps/web/src/lib/*-controller.ts`
- Risk: UI regressions in drag-and-drop, filtering, modal behavior
- Priority: Medium

**Offline/Sync:**
- What's not tested: `offline-store.ts`, `sync-engine.ts`, `tab-sync.ts` — no unit tests for conflict resolution logic
- Files: `apps/web/src/domains/offline/`
- Risk: Data loss during sync conflicts
- Priority: High

---

*Concerns audit: 2026-03-16*
