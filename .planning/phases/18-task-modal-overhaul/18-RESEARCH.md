# Research: Task Modal Overhaul

**Phase:** 18
**Date:** 2026-03-22

## Component Analysis

### `NewTaskModal.astro`
- Current state: Single column, basic inputs, native `<select>` for status, truncated title.
- Structural Need: Requires expansion to a more breathable layout. Instead of native select, it needs a custom UI for status selection. The title needs to be a `<textarea>` that auto-expands.

### `TaskDetailModal.astro`
- Current state: Fixed `max-w-xl`, stacking all fields vertically.
- Structural Need: Must be converted to CSS Grid (`grid-template-columns` or Tailwind `md:grid-cols-12`) to support the 2-column layout (e.g., 8 col left for content, 4 col right for metadata). 
- Right Column contents needed: Status, Priority, Dates, Pillar/Goal context.

### `task-modal-controller.ts`
- Current state: Handles basic open/close and form submissions.
- Behavioral Need: Must be updated to handle the auto-expanding textarea logic (`input` event listener adjusting `style.height`). Must handle the new custom status dropdown/pills, syncing visually selected state to a hidden `<input name="status">` for seamless form submission without rewriting the API layer.

### `StrategicEvaluator.astro`
- Current state: A standalone component or part of the detail view.
- Integration Need: Needs to be securely embedded in the `TaskDetailModal.astro` right column, potentially lazy-loaded or conditionally expanded to keep initial modal render times sub-50ms. Must adhere to `domain-strategy` validation rules.

## Theming & CSS
- Need to leverage Meitheal's existing design tokens in `index.css` for glassmorphism (`backdrop-blur-md`, subtle borders, dark transparent backgrounds).

## Constraints
- **Performance:** Avoid heavy JS layout thrashing. CSS Grid is preferred.
- **Accessibility:** Custom dropdowns must remain keyboard navigable.
- **Ingress Safety:** Client-side fetches must retain ingress paths if any new API calls are introduced (though standard form submission avoids this).
