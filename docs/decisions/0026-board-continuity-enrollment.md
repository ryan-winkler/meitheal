---
type: Decision
title: Trusted Board continuity at startup and recovery
description: "Enroll genuinely new databases and keep unknown restored access rules closed."
---

# Trusted Board continuity at startup and recovery

Date 2026-11-19

Status Accepted (superseded for Home Assistant cold backup marker inclusion and pre-0016 local upgrades by [ADR 0030](0030-home-assistant-backup-and-upgrade-continuity.md))

> **Update ([ADR 0030](0030-home-assistant-backup-and-upgrade-continuity.md)):** Home Assistant cold backups now include `/data/meitheal-board-grants.json` (excluding only `*.log`, `*.tmp`, and `meitheal-board-grants-pending`), and genuine non-empty local pre-`0016` Meitheal upgrades (`schema_version < 26`) auto-enroll when no conflicting marker or pending journal entry exists on disk. Post-`0016` continuity locks, conflicting-marker cold-replay blocks, empty/unknown file rejections, and explicit offline operator recovery remain unchanged.

## Context

A Supervisor App restore removes the excluded Board-grant marker and journal. A snapshot from before the first grant also lacks an access epoch. Treating that shape as an unrestricted first installation reopens work restricted later. The database cannot establish whether it is current. A mismatched marker must also close Household work, including background delivery, rather than only hide named Boards and organizing features.

The owner chose existing App permissions and an independently retained operator checkpoint. The App does not gain access to Home Assistant Share. A current administrator session alone cannot certify restored data.

## Decision

Only successful exclusive creation of a local database before SQLite opens it establishes automatic first-installation provenance. Existing files, empty files, symlinks, recovery-file residue and a concurrent opener do not establish it. The capability exists only in the creating process and is consumed once. Remote databases receive no automatic enrollment; isolated memory tests use an explicit initialization contract.

The creating migrator or schema initializer uses the same grant journal protocol as normal audience changes: prepare and sync the initial marker, commit the epoch, then publish and sync the marker. The packaged migrator finishes this work before its separate server process starts. The server consumes the persisted matching epoch and marker. No environment flag, archived row or empty-table heuristic recreates first-installation authority.

An existing epochless database stays locked. A verified current legacy installation can use the one-shot offline operator enrollment command under the [current checkpoint procedure](../kcs/home-assistant-backup-and-restore.md). Its protected external attestation binds the exact installation, App slug, immutable image/source, cold database file family and archive. The command consumes that attestation durably outside archived App data before migration or enrollment. Historical, unknown, foreign, superseded or already consumed evidence cannot authorize it. Cross-installation re-certification remains a separate procedure.

Current matching epochs remain compatible. An exact committed pending journal can finish publication. Missing, invalid or mismatched authority blocks governed requests, repository operations and background delivery. Recovery lock is distinct from a deleted Household Board. Only content-free health and static diagnostic resources remain available during the lock; the operator performs recovery while the App is stopped.

The public runtime persistence client enforces continuity for every query and transaction commit, including services and timers that do not use a task repository. Read and deferred transactions compare their pinned snapshot with the live database revision before publishing results. Explicit read-only batches remain read-only. Startup retains a private raw client; only the grant journal can unwrap a registered guard to perform its intentional epoch transition. A bounded health probe reads only connectivity metadata. Synthetic fixtures explicitly obtain their own raw setup client and never grant authority to existing files automatically.

Task-driven Grocy polls, retries and outbound writes verify current active Household immediately before provider dispatch, after asynchronous destination validation. Results arriving after authority is lost cannot save confirmations or imported work. Concurrent sync calls for the same active adapter share one operation. SQLite downloads capture their admitted revision, verify it after copying and before response publication, and recheck before and after each bounded asynchronous file read. Loss before publication returns unavailable; loss after headers aborts the stream and cleans up its snapshot and lease. Already delivered bytes or already dispatched provider work cannot be recalled.

Production keeps the canonical marker and pending directory under `/data`. Startup and runtime share one explicit marker context. Test fixtures select isolated contexts and cannot silently trust another marker path. Both source manifests exclude the marker and journal from future App backups; this change does not publish or install Stable.

## Verification and limits

Prove a genuine first installation and restart, an existing valid-epoch upgrade, interrupted initial enrollment before and after commit, concurrent creation, and rejection of ambiguous existing files. Pair a real later restriction with its cold pre-grant snapshot, testing absent and independently newer markers. Require Household reads, writes, counts, exports and cached or background deliveries to remain closed.

Rehearse the stopped operator path with current evidence and deny the identical historical data without that evidence. An older binary that cannot enforce the new recovery rule stays stopped during rollback; use the policy-aware package for historical-data denial tests. Exact source CI, fresh independent review, Supervisor qualification, physical Green performance and installed acceptance remain separate release gates.

The Linux CI asset ceilings are 1,855,000 aggregate bytes and 1,805,000 common generated bytes with the shared Board controls and browser authority checks enabled. The optional workspace assets retain the 50,000-byte ceiling. Linux RSS and write-latency limits and the physical Green profile still apply. The hosted measurements for the initial corrective package are in [CI run 44603684845, performance job](https://github.com/ryan-winkler/meitheal/actions/runs/44603684845/job/135841797811).

## Alternatives

Backing up the marker together with the database lets an older pair restore obsolete permissions. Inferring enrollment from absent policies, an empty database or a migration ledger has the same replay problem. A writable Share mount could retain a marker through App-only restore but expands filesystem authority; the owner rejected that option. Explicit creation provenance and operator-held current custody preserve the chosen permissions.
