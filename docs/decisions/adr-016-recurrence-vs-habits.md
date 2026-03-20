# ADR-016: Recurrence Engine vs Habit Cadence — Deliberate Separation

- **Status**: Accepted
- **Date**: 2026-03-20
- **Context**: Phase 1 discuss — 50-persona panel analysis on whether task recurrence (RRULE) and habit cadence should converge into one engine.

## Decision

Task recurrence and habit cadence remain **separate domain concepts** with distinct data models, lifecycle triggers, and UX patterns.

| Aspect | Task Recurrence | Habit Cadence |
|--------|----------------|---------------|
| **Data model** | `tasks.recurrence_rule` (RRULE TEXT) + `recurrence_anchor` | `task_templates.cadence` ("daily"/"weekly") |
| **Trigger** | Clone-on-completion (`cloneForRecurrence()`) | Daily cron (auto-create from template) |
| **User intent** | Obligation — "Review budget every month" | Identity — "I am someone who exercises daily" |
| **UX feedback** | Next due date badge | Streak counter, check-in card |
| **HA entities** | `calendar.meitheal_tasks` | `sensor.meitheal_streak` |
| **CalDAV sync** | Yes (RFC 5545 RRULE) | No — habits don't belong on shared calendars |
| **Complexity** | Full RRULE: FREQ, INTERVAL, BYDAY, COUNT, UNTIL | Simple picker: daily / weekly |
| **Emotion** | Relief on completion | Dopamine from streak |

## Rationale

### 50-Persona Panel Results (0/50 for convergence)

- **33/50** — keep fully separate
- **8/50** — keep separate with shared scheduling primitive
- **5/50** — shared primitive only (neutral on domain separation)
- **4/50** — neutral (no opinion)
- **0/50** — converge into one engine

### Industry Precedent

| Product | Approach | Outcome |
|---------|----------|---------|
| **TickTick** | Separate habit module | Market-leading habit+task UX |
| **Habitica** | 3 distinct types (Habits/Dailies/Todos) | 5M+ users, strong retention |
| **OmniFocus** | RRULE for tasks, no habits | Power user favorite |
| **Things 3** | Fixed/after-completion, no habits | Beloved UX simplicity |
| **Todoist** | Habits = recurring tasks | Consistently criticized, added Habits extension |

### ADHD/Productivity Panel (unanimous: keep separate)

Habits are ADHD dopamine mechanisms — streak counters and daily check-in cards only work because habits feel fundamentally different from tasks. Merging them kills the motivational distinction.

### DDD Bounded Context Analysis

Task recurrence belongs in `domain-tasks` (aggregate root: `Task`). Habit cadence belongs in the routine/template subdomain (aggregate root: `TaskTemplate`). Cross-aggregate convergence violates DDD principles and creates coupling between independent lifecycle patterns.

## Consequences

### Positive
- Clear domain language: "tasks recur, habits build streaks"
- Independent failure domains (RRULE bug doesn't affect streaks)
- Simpler habit UX (< 3 taps to create)
- Clean HA entity separation for automations

### Negative
- Two code paths for "things that happen repeatedly"
- Date math could be duplicated (mitigated by shared primitive)

### Future Options
- Extract shared scheduling primitives from `recurrence.ts` if habits need weekday selection (Mon/Wed/Fri)
- Habits could internally store a computed RRULE while exposing simplified UX
- Both systems remain independently testable and evolvable

## Related
- `apps/web/src/domains/tasks/recurrence.ts` — RRULE engine
- `apps/web/src/domains/tasks/persistence/template-repository.ts` — habit template persistence
- `.planning/persona-loops/phase-01/iteration-01/01-recurrence-engine-panel.md` — full 50-persona analysis
