# Managed backup hooks

Home Assistant and the Supervisor scripts call `POST /api/backup/prepare`
before snapshotting Meitheal's data. The route awaits schema readiness and runs
`PRAGMA wal_checkpoint(TRUNCATE)`. It returns `ok:true` only after SQLite
confirms a non-busy, fully checkpointed result. Busy, incomplete, invalid or
failed checkpoints return 503 with `ok:false`; callers must keep the database
and its WAL together in the snapshot rather than treating failure as a flush.

Preparation does not pause database writes, acquire a long-lived lock or create
a backup file. Later writes may produce new WAL frames. The configured hot
backup must capture the database/WAL together; a checkpoint alone is not a
database-only snapshot guarantee. `POST /api/backup/complete` is an idempotent
acknowledgement reporting `writes_paused:false`, not an unlock operation.

Explicit agent credentials require `settings:write`, including when a local
caller also supplies them. Household ingress users cannot bypass this rule.
The internal native-hook exception accepts only the immediate loopback peer or
the HA Core bridge address 172.30.32.1, without user-identity headers. Ingress
peer 172.30.32.2 and forwarded addresses do not qualify. `serve.mjs` overwrites
the internal peer header from its actual socket and sets a server-private
marker; bare Astro never trusts a supplied peer header. These lifecycle hooks
are documented in OpenAPI but excluded from MCP tool discovery.

If preparation returns 503, inspect the structured `backup.checkpoint.failed`
event and retry after long transactions finish. Do not delete a WAL to force a
checkpoint. Completion can safely be retried. Keep the HA console guard before
init when opening the canonical development environment for Tier 2 validation;
local SQLite tests do not replace actual HA/Supervisor acceptance.
