---
type: Runbook
title: "Home Assistant Core credentials"
description: "Enroll and rotate a scoped Meitheal API token on the existing Home Assistant integration."
---

# Home Assistant Core credentials

The Meitheal App and the Meitheal integration have separate roles. The App owns tasks and creates API tokens. The integration runs in Home Assistant Core and uses a token to list and manage tasks. A Home Assistant long-lived access token or a Meitheal license key cannot authenticate these requests.

## Enroll during the App upgrade

1. Identify the installer that owns `custom_components/meitheal` and record the existing config entry, to-do entity and associated automation. Back up Core and the Meitheal App using the [backup and restore runbook](home-assistant-backup-and-restore.md).
2. Open the existing Meitheal App through Home Assistant. Find **Agent Tokens** in Meitheal Settings and create a dedicated token for this Core instance. Grant **Read Tasks** (`tasks:read`) and add **Create & Update Tasks** (`tasks:write`), **Delete Tasks** (`tasks:delete`) and **Search** (`search:read`) according to the actions this instance needs. Removing task links uses **Create & Update Tasks**.
3. Install the credential-capable Core integration through its owning installation path while the previous App is still running. Restart Core if the component files changed. Open **Settings → Devices & services → Meitheal → ⋮ → Reconfigure**. Keep the address of the same App and enter the new token. The setup probe reads a task list with a limit of one. The entry reloads with the same entity identifiers.
4. Check that the existing to-do entity updates. With a disposable task, verify any enabled create, edit, complete, search, link and delete actions. Verify the associated automation can still use the same entity ID.
5. Upgrade the App once the authenticated Core connection is verified. Repeat the smoke check, then confirm direct protected API calls with a missing or revoked token receive HTTP 401. A valid token that lacks the required scope receives HTTP 403.

Some older App builds cannot recognize current Supervisor administrator identity. If **Agent Tokens** is unavailable through the normal Home Assistant UI, stage the updated integration and upgrade the App within the same maintenance window. Create the token in the new App, then reauthenticate or reconfigure the existing Core entry. Core task actions can be temporarily unavailable during this sequence. Verify the existing entity and task actions before ending the window.

Keep the previous App running while staging the updated Core integration. If the old App is restarted, its bundled integration can replace the staged files. Check the installed files before restarting Core or switching the App image. The App leaves Core files in place. The integration is distributed separately from the App image, and the App does not request a Home Assistant config mount. A rollback to an older App can reintroduce its startup copy.

A new discovery flow also asks for the token. Supervisor discovery supplies the address. Credentials are entered in the Home Assistant form. On Home Assistant OS, Core can use HTTP on the internal network after Supervisor confirms the exact installed Meitheal App hostname on port 3000. For a manual server address outside that path, use HTTPS with a certificate trusted by Home Assistant. Enter the hostname or IP separately from the port.

## Rotate or recover

When access to the task list is rejected, **Settings → Devices & services** offers **Reauthenticate**. Create a replacement at the existing Meitheal address, submit it, and verify the task entity and any required action. Then revoke the previous token. If only a write, search or delete action receives HTTP 403, use **Reconfigure** with a token that carries the missing scope.

Use **Reconfigure** to change the address. Supply a token issued by the Meitheal server at the new address. A blank token field preserves the current credential when the origin stays the same.

If the old App was upgraded first, reauthenticate the existing Core entry after the 401 response. For a connection error, check that the App is running and the configured host and port match the installed App. For a manual HTTPS connection, verify the certificate chain. The integration rejects redirects. Configure the final address directly.

For rollback, restore the previous App image with its matching App data. Check the installed Core component files against the intended installer, then restart Core and verify the existing entity. If the restored App data predates token creation, create a token on the restored App and reconfigure the existing integration.

Treat the Home Assistant config entry and any backup containing it as sensitive. Meitheal shows the token once at creation. The integration keeps it in Home Assistant's config entry store and omits it from diagnostics.

## Release verification

Run the Core behavior harness with Python 3.14 from `integrations/home-assistant` after installing `requirements-test.txt`. Run `pytest -q`. For Tier 2, open the real **Discovered** Meitheal card and complete its token form in a disposable Home Assistant Supervisor environment. Then repeat enrollment on an existing integration entry during an App upgrade. Check reauthentication after revocation and repeat a create, complete, search and delete cycle on the same existing entity. Record the App and Core versions and the exact candidate image digest.

The existing NFC service points at `POST /api/nfc/complete`. Its server endpoint needs separate implementation and acceptance before NFC completion can be advertised.

[Home Assistant reauthentication](https://contributors.home-assistant.io/core/quality-scale/reauthentication-flow/) · [Home Assistant reconfiguration](https://contributors.home-assistant.io/core/quality-scale/reconfiguration-flow/)
