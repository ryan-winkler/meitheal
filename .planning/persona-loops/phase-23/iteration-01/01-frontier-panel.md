# Frontier Panel: UI/UX Redesign for New Task Modal

## Context
The goal is to align the `NewTaskModal` with modern productivity standards (e.g. ClickUp), prioritizing brevity, clarity, and specific task kinds (Task, Shopping List, Checklist, Event), while deferring deeper metadata (Pillars, Principles) to the main `TaskDetailModal`.

## 1. Information Architecture
*   **Remove Pillar/Principle Selectors:** Tasks inherit these from broader strategic entities (Projects, Areas). Demanding them at creation adds unnecessary friction.
*   **Introduce Goals:** Users want to immediately link tasks to overarching goals.
*   **Task Kind Selector:** Users need to quickly categorize work. The modal should adapt visually or functionally based on the chosen kind:
    *   *Task (standard_action)*
    *   *Shopping list*
    *   *Checklist*
    *   *Event (calendar)*

## 2. Interaction Design
*   **Auto-open Details on Creation:** For all task kinds (except "quick add" from elsewhere), successfully clicking "Create" on the modal must immediately pop open the `TaskDetailModal` so the user can add "more details" seamlessly.
*   **ClickUp Aesthetic:** The modal should look like a command palette or unified entry point—dark, sleek, and tabbed.

## Recommendations
1. Re-envision the `NewTaskModal` header to include task-kind tabs or a dropdown.
2. Replace Pillar/Principle rows with a single Optional Goal dropdown.
3. Hook the form submission to return the newly created task ID and trigger the opening of the `TaskDetailModal`.
