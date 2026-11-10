---
type: Runbook
title: "Home Assistant backup and restore"
description: "Back up, restore, and verify Meitheal with the Home Assistant Supervisor."
---

# Home Assistant backup and restore

Stable and canary use Supervisor-managed cold backups. Supervisor stops a running Meitheal app before archiving its data and starts it again afterward. The app is unavailable during the snapshot. [Home Assistant app backup configuration](https://contributors.home-assistant.io/apps/reference/configuration/#backups)

## What is protected

The app backup contains Meitheal's persistent `/data` volume and Supervisor app options. This includes `meitheal.db` and its SQLite WAL and shared-memory files when present. The app excludes disposable `*.log` and `*.tmp` files. Keep all SQLite recovery files together.

A Meitheal-only backup covers the selected app. Home Assistant Core settings, separately managed integration files and browser-local state have separate backup paths. Supervisor backs up registry image metadata for a prebuilt app and requires the matching image during a restore to a different version or host. [Home Assistant Supervisor backup implementation](https://github.com/home-assistant/supervisor/blob/2026.10.5/supervisor/apps/app.py)

Task and Settings downloads are portable exports. The Settings export includes eligible preferences, shortcuts, layouts, rules and framework overrides. Enter credentials separately when moving the exported settings to a fresh installation.

The **Download database** action under **Settings → App & PWA** is available to verified Home Assistant administrators. It copies a consistent snapshot of the local SQLite database, including writes already committed in the WAL. It needs enough free space for one temporary copy on the database volume. Only one download can prepare or read that copy at a time. Retry after the first finishes or is cancelled. If the app loses power during a copy, a private `.meitheal-export-*` folder may remain beside the database. With Meitheal stopped, remove the incomplete temporary folder before retrying.

Confirm the download in Settings. The browser submits a native form and saves the streamed attachment. If the app has restarted or Settings has been open for more than 15 minutes, refresh Settings before retrying. The form is tied to the signed-in administrator and direct links to the download endpoint return a method error.

Keep the download private. Use the Supervisor backup to recover the complete app, including its options and other files in `/data`. For a remote database, use its host's backup tools. [SQLite online backup](https://www.sqlite.org/backup.html)

The download needs an online connection. If an edited download URL fails, open it again from **Settings → App & PWA**. Reload Meitheal and activate the app update on browsers that used an older build to remove old cached export URLs.

## Automatic startup database snapshots

For an existing nonempty local SQLite database, the migration runner saves a consistent snapshot before applying SQL changes. If you start the web server directly, its first schema initialization takes the snapshot instead. The packaged launchers coordinate so each successful startup makes one backup attempt.

The snapshot includes committed WAL data. Meitheal publishes the completed file as `backups/meitheal-<timestamp>.db` beside the database and keeps the five newest named snapshots. If it cannot complete a snapshot, it logs the failure and continues startup. Fresh, in-memory and remote databases skip this local backup. Use a verified Supervisor backup for the complete App recovery point.

## Create a backup

1. Open **Settings → System → Backups → Backup now → Manual backup** in Home Assistant.
2. Select the installed Meitheal app, name the backup and choose an approved location. Confirm the app and version in the completed backup details.
3. Keep an off-device copy and its emergency kit available to the operator. App data and options can include private household information or credentials.
4. If the app was running, confirm it returns to service. Open the Meitheal ingress page and confirm `GET /api/health` reports a healthy database.

## Checkpoint a legacy installation before upgrading

An installed app can still use the former hot backup configuration even when the repository has a newer cold-backup manifest. A checkpoint can flush committed WAL frames and still allow a new write while an archive is being created.

1. Record the installed channel, app slug, version and exact image digest. Preserve access to the prior image, including its tag and architecture. If the registry image is unavailable, retain an off-device image copy and rehearse a compatible rollback before proceeding.
2. Use an approved outage window. Stop only Meitheal in **Settings → Apps** and confirm it is stopped. Create a manual backup selecting only that installed app. Download and verify the backup and recovery material before proceeding.
3. If the app was running before the checkpoint, start it and confirm ingress and health. Keep the checkpoint off-device through the upgrade. Home Assistant's optional update backup is an additional recovery point.
4. Check which installer owns any existing Meitheal custom integration. An app upgrade can leave a legacy `custom_components/meitheal/backup.py` behind in a previously copied integration directory. Verify the installed component has been updated through its owning installation path before accepting the backup behavior. Check Core logs for calls to the old backup endpoints. Keep an integration rollback copy if separately upgrading the integration.

## Restore and verify

Restore only the matching Meitheal app from the selected Home Assistant backup. The stable and canary apps have separate data volumes. For a version rollback, restore the prior image and its pre-upgrade data together.

1. Wait for Supervisor to finish and verify the exact restored app version and image.
2. Start the app if it was stopped at backup time, then check ingress and `GET /api/health`.
3. Verify a known task, relation and setting match the backup point.
4. In the disposable Home Assistant devcontainer, run `PRAGMA integrity_check` on a restored copy of `/data/meitheal.db`. Require `ok` and verify the migration and app logs.

If the restored app cannot start, preserve the backup and check Supervisor and app logs. Verify that the old image can be retrieved and the backup contains the selected app. If database integrity fails, keep the restored app stopped and use the last verified backup.

## Tier 2 acceptance

In the editor-managed Home Assistant devcontainer, seed a task, related data and settings, then create a Supervisor backup while Meitheal runs. Observe a stop before archiving and a restart afterward. Make a second write, restore the backup and verify that the first write survived, the second is absent, and ingress and database integrity pass. Repeat with the app already stopped and confirm backup leaves it stopped. Record the image digest and outage.

Before updating the Green, rehearse the older app and data rollback on a disposable Supervisor. A locally tested archive proves file recovery. It takes a Supervisor rehearsal to verify the lifecycle and a Green run to verify device acceptance.
