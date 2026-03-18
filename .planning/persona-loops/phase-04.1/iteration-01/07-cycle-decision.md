# Cycle Decision — Phase 04.1 Iteration 01

**Status:** ✅ Proceed to Research + Discuss

## Summary

The 50-persona audit across 5 panels produced:
- **30 accepted** recommendations → 29 executable tasks
- **20 deferred** recommendations → 15 items for future phases
- **6 design constraints** (no-code rules to enforce during execution)

## Key Architecture Decisions (Requiring Approval)

1. **Separate tables** for `areas`, `goals`, `projects` — NOT task_type aliases in the tasks table
2. **`task_kind`** replaces `task_type` — behavioral classification, not hierarchy role
3. **Handoff state machine** — 4-state model (idle → claimed → proposed → accepted/rejected)
4. **Hash-verified proposals** — SHA-256 content hash prevents TOCTOU attacks
5. **Sub-phase split** — 04.1a (Schema), 04.1b (Bot Orchestration), 04.1c (Integration Translation)
6. **Ubiquitous language** — `is_habit` → `is_routine`, enforce via CI linting script

## What's NOT in Scope (Phase 04.1)

- No UI changes (sidebar tree, bot badges, goal progress rings)
- No field-family merge for offline sync (deferred to when core sync is field-aware)
- No HA entity registration (sensors, todo lists per project)
- No MCP tool declarations (depends on stable schema)
- No n8n webhooks (depends on stable event model)

## Open Questions for discuss-phase

1. **Board ↔ Project mapping**: Should each existing board become a project? Or should projects be a new concept alongside boards?
2. **Migration strategy for existing epics/stories**: Convert to goals/projects, or leave as tasks with `task_kind='standard_action'`?
3. **`endeavor_id` column**: The tasks table already has an `endeavor_id TEXT` column (currently unused). Should it map to `project_id`, or be removed?
4. **Agent scratchpad cleanup**: Daily cron or on-release? How does this work in the HA add-on context?

## Next Step

Proceed to `/gsd-research-phase` → `/gsd-discuss-phase` → `/gsd-plan-phase` → `/gsd-execute-phase`.
