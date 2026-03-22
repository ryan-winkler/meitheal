# Phase 18: Task Modal Overhaul - Research Synthesis

## Overview
This synthesis bridges the findings from the 50-Persona Audit (`50-PERSONA-AUDIT.md`) and the technical realities of the codebase (`18-RESEARCH.md`). It establishes the definitive approach for overhauling the New Task and Edit Task modals.

## Key Findings & Synthesis

### 1. Aesthetic Maturation (Glassmorphism & Theme)
- **Desire:** A premium UI feeling similar to ClickUp but faster and aligned correctly with Meitheal's dark mode palette (Neon Nocturne).
- **Reality:** We have base CSS variables in `index.css`. The modals currently use flat `<dialog>` elements with heavy backgrounds.
- **Synthesis:** The new backdrop will use `backdrop-filter: blur(8px) bg-black/50`. The modal container will be `bg-bg-primary/90 border border-border-dim rounded-2xl shadow-xl`. Inputs will lose their heavy borders, relying on subtle backgrounds `bg-bg-secondary` and focus rings `focus:ring-brand-primary` to reduce visual noise.

### 2. Form Functionality (Title & Status)
- **Desire:** Fast capture. Long titles should be fully readable. Status should be 1-click pills instead of a 2-click dropdown.
- **Reality:** We currently use a 1-line `<input>` and a `<select>` bound directly to HTML forms submitted by `task-modal-controller.ts`.
- **Synthesis:** 
  - The title field will become an auto-expanding `<textarea>` (using a known CSS grid string or JS resize hook).
  - The status dropdown will be replaced by a visual `.status-swimlane` component within the form. When a pill is clicked, JS updates a hidden `<input name="status" value="...">` to preserve the existing seamless Astro form `FormData` pipeline.

### 3. Layout Restructuring (Edit Modal)
- **Desire:** Deeper context without losing the "why" (Pillars, Goals). Needs to fit widescreen monitors better.
- **Reality:** `TaskDetailModal.astro` is a single narrow column. Appending Pillar/Strategy there pushes description far down.
- **Synthesis:** The `TaskDetailModal` will expand to a flex-based two-column layout (`md:grid-cols-3` or flex split) restricted by `max-w-4xl` or `5xl`.
  - **Main Area (Left/Top):** The editable title textarea, a richer markdown description, and subtasks.
  - **Sidebar (Right):** "Metadata & Strategy". This dedicated pane hosts the new swimlanes, dates, and natively integrates a condensed `StrategicEvaluator.astro`.

## Technical Path Forward
1. Update CSS variables to support enhanced glassmorphism and the swimlane active states.
2. Rewrite the HTML structure of `NewTaskModal.astro` (keep concentrated) and `TaskDetailModal.astro` (expand to 2 columns).
3. Inject the logic into `task-modal-controller.ts` for pill selection (status sync) and textarea auto-resize.
4. Modularize or cleanly embed `StrategicEvaluator` into the Edit modal sidebar.
