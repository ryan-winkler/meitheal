# Home Assistant Publishing Checklist

Source of truth:
- https://developers.home-assistant.io/docs/apps/publishing
- https://developers.home-assistant.io/docs/add-ons/presentation

## Repository-Level Requirements

1. Keep root `repository.yaml` present and valid.
2. Keep add-on folder with `config.yaml` + docs (`README.md`, `DOCS.md`).
3. Keep published container naming aligned with add-on `image` field and `{arch}` suffix.
4. Keep the GitHub repository About metadata aligned with the README story:
- description
- homepage/docs link
- discoverability topics (for example `home-assistant`, `home-assistant-addon`, `task-management`, `homelab`, `mcp`)

## Add-on Metadata Requirements

1. `config.yaml` includes:
- `name`
- `slug`
- `version`
- `arch`
- `image`
- ingress/API permissions as needed
2. `build.json` maps each supported architecture to `build_from`.
3. Add-on documentation clearly states setup and runtime expectations.

## Release and CI Requirements

1. Publish architecture-specific images to GHCR.
2. Tag images with add-on `version`.
3. Run `node scripts/check-version-sync.mjs` before cutting a release tag so `meitheal-hub/config.yaml`, `meitheal-hub/run.sh`, `apps/web/package.json`, and `apps/web/public/sw.js` agree.
4. Keep CI checks green before release (`governance`, typechecks/tests, migration, drift, perf budgets).
5. Run optional live-HA verification workflow before publishing stable tags.
