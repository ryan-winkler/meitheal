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
| **Area** | Broad responsibility or body of work such as Home, Work or Class. | ❌ | Name, icon, color and links |
| **Goal** | Desired outcome. A Goal can link directly to an Area, serve as the Goal for one or more Projects, or stand on its own. | Optional | Metric progress (%, count) |
| **Project** | Collection of related tasks. A Project can link directly to an Area and can also link to a Goal. | Optional | Status, description, icon |
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
- `projects.area_id` → Project → explicit Area link
- `projects.goal_id` → Project → Goal link
- `projects.is_default` → "Every Day" marker
- `tasks.project_id` → Task → Project link
- `tasks.goal_id` → Optional direct Task → Goal link
- `tasks.routine_template_id` → Task → Routine link
- `tasks.spawned_for_date` → Unique constraint for routine deduplication

## Goal progress

Goal detail and list responses return progress as a percentage from 0 to 100, calculated from the stored current metric and its positive target. A missing or invalid target reports zero progress. Saving a percentage through `PUT /api/goals/{id}` updates the current metric on the existing target's scale. A goal without a positive target becomes a percentage goal with a target of 100. Fractional percentages are supported; invalid values return 400 and leave the goal unchanged.

## Project custom fields

The Project **Custom Fields** section reports that project-specific field configuration is unavailable. Supported custom field values can still be added when creating a task; this does not create project-level field definitions.

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

## Collapsing the sidebar Areas menu

The Areas heading collapses the whole hierarchy independently of each area's project disclosure. Use Enter or Space on the heading. The choice is remembered in this browser and does not change sidebar visibility, order, saved labels, projects or tasks. **Planning** remains available when the group is closed. Browser storage restrictions do not prevent expanding or collapsing it.

## Edit an Area and view related work

Open the Area options menu in the sidebar and choose **Edit Area**. The Settings section opens inside Meitheal, including when entered from Home Assistant. Change the name, icon or color and choose **Save Changes**. If a save fails, the form keeps the values so you can retry. The **Areas** link returns to Planning. Open an Area card in **Planning → Areas & Projects** to see its overview.

Choose **Edit Project** in the Project’s sidebar menu to open its Settings. From **Planning → Areas & Projects**, each Project link opens its overview. Planning groups Projects by their explicit Area or, if unset, their linked Goal’s Area. Projects without either association appear under **Projects without an Area**. Use **New Project** in an Area group to create a Project there.

Open an Area’s **Goals** tab and select **New Goal** to create a Goal linked to that Area. The list includes its direct Goals and the Goals of its Projects, once each. A Project’s breadcrumb links to its selected Goal. **All Goals** opens the full list in Progress & Growth. API callers can use `GET /api/goals?area_id=…` or `GET /api/goals?project_id=…`. Combined filters match both associations.

Open an Area’s **Routines** tab and choose **New Routine** to open the editor with that Area selected. Saving or cancelling returns to the Area. Work created by the Routine keeps that Area. Progress & Growth also offers **New Routine** and **View Routines**. A Routine with a deleted Area needs a new Area before it can create more work.

Area membership in this hierarchy and sidebar preferences organize work. Use board sharing rules when available to control who can view or change work.

Changing a Routine’s Area affects tasks generated afterward. The existing task for today keeps its Area and remains the one completed by that Routine.

### Personal Pillars

In **Progress → Pillars → New Pillar**, choose **Household** or **Only me** before saving. Household Pillars remain shared as before. Only the active Home Assistant user who created a Personal Pillar can read or edit it and its Principles. The audience is fixed when the Pillar is saved. Personal Pillars are available online through Home Assistant and their Principles stay out of AI handoffs. Whole-database backups include them.
