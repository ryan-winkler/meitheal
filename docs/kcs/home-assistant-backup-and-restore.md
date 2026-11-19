---
type: Runbook
title: "Home Assistant backup and restore"
description: "Back up, restore, and verify Meitheal with the Home Assistant Supervisor."
---

# Home Assistant backup and restore

Stable and canary use Supervisor-managed cold backups. Supervisor stops a running Meitheal app before archiving its data and starts it again afterward. The app is unavailable during the snapshot. [Home Assistant app backup configuration](https://contributors.home-assistant.io/apps/reference/configuration/#backups)

Use the Home Assistant backup controls for a database that contains a named Board, Personal Pillar, personal display label, Selected people or Nobody audience, or task location. Changing a restricted audience back to Everyone keeps the database protected from raw download. Named Board access uses a separate revision file and a pending publication directory excluded from the App backup. A live interruption can finish publishing an exact matching committed revision from that directory. Supervisor can remove the excluded marker while replacing App data during restore. Exclusion does not make the marker survive. A missing or mismatched current revision keeps governed Board access closed. The App keeps its existing filesystem permissions; recovery uses the separately retained operator checkpoint described below.

## What is protected

The app backup contains Meitheal's persistent `/data` volume and Supervisor app options. This includes `meitheal.db` and its SQLite WAL and shared-memory files when present. The app excludes disposable `*.log` and `*.tmp` files. Keep all SQLite recovery files together.

A Meitheal-only backup covers the selected app. Home Assistant Core settings, separately managed integration files and browser-local state have separate backup paths. Supervisor backs up registry image metadata for a prebuilt app and requires the matching image during a restore to a different version or host. [Home Assistant Supervisor backup implementation](https://github.com/home-assistant/supervisor/blob/2026.10.5/supervisor/apps/app.py)

Task and Settings downloads are portable exports. The Settings export includes eligible preferences, shortcuts, layouts, rules and framework overrides. Enter credentials separately when moving the exported settings to a fresh installation.

The **Raw DB** action under **Settings → Backups & Reset → Data Portability** is available to Home Assistant's verified current owner. The raw download is available for databases without personal or restricted records. Supervisor backups retain Personal Pillars and Principles under the storage operator’s custody. A restore keeps Personal Pillars tied to their original Home Assistant user IDs. A user missing from the restored Home Assistant instance has no Personal Pillar access. It copies a consistent snapshot of the local SQLite database, including writes already committed in the WAL. It needs enough free space for one temporary copy on the database volume. Only one download can prepare or read that copy at a time. Retry after the first finishes or is cancelled. If the app loses power during a copy, a private `.meitheal-export-*` folder may remain beside the database. With Meitheal stopped, remove the incomplete temporary folder before retrying.

Confirm the download in Settings. The browser submits a native form and saves the streamed attachment. If the app has restarted or Settings has been open for more than 15 minutes, refresh Settings before retrying. The form is tied to the signed-in administrator and direct links to the download endpoint return a method error.

Keep the download private. Use the Supervisor backup to recover the complete app, including its options and other files in `/data`. For a remote database, use its host's backup tools. [SQLite online backup](https://www.sqlite.org/backup.html)

The download needs an online connection to Home Assistant Core. Meitheal checks the administrator’s current account before creating a snapshot. If Core cannot verify access, wait for it to reconnect and retry. If an edited download URL fails, open it again from **Settings → Backups & Reset → Data Portability**. Reload Meitheal and activate the app update on browsers that used an older build to remove old cached export URLs.

## Automatic startup database snapshots

For an existing nonempty local SQLite database, the migration runner saves a consistent snapshot before applying SQL changes. If you start the web server directly, its first schema initialization takes the snapshot instead. The packaged launchers coordinate so each successful startup makes one backup attempt.

The snapshot includes committed WAL data. Meitheal publishes the completed file as `backups/meitheal-<timestamp>-<unique-id>.db` beside the database and keeps the five newest named snapshots. If it cannot complete a snapshot, it logs the failure and continues startup. Fresh, in-memory and remote databases skip this local backup. Use a verified Supervisor backup for the complete App recovery point.

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

## Recover governed access from a current operator checkpoint

The Supervisor archive alone cannot establish current Board permissions. Keep the published `/data/meitheal-board-grants.json` in protected operator custody **outside** the App archive, paired with a verified current checkpoint. Do not add it to the backup or reconstruct its revision from a restored database. This procedure needs operator access to the App's local volume; there is no in-app unlock or database import endpoint.

### Capture and refresh

<!-- coderabbit-ai-generated:v1 -->

<!-- coderabbit-ai-generated-section:v1:7eb9efe052af59d3c1daad32a5fef1df4c33c5ebb7f30a7ee047e677e613592a -->

1. Establish continuity while the known current App is running. Verify the current Home Assistant owner through Core and check the expected Board roster, authorized reader and denied reader. An empty database and absent marker do not establish first enrollment. There is currently no supported trusted first-enrollment procedure; access stays locked until a named owner-approved enrollment procedure establishes current custody. An existing installation needs its confirmed live upgrade or an independently trusted current checkpoint. A markerless restored database is not proof of first enrollment.

<!-- /coderabbit-ai-generated:v1 -->
2. Record the App slug, channel, architecture, exact image/config identity and full source revision. Record the actual `/data` mount before stopping; Supervisor can remove its runtime container on stop. Stop only Meitheal and wait for its lifecycle job to finish. Keep Core accounts and other Apps unchanged.
3. Verify the published marker is a regular private file, and that no pending publication journal remains unresolved. Retain its original bytes privately and verify that its revision matches the cold database. Create a stopped-App Supervisor backup selecting only this App, with no Core or folder backup. Keep the DB, WAL and shared-memory files together.
4. Download the archive off-device. Record SHA-256 checksums for the archive, marker and cold database file family, and bind them to the installation and exact image. Independently extract the archive, verify SQLite integrity and foreign keys, the same database revision, App-only membership, and marker/journal exclusions. Retain the matching image; a tag alone can disappear or change.
5. Publish the verified checkpoint as current in a protected continuity record outside the Supervisor archive, keeping earlier records historical. Resume the exact App and recheck reader/denied-reader parity.

**Every committed grant or Board lifecycle change makes the previous checkpoint historical.** Refresh using these stopped-App steps after the change. Record a known newer change even if checkpoint capture is interrupted. If host loss occurs before refresh and current continuity cannot be independently established, recovery stays locked. An old checkpoint, a matching old database/marker pair, a timestamp or the last saved pointer cannot establish currency by itself.

### Restore without reopening historical permissions

<!-- coderabbit-ai-generated:v1 -->

<!-- coderabbit-ai-generated-section:v1:2d1e7eb003aeb11ef9f0a60bfcc12b1c98c797b9998f7a121d6d60c709066aba -->

1. Record the actual local volume while the container exists. Stop the App and any predecessor that could accept grant changes, and wait for Supervisor lifecycle jobs to finish. Keep them stopped through restore and marker publication. Only after stopping, independently establish that the retained checkpoint is still current. Require the same installation/App slug, matching exact image, archive and database checksums, and original separately retained published marker. Reject missing, unknown, foreign or superseded custody before writing any marker. Preserve the failed state and recovery files.

<!-- /coderabbit-ai-generated:v1 -->
<!-- coderabbit-ai-generated:v1 -->

<!-- coderabbit-ai-generated-section:v1:cda653c3713f189c70efcf12e76cde54d687b26a4b550eacc467d61d875a94ec -->

2. Restore only that App and its matching data while keeping it stopped. Prevent automatic startup during restore; if Supervisor cannot guarantee this, do not proceed with marker publication. Expect the marker to be absent afterward. Verify the missing-marker lock on a disposable copy; health alone does not establish permission recovery. Keep the App and any predecessor stopped through cold verification and marker publication in step 3.

<!-- /coderabbit-ai-generated:v1 -->
3. Through the recorded local volume, verify the restored cold database file family against the trusted archive **before** publishing anything. Require an absent marker destination and no unresolved pending journal. Publish only the separately retained current marker bytes with no-clobber/no-symlink handling, owner `10001:10001`, mode `0600`, and file plus parent-directory durability. Do not overwrite a different existing marker, infer one from SQLite, or use the predecessor's historical marker to unlock old data.
4. Start the exact matching App. Verify schema, integrity, image/config and protection, current roster and grant parity, authorized reads and denied readers. Any subsequent grant/lifecycle mutation requires a fresh checkpoint.

In disposable Supervisor, prove both the missing-marker lock and an older database paired with the independently current newer marker remain closed. Then prove the matching latest checkpoint restores only its current permissions. Keep failed and successful receipts separate. Portable re-certification after unknown continuity is a separate owner-approved procedure.

## Move data between Store repositories

<!-- coderabbit-ai-generated:v1 -->

<!-- coderabbit-ai-generated-section:v1:8d00d9ab05a0a1b6a66ff1bb233c4e6901ab13e0737c682b9a397ec1d3c9111a -->

A different repository URL creates a different internal App ID and data volume. A matching-App Supervisor restore is not a database import into that new ID. Settings JSON also omits tasks and protected credentials; there is no in-app SQLite import endpoint. This one-time transfer requires an operator with access to the App's local volume.

The source database may move without its excluded Board-grant marker. Named Board access therefore stays closed under the fail-closed rule. The target needs independently trusted marker bytes matching the database’s current revision, verified source continuity and verified target custody. There is currently no supported cross-repository marker transfer or re-certification process: access stays locked until the named **Store move custody re-certification** procedure is approved by the Home Assistant owner and completed. Do not synthesize a marker from SQLite or copy a historical matching pair. Checkpoint recovery above requires the same installation and App slug and cannot authorize this move.

<!-- /coderabbit-ai-generated:v1 -->

Rehearse the complete transition in a disposable Supervisor before changing the installed Canary. Isolate outbound network access before starting restored data or applying old App options: saved integration and logging endpoints can be contacted during startup or a health request. Limit the rehearsal browser to fixture services as well. Preserve stored values and verify isolation with a disposable control endpoint, without probing real saved URLs.

1. Keep the old App's complete backup, recovery material and exact image available. Select the complete database to retain. Work on a copy with its WAL and shared-memory files; use SQLite's backup API to produce a consistent standalone database. Require integrity and foreign-key checks, and privately record the original tasks and setting values. Keep the immutable source recovery files. [SQLite backup API](https://www.sqlite.org/backup.html)
2. Install only the new Canary. In the isolated rehearsal, start it with empty data and default options, and record its exact image and actual `/data` mount while its container exists. Then stop it through Supervisor. Installation alone does not create the container, and Supervisor stop normally removes it; inspect the mount before stopping. Confirm the App is stopped and no lifecycle job is still running. [Supervisor lifecycle](https://github.com/home-assistant/supervisor/blob/2026.10.5/supervisor/docker/app.py)
3. Through the recorded mount, retain any target database, WAL and shared-memory files together and move them away from the active database names. Keep the new `options.json` under Supervisor control. Place the normalized database in a temporary file on the same local volume, verify its checksum, set owner and group to the packaged service account (`10001:10001`) with mode `0600`, and rename it to `meitheal.db`. Never leave an old target WAL beside a replacement database.
4. Compare archived App-option names and types with the new manifest. Apply the complete intended compatible configuration through **Settings → Apps → Meitheal Canary → Configuration** or Supervisor's options API; record incompatible options for an explicit decision. Database settings and Supervisor App options are separate. Do not copy the old `options.json`, because Supervisor validates and regenerates it at startup. [Supervisor options API](https://github.com/home-assistant/supervisor/blob/2026.10.5/supervisor/api/apps.py#L315-L357)
5. Start the exact candidate and check migrations, database integrity and foreign keys. With a fresh administrator ingress session, compare decoded `GET /api/settings` values and the original tasks with the selected source. Verify the Settings controls, including notification preferences, and repeat after restarting the App. Account for documented schema conversions when comparing data.
6. Verify any separately managed Core integration's endpoint, authenticated actions and saved ingress links. Rehearse recovery with the matching prior App and data while that recovery path is still available. Keep network isolation throughout the rehearsal.

After the qualified Green transition passes the same acceptance, create and verify a backup matching the new App ID. Remove obsolete discovery entries only when no installed App depends on them. Retain the selected source checkpoint until the new recovery point is proven. This procedure does not replace the physical Green performance or installation gates.

## Verify the draft storage migration

For an upgrade from schema 14, take an App-only checkpoint and use a disposable copy to verify schema 15. Confirm SQLite integrity and read a known ordinary task after the app starts. Run `node scripts/migrate.mjs --check` from `apps/web` with the fixture database URL to verify the draft tables and receipt index. Keep the original checkpoint available for a rollback to the previous App. When checking post-upgrade task creation, verify concurrently created and duplicated tasks each return a distinct ticket number that matches the task details.

When draft capture is enabled, make a second App-only checkpoint with a saved draft from each of two temporary members. Save a later test draft change and restore the checkpoint. Confirm each member sees only their earlier draft and the later change is absent. Check both the App version and database integrity before testing ingress. A private draft and its publication receipt are part of the App database, so apply the same custody rules as for the full database download.

## Tier 2 acceptance

In the editor-managed Home Assistant devcontainer, seed a task, related data and settings, then create a Supervisor backup while Meitheal runs. Observe a stop before archiving and a restart afterward. Make a second write, restore the backup and verify that the first write survived, the second is absent, and ingress and database integrity pass. Repeat with the app already stopped and confirm backup leaves it stopped. Record the image digest and outage.

Before updating the Green, rehearse the older app and data rollback on a disposable Supervisor. A locally tested archive proves file recovery. It takes a Supervisor rehearsal to verify the lifecycle and a Green run to verify device acceptance.


Schema 24 adds raw-download protection for Nobody audiences and prevents changing or clearing a generated Routine occurrence's saved date when one is present. It upgrades existing schema 23 data in place and keeps the previous migration ledger entries. Use the matching App and data backup when restoring an earlier schema.
