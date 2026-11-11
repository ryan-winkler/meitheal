---
type: "Runbook"
title: "Home Assistant Publishing Checklist"
description: "Check App packaging, discovery, and installation."
---

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
6. Before publishing a canary, record a passing fixed 2,000-task benchmark for the exact ARM64 image on Home Assistant Green. Follow the [release-host runbook](releasing.md#qualify-and-promote-a-canary-from-a-release-host) to verify both published images before staging discovery.

### Astro runtime updates

Astro 7.4.8 requires Node.js 22.23.4 or later. Build with the locked pnpm
10.34.9 dependency graph and keep the Astro and Node adapter versions compatible.
The HA image builds on the host architecture and installs runtime dependencies
inside the target architecture. Check that both the standalone server and the
ingress wrapper can start from the packaged output.

Run the existing performance budget after the production build. In the HA
devcontainer, confirm the ingress panel opens without redirects escaping the
iframe, loads its CSS and fonts, and can open a task. Verify the built runtime
versions before publishing. Astro 7.2.8 introduced the AVIF security fix through
Sharp 0.35.4. [Astro security advisory](https://github.com/withastro/astro/security/advisories/GHSA-26w7-cxv4-gfx2).


## Runtime dependency check

The build stage bundles Astro and the Node adapter into the server output and emits font assets. The target-platform stage installs the production dependencies of `@meitheal/web` and its workspace packages. It copies them to the same path in the final image to preserve pnpm links. Sharp stays a runtime dependency so the image endpoint can load the native binary and libvips for the target platform. The final image runs SQLite migrations with `node scripts/migrate.mjs` and ships without npm or pnpm.

Verify each architecture from a clean build. Confirm neither package manager is in the final image. Start the App with an empty data directory and again with a migrated fixture. Check health, SQLite migrations, ingress and task persistence. Fetch a baked font and resize a bundled icon through `/_image` to verify the production dependency split.

Record the installed image size with `podman image inspect --format '{{.Size}}' "$image"`. For download size, export a gzip-compressed OCI manifest to a local directory with `podman push --compress --format oci "$image" "dir:$export_dir"` and sum the layer sizes with `jq '[.layers[].size] | add' "$export_dir/manifest.json"`. Compare the installed image against the 250 MiB Green budget. Keep the measurements and image digests with the release verification evidence.


Server output is bundled and minified while retaining function and class names. Preserve named stacks for support diagnostics and the bounded-stream security fixture; renaming `readWithinLimit` hides the fixture's real parser boundary and stalls its held-body acknowledgement. The client keeps Vite's normal minification. After changing server minification, run `task-participant-revocation.spec.ts` against the built output as well as the existing asset budget.

Server dependency bundling applies only during the production server build. Astro dev keeps CommonJS dependencies external so its SSR loader can resolve their native `require` calls. Keep the production bundle and the default dev server working when changing these options.
