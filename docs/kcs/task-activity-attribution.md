# Task activity attribution

The Task history records status changes as `status_change` and other field edits as `field_change`. Each entry keeps its committed old/new values and a readable diff summary. A no-op retry does not add another change entry.

For agent commands, the display name is read from the current verified credential inside the Task writer. Caller origin headers and actor fields do not select that identity. Later renaming a credential does not rewrite earlier activity entries.

Recent Activity keeps a separate feed marker for one update and its sanitized origin attribution. That marker and its provenance JSON are excluded from public Task history; public history carries the displayed credential name, not raw token identifiers, credentials or origin metadata. A write-only credential retains its minimal mutation acknowledgement and cannot read history.

Source proof: `tests/e2e/ordinary-work-r52-activity-addon.spec.ts` exercises real credential resolution and canonical HTTP handlers on both Board encodings. Retained provenance and cancellation regressions verify the feed parsing boundary and atomic rollback. Packaged and Home Assistant acceptance remain separate release gates.
