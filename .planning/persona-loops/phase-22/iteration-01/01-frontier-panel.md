# Frontier Panel - Phase 22 Iteration 01

## Objective
Task Modal UX/IA Polish and Bug Fixes

| Persona | Recommendation | Impact (1-5) | Effort (1-5) | Risk (1-5) | Decision |
| --- | --- | --- | --- | --- | --- |
| Platform Architect | Convert Title `<textarea>` resizing listener to calculate `scrollHeight` against an unconstrained container, or revert to `contenteditable` `<h3>` to prevent forced truncation or layout breakages shown in user feedback. | 5 | 2 | 2 | Accept |
| OSS Integrations Specialist | Re-architect the `TaskDetailModal` to strictly match the ClickUp standard Information Architecture: Breadcrumbs & Title on top, a horizontal/CSS Grid of Properties (Status, Assignee, Dates, Pillar) immediately below, followed by Description and Subtasks on the left, reserving the right column exclusively for 'Activity'. | 5 | 4 | 2 | Accept |
| Reliability Engineer | Resolve the 'Related Links' dropdown overflow by removing `overflow: hidden;` from parent containers `flex-1` / `overflow-y-auto` combinations, or migrating the dropdown to a React/portal-like strategy placing the `z-index` over the document root. | 5 | 1 | 1 | Accept |
| Security Engineer | Ensure proper semantic labeling and tab-indexing when shifting the properties grid to the top to maintain accessibility flow. | 4 | 1 | 1 | Accept |
| Product Architect | Implement a full-width "Add a detailed description..." block that closely mimics ClickUp's gray-background placeholder text design to improve WYSIWYG perception. | 4 | 1 | 1 | Accept |

## Rejected or Deferred

- (none yet)
