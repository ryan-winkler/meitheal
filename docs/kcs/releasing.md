---
type: "Runbook"
title: "Releasing Meitheal"
description: "Qualify App images and promote a verified version to the Home Assistant App Store."
---

# Releasing Meitheal

Home Assistant discovers both channels through the [current Meitheal add-on repository](https://github.com/Coolock-Village/meitheal-ha-addon). Keep existing Store entries and App slugs when updating a channel. Release workflows in this repository target the personal-account add-on repository after its ownership transfer. The optional Core integration has a separate [Marketplace release process](home-assistant-marketplace.md).

| Channel | Source ref | App version | GHCR image |
| --- | --- | --- | --- |
| Stable | A matching `vX.Y.Z` tag on a commit in `main` | `X.Y.Z` | `ghcr.io/ryan-winkler/meitheal-{arch}:X.Y.Z` |
| Canary | The current `main` commit | The first 12 hexadecimal characters of its commit ID | `ghcr.io/ryan-winkler/meitheal-canary-{arch}:{version}` |

## Qualify the release

1. Run the required checks and review findings for the intended source commit.
2. Follow the [Supervisor devcontainer runbook](home-assistant-devcontainer.md) for ingress, permissions, install, update and restart. Exercise [backup and restore](home-assistant-backup-and-restore.md) with disposable data.
3. Verify the intended Home Assistant version, supported architectures, and the resource budget on the target hardware. Record the tested source commit and image digest.
4. For stable, run `node scripts/bump-version.mjs patch` and update the App changelog. Check the edited files with `node scripts/check-version-sync.mjs`. Merge through the normal review process, then push the exact matching version tag after the reviewed commit reaches `main`.
5. For canary, run the image workflow from `main` after the reviewed commit reaches it. Qualify those exact images before staging App Store discovery. The source canary manifest stays unchanged.

## How CI publishes

The [Stable](../../.github/workflows/publish-addon-images.yml) and [Canary](../../.github/workflows/publish-canary-images.yml) workflows use the same [publication process](../../.github/workflows/publish-app.yml). Native amd64 and ARM64 jobs build and test the images with disposable SQLite data before pushing. Each job checks migrations, starts the packaged server, opens the Today page and creates a task. An existing version tag is accepted only when its image has the expected source revision and App metadata and passes the same smoke test.

For stable, a fresh runner with an empty Docker configuration pulls both versioned images from GHCR and compares their digests with the build job outputs. It uses the App repository credential to commit the manifest, docs and assets with both digests in the commit message. Stable promotion rejects a version lower than the advertised version.

The canary workflow ends after image publication and has no App repository credential. Pull the exact hosted artifacts and record both digests and config IDs. Use the ARM64 artifact for Green qualification, then follow the staging and review steps below.

Both App directories receive the same profile from `meitheal-hub/apparmor.txt`. Supervisor loads it under each installed App ID. Check the effective profile on a host with AppArmor enforcement and keep Protection mode enabled during qualification. [AppArmor in Home Assistant](https://contributors.home-assistant.io/apps/guides/security/#apparmor).

The publication jobs use standard GitHub-hosted Linux runners on both architectures. GitHub makes these runners available without compute charges for public repositories. Private use draws from the account’s included Actions minutes. [Runner reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners) · [Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions)

## Qualify and promote a canary from a release host

Run this from a clean source checkout on a trusted Linux host with Git, Node, jq, GitHub CLI and rootless Podman. When using images already published by CI, skip the local build and registry write in steps 1 and 2. When hosted Actions cannot start, use native ARM64 or configured ARM64 emulation for the local build and smoke test. Coordinate a single publisher before any registry writes and keep other publishers idle. The tag check and push are separate operations.

1. Run `bash scripts/publish-canary-local.sh build amd64` and `bash scripts/publish-canary-local.sh build aarch64`. Each build uses committed source, the same Home Assistant base and the same smoke test as CI. Record both image IDs. Use the exact ARM64 image ID for Green qualification. To transport it, use `podman save --format docker-archive IMAGE_ID` and `podman load`. Verify the ID after loading.
2. After qualification and review, check out current source `main`. If the reviewed commit has a different SHA, build and qualify that exact revision. Keep the two existing package names and verify package access separately from source visibility. A classic PAT with `write:packages` and write access to both packages is required. Pipe it from an approved credential store to `bash scripts/publish-canary-local.sh publish ARCH IMAGE_ID GHCR_USER`. The command rechecks the image ID and smoke test, refuses to replace an existing tag with a different image and prints the published digest. Run it for both architectures.
3. Run `bash scripts/publish-canary-local.sh stage AMD64_DIGEST AMD64_IMAGE_ID ARM64_DIGEST ARM64_IMAGE_ID APP_CHECKOUT` with a clean checkout of the current App repository `main`. It pulls both tags without credentials from an empty image store and verifies their digests, qualified image IDs and App metadata before writing the canary files. If either package denies anonymous access, leave the advertised version alone. Public visibility applies to the whole package, including previous versions. Review the existing images before changing that setting. [GitHub package visibility](https://docs.github.com/en/packages/learn-github-packages/configuring-a-packages-access-control-and-visibility)
4. Review the resulting files. A discovery push can trigger an installation on a device with automatic App updates enabled. Finish Green qualification and capture the target device’s pre-upgrade backup and rollback evidence before pushing. Recheck the current source `main` SHA against the reported revision immediately before submitting the App repository change through its normal branch rules. Include the source revision and both digests in the commit message. Verify the offered and installed versions in Supervisor.

## Verify the contribution check

The [CLA workflow](../../.github/workflows/cla.yml) runs trusted repository code and uses the job token to maintain the signature ledger, post the signing prompt and set the **Contributor License Agreement** status on the checked pull request head. The contributor’s fork code runs in the separate read-only CI workflow. CLA writes run one at a time on the shared ledger branch.

Before enabling the workflow on a new public repository, review the existing signature records for publication and seed `signatures/version1/cla.json` on `cla-signatures` with the approved ledger. For a new ledger, start with `{"signedContributors":[]}`. Preserve valid existing signatures when migrating. The job token needs write access to the ledger branch.

Rehearse from a fresh fork using standard hosted runners. Open a pull request with an unsigned account, confirm the status requires a signature, sign with the documented phrase, and confirm the matching pull request status passes and exactly one ledger entry appears. Repeat a recheck and verify an unrelated user or ordinary issue comment cannot write the ledger. Include simultaneous signatures, a busy pull request thread and two forks with the same branch name in the rehearsal. Require **Contributor License Agreement** from GitHub Actions and the read-only CI checks in the protected branch rules. After the rehearsal, remove the obsolete `CLA_TOKEN` secret if no other workflow uses it.

## Recover a failed run

- If GHCR denies a build job access, verify that the package is linked to the source repository and grants its workflow permission to publish. The build aborts if it cannot distinguish an absent version tag from denied access.
- If anonymous verification fails after a build, check the visibility of both per-architecture packages. Keep the App Store on its advertised version until the images can be pulled without credentials. [Container registry access](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry)
- If the last step cannot write the App repository, verify `ADDON_REPO_TOKEN` has only the permissions required to update contents in that repository. This workflow uses normal Git pushes, which respect branch rules.
- Retry a failed stable run on its matching tag, or a failed canary on current `main`. Keep the same version tag only when it still identifies the same image and source.
- After promotion, reload the App Store in Home Assistant and check that the offered version and installed image match the release commit. If a canary cannot start after an update, follow the [rollback runbook](home-assistant-backup-and-restore.md).

The image build passes the publication version to both Astro and the App runtime. The release smoke check requires the health endpoint to report that version. Local builds without a version override use the stable version in the App manifest.
