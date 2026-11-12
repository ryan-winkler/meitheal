# Releasing Meitheal

> KCS runbook for the Meitheal two-channel release strategy.
> Last updated: 2026-11-12

## Channel Architecture

```
dev branch
    │
    └─ push (merge) ──→ 🐤 Canary (auto-build, SHA version)
                         ghcr.io/coolock-village/meitheal-canary-{arch}:{sha}
                         meitheal-hub-canary/config.yaml updated & synced

release branch (or v* tag)
    │
    └─ push (promotion) → 📦 Stable (auto-build, semver)
                         ghcr.io/coolock-village/meitheal-{arch}:{version}
                         meitheal-hub/config.yaml synced
```

| Channel | Addon Name | Version Format | Trigger | Stage |
|---------|-----------|---------------|---------|-------|
| Stable | Meitheal | Semver (`0.1.x`) | Push to `release` or `v*` tag | `stable` |
| Canary | Meitheal Canary | Commit SHA (`abc1234`) | Push to `dev` (or `main`) | `experimental` |

## How Canary Works

1. Developers merge code into the `dev` branch.
2. The `publish-canary-images.yml` workflow starts automatically.
3. Docker Buildx compiles multi-arch images (`linux/amd64`, `linux/arm64`).
4. BuildKit cache mounts (`--mount=type=cache,id=pnpm-store`) accelerate package installation.
5. GitHub Actions caches image layers via `type=gha,scope=canary-${{ matrix.arch }}`.
6. The action pushes images to GHCR as `meitheal-canary-{arch}:{sha}` and `:canary`.
7. CI commits the updated SHA version into `meitheal-hub-canary/config.yaml` on the triggered branch.
8. CI syncs the updated configuration to `Coolock-Village/meitheal-ha-addon` on GitHub.
9. Home Assistant Supervisor discovers the new version and displays an update notice.

### Guard against infinite loops

- The canary workflow skips runs from `github-actions[bot]`.
- The `ci.yml` workflow ignores edits in `meitheal-hub-canary/config.yaml`.
- The commit uses GitHub API with `[skip ci]` semantics.
- Concurrency control cancels older in-progress builds when a new commit lands.

## Cutting a Stable Release

### 1. Bump version

Run the version update script:

```bash
node scripts/bump-version.mjs patch   # 0.1.80 → 0.1.81
# or: node scripts/bump-version.mjs minor  # 0.1.80 → 0.2.0
# or: node scripts/bump-version.mjs 1.0.0  # explicit version
```

This script updates four files together:
- `meitheal-hub/config.yaml`
- `meitheal-hub/run.sh`
- `apps/web/package.json`
- `apps/web/public/sw.js`

### 2. Update CHANGELOG.md

Add notes for user changes under the new version number.

### 3. Merge to release branch or push tag

Option A: Merge `dev` into `release` and push:
```bash
git checkout release
git merge dev
git push origin release
```

Option B: Create and push a semver tag:
```bash
git tag v0.1.81
git push origin v0.1.81
```

### 4. Verify Release Build

- Check [GitHub Actions](https://github.com/Coolock-Village/meitheal/actions/workflows/publish-addon-images.yml) for the publish workflow.
- Verify images exist on [GHCR](https://github.com/orgs/Coolock-Village/packages) and Docker Hub.
- The `sync-addon-repo.yml` workflow copies manifests to the public repository.
- Test the new version on a Home Assistant instance.

## Troubleshooting

### Stable publish failed

1. Check the vtag matches `config.yaml` version: `v{version}`
2. Run `node scripts/check-version-sync.mjs` to verify all 4 files match
3. Re-run the workflow via GitHub Actions UI

### Canary not updating

1. Check if the latest push was from `github-actions[bot]` (auto-skipped)
2. Check `meitheal-hub-canary/config.yaml` — version should be recent SHA
3. On HA: Settings → Add-ons → Meitheal Canary → Check for updates

### HA shows wrong version

HA Supervisor caches addon info. Try:
1. Settings → Add-ons → Add-on Store → ⋮ → Reload
2. Wait 5 minutes for background refresh
3. Restart Home Assistant Supervisor (last resort)

## Files Reference

| File | Purpose | Managed by |
|------|---------|-----------|
| `meitheal-hub/config.yaml` | Stable addon config | `bump-version.mjs` |
| `meitheal-hub-canary/config.yaml` | Canary addon config | CI (`update-canary-version.mjs`) |
| `scripts/bump-version.mjs` | Stable version bumps | Developer |
| `scripts/update-canary-version.mjs` | Canary version updates | CI only |
| `scripts/check-version-sync.mjs` | Version consistency guard | CI |
| `.github/workflows/publish-addon-images.yml` | Stable image publish | vtag trigger |
| `.github/workflows/publish-canary-images.yml` | Canary image publish | main push trigger |
| `.github/workflows/sync-addon-repo.yml` | Sync manifests → public repo | main push / vtag |

## Dual-Repo Architecture

The source code lives in `Coolock-Village/meitheal` (private). A separate public repository, `Coolock-Village/meitheal-ha-addon`, serves as the HA add-on store entry point.

```
meitheal (private)              meitheal-ha-addon (public)
├── apps/                       ├── repository.yaml
├── packages/                   ├── meitheal-hub/
├── meitheal-hub/        ──CI──→│   ├── config.yaml
│   ├── config.yaml             │   ├── DOCS.md, CHANGELOG.md
│   ├── Dockerfile              │   ├── icon.png, logo.png
│   └── ...                     │   └── translations/
├── meitheal-hub-canary/ ──CI──→├── meitheal-hub-canary/
│   └── ...                     │   └── ...
└── .github/workflows/          └── README.md
    └── sync-addon-repo.yml
```

- `sync-addon-repo.yml` copies manifests, docs, icons, and translations on every relevant push to `main`
- Docker images are published to GHCR from the private repo (images must be set to public visibility)
- HA users add `https://github.com/Coolock-Village/meitheal-ha-addon` as their repository URL
- Issues and discussions use the org-level space: `https://github.com/orgs/Coolock-Village/discussions`

### Post-migration: GHCR package visibility

After making the main repo private, GHCR packages default to private. You must manually set each package to public:

1. Go to `https://github.com/orgs/Coolock-Village/packages`
2. For each `meitheal-*` package → Settings → Change visibility → Public

