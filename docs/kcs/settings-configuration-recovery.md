---
type: Runbook
title: "Recovering rules and framework settings"
description: "Preserve configuration when saves and imports fail."
---
# Recovering rules and framework settings

Use an administrator session in Home Assistant to change shared rules, framework overrides or import Settings. Agent credentials cannot administer these settings. A standalone operator can manage them from the local machine.

Rule saves validate names, task types, lists, AI permissions and typed values before changing stored configuration. The bulk `PUT /api/rules` operation accepts `rules` and optional `replaceIds`. Omitting `replaceIds` replaces the whole list. Supplying the IDs shown by an editor replaces only those entries, preserving other custom rules. Restore Defaults replaces the rules and clears built-in framework overrides in one transaction. If an insert fails, the previous configuration remains available.

Built-in framework overrides accept a dictionary of known field keys, finite non-negative weights, non-empty labels and formulas, help text, and complete badge definitions. A partial field edit preserves other field properties and other saved overrides. Concurrent edits to different properties are merged against the latest stored configuration; an intervening write cannot silently discard another property's change. Repeated contention reports a save failure and asks for reload and retry. Built-in definitions come from the packaged Astro framework catalog. YAML framework creation retains its separate bounded parser and collision checks.

Before importing Settings, keep a downloaded export. Imports are limited to 200 KiB of actual UTF-8 bytes. Version 2 imports validate all supplied rules and framework overrides before writes; preferences, rules and framework overrides then commit together. Malformed input or a failed write preserves the previous configuration. Unknown preference keys and credential values are excluded. Re-enter credentials through their integration panel after restoring an export.

If an import reports invalid rules or framework overrides, correct the indicated input and retry. Do not reset existing configuration to bypass the error. If storage reports a failure, verify the app's database health and free space, then retry the original file. A successful import confirms persistence; integration connectivity requires its own check.

For a disposable verification dataset, save a custom rule and a built-in override, try an invalid import, and confirm both survive. Restore a valid export and confirm string preferences, rule lists, weights and labels round trip. A failed replacement must leave the old rules and overrides intact. The focused configuration-preservation tests cover validation, scoped rule replacement, transaction rollback, typed preference encoding, administrator restrictions and packaged catalog use.

Native Settings JSON exports contain decoded values marked `json-values`, so strings, quoted text, booleans, nulls, arrays and objects survive an export/import without extra quoting. The importer also recognizes the older native version2 export with its export timestamp and decodes those stored values once. Typed direct API payloads retain their string values. Credentials and unknown setting keys remain excluded; restore credentials through their supported setup flow. Current notification preferences, Assist selection, calendar selection and known optional feature flags are included. The JSON file is a configuration export, not a replacement for an App database backup.

An explicit null restores the saved null over a changed destination value; an absent key leaves that destination untouched. Multi-list Todo selection, per-calendar sync modes, and Grocy sync enablement and interval are restored alongside their single-list settings. To verify a restore, change every exported test preference before importing, then compare each restored value with the export.

CalDAV accepts the URL stored by credential setup and the JSON string restored by Settings. Importing a configuration preserves existing local credentials; it does not export or replace the password. After restoring, use Sync Now to verify calendar connectivity rather than relying only on the saved URL display.
