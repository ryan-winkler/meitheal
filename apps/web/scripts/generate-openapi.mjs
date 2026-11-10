#!/usr/bin/env node
/**
 * generate-openapi.mjs — Build-time OpenAPI 3.1 generator
 *
 * Generates apps/web/public/openapi.yaml from a declarative route catalog.
 * Uses plain JS objects (no Zod import) to avoid ESM/CJS issues at build time.
 * AI-prompt-engineered descriptions guide agent/automation usage.
 *
 * @domain integrations
 * @bounded-context code-to-spec
 */
import { writeFileSync, mkdirSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { stringify } from "yaml"

const OUTPUT = resolve(dirname(new URL(import.meta.url).pathname), "../public/openapi.yaml")
const JSON_OUTPUT = resolve(dirname(OUTPUT), ".well-known/jsondoc.json")

// ─── Reusable Schema Components ───────────────────────────────────────────────

const feedbackCategory = { type: "string", enum: ["problem", "accessibility", "suggestion", "other"] }
const feedbackState = { type: "string", enum: ["open", "in_progress", "resolved", "declined"] }
const feedbackMessage = { type: "string", minLength: 1, maxLength: 4096, description: "Plain text, at most 4 KiB in UTF-8." }
const feedbackVersion = { type: "string", description: "App version, when the sender chose to include it." }
const feedbackRouteFamily = { type: "string", enum: ["home", "tasks", "calendar", "settings", "other"] }
const feedbackReceipt = {
  id: { type: "string", format: "uuid" },
  receivedAt: { type: "integer", description: "Epoch milliseconds." },
}

const commentBody = {
  required: true,
  content: { "application/json": { schema: { type: "object", required: ["content"], properties: { content: { type: "string", minLength: 1, maxLength: 5000 } } } } },
}
const commentResourceParameters = [
  { name: "id", in: "path", required: true, schema: { type: "string" } },
  { name: "commentId", in: "path", required: true, schema: { type: "integer", minimum: 1 } },
]

const reactionContent = {
  type: "string", minLength: 1, maxLength: 16,
  description: "One line of emoji or plain text. Surrounding whitespace is trimmed and the text is normalized to NFC.",
}
const reactionCursor = { type: "string", pattern: "^[1-9][0-9]*$" }

const pinContext = { type: "string", pattern: "^[A-Za-z0-9_-]{43}$", description: "Opaque, short-lived browser account binding." }
const pinTaskIdentifier = { type: "string", minLength: 1, maxLength: 128, description: "Canonical task identifier or MTH ticket key." }
const pinState = { id: { type: "string" }, pinned: { type: "boolean" }, pinned_at: { type: ["integer", "null"] } }
const pinContextParameter = { name: "X-Meitheal-Pin-Context", in: "header", required: true, schema: pinContext }

const schemas = {
  TaskReaction: {
    type: "object",
    required: ["id", "content", "author", "can_manage"],
    properties: {
      id: { type: "integer", minimum: 1 },
      content: reactionContent,
      author: { type: "string", description: "Display author recorded when the reaction was added." },
      can_manage: { type: "boolean", description: "Whether the caller owns and can remove this reaction." },
    },
  },
  TaskReactionPage: {
    type: "object",
    required: ["reactions", "next_cursor", "can_react"],
    properties: {
      reactions: { type: "array", items: { $ref: "#/components/schemas/TaskReaction" }, maxItems: 50 },
      next_cursor: { anyOf: [reactionCursor, { type: "null" }], description: "Supply this value as cursor to continue." },
      can_react: { type: "boolean", description: "Whether the caller may add reactions." },
    },
  },
  TaskReactionCounts: {
    type: "object",
    required: ["counts"],
    properties: { counts: { type: "object", additionalProperties: { type: "integer", minimum: 1 }, maxProperties: 100 } },
  },
  TaskComment: {
    type: "object",
    required: ["id", "task_id", "content", "author", "created_at"],
    properties: {
      id: { type: "integer" },
      task_id: { type: "string" },
      content: { type: "string" },
      author: { type: "string", description: "Display author recorded when the comment was added." },
      created_at: { type: "string", description: "SQLite UTC timestamp." },
    },
  },
  TaskCommentListItem: {
    allOf: [
      { $ref: "#/components/schemas/TaskComment" },
      {
        type: "object",
        required: ["can_manage"],
        properties: {
          can_manage: { type: "boolean", description: "Whether the caller can edit and delete this comment." },
        },
      },
    ],
  },
  FeedbackSubmission: {
    type: "object",
    properties: {
      submissionId: { type: "string", format: "uuid", description: "Client-generated UUIDv4. Reuse it for identical retries." },
      category: feedbackCategory,
      message: feedbackMessage,
      appVersion: feedbackVersion,
      routeFamily: feedbackRouteFamily,
    },
    required: ["submissionId", "category", "message"],
  },
  FeedbackReceipt: { type: "object", properties: feedbackReceipt, required: ["id", "receivedAt"] },
  FeedbackExport: {
    type: "object",
    properties: {
      category: feedbackCategory,
      message: feedbackMessage,
      appVersion: { anyOf: [feedbackVersion, { type: "null" }] },
      routeFamily: { anyOf: [feedbackRouteFamily, { type: "null" }] },
    },
    required: ["category", "message", "appVersion", "routeFamily"],
  },
  FeedbackReport: {
    type: "object",
    properties: {
      ...feedbackReceipt,
      category: feedbackCategory,
      message: feedbackMessage,
      appVersion: { anyOf: [feedbackVersion, { type: "null" }] },
      routeFamily: { anyOf: [feedbackRouteFamily, { type: "null" }] },
      state: feedbackState,
      submitterId: { type: "string" },
      claimedBy: { type: ["string", "null"] },
      closedBy: { type: ["string", "null"] },
      disposition: { type: ["string", "null"], description: "Plain text, at most 1 KiB in UTF-8." },
    },
    required: ["id", "receivedAt", "category", "message", "appVersion", "routeFamily", "state", "submitterId",
      "claimedBy", "closedBy", "disposition"],
  },
  TaskId: { type: "string", description: "Unique task identifier (UUID)", example: "a1b2c3d4-e5f6-7890-abcd-ef1234567890" },
  Task: {
    type: "object",
    properties: {
      id: { $ref: "#/components/schemas/TaskId" },
      title: { type: "string", description: "Task title — the primary human-readable label" },
      description: { type: "string", nullable: true, description: "Rich text task description" },
      status: { type: "string", description: "Current workflow status. Also supports custom workflow statuses.", example: "pending" },
      priority: { type: "integer", minimum: 0, maximum: 5, description: "Priority level: 0=none, 1=lowest, 5=critical" },
      is_promoted: { type: "boolean", description: "Shared Kanban promotion, returned for task detail and updates." },
      due_date: { type: "string", format: "date-time", nullable: true },
      assigned_to: { type: "string", nullable: true, description: "User ID prefixed with 'ha_' or 'custom_'" },
      area_id: { type: "string", nullable: true },
      goal_id: { type: "string", nullable: true },
      project_id: { type: "string", nullable: true },
      parent_id: { type: "string", nullable: true, description: "Parent task ID for subtask hierarchy" },
      task_kind: { type: "string", enum: ["standard_action", "shopping_item", "checklist", "routine_instance", "calendar_event", "quick_capture"], description: "Behavioral kind — determines UI rendering and lifecycle rules" },
      labels: { type: "string", nullable: true, description: "Comma-separated label names" },
      checklists: { type: ["string", "null"], description: "A JSON-encoded array of checklist items with text, done, and an optional id. Historical tasks may have null." },
      board_name: { type: "string", nullable: true },
      ticket_key: { type: "string", nullable: true, description: "Human-readable key like MTH-42" },
      created_at: { type: "integer", description: "Unix timestamp (ms)" },
      updated_at: { oneOf: [{ type: "integer" }, { type: "string" }], description: "Stored Unix milliseconds or legacy ISO timestamp" },
      task_version: { type: "integer", minimum: 0, description: "Normalized workflow timestamp used by guarded writes" },
      deferred_at: { type: "integer", nullable: true, description: "Unix milliseconds when open work was deferred" },
      deferral_revision: { type: "string", nullable: true, pattern: "^[a-f0-9]{32}$", description: "Opaque deferral concurrency token" },
    },
    required: ["id", "title", "status"],
  },
  Area: {
    type: "object",
    properties: {
      id: { type: "string" },
      name: { type: "string" },
      description: { type: "string", nullable: true },
      icon: { type: "string", nullable: true },
      color: { type: "string", nullable: true },
      sort_order: { type: "integer" },
    },
    required: ["id", "name"],
  },
  Goal: {
    type: "object",
    properties: {
      id: { type: "string" },
      title: { type: "string" },
      area_id: { type: "string", nullable: true },
      status: { type: "string", enum: ["active", "paused", "completed", "abandoned"] },
      metric_type: { type: "string", nullable: true },
      metric_target: { type: "number", nullable: true },
      metric_current: { type: "number", nullable: true },
    },
    required: ["id", "title"],
  },
  Project: {
    type: "object",
    properties: {
      id: { type: "string" },
      name: { type: "string" },
      area_id: { type: "string", nullable: true },
      goal_id: { type: "string", nullable: true },
      status: { type: "string" },
      task_counts: {
        type: "object",
        properties: { active_open: { type: "integer" }, total: { type: "integer" }, complete: { type: "integer" } },
        required: ["active_open", "total", "complete"],
      },
    },
    required: ["id", "name"],
  },
  Pillar: {
    type: "object",
    properties: {
      id: { type: "string" },
      name: { type: "string" },
      identity_statement: { type: "string", nullable: true },
      icon: { type: "string", nullable: true },
      color: { type: "string", nullable: true },
      sort_order: { type: "integer" },
    },
    required: ["id", "name"],
  },
  Label: {
    type: "object",
    properties: { id: { type: "integer" }, title: { type: "string" }, color: { type: "string" } },
    required: ["id", "title"],
  },
  Setting: {
    type: "object",
    properties: { key: { type: "string" }, value: {} },
    required: ["key", "value"],
  },
  WebhookEvent: {
    type: "object",
    description: "Outbound event fired on task lifecycle changes. Subscribe via webhook settings or HA event bus.",
    properties: {
      eventId: { type: "string", format: "uuid" },
      eventType: { type: "string", enum: ["task.created", "task.updated", "task.completed", "task.deleted", "task.overdue", "area.updated"] },
      occurredAt: { type: "string", format: "date-time" },
      requestId: { type: "string" },
      payload: { type: "object" },
    },
    required: ["eventId", "eventType", "occurredAt", "payload"],
  },
  ProblemDetail: {
    type: "object",
    description: "RFC 9457 Problem Details (application/problem+json). Agents MUST read `invalidParams` to self-correct validation errors.",
    properties: {
      type: { type: "string", format: "uri", description: "URI identifying the problem type — resolves to human docs" },
      title: { type: "string", description: "Short human-readable summary of the problem type" },
      status: { type: "integer", description: "HTTP status code" },
      detail: { type: "string", description: "Human-readable explanation for this specific occurrence" },
      instance: { type: "string", description: "URI reference identifying the specific request path" },
      traceId: { type: "string", description: "Trace ID for correlation with structured logs" },
      error: { type: "string", description: "Legacy alias for detail — backward compatibility" },
      invalidParams: {
        type: "array",
        description: "Validation errors — agents should rewrite payload fields listed here and retry",
        items: {
          type: "object",
          properties: {
            name: { type: "string", description: "JSON path to the invalid field (e.g., body.title)" },
            reason: { type: "string", description: "Why the field is invalid" },
          },
          required: ["name", "reason"],
        },
      },
    },
    required: ["type", "title", "status"],
  },
  HealthResponse: {
    type: "object",
    properties: {
      status: { type: "string", enum: ["ok", "degraded"] },
      service: { type: "string" },
      version: { type: "string" },
      time: { type: "string", format: "date-time" },
      uptime_seconds: { type: "integer" },
      db_status: { type: "string" },
      db_integrity: { type: "string" },
      schema_version: { type: "integer" },
      ha_mode: { type: "string", enum: ["ha-addon", "standalone"] },
      supervisor_reachable: { type: "boolean" },
    },
  },
  SearchResult: {
    type: "object",
    required: ["query", "sections", "meta"],
    properties: {
      query: { type: "string" },
      sections: { type: "array", items: {
        type: "object", required: ["id", "label", "items"],
        properties: {
          id: { type: "string" }, label: { type: "string" },
          items: { type: "array", items: {
            type: "object", required: ["id", "kind", "title"],
            properties: {
              id: { type: "string" }, kind: { type: "string" }, title: { type: "string" },
              taskId: { type: "string" }, actionId: { type: "string" },
              href: { type: "string" }, subtitle: { type: "string" }, description: { type: "string" },
              icon: { type: "string" }, color: { type: ["string", "null"] }, meta: { type: "object" },
            },
          } },
        },
      } },
      meta: { type: "object", properties: {
        scope: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 12 },
        sort: { type: "string" }, include_completed: { type: "boolean" }, include_archived: { type: "boolean" },
        task_fields: { type: "array", items: { type: "string" } },
      } },
    },
  },
  AgentScope: {
    type: "string",
    enum: ["tasks:read", "tasks:write", "projects:read", "projects:write", "pillars:read", "pillars:write", "search:read", "settings:read", "settings:write", "webhooks:manage", "admin:*"],
    description: "Fine-grained permission scope for agent tokens. Use least-privilege: grant only what the agent needs.",
  },
  AgentToken: {
    type: "object",
    description: "Public metadata for an agent token. The plaintext token is only returned once on creation.",
    properties: {
      id: { type: "string", format: "uuid" },
      name: { type: "string", description: "Human label (e.g., 'n8n-prod', 'claude-agent')" },
      tokenPrefix: { type: "string", description: "First 8 chars of the token for identification (e.g., 'mth_a1b2')" },
      scopes: { type: "array", items: { $ref: "#/components/schemas/AgentScope" } },
      createdAt: { type: "string", format: "date-time" },
      expiresAt: { type: "string", format: "date-time", nullable: true },
      lastUsedAt: { type: "string", format: "date-time", nullable: true },
      revoked: { type: "boolean" },
    },
    required: ["id", "name", "tokenPrefix", "scopes", "createdAt"],
  },
  CreateAgentTokenRequest: {
    type: "object",
    description: "Payload for creating a new agent token. Scopes determine API access.",
    properties: {
      name: { type: "string", description: "Human label for the token" },
      scopes: { type: "array", items: { $ref: "#/components/schemas/AgentScope" }, minItems: 1 },
      expiresAt: { type: "string", format: "date-time", nullable: true, description: "Optional expiry. Null = no expiry." },
    },
    required: ["name", "scopes"],
  },
  CreateAgentTokenResponse: {
    type: "object",
    description: "Response from token creation — includes the plaintext token (shown ONCE).",
    properties: {
      id: { type: "string", format: "uuid" },
      name: { type: "string" },
      token: { type: "string", description: "⚠️ Show-once. The Bearer token the agent must use. Never stored or retrievable again." },
      tokenPrefix: { type: "string" },
      scopes: { type: "array", items: { $ref: "#/components/schemas/AgentScope" } },
      createdAt: { type: "string", format: "date-time" },
      expiresAt: { type: "string", format: "date-time", nullable: true },
    },
    required: ["id", "name", "token", "tokenPrefix", "scopes", "createdAt"],
  },
}

// ─── Helper: standard JSON responses ──────────────────────────────────────────

const jsonContent = (schema, desc) => ({
  description: desc,
  content: { "application/json": { schema } },
})

const labelCleanupError = (description, codes) => jsonContent({
  type: "object", additionalProperties: false, required: ["ok", "errorCode", "detail"],
  properties: { ok: { const: false }, errorCode: { type: "string", enum: codes }, detail: { type: "string" } },
}, description)

const labelMutationErrors = Object.fromEntries(Object.entries({
  400: labelCleanupError("Invalid ID, label change or unexpected deletion body", ["invalid"]),
  403: labelCleanupError("Current HA administrator or local standalone operator required; agent tokens denied", ["denied"]),
  404: labelCleanupError("Label no longer available", ["missing"]),
  409: labelCleanupError("No change committed: ambiguous/conflicting names or malformed stored selections", ["conflict", "blocked"]),
  413: labelCleanupError("Body exceeds 4 KiB", ["tooLarge"]),
  415: labelCleanupError("PUT requires application/json", ["media"]),
  499: labelCleanupError("Request cancelled before repository work", ["cancelled"]),
  503: labelCleanupError("Current administrator verification, bounded body read or storage unavailable", ["unavailable"]),
}).map(([status, response]) => [status, { ...response,
  headers: { "Cache-Control": { schema: { type: "string", const: "private, no-store" } } },
}]))
const labelMutationId = [{ name: "id", in: "path", required: true, schema: { type: "integer", minimum: 1, maximum: 9007199254740991 } }]
const labelDeletionErrors = Object.fromEntries(Object.entries(labelMutationErrors).filter(([status]) => !["413", "415"].includes(status)))

const ref = (name) => ({ $ref: `#/components/schemas/${name}` })
const arrOf = (name) => ({ type: "array", items: ref(name) })

const problemContent = (desc) => ({
  description: desc,
  content: { "application/problem+json": { schema: ref("ProblemDetail") } },
})

const err400 = problemContent("Validation error (RFC 9457 — read invalidParams to self-correct)")
const err500 = problemContent("Internal server error (RFC 9457)")

// ─── Route Catalog ────────────────────────────────────────────────────────────
// Each route has AI-prompt-engineered descriptions that guide agent usage.

const ingressSession = [{ haIngressSession: [] }]
const feedbackTag = ["Local feedback"]
const feedbackHeader = {
  in: "header", name: "X-Meitheal-Feedback", required: true, schema: { type: "string", const: "1" },
  description: "Same-origin Settings request marker. The route also checks Fetch Metadata when the browser provides it.",
}
const feedbackId = { in: "path", name: "id", required: true, schema: { type: "string", format: "uuid" } }
const feedbackForbidden = problemContent("A verified Home Assistant ingress user with the required role is needed.")
const feedbackUnavailable = problemContent("The local feedback database is busy or the queue is full.")
const feedbackJsonErrors = {
  400: err400,
  403: feedbackForbidden,
  413: problemContent("The request body exceeds 8 KiB."),
  415: problemContent("The request body must be application/json."),
  500: err500,
  503: feedbackUnavailable,
}
const feedbackJsonBody = schema => ({ required: true, content: { "application/json": { schema } } })

const reactionSecurity = [...ingressSession, { bearerAuth: [] }]
const reactionForbidden = problemContent("An active, nonsystem Home Assistant account or an automation token with the required task scope is needed.")
const reactionNotFound = problemContent("The task or comment does not exist.")
const reactionUnauthenticated = problemContent("An ingress session or a valid automation token is required.")
const reactionResponseErrors = { 401: reactionUnauthenticated, 403: reactionForbidden, 500: err500 }

function reactionPaths(resource, label, parameters) {
  return {
    collection: {
      get: {
        operationId: `get${resource}Reactions`,
        tags: ["Tasks"],
        summary: `List reactions on a ${label}`,
        description: "Returns up to 50 reactions, newest first. Home Assistant ingress requires current membership. Automation tokens need tasks:read.",
        security: reactionSecurity,
        parameters: [...parameters, { name: "cursor", in: "query", schema: reactionCursor }],
        responses: { 200: jsonContent(ref("TaskReactionPage"), "Reactions and continuation cursor"), 400: err400,
          404: reactionNotFound, ...reactionResponseErrors },
      },
      post: {
        operationId: `add${resource}Reaction`,
        tags: ["Tasks"],
        summary: `React to a ${label}`,
        description: "The same reaction by the same caller on the same target returns the existing reaction. The JSON body is limited to 1 KiB. Home Assistant ingress requires a fresh membership check before writing. Automation tokens need tasks:write.",
        security: reactionSecurity,
        parameters,
        requestBody: {
          required: true,
          content: { "application/json": { schema: { type: "object", required: ["content"], properties: { content: reactionContent } } } },
        },
        responses: {
          201: jsonContent(ref("TaskReaction"), "Added or already present reaction"),
          400: err400,
          404: reactionNotFound,
          408: problemContent("The request body did not arrive in time."),
          413: problemContent("The request body exceeds 1 KiB."),
          415: problemContent("The request body must be application/json."),
          ...reactionResponseErrors,
        },
      },
    },
    item: {
      delete: {
        operationId: `delete${resource}Reaction`,
        tags: ["Tasks"],
        summary: `Remove your reaction from a ${label}`,
        description: "Only the creator can remove a reaction. Home Assistant ingress requires a fresh membership check. Automation tokens need tasks:write.",
        security: reactionSecurity,
        parameters: [...parameters, { name: "reactionId", in: "path", required: true, schema: { type: "integer", minimum: 1 } }],
        responses: {
          204: { description: "Reaction removed" },
          404: problemContent("The reaction was not found on this target or is owned by a different caller."),
          ...reactionResponseErrors,
        },
      },
    },
  }
}
const taskReactionPaths = reactionPaths("Task", "task card", commentResourceParameters.slice(0, 1))
const commentReactionPaths = reactionPaths("TaskComment", "task comment", commentResourceParameters)

const inactivityRevision = { type: ["string", "null"], pattern: "^[a-f0-9]{32}$" }
const inactivityCatalogRevision = { type: ["string", "null"], pattern: "^[a-f0-9]{64}$" }
const inactivityId = { type: "string", minLength: 1, maxLength: 128 }
const inactivityArea = { ...inactivityId, type: ["string", "null"] }
const inactivityDays = { type: "integer", minimum: -1, maximum: 365 }
const inactivityEpoch = { type: "integer", format: "int64", description: "Epoch milliseconds" }
const inactivityObject = (properties) => ({
  type: "object", required: Object.keys(properties), additionalProperties: false, properties,
})
const inactivityPolicy = inactivityObject({ days: inactivityDays, revision: inactivityRevision })

const paths = {
  "/api/feedback": {
    post: {
      operationId: "submitLocalFeedback",
      tags: feedbackTag,
      summary: "Save local feedback and return a durable receipt",
      description: "Available to verified Home Assistant ingress users. An identical retry returns the same receipt.",
      security: ingressSession,
      parameters: [feedbackHeader],
      requestBody: feedbackJsonBody(ref("FeedbackSubmission")),
      responses: {
        ...feedbackJsonErrors,
        201: jsonContent(ref("FeedbackReceipt"), "Feedback saved"),
        409: problemContent("This submission ID was already used with different content."),
      },
    },
    get: {
      operationId: "listLocalFeedback",
      tags: feedbackTag,
      summary: "List local feedback for a verified Home Assistant administrator",
      description: "Returns up to 50 reports. Pass both parts of nextCursor for the next page.",
      security: ingressSession,
      parameters: [
        { in: "query", name: "state", schema: feedbackState },
        { in: "query", name: "before", schema: feedbackReceipt.receivedAt },
        { in: "query", name: "beforeId", schema: feedbackReceipt.id },
      ],
      responses: {
        200: jsonContent({
          type: "object",
          properties: { reports: arrOf("FeedbackReport"), nextCursor: { anyOf: [ref("FeedbackReceipt"), { type: "null" }] } },
          required: ["reports", "nextCursor"],
        }, "Local reports and cursor"),
        400: err400,
        403: feedbackForbidden,
        500: err500,
        503: feedbackUnavailable,
      },
    },
  },
  "/api/feedback/{id}": {
    patch: {
      operationId: "reviewLocalFeedback",
      tags: feedbackTag,
      summary: "Claim or close a report as a verified Home Assistant administrator",
      security: ingressSession,
      parameters: [feedbackId, feedbackHeader],
      requestBody: feedbackJsonBody({
        type: "object",
        properties: {
          state: { type: "string", enum: ["in_progress", "resolved", "declined"] },
          disposition: { type: "string", maxLength: 1024, description: "Required for closure, omitted for claim. At most 1 KiB in UTF-8." },
        },
        required: ["state"],
      }),
      responses: {
        ...feedbackJsonErrors,
        200: jsonContent(ref("FeedbackReport"), "Updated report"),
        404: problemContent("Report no longer exists."),
        409: problemContent("The report changed or the state transition is unavailable."),
      },
    },
    delete: {
      operationId: "deleteLocalFeedback",
      tags: feedbackTag,
      summary: "Permanently delete a closed report as a verified Home Assistant administrator",
      security: ingressSession,
      parameters: [feedbackId, feedbackHeader],
      responses: {
        204: { description: "Report removed" },
        400: err400,
        403: feedbackForbidden,
        404: problemContent("Report no longer exists."),
        409: problemContent("Close the report before deletion."),
        500: err500,
        503: feedbackUnavailable,
      },
    },
  },
  "/api/feedback/{id}/export": {
    post: {
      operationId: "prepareLocalFeedbackExport",
      tags: feedbackTag,
      summary: "Preview a reviewed report as a verified Home Assistant administrator",
      security: ingressSession,
      parameters: [feedbackId, feedbackHeader],
      requestBody: feedbackJsonBody({
        type: "object",
        properties: { reviewedMessage: feedbackMessage },
        required: ["reviewedMessage"],
      }),
      responses: {
        ...feedbackJsonErrors,
        200: jsonContent(ref("FeedbackExport"), "Reviewed text and selected context"),
        404: problemContent("Report no longer exists."),
      },
    },
  },
  // ── Health ──
  "/api/health": {
    get: {
      operationId: "getHealth",
      tags: ["System"],
      summary: "Health and readiness probe",
      description: "Use this to verify Meitheal is running before making other API calls. Returns version, uptime, database status, and Home Assistant connectivity. Call this first in any automation workflow.",
      responses: {
        200: jsonContent(ref("HealthResponse"), "Service healthy"),
        503: jsonContent(ref("HealthResponse"), "Service degraded"),
      },
    },
    head: {
      operationId: "healthPing",
      tags: ["System"],
      summary: "Lightweight liveness ping",
      description: "Ultra-fast liveness check with no response body. Use this for frequent polling (e.g., every 30s) instead of the full GET health endpoint.",
      responses: { 200: { description: "Alive" }, 503: { description: "Down" } },
    },
  },

  // ── Tasks CRUD ──
  "/api/tasks": {
    get: {
      operationId: "listTasks",
      tags: ["Tasks"],
      summary: "List all tasks with optional filters",
      description: "Retrieve tasks filtered by status, area, project, labels, priority, assignee, board, or due date. Use sort and limit parameters for pagination. This is the primary read endpoint for task management automations.",
      parameters: [
        { name: "status", in: "query", schema: { type: "string" }, description: "Filter: todo, in_progress, complete, archived" },
        { name: "deferred", in: "query", schema: { type: "string", enum: ["0", "1"] }, description: "Use 1 for deferred work and 0 for other work. Omission returns both." },
        { name: "area_id", in: "query", schema: { type: "string" } },
        { name: "project_id", in: "query", schema: { type: "string" } },
        { name: "board_name", in: "query", schema: { type: "string" } },
        { name: "assigned_to", in: "query", schema: { type: "string" } },
        { name: "priority", in: "query", schema: { type: "integer" } },
        { name: "due_date", in: "query", schema: { type: "string", format: "date" }, description: "Match the stored calendar day, either a date-only value or the date written in a stored ISO timestamp. Invalid dates return 400." },
        { name: "parent_id", in: "query", schema: { type: "string" }, description: "Get subtasks of a parent" },
        { name: "sort", in: "query", schema: { type: "string", enum: ["created", "updated", "priority", "due_date"] } },
        { name: "limit", in: "query", schema: { type: "integer", default: 50 } },
        { name: "offset", in: "query", schema: { type: "integer", default: 0 } },
      ],
      responses: {
        200: jsonContent({
          type: "object",
          properties: { tasks: arrOf("Task"), total: { type: "integer" }, limit: { type: "integer" }, offset: { type: "integer" } },
          required: ["tasks", "total", "limit", "offset"],
        }, "Task page and matching total"),
        400: problemContent("Invalid task filter"),
        500: err500,
      },
    },
  },
  "/api/tasks/today-counts": {
    get: {
      operationId: "getTodayTaskCounts",
      tags: ["Tasks"],
      summary: "Get the Today page task counters",
      description: "Returns counts over the full task database using the Today page rules. No task rows are returned.",
      responses: {
        200: jsonContent({
          type: "object",
          required: ["dueToday", "completedToday", "carriedForward", "remaining", "completionPercent"],
          properties: {
            dueToday: { type: "integer", minimum: 0 },
            completedToday: { type: "integer", minimum: 0 },
            carriedForward: { type: "integer", minimum: 0 },
            remaining: { type: "integer", minimum: 0 },
            completionPercent: { type: "integer", minimum: 0, maximum: 100 },
          },
        }, "Today counters"),
        503: problemContent("Today counters unavailable"),
      },
    },
  },
  "/api/tasks/create": {
    post: {
      operationId: "createTask",
      tags: ["Tasks"],
      summary: "Create a new task",
      description: "Create a task with optional calendar sync, assignment, and framework payload. Authenticated callers can retry an identical request with the Idempotency-Key header. Use this when a user or agent wants to capture a new action item.",
      parameters: [
        { name: "Idempotency-Key", in: "header", schema: { type: "string" }, description: "Prevents duplicate creation on retry" },
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["title"],
              properties: {
                title: { type: "string", description: "Task title (required)" },
                description: { type: "string" },
                status: { type: "string", default: "todo" },
                priority: { type: "integer" },
                due_date: { type: "string", format: "date-time" },
                assigned_to: { type: "string", description: "Must start with 'ha_' or 'custom_'" },
                area_id: { type: "string" },
                project_id: { type: "string" },
                parent_id: { type: "string" },
                labels: { type: "string" },
                board_name: { type: "string" },
                task_kind: { type: "string" },
                frameworkPayload: { type: "object" },
                calendar: {
                  type: "object",
                  properties: {
                    entityId: { type: "string" },
                    startDateTime: { type: "string", format: "date-time" },
                    endDateTime: { type: "string", format: "date-time" },
                    durationMinutes: { type: "integer" },
                  },
                },
              },
            },
          },
        },
      },
      responses: {
        201: jsonContent(ref("Task"), "Task created"),
        200: jsonContent(ref("Task"), "Idempotent replay — task already existed"),
        400: err400,
        500: err500,
      },
    },
  },
  "/api/nfc/complete": {
    post: { operationId: "completeTaskByNfcTag", tags: ["Tasks"], summary: "Complete the uniquely assigned incomplete task for an NFC tag",
      requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["tag_id"], properties: { tag_id: { type: "string" } } } } } },
      responses: { 200: { description: "Task completed (or already complete on retry)" }, 400: err400, 404: { description: "No matching task" }, 409: { description: "Tag is assigned ambiguously" }, 500: err500 },
    },
  },
  "/api/tasks/{id}/handoff": {
    post: {
      operationId: "manageTaskHandoff",
      tags: ["Tasks"],
      summary: "Claim, release, or propose edits to a task",
      description: "Requires tasks:propose. Claim returns a five-minute lease. Release and propose require that lease and the issuing token. Propose sends title or description changes to the administrator review queue without changing the task.",
      security: [{ bearerAuth: [] }],
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" }, description: "Task ID or ticket key" }],
      requestBody: { required: true, content: { "application/json": { schema: {
        type: "object",
        required: ["action"],
        properties: {
          action: { type: "string", enum: ["claim", "release", "propose"] },
          lease: { type: "string", format: "uuid", description: "Required for release and propose" },
          summary: { type: "string", maxLength: 500, description: "Required for propose" },
          updates: { type: "object", description: "Required for propose. Include at least one field.", properties: {
            title: { type: "string", minLength: 1, maxLength: 500 },
            description: { type: "string", maxLength: 10000 },
          }, additionalProperties: false },
        },
        additionalProperties: false,
      } } } },
      responses: {
        200: { description: "Claim returns lease and expiresAt. Proposal returns hash and reviewUntil. Times are Unix milliseconds." },
        400: { description: "Invalid handoff request" },
        401: { description: "An active agent token is required" },
        403: { description: "The agent token lacks tasks:propose" },
        404: { description: "Task not found" },
        409: { description: "The task, claim, or proposal is unavailable or changed" },
        422: { description: "The proposal does not change the task" },
      },
    },
  },
  "/api/tasks/{id}/accept-proposal": {
    post: {
      operationId: "reviewTaskProposal",
      tags: ["Tasks"],
      summary: "Approve or reject a pending task proposal",
      description: "Home Assistant administrator session and same-site request required. A proposal hash ties the decision to the reviewed content. Agent tokens cannot review proposals.",
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
      requestBody: { required: true, content: { "application/json": { schema: {
        type: "object",
        required: ["action", "proposal_hash"],
        properties: { action: { type: "string", enum: ["accept", "reject"] }, proposal_hash: { type: "string", pattern: "^[a-f0-9]{64}$" } },
        additionalProperties: false,
      } } } },
      responses: {
        200: { description: "Review decision applied" },
        403: { description: "A same-site Home Assistant administrator session is required" },
        409: { description: "The proposal expired, was already reviewed, or its task changed" },
      },
    },
  },
  "/api/tasks/{id}": {
    get: {
      operationId: "getTask",
      tags: ["Tasks"],
      summary: "Get a single task by ID",
      description: "Retrieve full task details including subtasks, checklists, comments count, and framework payload. Use this before updating a task to get its current state.",
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
      responses: { 200: jsonContent(ref("Task"), "Task details"), 404: jsonContent(ref("ProblemDetail"), "Not found") },
    },
    put: {
      operationId: "updateTask",
      tags: ["Tasks"],
      summary: "Update a task",
      description: "Send only the fields you want to change. PATCH accepts the same fields as PUT. Set project_id to an existing project ID to move the task, or null to clear the assignment. Changing the project preserves task area and status. Setting status to 'complete' triggers webhook events and optional calendar cleanup. With expected_status 'backlog', send the exact updated_at from the current task and a target status of 'pending' or 'active'. To guard a checklist write, include checklists and expected_checklists. Set expected_checklists to the exact checklist string or null returned by GET.",
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
      requestBody: { content: { "application/json": { schema: {
        type: "object",
        properties: {
          title: { type: "string", minLength: 1, maxLength: 500 },
          description: { type: "string", description: "Task text. The server keeps the first 10,000 characters." },
          status: { type: "string", description: "Canonical task status, a supported alias, or a custom status. Backlog decisions require exactly pending or active." },
          priority: { type: "number", description: "The server rounds and clamps this to 1 through 5." },
          is_promoted: { type: "boolean", description: "Show the task above regular cards in its Kanban lane." },
          due_date: { type: ["string", "null"] },
          assigned_to: { type: ["string", "null"] },
          project_id: { type: ["string", "null"] },
          parent_id: { type: ["string", "null"] },
          area_id: { type: "string" },
          labels: { type: "string", description: "JSON-encoded array of label names", example: '["repair","garage"]' },
          checklists: { type: "string", description: "Replacement JSON-encoded checklist array" },
          expected_checklists: { type: ["string", "null"], description: "Exact previous checklist value returned by GET" },
          updated_at: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER, description: "Observed task version as epoch milliseconds. Send the exact observed value with expected_status backlog." },
          expected_status: { type: "string", const: "backlog", description: "Requires exact updated_at and status pending or active. The task must still be in Backlog." },
        },
        dependentRequired: { expected_checklists: ["checklists"] },
        if: { required: ["expected_status"] },
        then: { required: ["updated_at", "status"], properties: { status: { enum: ["pending", "active"] } } },
        additionalProperties: true,
      } } } },
      responses: {
        200: jsonContent(ref("Task"), "Updated"),
        400: err400,
        404: jsonContent(ref("ProblemDetail"), "Not found"),
        409: {
          description: "Task version, intake state or checklist changed, dependencies remain open, or the destination is unavailable",
          content: {
            "application/json": { schema: { oneOf: [
              {
                type: "object",
                required: ["error", "code", "checklists"],
                properties: {
                  error: { type: "string" }, code: { const: "checklist_conflict" },
                  checklists: { type: ["string", "null"] },
                },
              },
              {
                type: "object",
                required: ["error", "errorCode", "server_updated_at", "client_updated_at"],
                properties: {
                  error: { type: "string" }, errorCode: { const: "TASK_VERSION_CONFLICT" },
                  server_updated_at: { type: "integer" }, client_updated_at: { type: "integer" },
                },
              },
              {
                type: "object",
                required: ["error", "errorCode", "blocked_by"],
                properties: {
                  error: { type: "string" }, errorCode: { const: "TASK_BLOCKED" },
                  blocked_by: { type: "array", items: {
                    type: "object",
                    required: ["id", "title", "status", "ticket_key"],
                    properties: {
                      id: { type: "string" }, title: { type: "string" },
                      status: { type: "string" }, ticket_key: { type: ["string", "null"] },
                    },
                  } },
                },
              },
            ] } },
            "application/problem+json": { schema: ref("ProblemDetail") },
          },
        },
      },
    },
    delete: {
      operationId: "deleteTask",
      tags: ["Tasks"],
      summary: "Delete a task",
      description: "Permanently removes a task and its domain events. Consider setting status to 'archived' instead if you want recoverability.",
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
      responses: { 200: { description: "Deleted" }, 404: jsonContent(ref("ProblemDetail"), "Not found") },
    },
  },
  "/api/tasks/clear-completed": {
    post: {
      operationId: "clearCompletedTasks",
      tags: ["Tasks"],
      summary: "Archive all completed tasks",
      description: "Moves all tasks with status 'complete' to 'archived'. Use this in daily/weekly cleanup automations.",
      responses: { 200: jsonContent({ type: "object", properties: { archived: { type: "integer" } } }, "Count of archived tasks") },
    },
  },
  "/api/tasks/delete-completed": {
    delete: {
      operationId: "deleteCompletedTasks",
      tags: ["Tasks"],
      summary: "Permanently delete all completed tasks",
      description: "⚠️ Destructive. Permanently removes all tasks with status 'complete'. Cannot be undone. Prefer clearCompletedTasks for safe cleanup.",
      responses: { 200: jsonContent({ type: "object", properties: { deleted: { type: "integer" } } }, "Count of deleted tasks") },
    },
  },
  "/api/tasks/reorder": {
    post: {
      operationId: "reorderTasks",
      tags: ["Tasks"],
      summary: "Reorder tasks by position",
      description: "Reorder the supplied tasks across their shared rank slots, or move one card relative to another card in the same Kanban lane and promotion group.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: {
          type: "object",
          properties: {
            ordered_ids: { type: "array", minItems: 1, items: { type: "string" } },
            task_id: { type: "string" },
            anchor_id: { type: "string" },
            lane: { type: "string" },
            before: { type: "boolean" },
          },
          oneOf: [{ required: ["ordered_ids"] }, { required: ["task_id", "anchor_id", "lane", "before"] }],
        } } },
      },
      responses: {
        200: { description: "Reordered" },
        409: jsonContent({
          type: "object",
          properties: { error: { type: "string" }, errorCode: { type: "string", const: "TASK_ORDER_CONFLICT" } },
          required: ["error", "errorCode"],
        }, "A requested card is missing, deferred, duplicated, or outside the required lane or promotion group"),
      },
    },
  },

  // ── Task Sub-resources ──
  "/api/task-drafts": {
    post: {
      operationId: "readTaskDraft",
      tags: ["Tasks"],
      summary: "Read your active New Task draft and publication receipt",
      description: "Private Home Assistant browser route. Send JSON with action read. An optional resolve object names a save attempt, or an exact publish attempt with draftId and revision. Verify the returned account context with HEAD before displaying data.",
      requestBody: { required: true, content: { "application/json": { schema: {
        type: "object", required: ["action"], additionalProperties: false,
        properties: { action: { const: "read" }, resolve: { type: "object" } },
      } } } },
      responses: {
        200: jsonContent({ type: "object", required: ["context", "draft", "latestReceipt"],
          properties: { context: pinContext, draft: { type: ["object", "null"] }, latestReceipt: { type: ["object", "null"] }, resolution: { type: "object" } },
        }, "Current owner’s draft and receipt"),
        400: problemContent("Invalid draft read"), 403: problemContent("Verified active Home Assistant account required"),
        413: problemContent("Body exceeds 64 KiB"), 415: problemContent("Expected JSON"),
      },
    },
    head: {
      operationId: "verifyTaskDraftContext",
      tags: ["Tasks"],
      summary: "Verify that the private draft context still belongs to the active account",
      parameters: [{ in: "header", name: "X-Meitheal-Draft-Context", required: true, schema: pinContext }],
      responses: {
        204: { description: "Account context still matches" }, 403: { description: "Verified active Home Assistant account required" },
        409: { description: "Account context changed or is missing" },
      },
    },
    put: {
      operationId: "writeTaskDraft",
      tags: ["Tasks"],
      summary: "Save, discard, publish, or abandon an unresolved publication",
      description: "Send at most 64 KiB. Expected is the current draftId and revision, or null for the first save. Use a stable attemptId for a save or publication. Retry an unresolved publication with its exact original task data, or advance its revision using abandon-publish.",
      parameters: [{ in: "header", name: "X-Meitheal-Draft-Context", required: true, schema: pinContext }],
      requestBody: { required: true, content: { "application/json": { schema: {
        type: "object", required: ["action", "expected"], additionalProperties: false,
        properties: {
          action: { enum: ["save", "discard", "publish", "abandon-publish"] }, expected: { type: ["object", "null"] },
          attemptId: { type: "string" }, snapshot: { type: "object" }, task: { type: "object" },
        },
      } } } },
      responses: {
        200: { description: "Draft action completed or existing publication receipt returned" },
        201: { description: "Published task with its immutable receipt" }, 400: problemContent("Invalid draft action"),
        403: problemContent("Verified active Home Assistant account required"),
        409: { description: "ACCOUNT_CHANGED or REVISION_CONFLICT" }, 413: problemContent("Body exceeds 64 KiB"),
        415: problemContent("Expected JSON"), 422: problemContent("Publication needs an available lane, goal, assignee and labels"),
        503: problemContent("Database writer busy. Retry the same action."),
      },
    },
  },
  "/api/task-inactivity": {
    post: {
      operationId: "taskInactivity",
      tags: ["Tasks"],
      summary: "Preview, manage, or display cues for task inactivity policies",
      description: "Online-only same-origin browser endpoint. On Home Assistant, an active browser account is required and saving requires a fresh administrator check. Home Assistant browser ingress requires HTTPS. A null Area selects the shared default. Days are elapsed days, zero turns the rule off, and minus one lets an Area inherit. A save uses the exact revisions and Area generation or shared Area catalog revision from a preview. The all filter shows ready tasks and deadlines within the next seven elapsed days. Page numbers beyond the result count return the last page, or one when empty.",
      requestBody: { required: true, content: { "application/json": { schema: { oneOf: [
        { type: "object", required: ["action", "areaId", "page", "filter"], additionalProperties: false,
          if: { properties: { areaId: { type: "null" } } },
          then: { properties: { days: { minimum: 0 } } }, properties: {
          action: { const: "preview" }, areaId: inactivityArea,
          page: { type: "integer", minimum: 1, maximum: 100000 }, filter: { enum: ["all", "ready", "upcoming", "stalled"] },
          days: inactivityDays,
        } },
        { type: "object", required: ["action", "areaId", "days", "expectedRevision", "expectedDefaultRevision", "areaGeneration", "expectedAreaCatalogRevision"],
          additionalProperties: false,
          if: { properties: { areaId: { type: "null" } } },
          then: { properties: { days: { minimum: 0 }, areaGeneration: { type: "null" }, expectedAreaCatalogRevision: { type: "string" } } },
          else: { properties: { areaGeneration: { type: "string" }, expectedAreaCatalogRevision: { type: "null" } } },
          properties: {
            action: { const: "save" }, areaId: inactivityArea,
            days: inactivityDays,
            expectedRevision: inactivityRevision,
            expectedDefaultRevision: inactivityRevision,
            areaGeneration: inactivityRevision, expectedAreaCatalogRevision: inactivityCatalogRevision,
          },
        },
        { type: "object", required: ["action", "ids"], additionalProperties: false, properties: {
          action: { const: "board" }, ids: { type: "array", minItems: 1, maxItems: 100,
            items: inactivityId },
        } },
      ] } } } },
      responses: {
        200: jsonContent({ oneOf: [
          inactivityObject({
            areaExists: { const: true }, areaGeneration: inactivityRevision, areaCatalogRevision: inactivityCatalogRevision,
            areas: { type: "array", items: inactivityObject({ id: inactivityId, name: { type: "string" } }) },
            policy: inactivityPolicy, defaultPolicy: inactivityPolicy, hasEffectivePolicy: { type: "boolean" },
            page: { type: "integer", minimum: 1 }, total: { type: "integer", minimum: 0 },
            tasks: { type: "array", maxItems: 25, items: inactivityObject({
              id: inactivityId, title: { type: "string" }, area_id: inactivityId,
              status: { type: "string" }, ticket_number: { type: ["integer", "null"] },
              last_activity: inactivityEpoch, deadline: { ...inactivityEpoch, type: ["integer", "null"] },
              stall_since: { ...inactivityEpoch, type: ["integer", "null"] },
            }) },
            now: inactivityEpoch, canSave: { type: "boolean" },
          }),
          inactivityObject({ policy: inactivityPolicy }),
          inactivityObject({
            now: inactivityEpoch,
            cues: { type: "object", additionalProperties: inactivityEpoch },
            stalled: { type: "object", additionalProperties: inactivityEpoch },
          }),
        ] }, "Policy preview, saved revision, or current cues for requested cards"),
        400: problemContent("Invalid action or scope"), 403: problemContent("Active browser access or administrator role required"),
        404: problemContent("Area unavailable"), 409: problemContent("Scope, revision, or Area generation changed"),
        413: problemContent("Request exceeds its action limit"), 415: problemContent("Expected JSON"),
        503: problemContent("Inactivity data or current administrator verification unavailable"),
      },
    },
  },
  "/api/comment-people": {
    post: {
      operationId: "findCommentPeople",
      tags: ["Tasks"],
      summary: "Find people to mention in a comment",
      description: "Verified same-origin Home Assistant editor only. Send the search term in a JSON body of at most 1 KiB. Returns up to five eligible people and opaque selectors.",
      parameters: [{ in: "header", name: "X-Meitheal-Mention-Context", required: true, schema: { type: "string" } }],
      requestBody: { required: true, content: { "application/json": { schema: {
        type: "object", additionalProperties: false, required: ["q"], properties: { q: { type: "string", maxLength: 40 } },
      } } } },
      responses: {
        200: { description: "Eligible people" },
        400: problemContent("Invalid search body or URL parameters"),
        403: problemContent("Current editor session required"),
        413: problemContent("Search request exceeds 1 KiB"),
        415: problemContent("Expected JSON"),
      },
    },
  },
  "/api/mention-inbox": {
    post: {
      operationId: "useMentionInbox",
      tags: ["Tasks"],
      summary: "List or mark your comment mentions",
      description: "Verified same-origin Home Assistant inbox only. Send action list with before null or a cursor, or action mark with id and read. Null id marks all read.",
      parameters: [{ in: "header", name: "X-Meitheal-Mention-Context", required: true, schema: { type: "string" } }],
      responses: { 200: { description: "Your current inbox page" }, 204: { description: "Read state saved" },
        403: problemContent("Current inbox session required"), 409: problemContent("Session changed") },
    },
  },
  "/api/task-pins": {
    post: {
      operationId: "readTaskPins",
      tags: ["Tasks"],
      summary: "Read your personal pins or check one task",
      description: "Requires a verified Home Assistant browser session. Private reads use POST to avoid legacy worker caches. Send at most 1 KiB of JSON.",
      requestBody: { required: true, content: { "application/json": { schema: { oneOf: [
        { type: "object", required: ["action"], additionalProperties: false,
          properties: { action: { const: "list" }, page: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER, default: 1 } } },
        { type: "object", required: ["action", "task"], additionalProperties: false,
          properties: { action: { const: "detail" }, task: pinTaskIdentifier } },
      ] } } } },
      responses: {
        200: jsonContent({ oneOf: [
          { type: "object", required: ["context", "page", "total", "items"], properties: {
            context: pinContext, page: { type: "integer" }, total: { type: "integer" },
            items: { type: "array", maxItems: 25, items: { type: "object",
              required: ["id", "ticket_key", "title", "status", "deferred_at", "pinned_at"], properties: {
                id: { type: "string" }, ticket_key: { type: ["string", "null"] }, title: { type: "string" },
                status: { type: "string" }, deferred_at: { type: ["integer", "null"] }, pinned_at: { type: "integer" },
              } } },
          } },
          { type: "object", required: ["context", ...Object.keys(pinState)], properties: { context: pinContext, ...pinState } },
        ] }, "Personal results and the account context required for a subsequent HEAD verification"),
        400: problemContent("Invalid pin request"), 401: problemContent("Ingress authentication required"),
        403: problemContent("Verified Home Assistant browser session required"), 404: problemContent("Task not found"),
        413: problemContent("Body exceeds 1 KiB"), 415: problemContent("Expected JSON"),
        429: problemContent("Rate limited"),
      },
    },
    head: {
      operationId: "verifyTaskPinContext",
      tags: ["Tasks"],
      summary: "Recheck the current Home Assistant account context",
      parameters: [pinContextParameter],
      responses: {
        204: { description: "Account context still matches" },
        401: { description: "Ingress authentication required" },
        403: { description: "Verified active Home Assistant account required" },
        409: { description: "Account context changed or is missing" },
        429: { description: "Rate limited" },
      },
    },
    put: {
      operationId: "setTaskPin",
      tags: ["Tasks"],
      summary: "Set the desired personal pin state",
      description: "Requires a verified Home Assistant browser session and the context from a successful private read. Send at most 1 KiB of JSON.",
      parameters: [pinContextParameter],
      requestBody: { required: true, content: { "application/json": { schema: {
        type: "object", required: ["task", "pinned"], additionalProperties: false,
        properties: { task: pinTaskIdentifier, pinned: { type: "boolean" } },
      } } } },
      responses: {
        200: jsonContent({ type: "object", required: Object.keys(pinState), properties: pinState }, "Saved pin state"),
        400: problemContent("Invalid pin request"), 401: problemContent("Ingress authentication required"),
        403: problemContent("Verified Home Assistant browser session required"), 404: problemContent("Task not found"),
        409: jsonContent({ type: "object", required: ["error", "errorCode"], properties: {
          error: { type: "string" }, errorCode: { const: "PIN_CONTEXT_CHANGED" },
        } }, "Account context changed or is missing"),
        413: problemContent("Body exceeds 1 KiB"), 415: problemContent("Expected JSON"),
        429: problemContent("Rate limited"),
      },
    },
  },
  "/api/tasks/{id}/deferral": {
    patch: {
      operationId: "setTaskDeferral",
      tags: ["Tasks"],
      summary: "Defer or resume open work",
      description: "Use the task_version and deferral_revision from the current task read. Resuming preserves the underlying workflow status.",
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
      requestBody: {
        required: true,
        content: { "application/json": { schema: {
          type: "object",
          properties: {
            deferred: { type: "boolean" },
            updated_at: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
            deferral_revision: { type: "string", nullable: true, pattern: "^[a-f0-9]{32}$" },
          },
          required: ["deferred", "updated_at", "deferral_revision"],
          additionalProperties: false,
        } } },
      },
      responses: {
        200: jsonContent({
          type: "object",
          properties: {
            id: { type: "string" }, status: { type: "string" }, updated_at: { type: "integer" },
            deferred_at: { type: "integer", nullable: true },
            deferral_revision: { type: "string", nullable: true, pattern: "^[a-f0-9]{32}$" },
          },
          required: ["id", "status", "updated_at", "deferred_at", "deferral_revision"],
        }, "Current deferral state"),
        400: problemContent("Invalid deferral request"),
        404: problemContent("Task not found"),
        409: jsonContent({
          type: "object",
          properties: {
            error: { type: "string" },
            errorCode: { type: "string", enum: ["TASK_VERSION_CONFLICT", "TASK_DEFERRAL_TERMINAL", "TASK_BLOCKED"] },
            server_updated_at: { type: "integer" }, client_updated_at: { type: "integer" },
            server_deferral_revision: { type: "string", nullable: true },
            client_deferral_revision: { type: "string", nullable: true },
            blocked_by: { type: "array", items: {
              type: "object",
              properties: { id: { type: "string" }, title: { type: "string" }, status: { type: "string" }, ticket_key: { type: "string", nullable: true } },
            } },
          },
          required: ["error", "errorCode"],
        }, "The current task conflicts with the requested change"),
        413: problemContent("Deferral request exceeds 1 KiB"),
      },
    },
  },
  "/api/tasks/{id}/comments": {
    get: {
      operationId: "getTaskComments",
      tags: ["Tasks"],
      summary: "List comments on a task",
      description: "Historical comments remain readable with task access. If Home Assistant cannot verify current membership, mention selectors are hidden and can_manage is false.",
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
      responses: { 200: jsonContent({ type: "object", required: ["comments"], properties: { comments: arrOf("TaskCommentListItem") } }, "Comments") },
    },
    post: {
      operationId: "addTaskComment",
      tags: ["Tasks"],
      summary: "Add a comment to a task",
      description: "Add a status update or handoff note. Home Assistant comment mentions require a current member, a rendered-account context, and a durable attempt header. Retry with the same text and attempt header for 48 hours under the original account. The JSON body is limited to 32 KiB.",
      parameters: [
        { name: "id", in: "path", required: true, schema: { type: "string" } },
        { name: "X-Meitheal-Comment-Attempt", in: "header", schema: { type: "string" } },
        { name: "X-Meitheal-Mention-Context", in: "header", schema: { type: "string" } },
      ],
      requestBody: commentBody,
      responses: {
        201: jsonContent(ref("TaskComment"), "The comment added by this request"),
        400: err400,
        403: problemContent("An active, nonsystem Home Assistant account or an automation token with task-write permission is required."),
        404: problemContent("Task not found."),
        408: problemContent("The request body did not arrive in time."),
        409: problemContent("The rendered account changed, a selected person is unavailable, or the attempt already used different text."),
        410: problemContent("The comment from the original attempt was deleted."),
        413: problemContent("The request body exceeds 32 KiB."),
        415: problemContent("The request body must be application/json."),
      },
    },
  },
  "/api/tasks/{id}/comments/{commentId}": {
    get: {
      operationId: "getTaskComment",
      tags: ["Tasks"],
      summary: "Get one comment on a task",
      description: "If Home Assistant cannot verify current membership, mention selectors are hidden.",
      parameters: commentResourceParameters,
      responses: {
        200: jsonContent(ref("TaskComment"), "The comment"),
        404: problemContent("Comment not found on this task."),
      },
    },
    patch: {
      operationId: "updateTaskComment",
      tags: ["Tasks"],
      summary: "Edit your comment",
      description: "The same currently active Home Assistant user or automation credential that created the comment may edit it. A display name does not grant ownership. Home Assistant edits containing mentions require the rendered-account context.",
      parameters: [...commentResourceParameters, { name: "X-Meitheal-Mention-Context", in: "header", schema: { type: "string" } }],
      requestBody: commentBody,
      responses: {
        200: jsonContent(ref("TaskComment"), "The updated comment"),
        400: err400,
        403: problemContent("An active, nonsystem Home Assistant account or an automation token with task-write permission is required."),
        404: problemContent("The comment was not found on this task or does not belong to the caller."),
        408: problemContent("The request body did not arrive in time."),
        409: problemContent("The rendered account changed or a selected person is unavailable."),
        413: problemContent("The request body exceeds 32 KiB."),
        415: problemContent("The request body must be application/json."),
      },
    },
    delete: {
      operationId: "deleteTaskComment",
      tags: ["Tasks"],
      summary: "Delete your comment",
      description: "Permanently remove a comment created by the same currently active Home Assistant user or automation credential.",
      parameters: commentResourceParameters,
      responses: {
        204: { description: "Comment deleted" },
        403: problemContent("An active, nonsystem Home Assistant account or an automation token with task-write permission is required."),
        404: problemContent("The comment was not found on this task or does not belong to the caller."),
        408: problemContent("A keyed request body did not arrive in time."),
      },
    },
  },
  "/api/tasks/{id}/reactions": taskReactionPaths.collection,
  "/api/tasks/{id}/reactions/{reactionId}": taskReactionPaths.item,
  "/api/tasks/{id}/comments/{commentId}/reactions": commentReactionPaths.collection,
  "/api/tasks/{id}/comments/{commentId}/reactions/{reactionId}": commentReactionPaths.item,
  "/api/tasks/reaction-counts": {
    get: {
      operationId: "getTaskReactionCounts",
      tags: ["Tasks"],
      summary: "Count card reactions for a batch of tasks",
      description: "Returns positive counts keyed by task ID. Comment reactions are excluded. Home Assistant ingress requires current membership. Automation tokens need tasks:read.",
      security: reactionSecurity,
      parameters: [{ name: "ids", in: "query", required: true,
        schema: { type: "string", maxLength: 12899 }, description: "1 to 100 comma-separated task IDs." }],
      responses: { 200: jsonContent(ref("TaskReactionCounts"), "Positive card reaction counts"), 400: err400, ...reactionResponseErrors },
    },
  },
  "/api/tasks/{id}/links": {
    get: { operationId: "getTaskLinks", tags: ["Tasks"], summary: "Get linked tasks", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { 200: { description: "Links" } } },
    post: { operationId: "linkTask", tags: ["Tasks"], summary: "Link two tasks", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], requestBody: { content: { "application/json": { schema: { type: "object", properties: { target_id: { type: "string" }, link_type: { type: "string" } } } } } }, responses: { 200: { description: "Linked" } } },
    delete: { operationId: "unlinkTask", tags: ["Tasks"], summary: "Remove a task link", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { 200: { description: "Unlinked" } } },
  },
  "/api/tasks/{id}/activity": {
    get: { operationId: "getTaskActivity", tags: ["Tasks"], summary: "Get task activity timeline", description: "Returns the audit trail for a specific task — useful for understanding what changed and when.", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { 200: { description: "Activity log" } } },
  },
  "/api/tasks/{id}/timeline": {
    get: { operationId: "getTaskTimeline", tags: ["Tasks"], summary: "Get task timeline entries", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { 200: { description: "Timeline" } } },
  },
  "/api/tasks/{id}/time": {
    get: { operationId: "getTaskTimeEntries", tags: ["Tasks"], summary: "Get time tracking entries", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { 200: { description: "Time entries" } } },
    post: { operationId: "addTaskTimeEntry", tags: ["Tasks"], summary: "Log time against a task", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], requestBody: { content: { "application/json": { schema: { type: "object", properties: { duration_minutes: { type: "integer" }, note: { type: "string" } } } } } }, responses: { 201: { description: "Logged" } } },
  },
  "/api/tasks/{id}/duplicate": {
    post: { operationId: "duplicateTask", tags: ["Tasks"], summary: "Duplicate a task", description: "Creates a copy of the task with a new ID. Useful for creating recurring instances or templates.", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { 201: jsonContent(ref("Task"), "Duplicated task") } },
  },

  // ── Search ──
  "/api/search": {
    get: {
      operationId: "searchMeitheal",
      tags: ["Search"],
      summary: "Universal search across tasks, views, settings, and actions",
      description: "The primary search endpoint for all Meitheal content. Supports scoped search (tasks, views, settings, actions), field selection, and sorting. Use scope=tasks for task-specific searches, or scope=all for universal discovery.",
      parameters: [
        { name: "q", in: "query", schema: { type: "string" }, description: "Search text. Omit for recent tasks." },
        { name: "scope", in: "query", schema: { type: "string", enum: ["all", "tasks", "views", "settings", "actions"], default: "all" } },
        { name: "limit", in: "query", schema: { type: "integer", default: 8, minimum: 1, maximum: Number.MAX_SAFE_INTEGER }, description: "Positive decimal integer. The effective per-section limit is capped at 12." },
        { name: "sort", in: "query", schema: { type: "string", enum: ["relevance", "updated"], default: "relevance" } },
        { name: "include_completed", in: "query", schema: { type: "boolean" } },
        { name: "include_archived", in: "query", schema: { type: "boolean" } },
        { name: "status", in: "query", schema: { type: "string" } },
        { name: "assigned_to", in: "query", schema: { type: "string" } },
        { name: "priority", in: "query", schema: { type: "integer" } },
        { name: "task_fields", in: "query", schema: { type: "string" }, description: "Comma-separated: id,title,description,labels,custom_fields,comments" },
      ],
      responses: {
        200: jsonContent(ref("SearchResult"), "Search results"), 400: err400,
        401: problemContent("Ingress or API credential required"),
        403: problemContent("Agent token lacks search:read"),
        429: problemContent("Rate limit exceeded"), 500: err500,
      },
    },
  },

  // ── Areas ──
  "/api/areas": {
    get: { operationId: "listAreas", tags: ["Hierarchy"], summary: "List all areas", description: "Areas are the top-level organizational containers (WHERE things happen). Every goal and project belongs to an area.", responses: { 200: jsonContent(arrOf("Area"), "Areas") } },
    post: { operationId: "createArea", tags: ["Hierarchy"], summary: "Create an area", requestBody: { content: { "application/json": { schema: ref("Area") } } }, responses: { 201: jsonContent(ref("Area"), "Created") } },
  },
  "/api/areas/{id}": {
    get: { operationId: "getArea", tags: ["Hierarchy"], summary: "Get area details", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { 200: jsonContent(ref("Area"), "Area") } },
    put: { operationId: "updateArea", tags: ["Hierarchy"], summary: "Update an area", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], requestBody: { content: { "application/json": { schema: ref("Area") } } }, responses: { 200: jsonContent(ref("Area"), "Updated") } },
    delete: { operationId: "deleteArea", tags: ["Hierarchy"], summary: "Delete an area", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { 200: { description: "Deleted" } } },
  },

  // ── Goals ──
  "/api/goals": {
    get: { operationId: "listGoals", tags: ["Hierarchy"], summary: "List all goals", description: "Goals define WHAT you want to achieve. They belong to areas and can have metric tracking (percentage, count, boolean).", responses: { 200: jsonContent(arrOf("Goal"), "Goals") } },
    post: { operationId: "createGoal", tags: ["Hierarchy"], summary: "Create a goal", requestBody: { content: { "application/json": { schema: ref("Goal") } } }, responses: { 201: jsonContent(ref("Goal"), "Created") } },
  },
  "/api/goals/{id}": {
    get: { operationId: "getGoal", tags: ["Hierarchy"], summary: "Get goal details", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { 200: jsonContent(ref("Goal"), "Goal") } },
    put: { operationId: "updateGoal", tags: ["Hierarchy"], summary: "Update a goal, including progress metrics", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], requestBody: { content: { "application/json": { schema: ref("Goal") } } }, responses: { 200: jsonContent(ref("Goal"), "Updated") } },
    delete: { operationId: "deleteGoal", tags: ["Hierarchy"], summary: "Delete a goal", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { 200: { description: "Deleted" } } },
  },

  // ── Projects ──
  "/api/projects": {
    get: { operationId: "listProjects", tags: ["Hierarchy"], summary: "List all projects", description: "Projects are containers for tasks within an area. They can be linked to goals for progress tracking.", responses: { 200: jsonContent(arrOf("Project"), "Projects") } },
    post: { operationId: "createProject", tags: ["Hierarchy"], summary: "Create a project", requestBody: { content: { "application/json": { schema: ref("Project") } } }, responses: { 201: jsonContent(ref("Project"), "Created") } },
  },
  "/api/projects/{id}": {
    get: { operationId: "getProject", tags: ["Hierarchy"], summary: "Get project details", parameters: [
      { name: "id", in: "path", required: true, schema: { type: "string" } },
      { name: "task_counts", in: "query", schema: { type: "string", enum: ["1"] }, description: "Include full-project active, total and completed task counts." },
    ], responses: { 200: jsonContent(ref("Project"), "Project") } },
    put: { operationId: "updateProject", tags: ["Hierarchy"], summary: "Update a project", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], requestBody: { content: { "application/json": { schema: ref("Project") } } }, responses: { 200: jsonContent(ref("Project"), "Updated") } },
    delete: { operationId: "deleteProject", tags: ["Hierarchy"], summary: "Delete a project", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { 200: { description: "Deleted" } } },
  },

  // ── Pillars ──
  "/api/pillars": {
    get: { operationId: "listPillars", tags: ["Pillars"], summary: "List all identity pillars", description: "Pillars are the WHY layer — permanent motivational anchors representing who the user wants to be. Soft limit of 5-6 pillars.", responses: { 200: jsonContent(arrOf("Pillar"), "Pillars") } },
    post: { operationId: "createPillar", tags: ["Pillars"], summary: "Create a pillar", requestBody: { content: { "application/json": { schema: ref("Pillar") } } }, responses: { 201: jsonContent(ref("Pillar"), "Created") } },
  },
  "/api/pillars/{id}": {
    get: { operationId: "getPillar", tags: ["Pillars"], summary: "Get pillar details", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { 200: jsonContent(ref("Pillar"), "Pillar") } },
    put: { operationId: "updatePillar", tags: ["Pillars"], summary: "Update a pillar", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], requestBody: { content: { "application/json": { schema: ref("Pillar") } } }, responses: { 200: jsonContent(ref("Pillar"), "Updated") } },
    delete: { operationId: "deletePillar", tags: ["Pillars"], summary: "Delete a pillar", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { 200: { description: "Deleted" } } },
  },
  "/api/pillars/{id}/principles": {
    get: { operationId: "listPillarPrinciples", tags: ["Pillars"], summary: "List principles for a pillar", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { 200: { description: "Principles" } } },
    post: { operationId: "addPillarPrinciple", tags: ["Pillars"], summary: "Add a principle to a pillar", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], requestBody: { content: { "application/json": { schema: { type: "object", properties: { text: { type: "string" } } } } } }, responses: { 201: { description: "Added" } } },
  },
  "/api/pillars/{id}/associations": {
    get: { operationId: "listPillarAssociations", tags: ["Pillars"], summary: "List goals/habits associated with a pillar", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { 200: { description: "Associations" } } },
    post: { operationId: "addPillarAssociation", tags: ["Pillars"], summary: "Associate a goal or habit with a pillar", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], requestBody: { content: { "application/json": { schema: { type: "object", properties: { entity_type: { type: "string", enum: ["goal", "habit"] }, entity_id: { type: "string" } } } } } }, responses: { 201: { description: "Associated" } } },
  },

  // ── Labels ──
  "/api/labels": {
    get: { operationId: "listLabels", tags: ["Labels"], summary: "List all labels", responses: { 200: jsonContent(arrOf("Label"), "Labels") } },
    post: { operationId: "createLabel", tags: ["Labels"], summary: "Create a label", requestBody: { content: { "application/json": { schema: ref("Label") } } }, responses: { 201: jsonContent(ref("Label"), "Created") } },
  },
  "/api/labels/cleanup": {
    post: {
      operationId: "useLabelCleanup", tags: ["Labels"], summary: "Review and remove selected unused label definitions",
      description: "Online-only same-origin administrator browser action. Home Assistant requires a fresh administrator check. Preview includes at most 25 definitions unused across all task states, legacy links, saved drafts and templates. Remove rechecks every selected revision and current usage in one transaction. A blocked or stale result deletes nothing. The 8 KiB request body contains filters and selections. Responses are private and no-store.",
      requestBody: { required: true, content: { "application/json": { schema: { oneOf: [
        { type: "object", additionalProperties: false, required: ["action", "afterId"], properties: {
          action: { const: "preview" }, afterId: { type: ["integer", "null"], minimum: 1, maximum: 9007199254740991 },
        } },
        { type: "object", additionalProperties: false, required: ["action", "labels"], properties: {
          action: { const: "remove" }, labels: { type: "array", minItems: 1, maxItems: 25, uniqueItems: true,
            items: { type: "object", additionalProperties: false, required: ["id", "revision"], properties: {
              id: { type: "integer", minimum: 1, maximum: 9007199254740991 }, revision: { type: "string", pattern: "^[a-f0-9]{64}$" },
            } },
          },
        } },
      ] } } } },
      responses: {
        200: jsonContent({ oneOf: [
          { type: "object", required: ["ok", "labels", "nextAfter"], properties: {
            ok: { const: true }, nextAfter: { type: ["integer", "null"] }, labels: { type: "array", maxItems: 25,
              items: { type: "object", required: ["id", "title", "hexColor", "revision"], properties: {
                id: { type: "integer" }, title: { type: "string" }, hexColor: { type: "string", pattern: "^#[a-fA-F0-9]{6}$" },
                revision: { type: "string", pattern: "^[a-f0-9]{64}$" },
              } },
            },
          } },
          { type: "object", required: ["ok", "removed"], properties: { ok: { const: true },
            removed: { type: "array", minItems: 1, maxItems: 25, items: { type: "integer" } },
          } },
        ] }),
        400: labelCleanupError("Invalid cleanup action or query parameters", ["invalid"]),
        401: labelCleanupError("Authenticated browser session required", ["denied"]),
        403: labelCleanupError("Current administrator browser required", ["denied"]),
        404: labelCleanupError("Noncanonical path alias rejected without redirect", ["invalid"]),
        405: { ...labelCleanupError("POST required", ["method"]), headers: { Allow: { schema: { type: "string", const: "POST" } } } },
        409: labelCleanupError("No selected definition was removed", ["stale", "blocked"]),
        413: labelCleanupError("Body exceeds 8 KiB", ["tooLarge"]), 415: labelCleanupError("Expected JSON", ["media"]),
        429: { ...labelCleanupError("Rate limited; retry after the indicated delay", ["busy"]),
          headers: { "Retry-After": { schema: { type: "string" } } } },
        499: labelCleanupError("Request cancelled", ["cancelled"]),
        503: labelCleanupError("Administrator verification, body read or storage unavailable", ["unavailable"]),
      },
    },
  },
  "/api/labels/{id}": {
    put: {
      operationId: "updateLabel", tags: ["Labels"], summary: "Update a shared label and its current references atomically",
      description: "Requires fresh Home Assistant administrator verification, or the existing local standalone operator boundary. Agent tokens are denied and this operation is excluded from MCP discovery. Renaming rewrites current task, saved-draft and template selections in one writer transaction. Ambiguous equivalent definitions or malformed selections commit nothing. Color-only edits do not scan private selections. Body limit is 4 KiB with a five-second read bound. Responses are private and no-store. Existing middleware authentication, CSRF and rate limits still apply.",
      parameters: labelMutationId,
      requestBody: { required: true, content: { "application/json": { schema: {
        type: "object", additionalProperties: false, minProperties: 1,
        properties: { title: { type: "string", description: "HTML is stripped, then the title is trimmed and validated as 1–100 UTF-16 code units with well-formed Unicode. The complete UTF-8 request must fit within 4 KiB." },
          hex_color: { type: "string", pattern: "^#?[a-fA-F0-9]{6}$" } },
      } } } },
      responses: { ...labelMutationErrors, 200: { ...jsonContent({ type: "object", required: ["id", "title", "hex_color"], properties: {
        id: { type: "integer", minimum: 1 }, title: { type: "string" }, hex_color: { type: "string", pattern: "^#[a-fA-F0-9]{6}$" },
      } }, "Committed label"), headers: { "Cache-Control": { schema: { type: "string", const: "private, no-store" } } } } },
    },
    delete: {
      operationId: "deleteLabel", tags: ["Labels"], summary: "Delete a shared label and its current references atomically",
      description: "Requires a current HA administrator or local standalone operator; agent tokens are denied and MCP excludes this operation. Send no body. The final equivalent definition removes matching current task, draft and template selections; deleting one duplicate retains their shared name references. The selected ID's legacy junctions and definition are removed in the same writer transaction. Private no-store responses contain no draft/template bodies. Middleware authentication, CSRF and rate limits still apply.",
      parameters: labelMutationId,
      responses: { ...labelDeletionErrors, 200: { ...jsonContent({ type: "object", required: ["ok", "deleted"], properties: {
        ok: { const: true }, deleted: { type: "integer", minimum: 1 },
      } }, "Committed deletion"), headers: { "Cache-Control": { schema: { type: "string", const: "private, no-store" } } } } },
    },
  },

  // ── Habits ──
  "/api/habits": {
    get: { operationId: "listHabits", tags: ["Habits"], summary: "List all habits and routines", description: "Returns habit templates with current streak data, schedule, and completion history.", responses: { 200: { description: "Habits list" } } },
    post: { operationId: "createHabit", tags: ["Habits"], summary: "Create a habit template", responses: { 201: { description: "Created" } } },
    put: { operationId: "updateHabit", tags: ["Habits"], summary: "Update a habit or record completion", description: "Send { complete: true } to record today's completion. Send other fields to update the template.", responses: { 200: { description: "Updated" } } },
    delete: { operationId: "deleteHabit", tags: ["Habits"], summary: "Delete a habit", responses: { 200: { description: "Deleted" } } },
  },

  // ── Settings ──
  "/api/settings": {
    get: { operationId: "getSettings", tags: ["Settings"], summary: "Get all application settings", description: "Returns a flat key-value map. System settings require administrator access and credential values are masked.", responses: { 200: jsonContent({ type: "object", additionalProperties: true }, "Settings map") } },
    put: { operationId: "updateSettings", tags: ["Settings"], summary: "Update a setting", description: "Send a key and value. Changing system settings requires administrator access.", requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { key: { type: "string" }, value: {} }, required: ["key"] } } } }, responses: { 200: { description: "Updated" }, 403: { description: "Administrator required" } } },
  },

  // ── Lanes (Kanban) ──
  "/api/lanes": {
    get: { operationId: "listLanes", tags: ["Views"], summary: "List kanban board lanes", responses: { 200: { description: "Lanes" } } },
    post: { operationId: "createLane", tags: ["Views"], summary: "Create a kanban lane", responses: { 201: { description: "Created" } } },
  },
  "/api/lanes/{id}": {
    put: { operationId: "updateLane", tags: ["Views"], summary: "Update a kanban lane", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { 200: { description: "Updated" } } },
    delete: { operationId: "deleteLane", tags: ["Views"], summary: "Delete a kanban lane", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { 200: { description: "Deleted" } } },
  },

  // ── Saved Filters ──
  "/api/saved-filters": {
    get: { operationId: "listSavedFilters", tags: ["Views"], summary: "List saved filter presets", responses: { 200: { description: "Saved filters" } } },
    post: { operationId: "createSavedFilter", tags: ["Views"], summary: "Create a saved filter", responses: { 201: { description: "Created" } } },
    put: { operationId: "updateSavedFilter", tags: ["Views"], summary: "Update a saved filter", responses: { 200: { description: "Updated" } } },
    delete: { operationId: "deleteSavedFilter", tags: ["Views"], summary: "Delete a saved filter", responses: { 200: { description: "Deleted" } } },
  },

  // ── Templates ──
  "/api/templates": {
    get: { operationId: "listTemplates", tags: ["Tasks"], summary: "List task templates", responses: { 200: { description: "Templates" } } },
    post: { operationId: "createTemplate", tags: ["Tasks"], summary: "Create a task template", responses: { 201: { description: "Created" } } },
  },

  // ── Users ──
  "/api/users": {
    get: { operationId: "listUsers", tags: ["Users"], summary: "List all users (HA + custom)", description: "Returns users from Home Assistant integration combined with any custom-defined users.", responses: { 200: { description: "User list" } } },
  },
  "/api/users/custom": {
    post: { operationId: "createCustomUser", tags: ["Users"], summary: "Create a custom user", responses: { 201: { description: "Created" } } },
  },

  // ── Gamification ──
  "/api/gamification": {
    get: { operationId: "getGamificationStats", tags: ["Progress"], summary: "Get gamification stats and achievements", description: "Returns XP, level, streaks, and unlocked achievements. Useful for motivation dashboards and daily briefings.", responses: { 200: { description: "Stats" } } },
  },

  // ── Pomodoro ──
  "/api/pomodoro": {
    get: { operationId: "getPomodoroState", tags: ["Focus"], summary: "Get current pomodoro timer state", responses: { 200: { description: "Timer state" } } },
    post: { operationId: "startPomodoro", tags: ["Focus"], summary: "Start or control a pomodoro session", responses: { 200: { description: "Timer updated" } } },
  },

  // ── Reminders ──
  "/api/reminders": {
    get: { operationId: "listReminders", tags: ["Tasks"], summary: "List all active reminders", responses: { 200: { description: "Reminders" } } },
    post: { operationId: "createReminder", tags: ["Tasks"], summary: "Create a reminder", responses: { 201: { description: "Created" } } },
  },

  // ── Review ──
  "/api/review/weekly": {
    get: { operationId: "getWeeklyReview", tags: ["Review"], summary: "Get weekly review summary", description: "Returns completed tasks, velocity trends, focus areas, and suggestions for the current or specified week. Perfect for weekly automation digests.", responses: { 200: { description: "Weekly review" } } },
  },
  "/api/review/velocity": {
    get: { operationId: "getVelocity", tags: ["Review"], summary: "Get task completion velocity", responses: { 200: { description: "Velocity data" } } },
  },

  // ── Frameworks (RICE, etc.) ──
  "/api/frameworks": {
    get: { operationId: "listFrameworks", tags: ["Strategy"], summary: "List available strategic frameworks", responses: { 200: { description: "Frameworks" } } },
    post: {
      operationId: "createFramework", tags: ["Strategy"], summary: "Create or import a framework",
      requestBody: { required: true, content: {
        "application/json": { schema: { type: "object", description: "Framework configuration using the existing camelCase JSON fields." } },
        "application/yaml": { schema: { type: "string", maxLength: 65536, description: "Framework YAML, at most 64 KiB of UTF-8. Uses snake_case YAML fields; generates the ID from name and sets source to imported. Alias expansion is limited to 100 and AST nesting to 64 levels." } },
      } },
      responses: { 201: { description: "Created" }, 400: { description: "Invalid YAML or framework validation errors" }, 409: { description: "Framework ID already exists" }, 413: { description: "YAML exceeds the 64 KiB UTF-8 limit" } },
    },
  },
  "/api/frameworks/{id}": {
    get: { operationId: "getFramework", tags: ["Strategy"], summary: "Get framework details", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { 200: { description: "Framework" } } },
    put: { operationId: "updateFramework", tags: ["Strategy"], summary: "Update a framework", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { 200: { description: "Updated" } } },
  },
  "/api/frameworks/{id}/export": {
    get: { operationId: "exportFramework", tags: ["Strategy"], summary: "Export framework data", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { 200: { description: "Export" } } },
  },

  // ── Rules Engine ──
  "/api/rules": {
    get: { operationId: "listRules", tags: ["Automation"], summary: "List automation rules", description: "Rules engine for automatic task mutations (e.g., auto-assign, auto-label, auto-prioritize).", responses: { 200: { description: "Rules" } } },
    post: { operationId: "createRule", tags: ["Automation"], summary: "Create an automation rule", responses: { 201: { description: "Created" } } },
    put: {
      operationId: "replaceRules", tags: ["Automation"], summary: "Replace validated task context rules atomically",
      description: "Omit replaceIds to replace the complete list. Supply replaceIds to replace only the displayed rules and preserve other custom rules. Invalid input or a failed insert preserves the previous configuration.",
      requestBody: { required: true, content: { "application/json": { schema: {
        type: "object", required: ["rules"], properties: {
          rules: { type: "array", maxItems: 1000, items: { type: "object", required: ["name"], properties: { name: { type: "string", minLength: 1, maxLength: 500 } } } },
          replaceIds: { type: "array", maxItems: 1000, items: { type: "string", maxLength: 128 } },
        },
      } } } },
      responses: { 200: { description: "Rules replaced" }, 400: { description: "Invalid rules or replacement IDs" }, 500: { description: "Replacement failed; previous rules unchanged" } },
    },
  },
  "/api/rules/{id}": {
    put: { operationId: "updateRule", tags: ["Automation"], summary: "Update a rule", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { 200: { description: "Updated" } } },
    delete: { operationId: "deleteRule", tags: ["Automation"], summary: "Delete a rule", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { 200: { description: "Deleted" } } },
  },
  "/api/rules/defaults": {
    post: { operationId: "restoreRuleDefaults", tags: ["Automation"], summary: "Atomically restore Strategic rules and clear framework overrides", responses: { 200: { description: "Defaults restored" }, 500: { description: "Reset failed; previous configuration unchanged" } } },
  },
  "/api/rules/resolve": {
    post: { operationId: "resolveRules", tags: ["Automation"], summary: "Test rule resolution against a task payload", description: "Dry-run: shows what rules would fire for a given task payload without applying changes.", responses: { 200: { description: "Resolution result" } } },
  },

  // ── Features ──
  "/api/features": {
    get: { operationId: "getFeatureFlags", tags: ["System"], summary: "Get runtime feature flags", responses: { 200: { description: "Feature flags" } } },
  },

  // ── Export ──
  "/api/export/tasks.json": { get: { operationId: "exportTasksJson", tags: ["Export"], summary: "Export all tasks as JSON", responses: { 200: { description: "JSON export" } } } },
  "/api/export/tasks.csv": { get: { operationId: "exportTasksCsv", tags: ["Export"], summary: "Export all tasks as CSV", responses: { 200: { description: "CSV export" } } } },
  "/api/export/tasks.ics": { get: { operationId: "exportTasksIcs", tags: ["Export"], summary: "Export tasks as iCalendar feed", responses: { 200: { description: "ICS export" } } } },
  "/api/export/database.sqlite": {
    post: {
      operationId: "exportDatabase",
      tags: ["Export"],
      summary: "Download a consistent SQLite snapshot as a verified Home Assistant administrator",
      description: "Submit the native form from the administrator's Meitheal Settings page. The form token is valid for 15 minutes and bound to the verified user. Includes committed writes in the write-ahead log. Contains private household data and local feedback. Use the database host's backup tools for remote databases.",
      security: ingressSession,
      requestBody: {
        required: true,
        content: {
          "application/x-www-form-urlencoded": {
            schema: { type: "object", required: ["token"], properties: { token: { type: "string" } } },
          },
        },
      },
      responses: {
        200: { description: "SQLite snapshot", content: { "application/x-sqlite3": { schema: { type: "string", format: "binary" } } } },
        400: { description: "The form could not be read or the app uses a remote database" },
        403: { description: "Current administrator access and a valid same-origin download form are required" },
        404: { description: "Local database or download path unavailable" },
        409: { description: "Another database download is in progress" },
        413: { description: "The form exceeds 256 bytes" },
        415: { description: "The form must use application/x-www-form-urlencoded" },
        503: { description: "Home Assistant Core could not verify current administrator access" },
        507: { description: "Insufficient free space for a snapshot on the database volume" },
      },
    },
  },
  "/api/export/settings.json": { get: { operationId: "exportSettings", tags: ["Export"], summary: "Export settings as JSON", responses: { 200: { description: "Settings JSON" } } } },
  "/api/import/settings": { post: { operationId: "importSettings", tags: ["Export"], summary: "Import settings from JSON", responses: { 200: { description: "Imported" } } } },

  // ── License ──
  "/api/license/status": {
    get: { operationId: "getLicenseStatus", tags: ["System"], summary: "Get license key verification status", description: "Returns plan type, expiry, and validation state. Grace mode: app is fully functional without a license.", responses: { 200: { description: "License status" } } },
  },

  // ── Home Assistant ──
  "/api/ha/connection": { get: { operationId: "getHAConnection", tags: ["HomeAssistant"], summary: "Get HA WebSocket connection status", responses: { 200: { description: "Connection status" } } } },
  "/api/ha/calendars": { get: { operationId: "getHACalendars", tags: ["HomeAssistant"], summary: "List HA calendar entities", responses: { 200: { description: "Calendars" } } } },
  "/api/ha/events": { get: { operationId: "getHAEvents", tags: ["HomeAssistant"], summary: "List recent HA events", responses: { 200: { description: "Events" } } } },
  "/api/ha/services": { get: { operationId: "getHAServices", tags: ["HomeAssistant"], summary: "List HA services", responses: { 200: { description: "Services" } } } },
  "/api/ha/addons": { get: { operationId: "getHAAddons", tags: ["HomeAssistant"], summary: "List HA add-ons", responses: { 200: { description: "Add-ons" } } } },
  "/api/ha/agents": { get: { operationId: "getHAAgents", tags: ["HomeAssistant"], summary: "List HA Assist agents", responses: { 200: { description: "Agents" } } } },
  "/api/ha/assist": { post: { operationId: "sendHAAssist", tags: ["HomeAssistant"], summary: "Send a message to HA Assist", requestBody: { content: { "application/json": { schema: { type: "object", properties: { text: { type: "string" } } } } } }, responses: { 200: { description: "Assist response" } } } },

  // ── Integrations ──
  "/api/integrations/status": { get: { operationId: "getIntegrationsStatus", tags: ["Integrations"], summary: "Get status of all integrations", responses: { 200: { description: "Status map" } } } },
  "/api/integrations/test-webhook": { post: { operationId: "testWebhook", tags: ["Integrations"], summary: "Fire a test webhook event", description: "Sends a test event to configured webhook endpoints. Use this to verify webhook connectivity.", responses: { 200: { description: "Test result" } } } },
  "/api/integrations/test-event": { post: { operationId: "testEvent", tags: ["Integrations"], summary: "Fire a test HA event bus event", responses: { 200: { description: "Test result" } } } },
  "/api/integrations/calendar/sync": { post: { operationId: "syncCalendar", tags: ["Integrations"], summary: "Trigger calendar sync", responses: { 200: { description: "Sync result" } } } },
  "/api/integrations/calendar/status": { get: { operationId: "getCalendarSyncStatus", tags: ["Integrations"], summary: "Get calendar sync status", responses: { 200: { description: "Status" } } } },
  "/api/integrations/n8n/health": { get: { operationId: "getN8nHealth", tags: ["Integrations"], summary: "Check n8n connectivity", responses: { 200: { description: "Health" } } } },
  "/api/integrations/n8n/workflows": { get: { operationId: "listN8nWorkflows", tags: ["Integrations"], summary: "List n8n workflows", responses: { 200: { description: "Workflows" } } } },
  "/api/integrations/nodered/status": { get: { operationId: "getNodeRedStatus", tags: ["Integrations"], summary: "Check Node-RED connectivity", responses: { 200: { description: "Status" } } } },
  "/api/integrations/nodered/flows": { get: { operationId: "listNodeRedFlows", tags: ["Integrations"], summary: "List Node-RED flows", responses: { 200: { description: "Flows" } } } },

  // ── Grocy ──
  "/api/grocy/sync": { post: { operationId: "syncGrocy", tags: ["Integrations"], summary: "Sync shopping list with Grocy", responses: { 200: { description: "Sync result" } } } },
  "/api/grocy/settings": { get: { operationId: "getGrocySettings", tags: ["Integrations"], summary: "Get Grocy integration settings", responses: { 200: { description: "Settings" } } } },
  "/api/grocy/test": { post: { operationId: "testGrocy", tags: ["Integrations"], summary: "Test Grocy connectivity", responses: { 200: { description: "Test result" } } } },

  // ── SSE ──
  "/api/sse": {
    get: { operationId: "subscribeSSE", tags: ["Events"], summary: "Subscribe to server-sent events", description: "Real-time event stream for task changes, sync status, and system events. Use EventSource API to connect. Events: task_updated, sync_status, notification.", responses: { 200: { description: "SSE stream", content: { "text/event-stream": { schema: { type: "string" } } } } } },
  },

  // ── Todo (HA sync) ──
  "/api/todo": { get: { operationId: "listTodoLists", tags: ["HomeAssistant"], summary: "List HA todo list entities", responses: { 200: { description: "Todo lists" } } } },
  "/api/todo/items": { get: { operationId: "getTodoItems", tags: ["HomeAssistant"], summary: "Get items from a HA todo list", responses: { 200: { description: "Items" } } } },
  "/api/todo/sync": { post: { operationId: "syncTodo", tags: ["HomeAssistant"], summary: "Sync tasks with HA todo lists", responses: { 200: { description: "Sync result" } } } },

  // ── Unfurl ──
  "/api/unfurl": {
    post: {
      operationId: "unfurlUrl",
      tags: ["Tasks"],
      summary: "Read metadata for a public web link",
      description: "Send the final public HTTP or HTTPS URL without embedded credentials. The App reads up to 256 KiB of decoded HTML within the request deadline.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: { type: "object", required: ["url"], properties: { url: { type: "string", maxLength: 2048 } } } } },
      },
      responses: {
        200: { description: "Available preview metadata" },
        400: { description: "Invalid input, restricted network target, or upstream redirect" },
        408: { description: "Request body deadline exceeded" },
        413: { description: "Request exceeds 16 KiB" },
        415: { description: "Target returned a media type other than HTML" },
        502: { description: "Unable to fetch the target" },
        504: { description: "Upstream deadline exceeded" },
      },
    },
  },

  // ── MCP ──
  "/api/mcp": {
    post: {
      operationId: "mcpEndpoint", tags: ["Agents"], summary: "Model Context Protocol JSON-RPC endpoint",
      description: "Streamable HTTP with JSON responses. Use server/discover for MCP 2026-07-28 or initialize for older revisions, then tools/list and tools/call. Requires a Meitheal token with mcp:execute and the scope of each called tool.",
      requestBody: { content: { "application/json": { schema: {
        type: "object",
        properties: {
          jsonrpc: { type: "string", const: "2.0" },
          id: { type: ["string", "number"] },
          method: { type: "string", enum: ["server/discover", "initialize", "notifications/initialized", "notifications/cancelled", "ping", "tools/list", "tools/call"] },
          params: { type: "object" },
        },
      } } } },
      responses: {
        200: { description: "JSON-RPC response" },
        202: { description: "Legacy notification accepted" },
        400: { description: "Invalid request, protocol version or metadata" },
        404: { description: "MCP disabled or method unavailable" },
        413: { description: "Request exceeds 1 MiB" },
      },
    },
  },

  // ── A2A ──
  "/api/a2a/agent-card": { get: { operationId: "getA2AAgentCard", tags: ["Agents"], summary: "Get the experimental A2A discovery card", responses: { 200: { description: "Discovery card with no executable bindings" }, 404: { description: "A2A disabled" } } } },
  "/api/a2a/message": { post: { operationId: "sendA2AMessage", tags: ["Agents"], summary: "Check A2A message execution availability", responses: { 501: { description: "A2A execution is unavailable" }, 404: { description: "A2A disabled" } } } },

  // ── Agent Tokens (Zero-Trust Auth) ──
  "/api/agent-tokens": {
    post: {
      operationId: "createAgentToken",
      tags: ["Auth"],
      summary: "Create a scoped API token for an agent or automation",
      description: "Issue a zero-trust agent token with fine-grained scopes. The plaintext token is returned ONCE in the response — store it securely. Requires admin access (HA admin or settings:write scope).\n\n**For n8n/Node-RED**: Create a token with only the scopes your workflow needs, then set it as Bearer token in your HTTP Request node.",
      parameters: [
        { name: "Idempotency-Key", in: "header", schema: { type: "string" }, description: "Prevents duplicate token creation on retry" },
      ],
      requestBody: { required: true, content: { "application/json": { schema: ref("CreateAgentTokenRequest") } } },
      responses: {
        201: jsonContent(ref("CreateAgentTokenResponse"), "Token created — copy the plaintext token immediately"),
        400: err400,
        403: problemContent("Admin access required"),
      },
    },
    get: {
      operationId: "listAgentTokens",
      tags: ["Auth"],
      summary: "List all agent tokens (metadata only)",
      description: "Returns public metadata for all active tokens. Token hashes and plaintexts are never exposed. Requires admin access.",
      responses: {
        200: jsonContent(arrOf("AgentToken"), "Token list"),
        403: problemContent("Admin access required"),
      },
    },
    patch: {
      operationId: "updateAgentToken",
      tags: ["Auth"],
      summary: "Update a token's name or scopes",
      description: "Modify the display name or permission scopes of an existing token. The token value itself cannot be changed — revoke and recreate if compromised.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: { type: "object", properties: { id: { type: "string" }, name: { type: "string" }, scopes: { type: "array", items: ref("AgentScope") } }, required: ["id"] } } },
      },
      responses: {
        200: jsonContent({ type: "object", properties: { ok: { type: "boolean" }, id: { type: "string" } } }, "Updated"),
        400: err400,
        403: problemContent("Admin access required"),
        404: problemContent("Token not found"),
      },
    },
    delete: {
      operationId: "deleteAgentToken",
      tags: ["Auth"],
      summary: "Revoke or permanently delete a token",
      description: "By default, soft-revokes the token (keeps record for audit trail). Set `hard: true` to permanently delete. Revoked tokens immediately stop working.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: { type: "object", properties: { id: { type: "string" }, hard: { type: "boolean", default: false, description: "true = permanent delete, false = soft revoke" } }, required: ["id"] } } },
      },
      responses: {
        200: jsonContent({ type: "object", properties: { ok: { type: "boolean" }, id: { type: "string" }, action: { type: "string", enum: ["revoked", "deleted"] } } }, "Token revoked or deleted"),
        403: problemContent("Admin access required"),
        404: problemContent("Token not found"),
      },
    },
  },
}

// ─── Webhook events ───────────────────────────────────────────────────────────

const webhooks = {
  "task.created": {
    post: {
      operationId: "onTaskCreated",
      summary: "Fires when a new task is created",
      description: "Delivered to configured webhook endpoints and HA event bus (meitheal_task_created). Payload includes full task object.",
      requestBody: { content: { "application/json": { schema: ref("WebhookEvent") } } },
      responses: { 200: { description: "Acknowledged" } },
    },
  },
  "task.updated": {
    post: {
      operationId: "onTaskUpdated",
      summary: "Fires when a task is updated",
      description: "Delivered to webhooks and HA event bus (meitheal_task_updated). If status changes to 'complete', also fires task.completed.",
      requestBody: { content: { "application/json": { schema: ref("WebhookEvent") } } },
      responses: { 200: { description: "Acknowledged" } },
    },
  },
  "task.completed": {
    post: {
      operationId: "onTaskCompleted",
      summary: "Fires when a task is marked complete",
      description: "Delivered via meitheal_task_completed HA event. Includes completed_at timestamp.",
      requestBody: { content: { "application/json": { schema: ref("WebhookEvent") } } },
      responses: { 200: { description: "Acknowledged" } },
    },
  },
  "task.deleted": {
    post: {
      operationId: "onTaskDeleted",
      summary: "Fires when a task is permanently deleted",
      requestBody: { content: { "application/json": { schema: ref("WebhookEvent") } } },
      responses: { 200: { description: "Acknowledged" } },
    },
  },
  "task.overdue": {
    post: {
      operationId: "onTaskOverdue",
      summary: "Fires when a task passes its due date without completion",
      requestBody: { content: { "application/json": { schema: ref("WebhookEvent") } } },
      responses: { 200: { description: "Acknowledged" } },
    },
  },
  "area.updated": {
    post: {
      operationId: "onAreaUpdated",
      summary: "Fires when an area is modified",
      requestBody: { content: { "application/json": { schema: ref("WebhookEvent") } } },
      responses: { 200: { description: "Acknowledged" } },
    },
  },
}

// ─── Build the document ───────────────────────────────────────────────────────

const document = {
  openapi: "3.1.0",
  info: {
    title: "Meitheal Hub API",
    version: "0.2.35",
    description: "Meitheal is a Home Assistant-native household and homelab execution hub. This API powers task management, strategic planning, habits, calendar sync, agent orchestration, and automation integrations. All endpoints accept and return JSON unless noted otherwise.\n\n**For AI agents**: Use operationId values as tool names. Prefer searchMeitheal for discovery, createTask/updateTask for mutations. Check getHealth before starting workflows.",
    contact: { name: "Ryan Winkler", url: "https://github.com/ryan-winkler/meitheal" },
    license: { name: "AGPL-3.0", url: "https://www.gnu.org/licenses/agpl-3.0.html" },
  },
  servers: [
    { url: "./", description: "Meitheal App origin relative to this document" },
    { url: "http://localhost:4321", description: "Development server" },
  ],
  components: {
    schemas,
    securitySchemes: {
      bearerAuth: { type: "http", scheme: "bearer", description: "Meitheal API token (mth_... prefix). Administrators create tokens via POST /api/agent-tokens with the scopes the client needs." },
      haIngressSession: {
        type: "apiKey", in: "cookie", name: "ingress_session",
        description: "Home Assistant browser session. Supervisor validates it and asserts the user on the trusted transport.",
      },
      haIngressToken: { type: "apiKey", in: "header", name: "Authorization", description: "Home Assistant Supervisor ingress token (auto-injected by HA)" },
    },
  },
  security: [{ bearerAuth: [] }],
  tags: [
    { name: "System", description: "Health, features, and license" },
    { name: "Tasks", description: "Task CRUD and sub-resources (comments, links, time, activity)" },
    { name: "Search", description: "Universal search across all content types" },
    { name: "Hierarchy", description: "Areas → Goals → Projects organizational structure" },
    { name: "Pillars", description: "Identity pillars (the WHY layer), principles, and associations" },
    { name: "Labels", description: "Task labels for categorization" },
    { name: "Habits", description: "Habit templates, streaks, and routine tracking" },
    { name: "Local feedback", description: "Household Settings workflow behind verified Home Assistant ingress." },
    { name: "Settings", description: "Application configuration" },
    { name: "Views", description: "Kanban lanes, saved filters, and view configuration" },
    { name: "Users", description: "User management (HA + custom)" },
    { name: "Progress", description: "Gamification, achievements, and XP" },
    { name: "Focus", description: "Pomodoro and focus session tracking" },
    { name: "Review", description: "Weekly review, velocity, and productivity insights" },
    { name: "Strategy", description: "Strategic frameworks (RICE scoring, etc.)" },
    { name: "Automation", description: "Rules engine for automatic task mutations" },
    { name: "Export", description: "Data export (JSON, CSV, ICS, SQLite)" },
    { name: "Events", description: "Server-sent events for real-time updates" },
    { name: "HomeAssistant", description: "Home Assistant integration endpoints" },
    { name: "Integrations", description: "External integrations (n8n, Node-RED, Grocy, calendar)" },
    { name: "Agents", description: "MCP and A2A agent protocol endpoints" },
    { name: "Auth", description: "Agent token management — zero-trust authorization for automations" },
  ],
  paths,
  webhooks,
}

// ─── Write output ─────────────────────────────────────────────────────────────

mkdirSync(dirname(OUTPUT), { recursive: true })

// ─── Strict Structured Outputs: enforce additionalProperties: false ───────────
// LLMs using structured output mode (Gemini, OpenAI) require strict schemas
// to guarantee 100% deterministic outputs. Walk all object schemas and inject.
function enforceStrictSchemas(obj) {
  if (!obj || typeof obj !== "object") return
  if (Array.isArray(obj)) { obj.forEach(enforceStrictSchemas); return }
  if (obj.type === "object" && obj.properties && !("additionalProperties" in obj)) {
    obj.additionalProperties = false
  }
  for (const val of Object.values(obj)) {
    enforceStrictSchemas(val)
  }
}
enforceStrictSchemas(document.components?.schemas)
enforceStrictSchemas(document.paths)
enforceStrictSchemas(document.webhooks)
// Mark the spec as strict for LLM tooling discovery
document["x-strict"] = true

const yaml = stringify(document, { lineWidth: 120 })
writeFileSync(OUTPUT, yaml, "utf-8")
mkdirSync(dirname(JSON_OUTPUT), { recursive: true })
writeFileSync(JSON_OUTPUT, JSON.stringify({
  ...document,
  servers: [{ ...document.servers[0], url: "../" }, ...document.servers.slice(1)],
}), "utf-8")

// Count endpoints for summary
let endpointCount = 0
for (const methods of Object.values(paths)) {
  endpointCount += Object.keys(methods).length
}
console.log(`✅ Generated OpenAPI 3.1 spec → ${OUTPUT}`)
console.log(`   ${endpointCount} operations across ${Object.keys(paths).length} paths`)
console.log(`   ${Object.keys(schemas).length} component schemas`)
console.log(`   ${Object.keys(webhooks).length} webhook events`)
