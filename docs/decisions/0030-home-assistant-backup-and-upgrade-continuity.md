---
type: "Decision"
title: "ADR 0030: Home Assistant Backup and Pre-0016 Upgrade Continuity"
description: "Includes the committed Board grant marker in Home Assistant cold backups and auto-enrolls verified pre-0016 local Meitheal databases when no conflicting marker exists."
---

# ADR 0030: Home Assistant Backup and Pre-0016 Upgrade Continuity

- **Date:** 2026-11-24
- **Status:** Accepted (supersedes the Home Assistant backup exclusion and pre-0016 SSH enrollment rules in [ADR 0026](0026-board-continuity-enrollment.md))
- **Deciders:** Maintainer

## Context

[ADR 0026](0026-board-continuity-enrollment.md) excluded `/data/meitheal-board-grants.json` from Home Assistant Supervisor cold backups and kept existing pre-`0016_ordinary_boards.mjs` (`v0.0.2` and pre-`0016` canary) databases locked (`503 continuity_locked`) unless an operator ran an out-of-band SSH checkpoint procedure (`enroll-legacy-continuity.mjs`).

In real Home Assistant installations (`meitheal-hub` and `meitheal-hub-canary`), excluding `meitheal-board-grants.json` broke ordinary Supervisor cold backups, restores, and in-place `v0.0.2 -> v0.0.3` App updates because:

1. Supervisor stops the App cleanly during cold backup (`backup: cold`) and restores `/data` from that same backup archive.
2. Upgrades from `v0.0.2` (`schema_version <= 25`) or pre-`0016` Canary snapshots either had no `meitheal-board-grants.json` yet or lost their excluded marker during a rollback restore, leaving the updated App unusable with HTTP `503` behind Home Assistant Ingress.

## Decision

1. **Include committed Board grant markers in Home Assistant Supervisor cold backups**:
   - Remove `"meitheal-board-grants.json"` from `backup_exclude` in both `meitheal-hub/config.yaml` and `meitheal-hub-canary/config.yaml`.
   - Keep only transient `*.log`, `*.tmp`, and `"meitheal-board-grants-pending"` in `backup_exclude`.
   - Supervisor cold backups and restores now preserve `meitheal.db`, SQLite WAL/shared-memory files, and `/data/meitheal-board-grants.json` together.

2. **Auto-enroll genuine pre-`0016` local Meitheal databases during startup when no conflicting marker exists**:
   - In `openDatabaseForStartup()` (`apps/web/scripts/database-client.mjs`), inspect existing non-empty local SQLite files (`existingStats.size > 0`, `!readOnly`) via `isPre0016MeithealDatabase()` and mark `pre0016LocalUpgrade: true` in `board-grant-context.mjs` only when:
     - `migrationState === "household-v19"`, `readOrdinaryBoardMigrationState(tx)` is `false`, and `app_settings.schema_version` is an integer in `[19, 25]`; OR
     - `migrationState === "predecessor"`, `main.tasks` exists alongside `__meitheal_migrations` or `app_settings`, and any stored `schema_version` is `< 26`.
   - In `admitStartupBoardTransition()` (`apps/web/scripts/board-grant-journal.mjs`), when applying `0016_ordinary_boards.mjs`:
     - If `!revision` (epochless pre-`0016` upgrade such as `v0.0.2 -> v0.0.3`), enroll an initial Board grant epoch and marker automatically when `pre0016LocalUpgrade` is `true` and neither the destination marker path nor any non-empty/non-directory pending entry exists on disk.
     - If `revision` exists on a pre-`0016` local database (`schema_version < 26`) whose marker was lost in an earlier excluded backup, rotate the epoch and write a fresh pending/published marker automatically only when neither a marker file nor any unresolved pending entry exists on disk.

3. **Keep strict fail-closed continuity gates intact**:
   - Empty (`0`-byte) local files, arbitrary non-Meitheal SQLite files, read-only connections, in-memory databases without trusted initialization, and remote libSQL databases do not auto-enroll.
   - When `applyStartupBoardSchema()` refuses `0016` admission (`!transition`), it persists `continuity_auto_enroll_blocked = '1'` via `INSERT OR IGNORE` into `app_settings` before committing `0015`, preventing empty or unknown files from auto-enrolling on subsequent SSR opens or restarts (`isPre0016MeithealDatabase()` checks for that setting and returns `false`), and deletes the setting only upon authorized admission.
   - Replaying a pre-`0016` database when a newer `meitheal-board-grants.json` or unresolved pending journal entry exists on disk (`hasMarkerOrPendingEntries`) stays `continuity_locked` (`503`).
   - Once `0016_ordinary_boards.mjs` completes (`schema_version >= 26`), `applyStartupBoardSchema()` skips `admitStartupBoardTransition()`; any missing, malformed, or mismatched marker stays `continuity_locked` (`503`).
   - The offline operator recovery command (`apps/web/scripts/enroll-legacy-continuity.mjs`) remains supported for explicit operator custody recovery and conflicting-marker incidents.

## Verification

- `tests/e2e/ha-backup-platform.spec.ts` asserts `backup: cold` and exact `backup_exclude` rules (`*.log`, `*.tmp`, `meitheal-board-grants-pending`) in both App manifests.
- `tests/e2e/ordinary-authority-schema.spec.ts` verifies automatic `schema25 -> schema28` enrollment for both epochless databases and pre-`0016` databases with a missing marker, and verifies `continuity_locked` (`pending26`) when a conflicting marker exists on disk.
- `tests/e2e/continuity-cold-replay.spec.ts`, `tests/e2e/continuity-http.spec.ts`, `tests/e2e/board-continuity-startup.spec.ts`, and `tests/e2e/continuity-standalone-startup.spec.ts` verify pre-grant replay denial with a retained marker, pre-`0016` upgrade auto-enrollment, post-`0016` lock on absent markers, and empty/unknown file rejection.
