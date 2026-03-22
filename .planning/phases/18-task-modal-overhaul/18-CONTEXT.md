# Phase 18: Task Modal Overhaul Context

## Goal
Overhaul the `NewTaskModal` and `TaskDetailModal` across the unified overlay to modernize the UI (glassmorphism, dark mode), expand the available space for complex editing, and integrate Strategic Lenses (Pillars, Principles) natively into the workflow.

## Business Context & Strategic Alignment
The task modal is the core interaction point for the application. The current state is cramped, truncates long titles, uses generic select dropdowns for status, and treats Strategic Lenses as a bolted-on afterthought. To compete with ClickUp while retaining our local-first speed and HA integration, we need a refined, highly functional overlay. 

The 50-persona audit determined that:
1. Fast capture (ADHD-friendly) requires a focused New Task flow.
2. Deep management requires a two-column expanded Edit Task flow.
3. Status swimlanes (pills) reduce cognitive load for stage transitions.
4. Auto-expanding text areas are necessary for titles.

## Phase Boundary
- **In Scope:** `NewTaskModal.astro`, `TaskDetailModal.astro`, `task-modal-controller.ts`, CSS updates for tasks.
- **In Scope:** Replacing `<select>` status with visual swimlane pills.
- **In Scope:** Integrating `StrategicEvaluator` visually into the modal columns.
- **Out of Scope:** Changing the backend SQLite task schema (we are using the existing `pillar_id`, `status` columns).
- **Out of Scope:** Rewriting the timeline or kanban view architectures (only updating the shared modals they use).

## Technical Context
- Modals currently exist in `apps/web/src/components/tasks/`.
- Logic is bundled in `apps/web/src/lib/task-modal-controller.ts`.
- The current implementation truncates titles due to flex/grid constraints in the header.
- The `StrategicEvaluator.astro` component exists but needs to be embedded natively into the edit modal layout rather than just launching a parallel flow.

## Agreed Scope
- **Layout Expansion:** The Edit Modal will utilize a wider max-width (e.g., `max-w-4xl`) with a 2-column layout for desktop.
- **Status Swimlanes:** Four selectable pills for status (Backlog, Todo, In Progress, Done) replacing standard HTML `<select>`.
- **Title Behavior:** The task title will use an expanding `<textarea>` to eliminate truncation.
- **Aesthetic:** Dark mode, glassmorphism (`backdrop-blur`), subtle neon accents, utilizing the established Obsidian Prism equivalent variables in `index.css`.
