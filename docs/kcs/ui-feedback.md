# Verify Settings feedback and task capture

Settings may report saved only after every required request succeeds. A failed
save must retain the form values and allow retry. Check both an HTTP rejection
(403 or 503) and a disconnected browser; a resolved `fetch` is not proof of success.

For local UI checks, run the Astro development server and open
`/dev/ui-truthfulness?data=worst&save=fail`. The development-only harness renders
the existing Settings page and New Task modal with API fixtures. Its data switch
offers Demo data, Worst case, Empty, One, and 1,284 users. Remove `save=fail` to
exercise successful fixture writes. Fixture writes never reach the database.
The route returns 404 in production.

Check the modal at 320px and desktop widths, with large text and dark/light
themes. Choose a task kind, change priority, add a checklist or shopping item,
and submit. Close and reopen it to verify the visible form resets. Do not clone
the form after binding handlers: that detaches listeners and cached references.

Routine creation belongs in Habits & Routines. Task creation does not assign
agents or upload attachments. Proposal-only tokens submit edits to the administrator review queue. Claims last
five minutes; pending proposals expire after 24 hours. Auto-accept and arbitrary
AI-scope permissions are not advertised. Assist uses `ha-assist-agent`, with
the legacy `ha-agent-id` used only when the canonical key is absent; an explicit
empty canonical preference selects built-in Assist.

UI feedback is Tier 1 verification. Home Assistant connections, ingress, and
actual automation enforcement require Tier 2; fixtures do not establish them.

Task descriptions accept at most 10000 characters and titles at most 500. The
form uses matching limits; API rejections retain the existing task instead of
silently truncating a description.

Rules autosaves belong to the current Settings page. Standalone navigation and
rules export flush any pending edit before reading or leaving the editor. A
failed flush stops navigation/export and preserves the visible edit for retry;
lifecycle cancellation must never construct replacement rules from a missing
editor. Framework read failures replace loading/stale controls with a reload
instruction. Verify immediate navigation/export within the debounce window and
navigation while a prior save is in flight.

A downloaded rules export restores custom frameworks whether they still exist
or have been deleted. Import creates only after a checked404/not-found lookup;
permission and service failures must not be treated as permission to create.
Rules may have committed before a later framework failure; the partial-outcome
message identifies this boundary.

The feedback bridge is owned by one page-lifecycle signal, including fallback
initialization and repeated page-load/HMR setup. One acknowledged action emits
one feedback toast. Production MCP self-requests use the app's local runtime
origin; HA's externally forwarded Host is not an internal API destination.

Calendar, timeline and Eisenhower presentation use the shared canonical status
configuration. Legacy aliases are normalized on read, and completion actions
send the canonical complete status. The manual screenshot spec is opt-in with
`E2E_BASE_URL` and `MEITHEAL_CAPTURE_SCREENSHOT=1`; its output uses the Playwright
run directory rather than a developer-specific path.

Eisenhower weekly review launches from the current shell and the UnifiedBar
action outside its delegated listener. The header binding is lifecycle-owned
and replaces previous bindings during repeated setup; completion submits the
canonical status once.

Integration disclosure headers keep the native expand button and help button as siblings. Never nest buttons: HTML parser recovery can move later Settings panels outside the main layout, leaving controls visible but clipped and unclickable. When diagnosing blocked Settings clicks after compiler upgrades, inspect DOM ancestry and main-content width before changing controller readiness or test timeouts.
