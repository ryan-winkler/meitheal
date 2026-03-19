# Optimization Panel — Dashboard Shell Rollout Iteration 01

## Post-Implementation Review

| Finding | Impact | Effort | Risk | Decision |
|---|---:|---:|---:|---|
| Dashboard-first was the right proving ground because the controller was already extracted | 5 | 1 | 1 | Keep |
| Habits should be the next page, but only after extracting its inline script into a pageLifecycle-safe controller | 5 | 3 | 2 | Accept |
| SearchHub verification exposed a useful schema drift bug (`areas.name` vs `areas.title`) that should stay covered | 4 | 1 | 2 | Accept |
| A generic section-shell controller could further reduce duplication if Today/Upcoming/Calendar adopt the same shell | 4 | 3 | 2 | Carry forward |
