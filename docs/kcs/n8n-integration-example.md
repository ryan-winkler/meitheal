---
type: "Guide"
title: "n8n / Node-RED Integration Examples"
description: "Connect Meitheal events to n8n or Node-RED."
---

# n8n / Node-RED Integration Examples

## Architecture

Meitheal supports two integration modes for n8n and Node-RED:

1. **HA Addon mode (auto)** — events flow via the **HA event bus** (`meitheal_task_*` events). Both n8n and Node-RED receive them through their built-in HA integrations (e.g. n8n's "Home Assistant Trigger" node). No webhook URL needed.
2. **Standalone mode** — HTTP webhooks sent to configured URLs with Bearer Token auth and HMAC signature. Standard webhook receivers — **no custom Meitheal adapter needed**.

### HA Event Types

| Event Type | Fired When |
|---|---|
| `meitheal_task_created` | New task created |
| `meitheal_task_updated` | Task fields modified |
| `meitheal_task_completed` | Task status set to "done" |
| `meitheal_task_deleted` | Task deleted |
| `meitheal_task_overdue` | Task passed its due date |
| `meitheal_board_updated` | Board configuration changed |

### Event Data Payload

Every event payload includes the full task context:

```json
{
  "task_id": "uuid",
  "title": "Fix the roof",
  "board_id": "default",
  "priority": "1",
  "status": "in_progress",
  "ticket_key": "MTH-42",
  "task_type": "task",
  "description": "Repair the leak in the kitchen ceiling",
  "labels": ["home", "urgent"],
  "due_date": "2026-03-10",
  "completed_at": null
}
```

| Field | Type | Description |
|-------|------|-------------|
| `task_id` | string | UUID of the task |
| `title` | string | Task title |
| `board_id` | string | Board the task belongs to |
| `priority` | string | Priority level (1 = highest) |
| `status` | string | Current task status |
| `ticket_key` | string | Human-readable ticket key (e.g. MTH-42) |
| `task_type` | string | Type of task (task, bug, feature, etc.) |
| `description` | string | Full task description |
| `labels` | string[] | Array of label names |
| `due_date` | string | ISO date or null |
| `completed_at` | string | ISO timestamp or null |

## HA Addon Mode — Node-RED

When Node-RED runs as an HA addon, it connects to HA Core via WebSocket automatically. Use the `events: all` node to listen for Meitheal events.

### Node-RED Flow: Task Created → Notification

1. **events: all** node — Filter: `meitheal_task_created`
2. **function** node — Format message: `msg.payload = "New task: " + msg.payload.event.title;`
3. **call service** node — `notify.persistent_notification` with `{ message: msg.payload }`

### Node-RED Flow: Urgent Task → Mobile Alert

1. **events: all** node — Filter: `meitheal_task_created`
2. **switch** node — Check `msg.payload.event.priority === "1"`
3. **call service** node — `notify.mobile_app_DEVICE` with urgency data

### Configuration

1. Go to **Meitheal → Settings → Integrations → n8n / Node-RED**
2. Select **HA Addon** mode (auto-detected when Node-RED addon is installed)
3. Check which events you want to receive
4. Click **Save n8n Settings**

No webhook URL or API key needed in this mode.

### n8n Flow: Task Created via HA Addon Mode

If you run n8n alongside HA, you can seamlessly receive Meitheal events over the HA Event Bus.
1. **Home Assistant Trigger node** — Event name: `meitheal_task_created`
2. **Set / Function node** — Parse event data via `{{ $json.event.title }}`
3. **HTTP / Discord / Action node** — Send desired notification

## Standalone Mode — Webhooks

You can receive Meitheal events by configuring the HTTP Webhook URL and placing an **n8n API Key** inside the Meitheal Settings. Meitheal will then send requests with `Authorization: Bearer <key>` Header so n8n can natively authenticate the webhook receiver.

### Webhook Headers

Every webhook delivery includes these headers:

| Header | Description |
|--------|-------------|
| `Content-Type` | `application/json` |
| `Authorization` | `Bearer <n8n_api_key>` (if configured) |
| `X-Meitheal-Event` | Event type (e.g. `task.created`) |
| `X-Meitheal-Delivery-Id` | Unique delivery UUID |
| `X-Meitheal-Signature` | `sha256=<hmac>` (if signing secret configured) |

### Example 1: Task Created → Grocy Stock Check → Shopping List

**Flow:** New task with grocery items → check Grocy stock → add missing items to shopping list → create "Go to Store" task.

#### n8n

1. **Webhook node** — receive `task.created` events
   - Method: POST
   - Path: `/webhook/meitheal`
   - Authentication: Header Auth (Name: `Authorization`, Type: Bearer, matches `n8n_api_key`)
2. **IF node** — check `payload.frameworkFields` contains grocery items
3. **HTTP Request node** — GET `http://grocy:9283/api/stock`
4. **Function node** — compare task items vs stock, find missing
5. **HTTP Request node** — POST `http://grocy:9283/api/stock/shoppinglist/add-product`
6. **HTTP Request node** — POST back to Meitheal: create "Go to Store" task

#### Node-RED

```json
[
  { "type": "http in", "url": "/webhook/meitheal", "method": "post" },
  { "type": "function", "func": "// Verify HMAC signature\n// Filter task.created events" },
  { "type": "http request", "url": "http://grocy:9283/api/stock" },
  { "type": "function", "func": "// Compare stock, find missing items" },
  { "type": "http request", "url": "http://grocy:9283/api/stock/shoppinglist/add-product" }
]
```

### Example 2: Framework Score → Notification

**Flow:** Framework scoring completed → send notification via Telegram/Slack.

#### n8n

1. **Webhook node** — receive `framework.score.applied`
2. **Function node** — format message: "Task '{title}' scored {score}/100"
3. **Telegram/Slack node** — send formatted message

### Example 3: Calendar Sync Failed → PagerDuty Alert

#### n8n

1. **Webhook node** — receive `webhook.delivery.failed`
2. **IF node** — filter for critical subscribers
3. **PagerDuty node** — create incident

## Troubleshooting

### Common Issues

| Symptom | Cause | Fix |
|---------|-------|-----|
| "Unreachable" health status | n8n instance not running or URL wrong | Verify n8n is running and URL is correct (e.g. `https://n8n.internal/webhook/meitheal`) |
| Test webhook returns 404 | Webhook path doesn't match n8n workflow | Check n8n workflow has a Webhook node with matching path |
| Test webhook returns 401 | API key mismatch | Ensure Meitheal's `n8n_api_key` matches the key in n8n's Header Auth credential |
| HMAC verification fails | Wrong signing secret | Ensure both Meitheal and your receiver use the same secret |
| Workflows show "API Key missing" | No API key configured | Add the n8n API key in Settings → n8n → Standalone Mode |
| HA Event Bus shows "Not running as HA addon" | Running in standalone mode | This is expected outside of HA. Use Standalone mode instead |

### Verifying Webhook Delivery

1. In Meitheal Settings → n8n → Standalone Mode, click **🔌 Test Webhook**
2. Check the status callout — green means delivered
3. In n8n, check the workflow execution log for the test payload
4. The "Last Delivery" indicator updates live after each test

---

*Last updated: 2026-03-16 — Added enriched payload docs, troubleshooting, webhook headers, and `task.overdue` event*
