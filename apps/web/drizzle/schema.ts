import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

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
    updatedAt: integer("updated_at").notNull()
  },
  (table) => ({
    idempotencyUnique: uniqueIndex("tasks_idempotency_unique").on(table.idempotencyKey),
    requestIdx: index("tasks_request_idx").on(table.requestId),
    stateIdx: index("tasks_calendar_sync_state_idx").on(table.calendarSyncState),
    createdIdx: index("tasks_created_idx").on(table.createdAt)
  })
);

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
