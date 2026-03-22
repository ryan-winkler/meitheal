# GSD Persona Loop — New Task Modal UX Audit

## Panel 1: Frontier Experts

| Persona | Recommendation | Impact | Effort | Risk | Decision |
|---------|---------------|--------|--------|------|----------|
| Product Architect | Collapse empty ASSIGNMENT section to inline placeholder | 3 | 2 | 1 | **Accept** |
| Platform Architect | Add "Add date" placeholder text in InlineDatePicker mounts | 3 | 1 | 1 | **Accept** |
| OSS Integrations | Replace native `<select>` for Shopping category with glass-dropdown | 3 | 2 | 1 | **Accept** |
| Reliability Engineer | Add graceful fallback if InlineDatePicker fails to mount | 3 | 2 | 2 | **Defer** |
| Security Engineer | Audit innerHTML usage in checklist/label rendering for XSS | 4 | 2 | 3 | **Defer** |

## Panel 2: ADHD/Productivity

| Persona | Recommendation | Impact | Effort | Risk | Decision |
|---------|---------------|--------|--------|------|----------|
| Workflow Coach | Pin footer (Cancel/Create) to modal bottom viewport | 4 | 2 | 2 | **Accept** |
| Execution Coach | Add priority color indicators to dropdown items | 3 | 2 | 1 | **Accept** |
| Knowledge Coach | Make toggle switches more prominent (size/label) | 2 | 1 | 1 | **Accept** |
| Focus Optimizer | Hide contextual fields border when no fields (Task kind) | 2 | 1 | 1 | **Accept** |
| Automation Coach | Remove duplicate footer priority indicator | 3 | 1 | 1 | **Accept** |

## Implementation Order

1. Pin footer to modal bottom *(highest impact)*
2. Collapse empty ASSIGNMENT section
3. Remove duplicate footer priority indicator
4. Priority color indicators for dropdown
5. Add "Add date" placeholder text
6. Shopping category → glass-dropdown
7. More prominent toggle switches
8. Hide contextual border for Task kind
