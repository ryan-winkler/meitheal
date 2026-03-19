# Operations Runbook

## Logging Pipeline Health

1. Confirm app emits JSON logs to stdout.
2. Confirm Alloy can read journal stream.
3. Confirm Loki receives labeled streams.
4. Confirm Grafana dashboards resolve data source.

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
