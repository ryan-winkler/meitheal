import { mkdirSync, copyFileSync, readdirSync, statSync, unlinkSync, existsSync } from "node:fs";
import path from "node:path";
import { type Client, createClient } from "@libsql/client";
import type { CalendarResult } from "@meitheal/integration-core";
import type { CalendarSyncState, CreateTaskPlan, IntegrationOutcome } from "@meitheal/domain-tasks";
import { drizzle } from "drizzle-orm/libsql";

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

let clientSingleton: Client | null = null;
let dbSingleton: ReturnType<typeof drizzle> | null = null;
let ensured = false;

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

/**
 * Auto-backup DB on cold start (PRA-25).
 * Copies the DB file to a backups/ subdirectory with FIFO rotation (max 5).
 * Skips backup if DB doesn't exist yet (fresh install).
 */
const MAX_BACKUPS = 5
function autoBackupDb(dbUrl: string): void {
  const dbPath = resolveDbPath(dbUrl)
  if (!dbPath || !existsSync(dbPath)) return

  const backupDir = path.join(path.dirname(dbPath), "backups")
  mkdirSync(backupDir, { recursive: true })

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
  const backupPath = path.join(backupDir, `meitheal-${timestamp}.db`)

  try {
    copyFileSync(dbPath, backupPath)
    // eslint-disable-next-line no-console
    console.log(`[meitheal] DB backup created: ${backupPath} (${statSync(backupPath).size} bytes)`)
  } catch {
    // eslint-disable-next-line no-console
    console.error(`[meitheal] DB backup failed — continuing without backup`)
    return
  }

  // FIFO rotation — keep max 5 backups
  try {
    const backups = readdirSync(backupDir)
      .filter(f => f.startsWith("meitheal-") && f.endsWith(".db"))
      .map(f => ({ name: f, time: statSync(path.join(backupDir, f)).mtimeMs }))
      .sort((a, b) => b.time - a.time)

    for (const old of backups.slice(MAX_BACKUPS)) {
      unlinkSync(path.join(backupDir, old.name))
    }
  } catch {
    // Non-critical — cleanup failure shouldn't block startup
  }
}

function getClient(): Client {
  if (clientSingleton) {
    return clientSingleton;
  }

  const dbUrl = resolveDbUrl();
  ensureFileDbDirectory(dbUrl);
  clientSingleton = createClient({ url: dbUrl });
  dbSingleton = drizzle(clientSingleton);
  return clientSingleton;
}

/** Drizzle ORM client — lazy-initialized singleton. Use for typed queries. */
export function getDb() {
  if (dbSingleton) {
    return dbSingleton;
  }
  getClient();
  if (!dbSingleton) {
    throw new Error("Failed to initialize Drizzle client");
  }
  return dbSingleton;
}

/** Low-level libSQL client — use for raw SQL when Drizzle isn't needed. */
export function getPersistenceClient(): Client {
  return getClient();
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

async function withTransaction<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = getClient();
  await client.execute("BEGIN");
  try {
    const result = await fn(client);
    await client.execute("COMMIT");
    return result;
  } catch (error) {
    await client.execute("ROLLBACK");
    throw error;
  }
}

async function hasColumn(client: Client, tableName: string, columnName: string): Promise<boolean> {
  const result = await client.execute(`PRAGMA table_info(${tableName})`);
  return result.rows.some((row) => String((row as Record<string, unknown>).name) === columnName);
}

/**
 * Idempotent schema bootstrap — creates all tables, indexes, and default data.
 * Safe to call on every request; short-circuits after first successful run.
 */
export async function ensureSchema(): Promise<void> {
  if (ensured) {
    return;
  }

  const client = getClient();

  // Auto-backup before any migrations (PRA-25)
  autoBackupDb(resolveDbUrl())

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
  if (!(await hasColumn(client, "tasks", "priority"))) {
    await client.execute("ALTER TABLE tasks ADD COLUMN priority INTEGER NOT NULL DEFAULT 3");
  }
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

  // Phase 15: Areas for DDD domain separation
  await client.execute(`
    CREATE TABLE IF NOT EXISTS areas (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      icon TEXT NOT NULL DEFAULT '📋',
      color TEXT NOT NULL DEFAULT '#6366F1',
      position INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  if (!(await hasColumn(client, "areas", "name")) && (await hasColumn(client, "areas", "title"))) {
    await client.execute("ALTER TABLE areas RENAME COLUMN title TO name");
  }

  // Auto-create default area if none exist
  const areaCount = await client.execute("SELECT COUNT(*) as cnt FROM areas");
  if (Number(areaCount.rows[0]?.cnt ?? 0) === 0) {
    const now = Date.now();
    await client.execute({
      sql: "INSERT INTO areas (id, name, icon, color, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      args: ["default", "Default", "📋", "#6366F1", 0, now, now],
    });
  }

  // Add area_id to tasks
  if (!(await hasColumn(client, "tasks", "area_id"))) {
    await client.execute("ALTER TABLE tasks ADD COLUMN area_id TEXT NOT NULL DEFAULT 'default'");
    await client.execute("UPDATE tasks SET area_id = 'default' WHERE area_id = 'default'");
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
  await client.execute("CREATE INDEX IF NOT EXISTS activity_log_event_type_idx ON task_activity_log(event_type)")
  await client.execute("CREATE INDEX IF NOT EXISTS activity_log_actor_type_idx ON task_activity_log(actor_type)")

  // Phase 18: Comments table
  await client.execute(`
    CREATE TABLE IF NOT EXISTS comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL,
      content TEXT NOT NULL,
      author TEXT NOT NULL DEFAULT 'user',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
    )
  `);
  // Composite index for timeline UNION query performance
  await client.execute("CREATE INDEX IF NOT EXISTS comments_task_created_idx ON comments(task_id, created_at DESC)");

  // Kanban swim lanes — server-persisted lane configuration
  await client.execute(`
    CREATE TABLE IF NOT EXISTS kanban_lanes (
      id TEXT PRIMARY KEY,
      key TEXT NOT NULL UNIQUE,
      label TEXT NOT NULL,
      icon TEXT NOT NULL DEFAULT '📌',
      position INTEGER NOT NULL DEFAULT 0,
      wip_limit INTEGER NOT NULL DEFAULT 0,
      includes TEXT NOT NULL DEFAULT '[]',
      built_in INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  // Seed default lanes if none exist
  const laneCount = await client.execute("SELECT COUNT(*) as cnt FROM kanban_lanes");
  if (Number(laneCount.rows[0]?.cnt ?? 0) === 0) {
    const now = Date.now();
    const defaultLanes = [
      { id: "lane-backlog", key: "backlog", label: "Backlog", icon: "📥", position: 0, includes: '["backlog"]', builtIn: 1 },
      { id: "lane-pending", key: "pending", label: "Todo", icon: "📋", position: 1, includes: '["pending","todo"]', builtIn: 1 },
      { id: "lane-active", key: "active", label: "In Progress", icon: "⚡", position: 2, includes: '["active","in_progress"]', builtIn: 1 },
      { id: "lane-complete", key: "complete", label: "Done", icon: "✅", position: 3, includes: '["complete","done"]', builtIn: 1 },
    ];
    for (const lane of defaultLanes) {
      await client.execute({
        sql: "INSERT INTO kanban_lanes (id, key, label, icon, position, wip_limit, includes, built_in, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?)",
        args: [lane.id, lane.key, lane.label, lane.icon, lane.position, lane.includes, lane.builtIn, now, now],
      });
    }
  }

  await client.execute("CREATE INDEX IF NOT EXISTS kanban_lanes_position_idx ON kanban_lanes(position)");

  // Migration: relabel built-in lanes Pending→Todo, Active→In Progress, Complete→Done
  await client.execute("UPDATE kanban_lanes SET label = 'Todo' WHERE key = 'pending' AND built_in = 1 AND label = 'Pending'");
  await client.execute("UPDATE kanban_lanes SET label = 'In Progress' WHERE key = 'active' AND built_in = 1 AND label = 'Active'");
  await client.execute("UPDATE kanban_lanes SET label = 'Done' WHERE key = 'complete' AND built_in = 1 AND label = 'Complete'");

  // Migration: add Backlog lane if not present (existing DBs that already seeded 3 lanes)
  const backlogExists = await client.execute({ sql: "SELECT id FROM kanban_lanes WHERE key = 'backlog' LIMIT 1", args: [] });
  if (backlogExists.rows.length === 0) {
    const now = Date.now();
    // Shift existing lanes up by 1 to make room at position 0
    await client.execute("UPDATE kanban_lanes SET position = position + 1");
    await client.execute({
      sql: "INSERT INTO kanban_lanes (id, key, label, icon, position, wip_limit, includes, built_in, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 0, ?, 1, ?, ?)",
      args: ["lane-backlog", "backlog", "Backlog", "📥", '["backlog"]', now, now],
    });
  }

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
  await client.execute("CREATE INDEX IF NOT EXISTS tasks_area_id_idx ON tasks(area_id)");
  // Human-readable ticket IDs — auto-incrementing ticket_number
  if (!(await hasColumn(client, "tasks", "ticket_number"))) {
    await client.execute("ALTER TABLE tasks ADD COLUMN ticket_number INTEGER");
    // Backfill existing tasks with sequential numbers based on insertion order (rowid)
    await client.execute("UPDATE tasks SET ticket_number = rowid WHERE ticket_number IS NULL");
  }

  await client.execute("CREATE INDEX IF NOT EXISTS tasks_task_type_idx ON tasks(task_type)");
  await client.execute("CREATE INDEX IF NOT EXISTS tasks_created_at_idx ON tasks(created_at)");
  await client.execute("CREATE INDEX IF NOT EXISTS tasks_due_date_idx ON tasks(due_date)");
  await client.execute("CREATE INDEX IF NOT EXISTS tasks_updated_at_idx ON tasks(updated_at)");
  await client.execute("CREATE INDEX IF NOT EXISTS tasks_is_favorite_idx ON tasks(is_favorite)");
  await client.execute("CREATE INDEX IF NOT EXISTS tasks_reminder_at_idx ON tasks(reminder_at)");
  await client.execute("CREATE UNIQUE INDEX IF NOT EXISTS tasks_ticket_number_idx ON tasks(ticket_number)");
  await client.execute("CREATE INDEX IF NOT EXISTS comments_task_id_idx ON comments(task_id)");

  // Assignments & Users domain — assigned_to column on tasks
  if (!(await hasColumn(client, "tasks", "assigned_to"))) {
    await client.execute("ALTER TABLE tasks ADD COLUMN assigned_to TEXT");
  }
  await client.execute("CREATE INDEX IF NOT EXISTS tasks_assigned_to_idx ON tasks(assigned_to)");

  // Kanban position — for within-lane card reordering
  if (!(await hasColumn(client, "tasks", "kanban_position"))) {
    await client.execute("ALTER TABLE tasks ADD COLUMN kanban_position INTEGER");
  }
  await client.execute("CREATE INDEX IF NOT EXISTS tasks_kanban_position_idx ON tasks(status, kanban_position)");

  // Composite index for kanban board queries — filters by both area_id and status
  await client.execute("CREATE INDEX IF NOT EXISTS tasks_board_status_idx ON tasks(area_id, status)");

  // Custom (non-HA) users — for families sharing one HA instance
  await client.execute(`
    CREATE TABLE IF NOT EXISTS custom_users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      color TEXT NOT NULL DEFAULT '#6366f1',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  // App-level settings (key/value store for defaults like default_assignee)
  await client.execute(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
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

  // UX unification: normalize legacy status values → canonical 4 (backlog/pending/active/complete)
  // Idempotent: only updates rows that still have legacy values
  await client.execute("UPDATE tasks SET status = 'pending' WHERE status = 'todo'");
  await client.execute("UPDATE tasks SET status = 'active' WHERE status = 'in_progress'");
  await client.execute("UPDATE tasks SET status = 'complete' WHERE status = 'done'");

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

  // ─── Phase 04.1a: Human-Agent DDD Core — New Hierarchy Tables ───


  // Goals: aggregate root — outcomes you're pursuing
  await client.execute(`
    CREATE TABLE IF NOT EXISTS goals (
      id TEXT PRIMARY KEY,
      area_id TEXT REFERENCES areas(id) ON DELETE SET NULL,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      target_date TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `)
  await client.execute("CREATE INDEX IF NOT EXISTS goals_area_id_idx ON goals(area_id)")
  await client.execute("CREATE INDEX IF NOT EXISTS goals_status_idx ON goals(status)")

  // Projects: aggregate root — time-bounded container of tasks toward a goal
  await client.execute(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      goal_id TEXT REFERENCES goals(id) ON DELETE SET NULL,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      icon TEXT NOT NULL DEFAULT '📋',
      color TEXT NOT NULL DEFAULT '#6366F1',
      position INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `)
  await client.execute("CREATE INDEX IF NOT EXISTS projects_goal_id_idx ON projects(goal_id)")
  await client.execute("CREATE INDEX IF NOT EXISTS projects_status_idx ON projects(status)")
  await client.execute("CREATE INDEX IF NOT EXISTS projects_goal_status_idx ON projects(goal_id, status)")

  // Task: task_kind — behavioral classification (replaces task_type hierarchy role)
  if (!(await hasColumn(client, "tasks", "task_kind"))) {
    await client.execute("ALTER TABLE tasks ADD COLUMN task_kind TEXT NOT NULL DEFAULT 'standard_action'")
    // Migrate existing task_type values → task_kind
    await client.execute("UPDATE tasks SET task_kind = 'standard_action' WHERE task_type IN ('task', 'epic', 'story')")
  }
  await client.execute("CREATE INDEX IF NOT EXISTS tasks_task_kind_idx ON tasks(task_kind)")

  // Task: project_id — links task to a project (nullable, progressive disclosure)
  if (!(await hasColumn(client, "tasks", "project_id"))) {
    await client.execute("ALTER TABLE tasks ADD COLUMN project_id TEXT")
  }
  await client.execute("CREATE INDEX IF NOT EXISTS tasks_project_id_idx ON tasks(project_id)")
  await client.execute("CREATE INDEX IF NOT EXISTS tasks_project_status_idx ON tasks(project_id, status)")

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

  // Goal metrics (PRA-27): structured progress tracking
  if (!(await hasColumn(client, "goals", "metric_type"))) {
    await client.execute("ALTER TABLE goals ADD COLUMN metric_type TEXT")
  }
  if (!(await hasColumn(client, "goals", "metric_target"))) {
    await client.execute("ALTER TABLE goals ADD COLUMN metric_target REAL")
  }
  if (!(await hasColumn(client, "goals", "metric_current"))) {
    await client.execute("ALTER TABLE goals ADD COLUMN metric_current REAL NOT NULL DEFAULT 0")
  }

  // Streak freezes (PRA-30): forgivable missed routines
  if (!(await hasColumn(client, "task_templates", "streak_freezes_used"))) {
    await client.execute("ALTER TABLE task_templates ADD COLUMN streak_freezes_used INTEGER NOT NULL DEFAULT 0")
  }
  if (!(await hasColumn(client, "task_templates", "streak_freeze_limit"))) {
    await client.execute("ALTER TABLE task_templates ADD COLUMN streak_freeze_limit INTEGER NOT NULL DEFAULT 3")
  }

  // WIP limits (PRA-07): per-area work-in-progress cap for ADHD focus
  // 0 = unlimited (default), positive integer = max active tasks per column
  if (!(await hasColumn(client, "areas", "wip_limit"))) {
    await client.execute("ALTER TABLE areas ADD COLUMN wip_limit INTEGER NOT NULL DEFAULT 0")
  }

  // Area metadata (PRA-14): energy budget + review cadence for ADHD planning
  // energy_budget: weekly hours cap for this area (0 = unlimited)
  // review_cadence: days between reviews (0 = no scheduled review)
  if (!(await hasColumn(client, "areas", "energy_budget"))) {
    await client.execute("ALTER TABLE areas ADD COLUMN energy_budget REAL NOT NULL DEFAULT 0")
  }
  if (!(await hasColumn(client, "areas", "review_cadence"))) {
    await client.execute("ALTER TABLE areas ADD COLUMN review_cadence INTEGER NOT NULL DEFAULT 0")
  }
  if (!(await hasColumn(client, "areas", "last_reviewed_at"))) {
    await client.execute("ALTER TABLE areas ADD COLUMN last_reviewed_at INTEGER")
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



  // Schema version tracking (PRA-23): set version after all migrations complete
  const versionRow = await client.execute("SELECT value FROM app_settings WHERE key = 'schema_version' LIMIT 1")
  const storedVersion = versionRow.rows.length > 0 ? Number(versionRow.rows[0]?.value ?? 0) : 0
  const targetVersion = 6
  if (storedVersion < targetVersion) {
    await client.execute({
      sql: `INSERT INTO app_settings (key, value, updated_at) VALUES ('schema_version', ?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      args: [String(targetVersion), Date.now()],
    })
  }
  currentSchemaVersion = targetVersion

  ensured = true;

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

export async function persistInitialPlan(plan: CreateTaskPlan): Promise<void> {
  const now = Date.now();

  await withTransaction(async (client) => {
    // Assign next sequential ticket_number for human-readable key (MTH-N)
    const nextNumResult = await client.execute("SELECT COALESCE(MAX(ticket_number), 0) + 1 AS next_num FROM tasks");
    const ticketNumber = Number((nextNumResult.rows[0] as Record<string, unknown>)?.next_num ?? 1);

    await client.execute({
      sql: `
        INSERT INTO tasks(
          id, title, status, framework_payload, calendar_sync_state,
          ticket_number, idempotency_key, request_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      args: [
        plan.aggregate.task.id,
        plan.aggregate.task.title,
        plan.aggregate.task.status,
        JSON.stringify(plan.aggregate.task.frameworkPayload),
        plan.aggregate.calendarSyncState,
        ticketNumber,
        plan.aggregate.idempotencyKey,
        plan.aggregate.requestId,
        now,
        now
      ]
    });

    for (const event of plan.events) {
      await client.execute({
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
      });
    }

    await client.execute({
      sql: `
        INSERT INTO integration_attempts(
          attempt_id, task_id, integration, request_id, idempotency_key, status, created_at, updated_at
        ) VALUES (?, ?, 'calendar', ?, ?, 'pending', ?, ?)
      `,
      args: [crypto.randomUUID(), plan.aggregate.task.id, plan.aggregate.requestId, plan.aggregate.idempotencyKey, now, now]
    });

    await client.execute({
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
    });
  });
}

export async function persistCalendarIntegrationResult(params: {
  taskId: string;
  requestId: string;
  idempotencyKey: string;
  result: CalendarResult;
}): Promise<PersistedTaskResponse> {
  const now = Date.now();

  await withTransaction(async (client) => {
    if (params.result.ok) {
      await client.execute({
        sql: `
          UPDATE tasks SET calendar_sync_state = 'confirmed', updated_at = ?
          WHERE id = ?
        `,
        args: [now, params.taskId]
      });

      await client.execute({
        sql: `
          UPDATE integration_attempts
          SET status = 'succeeded', response_payload = ?, updated_at = ?
          WHERE task_id = ? AND integration = 'calendar'
        `,
        args: [JSON.stringify(params.result.raw ?? null), now, params.taskId]
      });

      await client.execute({
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
      });

      await client.execute({
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
      });

      await client.execute({
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
      });

      return;
    }

    const failedState = params.result.retryable ? "failed_retryable" : "failed_terminal";

    await client.execute({
      sql: `
        UPDATE tasks SET calendar_sync_state = ?, updated_at = ?
        WHERE id = ?
      `,
      args: [failedState, now, params.taskId]
    });

    await client.execute({
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
    });

    await client.execute({
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
    });
  });

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

  const now = Date.now();
  await withTransaction(async (txClient) => {
    await txClient.execute({
      sql: `
        INSERT INTO calendar_confirmations(
          confirmation_id, task_id, request_id, provider_event_id, source, payload, created_at
        ) VALUES (?, ?, ?, ?, 'manual.confirmation', ?, ?)
      `,
      args: [
        params.confirmationId,
        params.taskId,
        params.requestId,
        params.providerEventId ?? null,
        JSON.stringify(params.payload ?? null),
        now
      ]
    });

    await txClient.execute({
      sql: `
        UPDATE tasks
        SET calendar_sync_state = 'confirmed', updated_at = ?
        WHERE id = ?
      `,
      args: [now, params.taskId]
    });

    await txClient.execute({
      sql: `
        INSERT INTO audit_trail(audit_id, request_id, task_id, integration, level, message, metadata, created_at)
        VALUES (?, ?, ?, 'calendar', 'info', 'Manual calendar confirmation persisted', ?, ?)
      `,
      args: [
        crypto.randomUUID(),
        params.requestId,
        params.taskId,
        JSON.stringify({ confirmationId: params.confirmationId, providerEventId: params.providerEventId }),
        now
      ]
    });
  });

  return { confirmationId: params.confirmationId, alreadyExisted: false };
}

export function resetPersistenceForTests(): void {
  clientSingleton = null;
  dbSingleton = null;
  ensured = false;
}
