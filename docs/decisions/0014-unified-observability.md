# ADR-0014: Unified Observability Standard (Immutable Audit Ledger)

- **Status**: Accepted
- **Date**: 2026-03-19
- **Supersedes**: ADR-0011 (Task Activity Log)
- **Context**: Humans and agents co-working need forensic-grade observability. ADR-0011 covered basic field-change logging. This ADR extends it into a complete Immutable Audit Ledger with actor taxonomy, unified timeline, and Grafana-native dashboards.

## Decision

### Actor Taxonomy

Every log event and activity record carries structured actor context:

| `actor_type` | Examples |
|---|---|
| `human` | User actions in UI |
| `bot` | MCP agent, Copilot |
| `system` | Meitheal internal (recurrence, cascade) |
| `webhook` | External webhook trigger |
| `calendar_sync` | HA calendar/todo sync |
| `llm` | LLM tool call |

### Schema Evolution

`task_activity_log` extended with:

```sql
ALTER TABLE task_activity_log ADD COLUMN actor_type TEXT NOT NULL DEFAULT 'user';
ALTER TABLE task_activity_log ADD COLUMN event_type TEXT NOT NULL DEFAULT 'field_change';
ALTER TABLE task_activity_log ADD COLUMN summary TEXT;
ALTER TABLE task_activity_log ADD COLUMN correlation_id TEXT;
CREATE INDEX activity_log_event_type_idx ON task_activity_log(event_type);
CREATE INDEX activity_log_actor_type_idx ON task_activity_log(actor_type);
```

### Event Types (Discriminated)

`field_change` · `status_change` · `created` · `deleted` · `comment` · `delegated` · `proposal` · `sync` · `assigned` · `label_change`

### Domain Logger

`@meitheal/domain-observability` extended with:
- `ActorType` union type
- `Actor` interface (`id`, `type`, `name?`)
- `LogEvent` gains `actor`, `actor_type`, `entity_id`, `entity_type`, `correlation_id`
- `timeline()` convenience method for immutable audit events

### Unified Timeline API

`GET /api/tasks/[id]/timeline` — merges `task_activity_log` + `comments` into a single chronological feed.

- Supports `?event_type=` and `?actor_type=` filters
- Returns `{ events, total, limit, offset }`
- Existing `GET /api/tasks/[id]/activity` preserved for backward compatibility

### Grafana Dashboards

| Dashboard | UID | Purpose |
|---|---|---|
| Audit Trail | `meitheal-audit-trail` | Chronological event stream, actor breakdown, bot activity |
| System Overview | `meitheal-system-overview` | Error rates, p95 latency, domain breakdown, health stats |

### Alloy Config

`config.river` updated to extract `actor_type` as a Loki label (low-cardinality, efficient filtering) and `entity_type` from JSON log bodies.

## Trade-offs

- `actor_type` as a Loki label adds one label dimension — acceptable given the 6-value enum (low cardinality)
- Unified timeline uses UNION ALL with comments table — slightly more expensive than separate queries but provides the key "Glass Box" UX
- Fire-and-forget pattern preserved — audit writes don't block API responses
- Migration uses `ALTER TABLE ADD COLUMN` with defaults — zero-downtime compatible with SQLite

## Consequences

- Every task action is attributed to a specific actor type
- Humans can see exactly "who did what" in a GitHub-style timeline
- Bot actions are separately filterable in both UI and Grafana
- Correlation IDs enable end-to-end tracing across n8n workflows and agent actions
- Foundation for future: real-time timeline via SSE, additional event types as features ship
