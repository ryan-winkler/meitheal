# Meitheal for Home Assistant

![Meitheal](custom_components/meitheal/brand/icon.png)

Connect Home Assistant to your Meitheal server. The integration exposes your task list as a Home Assistant to-do entity and adds task count sensors and actions for creating, completing, searching and refreshing tasks. Your task data stays in Meitheal.

## Requirements

Run Meitheal as a Home Assistant App or use a Meitheal server accessible from Home Assistant. The Home Assistant Core minimum for this package is 2026.10.4. The built-in Marketplace is available starting with Home Assistant 2026.11. [Home Assistant 2026.11 release notes](https://www.home-assistant.io/blog/2026/11/04/release-202611/).

<!-- ha-marketplace:exclude-start -->
## Install

Use one installer for `custom_components/meitheal`. If your Meitheal App release manages the integration, follow that release's instructions. When a public integration repository is available, add its URL through **Settings → Marketplace → Add from link** and install **Meitheal**. For a manual install, copy `custom_components/meitheal` into the `custom_components` folder in your Home Assistant configuration, then restart Home Assistant.

For an existing installation, back up Home Assistant before switching installers. Keep the existing Meitheal integration entry and check that its to-do entity ID survives the switch. [Home Assistant Marketplace](https://www.home-assistant.io/integrations/marketplace).
<!-- ha-marketplace:exclude-end -->

## Connect to Meitheal

1. Open Meitheal through Home Assistant and create a dedicated agent token. Grant **Read Tasks** and any other task or search permissions your automations need.
2. Open **Settings → Devices & services** in Home Assistant and accept the Meitheal discovery flow. If the integration is already configured, open its menu and choose **Reconfigure**.
3. Enter the dedicated token. For a manually configured server, enter the hostname and port separately, and use HTTPS with a certificate trusted by Home Assistant. Supervisor discovery can use the verified App address on its private network.
4. Open the Meitheal to-do entity and confirm it shows your tasks. Try a disposable task before updating automations.

If Meitheal rejects the token, create a new one and use **Reauthenticate**. Revoke the previous token after the entity and enabled actions work with the replacement. Keep Home Assistant backups private, since config entries store tokens.

## Use Assist

Review the Meitheal to-do entity under **Settings → Voice assistants → Expose**. Home Assistant controls its exposure. If an earlier integration exposed it automatically, review that choice after updating.

For voice capture, give the Core integration **Read Tasks** and **Create & Update Tasks**. Reserve **Delete Tasks** for installations that deliberately allow Core to delete Meitheal tasks. Home Assistant's built-in Todo removal can use that permission. Configured Meitheal custom sentences require an active Home Assistant administrator.

## Optional conversation tools

On Core 2026.11 or later, an active Home Assistant administrator can select **Meitheal Tasks (read only)** in a conversation agent's LLM API settings. It provides keyword search and task lookup by ID through the configured integration entry. The selected agent receives the task data these tools return. Use the existing Home Assistant actions or the Meitheal app to change tasks. Core 2026.10.4 supports the integration's to-do entity, sensors, and actions.

## Recover after an update

If an update fails, reinstall the last working release or restore the previous `custom_components/meitheal` files, then restart Home Assistant. Keep the existing integration entry so its entity IDs and automation references are preserved.

Use this repository’s **Issues** tab for reproducible integration bugs. Include the Home Assistant Core and integration versions and the step that failed. Remove tokens and personal task data from logs or screenshots.

## License

The Home Assistant integration is distributed under the [Apache License 2.0](LICENSE).
