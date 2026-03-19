# Optimization Actions — Dashboard Shell Rollout Iteration 01

## Open Actions

1. Create the habits follow-up slice: extract the inline script into a page controller, normalize fetch/listener lifecycle, then apply the shared shell.
2. Consider extracting the dashboard section-navigation logic into a generic section-shell helper before the third page adopts the pattern.
3. Keep the dashboard browser spec and `/api/search?scope=all` probe in the verification toolkit so future shell changes do not regress SearchHub.
