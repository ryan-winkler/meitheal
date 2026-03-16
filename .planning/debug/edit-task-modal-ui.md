# Debug: Edit Task Modal UI/UX Issues

## Status: INVESTIGATING 🔍

## Symptoms
- On mobile/small viewports (as seen in screenshot), the Task Detail / Edit Modal UI is broken.
- The "description" and checklist options seem to be "hidden" behind the custom fields.
- The scrolling of the entire modal isn't reactive and doesn't have the best UX.
- The modal layout appears to be absolute/fixed positioned incorrectly or lacking proper flexbox boundaries and `overflow-y: auto`.

## Hypotheses
1. **Hypothesis 1 (Overlap):** The sidebar or metadata section is absolutely positioned or lacking a proper grid/flex layout block on mobile, causing it to overlap the main content (description/checklist). Alternatively, the main content is forced behind the sidebar due to a missing flex-direction column on mobile.
2. **Hypothesis 2 (Scrolling):** The modal content container lacks `flex: 1` and `overflow-y: auto`, or the `max-height` is not constrained to `100dvh` (lacking safe area insets), causing the whole modal wrapper to scroll instead of just the content body, breaking sticky headers/footers.

## Investigation Steps
1. [x] Locate the component (likely `TaskDetailModal.astro` or similar).
2. [x] Analyze the DOM structure (Grid/Flex layout, main content vs sidebar).
3. [x] Check mobile media queries in `_modal.css` or embedded styles that might be breaking the layout.
4. [x] Understand how description and checklist are rendered.

## Findings
The layout bug was caused by an interaction between tailwind flexbox classes spanning the `<main>` and `<aside>` sidebar elements inside `TaskDetailModal.astro`.

1. **Root Cause**: On mobile screens (where flex-col applies), the wrapper element had `overflow-hidden` preventing the modal from scrolling as a single, tall vertical flow. Additionally, the `<main>` element was styled with `flex-1`, while the `<aside>` element lacked it. As a result, when the `<aside>` took up its natural height for the many task properties, the `flex-1` boundary squeezed `<main>` into a 0px height, making its contents (Description, Checklists) disappear.
2. **Fix Applied**: 
   * On the flex wrapper containing `<main>` and `<aside>`, we changed `overflow-hidden` to `overflow-y-auto md:overflow-hidden`. This allows the modal to be scrollable all the way through organically on mobile screens.
   * On the `<main>` column, we changed `flex-1` to `flex-none w-full md:flex-1 md:w-auto`. This allows the element to take its natural full height vertically without squashing on mobile, while still expanding to fill horizontal space correctly on desktop `md` layouts alongside the sidebar.
   
## Status: RESOLVED ✅
