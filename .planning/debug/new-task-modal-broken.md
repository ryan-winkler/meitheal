# Debug: New Task Modal Not Appearing

## Status: RESOLVED ✅

## Symptoms
- Clicking "+ New Task" button triggers focus shift but modal does not appear
- Affects all pages with the button (dashboard, kanban, today, table, etc.)

## Root Causes Found
1. **CSS specificity conflict**: Inline `style="display:none;position:fixed;"` on `#new-task-overlay` defeated `.modal-overlay.open { display: flex }` because inline styles have highest CSS specificity.
2. **Missing animation trigger**: `.modal-content` defaults to `opacity: 0; transform: scale(0.98) translateY(10px)` but the `modalFadeIn` animation only triggered on `dialog[open] .modal-content` — `NewTaskModal` uses a `<div>`, not `<dialog>`.

## Fixes Applied
1. Replaced inline styles with Tailwind `hidden` class + CSS `open` class toggling
2. Added `.modal-overlay.open .modal-content` rule to `_modal.css` for the fade-in animation
3. Added Escape key handler for keyboard accessibility
4. Added `role="dialog"`, `aria-modal="true"`, `aria-labelledby="new-task-title"` attributes

## Files Changed
- `apps/web/src/components/tasks/NewTaskModal.astro` — HTML + JS toggle logic + accessibility
- `apps/web/src/styles/_modal.css` — animation trigger for div-based modal overlays
- `tests/e2e/new-task-modal.spec.ts` — 8 E2E tests (all passing)

## Verification
- [x] Tier 1: Browser test on fresh dev server — modal opens, styled, animates, closes via all methods
- [x] E2E: 8/8 tests passed (open, accessibility, form fields, close, cancel, escape, backdrop, autofocus)
