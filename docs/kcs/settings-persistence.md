---
type: Runbook
title: Save and restore rules and framework settings
description: Preserve household rules, finish pending edits, and recover from rejected saves or imports.
---
# Save and restore rules and framework settings

The per-type Rules & Lenses editor changes its displayed default rules. Tagged and custom rules remain intact. Rapid edits are saved in order; an edit made while another save is in flight is saved afterward. If a save committed but its response was lost, the next retry reloads the current default-rule IDs before replacing them; it does not append duplicate defaults. Opening an empty configuration does not create rules automatically. Apply a preset explicitly when defaults are wanted.

Preset changes, Restore Defaults, imports and individual framework resets wait for pending saves. Export and navigation also finish queued edits first. A rejected save keeps the visible edit and blocks an export or navigation that would silently omit it. Check the connection and permissions, then change the control again to retry. A framework load failure removes stale sliders and shows recovery guidance.

A failed framework slider save keeps its latest value marked as unsaved and offers **Retry save** beside the field. Exports, navigation and replacements stay blocked until that latest value receives a successful acknowledgement. A lost response remains uncertain even if the server accepted the write; Retry save safely submits the same partial field update. An older request cannot clear a newer field draft. If a configuration reload fails, unsaved fields stay available for retry; a reset or import does not report a completed editor refresh.

Rules export includes built-in framework configuration and custom definitions. Imports validate custom definitions and check whether each already exists before changing configuration. Rules and built-in overrides use one validated server transaction. Custom definitions then use their existing create/update endpoints. If a custom-definition write fails after the transaction, the error says which part was imported; the selected file remains available for retry. Review the resulting configuration before retrying. Invalid input and denied existence checks do not erase the prior rules.

Native Settings imports report transport and application failures without reloading. Native Settings and Rules exports finish pending edits and download only a checked response. The framework wizard retains its fields and re-enables Save after rejection. YAML import continues to use the bounded server parser described in [Import a framework from YAML](framework-yaml-import.md).

For verification, use a disposable authenticated ingress fixture. Hold a checkbox or slider request, make another edit, and confirm its acknowledgement precedes a reset, export or navigation. Reject the request and confirm that edits remain visible with no success notification or download. Export, reset and import a configuration containing custom rules, labels, help text, weights, a formula and badges; confirm the stored configuration round trips. Repeat an ordinary edit and rejected retry in the default Astro development server, including ClientRouter navigation. These checks establish browser persistence behavior; native Home Assistant and installed-device acceptance remain separate.
