# Implementation Log — Dashboard Shell Rollout Iteration 01

## Notes

- Date: 2026-03-19
- This iteration follows the repo’s existing manual persona-loop pattern so the seven required artifacts stay present even though the skill generator scripts are not available locally.

## Changes Made

1. Added a new Phase 14 planning lane for the dashboard-first shell rollout and aligned `PROJECT`, `ROADMAP`, `REQUIREMENTS`, and `STATE`.
2. Added `apps/web/src/lib/unified-bar-controller.ts` so title switching, SearchHub launch, new-task launch, and overflow handling are reusable outside Settings.
3. Added `apps/web/src/lib/dashboard-registry.ts` and reworked `apps/web/src/pages/index.astro` around `UnifiedBar` plus five deep-linkable dashboard sections.
4. Replaced the old dashboard controller with a lifecycle-safe boot path that manages shell state, quick add, queue filtering, and task-detail launchers.
5. Updated `apps/web/src/lib/settings-shell-controller.ts` and `apps/web/src/components/layout/UnifiedBar.astro` to use the shared bar interaction contract.
6. Added `tests/e2e/dashboard-shell.spec.ts` for dashboard tab navigation, SearchHub launch, and shared new-task modal launch.
7. Fixed a pre-existing search failure by updating `AreaRepository` and the search service to use `areas.name` instead of the stale `areas.title` column.

## Verification

1. `git diff --check`
2. `pnpm --filter @meitheal/web build`
3. `pnpm check`
4. `E2E_BASE_URL=http://127.0.0.1:4321 pnpm --filter @meitheal/tests test tests/e2e/dashboard-shell.spec.ts`
5. `curl -sS -o /tmp/dashboard-search.json -w '%{http_code}\n' 'http://127.0.0.1:4321/api/search?scope=all'`

## Results

1. Dashboard now uses the mature shell language and keeps the existing dashboard task flows intact.
2. Shared `UnifiedBar` behavior is ready for the habits follow-up instead of remaining settings-only.
3. SearchHub is healthy on the dashboard path after the area-schema fix.
