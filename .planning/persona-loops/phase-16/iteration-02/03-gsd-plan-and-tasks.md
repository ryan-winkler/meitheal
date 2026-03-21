# GSD Plan & Tasks — Phase 16 Iteration 02

## Synthesized Tasks (from Panel Recommendations)

All 10 accepted recommendations from frontier + ADHD panels, ordered by dependency:

### T1: Core Native SVG Renderer [Foundational]
**Source**: Architectural pivot (Frappe Gantt CSS pipeline failure)
**GSD**: `/gsd-execute-phase 16`
- Build native SVG GANTT renderer with grid, bars, headers, column lines
- Pure vanilla JS + SVG, zero dependencies
- Use all existing Meitheal CSS vars for theming (Frontier → OSS Integrations Specialist)
- Sanitize all text via DOM APIs, never innerHTML (Frontier → Security Engineer)

### T2: Fixed Label Sidebar
**Source**: Frontier → Platform Architect
**GSD**: `/gsd-execute-phase 16`
- Add a fixed-position left column (~200px) with task names + ticket numbers
- Position: `sticky; left: 0` overlaying SVG
- Row heights must align with SVG grid rows

### T3: Resize Handles
**Source**: Frontier → Reliability Engineer
**GSD**: `/gsd-execute-phase 16`
- Add left/right edge drag handles on each bar
- Snap to current zoom unit
- Left handle changes `start_date`, right handle changes `end_date`
- Show date tooltip during drag

### T4: Hover Tooltips
**Source**: Frontier → Product Architect
**GSD**: `/gsd-execute-phase 16`
- Lightweight `<div>` tooltip on bar `mouseenter` (300ms delay)
- Shows: task name, dates, status, priority, progress
- Dismiss on `mouseleave`

### T5: Scroll-to-Today FAB
**Source**: ADHD → Workflow Coach
**GSD**: `/gsd-execute-phase 16`
- Sticky FAB in bottom-right of GANTT wrapper
- Pulse animation on first load
- Smooth scroll to today marker line

### T6: Keyboard Shortcuts
**Source**: ADHD → Execution Coach
**GSD**: `/gsd-execute-phase 16`
- `T` → scroll to today
- `N` → open quick-capture modal
- Arrow keys → navigate between bars
- Enter → open popup for focused bar

### T7: Priority Legend
**Source**: ADHD → Knowledge Coach
**GSD**: `/gsd-execute-phase 16`
- Collapsible chip in timeline toolbar
- Maps colours to P1-P4 labels
- Shows type indicators (epic/story/task)

### T8: Overdue Visual Markers
**Source**: ADHD → Focus Optimizer
**GSD**: `/gsd-execute-phase 16`
- Red left-border accent on bars where `end_date < today && !isComplete`
- Subtle pulsing glow animation
- Independent of task priority colour

### T9: Scroll Position Persistence
**Source**: ADHD → Automation Coach
**GSD**: `/gsd-execute-phase 16`
- Persist `scrollLeft` to localStorage keyed by zoom level
- Restore on view re-enter (hash switch back to `#timeline`)

### T10: Milestone Markers
**Source**: Research → Competitive Analysis
**GSD**: `/gsd-execute-phase 16`
- Diamond-shaped markers for zero-duration milestones
- Positioned at due_date when start_date === end_date
- Distinct from regular bar rendering

## Execution Order (dependency-aware)
1. T1 (core renderer) — foundation for all others
2. T2 (sidebar) — parallel with T1 completion
3. T3 (resize handles) — requires T1 bars
4. T4 (hover tooltips) — requires T1 bars
5. T5 (scroll FAB) — requires T1 scroll wrapper
6. T8 (overdue markers) — requires T1 bars
7. T10 (milestones) — requires T1 renderer
8. T6 (keyboard) — requires T1 + T5
9. T7 (legend) — standalone toolbar addition
10. T9 (scroll persistence) — requires T5

## Verification Plan
- `astro check` + `astro build` pass
- E2E tests (`timeline-shell.spec.ts`) updated and passing
- Tier 1 visual verification (screenshots in walkthrough)
- All 10 features manually tested in browser
