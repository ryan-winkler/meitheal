# ADHD & Productivity Panel — Dashboard Shell Rollout Iteration 01

## Objective

Reduce cognitive overhead on the dashboard while preserving the “capture, orient, act” workflow inside Home Assistant.

| Recommendation | Impact | Effort | Risk | Decision | Notes |
|---|---:|---:|---:|---|---|
| Make the dashboard sections job-oriented: overview, momentum, capture, focus, recent | 5 | 2 | 1 | Accept | Helps users understand where to go without scanning the whole page |
| Keep quick add visible as a first-class section, not hidden behind a modal-only flow | 5 | 1 | 1 | Accept | Supports low-friction capture for overwhelmed users |
| Preserve overdue context in the hero so urgency is visible before scrolling | 4 | 1 | 1 | Accept | Keeps executive-function support up front |
| Ship dashboard and habits together in one UX refactor | 2 | 5 | 4 | Reject | Too much context switching; habits still has inline-script debt |

## Accepted Direction

1. The dashboard shell should create a clear sequence: orient, review momentum, capture, focus, review recent work.
2. The rollout should stay page-by-page to limit cognitive and implementation churn.
