# DDD Audit: Consolidated Release Readiness Report

**Project:** Meitheal — Task Management & Strategic Planning Hub (Home Assistant Add-on)
**Audit Date:** 2026-03-19
**Methodology:** Full codebase DDD domain mapping → Per-domain persona panels (ADHD, Frontier, Accessibility, DDD Boundary)

---

## 1. Architecture Overview

Meitheal is a DDD monorepo with **21 bounded contexts** across 3 tiers:

- **4 package-level domains** (pure logic): `domain-auth`, `domain-tasks`, `domain-strategy`, `domain-observability`
- **1 integration package**: `integration-core` (adapters for Calendar, Grocy, D1, A2A, webhooks)
- **16 in-app domains**: Tasks, Auth, HA, Calendar, Todo, Gamification, Habits, Pomodoro, Strategy, Labels, Search, Notifications, Offline, Grocy, AI, Vikunja Compat

**UI Surface:** 14 pages, 64+ components, 97+ API routes, global modals/widgets

---

## 2. Release Readiness Scorecard

### By Domain (Frontier Panel Summary)

| Domain | Overall Status | Release Blockers | Polish Needed |
| --- | --- | --- | --- |
| **Core Tasks** (CRUD, views) | ✅ Release-ready | None | Bulk operations, keyboard nav |
| **Kanban** | ✅ Release-ready | None | ARIA live regions for drag-drop |
| **Table** | ✅ Release-ready | None | None |
| **Today** | ✅ Release-ready | None | Collapsible sections |
| **Upcoming** | ⚠️ Near-ready | Quick reschedule from this view | Minor |
| **Gantt** | ⚠️ MVP-level | No drag-resize, no dep editing, no zoom | Major rework needed for release |
| **Calendar** | ⚠️ Near-ready | No week/day view, no click-to-add | Medium polish |
| **Projects/Hierarchy** | ⚠️ Near-ready | No dedicated goal dashboard | Medium polish |
| **Gamification** | ✅ Near-ready | Streak freeze mechanic missing | Minor |
| **Habits** | ✅ Functional | None blocking | Starter templates |
| **Pomodoro** | ✅ Release-ready | None | Sound/vibration alerts |
| **Strategy/RICE** | ✅ Release-ready | None | Auto-suggest scoring |
| **Labels** | ✅ Release-ready | None | Label groups/categories |
| **HA Integration** | ✅ Release-ready | None | Connection status indicator |
| **Todo Sync** | ✅ Release-ready | None | None |
| **Calendar Sync** | ✅ Release-ready | None | CalDAV UI wiring |
| **Grocy** | ✅ Release-ready | None | Auto-detect addon |
| **Search** | ✅ Release-ready | None | Command palette expansion |
| **AI/Assist** | ✅ Release-ready | None | Suggested prompts |
| **Offline/PWA** | ⚠️ Near-ready | No conflict resolution UI, no connectivity indicator | Critical for offline UX |
| **Auth/Security** | ✅ Release-ready | None (WebAuthn is mock-only but not user-facing) | None |
| **Settings Shell** | ✅ Release-ready | None | Onboarding wizard |
| **Layout/Navigation** | ✅ Release-ready | None | Sidebar collapse mode |

### Release-Blocking Items (Must Fix)

1. **Offline connectivity indicator** — Users have zero visibility into offline/online state in main UI
2. **Conflict resolution notification** — Sync engine does last-write-wins silently; users need to know when conflicts occur

### High-Priority Pre-Release Items

3. **Gantt view maturity** — Either upgrade to interactive (drag-resize, zoom) or clearly mark as beta/experimental
4. **Calendar week/day views** — Monthly-only calendar limits daily planning
5. **Bulk task operations** — Multi-select + bulk status/priority/label change expected by users coming from Todoist/Asana/Linear
6. **Streak freeze/grace** — ADHD users will abandon the app if streak anxiety kicks in
7. **Sound/vibration for Pomodoro** — Timer completion without audio/haptic feedback defeats the purpose for ADHD users

---

## 3. ADHD Design Audit (Consolidated)

### Strengths (Keep These)

| Pattern | Where | Why It Works |
| --- | --- | --- |
| NL-aware quick-add | NewTaskModal, `/api/parse-task` | Reduces task entry friction dramatically — type naturally, system parses |
| MITs / Pinned tasks | Today page "Pinned" section | Focuses attention on what matters — critical for ADHD executive function |
| Confetti + XP | GamificationWidget, Confetti component | Completion-triggered dopamine reward — textbook ADHD motivation |
| ⌘K command palette | SearchHub | Fast context-switching without losing place — ADHD preferred navigation |
| Saved filter presets | SavedFilterPresets, Table view | Consistent views reduce "where was I?" ADHD friction |
| Carried-forward triage | Today page | Surfaces overdue tasks with intent — reschedule or complete, no guilt |
| Task type icons | TaskTypeIcon | Visual differentiation without reading — immediate pattern recognition |
| Board color coding | Board indicators | Visual grouping without cognitive load |

### Weaknesses (Fix for Release)

| Issue | Severity | Fix |
| --- | --- | --- |
| Dashboard information overload | HIGH | Add "Focus Mode" showing only today's top 3 MITs |
| Today page 8+ sections | HIGH | Make sections collapsible with remembered state |
| No sonic/haptic Pomodoro alerts | HIGH | Add configurable sound + vibration on timer completion |
| Streak anxiety (no freeze) | HIGH | Add 1-2 day streak freeze/grace period |
| Settings page complexity | MEDIUM | Add "Quick Setup" onboarding wizard for new users |
| No keyboard shortcut reference | MEDIUM | Add in-app shortcut guide (modal or settings section) |
| Gamification page data dump | MEDIUM | Use tabs or progressive disclosure |
| No sidebar collapse mode | LOW | Icon-only mode for focus |
| Project creation multi-step | LOW | "Quick Project" with auto-generated parent entities |

### ADHD Design Principles for Remaining Work

1. **One primary action per screen** — Every page should have one obvious "most important thing to do"
2. **Progressive disclosure** — Show summary first, details on demand
3. **Immediate feedback** — Every action should produce visible, rewarding feedback within 200ms
4. **Escape hatches** — Always provide a way to go back, undo, or defer without penalty
5. **External brain support** — The app should remember preferences, positions, and context across sessions

---

## 4. Accessibility Audit (Consolidated)

### Strengths

- TaskListItem: `role="button"`, `tabindex="0"`, descriptive `aria-label` with full context
- Modals: Proper `role="dialog"`, `aria-modal="true"`, `aria-labelledby`
- SearchHub: ARIA dialog pattern, keyboard navigation
- Checkboxes: Individual `aria-label` per task
- Favorite toggle: State-dependent `aria-label`

### Gaps (Fix for Release)

| Issue | Severity | Location |
| --- | --- | --- |
| Kanban drag-drop screen reader support | HIGH | Kanban page — needs ARIA live regions |
| Color-only priority indicators | HIGH | Priority dots use color only — need text/icon alternatives |
| Table sort/filter announcements | MEDIUM | Table view — filter changes not announced |
| Missing skip-to-content link | MEDIUM | Layout.astro — no skip nav |
| Settings tab focus management | MEDIUM | Tab switching should move focus to content |
| Calendar day cell semantics | LOW | Calendar uses divs — should use `role="gridcell"` |
| Gamification ring alt text | LOW | SVG progress ring needs accessible label |

---

## 5. DDD Boundary Health (Consolidated)

### Clean Boundaries (Compliant)

| Boundary | Evidence |
| --- | --- |
| Tasks ↔ Gamification | Gamification exports clean barrel file; tasks domain doesn't import gamification internals |
| Tasks ↔ Strategy | Strategy is a separate package; app-layer strategy repos access via public API |
| Auth ↔ Tasks | Auth is middleware-only; task domain unaware of auth |
| HA ↔ Todo | Todo bridge imports from HA barrel file, not internal modules |
| Search ↔ Tasks | Search imports from task repos but builds its own result types |
| Observability ↔ Everything | Logger is a pure utility package, no domain knowledge |

### Boundary Concerns (Address Before Scale)

| Concern | Severity | Details | Recommendation |
| --- | --- | --- | --- |
| HierarchyRepository in tasks/ | MEDIUM | Areas, Goals, Projects live in `domains/tasks/persistence/` but represent a separate aggregate | Extract to `domains/hierarchy/` or `packages/domain-hierarchy/` |
| Habits → task persistence | MEDIUM | `habit-service.ts` imports directly from `domains/tasks/persistence/store` | Habits should have own persistence or use task domain public API |
| Notifications → HA internals | LOW | Lazy-loaded but caches internal HA module refs | Route through HA barrel file exports only |
| Middleware complexity | LOW | Single file handles auth, rate limiting, settings, HA init, CSRF, HTML rewriting | Compose into separate middleware functions |
| Labels bridging Vikunja | LOW | `label-store.ts` bridges native labels and Vikunja compat table | Clean separation exists; document the bridge pattern |

---

## 6. CSS & Design System Audit

### Current State

- **17 CSS partial files** in `styles/`: tokens, base, buttons, cards, feedback, filter-toolbar, forms, kanban, labels, layout, modal, responsive, search-hub, search, table, tasks, utilities
- **Design token system**: CSS custom properties (`--text-primary`, `--bg-primary`, `--accent`, etc.)
- **HA theme bridge**: Maps HA theme variables to Meitheal tokens
- **Dark mode**: Supported via custom property overrides
- **Typography**: Geist Variable font (body), Outfit (headings)

### Consistency Issues

| Issue | Details |
| --- | --- |
| Mixed styling approaches | Some components use Tailwind utility classes (TaskDetailModal), others use BEM-like CSS classes (TaskListItem), others use inline styles (Settings) |
| Inline styles in Settings | SettingsGeneral.astro uses `style="..."` attributes instead of CSS classes |
| No spacing scale documentation | Gaps/padding use arbitrary pixel values rather than a token-based scale |
| Component CSS co-location inconsistent | Some components have `<style>` blocks, some use global CSS partials, some use utility classes |

### Recommendation

Adopt a consistent approach: Use CSS custom property tokens for spacing/sizing, BEM naming for component classes, and limit Tailwind utilities to layout-only concerns in modal components.

---

## 7. i18n Coverage

| Status | Details |
| --- | --- |
| Languages | English (en), Irish (ga) |
| Structure | JSON translation files + `t()` helper function |
| Coverage | Core navigation and common UI strings. Many settings/integration strings are English-only |
| Gap | Gamification, Habits, Review page strings aren't in translation files |
| Gap | Error messages from API are English-only |

---

## 8. Recommended Release Priorities

### Phase 1: Release Blockers (P0)

1. Add connectivity indicator to main UI (sidebar footer or status bar)
2. Add conflict notification when sync engine encounters conflicts
3. Mark Gantt view as "Beta" or hide behind feature flag

### Phase 2: High-Value Polish (P1)

4. Add Focus Mode to Dashboard (show only top 3 MITs)
5. Make Today page sections collapsible with persistent state
6. Add streak freeze/grace mechanic
7. Add Pomodoro sound/vibration alerts
8. Add bulk task operations (multi-select)
9. Fix color-only priority indicators (add icons/text)
10. Add skip-to-content link in Layout

### Phase 3: Competitive Parity (P2)

11. Calendar week/day views
12. Keyboard shortcut reference guide
13. Gantt view interactivity (drag-resize, zoom)
14. Suggested prompts in AI Assist
15. Command palette expansion (/, slash commands)
16. Onboarding wizard for new users
17. Sidebar icon-only collapse mode

### Phase 4: DDD Cleanup (P3)

18. Extract HierarchyRepository to separate bounded context
19. Decouple Habits from direct task persistence import
20. Compose middleware into separate functions
21. Standardize CSS approach (tokens + BEM, minimize Tailwind and inline styles)
22. Complete i18n coverage for all domains

---

## 9. Files Created

| File | Purpose |
| --- | --- |
| `.planning/research/ddd-audit/DOMAIN-MAP.md` | Complete domain inventory with 21 bounded contexts, UI surface map, API routes |
| `.planning/research/ddd-audit/PER-DOMAIN-AUDITS.md` | 11 sub-agent persona panel reviews (ADHD, Frontier, Accessibility, DDD Boundary) |
| `.planning/research/ddd-audit/CONSOLIDATED-REPORT.md` | This file — executive summary with release priorities |

---

## 10. Confidence Assessment

| Area | Confidence | Basis |
| --- | --- | --- |
| Domain inventory completeness | HIGH | Direct file enumeration + content analysis of all 21 domains |
| UI/UX assessment accuracy | MEDIUM-HIGH | Read all page templates, component sources, controllers |
| ADHD design recommendations | HIGH | Based on established ADHD-UX research patterns + codebase evidence |
| DDD boundary analysis | MEDIUM | File imports analyzed but no static analysis tool applied |
| Release priority ordering | MEDIUM | Based on competitive analysis training data + codebase maturity signals |
| CSS/design system audit | MEDIUM | Structural analysis; no visual rendering inspected |
