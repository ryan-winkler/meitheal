---
type: "Runbook"
title: "Operations Runbook"
description: "Diagnose and recover from operating problems."
---

# Operations Runbook

## Logging Pipeline Health

1. Confirm app emits JSON logs to stdout.
2. Confirm Alloy can read journal stream.
3. Confirm Loki receives labeled streams.
4. Confirm Grafana dashboards resolve data source.

## Live Updates

Open `GET /api/sse` through an authorized Home Assistant ingress session or the standalone app. The response should start with a `connected` event and send a heartbeat comment every 30 seconds. To verify Home Assistant delivery, open two streams and change a disposable calendar or to-do entity. Each stream should receive one `ha:entity_changed` event for the change. Closing the final stream releases the Meitheal event listeners.

Meitheal closes a stream when a frame would put more than 64 KiB in its application queue. The packaged server also counts pending Node HTTP output toward that budget and terminates a backed-up socket. HTTP framing and one frame being written by the adapter can add to the observed buffer size. EventSource can reconnect. If the browser repeatedly reconnects, check the proxy's stream buffering and the size and frequency of the entity updates.

## Dashboard Shell Verification

Use this after changing dashboard shell, search-launcher, or top-level navigation behavior.

1. Run `E2E_BASE_URL=http://127.0.0.1:4321 pnpm --filter @meitheal/tests test tests/e2e/dashboard-shell.spec.ts`.
2. Query `GET /api/search?scope=all` and confirm it returns `200` because the dashboard shell now depends on SearchHub.
3. Confirm the dashboard URL can move between:

- `#dashboard-overview`
- `#dashboard-momentum`
- `#dashboard-capture`
- `#dashboard-open`
- `#dashboard-recent`

4. Confirm the shell `New Task` button still opens the shared task modal and not a page-local implementation.

## Habits Shell Verification

Use this after changing habits shell, shell navigation, or the habits controller path.

1. Run `E2E_BASE_URL=http://127.0.0.1:4321 pnpm --filter @meitheal/tests test tests/e2e/habits-shell.spec.ts`.
2. Query `GET /habits` and confirm it returns `200`.
3. Confirm the habits URL can move between:

- `#habits-overview`
- `#habits-rhythm`
- `#habits-library`
- `#habits-flow`

4. Confirm the shell `New Habit` button opens the shared habits modal.
5. Confirm the shell search launcher still opens SearchHub instead of a page-local search surface.

## Today Shell Verification

Use this after changing the Today shell, Today controller, or task-detail handoff logic.

1. Run `E2E_BASE_URL=http://127.0.0.1:4321 pnpm --filter @meitheal/tests test tests/e2e/today-shell.spec.ts`.
2. Confirm the Today URL can move between:

- `#today-overview`
- `#today-focus`
- `#today-triage`
- `#today-work`
- `#today-habits`

3. Confirm the shell search launcher opens SearchHub and `#ask-ha-btn` is still present.
4. Confirm the shell `New Task` button opens the shared task modal.
5. Confirm clicking a Today task still opens the shared task detail surface.

## Task Link Verification

Open a task and select **Copy task link**. If the browser cannot access the clipboard, copy the selected link from the text field. The link opens the same task in the Tasks view for a recipient who can already access the installation and the task.

1. Open the copied link in a fresh authorized browser tab. Reload and confirm the same title and ticket number.
2. Repeat through Home Assistant. Confirm the URL keeps its ingress prefix and that the destination still requires Home Assistant access.
3. Open an old `/tasks#task-MTH-…` link. Confirm it opens the task and the Tasks view remains usable when you close the detail.
4. Delete a disposable task and reopen its link. Confirm the unavailable message appears and **Close detail** returns to the Tasks view.
5. Run `MEITHEAL_TEST_BROWSER=1 pnpm --filter @meitheal/tests test e2e/task-permalink.spec.ts` after building the web app.

## Upcoming Shell Verification

Use this after changing the Upcoming shell or `upcoming-controller.ts`.

1. Run `E2E_BASE_URL=http://127.0.0.1:4321 pnpm --filter @meitheal/tests test tests/e2e/upcoming-shell.spec.ts`.
2. Confirm the Upcoming URL can move between:

- `#upcoming-overview`
- `#upcoming-next`
- `#upcoming-week`
- `#upcoming-flow`

3. Confirm the shell search launcher opens SearchHub and `#ask-ha-btn` is still present.
4. Confirm the shell `New Task` button opens the shared task modal.
5. Confirm clicking an Upcoming task opens the shared task detail surface without routing away from `/upcoming`.

## Calendar Shell Verification

Use this after changing the Calendar shell, `calendar-controller.ts`, or route-switch behavior.

1. Run `E2E_BASE_URL=http://127.0.0.1:4321 pnpm --filter @meitheal/tests test tests/e2e/calendar-shell.spec.ts`.
2. Confirm the Calendar URL can move between:

- `#calendar-overview`
- `#calendar-month`
- `#calendar-agenda`
- `#calendar-flow`

3. Confirm `TaskViewTabs` still preserve the current query string when switching routes.
4. Confirm clicking a month cell opens the day drawer.
5. Confirm `Add Task` from the day drawer opens the shared task modal.

## Kanban Shell Verification

Use this after changing the Kanban shell or `kanban-controller.ts`.

1. Run `E2E_BASE_URL=http://127.0.0.1:4321 pnpm --filter @meitheal/tests test tests/e2e/kanban-shell.spec.ts`.
2. Pick a disposable area and check that its lane counts agree with the cards. Add a task in a lane and check that it appears in that area after reload.
3. Test a rejected create and confirm the title stays in the form. Move the task with the card actions and by dragging. Test a rejected move and confirm that the card stays in its original lane.
4. With a task key focused, use the arrow keys and open the focused card. Repeat the card actions at a 320 px viewport and with reduced motion enabled.
5. Confirm SearchHub, Assist, lane management, and the task view tabs still open. See the [Kanban guide](kanban-shell-guide.md) for the user workflows.
6. Run `tests/e2e/kanban-pagination.spec.ts` against a disposable server. Inspect the raw Tasks response and confirm it contains only the requested view. Check page navigation, full-board filtering, the retry state and relative card order.
7. For render changes, compare the packaged server with the same 1,000- and 2,000-card fixture. Record uncompressed HTML bytes, warm request latency and rendered card count. Use an isolated Home Assistant fixture for native performance qualification.

## Table Shell Verification

Use this after changing the Table shell or `table-controller.ts`.

1. Run `E2E_BASE_URL=http://127.0.0.1:4321 pnpm --filter @meitheal/tests test tests/e2e/table-shell.spec.ts`.
2. Open `/table` with a query and confirm the redirect lands on the Table tab inside Tasks. Switch views and reload to check that the query persists.
3. Use the Table filter builder and verify matching rows and the no-results state.
4. Open SearchHub, Ask Home Assistant and New Task from the Tasks header.
5. Use the task key to open detail with a keyboard. Close the dialog and confirm focus returns to that key.

## Cross-Page Shell Program Verification

Use this before closing the full 14.2→14.7 rollout family.

1. Run:

- `E2E_BASE_URL=http://127.0.0.1:4321 pnpm --filter @meitheal/tests test tests/e2e/today-shell.spec.ts`
- `E2E_BASE_URL=http://127.0.0.1:4321 pnpm --filter @meitheal/tests test tests/e2e/upcoming-shell.spec.ts`
- `E2E_BASE_URL=http://127.0.0.1:4321 pnpm --filter @meitheal/tests test tests/e2e/calendar-shell.spec.ts`
- `E2E_BASE_URL=http://127.0.0.1:4321 pnpm --filter @meitheal/tests test tests/e2e/kanban-shell.spec.ts`
- `E2E_BASE_URL=http://127.0.0.1:4321 pnpm --filter @meitheal/tests test tests/e2e/table-shell.spec.ts`

2. Confirm Calendar, Kanban, and Table preserve filters when switching via `TaskViewTabs`.
3. Confirm Today, Upcoming, Calendar, and Table still open the shared task detail surface.
4. Confirm no page introduces page-local search or page-local AI launchers.
5. Run Tier 2 ingress verification in the HA devcontainer before marking the full phase family complete.

## Task -> Calendar Traceability

Use `request_id` or `task_id` to follow lifecycle records:

1. `tasks` row shows `calendar_sync_state`.
2. `domain_events` includes `integration.sync.requested` and completion/failure events.
3. `integration_attempts` stores integration status and retry metadata.
4. `calendar_confirmations` stores confirmation IDs and provider event IDs.
5. `audit_trail` captures human-readable audit entries.

Recommended Loki filter sequence:

1. `{service=\"meitheal\",domain=\"tasks\"}` for creation lifecycle.
2. `{service=\"meitheal\",domain=\"integrations\"}` for calendar handoff.
3. `{service=\"meitheal\",domain=\"audit\"}` for final operator-facing trace.

## HA Ingress Login Failure

1. Verify `X-Ingress-Path` and `HASSIO_TOKEN` forwarding.
2. Check middleware rejection reason in auth logs.
3. Validate add-on ingress settings in `meitheal-hub/config.yaml`.

## Startup Health and Diagnostics

1. Query `GET /api/health` to validate runtime + DB readiness.
2. Inspect add-on logs for:

- `Database migration failed` errors from `run.sh`.
- startup healthcheck pass/fail diagnostics.

3. If health is failing:

- verify `MEITHEAL_DB_URL` and add-on write permissions.
- run migration commands manually in add-on shell.

The add-on defaults to `file:/data/meitheal.db`. File and in-memory URLs use the local SQLite client in both startup and migrations. An explicit remote database URL still selects the standard libSQL client.

## Database Migrations

Primary command path:

1. `pnpm --filter @meitheal/web db:migrate`
2. Verify applied migrations table `__meitheal_migrations`.
3. Confirm task-sync tables exist and are queryable.

CI gate:

1. `migration-check` job runs `db:migrate:check`.
2. If pending migrations exist, CI fails closed.

## Task comments

Post comments from the task detail panel or send `{"content":"Your note"}` to `POST /api/tasks/{id}/comments`. The endpoint accepts up to 5,000 characters in a JSON body of at most 32 KiB. It returns the comment created by that request. An older client can still send an `author` field. Meitheal derives attribution from the caller and preserves the recorded authors of existing comments.

Through Home Assistant, open Meitheal from a session that verifies the user. If the local Home Assistant name cache is unavailable, new comments use a short member reference. API writes use the configured automation credential label and require `tasks:write`. A standalone request uses the local user label.

To retrieve one comment, use `GET /api/tasks/{id}/comments/{commentId}`. To edit or delete it, send `PATCH` with the same JSON body or `DELETE` to that URL. The original verified Home Assistant user or the original automation credential owns the comment. API reads require `tasks:read` and mutations require `tasks:write`. An administrator, a replacement credential with the same name, or a matching display name cannot claim another author's comment. Comments recorded without a verified owner, including existing comments and anonymous standalone comments, remain readable. If an edit or deletion returns 404, check the task and comment IDs and use the original account or credential.

If posting fails in the task panel, the text remains in the composer. Retry on that task after resolving the reported problem. Check that the task still exists and use an authenticated Home Assistant session or a credential with task-write scope. Check `api.comments.post.failed` for storage failures.

## Public link previews

`POST /api/unfurl` accepts JSON with a public HTTP or HTTPS URL of up to 2,048 characters. Use the final page address and keep credentials out of the URL. A private or special-purpose address, a host with any restricted DNS answer, and a redirect receive HTTP 400. Link previews connect using the validated DNS answers for that request.

The JSON body limit is 16 KiB. The App reads the first 256 KiB of decoded HTML and extracts metadata found there. A non-HTML page receives HTTP 415. The five-second deadline covers the incoming body, name resolution and response reading. If an upstream lookup or fetch times out, check the final address and public DNS resolution.

## Data Retention & Cleanup

User-initiated deletion of old completed/archived tasks via Settings → Danger Zone.

**API endpoints:**

- `GET /api/tasks/delete-completed?months=3|6|12|24` — preview count
- `DELETE /api/tasks/delete-completed?months=3|6|12|24&confirm=true` — execute

**Audit trail:**

Every retention delete is logged to `audit_trail` with event `retention-delete`, including the month threshold, cutoff date, and count of deleted tasks.

**Investigation:**

1. Query `audit_trail` for `request_id = 'retention-delete'` to see deletion history.
2. Check structured logs: `{service="meitheal",domain="tasks"} |= "retention-delete.success"`.
3. Cascaded data: each deletion removes associated `task_activity_log`, `comments`, and `task_links` rows inside a transaction.

**Safety:** Only tasks with `status IN ('complete', 'archived')` and `updated_at < cutoff` are affected. Active work is never touched.

### IndexedDB Offline Schema Upgrades

The client-side `offline-store.ts` uses an `onupgradeneeded` handler to manage IDB schema versions:

- **V1**: `tasks` store + `pending_sync` store
- **V2**: Adds `task_attachments` store (Phase 23) with `taskId` and `createdAt` indexes

The upgrade runs automatically when the browser opens the database with a higher version number. To force a schema reset:

1. Clear site data in browser DevTools → Application → Storage
2. Or delete the `meitheal-offline` database from IndexedDB directly

## Task Activation Conflicts

When `PUT` or `PATCH` reports `Cannot activate: task is blocked by open dependencies`, check the returned `blocked_by` list for the task keys and titles of up to five open prerequisites. Resolve those tasks or remove the corresponding links from the task detail panel before retrying. If more prerequisites remain, the next attempt returns the remaining open work. See the [task lifecycle glossary](task-lifecycle-glossary.md#activate-a-task-with-dependencies) for link directions and terminal statuses.

## Compatibility API transition

The first source release serves the native task and label APIs. An installation that depends on the earlier compatibility API can keep its existing deployment during migration. Before switching, create a backup and update each caller to use the [native API](agent-automation-guide.md) with a token for its tasks. The previous label IDs and colours remain available in the native app.

## Performance and Drift Gates

The `schema-drift` CI job validates migration SQL against runtime schema expectations.

The `perf-budgets` job and local `pnpm --filter @meitheal/web perf:budget` command read [the same thresholds](../../apps/web/scripts/perf-budget-baseline.json). Run the web build first. The check measures:

- Up to 1.5 MiB for Astro build assets and the service worker. The full public directory, including install screenshots and API specifications, is reported separately.
- Up to 256 MiB of web process RSS after five warmup writes. This is a single process measurement on the CI host.
- Up to 250 ms at p95 across 100 consecutive requests to `POST /api/tasks` against a fresh local SQLite database. Each timed sample includes reading and validating the response body. Output also includes p50, p99, maximum and the number of requests over the threshold.

Use the [Home Assistant publishing checklist](ha-publishing-checklist.md) for image size and actual Green qualification. The CI smoke measures a local production build.

For calibration, the check accepts these overrides.

- `MEITHEAL_PERF_BUDGET_CLIENT_BYTES_MAX`
- `MEITHEAL_PERF_BUDGET_RSS_KB_MAX`
- `MEITHEAL_PERF_BUDGET_P95_MS_MAX`
- `MEITHEAL_PERF_BUDGET_FILE`

## Label storage

The native Labels API and task views use the original label tables. Updates keep existing IDs, names, colours, and task links. After an upgrade, open a task that has a coloured label. Confirm the label still appears in the task and in the label picker.
