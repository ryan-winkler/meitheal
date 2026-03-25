# Codex Agent Instructions for Meitheal

> These instructions apply to OpenAI Codex CLI (`codex`) when working in this repository.

## Mandatory Reading

Before making any changes, read `AGENTS.md` — it contains DDD boundaries, coding
conventions, commit policy, verification tiers, and deploy rules.

## Commit Authorship

- No `Co-authored-by` trailers — commits come from the user's git identity
- Commit with descriptive messages, never generic "update" messages

## Coding Standards

- No semicolons, double-quoted strings, 2-space indent
- Named exports only — no default exports
- kebab-case files, PascalCase types, camelCase functions
- Discriminated unions: `{ ok: true } | { ok: false, errorCode }`

## Architecture

- Astro SSR first — prefer official Astro integrations
- DDD bounded contexts — no cross-context deep imports
- HA add-on compatibility is a first-class constraint
- Never issue server-side redirects to bare `/` behind ingress

## Release & Publishing

Two-channel strategy — see `docs/kcs/releasing.md` for full runbook.

| Channel | Dir | Trigger | Version | Stage |
|---------|-----|---------|---------|-------|
| **Stable** | `meitheal-hub/` | vtag push (`v*`) | Semver (`0.0.1`) | `stable` |
| **Canary** | `meitheal-hub-canary/` | Push to `main` | Commit SHA | `experimental` |

### Publishing a Stable Release

```bash
# 1. Bump version (updates 4 files atomically)
node scripts/bump-version.mjs patch

# 2. Verify sync
node scripts/check-version-sync.mjs

# 3. Update CHANGELOG.md

# 4. Commit, tag, push
git add -A
git commit -m "🔖 release v{VERSION}"
git tag v{VERSION}
git push origin main --tags
```

### Canary (Automatic)

Every push to `main` auto-triggers `publish-canary-images.yml`.

**⚠️ Do NOT:**
- Manually edit `meitheal-hub-canary/config.yaml` version (CI-managed)
- Run `bump-version.mjs` for canary
- Move to a new version line without explicit user direction

## Testing

```bash
pnpm check                              # Typecheck all packages
pnpm --filter @meitheal/tests test      # Full test suite
node scripts/check-version-sync.mjs     # Version consistency
```

## Verification Tiers

| Change Type | Required Tier |
|-------------|---------------|
| CSS, UI components, client JS | 🔧 `npm run dev` in `apps/web/` |
| Ingress, HA API, WebSocket | 🏠 HA devcontainer |
| Final acceptance | 🌐 Production HA |
