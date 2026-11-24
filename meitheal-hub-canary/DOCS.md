# Meitheal Canary documentation

Meitheal Canary is the test channel for Meitheal. Use it to try new features and fixes for tasks, routines, projects and the Home Assistant integration before they go into a Stable release.

The version of each Canary build is the source commit that it comes from. Canary runs in its own app container (`meitheal_canary`).

> **Warning:** Do not use Canary for your everyday tasks. Canary builds can be unstable and they can lose data. Make backups frequently.

## Canary or Stable

| Channel | App | Use it for | Updates |
|---|---|---|---|
| **Stable** | **Meitheal** | Everyday household tasks | Numbered releases |
| **Canary** | **Meitheal Canary** | Tests of new features and fixes | A new build for each change to the source code |

## 1. Install Meitheal Canary

1. In Home Assistant, go to **Settings → Apps → Install app**. On older versions, go to **Settings → Add-ons → Add-on Store**.
2. Open the **⋮** menu in the top-right corner and select **Repositories**.
3. Add `https://github.com/ryan-winkler/meitheal-ha-addon`.
4. Select **Meitheal Canary**, then select **Install**.
5. Select **Start**.
6. If you want Canary in the sidebar, set **Show in sidebar** to on. Then select **Open web UI**.
7. Add a test task in **Today**. Reload the page and make sure that the task is still there.

If a new image is not available yet, read [install status (#1)](https://github.com/ryan-winkler/meitheal-ha-addon/issues/1).

## 2. Keep your data safe during updates

- **An update keeps your database and settings.** When the Board access record matches the database, Canary updates normally.
- **If your installation predates Board access records, prepare it before updating.** A Home Assistant operator must stop Canary and verify a current cold checkpoint held separately before enrolling the existing database. Work stays locked when the operator cannot establish which access rules are current. [Legacy Canary upgrade steps](https://github.com/ryan-winkler/meitheal/blob/dev/docs/kcs/home-assistant-backup-and-restore.md#first-installation-and-a-verified-legacy-upgrade)
- **Keep the Board access record separately.** For recovery, have your Home Assistant operator pair each current cold App backup with its independently retained Board access record. Refresh that checkpoint after each committed access change, Board deletion or Board restore. [Capture and restore a current checkpoint](https://github.com/ryan-winkler/meitheal/blob/dev/docs/kcs/home-assistant-backup-and-restore.md#recover-governed-access-from-a-current-operator-checkpoint)
- **Each channel and repository URL has its own data folder.** Back up Canary before uninstalling it. Plan any move between channels or Store repositories with your Home Assistant operator. [Moving between Store repositories](https://github.com/ryan-winkler/meitheal/blob/dev/docs/kcs/home-assistant-backup-and-restore.md#move-data-between-store-repositories)
- **The Meitheal integration uses a token.** If you use the Meitheal integration in **Settings → Devices & Services**, stop automatic updates before you update. After the update, make sure that your token in **Settings → Automation & AI** is correct. Then make sure that `todo.meitheal_tasks` and the task actions work.

## 3. Set up Meitheal Canary

Canary has the same features and setup as Stable. The [Meitheal documentation](https://github.com/ryan-winkler/meitheal/blob/dev/meitheal-hub/DOCS.md) tells you about:

- Your first five minutes
- Calendar and to-do sync
- The Meitheal integration and Assist
- The Companion app and the PWA
- Exports

Canary has its own tokens. If you connect the Meitheal integration to Canary, make the token in Canary and connect the integration to the Canary app.

## 4. Configuration options

| Option | Default | What it does |
|---|---|---|
| `log_level` | `info` | Sets how much the app writes to the log: `debug`, `info`, `warn` or `error`. |
| `log_categories` | `auth, tasks, integrations, observability, ha, calendar, todo, api, security, search` | Sets which parts of the app write `debug` and `info` messages. The app always writes `warn` and `error` messages. |
| `log_redaction` | `true` | Removes tokens, secrets and passwords from the log. |
| `audit_enabled` | `true` | Records task and token changes in a local audit log. |
| `loki_url` | `""` | Optional. Sends logs to an HTTP or HTTPS push URL for Grafana Loki without embedded credentials. Keep this field empty to turn off remote log forwarding. |
| `license_key` | `""` | Optional. An offline Ed25519 license key. Meitheal has all its functions without a key. |

## 5. Troubleshooting

- **The app restarts by itself.** The watchdog sends `GET /api/health` to internal port `3000`. If Canary does not reply, the watchdog restarts it. Look in the **Log** tab for the cause. For more detail, set `log_level` to `debug`.
- **A new build does not show.** Open the **⋮** menu in the app store and select **Check for updates**.
- **The web UI shows an old build after an update.** Accept the update message in Meitheal, or press `Ctrl+Shift+R` to reload the page.
- **Meitheal says installation continuity is locked.** Stop Canary and have your Home Assistant operator verify the latest recovery checkpoint from this installation. [Recover access from a current checkpoint](https://github.com/ryan-winkler/meitheal/blob/dev/docs/kcs/home-assistant-backup-and-restore.md#recover-governed-access-from-a-current-operator-checkpoint)

The [troubleshooting guide](https://github.com/ryan-winkler/meitheal/blob/dev/docs/kcs/troubleshooting.md) has more solutions.

## 6. Send feedback or report a problem

When you report a problem with Canary, give:

1. The Canary version from the **Info** tab of the app.
2. Your Home Assistant Core and Supervisor versions.
3. What you did, what you expected and what occurred.

Remove all tokens and personal data from logs and screenshots before you send them.

Open an issue at [github.com/ryan-winkler/meitheal-ha-addon/issues](https://github.com/ryan-winkler/meitheal-ha-addon/issues).
