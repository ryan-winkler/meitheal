# Backend operation results

## Completion and integration contracts

A successful response means the requested supported operation completed. An
unavailable integration, rejected write, skipped calendar, or unsupported
protocol must not be presented as an empty successful result.

- Manual calendar sync returns `ok: false` and HTTP 502 if any selected calendar
  fails or is skipped. `partial` distinguishes mixed outcomes; counts include
  successful calendars only. A connected calendar with no events remains a
  successful zero-count result. Inspect `failures`, integration status and
  server logs before retrying. Export-only, already-running and failure-backoff
  calendars are identified as skipped. A merge can have written some events
  before failing; retry uses existing event deduplication.
- `/api/health` GET is readiness: failed SQLite integrity means `degraded`,
  `db_integrity: failed` and HTTP 503 even when SQL connectivity works. HEAD
  remains process/database liveness; use GET for readiness monitoring. Preserve
  the database and backups before following the operations recovery runbook.
- A2A supports scoped synchronous task-title search, without fabricated background
  execution or task tracking. MCP gates its dynamic inventory and calls; WebMCP
  registers read-only browser tools where supported and unregisters on disable.
  See [protocol setup](webmcp-a2a-setup.md).
- Proposal-only tokens can claim and submit title/description edits for a Home
  Assistant administrator's review. Acceptance checks the reviewed proposal and
  unchanged task content. Fixed lease/review windows apply; there is no auto-accept.
  AI-scope values are advisory context, not operation permissions. See
  [task approvals](agent-task-approvals.md).
- Passkeys are unavailable. Production auth exports no mock verifier. Existing
  Home Assistant ingress and agent-token authentication remain the supported
  surfaces.

## Home Assistant connection

Credential precedence is Supervisor token, a complete saved `ha_url`/`ha_token`
pair, then `HA_BASE_URL`/`HA_TOKEN` environment configuration. A saved partial
pair does not override complete environment credentials. URLs must use HTTP or
HTTPS and may not contain embedded credentials, query strings or fragments.

Saving a complete standalone pair applies on the next connection operation.
Changing the resolved configuration replaces the authenticated WebSocket and
rebinds entity subscriptions. An incomplete or invalid configuration does not
claim a connection. Test through Settings and `/api/ha/connection`; connection
status does not include tokens or credential fingerprints. Supervisor mode
always retains Supervisor credentials. Validate HA changes in the Tier 2
Home Assistant devcontainer before deployment; local protocol fixtures do not
constitute Tier 2 acceptance.

## NFC, ordering and goal progress

1. Assign a tag with `PUT /api/tasks/{id}` and `nfc_tag_id` as a nonempty string
   of at most 255 characters; use `null` to remove the assignment.
2. Send `POST /api/nfc/complete` with `{ "tag_id": "your-tag" }`. It uses the
   ordinary task completion path. Unknown tags return 404; ambiguous duplicate
   assignments return 409 without completing a task. An already completed task
   returns `already_complete: true` without repeating completion side effects.
   The NFC feature flag applies, and agent tokens need `tasks:write`.
3. Task listing supports `sort=kanban_position&order=asc`, with null positions
   last and ID as a deterministic tie-break for pagination. Reorder through the
   existing `/api/tasks/reorder` operation.
4. `PUT /api/goals/{id}` accepts finite numeric `progress` from 0 through 100.
   It scales `metric_current` against an existing positive target. A targetless
   goal receives percentage tracking with target 100. GET list/detail returns
   computed bounded progress; invalid percentages do not modify the goal.

Completion statistics are recorded on an actual incomplete-to-complete task
update, including REST, MCP, HA and NFC callers. Repeated complete updates do
not award another completion. Concurrent status writes use a comparison against
the previously read status; a conflict returns 409 for reload/retry. Completion
history is historical: reopening a task does not erase an earned event.
Browser celebrations consume the authoritative task update gamification result; the old arbitrary
`POST /api/gamification` counter increment returns 410. A statistics failure is
reported separately from the successfully saved task.

## Logging runbook

`MEITHEAL_LOG_LEVEL` applies to application loggers and
`MEITHEAL_AUDIT_ENABLED=false` disables audit emission. Existing logger category
choices apply to application categories; audit is controlled separately by the audit option and still respects the minimum level. `MEITHEAL_LOG_CATEGORIES` uses a comma-separated allowlist
from the add-on category option (empty means no category filter). Secret redaction is mandatory, including structured
metadata; `log_redaction=false` cannot disable it. Stdout remains the canonical
JSON log stream. Optional `loki_url` (exported as `LOKI_URL`) is the complete
HTTP(S) Loki push endpoint, for example `http://loki:3100/loki/api/v1/push`.
Leave it empty to disable network forwarding. URLs with embedded credentials
are rejected; this minimal sink does not configure authentication or tenants.

The native sink shares one in-memory queue across application loggers: up to
200 waiting lines, 50 lines per request, a 250 ms flush delay, and one request
at a time with a 1 second timeout. Lines over 16 KiB and new lines beyond the
queue limit remain on stdout but are dropped from forwarding. The same
redacted JSON line is sent with only static `service` and `env` labels and
nanosecond timestamps encoded as strings. No task IDs, URLs or user IDs become
labels. Redirects are rejected. Failed requests are dropped without retries;
later batches continue. Failure diagnostics go directly to stderr at most once
per minute, without including the endpoint or receiver response. Timers do not
keep the process alive; queued telemetry can be lost on exit.

No Alloy sidecar is required. The startup `logging.loki.configured` message
reports configuration only. Confirm actual ingestion in the Loki receiver;
`logging.loki.delivery_failed` indicates rejected, unavailable, invalid or
over-capacity forwarding. Preserve stdout collection while troubleshooting.
Validate add-on startup changes in Tier 2 before release.

## Canary component installation

The add-on identifies bundled Python source by a content hash, rather than only
its manifest version. A changed package updates the managed component files and
removes the retired package stubs. The `component.updated` message requests a
Home Assistant restart to load changed Python modules; an add-on restart alone
does not claim that already imported HA code was reloaded. An unchanged package
does not recopy the integration. Health and agent-card versions use the actual
Supervisor-installed add-on version, with the source release value as fallback.

MCP does not advertise the former `getEntityState` helper: it called a calendar
endpoint and had no supported entity-state implementation. Calls to that tool
return an explicit unknown-tool error. Use the documented HA integration tools
for supported household operations.

Schema bootstrap is shared across concurrent startup requests and background
checks. A failed bootstrap can retry; callers must await it before reading or
writing the fresh database.

Generated task-list contracts use native sort column names (`created_at`,
`updated_at`) and the `{tasks,total,limit,offset}` pagination envelope. Calendar
sync tools require an explicit action: `sync`, `enable`, or `disable`; a manual
sync is not an empty request. Discovery tests execute these native shapes.
