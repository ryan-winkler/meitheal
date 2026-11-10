# Home Assistant task and Assist integration

The bundled custom component is a network client of Meitheal's native APIs.
It exposes the HA todo list, task sensors, services, intent handlers, and the
optional Meitheal Tasks LLM API. Agent MCP clients use the add-on's existing
Astro `/api/mcp` endpoint; there is no separate custom-component MCP server.
The component ships an English translation resource for its entity and service
names. Assist exposure resolves the todo entity through HA's entity registry,
including installations where the entity has been renamed.

## Task contracts

- Refresh requests every `/api/tasks` page with `limit=100`, increasing
  `offset`, and `sort=kanban_position&order=asc` until the reported total is
  reached. Failed or inconsistent pages fail the refresh rather than publish
  partial board counts. The server supplies a stable ID tie-break for ordering.
- At the integration boundary `pending` becomes `todo`, `active` becomes
  `in_progress`, and `complete` becomes `done`. JSON string labels become a
  string list, calendar sync state is retained, and numeric timestamps become
  ISO timestamps. This normalization applies to todo, sensor, and LLM views.
- Create uses `POST /api/tasks` with first-class `description`, `priority`,
  `due_date`, `urgency`, and `importance` when supplied. HA todo preserves its
  due date and description. Move uses `POST /api/tasks/reorder` with the full
  displayed `ordered_ids` list, including moves to the first position.
- Completion and removal by title require one case-insensitive exact match in
  the refreshed task list. Missing or duplicate titles fail with guidance to
  use a task ID. The LLM removal tool does not guess from ranked search results.
- Search accepts query, status, priority (1–5), and include_completed. The LLM
  search schema does not advertise unsupported Eisenhower filter parameters.
- Area and goal tools read `/api/areas` and `/api/goals?area_id=...`; manual
  goal progress uses `PUT /api/goals/{id}` with `progress` from 0 to 100.
- NFC completion calls `/api/nfc/complete` with `tag_id`. Assign the tag through
  task PUT's `nfc_tag_id` field first. No match or an ambiguous tag is an error;
  retrying an already-complete task does not emit another component completion.
- Failed HTTP responses are rejected before parsing JSON or reporting success.
  Successful no-content responses (204/205), including task deletion, do not
  require JSON. Other successful responses still reject malformed JSON.
  Component requests have a 15-second timeout and identify their automation
  source as `ha`. A failed optional gamification request does not fail tasks.

## Gamification sensors

Streak, total points, and today's completed count come from the gamification
API's `stats.currentStreak`, `stats.totalPoints`, and `stats.todayCompleted`.
The streak and completed-today entities are unavailable if that feature is
disabled, the request fails, or the response lacks valid counts. Zero is shown
only when a successful response measures zero. Updating an old completed task
does not cause it to be counted as a completion today.

## Overdue task events

The existing five-minute due-date scheduler records `task.overdue` observations
in the durable domain-event ledger, once for each task ID and due-date value.
It starts on the first server request, before attempting an HA connection, and
keeps observing transitions when reminder notifications are disabled or HA is
unavailable. The first observation establishes a baseline without emitting the
existing historical overdue inventory. Later ticks detect newly crossed dates
and open tasks updated with a deadline already in the past. Complete, done,
archived, and canceled tasks are excluded. Each tick claims at most 100 events;
remaining candidates drain on subsequent ticks, including after a restart.
ISO dates, date-times with offsets, and epoch-millisecond text are supported.

Events use the existing best-effort outbound dispatcher: configured webhooks
receive `task.overdue`; HA add-on mode fires `meitheal_task_overdue` when the
n8n event filter includes it (the default includes overdue). HA event data
includes `domain: meitheal`, as required by the component's device triggers.
The device-trigger adapter passes the event name as a list to HA's event
attachment helper, matching the helper's validated configuration contract.
An explicit saved event filter still controls delivery. Ledger observation is
not an acknowledgement from HA or a webhook. An unavailable destination does
not cause repeated overdue observations; there is no durable delivery retry
queue or replay of missed HA events.

For troubleshooting, check the scheduler's `tasks.overdue.observed` log,
`domain_events` entries with `event_type = 'task.overdue'`, the configured n8n
event selection, and webhook delivery results. Keep the internal baseline in
`app_settings`; deleting it resets the observation start time. To verify in
Tier 2, disable due-date reminders, create an open task with a near-future due
time, wait for the next scheduler tick, and capture both its single HA device
trigger and configured webhook request. Restart and wait another tick to check
that the same due date does not fire again. Repeat with HA disconnected to
confirm local observation continues; reconnecting does not replay the event.

## Configure Assist sentences

Home Assistant's supported custom sentence format is YAML under
`<ha_config>/custom_sentences/<language>/`. Files inside the integration are
resources and are not automatically loaded by the default agent. See the
[official sentence configuration guide](https://www.home-assistant.io/voice_control/custom_sentences_yaml/).

1. Copy the component's `custom_sentences/en/meitheal.yaml` or
   `custom_sentences/ga/meitheal.yaml` into the corresponding HA configuration
   directory. Preserve an existing custom file instead of overwriting it.
2. Reload Conversation or restart HA after copying. The component itself
   registers the matching intent handlers when loaded.
3. In the Assist sentence tester, try `add buy milk to my tasks`, then
   `show my tasks`. The bundled `item` wildcard captures the task title.
4. For LLM conversation agents, select the **Meitheal Tasks** LLM API instead.
   LLM tools and sentence matching are separate HA facilities.

## Troubleshoot and verify

If sensors or todo content are missing, check the integration's host/port,
add-on availability, and API errors in the HA log. If only gamification sensors
are unavailable, enable the gamification feature or inspect its API error.
If Meitheal Tasks is missing from the LLM API selection, check the integration's
registration exception in the HA log. Its constructor uses HA's `id` keyword;
LLM tool registration is separate from the default agent's sentence loading.
If a title is ambiguous, search for the intended ID and repeat the operation.
If a sentence is unrecognized, check the file location, selected language,
Conversation reload, and the `item` wildcard before investigating handlers.

Python regression checks use a local HTTP fixture and small HA lifecycle
stubs: `uv run --python 3.13 --with aiohttp --with voluptuous --with pyyaml --with hassil python -m unittest
discover -s tests/python -p 'test_ha_integration.py'`. They do not establish
Home Assistant runtime acceptance. Complete Tier 2 in the checked-in HA
devcontainer before release: create a task with due date and description,
reorder it across pages, verify completed tasks stay complete, exercise the
search service's advertised filters, test duplicate-title refusal, confirm
gamification disabled/unavailable behavior, and test the selected Assist path.
NFC and goal progress require their corresponding native API changes.

An explicitly empty `n8n_events` array disables that channel's event selection;
it must not fall back to all events. An absent/invalid setting retains defaults.
The existing event/settings cache refreshes within 60 seconds. A separately
configured generic webhook retains its own all-event subscription.

Supervisor identity uses `X-Remote-User-Id` and comma-separated
`X-Remote-User-Groups` (`system-admin` for administrators). Official identity
overrides legacy claims; add-on mode never falls back to caller-supplied
`X-Hass-*` identity. Missing identity is unknown and cannot modify household
settings. Explicit agent tokens keep their scoped authority. Standalone trusted
proxy compatibility retains legacy headers. See the official
[Supervisor ingress implementation](https://github.com/home-assistant/supervisor/blob/main/supervisor/api/ingress.py)
and [ingress guide](https://contributors.home-assistant.io/apps/guides/ingress/).
