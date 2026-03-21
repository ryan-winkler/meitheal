# ADHD/Productivity Panel - Phase 16 Iteration 04

## Objective
Reduce contributor cognitive load while preserving strict architecture standards.

| Persona | Recommendation | Impact (1-5) | Effort (1-5) | Risk (1-5) | Decision |
| --- | --- | --- | --- | --- | --- |
| Workflow Coach | Provide a visual indication (like a chevron or hover background) on the header + button so it's obvious it's a dropdown and not just an action trigger. | 4 | 1 | 1 | Accept |
| Execution Coach | The Add Column menu should close immediately when an option is toggled to reduce clicks required to get back to the timeline context. | 3 | 1 | 1 | Accept |
| Knowledge Coach | Extract the dropdown logic into a reusable `createDropdownMenu` helper function in the utils to avoid code duplication and share the exact same UI across the app for custom select dropdowns. | 4 | 2 | 2 | Accept |
| Focus Optimizer | Keep the UI lightweight—ensure no new complex SVGs or heavy DOM structures are injected just for the Add Column dropdown. Use existing CSS variables for colors. | 4 | 1 | 1 | Accept |
| Automation Coach | Automatically re-focus the "+ column" button when the dropdown is closed so keyboard navigation isn't lost. | 2 | 2 | 1 | Reject |

## Capture/Triage/Follow-through Improvement

- Extracted dropdown helper function will ensure standard accessibility and reliable closing states across all future UI dropdown elements, improving the flow of toggling timeline options without frustration.
