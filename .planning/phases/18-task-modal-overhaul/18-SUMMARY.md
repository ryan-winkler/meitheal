# Research Synthesis: Task Modal Overhaul

**Phase:** 18

## Key Findings & Decisions

1. **Layout Paradigm Shift:** The rigid, single-column modals constrict data density. The shift to a responsive 2-column grid in `TaskDetailModal.astro` (stacking on mobile) is mathematically necessary to fit Strategic Lenses alongside core task data without inducing endless vertical scrolling.
2. **Glassmorphism Aesthetic:** To achieve the "ClickUp-but-better" premium feel, native elements like `<select>` are dealbreakers. We must replace them with semantic, custom HTML constructs styled with utilities like `bg-bg-primary/90 backdrop-blur-md border-border-dim`.
3. **Frictionless Capture:** The `NewTaskModal.astro` must retain speed. Auto-focusing an auto-expanding title textarea removes the physical constraint of a one-line input, accommodating ADHD brain-dumping behavior immediately.
4. **Strategic Context Alignment:** Sidelining Pillars and Goals to a separate view breaks task coherence. By pulling `StrategicEvaluator.astro` directly into the edit modal's right rail, alignment becomes a primary action rather than an afterthought.

## Next Steps
Proceed to technical planning (`18-PLAN.md`) to map these architectural decisions into precise file modifications and task blocks.
