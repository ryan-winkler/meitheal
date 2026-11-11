import { desc, sql } from "drizzle-orm"
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const tasks = sqliteTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    endeavorId: text("endeavor_id"),
    title: text("title").notNull(),
    description: text("description"),
    status: text("status").notNull().default("todo"),
    frameworkPayload: text("framework_payload", { mode: "json" }).notNull().default("{}"),
    calendarSyncState: text("calendar_sync_state").notNull().default("pending"),
    idempotencyKey: text("idempotency_key").notNull(),
    requestId: text("request_id").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    deferredAt: integer("deferred_at"),
    deferralRevision: text("deferral_revision"),
    inactivityTouchedAt: integer("inactivity_touched_at"),
    lastActivitySpikeAt: integer("last_activity_spike_at")
  },
  (table) => ({
    idempotencyUnique: uniqueIndex("tasks_idempotency_unique").on(table.idempotencyKey),
    requestIdx: index("tasks_request_idx").on(table.requestId),
    stateIdx: index("tasks_calendar_sync_state_idx").on(table.calendarSyncState),
    createdIdx: index("tasks_created_idx").on(table.createdAt),
    deferredOrderIdx: index("tasks_deferred_order_idx").on(desc(table.deferredAt), table.id)
      .where(sql`${table.deferredAt} IS NOT NULL`)
  })
);

export const taskInactivityPolicy = sqliteTable("task_inactivity_policy", {
  scope: text("scope").primaryKey().notNull(),
  areaId: text("area_id").unique(),
  days: integer("days").notNull(),
  revision: text("revision").notNull(),
})

export const taskPins = sqliteTable("task_pins", {
  ownerId: text("owner_id").notNull(),
  taskId: text("task_id").notNull().references(() => tasks.id, { onDelete: "cascade" }),
  pinnedAt: integer("pinned_at").notNull(),
}, table => [
  primaryKey({ columns: [table.ownerId, table.taskId] }),
  index("task_pins_owner_recent_idx").on(table.ownerId, desc(table.pinnedAt), table.taskId),
  index("task_pins_task_idx").on(table.taskId),
])

export const domainEvents = sqliteTable(
  "domain_events",
  {
    eventId: text("event_id").primaryKey(),
    eventType: text("event_type").notNull(),
    taskId: text("task_id").notNull(),
    requestId: text("request_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    payload: text("payload", { mode: "json" }).notNull(),
    createdAt: integer("created_at").notNull()
  },
  (table) => ({
    taskIdx: index("domain_events_task_idx").on(table.taskId),
    requestIdx: index("domain_events_request_idx").on(table.requestId),
    createdIdx: index("domain_events_created_idx").on(table.createdAt)
  })
);

export const integrationAttempts = sqliteTable(
  "integration_attempts",
  {
    attemptId: text("attempt_id").primaryKey(),
    taskId: text("task_id").notNull(),
    integration: text("integration").notNull(),
    requestId: text("request_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    status: text("status").notNull(),
    errorCode: text("error_code"),
    retryAfterSeconds: integer("retry_after_seconds"),
    responsePayload: text("response_payload", { mode: "json" }),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull()
  },
  (table) => ({
    taskIdx: index("integration_attempts_task_idx").on(table.taskId),
    requestIdx: index("integration_attempts_request_idx").on(table.requestId),
    idempotencyIntegrationUnique: uniqueIndex("integration_attempts_idempotency_integration_unique").on(
      table.idempotencyKey,
      table.integration
    )
  })
);

export const calendarConfirmations = sqliteTable(
  "calendar_confirmations",
  {
    confirmationId: text("confirmation_id").primaryKey(),
    taskId: text("task_id").notNull(),
    requestId: text("request_id").notNull(),
    providerEventId: text("provider_event_id"),
    source: text("source").notNull().default("ha.create_event"),
    payload: text("payload", { mode: "json" }),
    createdAt: integer("created_at").notNull()
  },
  (table) => ({
    taskIdx: index("calendar_confirmations_task_idx").on(table.taskId),
    requestIdx: index("calendar_confirmations_request_idx").on(table.requestId),
    taskRequestUnique: uniqueIndex("calendar_confirmations_task_request_unique").on(
      table.taskId,
      table.requestId
    )
  })
);

export const auditTrail = sqliteTable(
  "audit_trail",
  {
    auditId: text("audit_id").primaryKey(),
    requestId: text("request_id").notNull(),
    eventId: text("event_id"),
    taskId: text("task_id"),
    integration: text("integration"),
    level: text("level").notNull(),
    message: text("message").notNull(),
    metadata: text("metadata", { mode: "json" }),
    createdAt: integer("created_at").notNull()
  },
  (table) => ({
    requestIdx: index("audit_trail_request_idx").on(table.requestId),
    taskIdx: index("audit_trail_task_idx").on(table.taskId),
    createdIdx: index("audit_trail_created_idx").on(table.createdAt)
  })
);
