# Phase 15: Hierarchy Architecture Overhaul - Research

**Researched:** 2026-03-20
**Domain:** Information Architecture, Page Consolidation, Routine Scheduling, Gantt Visualization
**Confidence:** HIGH

## Summary

This phase refactors Meitheal's navigation from flat sidebar items into a three-parent-page model (Tasks, Progress & Growth, Planning) with pinnable sub-menus. The proven pattern already exists in the codebase: Settings uses `UnifiedBar` with hash-based section routing, and all 8 shell rollout phases (14.1–14.7) have validated this approach. The primary technical risk is the new Gantt view, which Frappe Gantt (MIT, vanilla JS, SVG-based) handles cleanly. RICE scoring and Eisenhower already have domain packages (`domain-strategy/src/rice.ts`, `RiceBadge.astro`) so the Planning page consolidation is mostly UI reshuffling.

**Primary recommendation:** Reuse the Settings `UnifiedBar` + hash-routing pattern for all three parent pages. Add Frappe Gantt as the only new dependency. Build the pinnable sub-menu system as a sidebar settings extension (not a new architecture).

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- Parent page name: "Progress & Growth"
- Default project name: "Every Day" — top of AREAS tree
- Three parent pages: Tasks (Kanban/Calendar/Table/Gantt), Progress & Growth (Routines/Goals/Achievements), Planning (Eisenhower/Triage/RICE)
- Sub-menus pinnable to sidebar, hidden by default, configurable in settings
- Sidebar order: Dashboard → Today → Upcoming → Tasks → Progress & Growth → Planning
- "Routine" is canonical term per ADR-007, not "Habit"
- Full build P0-P6, no deferrals
- Gamification → renamed to "Achievements"
- Recurring tasks: separate section with callout banner on Routines page

### Claude's Discretion
- Sub-menu tab labels, helper text content, routine template UI
- "Every Day" icon, Gantt implementation approach, Triage/RICE initial scope

### Deferred Ideas (OUT OF SCOPE)
- HA entity registration for routine streaks (Phase 05.4)
- Offline routine template sync (Phase 05.3)
- Bot-spawned routine instances (Phase 05.2)
- n8n webhook for routine completion (Phase 05.6)
</user_constraints>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| Astro SSR | 5.x (current) | Page framework | Already in use, hash routing proven via Settings |
| UnifiedBar.astro | current | Tab bar component | Proven in Settings + 8 shell rollout phases |
| Custom Gantt (`gantt.astro`) | current | Gantt chart visualization | **Already built** — pure Astro SSR + CSS Grid, zero external deps, uses design tokens |
| pageLifecycle | current | Controller lifecycle | Already standard across all shell rollout pages |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| domain-strategy (rice.ts) | current | RICE scoring engine | Planning page RICE tab |
| RiceBadge.astro | current | RICE score display | Task cards and detail views |
| settings-registry.ts | current | Section metadata pattern | Extend for parent page registries |

### Existing Gantt Analysis
The Gantt view at `apps/web/src/pages/gantt.astro` (392 lines) is already a custom implementation:
- **Rendering:** Pure CSS Grid with server-calculated column positions
- **Data source:** `TaskRepository.getGanttTasks()` queries
- **Features:** Epic grouping, parent/child hierarchy (3 levels), progress bars, today highlight, weekend shading
- **Gaps:** No drag-and-drop, no dependency arrows, no zoom/view-mode switching, no client-side interactivity beyond click-to-open
- **Theming:** Already uses Meitheal design tokens (`--accent`, `--bg-card`, `--border`)

**Phase 15 Gantt work:** Evolve the existing custom implementation with modular, extensible enhancements — NOT replace it with a third-party library. This keeps us license-clean (AGPL-3.0 + Commercial dual-license) and Astro-native.

### Gantt Enhancement Roadmap (Modular)
1. Extract `gantt.astro` inline logic into `lib/gantt-controller.ts` (controller pattern)
2. Add client-side drag-and-drop for date adjustment (vanilla JS, no deps)
3. Add view mode switching (Day/Week/Month) via controller
4. Add dependency arrows (SVG overlay, since CSS Grid can't draw lines)
5. Each enhancement is a standalone module importable by the Gantt component

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Custom Gantt (evolve) | Frappe Gantt (MIT) | Has open issues/PRs, adds external dep, license needs careful review against commercial dual-license |
| Custom Gantt (evolve) | DHTMLX Gantt | Commercial license incompatible with AGPL + Commercial dual-license |
| Custom Gantt (evolve) | jsGanttImproved | Unmaintained, poor a11y, not Astro-native |

**Decision:** Keep and evolve custom Gantt. No new dependencies.

## Architecture Patterns

### Recommended: Parent Page Pattern (Proven)
```
pages/
├── tasks.astro          # Parent → Kanban | Calendar | Table | Gantt
├── progress.astro       # Parent → Routines | Goals | Achievements
├── planning.astro       # Parent → Eisenhower | Triage | RICE
```

Each parent page follows the Settings pattern:
1. Import `UnifiedBar` with tabs array
2. Render all section components inline (no lazy loading — Astro SSR handles this)
3. Hash-based routing: `#kanban`, `#goals`, `#eisenhower`
4. Controller file manages tab switching, data loading
5. Section components are standalone Astro components

### Pattern 1: Registry + Controller + UnifiedBar
**What:** Each parent page gets a registry (section metadata), controller (lifecycle + data), and UnifiedBar
**When to use:** Always — this is the established Meitheal shell pattern
**Example:**
```typescript
// lib/tasks-registry.ts
export const TASKS_SECTIONS = [
  { id: "kanban", label: "Kanban", icon: "kanban" },
  { id: "calendar", label: "Calendar", icon: "calendar" },
  { id: "table", label: "Table", icon: "table" },
  { id: "gantt", label: "Gantt", icon: "gantt" },
]
```

### Pattern 2: Pinnable Sub-Menus via Sidebar Config
**What:** Extend existing `sidebar_config` in settings DB to store pinned sub-menu items
**When to use:** For the pinnable sub-menu feature
**Example:**
```typescript
// In sidebar_config settings value
{
  "order": ["dashboard", "today", "upcoming", "tasks", "progress", "planning"],
  "pinnedSubMenus": {
    "kanban": true,     // Shows as individual sidebar item
    "calendar": false,  // Hidden — only visible inside Tasks parent
    "goals": true       // Shows as individual sidebar item
  },
  "subMenusVisible": false  // Master toggle in Settings
}
```

### Pattern 3: Redirect Routes for Backward Compat
**What:** Old route files that redirect to parent page hash
**When to use:** For `/gamification`, `/habits`, `/goals`, `/kanban`, `/calendar`, `/table`, `/eisenhower`
**Example:**
```astro
---
// pages/gamification.astro → redirect
return Astro.redirect("/progress#achievements")
---
```

### Anti-Patterns to Avoid
- **Don't create separate page routes for sub-views** — hash routing inside parent page keeps ingress safe
- **Don't lazy-load sections with JS** — Astro SSR renders all sections server-side, CSS hides inactive ones
- **Don't build custom Gantt** — date arithmetic, SVG rendering, drag-and-drop snapping are all deceptively complex

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Gantt chart | Custom SVG timeline | Frappe Gantt | Date math, zoom levels, drag snapping, dependency arrows |
| RICE scoring | Custom formula | `domain-strategy/src/rice.ts` | Already exists and tested |
| Sidebar config | New storage system | Extend `sidebar_config` setting | Already stored in settings DB |
| Tab bar | Custom tab component | `UnifiedBar.astro` | Already proven across 9 pages |
| Hash routing | Custom router | `settings-page.ts` pattern | Proven with ingress, PWA, companion |

## Common Pitfalls

### Pitfall 1: Ingress Redirect Loops
**What goes wrong:** Server-side redirects from old routes break inside HA ingress iframe
**Why it happens:** Redirects to bare `/` paths escape the ingress prefix
**How to avoid:** Use Astro's `Astro.redirect()` which respects the ingress middleware rewriting. Test all redirects in Tier 2 devcontainer.
**Warning signs:** 301 redirect loops in browser network tab

### Pitfall 2: Gantt Chart Container Sizing
**What goes wrong:** Frappe Gantt renders with 0 width/height when container is `display: none`
**Why it happens:** SVG calculations need actual DOM dimensions
**How to avoid:** Initialize Gantt only when its section becomes visible (listen for hash change). Use `gantt.refresh()` on section show.
**Warning signs:** Empty Gantt area, console errors about SVG dimensions

### Pitfall 3: Section State Loss on Tab Switch
**What goes wrong:** Kanban lane positions, calendar month, table scroll position lost when switching tabs
**Why it happens:** Hash change hides/shows sections, but doesn't preserve scroll or interactive state
**How to avoid:** Each section controller saves state to a `Map` on hide, restores on show. Settings already does this.
**Warning signs:** Users complaining about "losing their place"

### Pitfall 4: Pinned Sub-Menu Duplication
**What goes wrong:** Pinned "Kanban" in sidebar AND "Kanban" tab in Tasks parent page both visible
**Why it happens:** No coordination between sidebar nav and parent page tabs
**How to avoid:** Parent page tabs always show all sub-views. Sidebar pin is just a shortcut link to `/tasks#kanban`. No duplicate rendering.
**Warning signs:** Same page rendering twice or UX confusion

### Pitfall 5: Routine Template Schedule Drift
**What goes wrong:** Routine instances spawn at wrong times or double-spawn
**Why it happens:** Schedule evaluation doesn't account for timezone, DST, or already-spawned instances
**How to avoid:** Store `last_spawned_at` on template. Spawn logic checks if instance already exists for current period before creating.
**Warning signs:** Duplicate routine tasks, missed days, timezone complaints

## Code Examples

### Frappe Gantt Integration in Astro
```typescript
// lib/controllers/gantt-controller.ts
import Gantt from "frappe-gantt"
import "frappe-gantt/dist/frappe-gantt.css"

export function initGantt(containerId: string, tasks: GanttTask[]) {
  const ganttTasks = tasks.map(t => ({
    id: t.id,
    name: t.title,
    start: t.start_date,
    end: t.due_date || t.start_date,
    progress: t.progress || 0,
    dependencies: t.dependencies || [],
    color: t.priority === "urgent" ? "var(--error)" : undefined,
  }))

  return new Gantt(`#${containerId}`, ganttTasks, {
    view_mode: "Week",
    bar_height: 28,
    padding: 14,
    on_click: (task) => {
      // Open task detail modal
      document.dispatchEvent(new CustomEvent("open-task-detail", { detail: { taskId: task.id } }))
    },
    on_date_change: async (task, start, end) => {
      await fetch(`/api/tasks/${task.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ start_date: start.toISOString(), due_date: end.toISOString() }),
      })
    },
  })
}
```

### Pinnable Sub-Menu Sidebar Extension
```typescript
// In sidebar config, extend existing structure:
interface SidebarConfig {
  order?: string[]
  labels?: Record<string, string>
  customItems?: CustomNavItem[]
  pinnedSubMenus?: Record<string, boolean>  // NEW
  subMenusVisibleInSidebar?: boolean         // NEW (Settings toggle)
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Flat sidebar nav | Parent pages with sub-menu tabs | Phase 15 | 11 items → 6 items + sub-menus |
| Separate gamification page | "Achievements" tab in Progress & Growth | Phase 15 | Consolidated accomplishment domain |
| No default project | "Every Day" auto-created | Phase 15 | Quick capture always has a home |
| No direct goal→task | `goal_id` on tasks table | Phase 15 | Direct and inherited goal linking |

## Open Questions

1. **Gantt data source** — Should Gantt show all tasks with due dates, or only tasks in a selected project?
   - Recommendation: Default to current project/area filter, with "All tasks" toggle
2. **Triage page initial scope** — What specific functionality does Triage provide beyond Eisenhower?
   - Recommendation: Start with a "Review Queue" showing unscored/untriaged tasks for quick scoring
3. **Mobile parent page behavior** — Hash-based tabs on mobile can feel cramped
   - Recommendation: On mobile, sub-menu renders as scrollable pill bar (same as Settings mobile)

## Sources

### Primary (HIGH confidence)
- /frappe/gantt (Context7) — Gantt library API, events, configuration
- /websites/astro_build (Context7) — View transitions, client-side navigation
- Meitheal codebase — Settings `UnifiedBar` pattern, `sidebar_config`, `domain-strategy/rice.ts`

### Secondary (MEDIUM confidence)
- Web search — Frappe Gantt vs alternatives comparison, RICE framework implementation patterns

### Tertiary (LOW confidence)
- None — all findings verified against primary sources

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all libraries verified via Context7 or codebase
- Architecture: HIGH — parent page pattern already proven in 9 codebase pages
- Pitfalls: HIGH — derived from actual codebase patterns and known HA ingress issues

**Research date:** 2026-03-20
**Valid until:** 2026-04-20 (stable libraries, internal architecture)
