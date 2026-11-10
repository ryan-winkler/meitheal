---
type: "Reference"
title: "Hierarchy Glossary — Meitheal Ubiquitous Language"
description: "Find definitions for areas, goals, projects, and other planning terms."
---

# Hierarchy Glossary — Meitheal Ubiquitous Language

> **Phase 15** established the four-level hierarchy model. **Phase 17** added
> Pillars as identity-based motivational anchors. This glossary defines each
> term as it's used in code, UI, and documentation.

## Core Hierarchy (top → bottom)

| Term | Definition | Has Deadline? | Tracking |
|------|-----------|:------------:|----------|
| **Pillar** | Identity-based motivational anchor — the WHY behind everything. Permanent, never completed. "I am someone who..." | ❌ | Linked Goals, Routines (counts only — no failure states) |
| **Area** | Broad life/work category (e.g. Home, Work, Health). Permanent, never completed. | ❌ | Labels, descriptions, links |
| **Goal** | Long-term directional target inside an Area. No end date — it's aspirational. | ❌ | Metric progress (%, count) |
| **Project** | Time-bounded collection of related tasks, linked to a Goal. | Optional | Status, description, icon |
| **Task** | Atomic unit of work. Can belong to a Project (or "Every Day" by default). | Optional | Priority, RICE, status, labels |

## System Entities

| Term | Definition |
|------|-----------|
| **Every Day** | The default Project that catches tasks without an explicit Project assignment. Cannot be renamed or deleted. |
| **Routine** | A recurring template that auto-creates daily/weekly Tasks. Tracks streaks and contributes to gamification XP. Formerly called "Habit" (deprecated term). |
| **Routine Instance** | A Task created by a Routine template for a specific date. Carries `task_kind = 'routine_instance'` and `source_template_id`. |
| **Principle** | A behavioral boundary within a Pillar. "No screens after 9 PM." Can be marked Non-Negotiable for AI enforcement. |
| **Non-Negotiable** | A Principle with `isNonNegotiable = true`. Injected into LLM system prompts via `fetchPillarContext()`. Capped at 15 in prompts. |
| **Manifesto** | A Pillar's WHY statement using identity framing: "I am someone who builds lasting health." Displayed as the hero element on PillarCard. |
| **Weight** | A Pillar's relative importance (1-10). Used for algorithmic priority boosting in the strategic evaluator. |
| **Achievement** | Gamification milestones — XP totals, streak records, goal completions. Formerly the "Gamification" page. |

## Navigation Structure

| Parent Page | Sub-Views | Route |
|------------|-----------|-------|
| **Tasks** | Kanban, Calendar, Table, Timeline | `/tasks#kanban` |
| **Planning** | Spaces, Eisenhower, Triage, RICE | `/planning#eisenhower` |
| **Progress & Growth** | Routines, Goals, Achievements | `/progress#routines` |

## Deprecated Terms

| Old Term | New Term | ADR Reference |
|----------|----------|---------------|
| Habit | Routine | ADR-007 |
| Gamification | Achievements | Phase 15 |
| Standalone pages (e.g. `/kanban`) | Sub-views under parent pages | Phase 15 |

## Hierarchy in Code

```
Pillar (pillars table) ←—M2M—→ Goal, Routine (pillar_associations)
  └── Principle (principles table, pillar_id FK)

Pillar ←—direct FK—→ Goal (goals.pillar_id), Task (tasks.pillar_id), Routine (task_templates.pillar_id)

Area (areas table)
 └── Goal (goals table, area_id FK, pillar_id FK)
      └── Project (projects table, goal_id FK)
           └── Task (tasks table, project_id link, pillar_id FK — inherits from Goal if not set)
                └── Routine Instance (task_kind = 'routine_instance')
```

### Database Columns

- `pillars.id` → Pillar
- `pillars.manifesto` → WHY statement (identity framing)
- `pillars.weight` → Relative importance (1-10) for priority boosting
- `principles.pillar_id` → Principle → Pillar link
- `principles.is_non_negotiable` → AI-enforced behavioral boundary
- `pillar_associations.pillar_id` + `entity_type` + `entity_id` → Pillar ↔ Goal/Routine M2M link
- `goals.pillar_id` → Direct Goal → Pillar FK (primary association)
- `tasks.pillar_id` → Direct Task → Pillar FK (or inherited from Goal)
- `task_templates.pillar_id` → Direct Routine → Pillar FK
- `areas.id` → Area
- `goals.area_id` → Goal → Area link
- `projects.goal_id` → Project → Goal link
- `projects.is_default` → "Every Day" marker
- `tasks.project_id` → Task → Project link
- `tasks.goal_id` → Optional direct Task → Goal link
- `tasks.routine_template_id` → Task → Routine link
- `tasks.spawned_for_date` → Unique constraint for routine deduplication

## Goal progress

Goal detail and list responses return progress as a percentage from 0 to 100, calculated from the stored current metric and its positive target. A missing or invalid target reports zero progress. Saving a percentage through `PUT /api/goals/{id}` updates the current metric on the existing target's scale. A goal without a positive target becomes a percentage goal with a target of 100. Fractional percentages are supported; invalid values return 400 and leave the goal unchanged.

## Move a task to another project

Open the task, then choose its **Project** in the details panel. Choose **No project** to clear the assignment. The task keeps its existing area, status and ticket key. If the destination was deleted, reopen the task to refresh the project list and choose another destination.

Integrations can use `PUT /api/tasks/{id}` or `PATCH /api/tasks/{id}` with `project_id` set to a project ID or `null`. Deleting a project clears its tasks’ project assignment and preserves the tasks.

## Principle ownership

A Principle update or removal through `/api/pillars/{id}/principles` applies within the selected Pillar. A request for a Principle from another Pillar returns `404` and leaves it unchanged.

## Helper System

Users see inline explainer callouts (`InlineHelper.astro`) on parent pages.
These are dismissible (persisted in `localStorage` key `meitheal-dismissed-helpers`)
and restorable via the <kbd>?</kbd> keyboard shortcut.

## Edit a Pillar or save a Principle

Open **Progress & Growth → Pillars**. Choose **Edit** on the card or in Details to change the Pillar's identity and weight. **Add principle** opens a form for a boundary. Select **Non-Negotiable** when it should guide supported automation prompts. **Save principle** updates the detail list and card count after the App confirms the write. If saving fails, the form keeps the statement and checkbox for retry.
