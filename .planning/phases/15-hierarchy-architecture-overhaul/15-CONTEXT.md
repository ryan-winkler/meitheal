# Phase 15: Hierarchy Architecture Overhaul - Context

**Gathered:** 2026-03-20
**Status:** Ready for planning

<domain>
## Phase Boundary

This phase resolves the duplicative Area/Project sidebar navigation, unifies accomplishment-related features under one parent page, introduces calendar events as a task kind, adds direct goal→task linking, creates a default "Every Day" project, and builds the routine template system with streak tracking. It also fixes the API 400 empty-update bug and establishes the ubiquitous language glossary.

This phase does NOT introduce new HA integrations, offline/PWA changes, or bot orchestration updates.

</domain>

<decisions>
## Implementation Decisions

### Hierarchy Unification
- Merge PROJECTS tree and AREA dropdown into single "AREAS" sidebar section
- Areas are the top-level, enriched with descriptions, labels, and links
- Projects nest under their Area in the sidebar tree
- Goals are associated with Areas/Projects but managed from the Progress page, not the sidebar tree

### Default Project
- Name: **"Every Day"** (user-locked)
- Auto-created on first startup, undeletable
- Primary capture target for quick tasks without a project context
- Shows in sidebar tree under a special "ungrouped" position (not under any Area)

### Calendar Events
- Add `calendar_event` to `TaskKind` union
- Calendar events are tasks with additional properties (start/end time, location, all-day)
- Existing synced tasks should be backfilled to `calendar_event` kind
- No siloed bodies of work — everything is relational

### Goals ↔ Tasks
- Tasks get a direct `goal_id` foreign key
- Tasks can either have a direct `goal_id` or inherit from parent Project's goal
- Goal badge displayed on tasks in all views

### Routines & Habits
- "Routine" is the canonical domain term per ADR-007
- "Habit" may appear in UI copy but not in code
- Build routine_template entity with full CRUD
- Routine templates spawn `routine_instance` tasks on schedule
- Include streak tracking, freeze days
- Recurring tasks that are NOT routines should appear on the Routines page with "Convert to Routine" affordance
- **Full build P0-P6, no deferrals** (user-locked)

### Accomplishment Parent Page
- Goals, Routines/Habits, and Achievements (née Gamification) consolidated under one parent page
- Sub-menu tab bar (same pattern as Calendar's Month Grid | Agenda | Flow)
- Hash-based routing: `#routines`, `#goals`, `#achievements`
- Gamification renamed to "Achievements"
- Old routes (`/gamification`, `/habits`, `/goals`) redirect to parent page sub-sections

### Helper/Explainer System
- Three-tier system: inline callout (first encounter), tooltip (subsequent), `?` key panel (recall)
- Helpers dismissable with "Got it" button
- Dismissed state persisted in localStorage
- `?` key opens Tips panel with all concepts + re-show toggles
- Must respect `prefers-reduced-motion`

### API Fix
- Empty update body to `/api/tasks/[id]` returns 200 with unchanged entity (tolerant reader)
- Client-side validation prevents empty PUTs

### Claude's Discretion
- Parent page name (recommendation: "Progress & Growth" — user asked for IA analysis first)
- Exact sub-menu tab labels within the parent page
- Helper text content and which concepts get helpers
- Routine template UI design (form layout, schedule picker)
- "Every Day" project icon and visual treatment
- Whether routine streaks show in sidebar or only on Progress page

</decisions>

<specifics>
## Specific Ideas

- User screenshot shows sidebar PROJECTS tree with "Default" project and an "AREA" section with dropdown + "New Area" button directly below — this is the exact duplication to resolve
- User wants each page's sidebar item to move DOWN into the sub-menu bar on the parent page (see screenshot annotation)
- Gamification already has streak badges, XP, levels — these become "Achievements"
- Habits page already has routine template CRUD in progress — integrate, don't rebuild
- The sidebar is configurable (order, visibility, custom items) via settings — preserve this

</specifics>

<deferred>
## Deferred Ideas

- HA entity registration for routine streaks (belongs in Phase 05.4)
- Offline routine template sync (belongs in Phase 05.3)
- Bot-spawned routine instances (belongs in Phase 05.2)
- n8n webhook for routine completion events (belongs in Phase 05.6)

</deferred>

---

*Phase: 15-hierarchy-architecture-overhaul*
*Context gathered: 2026-03-20*
