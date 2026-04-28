# Concerns — Meitheal

**Mapped:** 2026-04-28 | **Confidence:** HIGH

## Resolved Since Last Map (2026-03-21)

| Former Concern | Resolution |
|----------------|------------|
| 10 files with 874 lines of uncommitted changes | All committed across Phases 26-30 |
| Pillar URLs use auto-generated IDs | Phase 19 delivered slug-based URLs |
| N+1 principle queries in `progress.astro` | Phase 19 batch fetch fix committed |
| `transition: all` performance concerns | Phase 30 eliminated all instances (0 remaining) |
| Old search bar duplication | Phase 09 `hideGlobalSearch` prop on ParentPageShell pages |
| `[id].astro` route not renamed | Slug-based routing handles this |

## Build Health

- `pnpm check` passes (exit 0) as of 2026-04-28
- `pnpm run build` passes (Server built in 6.68s) as of 2026-04-28
- Vite externalization warnings (util, crypto, fs, path, async_hooks) — expected, not errors
- `domain-auth` had missing `@types/node` — fixed 2026-04-28

## Technical Debt

### High Priority

| Issue | Location | Impact |
|-------|----------|--------|
| **Five Tier-2 verification gates open** | SET-08, SET-12, SHELL-33, STM-15, Phase 09 | Cannot ship without HA devcontainer verification |
| **Version frozen at `0.0.1`** | `meitheal-hub/config.yaml`, `apps/web/package.json` | No release cadence, canary drift |
| **`Layout.astro` is a God file** | `apps/web/src/layouts/Layout.astro` | Fetch monkey-patching, conditional rendering, script injection in one file |
| **No `CHANGELOG.md`** | Root | Users can't see what changed |
| **No `CONTRIBUTING.md`** | Root | External contributors have no guide |

### Medium Priority

| Issue | Location | Impact |
|-------|----------|--------|
| Mixed Drizzle + raw SQL patterns | Various domains | Inconsistent data access |
| `define:vars` without `is:inline` | Multiple templates | Build hints (not errors) |
| No formal test coverage tooling | `tests/` | Hard to track coverage gaps |
| Canary version stuck at `154f292` | `meitheal-hub-canary/config.yaml` | Auto-resolves on next push to main |

### Low Priority

| Issue | Location | Impact |
|-------|----------|--------|
| i18n only 2 locales (en, ga) | `i18n/` | Limited internationalization |
| No design tokens documentation | — | Developers can't discover available tokens |
| No skip-to-content link | WCAG gap | Accessibility |
| Heading hierarchy not audited | WCAG gap | Accessibility |

## Security Considerations

| Area | Status | Notes |
|------|--------|-------|
| CSRF protection | ✅ Active | `domain-auth` middleware |
| Rate limiting | ✅ Active | Per-IP in middleware |
| CSP headers | ✅ Active | Set in middleware |
| HTML sanitization | ✅ Active | `sanitize-html` on server |
| XSS hardening | ✅ Complete | Phases 24-25: innerHTML → replaceChildren |
| License key (Ed25519) | ✅ Active | Offline JWT, no phone-home |
| `.keys/` directory | ✅ Gitignored | Private key never committed |
| Secret scanning | ⚠️ Manual | No automated pre-commit hook |
| Input validation | ✅ Zod | API routes use Zod schemas |
| `confirm()`/`prompt()` migration | ✅ Complete | All native dialogs → `confirmDialog()`/`promptDialog()` |

## Performance Considerations

| Area | Status | Notes |
|------|--------|-------|
| `transition: all` | ✅ Eliminated | Phase 30: 0 remaining |
| Bundle size | ⚠️ Watch | 18 CSS modules, 90+ controllers |
| Font loading | ✅ Optimized | Fontsource variable fonts + relative path fix |
| SSR | ✅ Active | All pages server-rendered |
| Pre-bundling | ✅ Configured | `marked` in Vite optimizeDeps |
| Memory leaks | ✅ Addressed | managed-listeners + AbortController signals (Phases 11, 29) |
| Error boundaries | ✅ Added | Phase 29: global error handler + onPageLoad try/catch |

## Fragile Areas

| Area | Risk | Why |
|------|------|-----|
| **Ingress rewriting** | HIGH | Triple-layer: `serve.mjs` → middleware → Layout monkey-patch |
| **`serve.mjs` → Astro pipeline** | MEDIUM | Custom HTTP wrapper adds request lifecycle complexity |
| **Layout.astro** | MEDIUM | God file — conditional rendering, fetch monkey-patching, script injection |
| **Parent page controller** | MEDIUM | Hash-based routing with `pushState`/`popstate` |
| **Calendar/CalDAV sync** | MEDIUM | External service dependency with credential management |

## Environment Health (2026-04-28)

| Tool | Status | Notes |
|------|--------|-------|
| Node.js | ✅ v25.9.0 | Working |
| pnpm | ✅ 10.8.0 | Fixed via standalone installer post Kubuntu migration |
| TypeScript | ✅ 5.9.3 | Compiles clean |
| Docker | ❌ Not installed | Kubuntu migration — blocks Tier 2. Podman available. |
| Playwright | ❓ | Not tested since OS migration |
