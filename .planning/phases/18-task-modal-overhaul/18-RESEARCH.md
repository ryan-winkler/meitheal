# Phase 18: Task Modal Overhaul - Research & Implementation Details

## Existing Architecture Analysis

### 1. `NewTaskModal.astro`
- **Location:** `apps/web/src/components/tasks/NewTaskModal.astro`
- **Current State:** A relatively standard `<dialog>` based modal with basic form inputs.
- **Deficiencies:** Uses native `<select>` dropdowns for Status/Priority. Doesn't have an expanding title textarea (truncates visually). Lacks native strategic integration.
- **Classes/Styling:** Currently uses basic `bg-bg-card` and standard borders. Needs an upgrade to the glassmorphism aesthetic (`backdrop-blur` and deeper neon accents).

### 2. `TaskDetailModal.astro`
- **Location:** `apps/web/src/components/tasks/TaskDetailModal.astro`
- **Current State:** The edit modal. Currently constrained in width. Similar layout approach as New Task but with more fields.
- **Deficiencies:** Very dense single column. Status drop-down is clumsy for fast flow. Strategic elements are hidden. Markdown description editing is basic.
- **Classes/Styling:** Needs structural overhaul to become a `max-w-4xl` or `max-w-5xl` 2-column layout (content vs metadata).

### 3. `task-modal-controller.ts`
- **Location:** `apps/web/src/lib/task-modal-controller.ts`
- **Current State:** A massive ~1500 line controller managing DOM events for both modals. Handles form submissions, subtasks, recurrence, and lane selection.
- **Changes Needed:** 
  - Add logic to intercept "status swimlane pill" clicks and secretly update a hidden form input (so Astro form submission still works without rewriting the whole pipeline to fetch).
  - Add auto-resize logic for the new `<textarea>` title spanning.
  - Integrate logic for selecting Pillars/Principles from the new embedded Strategic section.

### 4. `StrategicEvaluator.astro`
- **Location:** `apps/web/src/components/tasks/StrategicEvaluator.astro`
- **Current State:** Analyzes tasks against pillars. 
- **Changes Needed:** Needs to be modularized or embedded directly into the right-hand column of `TaskDetailModal.astro` so users can link Pillars/Principles instantly while editing the task.

## New UI Requirements

1. **Title Auto-Expansion:**
   - Swap `<input type="text" name="title">` for `<textarea name="title" rows="1" onInput="this.parentNode.dataset.replicatedValue = this.value">`. Use CSS grid tricks or JS to auto-expand height as the user types so long titles are fully visible.
   
2. **Status Swimlanes:**
   - Swap `<select name="status">` for a visual pill group.
   - Values exist: `backlog`, `todo`, `in_progress`, `done`.
   - Visually: A flex row of 4 styled buttons. Clicking one makes it active (solid color) and updates a `<input type="hidden" name="status" value="...">`.

3. **Two-Column Edit Layout:**
   - Left column (flex-grow, ~60-70% width): Title, Description (textarea), Subtasks/Checklists.
   - Right column (fixed width, ~30-40% width, distinct background `bg-bg-darker` or frosted): Status Swimlane, Due Date Calendar, Assigned Pillar, Priority, Metadata, Strategic Lens score.

4. **Glassmorphism Aesthetic:**
   - The outer `<dialog>` should have `backdrop-filter: blur(12px)`.
   - The shell should use `bg-bg-primary/80` or `bg-surface/80` to let underlying page content bleed through softly.
   - Form fields should be frameless or have very subtle borders (15% opacity), relying on subtle hover states and focus rings (`focus:ring-brand-primary/50`).

## Risks & Constraints
- **HA Ingress Context:** We must make sure that fetching Pillars or updating tasks relies on relative `/api/...` calls safely behind the ingress wrapper. No absolute pathings.
- **Controller Size:** `task-modal-controller.ts` is already huge. Adding auto-resize and pill logic makes it larger. We should write exact, clean event delegation.
- **Astro Components:** We rely on SSR. The modal content is pre-rendered. We must ensure the new swimlane pills and textareas serialize their state properly upon opening an existing task.
