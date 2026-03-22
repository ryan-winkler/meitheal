# Research: Timeline Filters & Grouping UX Redesign

## Objective
Redesign the UI/UX of the Timeline's filtering and grouping mechanisms. The current implementation uses basic native HTML `<select>` elements and a clunky advanced filters box. The goal is to create a production-ready, visually sharp, and highly functional interface that aligns with Home Assistant's design principles and Meitheal's DDD architecture, drawing inspiration from top-tier productivity tools like ClickUp and Linear.

## Persona Loop Analysis (Lead UX Engineer)

### 1. Current State Assessment
- **UI Paradigm:** Form-heavy. The current `FilterToolbar.astro` relies almost entirely on `<select>` dropdowns for Status, Priority, RICE, User, Area, and Grouping.
- **Advanced Filters:** An expandable region with raw `<select>` and `<input>` fields. Functional, but feels like an internal developer tool rather than a premium user-facing application.
- **Aesthetic:** Lacks the glassmorphic, seamless integration expected in the Home Assistant environment. It takes up horizontal space and looks cluttered when multiple filters are active.

### 2. Industry Benchmarking (e.g., Linear, ClickUp, Notion)
- **Filters:** Filters are typically applied via a unified "Filter" button that opens a rich popover menu. Once applied, filters appear as prominent, removable "pills" or tags alongside the toolbar.
- **Grouping:** Grouping is usually handled by a concise "Display" or "Group" dropdown that uses icons and clean typography, rather than a native operating system `<select>` menu.
- **Interaction:** Changes apply instantly (which our current implementation handles well via `meitheal:filter-change`), but the visual feedback is much richer.

### 3. Proposed Redesign Architecture

#### A. Glassmorphic Dropdown System
We need a reusable custom dropdown system that replaces native `<select>` boxes.
- **`DropdownMenu.astro` / `DropdownMenu.ts`:** A custom popover component using floating-ui (or similar light positioning) or pure CSS if possible, styled with Meitheal's glassmorphic tokens (backdrop-blur, subtle borders, deep shadows).
- **Triggers:** Buttons that look like minimal badges or ghost buttons with a chevron down icon.

#### B. Unified Filter Builder (Pill-based)
Instead of 5 separate dropdowns always taking up space:
1. **"Filter" Button:** Opens a popover to select a field (`Status`, `Priority`, `Assignee`, etc.).
2. **Active Filter Pills:** Once a filter is created, it renders as a pill in the toolbar: `[ Status: Active (x) ]`.
3. **Advanced Modes:** Clicking a pill opens a popover to change its operator/value.

#### C. Grouping Popover
- Replace the native `Group By` and `Sub-group By` selects with a single "Display" or "Group" button.
- Clicking it opens a custom popover with list items for each grouping option, complete with leading icons (e.g., an icon for Status, Area, Priority).

### 4. Technical Implementation Strategy
- **Astro Native:** Build components leveraging Astro.
- **Vanilla JS:** Use vanilla JS for popover state and pill management (aligns with `filter-state.ts` and `timeline-controller.ts`).
- **CSS:** Use existing variables in `index.css` (e.g., `--color-surface-elevated`, `--glass-bg`).
- **DDD Compliance:** The filter state management remains in `tasks/ui` bounds.

## Next Steps
1. Draft the `implementation_plan.md`.
2. Present plan to user for review.
3. Execute the custom dropdown and filter pill UI.
