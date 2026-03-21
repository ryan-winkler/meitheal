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
| **Achievement** | Gamification milestones — XP totals, streak records, goal completions. Formerly the "Gamification" page. |

## Navigation Structure

| Parent Page | Sub-Views | Route |
|------------|-----------|-------|
| **Tasks** | Kanban, Calendar, Table, Timeline | `/tasks#kanban` |
| **Planning** | Eisenhower, Triage (coming), RICE (coming) | `/planning#eisenhower` |
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

Area (areas table)
 └── Goal (goals table, area_id FK)
      └── Project (projects table, goal_id FK)
           └── Task (tasks table, project_id FK)
                └── Routine Instance (task_kind = 'routine_instance')
```

### Database Columns

- `pillars.id` → Pillar
- `pillar_associations.pillar_id` + `entity_type` + `entity_id` → Pillar ↔ Goal/Routine M2M link
- `areas.id` → Area
- `goals.area_id` → Goal → Area link
- `projects.goal_id` → Project → Goal link
- `projects.is_default` → "Every Day" marker
- `tasks.project_id` → Task → Project link
- `tasks.goal_id` → Optional direct Task → Goal link
- `tasks.routine_template_id` → Task → Routine link
- `tasks.spawned_for_date` → Unique constraint for routine deduplication

## Helper System

Users see inline explainer callouts (`InlineHelper.astro`) on parent pages.
These are dismissible (persisted in `localStorage` key `meitheal-dismissed-helpers`)
and restorable via the <kbd>?</kbd> keyboard shortcut.
