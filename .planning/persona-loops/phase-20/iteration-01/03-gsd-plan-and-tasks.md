# GSD Plan & Tasks - Phase 20 Iteration 01

## Synthesized Tasks

1. **Strategic Evaluator Overflow Protection (P1 - Platform Architect)**
   - Add bounds checking or `max-h` and `overflow-y-auto` to the Strategic Evaluator inline panel so it never overflows the screen bottom.
2. **Dynamic Principle Loading State (P2 - Reliability Engineer)**
   - Display a brief spinner or "Loading..." text in the Principle dropdown while the `/api/pillars/{id}/principles` request is in flight.
3. **Glassmorphism Fallbacks (P3 - Security Engineer)**
   - Ensure a solid background color (e.g. `bg-bg-primary`) is present so that if `backdrop-blur` fails, the modal remains perfectly readable.
4. **Mobile Touch Targets (P4 - Product Architect)**
   - Ensure all `<select>`, `<button>`, and `<input>` elements in the modals have a minimum height of `44px` (or `py-2.5`).
5. **Auto-focus Title Capture (A1 - Workflow Coach)**
   - Connect `.focus()` to the `textarea[name="title"]` when `NewTaskModal` opens.
6. **Tooltips for Strategy (A3 - Knowledge Coach)**
   - Add inline `title="..."` or small SVG icons with hover text next to the Pillar and Principle labels explaining their purpose.
7. **Cmd+Enter to Save (A4 - Automation Coach)**
   - Add a global `keydown` event listener strictly scoped to when the modals are open. If `Cmd+Enter` or `Ctrl+Enter` is pressed, trigger the modal's save/submit action.

## Implementation Plan
These will be executed in a single batch pass directly through source file modifications.
