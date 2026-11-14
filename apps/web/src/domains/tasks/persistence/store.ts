import { mkdirSync } from "node:fs"
import path from "node:path";
import type { Client } from "@libsql/client"
import type { CalendarResult } from "@meitheal/integration-core";
import type { CalendarSyncState, CreateTaskPlan, IntegrationOutcome } from "@meitheal/domain-tasks";
import { assertSupportedDatabaseSchema, DATABASE_SCHEMA_VERSION, openDatabase } from "../../../../scripts/database-client.mjs"
import { autoBackupDb } from "../../../../scripts/startup-backup.mjs"
import { applyTaskDeferralMigration } from "../../../../drizzle/migrations/0004_task_deferral.mjs"
import { applyTaskPinsMigration } from "../../../../drizzle/migrations/0005_task_pins.mjs"
import { applyTaskDraftsMigration } from "../../../../drizzle/migrations/0006_task_drafts.mjs"
import { applyCommentMentionsMigration } from "../../../../drizzle/migrations/0007_comment_mentions.mjs"
import { applyTaskInactivityMigration } from "../../../../drizzle/migrations/0007_task_inactivity.mjs"
import { applyTaskStallMigration } from "../../../../drizzle/migrations/0008_task_stall.mjs"
import {
  installTaskActivityTriggers, taskWriteTriggerMetadata, validateExistingTaskWriteTriggers,
} from "../../../../drizzle/migrations/task-activity-schema.mjs"
import { reconcileTaskSchemaPrerequisites } from "../../../../drizzle/migrations/task-schema-prerequisites.mjs"
import { STATUS } from "../../../lib/status-config"
import {
  TaskRepository,
  type ExternalSyncLookup,
  type ExternalSyncMatch,
  type SyncChunkCommitResult,
  type SyncChunkItemError,
  type SyncConfirmationTarget,
  type SyncTaskMutation,
} from "./task-repository"

export type {
  ExternalSyncLookup,
  ExternalSyncMatch,
  SyncChunkCommitResult,
  SyncChunkItemError,
  SyncConfirmationTarget,
  SyncTaskMutation,
}

export interface PersistedTask {
  id: string;
  title: string;
  status: string;
  frameworkPayload: Record<string, unknown>;
  calendarSyncState: CalendarSyncState;
  idempotencyKey: string;
  requestId: string;
  assignedTo: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface PersistedTaskResponse {
  task: PersistedTask;
  integration: IntegrationOutcome;
}

let clientSingleton: Client | null = null
let clientSingletonDbUrl: string | null = null
let schemaInitialization: Promise<void> | undefined
let initializedDbUrl: string | null = null
let remoteSchemaCheck: Promise<void> | undefined
let startupBackupAttempted = false

/** Latest DB integrity check result — exposed via /api/health */
let dbIntegrityOk = true
/** Current schema version after ensureSchema() completes */
let currentSchemaVersion = 0

/** Get the latest integrity check result */
export function getDbIntegrityStatus(): boolean { return dbIntegrityOk }
/** Get the current schema version */
export function getSchemaVersion(): number { return currentSchemaVersion }

function resolveDbUrl(): string {
  return process.env.MEITHEAL_DB_URL ?? "file:./.data/meitheal.db"
}

function resolveDbPath(dbUrl: string): string | null {
  if (!dbUrl.startsWith("file:")) return null
  const dbPath = dbUrl.slice("file:".length)
  return path.isAbsolute(dbPath) ? dbPath : path.join(process.cwd(), dbPath)
}

function ensureFileDbDirectory(dbUrl: string): void {
  const absolutePath = resolveDbPath(dbUrl)
  if (absolutePath) {
    mkdirSync(path.dirname(absolutePath), { recursive: true })
  }
}

function getClient(): Client {
  const dbUrl = resolveDbUrl()
  if (clientSingleton && clientSingletonDbUrl === dbUrl) {
    return clientSingleton
  }
  if (clientSingleton) {
    const prev = clientSingleton
    clientSingleton = null
    clientSingletonDbUrl = null
    schemaInitialization = undefined
    initializedDbUrl = null
    remoteSchemaCheck = undefined
    startupBackupAttempted = false
    prev.close()
  }

  ensureFileDbDirectory(dbUrl)
  clientSingleton = openDatabase(dbUrl)
  clientSingletonDbUrl = dbUrl
  return clientSingleton
}

/** Low-level SQLite client — use for raw SQL queries. */
export function getPersistenceClient(): Client {
  return getClient();
}

/** Local admission is synchronous. Remote clients check the same marker before use. */
export function ensureDatabaseSchemaSupported(): void | Promise<void> {
  const client = getClient()
  if (client.protocol === "file") return
  remoteSchemaCheck ??= assertSupportedDatabaseSchema(client).catch(error => {
    remoteSchemaCheck = undefined
    throw error
  })
  return remoteSchemaCheck
}

function toTask(row: Record<string, unknown>): PersistedTask {
  return {
    id: String(row.id),
    title: String(row.title),
    status: String(row.status),
    frameworkPayload:
      typeof row.framework_payload === "string"
        ? (JSON.parse(row.framework_payload) as Record<string, unknown>)
        : (row.framework_payload as Record<string, unknown>) ?? {},
    calendarSyncState: String(row.calendar_sync_state) as CalendarSyncState,
    idempotencyKey: String(row.idempotency_key),
    requestId: String(row.request_id),
    assignedTo: typeof row.assigned_to === "string" ? row.assigned_to : null,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at)
  };
}

function toIntegrationOutcomeFromStored(params: {
  calendarSyncState: CalendarSyncState;
  confirmationId?: string;
  errorCode?: string;
  retryAfterSeconds?: number;
}): IntegrationOutcome {
  return {
    calendarSyncState: params.calendarSyncState,
    ...(params.confirmationId ? { confirmationId: params.confirmationId } : {}),
    ...(params.errorCode ? { errorCode: params.errorCode } : {}),
    ...(typeof params.retryAfterSeconds === "number"
      ? { retryAfterSeconds: params.retryAfterSeconds }
      : {})
  };
}

async function hasColumn(client: Client, tableName: string, columnName: string): Promise<boolean> {
  const result = await client.execute(`PRAGMA table_info(${tableName})`);
  return result.rows.some((row) => String((row as Record<string, unknown>).name) === columnName);
}

/**
 * Idempotent schema bootstrap — creates all tables, indexes, and default data.
 * Concurrent requests share one initialization and later calls reuse its result.
 */
export function ensureSchema(): Promise<void> {
  const dbUrl = resolveDbUrl()
  if (initializedDbUrl !== dbUrl) {
    schemaInitialization = undefined
    initializedDbUrl = dbUrl
  }
  schemaInitialization ??= initializeSchema().catch(error => {
    schemaInitialization = undefined
    initializedDbUrl = null
    throw error
  })
  return schemaInitialization
}

async function initializeSchema(): Promise<void> {
  const client = getClient()
  await assertSupportedDatabaseSchema(client)

  if (!startupBackupAttempted && process.env.MEITHEAL_STARTUP_BACKUP_HANDLED !== "1") {
    // A schema retry may follow partial writes. Keep the original pre-migration snapshot.
    startupBackupAttempted = true
    await autoBackupDb(client)
  }

  // WAL mode: enables concurrent reads during writes — critical for addon
  // context where SSR page loads and background syncs can overlap.
  await client.execute("PRAGMA journal_mode=WAL");

  // Integrity check: detect DB corruption on startup (PRA-24)
  try {
    const integrityResult = await client.execute("PRAGMA integrity_check(1)")
    const result = String((integrityResult.rows[0] as Record<string, unknown>)?.integrity_check ?? "")
    dbIntegrityOk = result === "ok"
    if (!dbIntegrityOk) {
      // eslint-disable-next-line no-console
      console.error(`[meitheal] DB INTEGRITY CHECK FAILED: ${result}`)
    }
  } catch {
    dbIntegrityOk = false
    // eslint-disable-next-line no-console
    console.error("[meitheal] DB integrity check threw — treating as failed")
  }

  await client.execute(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      endeavor_id TEXT,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      framework_payload TEXT NOT NULL DEFAULT '{}',
      calendar_sync_state TEXT NOT NULL DEFAULT 'pending',
      idempotency_key TEXT NOT NULL UNIQUE,
      request_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  await reconcileTaskSchemaPrerequisites(client)

  // Keep the original table names so existing labels and references retain their IDs.
  await client.execute(`
    CREATE TABLE IF NOT EXISTS vikunja_labels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL UNIQUE,
      hex_color TEXT NOT NULL DEFAULT '3f51b5'
    )
  `)
  await client.execute(`
    CREATE TABLE IF NOT EXISTS vikunja_task_labels (
      task_id TEXT NOT NULL,
      label_id INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (task_id, label_id)
    )
  `)

  await client.execute(`
    CREATE TABLE IF NOT EXISTS domain_events (
      event_id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      task_id TEXT NOT NULL,
      request_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);

  await client.execute(`
    CREATE TABLE IF NOT EXISTS integration_attempts (
      attempt_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      integration TEXT NOT NULL,
      request_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      status TEXT NOT NULL,
      error_code TEXT,
      retry_after_seconds INTEGER,
      response_payload TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(idempotency_key, integration)
    )
  `);

  await client.execute(`
    CREATE TABLE IF NOT EXISTS calendar_confirmations (
      confirmation_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      request_id TEXT NOT NULL,
      provider_event_id TEXT,
      source TEXT NOT NULL DEFAULT 'ha.create_event',
      payload TEXT,
      created_at INTEGER NOT NULL,
      UNIQUE(task_id, request_id)
    )
  `);

  await client.execute(`
    CREATE TABLE IF NOT EXISTS audit_trail (
      audit_id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL,
      event_id TEXT,
      task_id TEXT,
      integration TEXT,
      level TEXT NOT NULL,
      message TEXT NOT NULL,
      metadata TEXT,
      created_at INTEGER NOT NULL
    )
  `);

  await client.execute("CREATE INDEX IF NOT EXISTS tasks_request_idx ON tasks(request_id)");
  await client.execute("CREATE INDEX IF NOT EXISTS tasks_calendar_sync_state_idx ON tasks(calendar_sync_state)");
  await client.execute("CREATE INDEX IF NOT EXISTS tasks_created_idx ON tasks(created_at)");
  await client.execute("CREATE INDEX IF NOT EXISTS domain_events_task_idx ON domain_events(task_id)");
  await client.execute("CREATE INDEX IF NOT EXISTS domain_events_request_idx ON domain_events(request_id)");
  await client.execute("CREATE INDEX IF NOT EXISTS domain_events_created_idx ON domain_events(created_at)");
  await client.execute("CREATE INDEX IF NOT EXISTS integration_attempts_task_idx ON integration_attempts(task_id)");
  await client.execute("CREATE INDEX IF NOT EXISTS integration_attempts_request_idx ON integration_attempts(request_id)");
  await client.execute("CREATE INDEX IF NOT EXISTS calendar_confirmations_task_idx ON calendar_confirmations(task_id)");
  await client.execute("CREATE INDEX IF NOT EXISTS calendar_confirmations_request_idx ON calendar_confirmations(request_id)");
  await client.execute("CREATE INDEX IF NOT EXISTS calendar_confirmations_provider_event_idx ON calendar_confirmations(provider_event_id)");
  await client.execute("CREATE INDEX IF NOT EXISTS audit_trail_request_idx ON audit_trail(request_id)");
  await client.execute("CREATE INDEX IF NOT EXISTS audit_trail_task_idx ON audit_trail(task_id)");
  await client.execute("CREATE INDEX IF NOT EXISTS audit_trail_created_idx ON audit_trail(created_at)");

  if (!(await hasColumn(client, "integration_attempts", "updated_at"))) {
    await client.execute("ALTER TABLE integration_attempts ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0");
    await client.execute("UPDATE integration_attempts SET updated_at = created_at WHERE updated_at = 0");
  }

  // Phase 6: UI columns
  if (!(await hasColumn(client, "tasks", "due_date"))) {
    await client.execute("ALTER TABLE tasks ADD COLUMN due_date TEXT");
  }
  if (!(await hasColumn(client, "tasks", "labels"))) {
    await client.execute("ALTER TABLE tasks ADD COLUMN labels TEXT NOT NULL DEFAULT '[]'");
  }

  // Phase 14: Subtasks + Time tracking
  if (!(await hasColumn(client, "tasks", "parent_id"))) {
    await client.execute("ALTER TABLE tasks ADD COLUMN parent_id TEXT");
  }
  if (!(await hasColumn(client, "tasks", "time_tracked"))) {
    await client.execute("ALTER TABLE tasks ADD COLUMN time_tracked INTEGER NOT NULL DEFAULT 0");
  }

  // Custom fields JSON storage per task
  if (!(await hasColumn(client, "tasks", "custom_fields"))) {
    await client.execute("ALTER TABLE tasks ADD COLUMN custom_fields TEXT NOT NULL DEFAULT '{}'");
  }

  // Phase 18: Vikunja card parity — extended task fields
  if (!(await hasColumn(client, "tasks", "start_date"))) {
    await client.execute("ALTER TABLE tasks ADD COLUMN start_date TEXT");
  }
  if (!(await hasColumn(client, "tasks", "end_date"))) {
    await client.execute("ALTER TABLE tasks ADD COLUMN end_date TEXT");
  }
  if (!(await hasColumn(client, "tasks", "progress"))) {
    await client.execute("ALTER TABLE tasks ADD COLUMN progress INTEGER NOT NULL DEFAULT 0");
  }
  if (!(await hasColumn(client, "tasks", "color"))) {
    await client.execute("ALTER TABLE tasks ADD COLUMN color TEXT");
  }
  if (!(await hasColumn(client, "tasks", "is_favorite"))) {
    await client.execute("ALTER TABLE tasks ADD COLUMN is_favorite INTEGER NOT NULL DEFAULT 0");
  }
  // Phase 20: Agile hierarchy — epic/story/task type
  if (!(await hasColumn(client, "tasks", "task_type"))) {
    await client.execute("ALTER TABLE tasks ADD COLUMN task_type TEXT NOT NULL DEFAULT 'task'");
  }
  await client.execute("CREATE INDEX IF NOT EXISTS tasks_task_type_idx ON tasks(task_type)");

  // Phase 27: Summary field for card subtitles
  if (!(await hasColumn(client, "tasks", "summary"))) {
    await client.execute("ALTER TABLE tasks ADD COLUMN summary TEXT");
  }

  // Phase 29: Task activity log — audit trail (competitive parity: Jira/Asana/Linear)
  await client.execute(`
    CREATE TABLE IF NOT EXISTS task_activity_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      field TEXT NOT NULL,
      old_value TEXT,
      new_value TEXT,
      actor TEXT NOT NULL DEFAULT 'user',
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
    )
  `);
  await client.execute("CREATE INDEX IF NOT EXISTS activity_log_task_id_idx ON task_activity_log(task_id)");
  await client.execute("CREATE INDEX IF NOT EXISTS activity_log_created_at_idx ON task_activity_log(created_at)");

  // Immutable Audit Ledger columns (ADR-0014)
  if (!(await hasColumn(client, "task_activity_log", "actor_type"))) {
    await client.execute("ALTER TABLE task_activity_log ADD COLUMN actor_type TEXT NOT NULL DEFAULT 'user'")
  }
  if (!(await hasColumn(client, "task_activity_log", "event_type"))) {
    await client.execute("ALTER TABLE task_activity_log ADD COLUMN event_type TEXT NOT NULL DEFAULT 'field_change'")
  }
  if (!(await hasColumn(client, "task_activity_log", "summary"))) {
    await client.execute("ALTER TABLE task_activity_log ADD COLUMN summary TEXT")
  }
  if (!(await hasColumn(client, "task_activity_log", "correlation_id"))) {
    await client.execute("ALTER TABLE task_activity_log ADD COLUMN correlation_id TEXT")
  }
  if (!(await hasColumn(client, "task_activity_log", "feed_action"))) {
    await client.execute("ALTER TABLE task_activity_log ADD COLUMN feed_action TEXT")
  }
  if (!(await hasColumn(client, "task_activity_log", "feed_person_key"))) {
    await client.execute("ALTER TABLE task_activity_log ADD COLUMN feed_person_key TEXT")
  }
  await client.execute("CREATE INDEX IF NOT EXISTS activity_log_event_type_idx ON task_activity_log(event_type)")
  await client.execute("CREATE INDEX IF NOT EXISTS activity_log_actor_type_idx ON task_activity_log(actor_type)")

  // Reactions belong to either a task or a comment on that same task.
  await client.batch([
    `CREATE TABLE IF NOT EXISTS task_reactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      comment_id INTEGER CHECK (comment_id > 0),
      owner_key TEXT NOT NULL,
      content TEXT NOT NULL CHECK (length(content) BETWEEN 1 AND 16),
      author TEXT NOT NULL,
      FOREIGN KEY (comment_id, task_id) REFERENCES comments(id, task_id) ON DELETE CASCADE
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS task_reactions_owner_content_idx
      ON task_reactions(task_id, COALESCE(comment_id, 0), owner_key, content)`,
    "CREATE INDEX IF NOT EXISTS task_reactions_task_page_idx ON task_reactions(task_id, comment_id, id)",
    "CREATE INDEX IF NOT EXISTS task_reactions_comment_idx ON task_reactions(comment_id, task_id) WHERE comment_id IS NOT NULL",
  ], "write")

  // Phase 31: Recurring tasks — iCal RRULE format (e.g. "FREQ=WEEKLY;BYDAY=MO")
  if (!(await hasColumn(client, "tasks", "recurrence_rule"))) {
    await client.execute("ALTER TABLE tasks ADD COLUMN recurrence_rule TEXT");
  }

  // Phase 6: Rolling recurrence anchor — 'due_date' (fixed) or 'completion_date' (rolling)
  if (!(await hasColumn(client, "tasks", "recurrence_anchor"))) {
    await client.execute("ALTER TABLE tasks ADD COLUMN recurrence_anchor TEXT NOT NULL DEFAULT 'due_date'");
  }

  // Phase 12: Assignee rotation mode for recurring tasks
  if (!(await hasColumn(client, "tasks", "rotation_mode"))) {
    await client.execute("ALTER TABLE tasks ADD COLUMN rotation_mode TEXT");
  }

  // Phase 7: NFC tag ID for physical tag-to-task completion
  if (!(await hasColumn(client, "tasks", "nfc_tag_id"))) {
    await client.execute("ALTER TABLE tasks ADD COLUMN nfc_tag_id TEXT");
  }

  // Phase 31: In-task checklists — JSON array of {text, done} items
  if (!(await hasColumn(client, "tasks", "checklists"))) {
    await client.execute("ALTER TABLE tasks ADD COLUMN checklists TEXT NOT NULL DEFAULT '[]'");
  }

  // Phase 31: Reminder scheduling — ISO datetime for next reminder
  if (!(await hasColumn(client, "tasks", "reminder_at"))) {
    await client.execute("ALTER TABLE tasks ADD COLUMN reminder_at TEXT");
  }

  // Phase 31: Saved filters — user-defined reusable filter combinations
  await client.execute(`
    CREATE TABLE IF NOT EXISTS saved_filters (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      query_json TEXT NOT NULL DEFAULT '{}',
      icon TEXT NOT NULL DEFAULT '🔍',
      position INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  await client.execute("CREATE INDEX IF NOT EXISTS saved_filters_position_idx ON saved_filters(position)");

  // Phase 31: Task templates — reusable task blueprints
  // is_habit: 1 = habit template (auto-creates daily recurring tasks)
  await client.execute(`
    CREATE TABLE IF NOT EXISTS task_templates (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      template_json TEXT NOT NULL DEFAULT '{}',
      icon TEXT NOT NULL DEFAULT '📝',
      is_habit INTEGER NOT NULL DEFAULT 0,
      frequency TEXT NOT NULL DEFAULT 'daily',
      position INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  await client.execute("CREATE INDEX IF NOT EXISTS task_templates_position_idx ON task_templates(position)");

  // Habits integration: is_habit column on task_templates (existing DBs)
  if (!(await hasColumn(client, "task_templates", "is_habit"))) {
    await client.execute("ALTER TABLE task_templates ADD COLUMN is_habit INTEGER NOT NULL DEFAULT 0");
  }
  if (!(await hasColumn(client, "task_templates", "frequency"))) {
    await client.execute("ALTER TABLE task_templates ADD COLUMN frequency TEXT NOT NULL DEFAULT 'daily'");
  }

  // Habits integration: link tasks back to their source template
  if (!(await hasColumn(client, "tasks", "source_template_id"))) {
    await client.execute("ALTER TABLE tasks ADD COLUMN source_template_id TEXT");
  }
  await client.execute("CREATE INDEX IF NOT EXISTS tasks_source_template_id_idx ON tasks(source_template_id)");

  await client.execute("CREATE INDEX IF NOT EXISTS tasks_status_idx ON tasks(status)");
  await client.execute("CREATE INDEX IF NOT EXISTS tasks_priority_idx ON tasks(priority)");
  await client.execute("CREATE INDEX IF NOT EXISTS tasks_parent_id_idx ON tasks(parent_id)");
  await client.execute("CREATE INDEX IF NOT EXISTS tasks_task_type_idx ON tasks(task_type)");
  await client.execute("CREATE INDEX IF NOT EXISTS tasks_created_at_idx ON tasks(created_at)");
  await client.execute("CREATE INDEX IF NOT EXISTS tasks_due_date_idx ON tasks(due_date)");
  await client.execute("CREATE INDEX IF NOT EXISTS tasks_updated_at_idx ON tasks(updated_at)");
  await client.execute("CREATE INDEX IF NOT EXISTS tasks_is_favorite_idx ON tasks(is_favorite)");
  await client.execute("CREATE INDEX IF NOT EXISTS tasks_reminder_at_idx ON tasks(reminder_at)");

  if (!(await hasColumn(client, "tasks", "source"))) {
    await client.execute("ALTER TABLE tasks ADD COLUMN source TEXT NOT NULL DEFAULT 'user'");
  }
  if (!(await hasColumn(client, "tasks", "created_by"))) {
    await client.execute("ALTER TABLE tasks ADD COLUMN created_by TEXT");
  }

  // Custom (non-HA) users — for families sharing one HA instance
  await client.execute(`
    CREATE TABLE IF NOT EXISTS custom_users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      color TEXT NOT NULL DEFAULT '#6366f1',
      kind TEXT NOT NULL DEFAULT 'human',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  if (!(await hasColumn(client, "custom_users", "kind"))) {
    await client.execute("ALTER TABLE custom_users ADD COLUMN kind TEXT NOT NULL DEFAULT 'human'");
  }

  // Jira-style task linking — relationship types beyond parent/children
  await client.execute(`
    CREATE TABLE IF NOT EXISTS task_links (
      id TEXT PRIMARY KEY,
      source_task_id TEXT NOT NULL,
      target_task_id TEXT NOT NULL,
      link_type TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (source_task_id) REFERENCES tasks(id) ON DELETE CASCADE,
      FOREIGN KEY (target_task_id) REFERENCES tasks(id) ON DELETE CASCADE,
      UNIQUE(source_task_id, target_task_id, link_type)
    )
  `);
  await client.execute("CREATE INDEX IF NOT EXISTS task_links_source_idx ON task_links(source_task_id)");
  await client.execute("CREATE INDEX IF NOT EXISTS task_links_target_idx ON task_links(target_task_id)");

  // Strategic Lenses pivot: Task Context Rules — per-type/per-tag guardrails
  await client.execute(`
    CREATE TABLE IF NOT EXISTS rules (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      rule_type TEXT NOT NULL DEFAULT 'strategic-lens',
      task_types TEXT NOT NULL DEFAULT '[]',
      tags TEXT NOT NULL DEFAULT '[]',
      lens_ids TEXT NOT NULL DEFAULT '[]',
      ai_scope TEXT NOT NULL DEFAULT '{}',
      constraints TEXT NOT NULL DEFAULT '',
      priority INTEGER NOT NULL DEFAULT 100,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `)
  await client.execute("CREATE INDEX IF NOT EXISTS rules_rule_type_idx ON rules(rule_type)")
  await client.execute("CREATE INDEX IF NOT EXISTS rules_priority_idx ON rules(priority)")

  // Strategic Lenses pivot: Framework config overrides (user edits stored as JSON)
  await client.execute(`
    CREATE TABLE IF NOT EXISTS framework_configs (
      id TEXT PRIMARY KEY,
      framework_id TEXT NOT NULL UNIQUE,
      overrides TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `)
  await client.execute("CREATE UNIQUE INDEX IF NOT EXISTS framework_configs_fid_idx ON framework_configs(framework_id)")

  // Custom frameworks: user-created and imported full framework definitions
  await client.execute(`
    CREATE TABLE IF NOT EXISTS custom_frameworks (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'user',
      config_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `)

  // Task: task_kind — behavioral classification (replaces task_type hierarchy role)
  if (!(await hasColumn(client, "tasks", "task_kind"))) {
    await client.execute("ALTER TABLE tasks ADD COLUMN task_kind TEXT NOT NULL DEFAULT 'standard_action'")
    // Migrate existing task_type values → task_kind
    await client.execute("UPDATE tasks SET task_kind = 'standard_action' WHERE task_type IN ('task', 'epic', 'story')")
  }
  await client.execute("CREATE INDEX IF NOT EXISTS tasks_task_kind_idx ON tasks(task_kind)")

  // Domain events: entity_type — discriminator for goal/project/task events
  if (!(await hasColumn(client, "domain_events", "entity_type"))) {
    await client.execute("ALTER TABLE domain_events ADD COLUMN entity_type TEXT NOT NULL DEFAULT 'task'")
  }
  await client.execute("CREATE INDEX IF NOT EXISTS domain_events_entity_type_idx ON domain_events(entity_type)")

  // Task templates: rename is_habit → is_routine, frequency → cadence
  if (!(await hasColumn(client, "task_templates", "is_routine"))) {
    await client.execute("ALTER TABLE task_templates ADD COLUMN is_routine INTEGER NOT NULL DEFAULT 0")
    // Migrate existing habits
    if (await hasColumn(client, "task_templates", "is_habit")) {
      await client.execute("UPDATE task_templates SET is_routine = is_habit")
    }
  }
  if (!(await hasColumn(client, "task_templates", "cadence"))) {
    await client.execute("ALTER TABLE task_templates ADD COLUMN cadence TEXT NOT NULL DEFAULT 'daily'")
    // Migrate existing frequency values
    if (await hasColumn(client, "task_templates", "frequency")) {
      await client.execute("UPDATE task_templates SET cadence = frequency")
    }
  }
  if (!(await hasColumn(client, "task_templates", "streak_current"))) {
    await client.execute("ALTER TABLE task_templates ADD COLUMN streak_current INTEGER NOT NULL DEFAULT 0")
  }
  if (!(await hasColumn(client, "task_templates", "streak_best"))) {
    await client.execute("ALTER TABLE task_templates ADD COLUMN streak_best INTEGER NOT NULL DEFAULT 0")
  }

  // ─── Phase 04.1b: Bot Orchestration Core — Task Columns ───

  // owner: 'human' (default) or 'bot:<agent_name>'
  if (!(await hasColumn(client, "tasks", "owner"))) {
    await client.execute("ALTER TABLE tasks ADD COLUMN owner TEXT NOT NULL DEFAULT 'human'")
  }
  // lock_holder: bot agent name holding the lock (null = unlocked)
  if (!(await hasColumn(client, "tasks", "lock_holder"))) {
    await client.execute("ALTER TABLE tasks ADD COLUMN lock_holder TEXT")
  }
  // lock_expires_at: Unix timestamp when the lock auto-expires
  if (!(await hasColumn(client, "tasks", "lock_expires_at"))) {
    await client.execute("ALTER TABLE tasks ADD COLUMN lock_expires_at INTEGER")
  }
  // handoff_state: bot orchestration lifecycle state machine
  if (!(await hasColumn(client, "tasks", "handoff_state"))) {
    await client.execute("ALTER TABLE tasks ADD COLUMN handoff_state TEXT NOT NULL DEFAULT 'idle'")
  }
  // proposal_json: structured bot proposal for human review
  if (!(await hasColumn(client, "tasks", "proposal_json"))) {
    await client.execute("ALTER TABLE tasks ADD COLUMN proposal_json TEXT")
  }
  // proposal_hash: SHA-256 of proposal content for TOCTOU prevention
  if (!(await hasColumn(client, "tasks", "proposal_hash"))) {
    await client.execute("ALTER TABLE tasks ADD COLUMN proposal_hash TEXT")
  }
  // agent_scratchpad: ephemeral bot working notes (NEVER returned in API responses)
  if (!(await hasColumn(client, "tasks", "agent_scratchpad"))) {
    await client.execute("ALTER TABLE tasks ADD COLUMN agent_scratchpad TEXT")
  }
  await client.execute("CREATE INDEX IF NOT EXISTS tasks_handoff_state_idx ON tasks(handoff_state)")
  await client.execute("CREATE INDEX IF NOT EXISTS tasks_lock_expires_idx ON tasks(lock_expires_at)")

  // ─── Phase 05.1: Schema & Architecture Hardening (PRA-23/24/25/27/30) ───

  // Streak freezes (PRA-30): forgivable missed routines
  if (!(await hasColumn(client, "task_templates", "streak_freezes_used"))) {
    await client.execute("ALTER TABLE task_templates ADD COLUMN streak_freezes_used INTEGER NOT NULL DEFAULT 0")
  }
  if (!(await hasColumn(client, "task_templates", "streak_freeze_limit"))) {
    await client.execute("ALTER TABLE task_templates ADD COLUMN streak_freeze_limit INTEGER NOT NULL DEFAULT 3")
  }

  // PRA-13: Time-blocking columns for calendar-driven focus sessions
  // time_block_start/end: ISO 8601 datetime for scheduled focus block
  if (!(await hasColumn(client, "tasks", "time_block_start"))) {
    await client.execute("ALTER TABLE tasks ADD COLUMN time_block_start TEXT")
  }
  if (!(await hasColumn(client, "tasks", "time_block_end"))) {
    await client.execute("ALTER TABLE tasks ADD COLUMN time_block_end TEXT")
  }

  // PRA-12: Completion history for habit/template tracking
  // JSON array of { date: ISO, completed: boolean } entries
  if (!(await hasColumn(client, "task_templates", "completion_history"))) {
    await client.execute("ALTER TABLE task_templates ADD COLUMN completion_history TEXT NOT NULL DEFAULT '[]'")
  }

  // ─── Phase 06: Eisenhower Matrix — First-class urgency/importance ───

  // urgency: 0-5 (0 = unclassified), indexed for Eisenhower matrix queries
  if (!(await hasColumn(client, "tasks", "urgency"))) {
    await client.execute("ALTER TABLE tasks ADD COLUMN urgency INTEGER NOT NULL DEFAULT 0")
    // Backfill: derive urgency from due_date proximity (overdue/due today → 4, has due date → 2, else 0)
    await client.execute(`UPDATE tasks SET urgency = CASE
      WHEN due_date IS NOT NULL AND date(due_date) <= date('now') THEN 4
      WHEN due_date IS NOT NULL AND date(due_date) <= date('now', '+3 days') THEN 3
      WHEN due_date IS NOT NULL THEN 2
      ELSE 0
    END WHERE urgency = 0`)
  }
  // importance: 0-5 (0 = unclassified), indexed for Eisenhower matrix queries
  if (!(await hasColumn(client, "tasks", "importance"))) {
    await client.execute("ALTER TABLE tasks ADD COLUMN importance INTEGER NOT NULL DEFAULT 0")
    // Backfill: derive importance from priority (P1=5, P2=4, P3=3, P4=2, P5=1)
    await client.execute(`UPDATE tasks SET importance = CASE
      WHEN priority = 1 THEN 5
      WHEN priority = 2 THEN 4
      WHEN priority = 3 THEN 3
      WHEN priority = 4 THEN 2
      WHEN priority = 5 THEN 1
      ELSE 0
    END WHERE importance = 0`)
  }
  // eisenhower_override: 1 = user manually placed via drag-and-drop, 0 = auto-derived
  if (!(await hasColumn(client, "tasks", "eisenhower_override"))) {
    await client.execute("ALTER TABLE tasks ADD COLUMN eisenhower_override INTEGER NOT NULL DEFAULT 0")
  }
  await client.execute("CREATE INDEX IF NOT EXISTS tasks_urgency_idx ON tasks(urgency)")
  await client.execute("CREATE INDEX IF NOT EXISTS tasks_importance_idx ON tasks(importance)")

  // ─── Phase 07: Extended planning features — effort, blocked_by ───

  // effort_minutes: NULL = unestimated, integer = estimated minutes (5/15/30/60/120/240)
  if (!(await hasColumn(client, "tasks", "effort_minutes"))) {
    await client.execute("ALTER TABLE tasks ADD COLUMN effort_minutes INTEGER DEFAULT NULL")
  }
  // effort_type: NULL = unclassified, "deep" | "shallow" | "admin"
  if (!(await hasColumn(client, "tasks", "effort_type"))) {
    await client.execute("ALTER TABLE tasks ADD COLUMN effort_type TEXT DEFAULT NULL")
  }
  // blocked_by: NULL = not blocked, free-text describing what's blocking
  if (!(await hasColumn(client, "tasks", "blocked_by"))) {
    await client.execute("ALTER TABLE tasks ADD COLUMN blocked_by TEXT DEFAULT NULL")
  }

  // Routine Templates: separate from task_templates — owns scheduling + streak logic
  await client.execute(`
    CREATE TABLE IF NOT EXISTS routine_templates (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      cadence TEXT NOT NULL DEFAULT 'daily',
      schedule_config TEXT NOT NULL DEFAULT '{}',
      last_spawned_at INTEGER,
      streak_current INTEGER NOT NULL DEFAULT 0,
      streak_best INTEGER NOT NULL DEFAULT 0,
      streak_freezes_used INTEGER NOT NULL DEFAULT 0,
      streak_freeze_limit INTEGER NOT NULL DEFAULT 3,
      is_active INTEGER NOT NULL DEFAULT 1,
      project_id TEXT,
      goal_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `)
  await client.execute("CREATE INDEX IF NOT EXISTS routine_templates_active_idx ON routine_templates(is_active)")
  await client.execute("CREATE INDEX IF NOT EXISTS routine_templates_cadence_idx ON routine_templates(cadence)")

  // Routine Instances: link tasks to their source routine template with idempotent spawn
  if (!(await hasColumn(client, "tasks", "routine_template_id"))) {
    await client.execute("ALTER TABLE tasks ADD COLUMN routine_template_id TEXT")
  }
  if (!(await hasColumn(client, "tasks", "spawned_for_date"))) {
    await client.execute("ALTER TABLE tasks ADD COLUMN spawned_for_date TEXT")
  }
  await client.execute("CREATE INDEX IF NOT EXISTS tasks_routine_template_id_idx ON tasks(routine_template_id)")
  // Unique constraint prevents double-spawn: one instance per template per day
  await client.execute("CREATE UNIQUE INDEX IF NOT EXISTS tasks_routine_spawn_unique_idx ON tasks(routine_template_id, spawned_for_date)")

  const targetVersion = DATABASE_SCHEMA_VERSION
  const migration = await client.transaction("write")
  try {
    await assertSupportedDatabaseSchema(migration)
    validateExistingTaskWriteTriggers(await migration.execute(taskWriteTriggerMetadata))
    await migration.batch([
      "UPDATE tasks SET status = 'pending' WHERE status = 'todo'",
      "UPDATE tasks SET status = 'active' WHERE status = 'in_progress'",
      "UPDATE tasks SET status = 'complete' WHERE status = 'done'",
    ])
    await applyTaskDeferralMigration(migration)
    await applyTaskPinsMigration(migration)
    await applyTaskDraftsMigration(migration)
    await applyCommentMentionsMigration(migration)
    await applyTaskInactivityMigration(migration)
    await applyTaskStallMigration(migration)
    await installTaskActivityTriggers(migration)
    // Publish the schema version atomically with the last migration.
    await migration.execute({
      sql: `INSERT INTO app_settings (key, value, updated_at) VALUES ('schema_version', ?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
            WHERE CAST(app_settings.value AS INTEGER) < ?`,
      args: [String(targetVersion), Date.now(), targetVersion],
    })
    await migration.commit()
  } finally {
    migration.close()
  }
  currentSchemaVersion = targetVersion
}

export async function findByIdempotencyKey(idempotencyKey: string): Promise<PersistedTaskResponse | null> {
  const client = getClient();
  const taskResult = await client.execute({
    sql: `
      SELECT id, title, status, framework_payload, calendar_sync_state, idempotency_key, request_id, created_at, updated_at
      FROM tasks
      WHERE idempotency_key = ?
      LIMIT 1
    `,
    args: [idempotencyKey]
  });

  const taskRow = taskResult.rows[0] as Record<string, unknown> | undefined;
  if (!taskRow) {
    return null;
  }

  const task = toTask(taskRow);

  const confirmationResult = await client.execute({
    sql: `
      SELECT confirmation_id
      FROM calendar_confirmations
      WHERE task_id = ?
      ORDER BY created_at DESC
      LIMIT 1
    `,
    args: [task.id]
  });

  const attemptResult = await client.execute({
    sql: `
      SELECT error_code, retry_after_seconds
      FROM integration_attempts
      WHERE task_id = ? AND integration = 'calendar'
      ORDER BY created_at DESC
      LIMIT 1
    `,
    args: [task.id]
  });

  const confirmationRow = confirmationResult.rows[0] as Record<string, unknown> | undefined;
  const attemptRow = attemptResult.rows[0] as Record<string, unknown> | undefined;

  return {
    task,
    integration: toIntegrationOutcomeFromStored({
      calendarSyncState: task.calendarSyncState,
      ...(typeof confirmationRow?.confirmation_id === "string"
        ? { confirmationId: confirmationRow.confirmation_id }
        : {}),
      ...(typeof attemptRow?.error_code === "string" ? { errorCode: attemptRow.error_code } : {}),
      ...(typeof attemptRow?.retry_after_seconds === "number"
        ? { retryAfterSeconds: attemptRow.retry_after_seconds }
        : {})
    })
  };
}

/** Find a single task by UUID. Returns null if not found. */
export async function findTaskById(taskId: string): Promise<PersistedTask | null> {
  const client = getClient();
  const taskResult = await client.execute({
    sql: `
      SELECT id, title, status, framework_payload, calendar_sync_state, idempotency_key, request_id, created_at, updated_at
      FROM tasks
      WHERE id = ?
      LIMIT 1
    `,
    args: [taskId]
  });

  const taskRow = taskResult.rows[0] as Record<string, unknown> | undefined;
  if (!taskRow) {
    return null;
  }
  return toTask(taskRow);
}

export async function persistInitialPlan(plan: CreateTaskPlan, description: string | null): Promise<void> {
  const now = Date.now();

  await getClient().batch([
    {
      sql: `
        INSERT INTO tasks(
          id, title, description, status, framework_payload, calendar_sync_state,
          ticket_number, idempotency_key, request_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(ticket_number), 0) + 1 FROM tasks), ?, ?, ?, ?)
      `,
      args: [
        plan.aggregate.task.id,
        plan.aggregate.task.title,
        description,
        plan.aggregate.task.status,
        JSON.stringify(plan.aggregate.task.frameworkPayload),
        plan.aggregate.calendarSyncState,
        plan.aggregate.idempotencyKey,
        plan.aggregate.requestId,
        now,
        now
      ]
    },

    ...plan.events.map(event => ({
      sql: `
        INSERT INTO domain_events(event_id, event_type, task_id, request_id, idempotency_key, payload, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      args: [
        event.eventId,
        event.eventType,
        plan.aggregate.task.id,
        event.requestId,
        plan.aggregate.idempotencyKey,
        JSON.stringify(event.payload),
        now
      ]
    })),

    {
      sql: `
        INSERT INTO integration_attempts(
          attempt_id, task_id, integration, request_id, idempotency_key, status, created_at, updated_at
        ) VALUES (?, ?, 'calendar', ?, ?, 'pending', ?, ?)
      `,
      args: [crypto.randomUUID(), plan.aggregate.task.id, plan.aggregate.requestId, plan.aggregate.idempotencyKey, now, now]
    },

    {
      sql: `
        INSERT INTO audit_trail(audit_id, request_id, task_id, integration, level, message, metadata, created_at)
        VALUES (?, ?, ?, 'calendar', 'info', ?, ?, ?)
      `,
      args: [
        crypto.randomUUID(),
        plan.aggregate.requestId,
        plan.aggregate.task.id,
        "Task persisted and calendar sync marked pending",
        JSON.stringify({ idempotencyKey: plan.aggregate.idempotencyKey }),
        now
      ]
    },
  ], "write");
}

export async function persistCalendarIntegrationResult(params: {
  taskId: string;
  requestId: string;
  idempotencyKey: string;
  result: CalendarResult;
}): Promise<PersistedTaskResponse> {
  const now = Date.now();

  const failedState = !params.result.ok && params.result.retryable ? "failed_retryable" : "failed_terminal";
  await getClient().batch(params.result.ok ? [
    {
      sql: `
        UPDATE tasks SET calendar_sync_state = 'confirmed', updated_at = ?
        WHERE id = ?
      `,
      args: [now, params.taskId]
    },

    {
      sql: `
        UPDATE integration_attempts
        SET status = 'succeeded', response_payload = ?, updated_at = ?
        WHERE task_id = ? AND integration = 'calendar'
      `,
      args: [JSON.stringify(params.result.raw ?? null), now, params.taskId]
    },

    {
      sql: `
        INSERT OR IGNORE INTO calendar_confirmations(
          confirmation_id, task_id, request_id, provider_event_id, source, payload, created_at
        ) VALUES (?, ?, ?, ?, 'ha.create_event', ?, ?)
      `,
      args: [
        params.result.confirmationId,
        params.taskId,
        params.requestId,
        params.result.providerEventId ?? null,
        JSON.stringify(params.result.raw ?? null),
        now
      ]
    },

    {
      sql: `
        INSERT INTO domain_events(event_id, event_type, task_id, request_id, idempotency_key, payload, created_at)
        VALUES (?, 'integration.sync.completed', ?, ?, ?, ?, ?)
      `,
      args: [
        crypto.randomUUID(),
        params.taskId,
        params.requestId,
        params.idempotencyKey,
        JSON.stringify({ integration: "calendar", confirmationId: params.result.confirmationId }),
        now
      ]
    },

    {
      sql: `
        INSERT INTO audit_trail(audit_id, request_id, task_id, integration, level, message, metadata, created_at)
        VALUES (?, ?, ?, 'calendar', 'info', 'Calendar event confirmed', ?, ?)
      `,
      args: [
        crypto.randomUUID(),
        params.requestId,
        params.taskId,
        JSON.stringify({ confirmationId: params.result.confirmationId }),
        now
      ]
    },
  ] : [
    {
      sql: `
        UPDATE tasks SET calendar_sync_state = ?, updated_at = ?
        WHERE id = ?
      `,
      args: [failedState, now, params.taskId]
    },

    {
      sql: `
        UPDATE integration_attempts
        SET status = 'failed', error_code = ?, retry_after_seconds = ?, response_payload = ?, updated_at = ?
        WHERE task_id = ? AND integration = 'calendar'
      `,
      args: [
        params.result.errorCode,
        params.result.retryAfterSeconds ?? null,
        JSON.stringify(params.result.raw ?? null),
        now,
        params.taskId
      ]
    },

    {
      sql: `
        INSERT INTO audit_trail(audit_id, request_id, task_id, integration, level, message, metadata, created_at)
        VALUES (?, ?, ?, 'calendar', 'warn', 'Calendar sync failed', ?, ?)
      `,
      args: [
        crypto.randomUUID(),
        params.requestId,
        params.taskId,
        JSON.stringify({
          errorCode: params.result.errorCode,
          retryAfterSeconds: params.result.retryAfterSeconds,
          retryable: params.result.retryable
        }),
        now
      ]
    },
  ], "write");

  const persisted = await findByIdempotencyKey(params.idempotencyKey);
  if (!persisted) {
    throw new Error(`Unable to reload persisted task for idempotency key ${params.idempotencyKey}`);
  }

  return persisted;
}

export async function persistManualCalendarConfirmation(params: {
  taskId: string;
  requestId: string;
  confirmationId: string;
  providerEventId?: string;
  payload?: unknown;
}): Promise<{ confirmationId: string; alreadyExisted: boolean }> {
  const client = getClient();
  const task = await findTaskById(params.taskId);
  if (!task) {
    throw new Error(`TASK_NOT_FOUND:${params.taskId}`);
  }

  const now = Date.now();
  const [insertion] = await client.batch([
    {
      sql: `
        INSERT INTO calendar_confirmations(
          confirmation_id, task_id, request_id, provider_event_id, source, payload, created_at
        ) VALUES (?, ?, ?, ?, 'manual.confirmation', ?, ?)
        ON CONFLICT(confirmation_id) DO NOTHING
      `,
      args: [
        params.confirmationId,
        params.taskId,
        params.requestId,
        params.providerEventId ?? null,
        JSON.stringify(params.payload ?? null),
        now
      ]
    },

    {
      sql: `
        UPDATE tasks
        SET calendar_sync_state = 'confirmed', updated_at = ?
        WHERE id = ? AND changes() = 1
      `,
      args: [now, params.taskId]
    },

    {
      sql: `
        INSERT INTO audit_trail(audit_id, request_id, task_id, integration, level, message, metadata, created_at)
        SELECT ?, ?, ?, 'calendar', 'info', 'Manual calendar confirmation persisted', ?, ?
        WHERE changes() = 1
      `,
      args: [
        crypto.randomUUID(),
        params.requestId,
        params.taskId,
        JSON.stringify({ confirmationId: params.confirmationId, providerEventId: params.providerEventId }),
        now
      ]
    },
  ], "write");

  if (insertion?.rowsAffected === 0) {
    const existingResult = await client.execute({
      sql: `
        SELECT confirmation_id
        FROM calendar_confirmations
        WHERE task_id = ? AND confirmation_id = ?
        LIMIT 1
      `,
      args: [params.taskId, params.confirmationId]
    });

    const existing = existingResult.rows[0] as Record<string, unknown> | undefined;
    if (existing) {
      return { confirmationId: String(existing.confirmation_id), alreadyExisted: true };
    }
    throw new Error("Calendar confirmation ID is already associated with another task");
  }

  return { confirmationId: params.confirmationId, alreadyExisted: false };
}

export function findTasksByExternalSyncIds(lookup: ExternalSyncLookup): Promise<Map<string, ExternalSyncMatch>> {
  return new TaskRepository(getClient()).findTasksByExternalSyncIds(lookup)
}

export function commitSyncMutationChunks(
  mutations: SyncTaskMutation[],
  options?: { chunkSize?: number | undefined; signal?: AbortSignal | undefined },
): Promise<SyncChunkCommitResult> {
  return new TaskRepository(getClient()).commitSyncMutationChunks(mutations, options)
}

export function resetPersistenceForTests(): void {
  clientSingleton = null;
  schemaInitialization = undefined
  remoteSchemaCheck = undefined
  startupBackupAttempted = false
}
