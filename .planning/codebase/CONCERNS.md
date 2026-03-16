# Codebase Concerns

**Analysis Date:** 2026-03-16

## Tech Debt

**`@ts-nocheck` in `kanban-controller.ts`:**
- ✅ **Resolved:** `@ts-nocheck` removed from `kanban-controller.ts` (2026-03-16)

**Oversized Controllers:**
- Issue: Several client controllers are >2,000 lines with mixed concerns
- Files: `apps/web/src/lib/task-modal-controller.ts` (2,484 LoC), `apps/web/src/lib/kanban-controller.ts` (2,025 LoC)
- Impact: Difficult to navigate, test, and maintain. High cognitive load.
- Fix approach: Decompose into focused sub-modules per domain concern
- ✅ **Resolved:** `settings-controller.ts` decomposed from 3,218 LoC into 7 domain controllers (2026-03-16)

**Raw `console.*` Calls:**
- ✅ **Resolved:** Reduced to 6 calls in logger infrastructure files only (`client-logger.ts` (5), `api-logger.ts` (1)) — these are legitimate console.* calls inside the logger implementation itself. Zero raw console.* in application code. (2026-03-16)

**`(window as any)` Global Casts (✅ Resolved — 0 remaining):**
- ✅ All 11 uses eliminated via comprehensive Window interface in `env.d.ts` (Phase 13, 2026-03-16)
- Files by category:
  - **Listener guard flags (4):** `SettingsSystem.astro` (2), `PwaInstallBanner.astro` (2) — `__pwaCompactListenersBound`, `__pwaBannerListenersBound`
  - **Page-lifecycle interval tracking (3):** `page-lifecycle.ts` (3) — `__meitheal_interval_*` keys
  - **Exported global functions (2):** `FilterToolbar.astro` (`__isTaskVisible`), `PomodoroTimer.astro` (`startPomodoro`)
  - **Utility polling (2):** `wait-for-fn.ts` (2) — polls for dynamically loaded functions
- Impact: No type safety for inter-component contracts. Prone to silent failures.
- Fix approach: Add `Window` interface declaration in `env.d.ts` for all known globals

**`window.location.reload()` Anti-Pattern (✅ 10 remaining — all legitimate):**
- Issue: Multiple calls to `window.location.reload()` instead of DOM/state updates
- Files by count: `kanban-controller.ts` (10), `today-controller.ts` (8), `task-modal-controller.ts` (2), `settings-danger-controller.ts` (2), `SettingsSystem.astro` (2), `settings-theme-controller.ts` (1), `settings-data-controller.ts` (1), `layout-pwa-controller.ts` (1), `layout-controller.ts` (2), `calendar.astro` (1), `offline.astro` (1), `SidebarBoardSwitcher.astro` (1), `SavedFilterPresets.astro` (1), `Layout.astro` (1)
- Impact: Full page reloads disrupt user context, cause iframe reload behind HA ingress, waste bandwidth
- Fix approach: Replace with `meitheal:tasks-changed` CustomEvent dispatch for task mutations, keep legitimate reloads (settings purge/reset/import/locale/theme/sw-update)
- ✅ **Resolved for settings:** Reloads reduced to 4 documented legitimate uses (purge/reset/import/locale) in Phase 08.2. All 11 controllers fully audited (2026-03-16)
- ✅ **Phase 12:** NewTaskModal reload replaced with `meitheal:tasks-changed` CustomEvent + universal layout listener (2026-03-16)

**Settings XSS Hardening:**
- ✅ **Resolved:** All 11 settings controllers use `escapeHtml()` from shared `@lib/safe-html.ts` for any server/user data interpolated into `innerHTML`. All fetch calls wired with `pageLifecycle.signal` for abort safety. 58+ event listeners migrated to `pageLifecycle.on()` for memory safety. (2026-03-16)

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
- Problem: `SettingsGeneral.astro` (1,497 LoC), `SettingsSystem.astro` (1,288 LoC) are moderately large
- Files: `apps/web/src/components/settings/Settings*.astro`
- Improvement path: Lazy-load settings sections, code-split per tab
- ✅ **Partially resolved:** `SettingsIntegrations.astro` reduced from 2,654 to 1,403 LoC via 6 sub-components in `integrations/` (2026-03-16)

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
