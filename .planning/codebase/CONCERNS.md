# Concerns — Meitheal

**Mapped:** 2026-03-21 | **Confidence:** HIGH

## Uncommitted Changes (CRITICAL)

**10 files with 874 lines of uncommitted changes** spanning multiple conversations:

| File | Lines Changed | Source |
|------|---------------|--------|
| `pillar-service.ts` | +94 | Phase 19 — slug support |
| `principle-service.ts` | +24 | Phase 19 — batch fetch |
| `progress.astro` | +429/-118 | Phase 18/19 — inline pillar data |
| `planning.astro` | +77/-77 | Phase 18 — refactored layout |
| `19-CONTEXT.md` | +13/-3 | Phase 19 — user decisions |
| `timeline-controller.ts` | +235 (mixed) | Gantt conversation |
| `timeline-gantt.css` | +123 | Gantt conversation |
| `TasksTimelineView.astro` | +33 | Gantt conversation |
| `_parent-page.css` | +32 | Phase 18 |
| `parent-page-controller.ts` | +23 | Phase 18 |

> [!WARNING]
> These changes span 3 different conversations. They should be committed in logical groups before further work.

## Build Warnings (30)

`astro check` reports 30 errors (exit code 0 — warnings, not blockers):
- Unused imports in `projects/[id].astro` (`PRIORITY_ICONS`, `PRIORITY_COLORS`, `t`)
- `define:vars` script attribute hint (use `is:inline` to silence)
- Pre-existing type warnings across the codebase

## Technical Debt

### High Priority
| Issue | Location | Impact |
|-------|----------|--------|
| **Old search bar duplication** | `Layout.astro` / `TopNavigation.astro` | Visual duplication on some pages |
| **Pillar URLs use auto-generated IDs** | `/pillars/pillar_1774108575198_z5rmii` | Ugly, non-shareable URLs |
| **N+1 principle queries** | `progress.astro` | Fetches principles per pillar in loop |
| **`[id].astro` route not renamed** | `apps/web/src/pages/pillars/[id].astro` | Phase 19 work item |

### Medium Priority
| Issue | Location | Impact |
|-------|----------|--------|
| Unused `PRIORITY_ICONS` import | `projects/[id].astro` | Build warning |
| Unused `t` import | `projects/[id].astro` | Build warning |
| `define:vars` without `is:inline` | Multiple templates | Build hints |
| Mixed Drizzle + raw SQL patterns | Various domains | Inconsistent data access |

### Low Priority
| Issue | Location | Impact |
|-------|----------|--------|
| No formal test coverage tooling | `tests/` | Hard to track coverage gaps |
| i18n only 2 locales (en, ga) | `i18n/` | Limited internationalization |

## Security Considerations

| Area | Status | Notes |
|------|--------|-------|
| CSRF protection | ✅ Active | `domain-auth` middleware |
| Rate limiting | ✅ Active | Per-IP in middleware |
| CSP headers | ✅ Active | Set in middleware |
| HTML sanitization | ✅ Active | `sanitize-html` on server |
| License key (Ed25519) | ✅ Active | Offline JWT, no phone-home |
| `.keys/` directory | ✅ Gitignored | Private key never committed |
| Secret scanning | ⚠️ Manual | No automated pre-commit hook |
| Input validation | ✅ Zod | API routes use Zod schemas |

## Performance Considerations

| Area | Status | Notes |
|------|--------|-------|
| Bundle size | ⚠️ Watch | 23 CSS modules, 90+ controllers |
| N+1 queries | ⚠️ Active | Principles per pillar (Phase 19 fix exists in uncommitted code) |
| Font loading | ✅ Optimized | Fontsource variable fonts + relative path fix |
| SSR | ✅ Active | All pages server-rendered |
| Pre-bundling | ✅ Configured | `marked` in Vite optimizeDeps |

## Fragile Areas

| Area | Risk | Why |
|------|------|-----|
| **Ingress rewriting** | HIGH | Triple-layer: `serve.mjs` → middleware → Layout monkey-patch. Any layer failing = broken navigation |
| **`serve.mjs` → Astro pipeline** | MEDIUM | Custom HTTP wrapper adds complexity to request lifecycle |
| **Layout.astro** | MEDIUM | Single massive layout file with conditional rendering, fetch monkey-patching, and script injection |
| **Parent page controller** | MEDIUM | Hash-based routing with `pushState`/`popstate` — complex state management |
| **Calendar/CalDAV sync** | MEDIUM | External service dependency with credential management |
