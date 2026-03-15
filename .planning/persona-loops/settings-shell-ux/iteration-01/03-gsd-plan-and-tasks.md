# GSD Plan & Tasks - Settings Shell UX Iteration 01

## Accepted Work
1. Convert the top summary strip into real quick-jump navigation.
2. Move summary titles/details into `settings-registry.ts` so the shell has less duplicated configuration.
3. Update the shell controller so active state syncs across summary strip, left rail, hash links, and scroll tracking.
4. Clear search-muted sections when users jump via nav instead of leaving the page in a half-filtered state.
5. Preserve ingress-safe hash navigation and existing companion/x-callback behavior.
6. Add focused browser coverage for the summary-strip jump flow.

## Deferred Work
1. Add richer telemetry/HEART instrumentation around search success and section-jump success.
2. Explore a sticky tablet summary strip once the current navigation settles.
3. Revisit the visual treatment of Danger Zone for even stronger separation without shouting.

## Success Criteria
- Summary cards are clickable and keyboard accessible.
- Clicking a summary card updates hash and active state exactly like the left rail.
- Search does not leave the page visually “stuck” after a manual jump.
- No ingress-breaking route behavior is introduced.
