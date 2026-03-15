# Coding Conventions

> Last refreshed: 2026-03-15

## File Naming

| Type | Convention | Example |
|---|---|---|
| Files | kebab-case | `task-sync-service.ts`, `ha-connection.ts` |
| CSS partials | underscore prefix | `_kanban.css`, `_tokens.css` |
| Test specs | `*.spec.ts` | `ha-calendar-adapter.spec.ts` |
| Components | PascalCase | `TaskTypeIcon.astro`, `NewTaskModal.astro` |

## Code Style

| Rule | Standard |
|---|---|
| Semicolons | None |
| Quotes | Double |
| Indent | 2 spaces |
| Exports | Named only — no default exports |
| Max line | Not enforced, but ~120 chars recommended |

## Import Order

1. Node builtins (`node:fs`, `node:path`)
2. Framework (`astro`, `@astrojs/*`)
3. External packages (`date-fns`, `zod`, `marked`)
4. Workspace packages (`@meitheal/domain-tasks`, `@meitheal/integration-core`)
5. Relative imports (`./`, `../`)

**Path aliases:**
- `@domains/` → `apps/web/src/domains/`

## Naming Conventions

| Category | Convention | Example |
|---|---|---|
| Functions | camelCase | `createTask()`, `resolveIngressContext()` |
| Types/Interfaces | PascalCase | `TaskAggregate`, `CalendarSyncState` |
| Constants | UPPER_SNAKE | `RATE_LIMIT`, `MAX_RATE_ENTRIES` |
| CSS tokens | kebab-case with `--` prefix | `--bg-primary`, `--accent` |
| HTML IDs | kebab-case with context prefix | `td-title`, `td-status`, `cp-search` |

## Error Handling

### API Routes

Discriminated unions pattern:
```typescript
// Success
return new Response(JSON.stringify({ ok: true, data: result }))

// Error
return new Response(JSON.stringify({ ok: false, errorCode: "NOT_FOUND" }), { status: 404 })
```

### Client-side

`safe-fetch.ts` wraps all API calls with error handling and toast notifications.

## Patterns

### Repository Pattern

All database access goes through typed repositories in `domains/tasks/persistence/`:
```typescript
const repo = new TaskRepository(getPersistenceClient())
const tasks = await repo.getRecentTasks(10)
```

### Singleton Services

Database client, HA connection, and logger all use lazy-initialized singletons:
```typescript
let clientSingleton: Client | null = null
function getClient(): Client {
  if (clientSingleton) return clientSingleton
  clientSingleton = createClient({ url: resolveDbUrl() })
  return clientSingleton
}
```

### Controller Pattern

Client-side view controllers initialize in `<script>` blocks within Astro pages:
```astro
<script>
  import { initKanbanBoard } from "../lib/kanban-controller"
  document.addEventListener("DOMContentLoaded", () => initKanbanBoard())
</script>
```

### CSS Architecture

Partials imported via `global.css`:
```css
@import "./_tokens.css";
@import "./_base.css";
@import "./_layout.css";
/* ... all 18 partials */
```

Design tokens in `_tokens.css` define CSS custom properties consumed by all partials.

Tailwind v4 utility classes coexist with custom CSS partials.

### Logging

Single JSON object per line to stdout (Loki-compatible):
```json
{ "ts": "...", "level": "info", "event": "task_created", "domain": "tasks", "component": "api", "message": "..." }
```

Secrets auto-redacted via `defaultRedactionPatterns` in `@meitheal/domain-observability`.

### Validation

Zod schemas for API input validation. Raw SQL parameterized queries for database access.
