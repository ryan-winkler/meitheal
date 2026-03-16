# Phase 10: Smart Today — Remaining Gaps Research

**Researched:** 2026-03-16
**Domain:** Habits/Recurrence/Calendar/Context Integration on Today Page
**Confidence:** HIGH

## Summary

8 gaps remain from the 42-gap Smart Today Maturation: G38-G42 (habits integration), G27 (daily migration prompt), G28 (calendar events on Today), G29 (context grouping). All required infrastructure already exists in the codebase — this is integration work, not greenfield.

**Primary recommendation:** Wire existing domain services into `today.astro` (server-side data) and `today-controller.ts` (client-side behavior). No new database schema needed except `source_task_id` backlink column for G40.

## Architecture Patterns (Existing)

### Habits Domain — Two Implementations

There are **two** habit backends. Use the `TemplateRepository` path (production):

| Backend | Location | Status |
|---------|----------|--------|
| `habit-service.ts` | `src/domains/habits/habit-service.ts` | Legacy — standalone `habits` + `habit_completions` tables |
| `TemplateRepository` | `src/domains/tasks/persistence/template-repository.ts` | **Production** — `task_templates` with `is_habit=1`, creates real tasks via `source_template_id` |

**Use:** `TemplateRepository.getHabitsWithStats()` — returns `HabitWithStats[]` with `todayCompleted`, `currentStreak`, `longestStreak`, `todayTaskId`.

**API:** `GET /api/habits` + `POST /api/habits` with actions: `create`, `complete`, `update`, `delete`. Feature-flagged via `isFeatureEnabled("habits")`.

### Recurrence Engine

| File | Key Exports |
|------|-------------|
| `src/domains/tasks/recurrence.ts` | `parseRRule()`, `getNextOccurrence()`, `toRRuleString()`, `describeRule()` |
| `task-repository.ts` L743-806 | `getRecurrenceData()`, `cloneForRecurrence()` |

RRULE supports: DAILY, WEEKLY, MONTHLY, YEARLY with INTERVAL, BYDAY, COUNT, UNTIL.
`cloneForRecurrence()` creates next occurrence with fresh checklists + same metadata.

**Gap:** No `source_task_id` or `previous_occurrence_id` column. Need one for G40 (auto-link). The `source_template_id` column exists for habits → tasks, but recurrence chains (task → task) have no backlink.

### Calendar Events (HA)

| Component | Location |
|-----------|----------|
| HA calendar service | `src/domains/ha/ha-services.ts` — `listCalendarEvents()` |
| HTTP API | `src/pages/api/ha/events.ts` — `GET /api/ha/events?entity_id=&start=&end=` |
| Entity discovery | `getCalendarEntities()` from `src/domains/ha/ha-entities.ts` |

**Pattern:** Client-side fetch to `/api/ha/events` → returns `{ ok, events, supported_features }`. Events have `summary`, `start`, `end`, `description`.

### Context Grouping

**No existing `@home`/`@work` convention** in the codebase. Labels are stored as JSON arrays: `task.labels = '["shopping","urgent"]'`. Context tags would be a UI convention on top of existing label infrastructure — filter by labels matching `@` prefix.

### Today Page Current Structure

**Server-side** (`today.astro` frontmatter): partitions tasks into 5 sections:
1. Carried Forward (overdue)
2. Pinned/MITs (favorited)
3. Due Today
4. Unscheduled (no due date)
5. Suggested (high-priority within 3 days)

**Client-side** (`today-controller.ts`, 1143 lines): 
- `initTodayPage()` orchestrates setup
- Already has: keyboard nav, filters, sort, quick-add, batch, drag, WIP, auto-refresh, evening review, effort indicators

## Implementation Approach Per Gap

### G38: Habits Section on Today
- **Server:** Import `TemplateRepository`, call `getHabitsWithStats()`, check `isFeatureEnabled("habits")`
- **Page:** Add "🔄 Habits" section between Quick Add and Carried Forward
- **Each habit card:** icon + name + streak 🔥 + complete button
- **Client:** `setupHabitsSection()` in controller — handle complete via `POST /api/habits { action: "complete", templateId }`

### G39: Save as Habit
- **Client:** Add "Save as Habit" option in task action menu
- **Flow:** `POST /api/habits { action: "create", name: task.title }` — creates template from task
- **No recurrence needed** — habits are template-based, not RRULE-based

### G40: Auto-link Recurrences
- **Schema:** Add `source_task_id` column to tasks (nullable TEXT)
- **Modify `cloneForRecurrence()`:** Set `source_task_id` to completed task's ID
- **UI:** Show "Previous: MTH-X" link on recurrence tasks via `task_links` or inline

### G41: Recurrence Prompts + Cascade Cancel
Per user specs:
- At end of recurrence (COUNT exhausted or past UNTIL): prompt "Continue recurrence?"
- If any occurrence in chain is cancelled: prompt "Cancel all future occurrences?"
- **Flow:** On task complete → check `recurrence_rule` → if exhausted → show prompt
- **Client:** Modal/banner in today-controller after completion callback

### G42: 2-Month Lookahead + Cleanup
- **Lookahead:** When creating recurrence, generate occurrences for 2 months ahead (not 2 events)
- **Cleanup:** When recurrence cancelled → delete all future pending occurrences with matching `source_task_id` chain or `recurrence_rule`
- **API enhancement:** New endpoint or extend task completion handler

### G27: Daily Migration Prompt
- **Trigger:** Morning load (before noon) + carried forward tasks > 0
- **UI:** Banner: "You have N carried forward tasks. Triage now?"
- **Actions per task:** Keep (no change), Snooze (+1d), Drop (delete)
- **Client:** `setupMigrationPrompt()` in controller

### G28: Calendar Events on Today
- **Server:** Fetch `getCalendarEntities()`, then `listCalendarEvents()` for today
- **Or client-side:** Fetch `/api/ha/events?entity_id=*&start=today&end=today`
- **UI:** Read-only event cards in "📅 Calendar" section between sections
- **Graceful:** If HA not connected, hide section entirely

### G29: Context Grouping (@home, @work)
- **Logic:** Parse labels for `@` prefix → group tasks by context
- **UI:** Collapsible sub-sections within Due Today: "🏠 @home (3)", "💼 @work (2)", "📌 Other (4)"
- **Client:** Filter/group logic in controller, toggle via setting

## Common Pitfalls

1. **Double habits display:** Habit tasks (label: "habit") will appear in Due Today AND Habits section. Need deduplication — filter tasks with `source_template_id` from regular sections
2. **Feature flag:** Habits behind `isFeatureEnabled("habits")` — must check both server and client side
3. **HA connection:** Calendar events require active HA WebSocket. Must fail gracefully with empty section
4. **Recurrence cascades:** Deleting future occurrences needs careful query — scope by `recurrence_rule` value + future `due_date`
5. **2-month lookahead perf:** Generating 60 daily tasks upfront could be expensive. Use lazy generation (create next N on completion) rather than bulk insert

## Sources

### Primary (HIGH confidence)
- `src/domains/tasks/persistence/template-repository.ts` — TemplateRepository and HabitWithStats
- `src/domains/tasks/recurrence.ts` — RecurrenceRule, parseRRule, getNextOccurrence
- `src/domains/tasks/persistence/task-repository.ts` — cloneForRecurrence (L758-806)
- `src/pages/api/habits.ts` — Habits API with feature flag
- `src/pages/api/ha/events.ts` — HA calendar events API
- `src/domains/ha/ha-services.ts` — listCalendarEvents WebSocket bridge
- `src/pages/today.astro` — Current today page structure
- `src/lib/today-controller.ts` — Client-side controller (1143 lines)

---

*Research date: 2026-03-16*
*Valid until: 2026-04-16 (stable domain, internal code)*
