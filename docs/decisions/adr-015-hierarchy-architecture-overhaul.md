# ADR-015: Hierarchy Architecture Overhaul — Parent Pages, Helpers, Breadcrumbs

## Status

Accepted

## Date

2026-03-20

## Context

Phase 15 restructured Meitheal's navigation from flat standalone pages (Kanban, Calendar, Table, Timeline, Eisenhower, Habits, Goals, Gamification) into a hierarchy-aware parent page model. The previous architecture suffered from:

1. **Information fragmentation** — 8+ standalone pages with no contextual awareness of how they relate
2. **No hierarchy navigation** — users couldn't see where tasks sit in the Area → Goal → Project → Task chain
3. **No onboarding** — new users had no inline guidance explaining what each view does or when to use it
4. **Duplicative navigation** — Areas and Projects were confusingly similar in the sidebar
5. **Cognitive overload** — ADHD users reported decision paralysis when choosing between many sidebar items

## Decision

### 1. Parent Page Model

Consolidate standalone pages into three parent hubs, each using `ParentPageShell` for hash-based sub-section routing:

| Parent Page | Route | Sub-Views |
|-------------|-------|-----------|
| Tasks | `/tasks` | `#kanban`, `#calendar`, `#table`, `#timeline` |
| Planning | `/planning` | `#eisenhower`, `#triage` (coming), `#rice` (coming) |
| Progress & Growth | `/progress` | `#routines`, `#goals`, `#achievements` |

Legacy routes (`/kanban`, `/calendar`, `/eisenhower`, etc.) remain functional via Astro redirect pages.

### 2. Live Data Dashboards

Each parent page section shows:
- **Stat cards** — real-time counts from live database queries
- **Section description** — explains the purpose and workflow
- **Deep link** — "Open Full View →" to the legacy page

### 3. InlineHelper System

A collapsible, dismissible inline help component (`InlineHelper.astro`) powered by `helper-system.ts`:

- **Dismissal** persists in `localStorage` (`meitheal-dismissed-helpers`)
- **Collapse** reduces visual noise without permanent dismissal
- **`?` keyboard shortcut** restores all dismissed helpers with a flash notification
- **Three variants**: info (blue), tip (green), important (amber)
- **Self-initializing** — component includes its own `<script>` tag

### 4. HierarchyBreadcrumb

A compact `Area → Goal → Project` trail component showing a task's position in the hierarchy. Supports a compact mode for inline use in task list items.

### 5. Sidebar Consolidation

The sidebar was restructured to show parent pages as top-level items with sub-views accessible via the parent page's tab bar (UnifiedBar). Legacy standalone items were moved under their respective parent pages.

### 6. Today Page Integration

The `/today` Flow section was updated to link to parent page routes (`/tasks#calendar`, `/planning#eisenhower`, `/progress#routines`) instead of standalone pages, ensuring navigational consistency.

## Consequences

### Positive

- Reduced sidebar clutter from 10+ items to 5 (Dashboard, Today, Upcoming, Tasks, Progress, Planning)
- InlineHelper provides progressive disclosure — new users get guidance, experienced users dismiss
- `?` shortcut provides safety net for accidentally dismissed helpers
- Live stat cards give users immediate overview without entering each view
- Hash-based routing keeps parent pages ingress-safe (no server-side redirects)
- i18n keys added for all new hierarchy terms in both English and Irish

### Negative

- Parent page sections currently show summary data + deep links rather than embedding full functionality
- Helper system adds ~2KB of client-side JS for localStorage management
- Legacy redirect routes add ~8 small Astro files to the project

### Neutral

- Legacy pages continue to function — no breaking changes
- The `task_type` → `task_kind` migration (from ADR-007) is orthogonal to this architectural change
- KCS glossary (`docs/kcs/hierarchy-glossary.md`) serves as single source of truth for ubiquitous language

## Related ADRs

- [ADR-007: Hierarchy Model](./ADR-007-hierarchy-model.md) — defines the Area → Goal → Project → Task data model
- [ADR-014: Eisenhower Schema Columns](./adr-014-eisenhower-schema-columns.md) — Eisenhower quadrant data
