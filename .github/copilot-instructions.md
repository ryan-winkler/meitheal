# GitHub Copilot Instructions for Meitheal

> These instructions apply to all GitHub Copilot features in this repository:
> Copilot Chat, code completion, and the Copilot Coding Agent.

## Commit Authorship

**Do not publish commits under the Copilot bot identity.**

Every commit produced by an AI agent in this repository **must** include a
`Co-authored-by` trailer that credits the human owner:

```
Co-authored-by: ryan-winkler <ryan-winkler@users.noreply.github.com>
```

The preferred approach is a **squash-merge** of any agent-created PR so that
the final commit lands under the human author's identity. Do not push
force-authored commits directly to `main`.

## Coding Standards

Refer to `AGENTS.md` and the inline docs for full conventions. Key points:

- No semicolons, double-quoted strings, 2-space indent (TypeScript/Astro)
- Named exports only — no default exports
- kebab-case filenames, PascalCase types, camelCase functions
- Discriminated unions for API responses: `{ ok: true } | { ok: false, errorCode }`
- Do not introduce new external dependencies without security-advisory check

## Architecture Constraints

- Preserve Astro-first SSR architecture
- Maintain DDD bounded-context boundaries (no cross-context deep imports)
- Keep Home Assistant add-on compatibility as a first-class constraint
- Never issue server-side redirects to bare `/` paths behind HA ingress

## Verification Requirements

- For ingress, HA API/WebSocket, Supervisor, addon lifecycle, or sync changes, use Tier 2 before claiming verification
- Start Tier 2 by reopening the checked-in `.devcontainer/devcontainer.json` in Antigravity or VS Code and running `Start Home Assistant`
- Use `./scripts/devcontainer-up.sh` for status, recovery, and logs around that devcontainer environment
- Do not claim HA integration verification from Tier 1 alone

## GSD Workflow

- Treat `.planning/PROJECT.md`, `.planning/REQUIREMENTS.md`, `.planning/ROADMAP.md`, and `.planning/STATE.md` as authoritative build context when they exist
- For non-trivial scoped work already represented in `.planning/`, prefer the GSD lifecycle: discuss -> plan -> execute -> verify
- Use the workspace prompt files in `.github/prompts/` to delegate to the installed GSD workflows instead of reconstructing those workflows from memory
- When phase artifacts exist (`*-CONTEXT.md`, `*-RESEARCH.md`, `*-PLAN.md`, `*-SUMMARY.md`, `*-VERIFICATION.md`), follow them exactly and keep the affected planning docs current in the same change set
- For design-heavy, UX-heavy, or architecture-heavy changes, consult the relevant persona-loop outputs before treating the work as complete
- Work from repository root where `.planning/` lives when executing GSD-backed workflows

## Memory & Drift

- Use the memory MCP to persist short, verified repo facts and session notes that reduce re-discovery across long GSD cycles
- Only store validated facts, conventions, or durable decisions; never store secrets, tokens, private keys, or speculative assumptions
- Update memory after resolving recurring environment or workflow issues so future sessions do not re-debug the same problem

## Release & Publishing

Meitheal uses a **two-channel release strategy**:

| Channel | Dir | Trigger | Version | Stage |
|---------|-----|---------|---------|-------|
| Stable | `meitheal-hub/` | vtag push (`v*`) | Semver (`0.0.1`) | `stable` |
| Canary | `meitheal-hub-canary/` | Push to `main` | Commit SHA | `experimental` |

### Stable Release (Step-by-Step)

1. `node scripts/bump-version.mjs patch` — updates config.yaml, run.sh, package.json, sw.js
2. Update `CHANGELOG.md`
3. `git add -A && git commit -m "🔖 release v{VERSION}"`
4. `git tag v{VERSION} && git push origin main --tags`
5. CI publishes via `publish-addon-images.yml`

### Canary (Automatic)

Every push to `main` triggers `publish-canary-images.yml`. Do NOT manually edit `meitheal-hub-canary/config.yaml` version — it is CI-managed.

### Version Rules

- Stay in the current release line unless user explicitly asks to move (`0.0.x` stays `0.0.x`)
- Use `bump-version.mjs` — never manually edit version fields
- See `docs/kcs/releasing.md` for the full runbook
