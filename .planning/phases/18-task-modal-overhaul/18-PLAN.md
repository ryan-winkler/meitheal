---
wave: 1
depends_on: []
autonomous: true
files_modified:
  - apps/web/src/components/tasks/NewTaskModal.astro
  - apps/web/src/components/tasks/TaskDetailModal.astro
  - apps/web/src/lib/task-modal-controller.ts
---

# Plan: Task Modal Overhaul

**Phase:** 18

## Architectura Intent
Overhaul the `NewTaskModal` and `TaskDetailModal` to feel like a premium, dedicated application layer rather than an afterthought popup. This is achieved through CSS Grid structural changes, dark-mode glassmorphism aesthetics, dynamic status UI, and deeply integrated strategic alignments. 

## Implementation Tasks

### 1. NewTaskModal Overhaul
- **File:** `apps/web/src/components/tasks/NewTaskModal.astro`
- **Action:**
  - Inject glassmorphism classes (`backdrop-blur-xl bg-bg-primary/95 border-border-dim/50`).
  - Convert the `title` text input into a `<textarea rows="1" name="title" autofocus>` with `max-height` constraints.
  - Remove the native `<select name="status">`. Replace it with a grouped button layout (Backlog, Todo, In Progress, Done) acting as interactive pills. Add a hidden `<input type="hidden" name="status" value="backlog">` to maintain form data integrity.
  - Implement Keyboard shortcuts (`CMD+Enter` to save, `ESC` to close).

### 2. TaskDetailModal Architecture & Layout
- **File:** `apps/web/src/components/tasks/TaskDetailModal.astro`
- **Action:**
  - Widen the modal bounding box from `max-w-xl` to `max-w-4xl` or `5xl`.
  - Rewrite the layout into a CSS Grid: `grid-cols-1 md:grid-cols-12 gap-6`.
  - **Left Column (col-span-8):**
    - Large auto-expanding title textarea.
    - Markdown Description editor.
    - Checklists.
  - **Right Column (col-span-4):**
    - Custom Status Dropdown (grouped by phase).
    - Due Dates & scheduling.
    - Priority selection.
    - **Strategic Integration:** Embed the collapsible Strategic Lenses component here with visual indicators.

### 3. Controller Logic for UX Enhancements
- **File:** `apps/web/src/lib/task-modal-controller.ts`
- **Action:**
  - Add logic to attach variable height sizing to the new `textarea[name="title"]` on input events (e.g., `target.style.height = target.scrollHeight + 'px'`).
  - Add logic to handle clicks on the status pills/dropdown. When a pill is clicked, it highlights the pill, removes the highlight from siblings, and sets the value of the hidden `input[name="status"]` so the form submission hooks work untouched.
  - Implement global keyboard event listeners attached to the open modals for `Enter` and `Escape`.

## Verification Criteria
### Must Haves
- The TaskDetailModal must accurately render as a 2-column layout on desktop, and cleanly stack to 1-column on mobile viewports.
- The title textarea in both modals must expand downward as text is typed or pasted, stopping at a reasonable maximum height before introducing a scrollbar.
- Saving a task via the dynamic status dropdown/pills must successfully pass the correct value to the database, verifiable by reopening the task.
- The backdrop behind the modal must correctly blur the background application to increase visual focus.
