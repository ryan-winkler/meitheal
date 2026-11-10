---
type: Runbook
title: "Home Assistant Marketplace packaging"
description: "Stage, validate, install, and update the separate Meitheal Core integration package."
---

# Home Assistant Marketplace packaging

Home Assistant installs the Meitheal Core integration from a separate integration-only repository. The App repository remains the install source for the Meitheal server. The integration uses the existing `meitheal` domain and connects through the Meitheal API. Its minimum tested Core version is 2026.10.4. The built-in Marketplace UI requires Home Assistant 2026.11. [Repository structure](https://contributors.home-assistant.io/marketplace/reference/repository-structure/) · [Home Assistant 2026.11 release](https://www.home-assistant.io/blog/2026/11/04/release-202611/)

## Stage a release candidate

1. Run the Core credential tests from `integrations/home-assistant` with Python 3.14. Install `requirements-test.txt` in a fresh environment for Core 2026.11.1 and `requirements-test-2026.10.txt` in a separate environment for Core 2026.10.4. Run `python -m pytest -q` in each environment.
2. Stage an integration archive from the tested source commit. Choose a new output path and supply the integration repository's GitHub owner and name.

   ```sh
   python scripts/stage-home-assistant-integration.py /tmp/meitheal-integration.zip --ref HEAD --repository OWNER/REPOSITORY
   unzip -l /tmp/meitheal-integration.zip
   ```

3. Compare the SHA-256 printed by the script with a second build of the same commit and repository name. The staged manifest links to that repository's README and Issues tab. Check both URLs anonymously before publishing a release. The archive contains the Apache license, README, Marketplace metadata, runtime and validation workflow. Extract it at the integration repository root. Match the GitHub Release tag to the manifest version.
4. Require both staged jobs to pass on the integration repository. The HACS job checks the integration category with no ignored checks, and hassfest validates the integration. Set the repository description, add relevant topics, and enable Issues. Verify the custom install link and a tagged upgrade on a disposable Home Assistant instance before requesting catalog inclusion. [Validation checks](https://contributors.home-assistant.io/marketplace/reference/validation/)

## Test an installer handoff

Back up Home Assistant and record the existing Meitheal config entry and to-do entity ID. Follow the credential and rollback runbook before switching installation ownership. An older App release can overwrite integration files it manages on startup.

On a disposable Supervisor instance, install the staged integration through Marketplace or manually for a local test. Accept discovery or reconfigure the existing Meitheal entry. Enter a scoped token and exercise read, create, complete, search and delete against disposable tasks. Update the integration and restart Core, then confirm the same entity and automation references work. If an update fails, restore the prior component files and restart Core without removing the config entry. [Core credentials and rollback](home-assistant-core-credentials.md)

On Core 2026.11, check that **Meitheal Tasks (read only)** appears in the conversation agent's LLM API settings. Test keyword search and lookup by ID with an active administrator and a disposable task. Verify access fails for a member, for a caller without a user ID, and for a cached session after the administrator loses access or the integration unloads. On Core 2026.10.4, verify the integration's to-do entity and actions with the optional LLM registry disabled.
