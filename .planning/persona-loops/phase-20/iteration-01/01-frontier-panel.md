# Frontier Panel - Phase 20 Iteration 01

## Objective
Task Modal Overhaul - UI/UX Improvements

| Persona | Recommendation | Impact (1-5) | Effort (1-5) | Risk (1-5) | Decision |
| --- | --- | --- | --- | --- | --- |
| Platform Architect | Add intersection observer or viewport boundaries to `StrategicEvaluator` inline panel so it never overflows off-screen when opened. | 4 | 2 | 2 | Accept |
| OSS Integrations Specialist | Real-time optimistic UI update for the Status Dropdown without waiting for network (e.g. standardizing `isMutating` state UI). | 5 | 4 | 2 | Defer |
| Reliability Engineer | Add visual loading state (spinner/toast) when Principle dropdown is actively fetching after Pillar selection. | 4 | 2 | 1 | Accept |
| Security Engineer | Apply solid color fallback for `backdrop-blur` on older devices or configurations mimicking reduced transparency modes. | 4 | 1 | 1 | Accept |
| Product Architect | Increase touch targets (min 44px height) for all interactable elements (dropdowns, lens toggle) for mobile responsiveness. | 5 | 1 | 1 | Accept |

## Rejected or Deferred

- (Deferred) OSS Integrations Specialist: Real-time optimistic UI updates for status dropdown requires broader framework updates across tasks.
