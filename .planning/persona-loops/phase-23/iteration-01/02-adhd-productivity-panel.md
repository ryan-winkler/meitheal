# ADHD/Productivity Panel: New Task Modal

## 1. Friction Points
*   **Too Many Choices Upfront:** A modal that immediately asks for Pillar, Principle, Status, and complex metadata causes cognitive overload during the capture phase. 
*   **Context Switching:** Users get an idea -> open modal -> suddenly need to rethink strategy instead of just dumping the idea.

## 2. Solutions for Flow State
*   **Brevity is Key:** The capture modal should be lightning-fast. Title, optional Goal, and basic categorization (Task Kind).
*   **Immediate Deep Dive (Post-Capture):** Creating a ticket should auto-launch the `TaskDetailModal` so the user can *immediately* detail that thought while it's fresh, rather than hunting for the task again on a board. 
*   **Clear Categories (Task Kinds):** ADHD minds benefit from putting things in clear buckets: "Is this a checklist?", "Is this an event?", "Is this just a task?". Setting the `task_kind` visually clarifies the intent of the record.

## 3. Visual Overhaul
*   Align closely to the provided ClickUp reference: Tabs across the top corresponding to `task_kind`, a massive input field for the title, and explicit, well-spaced metadata slots below, completely shedding the clunky boxy look of the prior iteration.
