# Testing

> Last refreshed: 2026-03-15

## Framework

- **Playwright** ^1.58.2 — E2E testing
- **@axe-core/playwright** ^4.11.1 — Accessibility testing
- **Workspace**: `tests/` (`@meitheal/tests`)
- **Config**: `tests/playwright.config.ts`

## Running Tests

| Command | Scope |
|---|---|
| `pnpm --filter @meitheal/tests test` | All E2E tests |
| `pnpm --filter @meitheal/tests test <file>` | Specific spec |
| `pnpm check` | Typecheck all packages |

## Test Structure

```
tests/
├── e2e/               ← 48 E2E test specs
├── governance/         ← 2 governance compliance specs
├── unit/              ← 1 unit test
└── scripts/           ← Verification scripts
```

## E2E Test Categories (48 specs)

### API & Data

| Spec | Coverage |
|---|---|
| `api.spec.ts` | Core API endpoint validation |
| `task-sync-domain.spec.ts` | Task sync domain logic |
| `task-sync-persistence.spec.ts` | Task persistence layer |
| `task-type-api.spec.ts` | Task type API validation |
| `subtask-hierarchy.spec.ts` | Parent-child task relationships |
| `ticket-number.spec.ts` | Ticket numbering system |
| `status-consistency.spec.ts` | Status value consistency |
| `user-assignment.spec.ts` | User assignment flows |

### Security

| Spec | Coverage |
|---|---|
| `security-headers.spec.ts` | CSP, HSTS, X-Frame-Options |
| `phase5-security.spec.ts` | Phase 5 security hardening |
| `ha-security-hardening.spec.ts` | HA-specific security |
| `rate-limiter.spec.ts` | Rate limiting enforcement |
| `auth-passkey.spec.ts` | Passkey authentication |

### HA Integration

| Spec | Coverage |
|---|---|
| `ha-calendar-adapter.spec.ts` | Calendar entity sync |
| `ha-llm-api.spec.ts` | LLM API integration |
| `ha-backup-platform.spec.ts` | Backup/restore flows |

### Ingress

| Spec | Coverage |
|---|---|
| `ingress-header-validation.spec.ts` | Ingress header handling |
| `ingress-state-persistence.spec.ts` | State persistence across ingress |
| `middleware-ingress-behavior.spec.ts` | Middleware rewriting |
| `layout-ingress-client-router.spec.ts` | Client-side routing under ingress |

### UI & Navigation

| Spec | Coverage |
|---|---|
| `pages.spec.ts` | Page rendering |
| `navigation.spec.ts` | Navigation flows |
| `accessibility.spec.ts` | Axe accessibility audit |
| `branding.spec.ts` | Brand consistency |
| `seo.spec.ts` | SEO meta tags |
| `kanban-backlog-mode.spec.ts` | Kanban backlog functionality |

### Integrations

| Spec | Coverage |
|---|---|
| `integrations.spec.ts` | Integration status |
| `grocy-adapter.spec.ts` | Grocy API adapter |
| `vikunja-compat.spec.ts` | Vikunja v1 compatibility |
| `vikunja-compat-auth.spec.ts` | Vikunja auth compat |
| `vikunja-compat-calendar-sync.spec.ts` | Calendar sync compat |
| `vikunja-compat-calendar-timezone.spec.ts` | Timezone handling |
| `webhook-signer.spec.ts` | Webhook signature verification |
| `webmcp-a2a.spec.ts` | A2A protocol |

### Offline & PWA

| Spec | Coverage |
|---|---|
| `offline-sync.spec.ts` | Offline data sync |
| `offline-attachments.spec.ts` | Offline attachment handling |
| `pwa-offline.spec.ts` | PWA offline mode |

### Observability

| Spec | Coverage |
|---|---|
| `logging-observability.spec.ts` | Structured logging |
| `logger-redaction.spec.ts` | Secret redaction |

### Settings & Config

| Spec | Coverage |
|---|---|
| `theme-settings.spec.ts` | Theme switching |
| `agent-protocol-settings.spec.ts` | Agent config |

### Other

| Spec | Coverage |
|---|---|
| `cloud-runtime.spec.ts` | Cloud runtime compat |
| `export-service.spec.ts` | Export functionality |
| `notification-deeplinks.spec.ts` | Notification deep links |
| `rename-sweep-regression.spec.ts` | Rename regression |
| `migration-splitter.spec.mjs` | DB migration splitting |
| `well-known.spec.ts` | .well-known endpoints |

## Governance Tests (2 specs)

| Spec | Coverage |
|---|---|
| `iqs-platinum.spec.ts` | IQS platinum quality standards |
| `repo-standards.spec.ts` | Repository file & structure standards |

## Unit Tests (1 spec)

| Spec | Coverage |
|---|---|
| `todo-status-mapper.spec.ts` | HA todo status value mapping |

## Testing Conventions

- Tests import domain logic directly from workspace packages
- HA tests use local HTTP server harness to simulate HA API
- Persistence tests use temp SQLite (`file:${tmpdir}/...`)
- No shared state between specs — no external mocking framework
- Helper utilities in `tests/e2e/_helpers.ts`
- CI enforces all tests pass via `pnpm --filter @meitheal/tests test`

## CI Pipeline (`.github/workflows/ci.yml`)

Two jobs:
1. **governance** — File existence checks, CSS brace balance, version sync
2. **typecheck-and-tests** — `pnpm check` + `pnpm --filter @meitheal/tests test`
