# GSD Plan & Tasks: Phase 23 (New Task Modal Redesign)

## Overview
Based on the Frontier and ADHD panels, the `NewTaskModal.astro` will be completely stripped back and redesigned to match ClickUp's modern standard, focusing on brevity, immediate capture, and visual clarity.

## Tasks

1. **Information Architecture Reset:**
   - Remove the `Pillar` and `Principle` selector dropdowns entirely since they are inherited.
   - Add a simpler `Goal` selector.

2. **Task Kind Implementation:**
   - Introduce a tabbed header or primary selector for `task_kind`:
     - `task` (standard action)
     - `shopping_list` (Shopping list)
     - `checklist` (Checklist)
     - `event` (Event / calendar)
   - Ensure the modal visually updates or highlights the active kind.

3. **Auto-Open Details on Creation:**
   - Modify the form submission logic in `new-task-controller.ts`.
   - On successful `POST`, retrieve the newly created `task.id`.
   - Before closing the modal, trigger `openTaskDetail(task.id)` to immediately pop the ticket on the screen.

4. **Visual Overhaul (ClickUp Alignment):**
   - Apply a more command-palette-like UI.
   - Feature a larger, more prominent title input field.
   - Streamline metadata selectors (assignee, dates) into cleaner UI components.
