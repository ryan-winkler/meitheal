/**
 * AsyncAPI 2.6 Specification Generator
 *
 * Build-time generator that documents Meitheal's event-driven interfaces:
 *   1. Server-Sent Events (SSE) — real-time browser push
 *   2. Outbound Webhooks — task lifecycle events to n8n/Node-RED
 *
 * Output: apps/web/public/asyncapi.yaml
 * Run: node apps/web/scripts/generate-asyncapi.mjs
 *
 * @domain agent-protocols
 * @bounded-context event-dispatch
 */
import { writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { stringify } from "yaml"

const spec = {
  asyncapi: "2.6.0",
  info: {
    title: "Meitheal Event API",
    version: "0.3.0",
    description: "Real-time event streams and outbound webhooks for Meitheal — the Home Assistant-native task execution hub. Covers Server-Sent Events (SSE) for browser push and CloudEvents-compliant webhooks for n8n, Node-RED, and AI agent integrations.",
    contact: {
      name: "Coolock Village",
      url: "https://github.com/ryan-winkler/meitheal",
    },
    license: {
      name: "AGPL-3.0",
      url: "https://www.gnu.org/licenses/agpl-3.0.html",
    },
  },

  servers: {
    local: {
      url: "localhost:4321",
      protocol: "http",
      description: "Local development server",
    },
    haAddon: {
      url: "{ingress_path}",
      protocol: "http",
      description: "Home Assistant add-on (accessed via HA ingress proxy)",
      variables: {
        ingress_path: {
          description: "HA ingress path prefix (set by Supervisor)",
          default: "/api/hassio_ingress/token",
        },
      },
    },
  },

  channels: {
    // ── SSE Channels ──────────────────────────────────────────────────────
    "sse/connected": {
      description: "Initial SSE connection confirmation. Fired immediately on EventSource open.",
      subscribe: {
        operationId: "onSSEConnected",
        message: {
          name: "connected",
          title: "SSE Connection Established",
          contentType: "application/json",
          payload: {
            type: "object",
            properties: {
              ts: { type: "string", format: "date-time", description: "Server timestamp" },
              clients: { type: "integer", description: "Number of active SSE clients" },
            },
            required: ["ts", "clients"],
            additionalProperties: false,
          },
        },
      },
    },

    "sse/task:created": {
      description: "A new task was created via the UI or API.",
      subscribe: {
        operationId: "onTaskCreated",
        message: {
          name: "task:created",
          title: "Task Created (SSE)",
          contentType: "application/json",
          payload: { $ref: "#/components/schemas/TaskEvent" },
        },
      },
    },

    "sse/task:updated": {
      description: "A task was modified (title, status, priority, etc).",
      subscribe: {
        operationId: "onTaskUpdated",
        message: {
          name: "task:updated",
          title: "Task Updated (SSE)",
          contentType: "application/json",
          payload: { $ref: "#/components/schemas/TaskEvent" },
        },
      },
    },

    "sse/task:deleted": {
      description: "A task was permanently deleted.",
      subscribe: {
        operationId: "onTaskDeleted",
        message: {
          name: "task:deleted",
          title: "Task Deleted (SSE)",
          contentType: "application/json",
          payload: { $ref: "#/components/schemas/TaskEvent" },
        },
      },
    },

    "sse/ha:entity_changed": {
      description: "A Home Assistant entity changed state. Includes calendar and todo entity updates.",
      subscribe: {
        operationId: "onEntityChanged",
        message: {
          name: "ha:entity_changed",
          title: "HA Entity State Changed (SSE)",
          contentType: "application/json",
          payload: {
            type: "object",
            properties: {
              entity_id: { type: "string", description: "HA entity ID (e.g., calendar.family)" },
              state: { type: "string", description: "Current entity state" },
              attributes: { type: "object", description: "HA entity attributes" },
              last_updated: { type: "string", format: "date-time" },
            },
            required: ["entity_id", "state"],
            additionalProperties: false,
          },
        },
      },
    },

    // ── Outbound Webhook Channels ─────────────────────────────────────────
    "webhook/task.created": {
      description: "Outbound webhook fired when a task is created. Delivered as CloudEvents 1.0 binary content mode.",
      publish: {
        operationId: "webhookTaskCreated",
        bindings: {
          http: {
            type: "request",
            method: "POST",
            headers: {
              type: "object",
              properties: {
                "ce-specversion": { type: "string", const: "1.0" },
                "ce-type": { type: "string", const: "io.meitheal.task.created" },
                "ce-source": { type: "string", example: "/meitheal" },
                "ce-id": { type: "string", format: "uuid" },
                "ce-time": { type: "string", format: "date-time" },
                "x-meitheal-signature": { type: "string", description: "HMAC-SHA256 payload signature" },
                traceparent: { type: "string", description: "W3C traceparent for distributed tracing" },
              },
            },
          },
        },
        message: {
          name: "task.created",
          title: "Task Created (Webhook)",
          contentType: "application/json",
          payload: { $ref: "#/components/schemas/WebhookTaskPayload" },
        },
      },
    },

    "webhook/task.updated": {
      description: "Outbound webhook fired when a task is modified.",
      publish: {
        operationId: "webhookTaskUpdated",
        bindings: {
          http: { type: "request", method: "POST" },
        },
        message: {
          name: "task.updated",
          title: "Task Updated (Webhook)",
          contentType: "application/json",
          payload: { $ref: "#/components/schemas/WebhookTaskPayload" },
        },
      },
    },

    "webhook/task.completed": {
      description: "Outbound webhook fired when a task is marked complete.",
      publish: {
        operationId: "webhookTaskCompleted",
        bindings: {
          http: { type: "request", method: "POST" },
        },
        message: {
          name: "task.completed",
          title: "Task Completed (Webhook)",
          contentType: "application/json",
          payload: { $ref: "#/components/schemas/WebhookTaskPayload" },
        },
      },
    },

    "webhook/task.deleted": {
      description: "Outbound webhook fired when a task is deleted.",
      publish: {
        operationId: "webhookTaskDeleted",
        bindings: {
          http: { type: "request", method: "POST" },
        },
        message: {
          name: "task.deleted",
          title: "Task Deleted (Webhook)",
          contentType: "application/json",
          payload: { $ref: "#/components/schemas/WebhookTaskPayload" },
        },
      },
    },

    "webhook/task.overdue": {
      description: "Outbound webhook fired when a task passes its due date without completion.",
      publish: {
        operationId: "webhookTaskOverdue",
        bindings: {
          http: { type: "request", method: "POST" },
        },
        message: {
          name: "task.overdue",
          title: "Task Overdue (Webhook)",
          contentType: "application/json",
          payload: { $ref: "#/components/schemas/WebhookTaskPayload" },
        },
      },
    },

    "webhook/task.commented": {
      description: "Outbound webhook fired when an automation or agent posts a comment on a task.",
      publish: {
        operationId: "webhookTaskCommented",
        bindings: {
          http: { type: "request", method: "POST" },
        },
        message: {
          name: "task.commented",
          title: "Task Commented (Webhook)",
          contentType: "application/json",
          payload: { $ref: "#/components/schemas/WebhookTaskCommentedPayload" },
        },
      },
    },

    "webhook/area.updated": {
      description: "Outbound webhook fired when an area (board) is modified.",
      publish: {
        operationId: "webhookAreaUpdated",
        bindings: {
          http: { type: "request", method: "POST" },
        },
        message: {
          name: "area.updated",
          title: "Area Updated (Webhook)",
          contentType: "application/json",
          payload: {
            type: "object",
            properties: {
              eventId: { type: "string", format: "uuid" },
              eventType: { type: "string", const: "area.updated" },
              occurredAt: { type: "string", format: "date-time" },
              payload: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  name: { type: "string" },
                },
                additionalProperties: false,
              },
            },
            additionalProperties: false,
          },
        },
      },
    },
  },

  components: {
    schemas: {
      TaskEvent: {
        type: "object",
        description: "SSE task event payload — lightweight for real-time push.",
        properties: {
          id: { type: "string", description: "Task ID" },
          title: { type: "string", description: "Task title" },
          status: { type: "string", enum: ["pending", "active", "complete", "backlog"] },
          priority: { type: "integer", minimum: 1, maximum: 5 },
          area_id: { type: "string", description: "Board/area ID" },
        },
        required: ["id", "title"],
      },

      WebhookTaskPayload: {
        type: "object",
        description: "CloudEvents-wrapped task webhook payload. Includes full DomainEvent envelope.",
        properties: {
          eventId: { type: "string", format: "uuid", description: "Unique event ID (also ce-id)" },
          eventType: { type: "string", description: "Event type (e.g., task.created)" },
          occurredAt: { type: "string", format: "date-time", description: "ISO 8601 timestamp" },
          requestId: { type: "string", description: "Originating request correlation ID" },
          payload: {
            type: "object",
            description: "Task data at time of event",
            properties: {
              id: { type: "string" },
              title: { type: "string" },
              status: { type: "string" },
              priority: { type: "integer" },
              area_id: { type: "string" },
              board_name: { type: "string" },
              due_date: { type: "string", format: "date" },
              assigned_to: { type: ["string", "null"] },
              description: { type: "string", maxLength: 200 },
              labels: { type: "string" },
              ticket_key: { type: ["string", "null"] },
              task_type: { type: "string" },
            },
          },
        },
        required: ["eventId", "eventType", "occurredAt", "requestId", "payload"],
      },

      WebhookTaskCommentedPayload: {
        type: "object",
        description: "CloudEvents-wrapped task.commented webhook payload emitted when an agent comments on a task.",
        properties: {
          eventId: { type: "string", format: "uuid", description: "Unique event ID (also ce-id)" },
          eventType: { type: "string", const: "task.commented" },
          occurredAt: { type: "string", format: "date-time", description: "ISO 8601 timestamp" },
          requestId: { type: "string", description: "Originating request correlation ID" },
          traceId: { type: "string", description: "Optional trace ID" },
          payload: {
            type: "object",
            description: "Task and comment details at time of event",
            properties: {
              id: { type: "string" },
              comment_id: { type: ["integer", "string"] },
              author: { type: "string" },
              content: { type: "string" },
              title: { type: "string" },
              ticket_key: { type: ["string", "null"] },
              status: { type: "string" },
              assigned_to: { type: ["string", "null"] },
              comment: {
                type: "object",
                properties: {
                  id: { type: ["integer", "string"] },
                  author: { type: "string" },
                  excerpt: { type: "string", maxLength: 280 },
                  by_agent: { type: "boolean" },
                },
                required: ["author", "excerpt", "by_agent"],
              },
            },
            required: ["id", "author", "content", "title", "status", "comment"],
          },
        },
        required: ["eventId", "eventType", "occurredAt", "requestId", "payload"],
      },
    },
  },
}

const output = resolve(dirname(fileURLToPath(import.meta.url)), "../public/asyncapi.yaml")
writeFileSync(output, stringify(spec), "utf-8")

const sseChannels = Object.keys(spec.channels).filter(c => c.startsWith("sse/")).length
const webhookChannels = Object.keys(spec.channels).filter(c => c.startsWith("webhook/")).length
console.log(`[AsyncAPI] Generated ${sseChannels} SSE + ${webhookChannels} webhook channels → public/asyncapi.yaml`)
