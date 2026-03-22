# Panel 02: ADHD & Productivity Experts

**Phase:** 18
**Iteration:** 01
**Objective:** Task Modal Overhaul: Enhance New Task & Edit Task overlays with glassmorphism, responsive 2-column layout, dynamic status dropdown, and integrated Strategic Lenses.

## 1. Workflow Coach
**Recommendation:** Set the `autofocus` attribute on the title textarea specifically for the New Task modal, ensuring immediate capture readiness without a second click. 
**Scores:** Impact: 5 | Effort: 1 | Risk: 1
**Decision:** Accept

## 2. Execution Coach
**Recommendation:** Group the dynamic status dropdown options by their parent phase (e.g., Backlog, Todo, In Progress, Done) using optgroups or visual dividers, so users don't get overwhelmed by a long flat list of custom statuses.
**Scores:** Impact: 4 | Effort: 2 | Risk: 1
**Decision:** Accept

## 3. Knowledge Coach
**Recommendation:** Add a visual indicator (like a filled icon or badge with a count) on the collapsed Strategic Lenses header in the Edit Modal. This prevents "out of sight, out of mind" by showing that strategic alignments exist without requiring expansion.
**Scores:** Impact: 4 | Effort: 2 | Risk: 1
**Decision:** Accept

## 4. Focus Optimizer
**Recommendation:** Enhance the modal backdrop with `backdrop-blur-sm` and a darker semi-transparent overlay. This visually mutes the complex Kanban board behind it, reducing cognitive load and enforcing single-task focus.
**Scores:** Impact: 4 | Effort: 1 | Risk: 1
**Decision:** Accept

## 5. Automation Coach
**Recommendation:** Implement global keyboard shortcuts scoped to the modal: `Command/Ctrl + Enter` to save the task, and `Escape` to close the modal, minimizing context switching between keyboard and mouse.
**Scores:** Impact: 5 | Effort: 2 | Risk: 1
**Decision:** Accept
