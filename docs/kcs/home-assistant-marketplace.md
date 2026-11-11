---
type: Runbook
title: "Home Assistant Marketplace packaging"
description: "Stage, validate, install, and update the separate Meitheal Core integration package."
---

# Home Assistant Marketplace packaging

Home Assistant installs the Meitheal Core integration from a separate integration-only repository. The App repository remains the install source for the Meitheal server. The integration uses the existing `meitheal` domain and connects through the Meitheal API. Its minimum tested Core version is 2026.10.4. The built-in Marketplace UI requires Home Assistant 2026.11. [Repository structure](https://contributors.home-assistant.io/marketplace/reference/repository-structure/) · [Home Assistant 2026.11 release](https://www.home-assistant.io/blog/2026/11/04/release-202611/)

## Stage a release candidate

1. Run the Core credential tests from `integrations/home-assistant` with Python 3.14. Install `requirements-test.txt` in a fresh environment for Core 2026.11.1 and `requirements-test-2026.10.txt` in a separate environment for Core 2026.10.4. First build the web App with `pnpm --filter @meitheal/web build` and put Node on PATH to include the App/Core delivery tests; those tests explicitly skip when the build or Node is absent. Run `python -m pytest -q` in each environment.
2. Stage an integration archive from the tested source commit. Choose a new output path and supply the integration repository's GitHub owner and name.

   ```sh
   python scripts/stage-home-assistant-integration.py /tmp/meitheal-integration.zip --ref HEAD --repository OWNER/REPOSITORY
   unzip -l /tmp/meitheal-integration.zip
   ```

3. Compare the SHA-256 printed by the script with a second build of the same commit and repository name. The staged manifest links to that repository's README and Issues tab. Check both URLs anonymously before publishing a release. The archive contains the Apache license, README, Marketplace metadata, runtime and validation workflow. Extract it at the integration repository root. Match the GitHub Release tag to the manifest version.
4. Require both staged jobs to pass on the integration repository. The HACS job checks the integration category with no ignored checks, and hassfest validates the integration. Set the repository description, add relevant topics, and enable Issues. Verify the custom install link and a tagged upgrade on a disposable Home Assistant instance before requesting catalog inclusion. [Validation checks](https://contributors.home-assistant.io/marketplace/reference/validation/)

## Test an installer handoff

Back up Home Assistant and record the existing Meitheal config entry and to-do entity ID. Follow the credential and rollback runbook before switching installation ownership. An older App release can overwrite integration files it manages on startup.

On a disposable Supervisor instance, install the staged integration through Marketplace or manually for a local test. Accept discovery or reconfigure the existing Meitheal entry. Enter a scoped token and exercise read, create, complete, search and delete against disposable tasks. Update the integration and restart Core, then confirm the same entity and automation references work. If an update fails, restore the prior component files and restart Core without removing the config entry. [Core credentials and rollback](home-assistant-core-credentials.md)

On Core 2026.11, check that **Meitheal Tasks (read only)** appears in the conversation agent's LLM API settings. Test keyword search and lookup by ID with an active administrator and a disposable task. Verify access fails for a member, for a caller without a user ID, and for a cached session after the administrator loses access or the integration unloads. On Core 2026.10.4, verify the integration's to-do entity and actions with the optional LLM registry disabled.

## Task adapter data and troubleshooting

The Core integration uses its configured, cookie-free authenticated API client for every task page and action. It reads all native task-list pages in stable board order before publishing counts. A malformed page, duplicate task, changing total or failed page keeps the previous snapshot and fails the refresh; task access denial still starts reauthentication. Older complete list responses without pagination metadata remain supported.

Task creation sends description, priority, due date, urgency and importance as first-class native fields and requires a flat response containing the created task ID before announcing success. Todo dates are converted to Core date/date-time values, and moves submit the full displayed order to the native reorder endpoint. Unknown IDs fail without writing. Deferred cards remain in the full coordinator snapshot and sensor counts, with `deferred_at`/`deferral_revision` preserved, but are excluded from the Todo inventory and submitted move order. A deferred card cannot be the moved item or its previous-item anchor. Filtering uses exact nullness, matching the native reorder guard, and introduces no 2,000-task cap. The native API continues to reject any submitted deferred card; successful ordinary-only moves preserve the deferred card's state and slot. The task list endpoint must support `sort=kanban_position&order=asc`; retain this alongside the reorder endpoint when upgrading the server. A successful bodyless delete still refreshes and emits its deletion event.

Complete/delete by spoken title requires one exact case-insensitive match. If duplicate names exist, use an explicit task ID. An already completed cached task is rechecked through the authenticated task API before skipping its completion; a reopened task is completed normally. Completion also requires a matching flat acknowledgement before emitting success. This does not add mutating batch LLM tools: the entry-specific Core LLM API remains read-only with its current administrator checks. Custom sentence resources use Hassil YAML with a task-title wildcard in English and Gaeilge. Home Assistant's exposure choice remains under the user's control.

Optional gamification failures or denied permissions leave streak and completed-today sensors unavailable. They do not publish a false zero or hide otherwise available tasks. Completed-today comes from authoritative daily statistics, rather than the all-time number of completed tasks. Do not widen a token's authority to make an optional statistic available.

Run the integration's existing pytest suite on both supported Core versions. Its requirements pin `hassil==3.12.1` only for testing the real English/Irish sentence parser, matching both Core conversation manifests; the integration runtime manifest is unchanged. Follow the installer handoff above for Tier 2 Todo create/update/due/move/delete and actual Assist dispatch verification. These source-level tests are not an installed-Home-Assistant acceptance receipt.

The NFC service uses the same authenticated client to POST `{tag_id}` to `/api/nfc/complete`, requiring the server's NFC feature flag and `tasks:write` permission. The native endpoint returns 404 for disabled/unknown tags and 409 for duplicate assignments; the adapter propagates failures without announcing success. A fresh completion must include the matching completed task; `already_complete: true` refreshes without repeating the completion event. Test this service against the restored native route in Tier 2 before physical use; an actual tag read remains a separate Tier 3 check. No unauthenticated lookup, automatic component installation, backup hook or broad LLM capability is introduced.


Device automation triggers retain the `domain: meitheal` event-data filter and Core's normalized event-type list. The shared `app-task-overdue.json` contract is exercised through Core's actual event-trigger attachment: the App-shaped event fires once with its task data, the same event without its domain does not fire, and detach stops delivery. The App producer has a separate WebSocket-side regression against the same contract. This pairing is source/runtime-harness evidence; it does not replace the required installed-HA Tier 2 automation check.

Native task mutations use `X-Meitheal-HA-Event-Authority` on the successful App response to choose one event producer. The header lists the event types the App owns under that request's Supervisor/event-filter policy. It does not acknowledge bus delivery. The native coordinator keeps a separate authority set for each HTTP request and emits its `source: component` fallback only for events the App did not claim. Standalone servers and App-disabled events retain that fallback. Created, updated, completed and bodyless deleted responses follow this contract; NFC forwards the underlying task response's authority. App-owned events retain `source: meitheal`, including overdue events. The device trigger's domain filter is unchanged. Upgrade both the App and native integration for this contract; older App responses without the header use the native fallback.

HA event delivery remains best effort. A held connection, failed acknowledgement or lost acknowledgement never starts a second producer after the App claims authority. A failed delivery may produce no automation action; this contract does not provide exactly-once delivery or a durable retry queue. No task/time suppression is used, so rapid reopen/complete transitions still produce their separate completion actions. The App also owns the decision not to repeat a completion when the write made no new completion transition. Mutation responses read local policy without waiting for Core's connection or acknowledgement. Native REST calls explicitly use `Content-Type: application/json`, including empty DELETE requests, while retaining the existing Origin/token and transport checks.

For a disposable verification, build the web App and run `tests/test_event_authority.py` in the Core test environment with Node on PATH. Its actual native client/coordinator calls the built App's middleware and task routes, commits SQLite mutations, forwards App `fire_event` WebSocket frames onto the real Core bus, and counts actions through Core's actual device-trigger attachment. It covers native/App-enabled and standalone/App-disabled producers, rapid transitions, NFC, empty DELETE, concurrent response binding and held/lost/failed acknowledgements. This loopback protocol fixture does not replace installed-HA Tier 2 acceptance or physical device checks.
