# Phase 15: Hierarchy Architecture Overhaul — PLAN

**Created:** 2026-03-20
**Status:** Ready for execution
**Inputs:** 15-SUMMARY.md, 15-RESEARCH.md, 15-CONTEXT.md, Persona Loop

---

## Goal

Consolidate Meitheal's 11-item flat sidebar navigation into a 6-item focused structure with three parent pages (Tasks, Progress & Growth, Planning), pinnable sub-menus, an "Every Day" default project, routine template system, and direct goal→task linking.

## Wave Structure

### Wave 1: Schema & Domain Model Foundation
**Goal:** Database and domain model changes that everything else depends on.

#### Task 1.1: Add `is_default` to projects table
- **File:** `packages/domain-tasks/src/schema.ts` — add `is_default` column
- **File:** `packages/domain-tasks/src/domain-model.ts` — add `isDefault` to `Project` interface
- **File:** `packages/domain-tasks/src/persistence/project-repository.ts` — add `ensureDefaultProject()`, guard `is_default` in update/delete
- **Success:** Migration creates column, default project auto-created on startup

#### Task 1.2: Add `goal_id` to tasks table
- **File:** `packages/domain-tasks/src/schema.ts` — add `goal_id TEXT REFERENCES goals(id)` FK
- **File:** `packages/domain-tasks/src/domain-model.ts` — add `goalId` to `Task` interface
- **File:** `packages/domain-tasks/src/persistence/task-repository.ts` — include `goal_id` in CRUD
- **Success:** Tasks can optionally link directly to a goal

#### Task 1.3: Add `calendar_event` to TaskKind
- **File:** `packages/domain-tasks/src/domain-model.ts` — add `"calendar_event"` to `TaskKind` union
- **File:** API routes that validate `task_kind` — accept new value
- **Success:** Calendar events can be created as tasks with `task_kind = "calendar_event"`

#### Task 1.4: Create `routine_templates` table
- **File:** `packages/domain-tasks/src/schema.ts` — new table definition
- **File:** `packages/domain-tasks/src/domain-model.ts` — `RoutineTemplate` interface
- **File:** `packages/domain-tasks/src/persistence/routine-repository.ts` — [NEW] CRUD + `spawnDueInstances()` with idempotent check
- **Columns:** `id, title, description, frequency, schedule_config, last_spawned_at, streak_count, streak_freeze_days, is_active, created_at, updated_at`
- **Unique constraint:** `(routine_template_id, spawned_for_date)` on routine instances
- **Success:** Templates can be created, and `spawnDueInstances()` is idempotent (unit test)

#### Task 1.5: API route protection for default project
- **File:** `apps/web/src/pages/api/projects/[id].ts` — reject DELETE on `is_default`, ignore `is_default` in PUT body
- **Success:** `DELETE /api/projects/:id` returns 403 for default, `PUT` ignores `is_default` field

---

### Wave 2: Shared ParentPageShell & Registry Infrastructure
**Goal:** Build the reusable components and registries that all three parent pages will use.

#### Task 2.1: Create `PARENT_PAGE_ROUTES` constant
- **File:** `apps/web/src/lib/parent-page-registry.ts` — [NEW] canonical registry mapping parent pages to their sub-views, old routes, and sidebar config
- **Success:** Single source of truth consumed by sidebar, redirects, and search

#### Task 2.2: Create `ParentPageShell` component
- **File:** `apps/web/src/components/layout/ParentPageShell.astro` — [NEW] shared component wrapping `UnifiedBar` + section show/hide + controller lifecycle
- **Props:** `title, icon, sections: Section[], searchScope, searchPlaceholder`
- **Pattern:** Identical to Settings.astro shell but extracted as reusable component
- **Success:** Component renders title, tab bar, sections container — verified standalone

#### Task 2.3: Create `parent-page-controller.ts`
- **File:** `apps/web/src/lib/parent-page-controller.ts` — [NEW] shared controller for hash routing, tab state, section visibility
- **Pattern:** Based on `settings-page.ts` but generalized
- **Success:** Hash changes show/hide sections, deep-links work, back/forward navigation works

---

### Wave 3: Sidebar Consolidation
**Goal:** Reduce sidebar from 11 items to 6.

#### Task 3.1: Update `NAV_ITEMS` and `DEFAULT_ORDER`
- **File:** `apps/web/src/components/layout/Sidebar.astro` — replace 11 items with 6 consolidated items:
  ```
  dashboard → / (unchanged)
  today → /today (unchanged)
  upcoming → /upcoming (unchanged)
  tasks → /tasks (NEW parent)
  progress → /progress (NEW parent)
  planning → /planning (NEW parent)
  ```
- Remove: `kanban`, `table`, `calendar`, `gamification`, `habits`, `projects`, `goals`, `eisenhower`
- Add: `tasks`, `progress`, `planning`
- **Success:** Sidebar shows exactly 6 nav items

#### Task 3.2: Implement pinnable sub-menus
- **File:** `apps/web/src/components/layout/Sidebar.astro` — add pinned sub-menu rendering (indented children under parent items when sidebar expanded)
- **File:** `apps/web/src/lib/settings-sidebar-controller.ts` — extend `sidebar_config` schema with `pinnedSubMenus` and `subMenusVisibleInSidebar`
- **File:** `apps/web/src/components/settings/SettingsGeneral.astro` — add toggle for sub-menu visibility in Settings
- **Success:** Users can pin sub-views to sidebar, toggle visibility in settings

#### Task 3.3: "Every Day" project in AREAS tree
- **File:** `apps/web/src/components/layout/SidebarHierarchyTree.astro` — render "Every Day" pinned at top of AREAS tree
- **Success:** "Every Day" always shows at top of AREAS section, undeletable

---

### Wave 4: Parent Pages — Tasks, Progress & Growth, Planning
**Goal:** Create the three parent pages with their sub-views.

#### Task 4.1: Create `/tasks` parent page
- **File:** `apps/web/src/pages/tasks.astro` — [NEW] parent page using `ParentPageShell`
- **Sections:** Kanban (`#kanban`), Calendar (`#calendar`), Table (`#table`), Gantt (`#gantt`)
- **File:** `apps/web/src/lib/tasks-page-registry.ts` — [NEW] section definitions
- Inline existing component content from `kanban.astro`, `calendar.astro`, `table.astro`, `gantt.astro`
- **Success:** All four views accessible via tabs at `/tasks`

#### Task 4.2: Create `/progress` parent page
- **File:** `apps/web/src/pages/progress.astro` — [NEW] parent page using `ParentPageShell`
- **Sections:** Routines (`#routines`), Goals (`#goals`), Achievements (`#achievements`)
- **File:** `apps/web/src/lib/progress-page-registry.ts` — [NEW] section definitions
- Inline existing component content from `habits.astro`, `goals/index.astro`, `gamification.astro`
- **Success:** All three views accessible via tabs at `/progress`

#### Task 4.3: Create `/planning` parent page
- **File:** `apps/web/src/pages/planning.astro` — [NEW] parent page using `ParentPageShell`
- **Sections:** Eisenhower (`#eisenhower`), Triage (`#triage`), RICE (`#rice`)
- **File:** `apps/web/src/lib/planning-page-registry.ts` — [NEW] section definitions
- Eisenhower: inline from `eisenhower.astro`
- Triage: [NEW] review queue of unscored/uncategorized tasks
- RICE: [NEW] scoring interface using existing `domain-strategy/rice.ts`
- **Success:** All three views accessible via tabs at `/planning`

#### Task 4.4: Extract Gantt logic to controller
- **File:** `apps/web/src/lib/controllers/gantt-controller.ts` — [NEW] extract from `gantt.astro` inline logic
- Keep modular: data fetching, grid calculation, and event handling as separate functions
- **Success:** Gantt renders via controller, same visual output as current

---

### Wave 5: Redirect Routes & Backward Compatibility
**Goal:** Old URLs keep working.

#### Task 5.1: Convert old pages to redirects
- **Files to modify (convert to redirect):**
  - `apps/web/src/pages/kanban.astro` → redirect to `/tasks#kanban`
  - `apps/web/src/pages/calendar.astro` → redirect to `/tasks#calendar`
  - `apps/web/src/pages/table.astro` → redirect to `/tasks#table`
  - `apps/web/src/pages/gantt.astro` → redirect to `/tasks#gantt`
  - `apps/web/src/pages/gamification.astro` → redirect to `/progress#achievements`
  - `apps/web/src/pages/habits.astro` → redirect to `/progress#routines`
  - `apps/web/src/pages/goals/index.astro` → redirect to `/progress#goals`
  - `apps/web/src/pages/eisenhower.astro` → redirect to `/planning#eisenhower`
  - `apps/web/src/pages/projects/index.astro` → stays (project detail page still needed)
- **Success:** All old bookmarks and links continue working

#### Task 5.2: Update search hub and search results
- **File:** `apps/web/src/lib/search-hub-controller.ts` — update route mappings
- **File:** `apps/web/src/domains/search/` — update search result links to parent page hashes
- **Success:** Search results link to correct parent page sections

#### Task 5.3: Update MCP manifest
- **File:** `public/.well-known/mcp.json` — add sub-view entries for AI agent navigation
- **Success:** AI agents can navigate to specific sub-views

#### Task 5.4: Update PWA service worker precache
- **File:** `apps/web/src/sw.ts` or equivalent — update precache list to new routes
- **Success:** `/tasks`, `/progress`, `/planning` cached for offline

---

### Wave 6: Routine Templates & "Every Day" Integration
**Goal:** Routine template CRUD, auto-spawn, recurring task display.

#### Task 6.1: Routine template API routes
- **File:** `apps/web/src/pages/api/routines/[id].ts` — [NEW] GET/PUT/DELETE single template
- **File:** `apps/web/src/pages/api/routines/index.ts` — [NEW] GET all, POST create
- **File:** `apps/web/src/pages/api/routines/spawn.ts` — [NEW] POST trigger spawn for today
- **Success:** Full CRUD + spawn via API

#### Task 6.2: Auto-spawn on page load
- **File:** `apps/web/src/layouts/Layout.astro` — add spawn trigger on page load (client-side fetch to `/api/routines/spawn`)
- **Success:** Opening any page auto-creates today's due routine instances

#### Task 6.3: Routines section in Progress page
- **File:** `apps/web/src/components/progress/RoutinesSection.astro` — [NEW] routine template list + recurring task callout banner
- Recurring tasks without a routine: separate section with callout at top
- "Convert to Routine" button on each recurring task
- **Success:** Routines page shows templates, streaks, and unlinked recurring tasks

#### Task 6.4: "Every Day" as default quick-add target
- **File:** `apps/web/src/lib/quick-add-controller.ts` — default `project_id` to "Every Day" when none selected
- **File:** quick-add UI components — pre-select "Every Day" project
- **Success:** Quick-add with no project assigns to "Every Day"

---

### Wave 7: Today Page Integration & Hierarchy Breadcrumb
**Goal:** Enhance Today page and task detail with persona recommendations.

#### Task 7.1: Daily routine check-in on Today page
- **File:** `apps/web/src/pages/today.astro` — add collapsible "Routines" section above task list
- Show pending routine instances with one-tap complete
- **Success:** Today page shows routine check-in section

#### Task 7.2: Hierarchy breadcrumb in task detail
- **File:** `apps/web/src/components/tasks/TaskDetailModal.astro` — add breadcrumb showing Area → Goal → Project → Task
- **File:** API — add endpoint or extend task detail to include hierarchy path
- **Success:** Task detail shows full hierarchy path with clickable links

---

### Wave 8: i18n, Glossary, Polish
**Goal:** Translation updates, ubiquitous language glossary, final polish.

#### Task 8.1: Update i18n translations
- **File:** `apps/web/src/i18n/en.json` — add `nav.tasks`, `nav.progress`, `nav.planning`, rename gamification keys to achievements
- **File:** `apps/web/src/i18n/ga.json` — Irish translations for new keys
- **Success:** All new navigation items have proper translations in both locales

#### Task 8.2: Create hierarchy glossary
- **File:** `docs/kcs/hierarchy-glossary.md` — [NEW] ubiquitous language definitions for Area, Goal, Project, Task, Routine, Achievement
- **Success:** All terms have clear, unambiguous definitions

#### Task 8.3: Gantt accessibility improvements
- **File:** `apps/web/src/components/tasks/GanttSection.astro` (or via controller) — add `role="grid"`, `aria-colcount`, `aria-rowcount`, keyboard nav
- **Success:** Screen reader announces task info when navigating Gantt

#### Task 8.4: Goal badge on task cards
- **File:** `apps/web/src/components/tasks/TaskCard.astro` — display goal badge when task has `goal_id`
- **Success:** Tasks with goals show goal name badge in all views

---

## Verification Plan

### Automated Tests
| Test | Command | What |
|------|---------|------|
| Schema migration | `pnpm --filter @meitheal/tests test schema` | `is_default`, `goal_id`, `routine_templates` |
| Routine spawn idempotency | `pnpm --filter @meitheal/tests test routine` | Double-spawn returns same instance |
| Default project protection | `pnpm --filter @meitheal/tests test project` | DELETE 403, PUT ignores `is_default` |
| Redirect routes | `pnpm --filter @meitheal/tests test redirect` | Old URLs redirect to parent pages |
| Sidebar consolidation | E2E browser test | 6 items visible, pinning works |

### Manual Verification
| Tier | What | How |
|------|------|-----|
| 🔧 Tier 1 | Tab switching, section rendering, sidebar | `npm run dev` in `apps/web/` |
| 🏠 Tier 2 | Ingress hash routing, redirects, API guards | `./scripts/devcontainer-up.sh` |
| 🏠 Tier 2 | Routine auto-spawn behind ingress | HA devcontainer |
| 🌐 Tier 3 | Full E2E with real data | Production HA (`ha.internal`) |

### Native-First Verification
- [ ] All parent pages work behind HA ingress (Tier 2)
- [ ] MCP manifest includes sub-view entries
- [ ] PWA caches new routes for offline
- [ ] All sections render SSR (check page source)
- [ ] No client-side framework dependencies added

---

## Dependencies

| Wave | Depends On |
|------|------------|
| Wave 1 (Schema) | Nothing — start here |
| Wave 2 (Shell/Registry) | Nothing — can parallel with Wave 1 |
| Wave 3 (Sidebar) | Wave 2 (needs registry) |
| Wave 4 (Parent Pages) | Wave 2 (needs ParentPageShell) + Wave 1 (needs schema) |
| Wave 5 (Redirects) | Wave 4 (parent pages must exist) |
| Wave 6 (Routines) | Wave 1 (schema) + Wave 4 (Progress page) |
| Wave 7 (Today/Breadcrumb) | Wave 1 (goal_id) + Wave 6 (routine instances) |
| Wave 8 (Polish) | All previous waves |

---

*Phase: 15-hierarchy-architecture-overhaul*
*Plan created: 2026-03-20*
