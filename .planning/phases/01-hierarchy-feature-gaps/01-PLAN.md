---
wave: 1
depends_on: []
files_modified:
  - docs/decisions/adr-016-recurrence-vs-habits.md
  - tests/unit/recurrence.spec.ts
autonomous: true
---

# Plan 01: ADR + Recurrence Test Coverage

<goal>
Document the deliberate separation of task recurrence and habit cadence in an ADR, and add comprehensive unit tests for the existing `recurrence.ts` engine covering all frequencies, edge cases, and boundary conditions.
</goal>

<tasks>

## Task 1: Write ADR-016 — Recurrence vs Habits Separation

Create `docs/decisions/adr-016-recurrence-vs-habits.md` documenting:
- **Decision:** Task recurrence (RRULE) and habit cadence stay as separate domain concepts
- **Context:** 50-persona panel (0/50 for convergence), industry precedent (TickTick, Habitica, OmniFocus keep separate; Todoist merges and gets criticized)
- **Rationale:** Different lifecycle patterns (clone-on-completion vs daily-cron), different UX needs (streaks/dopamine vs obligation/relief), different HA entities, different CalDAV requirements
- **Consequences:** Shared scheduling primitives may be extracted later. Habits may optionally support weekday selection using simplified RRULE internally.

## Task 2: Create recurrence.spec.ts

Create `tests/unit/recurrence.spec.ts` testing:

### parseRRule
- Valid DAILY, WEEKLY, MONTHLY, YEARLY rules
- RRULE: prefix handling
- INTERVAL parsing (1, 2, custom)
- BYDAY combinations (MO,WE,FR)
- COUNT and UNTIL constraints
- Invalid/empty input returns null
- Unknown FREQ returns null

### getNextOccurrence
- DAILY: simple +1 day, custom interval
- WEEKLY: next week, BYDAY wrap-around (from Friday → next Monday)
- MONTHLY: standard advance, month-end overflow (Jan 31 → Feb 28)
- YEARLY: standard advance, leap year (Feb 29 → Feb 28)
- COUNT exhaustion returns null
- UNTIL boundary returns null when exceeded

### toRRuleString
- Round-trip: parse → serialize → parse produces same result
- INTERVAL > 1 included, INTERVAL = 1 omitted
- BYDAY serialization

### describeRule
- Human-readable descriptions for each frequency
- Interval variations ("Every day" vs "Every 3 days")
- BYDAY descriptions ("Every Monday, Wednesday, Friday")
- COUNT suffix ("5 times")
- UNTIL suffix

</tasks>

<verification>
- `pnpm --filter @meitheal/tests test tests/unit/recurrence.spec.ts` passes with 100% of test cases green
- `pnpm check` passes (no type errors introduced)
- ADR follows existing format in `docs/decisions/`
</verification>

<must_haves>
- ADR documents the deliberate separation with industry precedent
- Recurrence tests cover all 4 frequencies
- Month-end overflow edge case tested (Jan 31 → Feb 28)
- Leap year edge case tested
- BYDAY wrap-around tested (end of week → next occurrence)
- COUNT exhaustion tested
- UNTIL boundary tested
- Round-trip serialization tested
</must_haves>
