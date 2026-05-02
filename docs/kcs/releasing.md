# Releasing Meitheal

> KCS runbook for the Meitheal two-channel release strategy.
> Last updated: 2026-03-20

## Channel Architecture

```
main branch
    │
    ├─ push ──→ 🐤 Canary (auto-build, SHA version)
    │            ghcr.io/coolock-village/meitheal-canary-{arch}:{sha}
    │
    └─ vtag ──→ 📦 Stable (manual release, semver)
                 ghcr.io/coolock-village/meitheal-{arch}:{version}
```

| Channel | Addon Name | Version Format | Trigger | Stage |
|---------|-----------|---------------|---------|-------|
| Stable | Meitheal | Semver (`0.0.1`) | vtag push (`v*`) | `stable` |
| Canary | Meitheal Canary | Commit SHA (`abc1234`) | Push to `main` | `experimental` |

## Cutting a Stable Release

### 1. Bump version

```bash
node scripts/bump-version.mjs patch   # 0.0.1 → 0.0.2
# or: node scripts/bump-version.mjs minor  # 0.0.2 → 0.1.0
# or: node scripts/bump-version.mjs 1.0.0  # explicit version
```

This updates 4 files atomically:
- `meitheal-hub/config.yaml`
- `meitheal-hub/run.sh`
- `apps/web/package.json`
- `apps/web/public/sw.js`

### 2. Update CHANGELOG.md

Add an entry under the new version number.

### 3. Commit and tag

```bash
git add -A
git commit -m "🔖 release v0.0.2"
git tag v0.0.2
git push origin main --tags
```

### 4. Verify

- Check [GitHub Actions](https://github.com/Coolock-Village/meitheal/actions/workflows/publish-addon-images.yml) for the publish workflow
- Verify images appear on [GHCR](https://github.com/orgs/Coolock-Village/packages)
- Test update on a HA instance

## How Canary Works

1. Developer pushes code to `main`
2. `publish-canary-images.yml` triggers (if not a bot commit)
3. CI builds Docker images using the same `meitheal-hub/Dockerfile`
4. Images pushed as `meitheal-canary-{arch}:{sha}` + `:canary`
5. CI updates `meitheal-hub-canary/config.yaml` version and commits back
6. HA Supervisor sees new version on next repo refresh → offers update

### Guard against infinite loops

- The canary workflow skips runs from `github-actions[bot]`
- The `ci.yml` ignores changes to `meitheal-hub-canary/config.yaml`
- The canary commit message includes `[skip ci]`

## Promoting Canary to Stable

There's no automated promotion. To promote:

1. Verify the canary build you want to promote works on HA
2. Run `node scripts/bump-version.mjs patch` (or minor/major)
3. Follow the "Cutting a Stable Release" steps above

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

