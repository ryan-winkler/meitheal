---
type: "Reference"
title: "Hierarchy Glossary — Meitheal Ubiquitous Language"
description: "Understand Boards, Areas, Projects and the optional planning features."
---

# Hierarchy Glossary — Meitheal Ubiquitous Language

Open a Board, choose a Area, then open a Project for its related tasks. Tasks can also stay directly in a Area or Unfiled on their Board. Goals, Routines, Pillars and Principles provide additional planning relationships.

## Organization and planning terms

| Term | Definition | Has Deadline? | Tracking |
|------|-----------|:------------:|----------|
| **Board** | A workspace with its own workflow. Named Boards have explicit members and permissions. Household contains the existing shared work. | ❌ | Members, columns and tasks |
| **Area** | An ongoing responsibility within a Board, such as Kitchen or Operations. Areas can contain tasks, Projects, Goals and Routines. | ❌ | Name, icon, color and related work |
| **Pillar** | Identity-based motivational anchor — the WHY behind everything. Permanent, never completed. "I am someone who..." | ❌ | Linked Goals, Routines (counts only — no failure states) |
| **Goal** | Desired outcome. A Goal can link directly to a Area, serve as the Goal for one or more Projects, or stand on its own. | Optional | Metric progress (%, count) |
| **Project** | Related tasks within a Board, optionally organized in a Area and linked to a Goal. | Optional | Status, description, icon |
| **Task** | A piece of work on a Board. It can belong to a Area or Project or remain Unfiled. | Optional | Priority, RICE, status, labels |
| **Home Assistant Area** | An optional task field for a physical location from Home Assistant’s registry. Administrators choose who can use it. | ❌ | Physical location |

Personal labels in **Settings → Navigation & Shortcuts → Labels** change display terms for the verified Home Assistant account and language. Search recognizes canonical and personal names. Routes, record IDs and individual record names retain their identities.

Named Board grants govern access to the Board’s work. Administrators choose module availability in **Settings → Tasks & Boards → Organization features**. Those audiences apply to organizing features such as Areas and Projects. See [Named Boards](named-boards.md) for the current permission and organization journeys.

## System Entities

| Term | Definition |
|------|-----------|
| **Every Day** | The protected legacy default Project for Household tasks. |
| **Routine** | A template for repeated work. Household Routines use the existing task-generation flow. A named Board check-in creates one completed occurrence per UTC day or week. The older Household library also uses the label Habit. |
| **Routine Instance** | A Task created by a Routine template for a specific period. Carries `task_kind = 'routine_instance'` and `source_template_id`. Named Board occurrences retain their Area and optional Project and keep their original date. |
| **Principle** | A behavioral boundary within a Pillar. "No screens after 9 PM." Can be marked Non-Negotiable for AI enforcement. |
| **Non-Negotiable** | A Principle with `isNonNegotiable = true`. Injected into LLM system prompts via `fetchPillarContext()`. Capped at 15 in prompts. |
| **Manifesto** | A Pillar's WHY statement using identity framing: "I am someone who builds lasting health." Displayed as the hero element on PillarCard. |
| **Weight** | A Pillar's relative importance (1-10). Used for algorithmic priority boosting in the strategic evaluator. |
| **Achievement** | Gamification milestones — XP totals, streak records, goal completions. Formerly the "Gamification" page. |

## Navigation Structure

| Parent Page | Sub-Views | Route |
|------------|-----------|-------|
| **Boards** | Household and accessible named Boards, then Areas and Projects | `/boards` |
| **Tasks** | Kanban, Calendar, Table, Timeline | `/tasks?view=kanban` |
| **Planning** | Boards, Eisenhower, Triage, RICE | `/planning#eisenhower` |
| **Progress & Growth** | Pillars, Routines, Goals, Achievements | `/progress#pillars` |

Existing `/areas/{id}` and `/projects/{id}` bookmarks open the matching Household Board context. Supported section fragments, including settings, are preserved. When Planning is available, `/planning#spaces` opens its Boards section. Choose **Manage Boards** to open the full directory at `/boards`.

## Deprecated Terms

| Old Term | New Term | ADR Reference |
|----------|----------|---------------|
| Area as an organizing responsibility | Area | Existing `area` storage and API names are retained |
| Habit | Routine | ADR-007 |
| Gamification | Achievements | Phase 15 |
| Standalone pages (e.g. `/kanban`) | Sub-views under parent pages | Phase 15 |

## Organization in storage

`task_boards` stores Boards. Named tasks use `tasks.task_board_id`, and named planning records use `owner_board_id`. `board_task_planning` stores a named ticket’s Area and Project placement. `home_assistant_task_areas` stores the separate physical location.

The Household storage relationships below retain the earlier Area field names. A Project can link directly to its Area, so a Goal is optional.

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
- `areas.id` → Area (legacy Area identifier)
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

For a Household task, open the task and choose its **Project** in the details panel. Choose **No project** to clear the assignment. The task keeps its existing Area, status and ticket key. If the destination was deleted, reopen the task to refresh the Project list and choose another destination. For a named Board ticket, use **File task** within its Board to select a Area or Project.

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

The Household Areas heading collapses its tree independently of each Area’s Project disclosure. Use Enter or Space on the heading. The choice is remembered in this browser and preserves the saved sidebar configuration. Named Board disclosures open their own Areas. Browser storage restrictions do not prevent expanding or collapsing the tree.

## Edit a Area and view related work

Open **Boards → Household → Areas** or a named Board’s **Areas**. Open a Area and its settings to change the name, icon or color. If a save fails, the form keeps the values so you can retry. Older **Edit Area** links open the matching Household Area settings inside Home Assistant ingress.

Open a Project from its Area to see its tasks. **Project settings** opens its edit controls. Use **New Project** in a Area to create related work there. A named Board also keeps unfiled Projects reachable from its Areas view.

Open a Household Area’s **Goals** tab and select **New Goal** to create a Goal linked to that Area. The list includes its direct Goals and the Goals of its Projects, once each. A Project’s breadcrumb links to its selected Goal. **All Goals** opens the full list in Progress & Growth. API callers can use `GET /api/goals?area_id=…` or `GET /api/goals?project_id=…`. Combined filters match both associations.

Open a Household Area’s **Routines** tab and choose **New Routine** to open the editor with that Area selected. Saving or cancelling returns to the Area. Work created by the Routine keeps that Area. Progress & Growth also offers **New Routine** and **View Routines**. A Routine with a deleted Area needs a valid Area before it can create more work.

For a named Board, create a Routine under its Area or within Project settings. Project-bound occurrences keep both placements. Closing or removing the Project prevents new occurrences. Existing completed occurrences retain their identity on a permitted retry. See the [Routine library guide](habits-shell-guide.md#check-in-on-a-named-board-routine).

Changing a Household Routine’s Area affects tasks generated afterward. The existing task for today keeps its Area and remains the one completed by that Routine.

### Personal Pillars

In **Progress → Pillars → New Pillar**, choose **Household** or **Only me** before saving. Household Pillars remain shared as before. Only the active Home Assistant user who created a Personal Pillar can read or edit it and its Principles. The audience is fixed when the Pillar is saved. Personal Pillars are available online through Home Assistant. If the browser goes offline or changes accounts, Progress hides the previous view. Reconnect and refresh Progress to return. Personal Principles stay out of AI handoffs. Whole-database backups include them.

Open **Progress** from the main navigation to reach Personal Pillars. Opening Progress from a Board, Area or Project shows Pillars for that workspace.


## Task Hierarchy, Child Items, and Checklist Steps

Within a Board, Meitheal organizes work on a single `tasks` model using `task_type` (`epic`, `story`, `task`) and optional same-Board acyclic `parent_id` links (`MAX_TASK_HIERARCHY_DEPTH = 4` in `packages/domain-tasks/src/domain-model.ts`):

- **Parent / Child Rules (`ALLOWED_CHILD_TYPES`)**:
  - **Epic** can contain **Epic**, **Story**, or **Task** child items.
  - **Story** can contain **Task** child items.
  - **Task** can contain nested **Task** child items.
  - Standalone tasks with no Area, Project, or Parent remain valid across all Board and Personal workspaces.
- **Child Items vs. Checklist Steps vs. Markdown Task Lists**:
  - **Child Items** (`parent_id`) are tracked work items on the Board with their own ticket keys, status lanes, assignees, and due dates. Selecting **Full form…** from **Child Items** opens `NewTaskModal` with the parent prelinked while preserving any unsaved draft on the parent (`task-editor-draft-stack.ts`).
  - **Checklist Steps** (`tasks.checklists`) are lightweight steps stored inside one task and never double-counted as child tickets. Use **Convert to child task** on a checklist item to promote an individual step into its own tracked work item.
  - **Markdown `- [ ]` lists** inside descriptions remain plain formatted text unless explicitly added as structured Checklist Steps.
- **Promoted vs. Pins**:
  - **Promoted** (`is_promoted`) is the shared Board prominence flag that pins a card near the top of its Kanban lane and highlights it in Today/Dashboard.
  - **Pins** (`task_pins`) remain strictly private bookmarks per user. Legacy `is_favorite` is retired into `archived_task_favorites` (`0018_task_experience.mjs`).
