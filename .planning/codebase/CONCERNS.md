# Codebase Concerns — Meitheal

> Last refreshed: 2026-03-19

## 🔴 Critical Concerns

### 1. Eisenhower Page Isolation
**Files:** `pages/eisenhower.astro` (1337 lines), `lib/eisenhower-controller.ts` (999 lines)
**Issue:** Eisenhower is the only task page that does NOT use UnifiedBar, page-shell-controller, or pageLifecycle. It has its own header, mobile tabs, triage overlay, review wizard, and drag-and-drop system — all standalone.
**Impact:** Consistency violation across all UX heuristics. Breaking changes to shared infrastructure don't affect Eisenhower (hidden drift). No shared test coverage.
**Remediation:** Adopt UnifiedBar + create eisenhower-registry + refactor controller to use `initPageShellNavigation`.

### 2. Shell CSS Duplication (~600 lines)
**Files:** `calendar.astro`, `upcoming.astro`, `table.astro`, `kanban.astro`
**Issue:** Hero sections, shell grids, section intros, flow cards, animation keyframes are copy-pasted across 4+ pages. Each page has ~150 lines of identical structure CSS with only naming changes (`.calendar-hero__title` vs `.upcoming-hero__title`).
**Impact:** Any shell style change requires editing 4+ files. Easy to introduce inconsistency.
**Remediation:** Extract `PageShell.astro` or `shell.css` with shared hero/section/flow patterns.

### 3. Zero Client-Side Controller Tests
**Files:** All `*-controller.ts` files
**Issue:** Vanilla JS controllers handle scroll spy, tab overflow, drag-and-drop, keyboard navigation, and more — all untested. Shell spec files test server-rendered output but not runtime behavior.
**Impact:** Regressions in client-side logic go undetected until user reports.
**Remediation:** Add controller unit tests or adopt a lightweight browser test framework.

### 4. Orphaned API Routes (20+)
**Files:** See INTEGRATION-CHECK.md
**Issue:** 20+ API route files have zero discovered frontend consumers. Many are feature stubs that were implemented server-side but never wired to UI.
**Impact:** Dead code, maintenance burden, potential security surface.
**Remediation:** Audit each route — wire to UI, remove, or document as external-only.

## ⚠️ High Concerns

### 5. Large Controller Files
**Files:**
| Controller | Lines |
|-----------|-------|
| `task-modal-controller.ts` | 2522 |
| `kanban-controller.ts` | 2063 |
| `today-controller.ts` | 1548 |
| `table-controller.ts` | 1352 |
| `eisenhower-controller.ts` | 999 |

**Issue:** Single-file controllers handling multiple concerns (initialization, event handlers, UI updates, API calls, state management).
**Impact:** Difficult to maintain, test, or modify individual features.
**Remediation:** Decompose into sub-controllers per concern.

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

### 8. Hardcoded scroll-margin-top
**Files:** All pages with sections
**Issue:** `scroll-margin-top: 88px` hardcoded everywhere. If unified bar height changes, all pages break.
**Impact:** Fragile coupling between bar height and page layout.
**Remediation:** Use CSS custom property `--bar-height` set by the bar itself.

### 9. Missing `prefers-reduced-motion`
**Files:** All pages with animations
**Issue:** Section flash, collapse/expand, drag feedback animations have no reduced-motion alternative.
**Impact:** Accessibility violation for users with motion sensitivity.
**Remediation:** Add `@media (prefers-reduced-motion: reduce)` queries.

### 10. Title Switcher Discoverability
**File:** `unified-bar-controller.ts`
**Issue:** Title text is clickable to show a page navigation dropdown, but there's no visual affordance (no chevron, no cursor change, no underline).
**Impact:** Power-user feature that most users will never discover.
**Remediation:** Add dropdown chevron icon + `aria-haspopup="true"`.

## ⚠️ Medium Concerns

### 11. Dual Navigation Bar on 3 Pages
**Files:** `calendar.astro`, `kanban.astro`, `table.astro`
**Issue:** These pages render both UnifiedBar (section tabs) AND TaskViewTabs (page switching). Two horizontal bars with similar appearance but different functions.
**Impact:** Cognitive load, especially on mobile where both consume screen space.
**Remediation:** Consider merging TaskViewTabs into UnifiedBar as a secondary row or dropdown.

### 12. Section Registries Not Abstracted
**Files:** 7 separate `*-registry.ts` files
**Issue:** All follow the same `{ id, label }[]` pattern but each is independently maintained with no shared type or factory.
**Impact:** Low, but a missed opportunity for type safety and pattern enforcement.
**Remediation:** Create `lib/section-registry.ts` shared type + factory.

### 13. Triage Data Not Surfaced
**File:** `eisenhower-controller.ts`
**Issue:** Triage mode collects interest/engagement data (🤩 engaging, 😬 dreaded) but this data is never shown in any UI after triage completes.
**Impact:** User effort wasted — they classify tasks but the classification disappears.
**Remediation:** Surface engagement scores in task detail modal or strategic views.

### 14. No Active Task Indicator
**Issue:** No unified bar element shows "what am I working on right now." The bar shows navigation and capture, but not current focus.
**Impact:** Context loss when returning to the app after interruption.
**Remediation:** Consider adding a persistent "currently working on" indicator.

## Technical Debt Summary

| Category | Items | Total Lines Affected |
|----------|-------|---------------------|
| Consistency gaps | 2 (Eisenhower, CSS) | ~2,900 |
| Test gaps | 3 (controllers, eisenhower, registries) | ~16,500 |
| Code quality | 4 (large files, inline styles, globals) | ~6,000 |
| Accessibility | 2 (reduced-motion, title affordance) | ~500 |
| DX/Maintenance | 3 (orphaned routes, hardcoded values, no abstraction) | ~1,000 |
