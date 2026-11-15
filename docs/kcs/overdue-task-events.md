---
type: Runbook
title: "Overdue task events"
description: "Observe deadline transitions separately from notification delivery."
---
# Overdue task events

Meitheal observes overdue transitions through the existing deadline scheduler, including when reminder notifications are off or Home Assistant is unavailable. The first run establishes a baseline without replaying the existing overdue inventory. Later checks observe open tasks whose deadline crossed, or whose deadline was edited into the past. A changed deadline creates a new episode. Completed, archived and cancelled tasks are excluded.

Each check records up to 100 episodes in the local event ledger before passing them to the ordinary best-effort dispatcher. A full backlog remains open for later checks and process restarts. Concurrent checks cannot claim the same episode twice. A ledger row confirms observation; it does not guarantee receipt by Home Assistant, n8n or another webhook subscriber. A delivery failure does not become another overdue transition on the next tick.

To receive events in n8n, enable `task.overdue` in its event selection. An explicit empty selection delivers no events; an absent selection uses the defaults. Keep notification preferences separate from this domain event selection.

<!-- coderabbit-ai-generated:v1 -->

<!-- coderabbit-ai-generated-section:v1:241d1dd24c92cc03e87284a620ab06708ad1979637a1e39ccb2f69dc4901b5e1 -->

Date-only deadlines become overdue after their household calendar day ends. Timed deadlines use the same normalized instant for both the household day and clock comparison; timestamps without an offset are interpreted as UTC. To check a cross-day case, use Pacific/Auckland just after midnight with an offset-less timestamp dated the previous UTC day whose instant is still in the future: it must remain current until that instant passes.

For a disposable verification dataset, start the app before creating a task with a near-future deadline. Let the deadline pass with reminders off and verify one `task.overdue` event. Restart and confirm the event is not repeated. Move the deadline into the future and let it pass again to verify a new episode. Confirm an empty n8n selection suppresses delivery. A local harness proves these contracts; native Home Assistant and subscriber receipt require separate environment checks.


<!-- /coderabbit-ai-generated:v1 -->