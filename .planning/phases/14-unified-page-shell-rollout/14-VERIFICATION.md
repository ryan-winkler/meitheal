# Phase 14 Verification

**Date:** 2026-03-19

## Tier 1

- `git diff --check`
  - Passed
- `pnpm --filter @meitheal/web build`
  - Passed, with existing Astro/Vite warnings only
- `pnpm check`
  - Passed, with existing Astro/Vite warnings only
- `E2E_BASE_URL=http://127.0.0.1:4321 pnpm --filter @meitheal/tests test tests/e2e/dashboard-shell.spec.ts`
  - Passed, 3/3 tests green
- `curl -sS -o /tmp/dashboard-search.json -w '%{http_code}\n' 'http://127.0.0.1:4321/api/search?scope=all'`
  - Returned `200`

## Tier 2

- Not required for this slice. The rollout changed dashboard UI/client behavior only and did not touch ingress, middleware, HA websocket, supervisor, or add-on lifecycle code.

## Acceptance Check

1. Dashboard uses `UnifiedBar` with hash-linked sections: passed
2. SearchHub opens from the dashboard shell and `/api/search` stays healthy: passed
3. Shared new-task and task-detail handoff still work from the dashboard: passed
4. The rollout path for habits and later pages is documented: passed
