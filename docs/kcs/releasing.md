---
type: "Runbook"
title: "Releasing Meitheal"
description: "Qualify App images and promote a verified version to the Home Assistant App Store."
---

# Releasing Meitheal

Home Assistant discovers both channels through the [Meitheal add-on repository](https://github.com/ryan-winkler/meitheal-ha-addon). Keep existing Store entries and App slugs when updating a channel. The optional Core integration has a separate [Marketplace release process](home-assistant-marketplace.md).

Maintain one Canary App entry in `meitheal-hub-canary/config.yaml`, with slug `meitheal_canary` and image family `ghcr.io/ryan-winkler/meitheal-canary-{arch}`. Settings and other feature work ship through this same Canary. The Stable manifest remains in `meitheal-hub/config.yaml` with slug `meitheal`. Release preparation, image metadata and staging validate both canonical manifests and reject additional root App manifests, including Settings, preview and extra experimental variants. Staging checks the destination repository before writing files. Remove an obsolete extra manifest through its reviewed retirement process before staging.

This repository guard covers the release tooling. Supervisor installations from other repositories or manually created local Apps require separate device checks and cleanup.

## Move a Canary from the legacy private Store repository

Supervisor derives the installed App ID from its repository URL. The public repository gives Meitheal Canary a new internal ID. Use the public HTTPS URL without credentials. [Supervisor Store API](https://contributors.home-assistant.io/apps/supervisor-api/store/)

After the public ARM64 image passes the Green benchmark and publishes, add the public repository and confirm that it offers the qualified version. Before uninstalling the legacy Canary, retain an App-only Supervisor backup and verify access to its exact rollback image. Rehearse the [database and App-option transfer](home-assistant-backup-and-restore.md#move-data-between-store-repositories) in an isolated Supervisor first; a new repository ID does not inherit the old data volume, and Settings JSON does not include tasks or protected credentials.

Keep at most one Canary installed during the transition: uninstall the legacy Canary before installing **Meitheal Canary** from the public repository. Transfer the verified data and compatible App options, then verify health, authenticated ingress, settings, tasks and restart persistence. Update saved Home Assistant shortcuts and any separately installed Meitheal integration that still targets the old App hostname. Keep the legacy recovery material until acceptance and a matching backup of the new App are verified. Remove the legacy repository once no installed Apps depend on it.

| Channel | Source ref | App version | GHCR image |
| --- | --- | --- | --- |
| Stable | A matching `vX.Y.Z` tag on a commit in `main` | `X.Y.Z` | `ghcr.io/ryan-winkler/meitheal-{arch}:X.Y.Z` |
| Canary | The current `main` commit | The first 12 hexadecimal characters of its commit ID | `ghcr.io/ryan-winkler/meitheal-canary-{arch}:{version}` |

## Qualify the release

The [CI workflow](../../.github/workflows/ci.yml) runs on pull requests and pushes to `main`. Feature branch updates use the pull request run to avoid duplicate push and pull request checks for the same update. Push checks on `main` verify the merged source; pushes changing only `meitheal-hub-canary/config.yaml` remain excluded.

1. Run the required checks and review findings for the intended source commit.
2. Follow the [Supervisor devcontainer runbook](home-assistant-devcontainer.md) for ingress, permissions, install, update and restart. Exercise [backup and restore](home-assistant-backup-and-restore.md) with disposable data.
3. Verify the intended Home Assistant version, supported architectures, and the resource budget on the target hardware. Record the tested source commit and image digest.
4. For stable, run `node scripts/bump-version.mjs patch` and update the App changelog. Check the edited files with `node scripts/check-version-sync.mjs`. Merge through the normal review process, then push the exact matching version tag after the reviewed commit reaches `main`.
5. For canary, use the hosted smoke workflow to check native builds from `main`. Build and retain the candidate images on the release host. Qualify those exact images before publication.

## Hosted builds and stable publication

The [Stable workflow](../../.github/workflows/publish-addon-images.yml) builds and tests images on native amd64 and ARM64 runners before pushing to GHCR. The smoke test checks migrations, starts the packaged server with disposable SQLite data, opens Today and creates a task. An existing version tag is accepted only when its image has the expected source revision and App metadata and passes the same smoke test.

For stable, a fresh runner with an empty Docker configuration pulls both versioned images from GHCR and compares their digests with the build job outputs. It uses the App repository credential to commit the manifest, docs and assets with both digests in the commit message. Stable promotion rejects a version lower than the advertised version.

The [Canary workflow](../../.github/workflows/publish-canary-images.yml) runs the same build and smoke test on both native architectures. It uses local image tags and has no package permissions or App repository credential. Build results are recorded in Actions. Use the release-host procedure below for retained images, hardware qualification and publication.

Check system library versions in the built images before promotion. The runtime Dockerfile requires zlib 1.4 or later so a cached Home Assistant base cannot retain an older version. [Alpine security tracker](https://security.alpinelinux.org/vuln/CVE-2026-4738)

Both App directories receive the same profile from `meitheal-hub/apparmor.txt`. Supervisor loads it under each installed App ID. Check the effective profile on a host with AppArmor enforcement and keep Protection mode enabled during qualification. [AppArmor in Home Assistant](https://contributors.home-assistant.io/apps/guides/security/#apparmor).

Both workflows use standard GitHub-hosted Linux runners on both architectures. GitHub makes these runners available without compute charges for public repositories. Private use draws from the account’s included Actions minutes. [Runner reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners) · [Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions)

## Qualify and promote a canary from a release host

Run this from a clean source checkout on a trusted Linux host with Git, Node, Python 3.10 or later, jq, GitHub CLI and rootless Podman. Build ARM64 natively or with configured ARM64 emulation, then qualify it on the physical Green. Coordinate a single publisher before any registry writes and keep other publishers idle. The tag check and push are separate operations.

1. Run `bash scripts/publish-canary-local.sh build amd64` and `bash scripts/publish-canary-local.sh build aarch64`. Each build uses committed source, the same Home Assistant base and the same smoke test as CI. Retain both images and record their full `sha256:` config IDs. To transport the ARM64 image, use `podman save --format docker-archive IMAGE_ID` and `podman load`. Verify the ID after loading and save the raw fixed 2,000-task Green benchmark log as a regular file. Keep the log with the private release evidence.
2. After qualification and review, check out current source `main`. If the reviewed commit has a different SHA, build and qualify that exact revision. Use a classic PAT with `write:packages` and access to both canonical per-architecture packages. Pipe it from an approved credential store for each command. Publish ARM64 first, then publish the AMD64 sibling from the same source revision. Supply the same Green receipt and ARM64 ID to both commands.

   ```sh
   bash scripts/publish-canary-local.sh publish aarch64 ARM64_IMAGE_ID GHCR_USER ARM64_IMAGE_ID GREEN_RECEIPT
   bash scripts/publish-canary-local.sh publish amd64 AMD64_IMAGE_ID GHCR_USER ARM64_IMAGE_ID GREEN_RECEIPT
   ```

   Before registry login, the command recomputes the Green gates from the raw log and checks the exact ARM64 config ID, running version and retained image metadata. The receipt must include the driver’s measured wall time, samples at the expected cadence and a final cleanup marker after the measurements and health checks. The command smoke-tests the image being published and refuses to replace an existing tag with a different image. After the push it verifies the digest and image metadata with a fresh anonymous pull before printing the digest. The receipt must come from the trusted release operator’s physical run. The verifier checks consistency and thresholds, and the raw log carries no signature attesting to its origin.

   The publisher can create a tag when the authenticated registry lookup reports that the tag or package does not exist. Authentication, permission and service errors stop publication. GitHub initially creates personal Container Registry packages as private. On the first publication, an image push can succeed while the anonymous verification still fails. Review the package history and image identity in the canonical namespace before making each package public. GitHub applies public visibility permanently to the package and its entire version history. Retry the publish command with the identical image ID and Green receipt to verify the existing tag. [GitHub Container Registry publishing](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry#pushing-container-images)

3. Run `bash scripts/publish-canary-local.sh stage AMD64_DIGEST AMD64_IMAGE_ID ARM64_DIGEST ARM64_IMAGE_ID APP_CHECKOUT GREEN_RECEIPT` with a clean checkout of the current App repository `main`. It rechecks the Green receipt and pulls both tags without credentials from an empty image store. It verifies their digests, qualified image IDs and App metadata before writing the canary files. If either package denies anonymous access, leave the advertised version alone. Public visibility applies to the whole package, including previous versions. Review the existing images before changing that setting. [GitHub package visibility](https://docs.github.com/en/packages/learn-github-packages/configuring-a-packages-access-control-and-visibility)
4. Review the resulting files. A discovery push can trigger an installation on a device with automatic App updates enabled. Capture the target device’s pre-upgrade backup and rollback evidence before pushing. Recheck the current source `main` SHA against the reported revision immediately before submitting the App repository change through its normal branch rules. Include the source revision and both digests in the commit message. Verify the offered and installed versions in Supervisor.

### Read the Green performance receipt

Run `python3 scripts/verify-canary-green.py --report GREEN_RECEIPT ARM64_IMAGE_ID VERSION`, using the 12-character Canary version. The JSON reports individual gates even when a complete receipt fails. The command still exits nonzero on failure. Keep the raw receipt with the report.

| Release gate | What the fixed workload measures |
| --- | --- |
| Idle memory below 64 MiB | The largest of 12 cgroup `memory.current` samples under the nearest-rank p95 calculation. |
| Active memory below 96 MiB | Nearest-rank p95 of sampled `memory.current` during the 105-cycle workload. The report also includes the sampled maximum and the observed cgroup high-water mark when available. |
| Mean active CPU at or below 15% of one core | Cgroup CPU time divided by the elapsed time between active samples. The window includes the fixed 2.5-second pause in each cycle. The report also includes interval CPU and throttling to show bursts the mean can hide. |
| Every route p95 at or below 350 ms | The 100th value in ascending order for each set of 105 complete loopback HTTP responses. The report shows p50, maximum and the number above 350 ms, so up to five slow responses remain visible even when the gate passes. |

Charged cgroup memory includes anonymous memory, file cache and kernel charges. Treat a single run as a repeatable release screen. Record repeated runs with the same image and workload when investigating variance. For installed acceptance, separately check browser interactions through Home Assistant ingress and observe the installed App with Home Assistant connected. Loopback curl records the full response, including transfer and writing the response to a file. Browser rendering, ingress and Home Assistant integrations have separate costs. [Linux cgroup memory accounting](https://docs.kernel.org/admin-guide/cgroup-v2.html#memory-interface-files) · [curl timing fields](https://curl.se/docs/manpage.html#-w)

## Verify the contribution check

The [CLA workflow](../../.github/workflows/cla.yml) runs trusted repository code and uses the job token to maintain the signature ledger, post the signing prompt and set the **Contributor License Agreement** status on the checked pull request head. The contributor’s fork code runs in the separate read-only CI workflow. CLA writes run one at a time on the shared ledger branch.

Before enabling the workflow on a new public repository, review the existing signature records for publication and seed `signatures/version1/cla.json` on `cla-signatures` with the approved ledger. For a new ledger, start with `{"signedContributors":[]}`. Preserve valid existing signatures when migrating. The job token needs write access to the ledger branch.

Rehearse from a fresh fork using standard hosted runners. Open a pull request with an unsigned account, confirm the status requires a signature, sign with the documented phrase, and confirm the matching pull request status passes and exactly one ledger entry appears. Repeat a recheck and verify an unrelated user or ordinary issue comment cannot write the ledger. Include simultaneous signatures, a busy pull request thread and two forks with the same branch name in the rehearsal. Require **Contributor License Agreement** from GitHub Actions and the read-only CI checks in the protected branch rules. After the rehearsal, remove the obsolete `CLA_TOKEN` secret if no other workflow uses it.

## Recover a failed run

- If GHCR denies a stable publication job access, verify that the package is linked to the source repository and grants its workflow permission to publish. Publication aborts if it cannot distinguish an absent version tag from denied access. For canary, check the release-host credential and access to both packages.
- If anonymous verification fails after publication, check the visibility of both per-architecture packages. A successful push may have already created the tag. Retry with the same image and receipt once access is fixed. Keep the App Store on its advertised version until the images can be pulled without credentials. [Container registry access](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry)
- If the last step cannot write the App repository, verify `ADDON_REPO_TOKEN` has only the permissions required to update contents in that repository. This workflow uses normal Git pushes, which respect branch rules.
- Retry a failed stable run on its matching tag, or a failed canary smoke run on current `main`. For a failed canary publication, retry with the same qualified image ID and source revision.
- After promotion, reload the App Store in Home Assistant and check that the offered version and installed image match the release commit. If a canary cannot start after an update, follow the [rollback runbook](home-assistant-backup-and-restore.md).

The image build passes the publication version to both Astro and the App runtime. The release smoke check requires the health endpoint to report that version. Local builds without a version override use the stable version in the App manifest.
