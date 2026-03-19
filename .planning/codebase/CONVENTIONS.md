# Codebase Conventions — Meitheal

> Last refreshed: 2026-03-19

## Naming

| Category | Convention | Example |
|----------|-----------|---------|
| Files | kebab-case | `task-sync-service.ts`, `page-shell-controller.ts` |
| Functions | camelCase | `createTask()`, `initPageShellNavigation()` |
| Types/Interfaces | PascalCase | `TaskAggregate`, `CalendarSyncState` |
| Test specs | `<name>.spec.ts` | `ha-calendar-adapter.spec.ts` |
| CSS classes | BEM-like with page prefix | `.today-shell__clear-btn`, `.eisenhower__header` |
| Custom events | namespaced | `meitheal:new-task`, `meitheal:toggle-search` |
| Section data attrs | page-prefixed | `data-today-section`, `data-calendar-section` |

## Code Style

- No semicolons
- Double quotes
- 2-space indent
- Named exports only — no default exports
- Import order: Node builtins → Framework → External → Workspace → Relative

## Path Aliases

```json
{
  "@domains/*": "src/domains/*",
  "@lib/*": "src/lib/*",
  "@i18n/*": "src/i18n/*"
}
```

## API Result Pattern

Discriminated unions for all API results:
```typescript
{ ok: true, data: T } | { ok: false, errorCode: string }
```

## Controller Pattern

Every page has a controller in `lib/`:
1. Controller exports an `init{PageName}Page()` function
2. Function calls `initPageShellNavigation()` from `page-shell-controller.ts`
3. Shell navigation receives: `barId`, `shellId`, `sectionSelector`, `sections` registry
4. Page script block calls controller on `astro:page-load`

```typescript
// Pattern in each page's <script>
import { initTodayPage } from "../lib/today-controller"
document.addEventListener("astro:page-load", () => initTodayPage())
```

**Exception:** `eisenhower-controller.ts` does NOT follow this pattern.

## Section Registry Pattern

Each page defines sections in a `*-registry.ts` file:
```typescript
export const TODAY_SECTIONS = [
  { id: "overview", label: "Overview" },
  { id: "tasks", label: "Tasks" },
  { id: "flow", label: "Flow" },
] as const
```

Registries are consumed by exactly 2 files:
1. The `.astro` page (for rendering tabs/anchors)
2. The controller (for section navigation logic)

## Component Patterns

### UnifiedBar Integration
Pages use `<UnifiedBar>` via Layout slot:
```astro
<UnifiedBar
  barId="today-bar"
  pageTitle="Today"
  sections={TODAY_SECTIONS}
  slot="custom-header"
>
  <!-- Optional custom actions via slot -->
</UnifiedBar>
```

### Lifecycle Management
- `pageLifecycle` from `lib/page-lifecycle.ts` manages init/cleanup
- `managed-listeners.ts` provides `createListenerManager()` + `installPageCleanup()`
- All event listeners must be cleaned up via these utilities

### Event Communication
Custom events for cross-component communication:
- `meitheal:new-task` — open new task modal
- `meitheal:toggle-search` — open search hub
- `meitheal:task-updated` — task CRUD notification
- `meitheal:toast` — show toast notification

## Error Handling

- API routes return discriminated unions (ok/error)
- Client-side: `showToast()` for user-visible errors
- Server-side: structured JSON logging via `domain-observability`
- Redact secrets by default via `defaultRedactionPatterns`

## Commit Messages

- Descriptive messages, never generic
- `Co-authored-by: ryan-winkler <...>` trailer for AI-generated commits
- PRs opened by AI squash-merged under human identity
