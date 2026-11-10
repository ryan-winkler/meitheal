---
type: Runbook
title: "Home Assistant Marketplace packaging"
description: "Stage, validate, install, and update the separate Meitheal Core integration package."
---

# Home Assistant Marketplace packaging

Home Assistant installs the Meitheal Core integration from a separate integration-only repository. The App repository remains the install source for the Meitheal server. The integration uses the existing `meitheal` domain and connects through the Meitheal API. Its minimum tested Core version is 2026.10.4. The built-in Marketplace UI requires Home Assistant 2026.11. [Repository structure](https://contributors.home-assistant.io/marketplace/reference/repository-structure/) · [Home Assistant 2026.11 release](https://www.home-assistant.io/blog/2026/11/04/release-202611/)

## Stage a release candidate

1. Run the Core credential tests from `integrations/home-assistant` with Python 3.14. Install `requirements-test.txt` in a fresh environment for Core 2026.11.0 and `requirements-test-2026.10.txt` in a separate environment for Core 2026.10.4. Run `python -m pytest -q` in each environment.
2. Stage an integration archive from the tested source commit. Choose a new output path.

   ```sh
   python scripts/stage-home-assistant-integration.py /tmp/meitheal-integration.zip --ref HEAD
   unzip -l /tmp/meitheal-integration.zip
   ```

3. Compare the SHA-256 printed by the script with a second build of the same commit. Stage the extracted tree at the integration repository root. The archive contains the Apache license, README, Marketplace metadata and `custom_components/meitheal` runtime. The manifest version and the integration repository's release tag must agree.
4. Run hassfest and the HACS validation action with the integration category on the staged repository. A published listing also needs repository description, topics and an enabled issue tracker. Verify the custom install link and a tagged upgrade on a disposable Home Assistant instance before requesting catalog inclusion. [Validation checks](https://contributors.home-assistant.io/marketplace/reference/validation/)

## Test an installer handoff

Back up Home Assistant and record the existing Meitheal config entry and to-do entity ID. Follow the credential and rollback runbook before switching installation ownership. An older App release can overwrite integration files it manages on startup.

On a disposable Supervisor instance, install the staged integration through Marketplace or manually for a local test. Accept discovery or reconfigure the existing Meitheal entry. Enter a scoped token and exercise read, create, complete, search and delete against disposable tasks. Update the integration and restart Core, then confirm the same entity and automation references work. If an update fails, restore the prior component files and restart Core without removing the config entry. [Core credentials and rollback](home-assistant-core-credentials.md)
