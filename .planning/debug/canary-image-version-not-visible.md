---
status: investigating
trigger: "Solve this for me. The packages when Looking at them in the now private repo says 20 hours ago, but the Canary images ARE successfully publishing, But neither whatever that sees nor HA supervistor is seeing the new version. WHat happened? Can you fix it?"
created: 2026-03-20T00:00:00Z
updated: 2026-03-20T21:35:00Z
---

# Canary Image Version Not Visible

## Current Focus

hypothesis: the root cause is stale remote state, not stale local state; Home Assistant is correctly reading origin/main while this environment cannot push the newer local commits because Git auth is broken
test: compare HEAD with origin/main and verify whether push/auth is currently functional in this shell
expecting: origin/main remains on an old canary version and push attempts fail with credential-helper or PAT auth errors
next_action: hand off the required human push/auth recovery step

## Symptoms

expected: each successful canary publish to main should surface as a new canary image/version that package views and Home Assistant Supervisor can detect
actual: canary images appear to publish successfully, but the package view still shows stale publish timing and Home Assistant Supervisor does not see a newer version
errors: no explicit workflow failure reported; symptom is stale version visibility despite successful canary publishing
reproduction: push changes to main, observe successful canary image publish, then inspect package visibility and Home Assistant Supervisor update detection
started: at least by the current successful canary publishes visible around 20 hours after the package timestamp shown in the private repo UI

## Eliminated

- hypothesis: Home Assistant categorically cannot use private GHCR images
  evidence: Supervisor code supports configured registry credentials for custom registries including ghcr.io and passes them to image pull and manifest fetch paths
  timestamp: 2026-03-20T21:20:00Z

- hypothesis: canary SHA versions are rejected because Supervisor requires ordered semver for update visibility
  evidence: add-on update visibility uses version inequality for installed vs latest addon version; strict ordering is not required just to show an update
  timestamp: 2026-03-20T21:20:00Z

## Evidence

- timestamp: 2026-03-20T21:00:00Z
  checked: Home Assistant publishing/configuration docs
  found: When using the image field, add-on config version must match the image tag that will be pulled
  implication: successful canary image publishes alone are insufficient; config.yaml version must move in lockstep for Supervisor to detect a new build

- timestamp: 2026-03-20T21:05:00Z
  checked: private repo canary workflow and update script
  found: publish-canary-images.yml pushes ghcr.io/coolock-village/meitheal-canary-{arch}:{sha_short} and separately updates meitheal-hub-canary/config.yaml to that same short SHA
  implication: the intended design is valid; the bug is in propagation/visibility rather than basic workflow intent

- timestamp: 2026-03-20T21:10:00Z
  checked: Supervisor add-on update logic
  found: installed add-on update availability is based on installed version != latest store version, while private registry credentials are supported separately through docker registry config
  implication: a PAT for private Git repo access does not by itself prove Supervisor can access private ghcr images, and lack of semver ordering is not enough to explain missing update visibility

- timestamp: 2026-03-20T21:30:00Z
  checked: local HEAD versus origin/main
  found: local HEAD is 45ea79a4b6d91cf9f2b3538ac476fd123b9c99f9 while origin/main is c221e98620db047c8657e401745397da8f4db93b, and origin/main still has meitheal-hub-canary/config.yaml version 0879714
  implication: Home Assistant is seeing the old remote version because the newer canary-related commits were never pushed to GitHub

- timestamp: 2026-03-20T21:32:00Z
  checked: direct git authentication to origin
  found: git remote access fails in this shell with missing gh credential helper and stale VS Code askpass path, ending in invalid username or token authentication failure
  implication: I cannot complete the remote fix from this environment without a working PAT-backed git authentication path

## Resolution

root_cause: The private GitHub repository remote is stale. Home Assistant is correctly reading origin/main at canary version 0879714, while the newer local canary-related commits exist only in the local clone and have not been pushed. A separate environment issue blocks pushing: git auth in this shell is broken because the configured credential helper/askpass path is invalid.
fix: Pending push of the local main branch to origin using a working PAT-backed git authentication path. No repository code change is required to make Home Assistant notice the newer version once the updated config.yaml reaches origin/main.
verification: Verified by comparing local HEAD to origin/main and by reading origin/main:meitheal-hub-canary/config.yaml, which still advertises version 0879714.
files_changed: []
