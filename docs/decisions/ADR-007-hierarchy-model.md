# ADR-007: Hierarchy Model — Area → Goal → Project → Task → Routine

## Status

Accepted

## Date

2026-03-18

## Context

Meitheal originally used an `epic → story → task` hierarchy modeled as a single `task_type` column on the `tasks` table. This conflated two orthogonal concerns:

1. **Hierarchy role** — where a work item sits in a containment tree (epic contains stories, stories contain tasks)
2. **Behavioral classification** — how a work item behaves (is it a shopping list item? a daily routine? a standard action?)

This caused several problems:

- Epics and stories are tasks, but they're also containers — the UI had to special-case them everywhere
- No concept of "why" you're doing work (goals) or "where" it belongs in your life (areas)
- Bot-created tasks had no formal handoff protocol — bots could mutate tasks freely
- The `task_type` column was overloaded: `'task'` meant both "this is a regular task" and "this is at the bottom of the hierarchy"

## Decision

Replace `epic → story → task` with a 3-tiered DDD model:

### Tier 1: Navigation Hierarchy (separate tables)

| Entity  | Table      | Purpose                              | Aggregate Root? |
|---------|------------|--------------------------------------|-----------------|
| Area    | `areas`    | Life domain classification           | No              |
| Goal    | `goals`    | Desired outcome you're pursuing      | Yes             |
| Project | `projects` | Time-bounded container toward a goal | Yes             |

### Tier 2: Atomic Units (tasks table)

| Entity          | `task_kind` value   | Purpose                            |
|-----------------|--------------------|------------------------------------|
| Standard Action | `standard_action`  | Normal task                        |
| Shopping Item   | `shopping_item`    | Item for a shopping list           |
| Checklist       | `checklist`        | Multi-step checklist               |
| Routine Instance| `routine_instance` | Spawned from a routine template    |

### Tier 3: Bot Orchestration (task columns)

| Column           | Purpose                                    |
|------------------|--------------------------------------------|
| `owner`          | `'human'` or `'bot:<agent_name>'`          |
| `lock_holder`    | Bot currently holding the lock             |
| `lock_expires_at`| TTL for auto-release                       |
| `handoff_state`  | State machine: idle→claimed→proposed→done  |
| `proposal_json`  | Structured bot proposal for human review   |
| `proposal_hash`  | SHA-256 for TOCTOU prevention              |
| `agent_scratchpad`| Ephemeral bot notes (never in API responses)|

### Key Design Rules

- **`task_type` stays** for backward compatibility (vikunja-compat layer translates)
- **`task_kind` replaces** `task_type` for all new code — behavioral, not hierarchical
- **Areas/Goals/Projects are NOT tasks** — they have their own tables, not `task_type` values
- **Progressive disclosure** — fresh installs show only tasks/projects, areas/goals are opt-in
- **Bot proposals never trigger notifications** — queued for human review during triage
- **Agent scratchpad excluded from all SELECTs** — sanitized at the repository layer

## Consequences

### Positive

- Clean separation of hierarchy (Area→Goal→Project) from behavior (task_kind)
- Bot interaction is formalized with handoff state machine and SHA-256 verified proposals
- Backward compatible — existing tasks work unchanged, existing API responses preserved
- ADHD-friendly — Today/Upcoming views only show tasks, never goals/projects

### Negative

- 3 new tables increase schema complexity
- Migration path from epic/story to goals/projects requires careful data handling
- `task_type` must coexist with `task_kind` during transition period
- More indexes on the tasks table (now ~25)

### Neutral

- Board concept stays alongside Projects for now (1:1 mapping, gradual convergence)
- Existing offline sync is unaffected (tasks only, no areas/goals/projects in offline store)
