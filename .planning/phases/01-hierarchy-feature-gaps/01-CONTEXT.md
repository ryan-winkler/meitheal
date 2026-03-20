# Phase 1: Hierarchy + Feature Gaps - Context

**Gathered:** 2026-03-20
**Status:** Ready for planning

<domain>
## Phase Boundary

Complete the Epic→Story→Task hierarchy across all views, fill remaining subtask/recurrence/checklist UI gaps, and ensure parent/children relationships ebb and flow together. This phase was marked "Complete" in the original roadmap (2026-03-09) — hierarchy CRUD for Areas, Goals, Projects exists. This discussion revisits **remaining gaps and polish**, not greenfield.

</domain>

<decisions>
## Implementation Decisions

### Recurrence Engine — Keep Separate

**50-persona panel unanimously rejected convergence** (0/50 for merge).

- Task recurrence (RRULE engine in `recurrence.ts`) and habit cadence (`task_templates.cadence`) stay as separate domain concepts
- Both may share a scheduling primitive (date math utilities) but remain distinct aggregate roots
- Habits are identity/streak work (dopamine). Tasks are obligation work (relief). Different UX, different lifecycle, different HA entities.
- Industry precedent: TickTick, Habitica, OmniFocus all keep separate. Todoist merges them and gets criticized.

**Concrete follow-ups:**
1. Write ADR `docs/decisions/adr-recurrence-vs-habits.md` documenting deliberate separation
2. Add `recurrence.spec.ts` edge case coverage (leap years, month-end overflow, DST, BYDAY wrap)
3. Optionally extend habit cadence to support weekday selection (Mon/Wed/Fri) using simplified RRULE internally

### Claude's Discretion

- Hierarchy navigation, subtask UX, and AI surface areas were offered for discussion but user deferred — Claude has flexibility to make standard implementation choices for these areas during planning
- Subtask nesting depth, breadcrumb display, and AI auto-organization can follow established patterns (TickTick/Things 3 style for subtasks, standard tree navigation for hierarchy)

</decisions>

<specifics>
## Specific Ideas

- Habits should feel like a "wellness dashboard" not a "filtered task list"
- Streak counters and daily check-in cards are ADHD dopamine mechanisms — don't dilute them
- Habit creation should be < 3 taps. Task recurrence can be complex.
- CalDAV sync uses RRULE for tasks. Habits don't belong in CalDAV pipeline.
- HA entities stay split: `sensor.meitheal_streak` (habits) vs `calendar.meitheal_tasks` (recurrence)

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope.

</deferred>

---

*Phase: 01-hierarchy-feature-gaps*
*Context gathered: 2026-03-20*
