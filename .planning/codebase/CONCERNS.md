# Codebase Concerns — Meitheal

> Last refreshed: 2026-03-20 (Phase 16 — Task Views Overhaul)

## 🔴 Critical Concerns

### 1. Eisenhower Page Isolation
**Files:** `pages/eisenhower.astro` (1425 lines), `lib/eisenhower-controller.ts` (654 lines)
**Issue:** Eisenhower is the only task page that does NOT use UnifiedBar, page-shell-controller, or pageLifecycle. It has its own header, mobile tabs, triage overlay, review wizard, and drag-and-drop system — all standalone.
**Impact:** Consistency violation across all UX heuristics. Breaking changes to shared infrastructure don't affect Eisenhower (hidden drift). No shared test coverage.
**Remediation:** Adopt UnifiedBar + create eisenhower-registry + refactor controller to use `initPageShellNavigation`.

### 2. Zero Client-Side Controller Tests
**Files:** All `*-controller.ts` files
**Issue:** Vanilla JS controllers handle scroll spy, tab overflow, drag-and-drop, keyboard navigation, and more — all untested. Shell spec files test server-rendered output but not runtime behavior.
**Impact:** Regressions in client-side logic go undetected until user reports.
**Remediation:** Add controller unit tests or adopt a lightweight browser test framework.

### 3. Orphaned API Routes (20+)
**Files:** See INTEGRATION-CHECK.md
**Issue:** 20+ API route files have zero discovered frontend consumers. Many are feature stubs that were implemented server-side but never wired to UI.
**Impact:** Dead code, maintenance burden, potential security surface.
**Remediation:** Audit each route — wire to UI, remove, or document as external-only.

### 4. Orphaned `TaskViewTabs.astro`
**File:** `components/tasks/TaskViewTabs.astro`
**Issue:** No pages import this component after Phase 16 moved view switching to UnifiedBar pills. The file still exists in the codebase.
**Impact:** Dead code, confusion for future contributors.
**Remediation:** Delete `TaskViewTabs.astro` (verify zero imports first).

## ⚠️ High Concerns

### 5. Large Controller Files
**Files:**

| Controller | Lines |
|-----------|-------|
| `task-modal-controller.ts` | 2522 |
| `kanban-controller.ts` | 1657 |
| `table-controller.ts` | 1012 |
| `today-controller.ts` | 934 |
| `habits-controller.ts` | 907 |

**Issue:** Single-file controllers handling multiple concerns (initialization, event handlers, UI updates, API calls, state management). Kanban was partially decomposed (3 sub-controllers extracted), but the main file is still large.
**Impact:** Difficult to maintain, test, or modify individual features.
**Remediation:** Continue decomposition pattern from kanban-controller to other large controllers.

### 6. Inline Styles in Upcoming
**File:** `pages/upcoming.astro`
**Issue:** >200 lines of inline `style=` attributes on task items instead of CSS classes.
**Impact:** No shared styling with other pages' task rendering. Maintenance nightmare.
**Remediation:** Use `TaskListItem.astro` or create `UpcomingTaskCard.astro`.

### 7. Global CSS Leaks from Eisenhower
**File:** `pages/eisenhower.astro`
**Issue:** Uses `:global(.quadrant__wip-warning)` and `:global(.tli--dragging)` — these styles leak across all pages.
**Impact:** Unintended style changes on other pages if class names collide.
**Remediation:** Use scoped styles or page-specific class prefixes.

### ~~8. Hardcoded scroll-margin-top~~ ✅ Partially Resolved
**Files:** All pages with sections
**Issue:** `scroll-margin-top: 88px` hardcoded everywhere. If unified bar height changes, all pages break.
**Impact:** Fragile coupling between bar height and page layout.
**Resolution:** `habits.astro`, `index.astro` migrated to `--unified-bar-height` CSS var. `eisenhower.astro` already used it. Remaining pages are low-priority.

### ~~9. Missing `prefers-reduced-motion`~~ ✅ Resolved
**Files:** All pages with animations
**Issue:** Section flash, collapse/expand, drag feedback animations have no reduced-motion alternative.
**Resolution:** Added `@media (prefers-reduced-motion: reduce)` to `SignalBar.astro`, `tasks.astro` (popover, drag), `eisenhower.astro` (wip-pulse, triage, review overlays), `UnifiedBar.astro` (chevron, dropdown). `today.astro` already had comprehensive coverage.

### ~~10. Title Switcher Discoverability~~ ✅ Resolved
**File:** `unified-bar-controller.ts`
**Issue:** Title text is clickable to show a page navigation dropdown, but there's no visual affordance.
**Resolution:** Already has chevron icon, `cursor: pointer`, `aria-haspopup="true"`, hover bg change, and active border highlight. No further action needed.

## ⚠️ Medium Concerns

### 11. Section Registries Not Abstracted
**Files:** 9 separate `*-registry.ts` files
**Issue:** All follow the same `{ id, label }[]` pattern but each is independently maintained with no shared type or factory.
**Impact:** Low, but a missed opportunity for type safety and pattern enforcement.
**Remediation:** Create `lib/section-registry.ts` shared type + factory.

### 12. Triage Data Not Surfaced
**File:** `eisenhower-controller.ts`
**Issue:** Triage mode collects interest/engagement data (🤩 engaging, 😬 dreaded) but this data is never shown in any UI after triage completes.
**Impact:** User effort wasted — they classify tasks but the classification disappears.
**Remediation:** Surface engagement scores in task detail modal or strategic views.

### 13. No Active Task Indicator
**Issue:** No unified bar element shows "what am I working on right now." The bar shows navigation and capture, but not current focus.
**Impact:** Context loss when returning to the app after interruption.
**Remediation:** Consider adding a persistent "currently working on" indicator.

### 14. `tasks.astro` Growing Large (1767 lines)
**File:** `pages/tasks.astro`
**Issue:** After absorbing kanban content, `tasks.astro` is now the largest page. Combines SSR data fetching, view pill generation, signal bar, filter toolbar, kanban board HTML, and 400+ lines of CSS.
**Impact:** Harder to navigate and modify. Signal bar and filter toolbar patterns are duplicated across pages.
**Remediation:** Extract `SignalBar.astro` and `FilterToolbar.astro` as shared components.

## ✅ Resolved Concerns (Phase 16)

| # | Former Concern | Resolution |
|---|---------------|------------|
| 2 | Shell CSS Duplication (~600 lines) | Hero sections removed, replaced with signal bars. Duplication reduced significantly. |
| 11 | Dual Navigation Bar on 3 Pages | `TaskViewTabs` removed from all pages; view switching merged into UnifiedBar as pill buttons. |

## Technical Debt Summary

| Category | Items | Total Lines Affected |
|----------|-------|---------------------|
| Consistency gaps | 1 (Eisenhower) | ~2,100 |
| Test gaps | 2 (controllers, eisenhower) | ~14,000 |
| Code quality | 4 (large files, inline styles, globals, orphaned component) | ~5,500 |
| Accessibility | 2 (reduced-motion, title affordance) | ~500 |
| DX/Maintenance | 4 (orphaned routes, hardcoded values, no abstraction, no active indicator) | ~1,200 |
