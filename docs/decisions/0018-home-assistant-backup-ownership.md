---
type: Decision
title: "Home Assistant owns app backup consistency"
description: "Records why the Home Assistant Supervisor owns consistent App backups."
---

# Home Assistant owns app backup consistency

## Context

Meitheal persists data in SQLite under the Home Assistant app `/data` volume. The former hot-backup hooks called checkpoint endpoints that are absent from the app. A successful checkpoint alone still permits writes while Supervisor archives the volume.

## Decision

Stable and canary declare `backup: cold`. Home Assistant Supervisor stops a running app before archiving `/data` and restarts it afterward. It leaves an already stopped app stopped. The database and any SQLite recovery files stay together.

Remove the duplicate backup hooks from the app and the optional Home Assistant integration. Follow the runbook to identify legacy installed integration copies and prepare a safe checkpoint before upgrading. [Backup and restore runbook](../kcs/home-assistant-backup-and-restore.md)

## Alternatives

- Checkpoint-only hot hooks leave a window in which a writer can commit before the archive is complete.
- An online backup would need a separate restore artifact, write coordination, crash recovery and disk-space controls. Revisit this if a measured backup outage justifies that work.

## Consequences

Backups briefly stop a running app. Supervisor owns backup and restore, and Meitheal keeps its app data in the volume Supervisor backs up. Verify stop, restart, restore and version rollback in Tier 2 before a release uses this contract.
