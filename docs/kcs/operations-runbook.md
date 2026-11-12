# Operations Runbook

## Logging Pipeline Health

1. Confirm app emits JSON logs to stdout.
2. Confirm Alloy can read journal stream.
3. Confirm Loki receives labeled streams.
4. Confirm Grafana dashboards resolve data source.

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
2. Confirm the Kanban URL can move between:

- `#kanban-overview`
- `#kanban-lanes`
- `#kanban-fields`
- `#kanban-flow`

3. Confirm the shell search launcher opens SearchHub and `#ask-ha-btn` is still present.
4. Confirm `Manage Lanes` still opens the lane-management surface.
5. Confirm `TaskViewTabs` preserve the current query string when switching routes.

## Table Shell Verification

Use this after changing the Table shell or `table-controller.ts`.

1. Run `E2E_BASE_URL=http://127.0.0.1:4321 pnpm --filter @meitheal/tests test tests/e2e/table-shell.spec.ts`.
2. Confirm the Table URL can move between:

- `#table-overview`
- `#table-filters`
- `#table-fields`
- `#table-flow`

3. Confirm the shell search launcher opens SearchHub and `#ask-ha-btn` is still present.
4. Confirm the shell `New Task` button opens the shared task modal.
5. Confirm clicking a table row still opens the shared task detail surface.

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

## Database Migrations

Primary command path:

1. `pnpm --filter @meitheal/web db:migrate`
2. Verify applied migrations table `__meitheal_migrations`.
3. Confirm task-sync tables exist and are queryable.

CI gate:

1. `migration-check` job runs `db:migrate:check`.
2. If pending migrations exist, CI fails closed.

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

## Vikunja Compatibility Mode

1. Configure one of:

- `MEITHEAL_VIKUNJA_API_TOKEN`
- `MEITHEAL_VIKUNJA_API_TOKENS`

2. Use `/api/v1/*` routes for voice assistant interop.
2. Calendar behavior for compat task create:

- `compatibility.vikunja_api.calendar_sync_mode: disabled` (default)
- `compatibility.vikunja_api.calendar_sync_mode: enabled` (optional)

4. Optional env override for validation/probing:

- `MEITHEAL_COMPAT_CALENDAR_SYNC_MODE=enabled|disabled`

5. Live compatibility verifier options:

- local/manual: `tests/scripts/verify_vikunja_voice_assistant_compat.py`
- GitHub Actions: `Live Vikunja Voice Assistant Compatibility` workflow (`.github/workflows/live-vikunja-voice-assistant.yml`)

## Performance and Drift Gates

1. `schema-drift` CI job validates migration SQL against runtime schema expectations.
2. `perf-budgets` CI job enforces (GitHub Actions calibrated profile):

- client bundle total <= 64 KB
- web process RSS <= 160 MB after warm start
- task create p95 <= 150 ms in harness

3. Budget source is `apps/web/scripts/perf-budget-baseline.json`, calibrated from GitHub runner measurements.
2. Outside GitHub Actions, default local thresholds remain conservative:

- client bundle total <= 80 KB
- web process RSS <= 220 MB
- task create p95 <= 250 ms

5. Optional overrides for calibration windows:

- `MEITHEAL_PERF_BUDGET_CLIENT_BYTES_MAX`
- `MEITHEAL_PERF_BUDGET_RSS_KB_MAX`
- `MEITHEAL_PERF_BUDGET_P95_MS_MAX`
- `MEITHEAL_PERF_BUDGET_FILE`

6. Home Assistant publishing readiness checklist: `docs/kcs/ha-publishing-checklist.md`.

## Local image builds

From the repository root, run:

```bash
npm run build:image -- --tag localhost/meitheal:dev
```

The equivalent pnpm command is `pnpm run build:image --tag localhost/meitheal:dev`.
Both use the add-on Dockerfile and repository build context. Additional arguments
are passed to `podman build`. This builds a local image; it does not publish or
replace a running add-on.

When the host provides `meitheal-build`, the command selects that host's guarded
build storage automatically. A launcher failure stops the build. Otherwise it
uses the host's normal Podman configuration. Keep existing container lifecycle
commands on the store where those containers were created.

## Privileged development-container console

Mask the guest getty units before starting init in a privileged development
container. Use the absolute /usr/bin/systemctl path, since a base-image wrapper
can bypass service changes. Keep this command in local Compose overrides that
replace the development-container startup command.

## Contributor agreement automation

The CLA action is pinned to the verified upstream v2.6.1 commit rather than an
unpublished major-version alias. Local signature storage needs contents write
permission; the agreement link is the full repository document URL. Comment
triggers accept only the configured signature or recheck text on pull requests.
The privileged workflow does not check out or execute contributor source.

## Client asset budget

Self-hosted fonts use WOFF2, including JetBrains Mono400/500, consistent with the
other shipped families and supported Home Assistant browsers. Duplicate legacy
WOFF files are not bundled. The existing client-byte, memory and latency budgets
remain unchanged; run the build and perf:budget command to verify output.

The performance harness owns its temporary server process and waits for it to
close after every measurement, including failures. It first sends SIGTERM and
escalates to SIGKILL after two seconds if application shutdown handlers leave
the listener running. Unused server output is ignored to avoid pipe backpressure;
the harness still prints the measured result and returns a nonzero exit status
when any budget fails. A printed passing result is complete once the command exits.

## Dependency security gate

Run unsuppressed pnpm audit with the frozen lockfile; all CI audit severities
must pass. The patched Astro7.3 line and matching Node adapter preserve the
Node>=22.12 baseline. Keep the declared bounded version range until a deliberate
validated upgrade, and do not restore unused MDX or unpatched dependency chains.
After upgrades, run the full tests/build/typecheck, performance budgets and
relevant local/HA runtime checks. Older framework receipts are not evidence of
an exact upgraded runtime.
