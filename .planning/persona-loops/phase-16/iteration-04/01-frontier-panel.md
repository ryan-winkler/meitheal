# Frontier Panel - Phase 16 Iteration 04

## Objective
UI/UX optimizations, memory optimization, click handlers, and button issue avoidance

| Persona | Recommendation | Impact (1-5) | Effort (1-5) | Risk (1-5) | Decision |
| --- | --- | --- | --- | --- | --- |
| Platform Architect | Centralize click-outside logic using AbortController to automatically clean up orphaned document event listeners. | 4 | 2 | 2 | Accept |
| OSS Integrations Specialist | Export the Gantt UI state changes via native CustomEvents instead of direct localStorage coupling inside button click handlers. | 2 | 3 | 1 | Reject |
| Reliability Engineer | Fix immediate memory leaks in `addColBtn` and `colMenuBtn` where closing menus by clicking the toggle button leaves ghost `document.addEventListener("click")` listeners forever. | 5 | 1 | 1 | Accept |
| Security Engineer | Replace using `innerHTML` for SVG construction (e.g. `checkIcon` in dropdown) with static DOM generation or sanitized templates to avoid DOM wiping and XSS vulnerabilities. | 4 | 2 | 1 | Accept |
| Product Architect | Standardize spacing and vertical alignment inside newly added dropdown menus so text properly centers with icons. | 3 | 1 | 1 | Accept |

## Rejected or Deferred

- OSS Integrations Specialist recommendation rejected due to low impact on immediate stability and UX.
