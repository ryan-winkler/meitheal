# Contributing to Meitheal

> **Meitheal** (pronounced *MEH-hal*) is the Irish word for a cooperative work team — neighbours coming together to get things done. That spirit defines how we build this project.

Contributions are welcome! Whether you're fixing a bug, improving docs, or adding a feature, this guide explains how we work.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Our Rules](#our-rules)
- [Architecture](#architecture)
- [Getting Started](#getting-started)
- [Coding Conventions](#coding-conventions)
- [Testing](#testing)
- [Pull Request Process](#pull-request-process)
- [HA Add-on Development](#ha-add-on-development)
- [AI Contributors](#ai-contributors)

## Code of Conduct

Be kind, be constructive. We're a community project built by volunteers. Treat every contributor — human or AI — with respect.

## Our Rules

These are non-negotiable. PRs that violate them will be asked to revise.

### 1. Astro-First

Meitheal is built on [Astro](https://astro.build/) SSR. Prefer official Astro integrations before custom solutions. Don't introduce alternative frameworks unless there's no Astro-native option.

### 2. Domain-Driven Design (DDD)

Every feature belongs to a **bounded context**. There are 5:

| Context | Package | Scope |
|---------|---------|-------|
| Auth | `domain-auth` | Ingress, tokens, passkeys |
| Tasks | `domain-tasks` | Task CRUD, boards, kanban |
| Strategy | `domain-strategy` | Frameworks, scoring, evaluation |
| Observability | `domain-observability` | Logging, auditing, metrics |
| Integrations | `integration-core` | Calendar sync, webhooks, adapters |

**Rules:**
- Domain logic goes in `packages/domain-*/`, NOT in pages or API routes
- Cross-context imports must use public package APIs, never deep path imports
- Use ubiquitous language — say "task" not "todo", "board" not "project"

### 3. Knowledge-Centered Support (KCS)

Every behavior change requires a documentation update **in the same commit**:
- New features → update relevant KCS runbook or create a new one
- Architectural decisions → write an ADR in `docs/decisions/`
- Error messages must enable self-service debugging

### 4. Home Assistant First

HA add-on compatibility is a first-class constraint:
- Ingress auth must work in all code paths
- AppArmor profile must remain restrictive
- `config.yaml` and `repository.yaml` must stay HA-publishing-compliant
- Test with the HA Supervisor, not just standalone

### 5. CodeRabbit Triage

CodeRabbitAI reviews every PR. Treat findings as required triage:
- **Accept** and implement the fix, OR
- **Document** the reject rationale in the PR comment

## Architecture

```
meitheal/
├── apps/web/              # Astro SSR app (pages, API routes, middleware)
├── packages/domain-*/     # Pure domain logic (5 bounded contexts)
├── packages/integration-core/  # Adapter interfaces + implementations
├── meitheal-hub/          # HA OS add-on (Dockerfile, AppArmor, config)
├── tests/                 # Playwright test suite
│   ├── e2e/               # Integration + E2E tests
│   └── governance/        # Repo standards enforcement
├── docs/                  # ADRs, KCS runbooks, analysis
└── .planning/             # Internal planning artifacts
```

**Data flow:** SQLite via Drizzle ORM → domain events with idempotency keys → adapter pattern for integrations.

## Getting Started

### Prerequisites

- Node.js 22+
- pnpm 9+
- Git

### Setup

```bash
git clone https://github.com/Coolock-Village/meitheal.git
cd meitheal
pnpm install
```

### Development

```bash
pnpm --filter web dev      # Start dev server (http://localhost:3000)
pnpm check                 # Typecheck all packages (must pass with 0 errors)
pnpm --filter @meitheal/tests test   # Run full test suite
```

## Coding Conventions

### Style

| Rule | Value |
|------|-------|
| Semicolons | No |
| Quotes | Double |
| Indent | 2 spaces |
| Exports | Named only (no default exports) |

### Naming

| Thing | Convention | Example |
|-------|-----------|---------|
| Files | kebab-case | `task-sync-service.ts` |
| Functions | camelCase | `createTask()` |
| Types | PascalCase | `TaskAggregate` |
| Test specs | `<name>.spec.ts` | `ha-calendar-adapter.spec.ts` |

### Import Order

1. Node builtins (`node:fs/promises`)
2. Framework (`astro`, `astro:content`)
3. External packages (`drizzle-orm`, `zod`)
4. Workspace packages (`@meitheal/domain-tasks`)
5. Local/relative (`./task`, `@domains/auth/ingress`)

### Patterns

- **Discriminated unions** for API results: `{ ok: true } | { ok: false, errorCode }`
- **Command objects** for complex inputs: `CreateTaskCommand`
- **AbortController** timeouts on all external calls
- **Structured JSON logging** — single object per line, Loki-compatible

## Testing

### CI Jobs (all must pass)

| Job | What it checks |
|-----|---------------|
| `typecheck-and-tests` | `astro check` + full Playwright suite |
| `migration-check` | Drizzle migration pipeline |
| `schema-drift` | Schema matches migrations |
| `governance` | Required files exist |
| `ha-harness` | HA calendar adapter tests |
| `perf-budgets` | Bundle size, RSS, p95 latency |

### Running Locally

```bash
# All tests
pnpm --filter @meitheal/tests test

# Specific spec
pnpm --filter @meitheal/tests test e2e/ingress-header-validation.spec.ts

# E2E browser tests (requires running server)
E2E_BASE_URL=http://localhost:3000 pnpm --filter @meitheal/tests test e2e/pages.spec.ts
```

### Writing Tests

- Tests import domain logic directly from workspace packages
- HA tests use a local HTTP server harness to simulate the HA API
- Persistence tests use temp SQLite files — no shared state between specs
- Browser-dependent tests must include `test.skip(shouldSkipBrowserSpecs(), ...)`

## Contributor License Agreement (CLA)

Meitheal is [dual-licensed](COMMERCIAL.md) under AGPL-3.0 and a commercial license. To maintain this, we require all contributors to sign a **Contributor License Agreement** before their first PR can be merged.

**What it does:**
- Grants the maintainer (Ryan Winkler) the rights to offer your contribution under both the AGPL and commercial terms
- You **retain copyright** to your contribution
- You are **not** transferring ownership — just granting a broad license

**How it works:**
1. Open a pull request
2. A bot will comment asking you to sign the CLA
3. Reply with: `I have read the CLA Document and I hereby sign the CLA.`
4. Done — you won't be asked again for future PRs

Read the full CLA text: [`.github/CLA.md`](.github/CLA.md).

## Pull Request Process

### Branch Naming

```
feat/<description>    # New features
fix/<description>     # Bug fixes
docs/<description>    # Documentation only
chore/<description>   # Tooling, CI, dependencies
```

### Commit Messages

Conventional commits with emoji prefixes:

```
🆕 feat(tasks): add board drag-and-drop reordering
🐛 fix(auth): handle missing ingress headers gracefully
📝 docs(kcs): update operations runbook for webhook config
🔧 chore(ci): raise perf budget for theme system growth
🧪 test(e2e): add regression assertions for ingress edge cases
```

### Before Opening a PR

1. `pnpm check` passes with **0 errors**
2. `pnpm --filter @meitheal/tests test` passes
3. KCS docs updated if behavior changed (same commit)
4. No cross-context deep imports
5. HA add-on compatibility preserved (if touching `meitheal-hub/`)

### Review

- All 6 CI jobs must pass
- CodeRabbit findings must be triaged (accept/reject with rationale)
- At least one maintainer approval required

## HA Add-on Development

The add-on lives in `meitheal-hub/`:

```bash
# Build locally
docker build -t meitheal-hub \
  --build-arg BUILD_FROM=ghcr.io/home-assistant/amd64-base:latest \
  meitheal-hub

# Run outside HA Supervisor
docker run -p 3000:3000 -v $(pwd)/data:/data meitheal-hub /run-local.sh
```

Key files:

| File | Purpose |
|------|---------|
| `config.yaml` | Add-on manifest (ingress, auth, AppArmor, options) |
| `apparmor.txt` | Security profile (enforced by Supervisor) |
| `translations/en.yaml` | English option descriptions for HA UI |
| `run.sh` | Supervisor entrypoint |
| `run-local.sh` | Local dev entrypoint (no bashio) |
| `repository.yaml` | HA add-on repository definition (repo root) |

## AI Contributors

AI systems are welcome. See:

- [AI_POLICY.md](AI_POLICY.md) — licensing, API access, training permissions
- [AGENTS.md](AGENTS.md) — mandatory rules for all contributors (human + AI)
- [WEBMCP.md](WEBMCP.md) — machine-readable protocol integration

---

*Questions? Open a [discussion](https://github.com/Coolock-Village/meitheal/discussions).*
