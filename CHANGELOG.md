<!-- markdownlint-disable MD024 -->

# Changelog

All notable changes to Meitheal are documented in this file.

## [0.3.1] — 2026-03-19

### Changed

- Refreshed codebase planning docs for architecture, conventions, integrations, stack, and structure
- Added unified bar cross-page integration and verification reports under `.planning/research/unified-bar-cross-page/`
- Cut a `0.3.1` patch release from current `main` to republish Home Assistant add-on artifacts

## [0.1.95] — 2026-03-08

### Added

- **`supervisor-fetch.ts`** — shared Supervisor proxy fetch with 8s AbortController timeout + auto token injection
- **`TaskRepository`** — repository pattern for all SSR task queries (335 lines, 15+ methods)
- **StatusBadge** — `backlog` + `cancelled` status support, `isDone` includes cancelled
- **CSS badge classes** — `.badge-backlog` (gray), `.badge-cancelled` (red/danger)
- **i18n keys** — `task_status.backlog`, `task_status.cancelled` in en.json + ga.json

### Security

- **XSS fix** — comment rendering migrated from innerHTML to DOM API (textContent)
- **i18n link types** — hardcoded English labels replaced with `t()` calls
- **Supervisor timeout** — 5 Supervisor proxy fetches now have 8s timeout protection

### Fixed

- **safe-fetch.ts** — 5 TypeScript errors (`string|undefined` → nullish coalescing)
- **Perf budget** — baseline bumped from 819KB to 921KB (intentional growth)
- **grocy/test.ts** — unsafe `rows[0].value` → `rows[0]?.value` optional chaining
- **tasks/create.ts** — migrated to `apiJson`/`apiError` helpers

### Changed

- 5 Supervisor proxy fetches migrated to shared utility (ha/status, ha/addons, ha-connection, grocy/test, grocy/auto-key)
- All JSON.parse calls verified in try/catch
- All setInterval/setTimeout have typed refs with cleanup

## [0.3.0] — 2026-03-19

### Added

- **Task Activity Log** — field-level audit trail for all task changes (ADR-0011)
- **Task Duplication** — `POST /api/tasks/[id]/duplicate` endpoint
- **Optimistic Locking** — 409 Conflict on stale `updated_at` (ADR-0010)
- **Rate Limiting** — 120 req/min per IP with x-ratelimit headers (ADR-0009)
- **Comment Counts** — displayed on kanban cards
- **Inline Priority Editing** — table view priority column now editable
- **Security Headers** — X-Content-Type-Options, X-Frame-Options, Referrer-Policy, Permissions-Policy, X-XSS-Protection, CSP
- **CSRF Protection** — origin-based checking on all mutating API routes
- **Reduced Motion** — `prefers-reduced-motion: reduce` media query
- **Toast Accessibility** — `aria-live="polite"` on all toast containers
- **DB Indexes** — 9 indexes covering all filter/sort columns
- **Kanban Group-By Persistence** — localStorage for group selection
- **Shared API Helpers** — `apiError()` / `apiJson()` in `lib/api-response.ts`
- **ADRs 0008-0011** — Phase 27-30 architectural decisions
- **AppArmor Profile** — restrictive `apparmor.txt` for HA add-on container security
- **HA Ingress User Identity** — extract `X-Hass-User-Id` and `X-Hass-Is-Admin` from Supervisor headers
- **Auth API** — `auth_api: true` enables Supervisor auth backend validation
- **Panel Admin** — sidebar panel restricted to HA admin users
- **Non-root Container** — Dockerfile runs as `meitheal` user instead of root
- **Dynamic CSP** — `frame-ancestors` adjusts for HA ingress iframe embedding
- **Translations** — English option descriptions in `translations/en.yaml`
- **tmpfs** — `/tmp` mounted as tmpfs for ephemeral storage
- **Activity Log UI** — collapsible `<details>` section in task detail panel, lazy-loaded on expand
- **Duplicate Task Button** — 📋 button in task detail action sidebar (POST + auto-open clone)
- **Time Tracked Input** — editable minutes-tracked field in Date & Time section
- **Danger Zone** — settings page section for purge all tasks (triple-confirm) and reset settings
- **Command Palette Nav** — Go to Dashboard/Kanban/Table/Settings + Export CSV commands
- **Command Search Filtering** — typing in command palette filters both commands and tasks
- **Version Bump** — `0.3.0` Phase 32: Deep Audit

### Fixed

- Comments POST now wrapped in try/catch
- Labels GET/POST now wrapped in try/catch
- Lanes PUT/DELETE now wrapped in try/catch
- Table bulk operations wrapped in try/catch with error toasts
- Table +New Task button wired to API POST
- Inline-select sends priority as number (was string, silently ignored)

### Changed

- CSP tightened: `base-uri 'self'`, `form-action 'self'`, `upgrade-insecure-requests`
- Settings API: key regex validation, 10KB value cap
- Import: 100KB payload guard, expanded allowlist
- Build time improved: 2.35s (from 2.49s)
- Bundle stable: tasks 10.59kB, Layout 21.91kB (gzip)
