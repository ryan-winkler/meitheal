# Conventions — Meitheal

**Mapped:** 2026-03-21 | **Confidence:** HIGH

## Code Style

| Rule | Convention |
|------|-----------|
| Semicolons | None |
| Quotes | Double (`"`) |
| Indent | 2 spaces |
| Trailing commas | Yes (ES5) |
| Exports | Named only — no `default` exports |
| Line endings | LF |

## Naming

| Type | Convention | Example |
|------|-----------|---------|
| Files | kebab-case | `pillar-service.ts`, `ha-connection.ts` |
| Functions | camelCase | `createPillar()`, `getPillarBySlug()` |
| Types/Interfaces | PascalCase | `Pillar`, `TaskAggregate`, `CalendarSyncState` |
| CSS classes | kebab-case | `.pillar-card`, `.unified-bar` |
| CSS variables | `--kebab-case` | `--color-primary`, `--radius-md` |
| API routes | kebab-case directories | `/api/pillars/[id]/principles` |
| Test specs | `name.spec.ts` | `pillars.spec.ts` |
| Controllers | `*-controller.ts` | `kanban-controller.ts` |
| Registries | `*-registry.ts` | `settings-registry.ts` |

## Import Order

1. Node builtins (`node:fs`, `node:path`)
2. Framework (`astro`)
3. External (`date-fns`, `zod`)
4. Workspace (`@meitheal/domain-tasks`)
5. Relative (`./`)

Path alias: `@domains/` → `apps/web/src/domains/`

## API Response Pattern

All API routes use discriminated unions:

```typescript
// Success
return new Response(JSON.stringify({ ok: true, data: result }))

// Error
return new Response(JSON.stringify({ ok: false, errorCode: "NOT_FOUND" }), { status: 404 })
```

## Component Patterns

### Astro Components
- Server-side rendered Astro components (`.astro`)
- Client-side behavior via external `*-controller.ts` files
- No framework components (React/Vue/Svelte) — vanilla JS only
- `pageLifecycle.onLoad()` for controller initialization

### Controller Pattern
```typescript
// lib/some-controller.ts
import { pageLifecycle } from "./page-lifecycle"

function init() {
  const el = document.getElementById("my-element")
  if (!el) return
  // Setup...
}

pageLifecycle.onLoad(init)
```

### Managed Listeners
```typescript
import { createListenerManager } from "./managed-listeners"

function init() {
  const listeners = createListenerManager()
  listeners.add(el, "click", handler)
  // Auto-cleanup on page unload
}
```

## Error Handling

| Context | Pattern |
|---------|---------|
| API routes | Try/catch → `{ ok: false, errorCode }` response |
| Domain services | `try { } catch { /* column already exists */ }` for migrations |
| Client controllers | Silent return on missing DOM elements (`if (!el) return`) |
| Schema ensure | Idempotent `CREATE TABLE IF NOT EXISTS`, `ALTER TABLE ADD COLUMN` with catch |

## ID Generation

```typescript
function generateId(): string {
  return `entity_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}
```

Pattern used across all domains: `pillar_`, `task_`, `principle_`, etc.

## Persistence Pattern

Each domain service follows:
1. `ensureSchema()` — Idempotent schema creation + migrations
2. `schemaEnsured` boolean flag — Skip redundant calls
3. Raw SQL via `getPersistenceClient()` — Not Drizzle query builder
4. `toEntity(row)` — Row mapper function

## CSS Architecture

- CSS custom properties (tokens) in `_tokens.css`
- Modular CSS files with `_` prefix
- All imported via `global.css` using `@import`
- Tailwind v4 available but primary styling is custom CSS
- No CSS-in-JS

## Commit Messages

```
emoji type(scope): description

Co-authored-by: ryan-winkler <ryan-winkler@users.noreply.github.com>
```

Common prefixes:
- `✨` feat — New feature
- `🐛` fix — Bug fix
- `📋` docs — Documentation
- `🧹` chore — Cleanup
- `♿` a11y — Accessibility
- `🐤` canary — Canary version bump
