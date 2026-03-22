# GSD Plan & Tasks - Phase 22 Iteration 01

## Synthesized Tasks

1. **Title Auto-Expansion Fix (P1/A2)**
   - Modify the Title `<textarea>` in `TaskDetailModal.astro` (and `NewTaskModal.astro` if applicable) to properly auto-expand. Often, this requires a simple JS listener attaching to `input` that resets `height` to `auto` then calculates `scrollHeight`. Also, ensure `text-ellipsis`/truncation CSS isn't forcing it flat.
2. **ClickUp Information Architecture (IA) Alignment (P2/A1)**
   - Restructure `TaskDetailModal.astro` layout:
     - Top: Breadcrumbs (Project/Pillar) & ID
     - Next: Title Textarea + "Ask Brain" quick action button
     - Next: A comprehensive Property Grid comprising: Status, Assignees, Dates, Priority, Time Tracked, Tags/Labels, Pillar, Principle, Project.
     - Next: Description section.
     - Next: Custom Fields, Checklists, Subtasks.
     - Move the `StrategicEvaluator` inline to an appropriate spot (perhaps bottom of Properties or alongside Subtasks).
     - Keep the UI single-column focused for the main meat, or cleanly utilize the wide modal, removing the explicit left/right column split which was confusing UX.
3. **Related Links Overflow Fix (P3/A4)**
   - Locate the 'Related Links' component (likely `TaskDetailModal.astro` or injected dynamically). Verify the parent container's `overflow` properly allows absolutely positioned dropdowns. Fix clipping by removing `overflow-hidden` or adjusting `z-index`. 

## Output Execution
We will start with the complete restructuring of `TaskDetailModal.astro`.
