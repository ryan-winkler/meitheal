# Concerns & Technical Debt

> Last refreshed: 2026-03-15

## Critical Concerns

### 1. Monolithic Layout.astro (1255 lines)

`Layout.astro` is the app's single layout file containing:
- Global sidebar
- Task detail modal (two-column layout with all properties)
- Command palette
- All client-side script initialization
- Fetch monkey-patching for ingress

**Risk**: Any change to the task modal, sidebar, or command palette touches this massive file. High merge conflict probability.

**Recommendation**: Extract task detail modal and command palette into standalone Astro components.

### 2. Oversized Client Controllers

| Controller | Lines | Concern |
|---|---|---|
| `settings-controller.ts` | 3205 | Single file managing all settings tabs |
| `task-modal-controller.ts` | 2417 | Monolithic modal state management |
| `kanban-controller.ts` | 2019 | Drag/drop + lanes + rendering in one file |
| `table-controller.ts` | 1336 | Table sorting/filtering/rendering |

**Risk**: Hard to reason about, test, or modify incrementally. Each is a God Object.

**Recommendation**: Split per-concern (e.g., `kanban-drag.ts`, `kanban-lanes.ts`, `kanban-render.ts`).

### 3. Inline SQL in TaskRepository

`TaskRepository` uses raw SQL strings (not Drizzle typed queries) for most operations. While parameterized, they bypass Drizzle's type safety and schema validation.

**Risk**: Schema drift undetected until runtime. No compile-time column validation.

**Recommendation**: Migrate critical queries to Drizzle's query builder for type safety.

## Architecture Debt

### 4. CSS Dual System

The codebase uses **both** Tailwind v4 utility classes AND custom CSS partials (18 files). The boundary is unclear — some components use Tailwind, others use custom classes, many use both.

**Risk**: Style conflicts, maintenance confusion, inconsistent design system.

### 5. Vikunja Compatibility Layer

`api/v1/` routes maintain backward compatibility with Vikunja's API format. This adds maintenance burden for a legacy concern.

**Risk**: Dead code if no Vikunja clients are actively used. Adds API surface to secure.

### 6. Domain Boundary Violations

Some files in `lib/` directly import from `domains/` bypassing package boundaries. The `@domains/` alias makes cross-domain imports easy but hard to track.

## Performance Concerns

### 7. No Client-Side Bundling Strategy

All `<script>` blocks in Astro pages compile to individual JS files. No shared chunks for common utilities (toast, filter engine, safe-fetch).

**Risk**: Duplicate code across page bundles. Each view page re-bundles shared utilities.

### 8. Large Modal DOM

The task detail modal in `Layout.astro` renders ~400 lines of HTML with all properties, even when the modal is hidden. This DOM is present on every page.

**Risk**: Unnecessary initial DOM weight. Memory pressure from hidden interactive elements.

## Security Considerations

### 9. Dependency Overrides

Five packages have version overrides in root `package.json` for security:
- `lodash` >=4.17.23
- `svgo` >=4.0.1  
- `undici` >=7.24.3
- `devalue` >=5.6.4
- `esbuild` >=0.25.0

**Action**: Monitor Dependabot for new advisories. Some overrides may be stale.

### 10. Rate Limiter Memory

The in-memory rate limiter in `middleware.ts` caps at 10,000 entries (~800KB). Under sustained attack from many unique IPs, this could grow before eviction kicks in.

## Testing Gaps

### 11. Unit Test Coverage

Only 1 unit test exists (`todo-status-mapper.spec.ts`). All other testing is E2E via Playwright. Domain logic in packages/ has no unit tests.

**Risk**: Slow feedback loop. E2E tests can't isolate domain logic regressions.

### 12. No Visual Regression Testing

No screenshot comparison testing. UI changes are verified manually or via browser subagent screenshots (ephemeral, not tracked).

## Documentation Debt

### 13. Stale Theme Settings Failures

Test results in `tests/test-results/` show persistent `e2e-theme-settings` failures with error-context.md files. These may indicate flaky tests or genuine regressions.

## Deferred Items

### 14. Gantt View

`gantt.astro` exists but functionality maturity is unclear.

### 15. Offline Sync Engine

Full offline support exists (`domains/offline/`) with IndexedDB store, sync engine, tab sync, and service worker registration. Maturity and edge case handling need verification.

### 16. Gamification System

Achievement engine and streak tracker exist but integration depth with core task flow is uncertain.
