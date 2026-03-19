---
phase: 14.2-unified-bar-cross-page
verified: 2026-03-19T23:06:00Z
status: gaps_found
score: 7/9 must-haves verified
gaps:
  - truth: "Eisenhower page uses UnifiedBar for consistent navigation"
    status: failed
    reason: "Eisenhower has completely separate header, mobile tabs, and controller — does not import UnifiedBar or page-shell-controller"
    artifacts:
      - path: "apps/web/src/pages/eisenhower.astro"
        issue: "Uses standalone eisenhower__header instead of UnifiedBar"
      - path: "apps/web/src/lib/eisenhower-controller.ts"
        issue: "999 lines, does not call initPageShellNavigation, does not import from page-shell-controller"
    missing:
      - "Import and render UnifiedBar component in eisenhower.astro"
      - "Refactor eisenhower-controller to call initPageShellNavigation"
      - "Create eisenhower-registry.ts for section definitions"
  - truth: "Shell CSS is DRY across all pages"
    status: failed
    reason: "Hero sections, shell grid, section intros duplicated across Calendar, Upcoming, Table, Kanban (~150 lines each)"
    artifacts:
      - path: "apps/web/src/pages/calendar.astro"
        issue: "calendar-hero, calendar-shell CSS blocks duplicated from shared pattern"
      - path: "apps/web/src/pages/table.astro"
        issue: "table-hero, table-shell CSS blocks duplicated from shared pattern"
      - path: "apps/web/src/pages/upcoming.astro"
        issue: "upcoming-hero, upcoming-shell CSS blocks duplicated from shared pattern"
    missing:
      - "Extract shared PageShell.astro or shell.css with common hero/section/flow patterns"
human_verification:
  - test: "Navigate between all pages and verify unified bar rendering is consistent"
    expected: "Same bar height, title position, tab pill alignment, search/action placement on every page"
    why_human: "Visual consistency cannot be verified programmatically"
  - test: "Test Eisenhower mobile tab switching"
    expected: "Quadrant tabs work on <768px viewport"
    why_human: "Viewport-dependent behavior needs manual testing"
---

# Unified Bar Cross-Page — Verification Report

**Phase Goal:** Provide consistent navigation shell (UnifiedBar) across all task-oriented pages
**Verified:** 2026-03-19
**Status:** gaps_found
**Build:** `pnpm check` passes clean (exit 0)

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | UnifiedBar renders on Today | ✅ VERIFIED | `today.astro` imports at line 22, renders at line 169, barId=`today-bar` |
| 2 | UnifiedBar renders on Upcoming | ✅ VERIFIED | `upcoming.astro` imports at line 3, renders at line 95, barId=`upcoming-bar` |
| 3 | UnifiedBar renders on Calendar | ✅ VERIFIED | `calendar.astro` imports at line 3, renders at line 145, barId=`calendar-bar` |
| 4 | UnifiedBar renders on Kanban | ✅ VERIFIED | `kanban.astro` imports UnifiedBar, renders with barId=`kanban-bar` |
| 5 | UnifiedBar renders on Table | ✅ VERIFIED | `table.astro` imports at line 3, renders at line 89, barId=`table-bar` |
| 6 | UnifiedBar renders on Eisenhower | ❌ FAILED | Eisenhower uses its own `eisenhower__header` with no UnifiedBar import |
| 7 | Section navigation (tab pills → scroll) works | ✅ VERIFIED | All 5 shell controllers call `initPageShellNavigation` with section registries |
| 8 | Shell test coverage exists | ✅ VERIFIED | 7 shell spec files: today, upcoming, calendar, kanban, table, dashboard, habits |
| 9 | Shell CSS is DRY | ❌ FAILED | ~150 lines of hero/shell CSS duplicated per page (Calendar, Upcoming, Table, Kanban) |

**Score:** 7/9 truths verified

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `UnifiedBar.astro` | Reusable bar component | ✅ VERIFIED | 512 lines, clean props API, slot support |
| `unified-bar-controller.ts` | Controller for bar interactivity | ✅ VERIFIED | 187 lines, exports 5 functions |
| `page-shell-controller.ts` | Shared shell navigation logic | ✅ VERIFIED | 259 lines, generic `initPageShellNavigation<T>` |
| Section registries (7) | Define sections per page | ✅ VERIFIED | All 7 exist and are consumed by 2 files each |
| `eisenhower-controller.ts` | Should use shared shell | ❌ ORPHANED | 999 lines, standalone, no shared infrastructure |

### Key Link Verification

| From | To | Via | Status | Details |
|------|-----|-----|--------|---------|
| `UnifiedBar.astro` | `Layout.astro` | `slot="custom-header"` | ✅ WIRED | All consuming pages use the slot pattern |
| `page-shell-controller.ts` | `unified-bar-controller.ts` | `import { initTitleSwitcher }` | ✅ WIRED | 4 functions imported and called |
| `{page}-controller.ts` | `page-shell-controller.ts` | `import { initPageShellNavigation }` | ✅ WIRED (5/6) | Eisenhower missing |
| `{page}-registry.ts` | `{page}.astro` + controller | direct import | ✅ WIRED (7/7) | All registries consumed |
| `eisenhower-controller.ts` | `page-shell-controller.ts` | — | ❌ NOT WIRED | No import exists |

### Anti-Patterns Found

| File | Pattern | Severity | Impact |
|------|---------|----------|--------|
| `eisenhower.astro` | `:global(.quadrant__wip-warning)` | ⚠️ Warning | CSS leaks to other pages via global scope |
| `eisenhower.astro` | `:global(.tli--dragging)` | ⚠️ Warning | CSS leaks to other pages via global scope |
| `upcoming.astro` | >200 inline `style=` attributes | ⚠️ Warning | Maintenance burden, no shared styling |
| `calendar.astro` / `table.astro` / `upcoming.astro` | ~150 lines duplicated hero/shell CSS | 🔴 Blocker | DRY violation, maintenance risk |
| All pages | `scroll-margin-top: 88px` hardcoded | ⚠️ Warning | Fragile if bar height changes |
| `eisenhower-controller.ts` | 999 lines, single file | ⚠️ Warning | Should be decomposed into sub-controllers |

### Human Verification Required

#### 1. Visual Consistency Across Pages
**Test:** Navigate Today → Upcoming → Calendar → Kanban → Table on desktop and mobile
**Expected:** Same bar height, same title alignment, same search/action placement, consistent tab pill rendering
**Why human:** Visual pixel-level consistency can't be verified by grep

#### 2. Eisenhower Mobile Tab UX
**Test:** Open Eisenhower at <768px viewport
**Expected:** Quadrant tabs show/hide correctly, tab state persists
**Why human:** Viewport-dependent behavior

#### 3. Title-Switcher Discoverability
**Test:** Ask a new user to navigate to a different page from any page
**Expected:** User can discover the title dropdown within 5 seconds
**Why human:** Discoverability is a usability test, not a code test

### Gaps Summary

Two gaps block full goal achievement:

1. **Eisenhower isolation** — the page has rich functionality (triage, review, drag-and-drop, focus mode, mobile tabs, quick capture) but none of it shares infrastructure with the unified bar system. This is the single largest integration gap in the codebase. Remediation: adopt UnifiedBar + create eisenhower-registry + refactor controller to use `initPageShellNavigation`.

2. **Shell CSS duplication** — hero sections, shell grids, section intros, flow cards, and animation keyframes are copy-pasted across 4+ pages with only naming changes (e.g., `.calendar-hero__title` vs `.upcoming-hero__title` vs `.table-hero__title`). Remediation: extract shared `PageShell.astro` component or `shell.css` stylesheet.

---

_Verified: 2026-03-19T23:06:00Z_
_Verifier: Antigravity (gsd-verifier)_
