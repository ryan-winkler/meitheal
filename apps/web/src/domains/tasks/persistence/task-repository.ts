/**
 * TaskRepository — centralized domain service for all task-related database queries.
 * @domain Task Management
 *
 * Provides typed, parameterized query methods for both reads and writes.
 * Read methods serve Astro page files (dashboard, kanban, calendar, etc.).
 * Write methods serve API routes (tasks CRUD, recurrence, activity logging).
 *
 * @example
 *   import { TaskRepository } from '@domains/tasks/persistence/task-repository';
 *   const repo = new TaskRepository(getPersistenceClient());
 *   const tasks = await repo.getRecentTasks(10);
 *   const created = await repo.createTask({ id: '...', title: 'New', ... });
 */

import type { Client, InStatement, InValue, ResultSet } from "@libsql/client"
import { executeWriteWithRetry, runWriteTransaction } from "../../../../scripts/database-client.mjs"
import { getStatusDef, isDoneStatus, normalizeStatus, STATUS } from "../../../lib/status-config"
import { logApiError, logApiWarn } from "../../../lib/api-logger"
import { EXACT_TASK_IDENTIFIER_SCORE } from "../../../lib/task-search-score"
import { readStoredCalendarDay } from "../../../lib/calendar-day"
import { calendarDayFromInput, calendarToday, shiftCalendarDay } from "../../../lib/date"
import { parseTicketKey } from "../../../lib/ticket-key"
import { getNextOccurrence, parseRRule } from "../recurrence"
import { deferralTerminalStatusesSql, isDeferralTerminalStatus } from "./task-deferral-status"
import { discardUnappliedTaskActivity, taskChangedActivity, type RecentTaskActor } from "./recent-activity"
import { nextTaskTimestampMs, taskTimestampMs } from "./task-timestamp"
import { inactivityRuleActor, inactivityWriteGuard } from "./task-inactivity-query"
import { openTaskDependencies } from "./task-dependencies"

/**
 * Both date-only (`YYYY-MM-DD`) and timed ISO (`YYYY-MM-DDTHH:MM...`) due dates
 * are evaluated against the household calendar day so events occurring today are never overdue.
 * Arguments: today (YYYY-MM-DD in the user's timezone), complete status.
 */
const OVERDUE_TASK_PREDICATE = "due_date IS NOT NULL AND due_date <> '' AND substr(due_date, 1, 10) < ? AND status != ?"

function overdueArgs(today?: string): [string] {
  return [today ?? calendarToday()]
}
const taskHistoryPredicate = "(feed_action IS NULL OR field <> 'activity')"

type RecurrenceSuccessor = {
  id: string
  ticketNumber: number
  title: string
  dueDate: string
  rule: string
}
type RecurrenceOutcome = RecurrenceSuccessor | "invalid" | undefined

export type TaskCatalogRow = Pick<TaskRow, "id" | "ticket_number" | "title" | "status" | "priority" | "deferred_at"> & {
  score: number
  id_hit?: number
  exact_id?: number
  title_at?: number
  description_hit?: number
  labels_hit?: number
  custom_fields_hit?: number
  comments_hit?: number
  excerpt?: string | null
}

// ── Types ──────────────────────────────────────────────────────────────────

/**
 * Typed task row — maps every column in the `tasks` table.
 *
 * The index signature `[key: string]: unknown` is kept intentionally so
 * existing `as TaskRow` casts from libSQL's generic `Row` type still compile,
 * while all known fields now provide autocompletion and type-safe access.
 *
 * @see store.ts ensureSchema() for the canonical column definitions.
 */
export interface TaskRow {
  [key: string]: unknown
  // ── Core (CREATE TABLE) ──
  id: string
  endeavor_id: string | null
  title: string
  description: string | null
  status: string
  framework_payload: string
  calendar_sync_state: string
  idempotency_key: string
  request_id: string
  created_at: number
  updated_at: number
  task_version?: number
  deferred_at: number | null
  deferral_revision: string | null
  // ── Phase 2 additions ──
  priority: number
  due_date: string | null
  labels: string
  parent_id: string | null
  time_tracked: number
  area_id: string
  custom_fields: string
  start_date: string | null
  end_date: string | null
  progress: number
  color: string | null
  is_favorite: number
  is_promoted: number
  task_type: string
  summary: string | null
  // ── Phase 3 (recurrence, checklists, NFC) ──
  recurrence_rule: string | null
  recurrence_anchor: string
  rotation_mode: string | null
  nfc_tag_id: string | null
  checklists: string | null
  reminder_at: string | null
  source_template_id: string | null
  ticket_number: number | null
  assigned_to: string | null
  kanban_position: number | null
  // ── Phase 4 (DDD hierarchy + human-agent) ──
  task_kind: string
  project_id: string | null
  goal_id: string | null
  owner: string
  lock_holder: string | null
  lock_expires_at: number | null
  handoff_state: string
  proposal_json: string | null
  proposal_hash: string | null
  agent_scratchpad: string | null
  // ── Phase 6 (time-blocking) ──
  time_block_start: string | null
  time_block_end: string | null
  // ── Phase 6 (Eisenhower matrix) ──
  urgency: number
  importance: number
  eisenhower_override: number
  // ── Phase 7 (extended planning) ──
  effort_minutes: number | null
  effort_type: string | null
  blocked_by: string | null
}

/**
 * Strip agent_scratchpad from task rows before returning to callers.
 * The scratchpad is ephemeral bot working data that must NEVER appear in API responses.
 */
function sanitizeRows(rows: TaskRow[]): TaskRow[] {
  return rows.map(row => {
    const { agent_scratchpad: _, ...rest } = row
    return rest as unknown as TaskRow
  })
}

function cloneRecurringChecklist(checklists: string | null): string {
  if (!checklists) return "[]"
  let input: unknown
  try {
    input = JSON.parse(checklists)
  } catch {
    return "[]"
  }
  if (!Array.isArray(input)) return "[]"

  const steps: Array<{ text: string; id?: string }> = []
  for (const row of input) {
    if (typeof row === "string") {
      steps.push({ text: row })
    } else if (row && typeof row.text === "string") {
      const id = typeof row.id === "string" && row.id.trim() ? row.id : undefined
      steps.push(id ? { text: row.text, id } : { text: row.text })
    }
  }
  const reserved = new Set(steps.map(step => step.id))
  const assigned = new Set<string>()
  return JSON.stringify(steps.map(({ text, id }) => {
    if (!id || assigned.has(id)) {
      do {
        id = crypto.randomUUID()
      } while (reserved.has(id))
      reserved.add(id)
    }
    assigned.add(id)
    return { id, text, done: false }
  }))
}

/** Status count for dashboard statistics */
export interface StatusCount {
  status: string;
  count: number;
}

/** Dashboard statistics aggregate */
export interface DashboardStats {
  total: number;
  open: number;
  active: number;
  completed: number;
  overdue: number;
}

/** Area metadata */
export interface AreaInfo {
  id: string;
  name: string;
  color: string;
}

/** Calendar day task aggregate */
export interface CalendarDayInfo {
  dueDate: string;
  count: number;
  colors: string[];
  haEvents: number;
}

/** Kanban lane definition */
export interface KanbanLane {
  id: string;
  key: string;
  label: string;
  icon: string;
  includes: string[];
  builtIn: boolean;
  wipLimit: number;
}

/** Narrow projection used to filter and count all eligible cards before pagination. */
export type KanbanIndexRow = Pick<TaskRow, "id" | "status" | "priority" | "task_type" | "task_kind" | "area_id" | "assigned_to" | "is_promoted"> &
  Partial<Pick<TaskRow, "title" | "labels">> & { overdue?: number }

/** Setting key-value pair */
export interface SettingRow {
  key: string;
  value: string;
}

// ── Repository ─────────────────────────────────────────────────────────────

type TaskBlocker = Pick<TaskRow, "id" | "title" | "status" | "ticket_number">
type DeferralState = Pick<TaskRow, "id" | "status" | "deferred_at" | "deferral_revision" | "updated_at">
type DeferralDiagnostic = DeferralState & { assigned_to?: string | null }

type DeferralResult =
  | { ok: true; task: DeferralState }
  | { ok: false; errorCode: "unavailable" | "terminal" | "ineligible" | "assignee_mismatch" }
  | { ok: false; errorCode: "conflict"; task: DeferralState }
  | { ok: false; errorCode: "blocked"; blockers: TaskBlocker[] }

/**
 * Centralized repository for task-related database queries.
 * Replaces inline SQL in Astro page files to enforce DDD boundaries.
 *
 * Design decisions:
 * - Returns raw `TaskRow[]` to avoid coupling to specific page needs.
 * - Uses parameterized queries to prevent SQL injection.
 * - Each method maps 1:1 to a query previously inline in a page file.
 * - Stateless: client injected via constructor (follows existing store pattern).
 */
export type TaskCreationData = {
  id: string; title: string; description: string; status: string;
  priority: number; due_date: string | null; labels: string;
  framework_payload: string; parent_id: string | null;
  area_id: string; custom_fields: string; project_id?: string | null; goal_id?: string | null; start_date: string | null;
  end_date: string | null; progress: number; color: string | null;
  is_favorite: number; task_type: string; task_kind?: string;
  assigned_to: string | null; checklists?: string | null;
  recurrence_rule?: string | null;
  urgency?: number; importance?: number;
  effort_minutes?: number | null; effort_type?: string | null; blocked_by?: string | null;
  source?: string; created_by?: string | null;
}

/** Use one statement for an ordinary insert or a conditional insert in a write batch. */
export function taskInsertStatement(data: TaskCreationData, createdAt: number, {
  idempotencyKey = crypto.randomUUID(),
  requestId = crypto.randomUUID(),
  guard,
}: {
  idempotencyKey?: string
  requestId?: string
  guard?: { sql: string; args: InValue[] }
} = {}): InStatement {
  return {
    sql: `INSERT INTO tasks (id, title, description, status, priority, due_date, labels,
                             framework_payload, calendar_sync_state, parent_id, time_tracked, project_id, goal_id,
                             area_id, custom_fields, start_date, end_date, progress, color, is_favorite,
                             task_type, task_kind, ticket_number, assigned_to, checklists, recurrence_rule,
                             urgency, importance, effort_minutes, effort_type, blocked_by,
                             source, created_by,
                             idempotency_key, request_id, created_at, updated_at)
          SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                  (SELECT COALESCE(MAX(ticket_number), 0) + 1 FROM tasks), ?, ?, ?, ?, ?, ?, ?, ?,
                  ?, ?,
                  ?, ?, ?, ?
          ${guard ? `WHERE ${guard.sql}` : ""}
          RETURNING ticket_number`,
    args: [
      data.id, data.title, data.description, normalizeStatus(data.status), data.priority,
      data.due_date, data.labels, data.framework_payload,
      STATUS.PENDING, data.parent_id, data.project_id ?? null, data.goal_id ?? null, data.area_id, data.custom_fields,
      data.start_date, data.end_date, data.progress, data.color, data.is_favorite,
      data.task_type, data.task_kind ?? "standard_action", data.assigned_to,
      data.checklists ?? "[]", data.recurrence_rule ?? null,
      data.urgency ?? 0, data.importance ?? 0,
      data.effort_minutes ?? null, data.effort_type ?? null, data.blocked_by ?? null,
      data.source ?? "user", data.created_by ?? null,
      idempotencyKey, requestId, createdAt, createdAt,
      ...(guard?.args ?? []),
    ] as InValue[],
  }
}

export type ExternalSyncLookup =
  | { source: "ha_todo"; entityId: string; externalIds: string[] }
  | { source: "calendar"; entityId: string; externalIds: string[] }
  | { source: "grocy"; grocyEntityType: "chore" | "task" | "shopping"; externalIds: string[] }

export interface ExternalSyncMatch {
  confirmationId: string
  taskId: string
  externalId: string
  syncUpdatedAt: number
  taskUpdatedAt: number
}

export type SyncConfirmationTarget =
  | {
      source: "ha_todo"
      entityId: string
      externalId: string
      confirmationId?: string | undefined
      syncDirection?: "inbound" | "outbound" | undefined
      payload: string
    }
  | {
      source: "calendar"
      entityId: string
      externalId: string
      previousExternalId?: string | undefined
      confirmationId?: string | undefined
      confirmationSource?: string | undefined
      payload: string
    }
  | {
      source: "grocy"
      grocyEntityType: "chore" | "task" | "shopping"
      externalId: string
      confirmationId?: string | undefined
      syncDirection?: "inbound" | "outbound" | undefined
      payload: string
    }

export type SyncTaskMutation =
  | {
      kind: "create"
      taskId?: string | undefined
      requestId?: string | undefined
      idempotencyKey: string
      title: string
      description?: string | null | undefined
      status?: string | undefined
      priority?: number | undefined
      dueDate?: string | null | undefined
      startDate?: string | null | undefined
      endDate?: string | null | undefined
      recurrenceRule?: string | null | undefined
      labels?: string[] | string | undefined
      areaId?: string | undefined
      taskType?: string | undefined
      taskKind?: string | undefined
      createdAt?: number | undefined
      confirmation: SyncConfirmationTarget
    }
  | {
      kind: "update"
      taskId: string
      title?: string | undefined
      description?: string | null | undefined
      replaceDescription?: boolean | undefined
      status?: string | undefined
      openEcho?: boolean | undefined
      dueDate?: string | null | undefined
      updateDueDate?: boolean | undefined
      startDate?: string | null | undefined
      endDate?: string | null | undefined
      recurrenceRule?: string | null | undefined
      taskKind?: string | undefined
      areaId?: string | undefined
      ensureCalendarSyncLabel?: boolean | undefined
      updatedAt?: number | undefined
      confirmation?: (SyncConfirmationTarget & { requireUnmodifiedSinceSync?: boolean | undefined }) | undefined
    }
  | {
      kind: "link"
      taskId: string
      requestId?: string | undefined
      createdAt?: number | undefined
      confirmation: SyncConfirmationTarget
    }

export interface SyncChunkItemError {
  index: number
  message: string
}

export interface SyncChunkCommitResult {
  created: number
  updated: number
  linked: number
  skipped: number
  chunksCommitted: number
  ticketNumbers: number[]
  errors: SyncChunkItemError[]
}

const ensuredTodoSyncClients = new WeakSet<Client>()
const ensuredGrocySyncClients = new WeakSet<Client>()

async function ensureTodoSyncConfirmationTable(client: Client): Promise<void> {
  if (ensuredTodoSyncClients.has(client)) return
  await client.execute(`
    CREATE TABLE IF NOT EXISTS todo_sync_confirmations (
      confirmation_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      request_id TEXT NOT NULL,
      ha_entity_id TEXT NOT NULL,
      ha_todo_uid TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'ha.todo_sync',
      sync_direction TEXT NOT NULL DEFAULT 'inbound',
      payload TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `)
  await client.execute("CREATE INDEX IF NOT EXISTS idx_todo_sync_entity_uid ON todo_sync_confirmations(ha_entity_id, ha_todo_uid)")
  await client.execute("CREATE INDEX IF NOT EXISTS idx_todo_sync_task ON todo_sync_confirmations(task_id)")
  ensuredTodoSyncClients.add(client)
}

async function ensureGrocySyncConfirmationTable(client: Client): Promise<void> {
  if (ensuredGrocySyncClients.has(client)) return
  await client.execute(`
    CREATE TABLE IF NOT EXISTS grocy_sync_confirmations (
      confirmation_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      grocy_entity_type TEXT NOT NULL,
      grocy_entity_id TEXT NOT NULL,
      sync_direction TEXT NOT NULL DEFAULT 'inbound',
      payload TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `)
  await client.execute("CREATE INDEX IF NOT EXISTS idx_grocy_sync_entity ON grocy_sync_confirmations(grocy_entity_type, grocy_entity_id)")
  await client.execute("CREATE INDEX IF NOT EXISTS idx_grocy_sync_task ON grocy_sync_confirmations(task_id)")
  ensuredGrocySyncClients.add(client)
}

export class TaskRepository {
  constructor(private readonly client: Client) {}

  // ── Dashboard (index.astro) ─────────────────────────────────────────

  /** Recent tasks for dashboard hero section */
  async getRecentTasks(limit = 10): Promise<TaskRow[]> {
    const result = await this.client.execute(
      `SELECT id, title, description, status, priority, due_date, labels, calendar_sync_state, is_favorite, area_id, color, ticket_number, task_type, task_kind, project_id, owner, handoff_state, created_at, updated_at, deferred_at
       FROM tasks ORDER BY created_at DESC LIMIT ${limit}`,
    );
    return result.rows as unknown as TaskRow[];
  }

  /** Tasks belonging to a specific project, ordered by priority */
  async findByProjectId(projectId: string): Promise<TaskRow[]> {
    const result = await this.client.execute({
      sql: `SELECT id, title, description, status, priority, due_date, labels, is_favorite, area_id, color, ticket_number, task_type, task_kind, project_id, owner, handoff_state, assigned_to, progress, created_at, updated_at, deferred_at
            FROM tasks WHERE project_id = ?
            ORDER BY priority ASC, created_at DESC`,
      args: [projectId],
    });
    return sanitizeRows(result.rows as unknown as TaskRow[]);
  }

  /** Aggregate total and completed task counts grouped by project_id (replaces N+1 findByProjectId loops). */
  async getProjectTaskCounts(): Promise<Map<string, { total: number; completed: number }>> {
    const result = await this.client.execute(
      `SELECT project_id,
              COUNT(*) AS total,
              COUNT(*) FILTER (WHERE status = 'complete') AS completed
       FROM tasks
       WHERE project_id IS NOT NULL
       GROUP BY project_id`,
    )
    const counts = new Map<string, { total: number; completed: number }>()
    for (const row of result.rows) {
      const r = row as Record<string, unknown>
      if (r.project_id != null) {
        counts.set(String(r.project_id), {
          total: Number(r.total ?? 0),
          completed: Number(r.completed ?? 0),
        })
      }
    }
    return counts
  }

  /** Favorited, non-complete tasks */
  async getFavoriteTasks(limit = 5): Promise<TaskRow[]> {
    const result = await this.client.execute({
      sql: `SELECT id, title, status, priority, due_date, is_favorite
            FROM tasks WHERE is_favorite = 1 AND status != ? AND deferred_at IS NULL
            ORDER BY updated_at DESC LIMIT ${limit}`,
      args: [STATUS.COMPLETE],
    });
    return result.rows as unknown as TaskRow[];
  }

  /** Open (non-complete) tasks ordered by priority then due date */
  async getOpenTasks(limit = 15): Promise<TaskRow[]> {
    const result = await this.client.execute({
      sql: `SELECT id, title, status, priority, due_date, assigned_to, area_id, ticket_number, task_type, task_kind, project_id, owner, handoff_state
            FROM tasks WHERE status NOT IN (?) AND deferred_at IS NULL
            ORDER BY priority ASC, due_date ASC NULLS LAST, updated_at DESC
            LIMIT ${limit}`,
      args: [STATUS.COMPLETE],
    });
    return result.rows as unknown as TaskRow[];
  }

  /** Count tasks grouped by status for dashboard stats */
  async getStatusCounts(): Promise<DashboardStats> {
    const result = await this.client.execute(
      "SELECT status, COUNT(*) AS cnt, COUNT(*) FILTER (WHERE deferred_at IS NULL) AS open_count FROM tasks GROUP BY status",
    );
    const stats: DashboardStats = { total: 0, open: 0, active: 0, completed: 0, overdue: 0 };
    for (const row of result.rows) {
      const r = row as Record<string, unknown>;
      const s = String(r.status);
      const c = Number(r.cnt);
      const open = Number(r.open_count)
      stats.total += c;
      if (s === STATUS.ACTIVE) stats.active += open
      if (s === STATUS.COMPLETE) stats.completed += c;
      else stats.open += open
    }
    return stats;
  }

  /** Count overdue tasks (past due, not complete) */
  /** Count open tasks past due. Pass today's YYYY-MM-DD in the user's timezone. */
  async getOverdueCount(today?: string, timezone = "Europe/Dublin"): Promise<number> {
    const resolvedToday = today ?? calendarToday(timezone);
    const upperBound = shiftCalendarDay(resolvedToday, 2);
    const result = await this.client.execute({
      sql: `SELECT due_date FROM tasks
            WHERE due_date IS NOT NULL AND due_date <> ''
              AND substr(due_date, 1, 10) < ?
              AND status != ?
              AND deferred_at IS NULL`,
      args: [upperBound, STATUS.COMPLETE],
    });
    let count = 0;
    for (const row of result.rows) {
      const day = calendarDayFromInput(String((row as Record<string, unknown>).due_date ?? ""), timezone);
      if (day && day < resolvedToday) count++;
    }
    return count;
  }

  /** All boards (for card badges on dashboard) */
  async getAreas(): Promise<Record<string, AreaInfo>> {
    const result = await this.client.execute("SELECT id, name, color FROM areas");
    const areaMap: Record<string, AreaInfo> = {
      default: { id: "default", name: "Default", color: "#6366F1" },
    };
    for (const b of result.rows) {
      const br = b as Record<string, unknown>;
      areaMap[String(br.id)] = {
        id: String(br.id),
        name: String(br.name ?? "Default"),
        color: String(br.color ?? "#6366F1"),
      };
    }
    return areaMap;
  }

  // ── Kanban (kanban.astro) ───────────────────────────────────────────

  async withKanbanRead<T>(read: (reader: Pick<Client, "execute">) => Promise<T>): Promise<T> {
    const snapshot = await this.client.transaction("read")
    try {
      return await read(snapshot)
    } finally {
      snapshot.close()
    }
  }

  /** Ordered, narrow scan for lane counts and matching before loading card details. */
  async getKanbanIndex(
    statuses: string[],
    cutoff: number,
    { matchText, matchOverdue, today }: { matchText: boolean; matchOverdue: boolean; today?: string },
    reader: Pick<Client, "execute">,
  ): Promise<KanbanIndexRow[]> {
    if (!statuses.length) return []
    const result = await reader.execute({
      sql: `SELECT id, status, priority, task_type, task_kind, area_id, assigned_to, is_promoted
                  ${matchText ? ", title, labels" : ""}
                  ${matchOverdue ? `, (${OVERDUE_TASK_PREDICATE}) AS overdue` : ""}
            FROM tasks
            WHERE status IN (SELECT value FROM json_each(?))
              AND deferred_at IS NULL
              AND (? = 0 OR lower(status) != 'complete' OR updated_at >= ?)
            ORDER BY is_promoted DESC, kanban_position ASC NULLS LAST, priority ASC, created_at DESC, id ASC`,
      args: [
        ...(matchOverdue ? [...overdueArgs(today), STATUS.COMPLETE] : []),
        JSON.stringify(statuses), cutoff, cutoff,
      ],
    })
    return result.rows as unknown as KanbanIndexRow[]
  }

  /** Load full cards and their indexed counts only for the rendered pages. */
  async getKanbanCards(ids: string[], cutoff: number, reader: Pick<Client, "execute">): Promise<TaskRow[]> {
    if (!ids.length) return []
    const result = await reader.execute({
      sql: `SELECT task.id, task.title, task.description, task.status, task.priority, task.due_date,
                   task.labels, task.framework_payload, task.calendar_sync_state, task.area_id,
                   task.custom_fields, task.progress, task.color, task.is_favorite, task.is_promoted, task.task_type,
                   task.task_kind, task.project_id, task.owner, task.handoff_state, task.ticket_number,
                   task.assigned_to, task.recurrence_rule, task.checklists,
                   task.urgency, task.importance, task.eisenhower_override,
                   task.effort_minutes, task.effort_type, task.blocked_by, task.nfc_tag_id, task.kanban_position,
                   task.deferred_at, task.deferral_revision, ${taskTimestampMs("task.updated_at")} AS task_version,
                   (SELECT COUNT(*) FROM comments WHERE task_id = task.id) AS comment_count,
                   (SELECT COUNT(*) FROM tasks AS child WHERE child.parent_id = task.id
                      AND (? = 0 OR lower(child.status) != 'complete' OR child.updated_at >= ?)) AS child_count
            FROM json_each(?) AS wanted JOIN tasks AS task ON task.id = wanted.value
            WHERE task.deferred_at IS NULL`,
      args: [cutoff, cutoff, JSON.stringify(ids)],
    })
    return result.rows as unknown as TaskRow[]
  }

  /** Kanban lane definitions ordered by position */
  async getKanbanLanes(): Promise<KanbanLane[]> {
    const result = await this.client.execute(
      "SELECT id, key, label, icon, position, wip_limit, includes, built_in FROM kanban_lanes ORDER BY position ASC",
    );
    return result.rows.map((r: Record<string, unknown>) => ({
      id: String(r.id),
      key: String(r.key),
      label: String(r.label),
      icon: String(r.icon),
      includes: JSON.parse(String(r.includes ?? "[]")),
      builtIn: Number(r.built_in ?? 0) === 1,
      wipLimit: Number(r.wip_limit ?? 0),
    }));
  }

  /** Get settings by keys (e.g. completed_auto_hide_days, backlog_mode) */
  async getSettings(keys: string[]): Promise<Record<string, string>> {
    const placeholders = keys.map(() => "?").join(", ");
    const result = await this.client.execute({
      sql: `SELECT key, value FROM settings WHERE key IN (${placeholders})`,
      args: keys,
    });
    const settings: Record<string, string> = {};
    for (const row of result.rows) {
      const r = row as Record<string, unknown>;
      settings[String(r.key)] = String(r.value);
    }
    return settings;
  }

  // ── Calendar (calendar.astro) ───────────────────────────────────────

  /** Task counts per day for a given month (non-complete) */
  async getCalendarTaskCounts(
    monthStart: string,
    monthEnd: string,
    timezone = "Europe/Dublin",
  ): Promise<Record<string, CalendarDayInfo>> {
    const lowerBound = shiftCalendarDay(monthStart, -1);
    const upperBound = shiftCalendarDay(monthEnd, 1);
    const result = await this.client.execute({
      sql: `SELECT due_date, color
            FROM tasks
            WHERE due_date IS NOT NULL AND due_date <> ''
              AND substr(due_date, 1, 10) >= ? AND substr(due_date, 1, 10) <= ?
              AND status NOT IN (?)`,
      args: [lowerBound, upperBound, STATUS.COMPLETE],
    });

    const tasksByDay: Record<string, CalendarDayInfo> = {};
    for (const row of result.rows) {
      const r = row as Record<string, unknown>;
      const day = calendarDayFromInput(String(r.due_date ?? ""), timezone);
      if (!day || day < monthStart || day > monthEnd) continue;
      const existing = tasksByDay[day] ?? {
        dueDate: day,
        count: 0,
        colors: [],
        haEvents: 0,
      };
      existing.count += 1;
      const color = typeof r.color === "string" ? r.color.trim() : "";
      if (color && existing.colors.length < 3) {
        existing.colors.push(color);
      }
      tasksByDay[day] = existing;
    }
    return tasksByDay;
  }

  /** HA & CalDAV synced event counts per day for calendar view (expands recurring series occurrences) */
  async getCalendarHAEventCounts(
    monthStart: string,
    monthEnd: string,
    timezone = "Europe/Dublin",
  ): Promise<Record<string, number>> {
    const taskDays = new Map<string, Set<string>>();

    const addSpan = (taskId: string, startRaw: unknown, endRaw?: unknown, effectiveEndRaw?: unknown) => {
      if (typeof startRaw !== "string" || !startRaw.trim()) return;
      const startDay = calendarDayFromInput(startRaw, timezone);
      if (!startDay) return;

      let endDay = startDay;
      if (typeof effectiveEndRaw === "string" && /^\d{4}-\d{2}-\d{2}$/.test(effectiveEndRaw.trim())) {
        endDay = effectiveEndRaw.trim();
      } else if (typeof endRaw === "string" && endRaw.trim()) {
        const sTrim = startRaw.trim();
        const eTrim = endRaw.trim();
        if (/^\d{4}-\d{2}-\d{2}$/.test(sTrim) && /^\d{4}-\d{2}-\d{2}$/.test(eTrim) && eTrim > sTrim) {
          endDay = shiftCalendarDay(eTrim, -1);
        } else {
          endDay = calendarDayFromInput(eTrim, timezone) ?? startDay;
        }
      }
      if (endDay < startDay) endDay = startDay;

      const from = startDay > monthStart ? startDay : monthStart;
      const to = endDay < monthEnd ? endDay : monthEnd;
      if (from > to) return;

      let set = taskDays.get(taskId);
      if (!set) {
        set = new Set<string>();
        taskDays.set(taskId, set);
      }
      let cur = from;
      for (let guard = 0; guard < 62 && cur <= to; guard++) {
        set.add(cur);
        const next = shiftCalendarDay(cur, 1);
        if (next === cur) break;
        cur = next;
      }
    };

    const confirmationsRes = await this.client.execute({
      sql: `SELECT cc.task_id, cc.payload, t.due_date, t.start_date, t.end_date
            FROM calendar_confirmations cc
            INNER JOIN tasks t ON t.id = cc.task_id
            WHERE cc.source IN ('ha.calendar_sync', 'caldav')
              AND t.calendar_sync_state = 'synced'`,
      args: [],
    });

    const confirmedTaskIds = new Set<string>();
    for (const row of confirmationsRes.rows) {
      const r = row as Record<string, unknown>;
      const taskId = String(r.task_id ?? "");
      if (!taskId) continue;
      confirmedTaskIds.add(taskId);

      let expandedFromPayload = false;
      if (typeof r.payload === "string" && r.payload.trim()) {
        try {
          const parsed = JSON.parse(r.payload) as {
            occurrences?: Array<{ start?: unknown; end?: unknown; effective_end?: unknown }>;
          };
          if (Array.isArray(parsed.occurrences) && parsed.occurrences.length > 0) {
            expandedFromPayload = true;
            for (const occ of parsed.occurrences) {
              addSpan(taskId, occ?.start, occ?.end, occ?.effective_end);
            }
          }
        } catch {
          // Malformed confirmation payload falls back to task dates below
        }
      }

      if (!expandedFromPayload) {
        const startVal = r.start_date ?? r.due_date;
        addSpan(taskId, startVal, undefined, typeof r.end_date === "string" ? calendarDayFromInput(r.end_date, timezone) : undefined);
      }
    }

    const syncedTasksRes = await this.client.execute({
      sql: `SELECT id, due_date, start_date, end_date
            FROM tasks
            WHERE calendar_sync_state = 'synced'`,
      args: [],
    });
    for (const row of syncedTasksRes.rows) {
      const r = row as Record<string, unknown>;
      const taskId = String(r.id ?? "");
      if (!taskId || confirmedTaskIds.has(taskId)) continue;
      const startVal = r.start_date ?? r.due_date;
      const endDay = typeof r.end_date === "string" ? calendarDayFromInput(r.end_date, timezone) : undefined;
      addSpan(taskId, startVal, undefined, endDay ?? undefined);
    }

    const counts: Record<string, number> = {};
    for (const days of taskDays.values()) {
      for (const day of days) {
        counts[day] = (counts[day] ?? 0) + 1;
      }
    }
    return counts;
  }

  // ── Timeline (timeline.astro) ─────────────────────────────────────────

  /** All tasks with date fields for Timeline/GANTT chart rendering */
  async getTimelineTasks(): Promise<TaskRow[]> {
    const result = await this.client.execute(
      `SELECT id, title, status, priority, due_date, start_date, end_date, color, task_type, task_kind, project_id, assigned_to, progress, ticket_number, parent_id, blocked_by, effort_minutes, labels, area_id, deferred_at
       FROM tasks ORDER BY start_date ASC NULLS LAST, created_at DESC`,
    );
    return result.rows as unknown as TaskRow[];
  }

  // ── Today (today.astro) ─────────────────────────────────────────────

  /** Overdue tasks (past due date, non-complete) */
  async getOverdueTasks(todayStr: string, timezone = "Europe/Dublin"): Promise<TaskRow[]> {
    const upperBound = shiftCalendarDay(todayStr, 2);
    const result = await this.client.execute({
      sql: `SELECT * FROM tasks
            WHERE due_date IS NOT NULL AND due_date <> '' AND substr(due_date, 1, 10) < ?
              AND status NOT IN (?)
              AND deferred_at IS NULL
            ORDER BY due_date ASC`,
      args: [upperBound, STATUS.COMPLETE],
    });
    const rows = sanitizeRows(result.rows as unknown as TaskRow[]);
    return rows.filter((row) => {
      const day = calendarDayFromInput(row.due_date, timezone);
      return day !== null && day < todayStr;
    });
  }

  /** Tasks due on a specific date (non-complete) */
  async getTasksDueOn(dateStr: string, timezone = "Europe/Dublin"): Promise<TaskRow[]> {
    const lowerBound = shiftCalendarDay(dateStr, -1);
    const upperBound = shiftCalendarDay(dateStr, 1);
    const result = await this.client.execute({
      sql: `SELECT * FROM tasks
            WHERE due_date IS NOT NULL AND due_date <> ''
              AND substr(due_date, 1, 10) >= ? AND substr(due_date, 1, 10) <= ?
              AND status NOT IN (?) AND deferred_at IS NULL
            ORDER BY priority DESC, created_at ASC`,
      args: [lowerBound, upperBound, STATUS.COMPLETE],
    });
    const rows = sanitizeRows(result.rows as unknown as TaskRow[]);
    return rows.filter((row) => calendarDayFromInput(row.due_date, timezone) === dateStr);
  }

  /** Unscheduled tasks (no due date, non-complete) */
  async getUnscheduledTasks(limit = 10): Promise<TaskRow[]> {
    const result = await this.client.execute({
      sql: `SELECT * FROM tasks
            WHERE due_date IS NULL AND status NOT IN (?) AND deferred_at IS NULL
            ORDER BY priority DESC, created_at DESC
            LIMIT ${limit}`,
      args: [STATUS.COMPLETE],
    });
    return sanitizeRows(result.rows as unknown as TaskRow[]);
  }

  /**
   * Suggested tasks — high-priority (p1-p2) tasks due within 3 days,
   * or unscheduled high-priority tasks. Excludes tasks already due today
   * and already shown in overdue section.
   * Used by Smart Today (SMT-01).
   */
  async getSuggestedTasks(todayStr: string, limit = 10, timezone = "Europe/Dublin"): Promise<TaskRow[]> {
    // Calculate end date (3 days from today)
    const endStr = shiftCalendarDay(todayStr, 3);
    const upperBound = shiftCalendarDay(endStr, 1);

    const result = await this.client.execute({
      sql: `SELECT * FROM tasks
            WHERE status NOT IN (?)
              AND deferred_at IS NULL
              AND (
                (due_date IS NOT NULL AND due_date <> '' AND substr(due_date, 1, 10) >= ? AND substr(due_date, 1, 10) <= ? AND priority <= 2)
                OR (due_date IS NULL AND priority <= 2)
              )
            ORDER BY priority ASC, due_date ASC NULLS LAST
            LIMIT ${limit * 3}`,
      args: [STATUS.COMPLETE, todayStr, upperBound],
    });
    const rows = sanitizeRows(result.rows as unknown as TaskRow[]);
    return rows
      .filter((row) => {
        if (!row.due_date) return true;
        const day = calendarDayFromInput(row.due_date, timezone);
        return day !== null && day > todayStr && day <= endStr;
      })
      .slice(0, limit);
  }

  /** Count tasks completed today (status=complete AND updated_at today) — SMT-03 */
  async getCompletedTodayCount(todayStr: string): Promise<number> {
    // today timestamps: midnight to midnight (epoch ms)
    const startMs = new Date(todayStr).getTime()
    const endMs = startMs + 86400000
    const result = await this.client.execute({
      sql: `SELECT COUNT(*) as cnt FROM tasks
            WHERE status = ? AND updated_at >= ? AND updated_at < ?`,
      args: [STATUS.COMPLETE, startMs, endMs],
    });
    return Number((result.rows[0] as Record<string, unknown>)?.cnt ?? 0);
  }

  // ── Upcoming (upcoming.astro) ───────────────────────────────────────

  /** Tasks within a date range (non-complete) for upcoming view */
  async getTasksInRange(startDate: string, endDate: string, timezone = "Europe/Dublin"): Promise<TaskRow[]> {
    const lowerBound = shiftCalendarDay(startDate, -1);
    const upperBound = shiftCalendarDay(endDate, 1);
    const result = await this.client.execute({
      sql: `SELECT * FROM tasks
            WHERE due_date IS NOT NULL AND due_date <> ''
              AND substr(due_date, 1, 10) >= ? AND substr(due_date, 1, 10) <= ?
              AND status NOT IN (?)
              AND deferred_at IS NULL
            ORDER BY due_date ASC, priority DESC, created_at ASC`,
      args: [lowerBound, upperBound, STATUS.COMPLETE],
    });
    const rows = sanitizeRows(result.rows as unknown as TaskRow[]);
    return rows.filter((row) => {
      const day = calendarDayFromInput(row.due_date, timezone);
      return day !== null && day >= startDate && day <= endDate;
    });
  }

  // ── Write Methods (API routes) ────────────────────────────────────────

  /**
   * Resolve a task identifier to its UUID.
   * Accepts UUID or MTH-N ticket key format.
   */
  async resolveTaskId(idOrKey: string): Promise<{ id: string; updated_at: unknown } | null> {
    let parsedTicketNum: number | null = null;
    if (/^MTH-\d+$/i.test(idOrKey)) {
      const n = Number(idOrKey.slice(4));
      parsedTicketNum = Number.isSafeInteger(n) && n > 0 ? n : null;
    }
    const result = await this.client.execute({
      sql: `SELECT id, ${taskTimestampMs("updated_at")} AS updated_at FROM tasks
            WHERE id = ? OR ticket_number = ? LIMIT 1`,
      args: [idOrKey, parsedTicketNum],
    });
    if (result.rows.length === 0) return null;
    const row = result.rows[0] as Record<string, unknown>;
    return { id: String(row.id), updated_at: row.updated_at };
  }

  /** Retrieve a single task by ID/ticket key, with parent info JOINed */
  async findById(idOrKey: string): Promise<TaskRow | null> {
    let parsedTicketNum: number | null = null;
    if (/^MTH-\d+$/i.test(idOrKey)) {
      const n = Number(idOrKey.slice(4));
      parsedTicketNum = Number.isSafeInteger(n) && n > 0 ? n : null;
    }
    const result = await this.client.execute({
      sql: `SELECT t.id, t.title, t.description, t.status, t.priority, t.due_date, t.labels,
                   t.framework_payload, t.calendar_sync_state, t.area_id, t.custom_fields,
                   t.parent_id, t.time_tracked, t.start_date, t.end_date, t.progress, t.color,
                   t.is_favorite, t.is_promoted, t.task_type, t.task_kind, t.project_id, t.owner, t.handoff_state,
                   t.ticket_number, t.assigned_to, t.checklists,
                   t.urgency, t.importance, t.eisenhower_override,
                   t.effort_minutes, t.effort_type, t.blocked_by, t.nfc_tag_id, t.kanban_position,
                   t.recurrence_rule, t.created_at, t.updated_at, t.deferred_at, t.deferral_revision,
                   ${taskTimestampMs("t.updated_at")} AS task_version,
                   p.title as parent_title, p.task_type as parent_task_type, p.ticket_number as parent_ticket_number
            FROM tasks t
            LEFT JOIN tasks p ON t.parent_id = p.id
            WHERE t.id = ? OR t.ticket_number = ? LIMIT 1`,
      args: [idOrKey, parsedTicketNum],
    });
    return (result.rows[0] as unknown as TaskRow) ?? null;
  }

  /**
   * Export all tasks with explicit column list.
   * Used by export/tasks.json.ts and export/tasks.csv.ts.
   * Column list is explicit to avoid leaking internal schema changes.
   */
  async exportAll(): Promise<TaskRow[]> {
    const result = await this.client.execute(
      `SELECT id, title, description, status, priority, due_date, labels,
              framework_payload, calendar_sync_state, area_id, custom_fields,
              parent_id, time_tracked, start_date, end_date, progress, color,
              is_favorite, task_type, task_kind, project_id, owner, handoff_state,
              ticket_number, recurrence_rule,
              checklists, reminder_at, created_at, updated_at
       FROM tasks ORDER BY updated_at DESC`
    );
    return result.rows as unknown as TaskRow[];
  }

  async findBacklogPage(requestedPage: number): Promise<{
    page: number;
    total: number;
    tasks: Array<Pick<TaskRow, "id" | "title" | "description" | "ticket_number" | "due_date"> & { updated_at: number }>;
  }> {
    const pageSize = 25
    const page = Number.isSafeInteger(requestedPage) ? requestedPage : 1
    const result = await this.client.execute({
      sql: `WITH totals AS (
              SELECT COUNT(*) AS total FROM tasks WHERE status = ? AND deferred_at IS NULL
            ), bounds AS (
              SELECT total, MAX(1, MIN(?, CAST((total + ? - 1) / ? AS INTEGER))) AS page FROM totals
            ), items AS (
              SELECT id, title, description, ticket_number, due_date,
                     ${taskTimestampMs("created_at")} AS created_ms,
                     ${taskTimestampMs("updated_at")} AS updated_at
              FROM tasks WHERE status = ? AND deferred_at IS NULL
              ORDER BY created_ms ASC, id ASC
              LIMIT ? OFFSET (SELECT (page - 1) * ? FROM bounds)
            )
            SELECT bounds.total, bounds.page, items.*
            FROM bounds LEFT JOIN items ON TRUE
            ORDER BY items.created_ms ASC, items.id ASC`,
      args: [STATUS.BACKLOG, page, pageSize, pageSize, STATUS.BACKLOG, pageSize, pageSize],
    })
    return {
      page: Number(result.rows[0]?.page ?? 1),
      total: Number(result.rows[0]?.total ?? 0),
      tasks: result.rows.flatMap(row => row.id == null ? [] : [{
        id: String(row.id),
        title: String(row.title),
        description: row.description == null ? null : String(row.description),
        ticket_number: row.ticket_number == null ? null : Number(row.ticket_number),
        due_date: row.due_date == null ? null : String(row.due_date),
        updated_at: Number(row.updated_at),
      }]),
    }
  }

  /** List tasks with optional filters, pagination, and sorting. */
  async findDeferredPage(requestedPage: number): Promise<{
    page: number
    total: number
    tasks: Array<DeferralState & Pick<TaskRow, "title" | "project_id" | "ticket_number"> & { automatic: boolean }>
  }> {
    const page = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1
    const { rows } = await this.client.execute({
      sql: `WITH totals AS (
              SELECT COUNT(*) AS total FROM tasks WHERE deferred_at IS NOT NULL
            ), bounds AS (
              SELECT total, MAX(1, MIN(?, (total + 24) / 25)) AS page FROM totals
            ), items AS (
              SELECT id, title, project_id, status, ticket_number, deferred_at, deferral_revision,
                     ${taskTimestampMs("updated_at")} AS updated_at,
                     COALESCE((SELECT actor = '${inactivityRuleActor}' AND actor_type = 'system'
                      FROM task_activity_log WHERE task_id = tasks.id AND field = 'deferred_at'
                        AND new_value = CAST(tasks.deferred_at AS TEXT) ORDER BY id DESC LIMIT 1), 0) AS automatic
              FROM tasks WHERE deferred_at IS NOT NULL
              ORDER BY deferred_at DESC, id ASC
              LIMIT 25 OFFSET (SELECT (page - 1) * 25 FROM bounds)
            )
            SELECT bounds.total, bounds.page, items.*
            FROM bounds LEFT JOIN items ON TRUE
            ORDER BY items.deferred_at DESC, items.id ASC`,
      args: [page],
    })
    return {
      page: Number(rows[0]?.page ?? 1),
      total: Number(rows[0]?.total ?? 0),
      tasks: rows.filter(row => row.id !== null).map(row => ({
        ...row, automatic: Number(row.automatic) === 1,
      })) as unknown as Array<DeferralState & Pick<TaskRow, "title" | "project_id" | "ticket_number"> & { automatic: boolean }>,
    }
  }

  /** List tasks with optional filters, pagination, and sorting. */
  async findAll(opts: {
    status?: string;
    dueDate?: string;
    priority?: number;
    areaId?: string;
    projectId?: string;
    taskType?: string;
    parentId?: string;
    search?: string;
    assignedTo?: string;
    label?: string;
    favorite?: boolean;
    deferred?: boolean
    sort?: string;
    order?: "ASC" | "DESC";
    limit?: number;
    offset?: number;
  }): Promise<{ tasks: TaskRow[]; total: number }> {
    const validSorts = ["created_at", "updated_at", "title", "status", "priority", "due_date", "kanban_position"];
    const sortCol = validSorts.includes(opts.sort ?? "") ? opts.sort! : "created_at";
    const order = opts.order ?? "DESC";
    const limit = Math.min(500, Math.max(1, opts.limit ?? 100));
    const offset = Math.max(0, opts.offset ?? 0);

    const conditions: string[] = [];
    const args: InValue[] = [];

    if (opts.status) {
      const definition = getStatusDef(opts.status)
      const statuses = definition ? [definition.canonical, ...definition.aliases] : [opts.status]
      conditions.push(`status IN (${statuses.map(() => "?").join(", ")})`)
      args.push(...statuses)
    }
    if (opts.dueDate) {
      // Match the stored calendar day without shifting offset timestamps to UTC.
      conditions.push("due_date GLOB ? AND date(due_date) IS NOT NULL")
      args.push(`${opts.dueDate}*`)
    }
    if (opts.priority != null) { conditions.push("priority = ?"); args.push(opts.priority); }
    if (opts.areaId) { conditions.push("area_id = ?"); args.push(opts.areaId); }
    if (opts.projectId) { conditions.push("project_id = ?"); args.push(opts.projectId); }
    if (opts.taskType) { conditions.push("task_type = ?"); args.push(opts.taskType); }
    if (opts.parentId) { conditions.push("parent_id = ?"); args.push(opts.parentId); }
    if (opts.search) { conditions.push("(title LIKE ? OR description LIKE ?)"); args.push(`%${opts.search}%`, `%${opts.search}%`); }
    if (opts.assignedTo) { conditions.push("assigned_to = ?"); args.push(opts.assignedTo); }
    if (opts.label) { conditions.push("EXISTS (SELECT 1 FROM json_each(tasks.labels) WHERE json_each.value = ?)"); args.push(opts.label); }
    if (opts.favorite) { conditions.push("is_favorite = 1"); }
    if (opts.deferred !== undefined) conditions.push(opts.deferred ? "deferred_at IS NOT NULL" : "deferred_at IS NULL")

    const where = conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";

    const selectSql = `SELECT id, title, description, status, priority, due_date, labels,
                              framework_payload, calendar_sync_state, parent_id, time_tracked,
                              area_id, custom_fields, start_date, end_date, progress, color,
                              is_favorite, task_type, task_kind, project_id, owner, handoff_state,
                              ticket_number, assigned_to, created_at, updated_at, deferred_at, deferral_revision,
                              urgency, importance, eisenhower_override,
                              effort_minutes, effort_type, blocked_by, nfc_tag_id, kanban_position,
                              ${taskTimestampMs("updated_at")} AS task_version
                       FROM tasks${where}
                       ORDER BY ${sortCol} ${order} NULLS LAST, id ASC LIMIT ${limit} OFFSET ${offset}`;
    const countSql = `SELECT COUNT(*) as cnt FROM tasks${where}`;

    const [result, countResult] = await this.client.batch([
      { sql: selectSql, args },
      { sql: countSql, args },
    ], "read")

    const total = Number(countResult?.rows[0]?.cnt ?? 0)
    return { tasks: (result?.rows ?? []) as unknown as TaskRow[], total }
  }

  /** Advanced catalog search used by the universal search hub and HA search bridges. */
  async searchCatalog(opts: {
    query?: string
    status?: string
    priority?: number
    assignedTo?: string
    includeCompleted?: boolean
    includeArchived?: boolean
    fields?: readonly string[]
    sort?: "relevance" | "updated"
    limit?: number
  }): Promise<TaskCatalogRow[]> {
    const query = (opts.query ?? "").trim().toLowerCase()
    const fields = new Set((opts.fields ?? ["id", "title", "description", "labels", "custom_fields", "comments"])
      .map(field => field.toLowerCase()))
    const limit = Math.min(50, Math.max(1, opts.limit ?? 12))
    const conditions: string[] = []
    const args: InValue[] = []

    const excludedStatuses: string[] = []
    if (opts.includeCompleted !== true) excludedStatuses.push(STATUS.COMPLETE)
    if (opts.includeArchived !== true) excludedStatuses.push("archived")
    if (excludedStatuses.length > 0) {
      conditions.push(`tasks.status NOT IN (${excludedStatuses.map(() => "?").join(", ")})`)
      args.push(...excludedStatuses)
    }
    if (opts.status) {
      conditions.push("tasks.status = ?")
      args.push(normalizeStatus(opts.status))
    }
    if (opts.priority != null) {
      conditions.push("tasks.priority = ?")
      args.push(opts.priority)
    }
    if (opts.assignedTo) {
      conditions.push("tasks.assigned_to = ?")
      args.push(opts.assignedTo)
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""
    const projection = "tasks.id, tasks.ticket_number, tasks.title, tasks.status, tasks.priority, tasks.deferred_at"
    const updatedAt = taskTimestampMs("tasks.updated_at")
    if (!query) {
      const result = await this.client.execute({
        sql: `SELECT ${projection}, 0 AS score
              FROM tasks ${where}
              ORDER BY ${updatedAt} DESC, tasks.priority ASC, tasks.id ASC
              LIMIT ?`,
        args: [...args, limit],
      })
      return result.rows as unknown as TaskCatalogRow[]
    }

    const parsedTicket = parseTicketKey(query) ?? (/^[0-9]+$/.test(query) ? Number(query) : 0)
    const ticket = Number.isSafeInteger(parsedTicket) && parsedTicket > 0 ? parsedTicket : null
    const selected = (field: string, sql: string) => fields.has(field) ? sql : "0"
    // INSTR treats percent, underscore and backslash literally. The needle and
    // the stored field keep their existing JavaScript/SQLite case behavior.
    const position = (column: string) => `instr(lower(coalesce(${column}, '')), needle.value)`
    const commentMatch = `c.task_id = tasks.id AND ${position("c.content")} > 0`
    const snippet = (column: string) => {
      const start = `max(${position(column)} - 32, 1)`
      return `(CASE WHEN ${start} > 1 THEN '...' ELSE '' END) ||
              substr(${column}, ${start}, 174) ||
              (CASE WHEN length(${column}) >= ${start} + 174 THEN '...' ELSE '' END)`
    }
    const snippets = [
      fields.has("description") ? `WHEN page.description_hit THEN ${snippet("tasks.description")}` : "",
      fields.has("comments") ? `WHEN page.comments_hit THEN (
        SELECT ${snippet("c.content")} FROM comments c
        WHERE ${commentMatch} ORDER BY c.created_at DESC, c.id DESC LIMIT 1
      )` : "",
      fields.has("custom_fields") ? `WHEN page.custom_fields_hit THEN ${snippet("tasks.custom_fields")}` : "",
      fields.has("labels") ? `WHEN page.labels_hit THEN ${snippet("tasks.labels")}` : "",
    ].filter(Boolean)
    const excerpt = snippets.length ? `CASE ${snippets.join("\n")} END` : "NULL"
    const orderBy = opts.sort === "updated" ? "" : "score DESC, "

    const result = await this.client.execute({
      sql: `WITH needle(value, ticket) AS (VALUES (?, ?)),
            hits AS MATERIALIZED (
              SELECT tasks.id, tasks.priority, ${updatedAt} AS updated_at_ms,
                ${selected("id", `lower(tasks.id) = needle.value OR coalesce(tasks.ticket_number = needle.ticket, 0)`)} AS exact_id,
                ${selected("id", `${position("tasks.id")} > 0 OR
                  ${position("'mth-' || cast(tasks.ticket_number AS TEXT)")} > 0 OR
                  ${position("cast(tasks.ticket_number AS TEXT)")} > 0`)} AS id_hit,
                ${selected("title", "lower(tasks.title) = needle.value")} AS exact_title,
                ${selected("title", position("tasks.title"))} AS title_at,
                ${selected("description", `${position("tasks.description")} > 0`)} AS description_hit,
                ${selected("labels", `${position("tasks.labels")} > 0`)} AS labels_hit,
                ${selected("custom_fields", `${position("tasks.custom_fields")} > 0`)} AS custom_fields_hit,
                ${selected("comments", `EXISTS (SELECT 1 FROM comments c WHERE ${commentMatch})`)} AS comments_hit,
                (tasks.status NOT IN ('complete', 'archived')) * 6 AS open_boost
              FROM tasks CROSS JOIN needle ${where}
            ),
            page AS (
              SELECT hits.*,
                CASE WHEN exact_id THEN ${EXACT_TASK_IDENTIFIER_SCORE}
                     WHEN exact_title THEN 3000
                     WHEN title_at = 1 THEN 2000
                     ELSE 1000 END
                + (title_at > 0) * 60 + description_hit * 25 + labels_hit * 18
                + custom_fields_hit * 15 + comments_hit * 12 + open_boost AS score
              FROM hits
              WHERE exact_id OR id_hit OR title_at > 0 OR description_hit OR labels_hit OR custom_fields_hit OR comments_hit
              ORDER BY ${orderBy}updated_at_ms DESC, priority ASC, id ASC
              LIMIT ?
            )
            SELECT ${projection}, page.score, page.id_hit, page.exact_id, page.title_at,
              page.description_hit, page.labels_hit, page.custom_fields_hit, page.comments_hit, ${excerpt} AS excerpt
            FROM page JOIN tasks ON tasks.id = page.id CROSS JOIN needle
            ORDER BY ${orderBy}page.updated_at_ms DESC, page.priority ASC, page.id ASC`,
      args: [query, ticket, ...args, limit],
    })

    return result.rows as unknown as TaskCatalogRow[]
  }

  /** Look up the default assignee from app_settings (nullable) */
  async getDefaultAssignee(): Promise<string | null> {
    try {
      const result = await this.client.execute(
        "SELECT value FROM app_settings WHERE key = 'default_assignee' LIMIT 1"
      );
      if (result.rows.length > 0) {
        return String((result.rows[0] as Record<string, unknown>).value);
      }
    } catch { /* ignore — default is optional */ }
    return null;
  }

  /** Look up a parent task's type for nesting validation */
  async getParentTaskType(parentId: string): Promise<string | null> {
    const result = await this.client.execute({
      sql: "SELECT task_type FROM tasks WHERE id = ? LIMIT 1",
      args: [parentId],
    });
    if (result.rows.length === 0) return null;
    return String((result.rows[0] as Record<string, unknown>).task_type ?? "task");
  }

  /**
   * Insert a new task. Caller is responsible for validation and ID generation.
   * @returns The ticket number allocated by the insert.
   */
  async createTask(data: TaskCreationData, createdAt = Date.now()): Promise<number> {
    const result = await this.client.execute(taskInsertStatement(data, createdAt))
    return Number(result.rows[0]!.ticket_number)
  }

  /** Resolve a physical tag without silently choosing duplicate assignments. */
  async findByNfcTag(tagId: string): Promise<Array<{ id: string; title: string; status: string }>> {
    const result = await this.client.execute({
      sql: "SELECT id, title, status FROM tasks WHERE nfc_tag_id = ? AND status != 'archived' ORDER BY id LIMIT 2",
      args: [tagId],
    })
    return result.rows as unknown as Array<{ id: string; title: string; status: string }>
  }

  /** Apply a partial update with atomic dependency, version and checklist guards. */
  async updateTask(
    id: string,
    fields: Record<string, InValue>,
    { version, expectedChecklists, expectedAssignedTo, activity, signal }: {
      version?: { updatedAt: number; expectedStatus?: "backlog" }
      expectedChecklists?: string | null
      expectedAssignedTo?: string
      activity?: RecentTaskActor
      signal?: AbortSignal | undefined
    } = {},
  ): Promise<
    { ok: true; task: TaskRow; previousStatus?: string; successor?: RecurrenceSuccessor }
    | { ok: false; errorCode: "unavailable" }
    | { ok: false; errorCode: "assignee_mismatch" }
    | { ok: false; errorCode: "checklist_conflict"; checklists: string | null }
    | { ok: false; errorCode: "conflict"; updatedAt: number }
    | { ok: false; errorCode: "blocked"; blockers: TaskBlocker[] }
  > {
    const updates: string[] = []
    const args: InValue[] = []

    for (const [col, val] of Object.entries(fields)) {
      updates.push(`${col} = ?`)
      args.push(val)
    }
    if (updates.length === 0) return { ok: false, errorCode: "unavailable" }

    const storedVersion = taskTimestampMs("updated_at")
    updates.push(`updated_at = ${nextTaskTimestampMs("updated_at")}`)
    const now = Date.now()
    args.push(now)
    const whereArgs: InValue[] = [id]

    // Legacy task databases do not have a project foreign key. Check the
    // destination in the write so project deletion cannot race reassignment.
    const projectId = fields.project_id
    const destinationExists = typeof projectId === "string"
      ? " AND EXISTS (SELECT 1 FROM projects WHERE id = ?)"
      : ""
    if (typeof projectId === "string") whereArgs.push(projectId)
    const checklistMatches = expectedChecklists === undefined ? "" : " AND checklists IS ?"
    if (expectedChecklists !== undefined) whereArgs.push(expectedChecklists)
    const assigneeMatches = expectedAssignedTo === undefined ? "" : " AND assigned_to = ?"
    if (expectedAssignedTo !== undefined) whereArgs.push(expectedAssignedTo)

    const predicates: string[] = []
    if (version) {
      predicates.push(`${storedVersion} < 9007199254740991`, `${storedVersion} ${version.expectedStatus ? "=" : "<="} ?`)
      whereArgs.push(version.updatedAt)
      if (version.expectedStatus) {
        predicates.push("tasks.status = ?", "tasks.deferred_at IS NULL")
        whereArgs.push(version.expectedStatus)
      }
    }

    const dependencies = fields.status === STATUS.ACTIVE ? openTaskDependencies(id) : null
    if (dependencies) whereArgs.push(...dependencies.args)
    const where = `WHERE id = ?${destinationExists}${checklistMatches}${assigneeMatches}
      ${predicates.length ? `AND ${predicates.join(" AND ")}` : ""}
      ${dependencies ? `AND NOT EXISTS (${dependencies.sql})` : ""}`
    const update = {
      sql: `UPDATE tasks SET ${updates.join(", ")} ${where}
            RETURNING id, title, description, status, priority, due_date, labels,
                      framework_payload, calendar_sync_state, area_id, custom_fields,
                      parent_id, time_tracked, start_date, end_date, progress, color,
                      is_favorite, is_promoted, task_type, task_kind, project_id, owner, handoff_state,
                      ticket_number, assigned_to, checklists, urgency, importance, nfc_tag_id,
                      eisenhower_override, created_at, updated_at`,
      args: [...args, ...whereArgs],
    }

    const diagnostics = []
    const versionIndex = version ? diagnostics.length : -1
    if (version) {
      diagnostics.push({ sql: `SELECT status, deferred_at, ${storedVersion} AS updated_at FROM tasks WHERE id = ?`, args: [id] })
    }
    const checklistIndex = expectedChecklists !== undefined ? diagnostics.length : -1
    if (expectedChecklists !== undefined) {
      diagnostics.push({
        sql: "SELECT checklists FROM tasks WHERE id = ? AND checklists IS NOT ?",
        args: [id, expectedChecklists],
      })
    }
    const assigneeIndex = expectedAssignedTo !== undefined ? diagnostics.length : -1
    if (expectedAssignedTo !== undefined) {
      diagnostics.push({
        sql: "SELECT id FROM tasks WHERE id = ? AND (assigned_to IS NULL OR assigned_to != ?)",
        args: [id, expectedAssignedTo],
      })
    }
    const depsIndex = dependencies ? diagnostics.length : -1
    if (dependencies) {
      diagnostics.push({ ...dependencies, sql: `${dependencies.sql} ORDER BY t.id LIMIT 5` })
    }

    // A status transition and its prior state share the same writer transaction.
    // Callers must use this snapshot for once-only completion side effects.
    const statusIndex = diagnostics.length
    if (typeof fields.status === "string") {
      diagnostics.push({ sql: "SELECT status, date('now') AS completion_day FROM tasks WHERE id = ?", args: [id] })
    }

    // Capture the old state and commit the event and update in the same writer batch.
    const eventId = activity ? crypto.randomUUID() : null
    const statements: InStatement[] = [...diagnostics]
    if (activity && eventId) statements.push(taskChangedActivity(fields, where, whereArgs, activity, now, eventId))
    const writeIndex = statements.length
    statements.push(update)
    if (eventId) statements.push(discardUnappliedTaskActivity(eventId))
    let results: ResultSet[]
    let recurrence: RecurrenceOutcome
    if (typeof fields.status === "string" && isDoneStatus(fields.status)) {
      const repo = this
      const completion = await runWriteTransaction(this.client, function* (): Generator<
        InStatement[], { results: ResultSet[]; recurrence: RecurrenceOutcome }, ResultSet[]
      > {
        const writeResults = yield statements
        const prior = writeResults[statusIndex]?.rows[0]
        const previousStatus = String(prior?.status ?? "")
        const next = writeResults[writeIndex]?.rows[0] && !isDoneStatus(previousStatus)
          ? yield* repo.createRecurrenceSuccessor(id, String(prior?.completion_day ?? ""))
          : undefined
        return { results: writeResults, recurrence: next }
      }, { signal })
      results = completion.results
      recurrence = completion.recurrence
    } else {
      results = statements.length > 1
        ? await executeWriteWithRetry(this.client, statements, { signal })
        : [await executeWriteWithRetry(this.client, update, { signal })]
    }
    if (recurrence === "invalid") logApiWarn("recurrence-auto-create", "Invalid saved recurrence rule or date")
    const successor = recurrence === "invalid" ? undefined : recurrence
    const row = results[writeIndex]?.rows[0]
    if (row) return { ok: true, task: row as unknown as TaskRow,
      ...(typeof fields.status === "string" ? { previousStatus: String(results[statusIndex]?.rows[0]?.status ?? "") } : {}),
      ...(successor ? { successor } : {}),
    }

    if (assigneeIndex >= 0 && results[assigneeIndex]?.rows.length) {
      return { ok: false, errorCode: "assignee_mismatch" }
    }
    if (versionIndex >= 0) {
      const current = results[versionIndex]?.rows[0]
      if (!current) return { ok: false, errorCode: "unavailable" }
      const updatedAt = Number(current.updated_at)
      const changed = version!.expectedStatus
        ? updatedAt !== version!.updatedAt || current.status !== version!.expectedStatus || current.deferred_at !== null
        : updatedAt > version!.updatedAt
      if (changed || updatedAt === Number.MAX_SAFE_INTEGER) {
        return { ok: false, errorCode: "conflict", updatedAt }
      }
    }
    const changedChecklist = checklistIndex >= 0 ? results[checklistIndex]?.rows[0]?.checklists : undefined
    if (typeof changedChecklist === "string" || changedChecklist === null) {
      return { ok: false, errorCode: "checklist_conflict", checklists: changedChecklist }
    }
    const blockers = depsIndex >= 0 ? results[depsIndex]?.rows : undefined
    if (blockers?.length) {
      return {
        ok: false,
        errorCode: "blocked",
        blockers: blockers as unknown as TaskBlocker[],
      }
    }
    return { ok: false, errorCode: "unavailable" }
  }

  /** Move open work in or out of deferral without changing its workflow clock. */
  async setDeferral(
    id: string,
    deferred: boolean,
    guard: { updatedAt: number; revision: string | null; inactivityNow?: number },
    actor: { id: string; type: "agent" | "human" | "system"; requestId?: string | null },
    expectedAssignedTo?: string,
  ): Promise<DeferralResult> {
    const now = guard.inactivityNow ?? Date.now()
    const marker = deferred ? now : null
    const correlationId = actor.requestId ?? null
    const version = taskTimestampMs("updated_at")
    const columns = `id, status, deferred_at, deferral_revision, ${version} AS updated_at`
    if (deferred && guard.inactivityNow !== undefined) {
      const eligibility = inactivityWriteGuard(now)
      const transaction = await this.client.transaction("write")
      try {
        const [changed, audit, verified] = await transaction.batch([
          {
            sql: `UPDATE tasks SET deferred_at = ?, deferral_revision = lower(hex(randomblob(16)))
              WHERE id = ? AND ${version} = ? AND deferral_revision IS ? AND (${eligibility.sql})
              RETURNING ${columns}`,
            args: [now, id, guard.updatedAt, guard.revision, ...eligibility.args],
          },
          {
            sql: `INSERT INTO task_activity_log
                (task_id, field, old_value, new_value, actor, actor_type, event_type, summary, correlation_id, created_at)
              SELECT id, 'deferred_at', NULL, CAST(deferred_at AS TEXT), ?, 'system', 'field_change', ?, ?, ?
              FROM tasks WHERE changes() = 1 AND id = ? AND deferred_at = ?`,
            args: [inactivityRuleActor, "Automatically deferred after inactivity", correlationId, now, id, now],
          },
          {
            sql: `SELECT 1 FROM task_activity_log WHERE id = last_insert_rowid() AND task_id = ?
              AND field = 'deferred_at' AND old_value IS NULL AND new_value = ?
              AND actor = ? AND actor_type = 'system' AND event_type = 'field_change'
              AND correlation_id IS ? AND created_at = ?`,
            args: [id, String(now), inactivityRuleActor, correlationId, now],
          },
        ])
        const task = changed?.rows[0] as unknown as DeferralState | undefined
        if (!task && audit?.rowsAffected === 0) return { ok: false, errorCode: "ineligible" }
        if (!task || audit?.rowsAffected !== 1 || verified?.rows.length !== 1) {
          throw new Error("Automatic deferral requires one matching audit row")
        }
        await transaction.commit()
        return { ok: true, task }
      } finally {
        if (!transaction.closed) await transaction.rollback()
      }
    }
    const dependencies = openTaskDependencies(id)
    const activeStates = [STATUS.ACTIVE, ...(getStatusDef(STATUS.ACTIVE)?.aliases ?? [])]
    const activePredicate = `lower(status) IN (${activeStates.map(() => "?").join(", ")})`
    const assigneeGuard = expectedAssignedTo === undefined ? "" : " AND assigned_to = ?"
    const assigneeArgs = expectedAssignedTo === undefined ? [] : [expectedAssignedTo]
    const eligible = `id = ? AND ${version} = ? AND deferral_revision IS ?
      AND lower(status) NOT IN ${deferralTerminalStatusesSql}
      AND deferred_at IS ${deferred ? "" : "NOT "}NULL${assigneeGuard}
      ${deferred ? "" : `AND (NOT (${activePredicate}) OR NOT EXISTS (${dependencies.sql}))`}`
    const args = [id, guard.updatedAt, guard.revision, ...assigneeArgs, ...(deferred ? [] : [...activeStates, ...dependencies.args])]
    const [diagnostic, audit, changed, blockers] = await this.client.batch([
      { sql: `SELECT ${columns}, assigned_to FROM tasks WHERE id = ?`, args: [id] },
      {
        sql: `INSERT INTO task_activity_log
                (task_id, field, old_value, new_value, actor, actor_type, event_type, correlation_id, created_at)
              SELECT id, 'deferred_at', CAST(deferred_at AS TEXT), ?, ?, ?, 'field_change', ?, ?
              FROM tasks WHERE ${eligible}`,
        args: [marker === null ? null : String(marker), actor.id, actor.type, correlationId, now, ...args],
      },
      {
        sql: `UPDATE tasks SET deferred_at = ?, deferral_revision = lower(hex(randomblob(16)))
              WHERE changes() = 1 AND ${eligible} RETURNING ${columns}`,
        args: [marker, ...args],
      },
      ...(!deferred ? [{ ...dependencies, sql: `${dependencies.sql} ORDER BY t.id LIMIT 5` }] : []),
    ], "write")
    const row = changed?.rows[0] as unknown as DeferralState | undefined
    if (row && audit?.rowsAffected === 1) return { ok: true, task: row }

    const currentDiag = diagnostic?.rows[0] as unknown as DeferralDiagnostic | undefined
    if (!currentDiag) return { ok: false, errorCode: "unavailable" }
    if (expectedAssignedTo !== undefined && currentDiag.assigned_to !== expectedAssignedTo) {
      return { ok: false, errorCode: "assignee_mismatch" }
    }
    const { assigned_to: _assignedTo, ...current } = currentDiag
    if (current.updated_at !== guard.updatedAt || current.deferral_revision !== guard.revision) {
      return { ok: false, errorCode: "conflict", task: current }
    }
    if (isDeferralTerminalStatus(current.status)) {
      return { ok: false, errorCode: "terminal" }
    }
    if ((current.deferred_at !== null) === deferred) return { ok: true, task: current }
    if (!deferred && normalizeStatus(current.status) === STATUS.ACTIVE && blockers?.rows.length) {
      return { ok: false, errorCode: "blocked", blockers: blockers.rows as unknown as TaskBlocker[] }
    }
    throw new Error("Task deferral write did not match its transaction snapshot")
  }

  /** Fetch old field values for activity log diffing before an update */
  async getFieldsForDiff(id: string): Promise<TaskRow | null> {
    const result = await this.client.execute({
      sql: `SELECT title, description, status, priority, due_date, labels,
                   framework_payload, area_id, custom_fields, parent_id,
                   task_type, task_kind, project_id, owner, handoff_state,
                   start_date, end_date, progress, color, is_favorite, is_promoted, assigned_to,
                   urgency, importance, eisenhower_override
            FROM tasks WHERE id = ? LIMIT 1`,
      args: [id],
    });
    return (result.rows[0] as unknown as TaskRow) ?? null;
  }

  /**
   * Log field-level activity changes (fire-and-forget).
   * Uses a single multi-row INSERT for performance — avoids N parallel statements.
   */
  async logActivity(
    taskId: string,
    changes: Array<{ field: string; oldValue: string | null; newValue: string }>,
    opts?: { actor?: string; actor_type?: string; correlation_id?: string },
  ): Promise<void> {
    if (changes.length === 0) return
    const now = Date.now()
    const actorType = opts?.actor_type ?? "user"
    const actor = opts?.actor ?? "user"
    const correlationId = opts?.correlation_id ?? null

    const placeholders: string[] = []
    const args: InValue[] = []
    for (const { field, oldValue, newValue } of changes) {
      const eventType = field === "status" ? "status_change" : "field_change"
      const summary = `${field}: ${oldValue ?? '(empty)'} → ${newValue}`
      placeholders.push("(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      args.push(taskId, field, oldValue, newValue, actor, actorType, eventType, summary, correlationId, now)
    }

    await this.client.execute({
      sql: `INSERT INTO task_activity_log (task_id, field, old_value, new_value, actor, actor_type, event_type, summary, correlation_id, created_at)
            VALUES ${placeholders.join(", ")}`,
      args,
    }).catch((err) => logApiError("audit-activity", "Failed to write activity log entries", err))
  }

  /**
   * Record a non-field-change timeline event (created, delegated, sync, etc.)
   * Part of the Immutable Audit Ledger — every significant action gets recorded.
   */
  async recordTimelineEvent(taskId: string, event: {
    event_type: string
    actor: string
    actor_type: string
    summary: string
    field?: string
    old_value?: string | null
    new_value?: string
    correlation_id?: string
  }): Promise<void> {
    const now = Date.now()
    await this.client.execute({
      sql: `INSERT INTO task_activity_log (task_id, field, old_value, new_value, actor, actor_type, event_type, summary, correlation_id, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        taskId,
        event.field ?? event.event_type,
        event.old_value ?? null,
        event.new_value ?? null,
        event.actor,
        event.actor_type,
        event.event_type,
        event.summary,
        event.correlation_id ?? null,
        now,
      ] as InValue[],
    }).catch((err) => logApiError("audit-timeline", "Failed to write timeline event", err))
  }

  /** Delete a single task and cascade-clean related data */
  async deleteTask(id: string, options?: { signal?: AbortSignal | undefined }): Promise<void> {
    await executeWriteWithRetry(
      this.client,
      { sql: "DELETE FROM tasks WHERE id = ?", args: [id] },
      { signal: options?.signal },
    )
    // Orphan link cleanup
    try {
      await executeWriteWithRetry(
        this.client,
        {
          sql: "DELETE FROM task_links WHERE source_task_id = ? OR target_task_id = ?",
          args: [id, id],
        },
        { signal: options?.signal },
      )
    } catch (err) {
      if ((err as { name?: string })?.name === "AbortError") throw err
      /* task_links table may not exist yet */
    }
  }

  /** Purge ALL tasks (cascade: activity log, comments, tasks) */
  async purgeAll(): Promise<void> {
    await this.client.execute("DELETE FROM task_activity_log");
    await this.client.execute("DELETE FROM comments");
    await this.client.execute("DELETE FROM tasks");
  }

  /**
   * Count completed/archived tasks older than a cutoff timestamp.
   * Used for dry-run preview before destructive deletion.
   * @param cutoffMs - Epoch milliseconds; tasks with updated_at < this are counted
   */
  async countCompletedBefore(cutoffMs: number): Promise<number> {
    const result = await this.client.execute({
      sql: `SELECT COUNT(*) as cnt FROM tasks
            WHERE status IN ('complete', 'archived')
              AND updated_at < ?`,
      args: [cutoffMs],
    });
    return Number((result.rows[0] as Record<string, unknown>)?.cnt ?? 0);
  }

  /**
   * Permanently delete completed/archived tasks older than a cutoff timestamp.
   * Cascades to: task_activity_log, comments, task_links.
   *
   * @param cutoffMs - Epoch milliseconds; tasks with updated_at < this are deleted
   * @returns Number of tasks deleted
   *
   * @safety Only touches tasks with status IN ('complete', 'archived').
   * Active, pending, and in-progress tasks are NEVER affected regardless of age.
   */
  async deleteCompletedBefore(cutoffMs: number): Promise<number> {
    const expired = "SELECT id FROM tasks WHERE status IN ('complete', 'archived') AND updated_at < ?"
    const results = await this.client.batch([
      { sql: `DELETE FROM task_activity_log WHERE task_id IN (${expired})`, args: [cutoffMs] },
      { sql: `DELETE FROM comments WHERE task_id IN (${expired})`, args: [cutoffMs] },
      {
        sql: `DELETE FROM task_links WHERE source_task_id IN (${expired}) OR target_task_id IN (${expired})`,
        args: [cutoffMs, cutoffMs],
      },
      { sql: `DELETE FROM tasks WHERE id IN (${expired})`, args: [cutoffMs] },
    ], "write")
    return results[3]?.rowsAffected ?? 0
  }

  private *createRecurrenceSuccessor(
    id: string,
    completionDay: string,
  ): Generator<InStatement[], RecurrenceOutcome, ResultSet[]> {
    const [recurrence] = yield [this.recurrenceDataQuery(id)]
    const source = recurrence?.rows[0] as unknown as TaskRow | undefined
    const rule = source?.recurrence_rule
    if (!source || typeof rule !== "string" || !rule) return

    const parsed = parseRRule(rule)
    if (!parsed) return "invalid"

    const base = source.recurrence_anchor === "completion_date" || !source.due_date
      ? completionDay
      : String(source.due_date)
    const savedDate = new Date(base)
    const writtenDay = readStoredCalendarDay(base)
    const writtenDate = writtenDay && writtenDay !== base && Number.isFinite(savedDate.getTime())
      ? new Date(writtenDay)
      : savedDate
    const anchor = Number.isFinite(writtenDate.getTime()) ? writtenDate : savedDate
    const next = getNextOccurrence(parsed, anchor)
    if (next === null) return
    if (!Number.isFinite(next.getTime())) return "invalid"

    const dueDate = next.toISOString().split("T")[0]!
    const { id: successorId, insert } = this.recurrenceInsert(source, dueDate, rule)
    const [created] = yield [insert]
    const ticket = created?.rows[0]?.ticket_number
    if (ticket == null) throw new Error("Recurring occurrence insert returned no ticket")
    return { id: successorId, ticketNumber: Number(ticket), title: source.title, dueDate, rule }
  }

  /** Fetch the task fields inherited by its next occurrence. */
  async getRecurrenceData(id: string): Promise<TaskRow | null> {
    const result = await this.client.execute(this.recurrenceDataQuery(id))
    return (result.rows[0] as unknown as TaskRow) ?? null
  }

  private recurrenceDataQuery(id: string): InStatement {
    return {
      sql: `SELECT recurrence_rule, recurrence_anchor, due_date, title, description, priority, labels,
                   area_id, project_id, parent_id, task_type, assigned_to, checklists, custom_fields
            FROM tasks WHERE id = ? LIMIT 1`,
      args: [id],
    }
  }

  /**
   * Clone a task for recurrence — creates next occurrence with new due date.
   * Resets checklists (all items unchecked) and status to pending.
   */
  async cloneForRecurrence(
    sourceTask: TaskRow,
    nextDueDate: string,
    recurrenceRule: string,
  ): Promise<{ id: string; ticketNumber: number }> {
    const { id, insert } = this.recurrenceInsert(sourceTask, nextDueDate, recurrenceRule)
    const result = await this.client.execute(insert)
    return { id, ticketNumber: Number(result.rows[0]!.ticket_number) }
  }

  private recurrenceInsert(sourceTask: TaskRow, nextDueDate: string, recurrenceRule: string) {
    const id = crypto.randomUUID()
    const now = Date.now()

    // Resolve the project in the insert so legacy references and concurrent
    // project deletion cannot create a dangling reference.
    const insert: InStatement = {
      sql: `INSERT INTO tasks (id, title, description, status, priority, due_date, labels,
                               recurrence_rule, recurrence_anchor, area_id, project_id, parent_id, task_type, assigned_to,
                               checklists, custom_fields, ticket_number,
                               idempotency_key, request_id, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                    (SELECT id FROM projects WHERE id = ?), ?, ?, ?, ?, ?,
                    (SELECT COALESCE(MAX(ticket_number), 0) + 1 FROM tasks), ?, ?, ?, ?)
            RETURNING ticket_number`,
      args: [
        id,
        sourceTask.title ? String(sourceTask.title) : "Recurring task",
        sourceTask.description ? String(sourceTask.description) : null,
        STATUS.PENDING,
        sourceTask.priority != null ? Number(sourceTask.priority) : 3,
        nextDueDate,
        sourceTask.labels ? String(sourceTask.labels) : "[]",
        recurrenceRule,
        sourceTask.recurrence_anchor ? String(sourceTask.recurrence_anchor) : "due_date",
        sourceTask.area_id ? String(sourceTask.area_id) : "default",
        sourceTask.project_id ?? null,
        sourceTask.parent_id ? String(sourceTask.parent_id) : null,
        sourceTask.task_type ? String(sourceTask.task_type) : "task",
        sourceTask.assigned_to ? String(sourceTask.assigned_to) : null,
        cloneRecurringChecklist(sourceTask.checklists),
        sourceTask.custom_fields ? String(sourceTask.custom_fields) : "{}",
        crypto.randomUUID(), crypto.randomUUID(), now, now,
      ] as InValue[],
    }
    return { id, insert }
  }

  /** Count open tasks (non-complete) — used for iOS badge count */
  async getOpenTaskCount(): Promise<number> {
    try {
      const result = await this.client.execute({
        sql: `SELECT COUNT(*) as cnt FROM tasks WHERE status NOT IN (?)`,
        args: [STATUS.COMPLETE],
      });
      return Number((result.rows[0] as Record<string, unknown>).cnt) || 0;
    } catch { return 0; }
  }

  /**
   * Get immediate child task IDs for cascade completion.
   * Only returns non-complete children.
   */
  async getChildrenIds(parentId: string, assignedTo?: string): Promise<string[]> {
    const assigneeFilter = assignedTo === undefined ? "" : " AND assigned_to = ?"
    const args = assignedTo === undefined ? [parentId, STATUS.COMPLETE] : [parentId, STATUS.COMPLETE, assignedTo]
    const result = await this.client.execute({
      sql: `SELECT id FROM tasks WHERE parent_id = ? AND status != ?${assigneeFilter}`,
      args,
    });
    return result.rows.map((r) => String((r as Record<string, unknown>).id));
  }

  /**
   * Cascade complete — set all non-complete children to complete and return their IDs.
   * When assignedTo is supplied, only children assigned to that agent are updated.
   */
  async cascadeCompleteIds(parentId: string, assignedTo?: string): Promise<string[]> {
    const now = Date.now()
    const assigneeFilter = assignedTo === undefined ? "" : " AND assigned_to = ?"
    const args = assignedTo === undefined
      ? [STATUS.COMPLETE, now, parentId, STATUS.COMPLETE]
      : [STATUS.COMPLETE, now, parentId, STATUS.COMPLETE, assignedTo]
    const result = await this.client.execute({
      sql: `UPDATE tasks SET status = ?, updated_at = ${nextTaskTimestampMs("updated_at")} WHERE parent_id = ? AND status != ?${assigneeFilter} RETURNING id`,
      args,
    });
    return result.rows.map((r) => String((r as Record<string, unknown>).id));
  }

  /**
   * Cascade complete — set all non-complete children to complete.
   * When assignedTo is supplied, only children assigned to that agent are updated.
   */
  async cascadeComplete(parentId: string, assignedTo?: string): Promise<number> {
    return (await this.cascadeCompleteIds(parentId, assignedTo)).length
  }

  /** Reorder submitted tasks across their existing slots in the shared order. */
  async reorderTasks(ids: string[]): Promise<boolean> {
    if (ids.length === 0) return false
    const result = await this.client.execute({
      sql: `WITH requested AS MATERIALIZED (
              SELECT value AS id, key AS ordinal FROM json_each(?)
            ), allowed AS MATERIALIZED (
              SELECT COUNT(*) AS total FROM requested
              JOIN tasks ON tasks.id = requested.id AND tasks.deferred_at IS NULL
              HAVING total = (SELECT COUNT(*) FROM requested)
                 AND total = COUNT(DISTINCT requested.id)
            ), ordered AS MATERIALIZED (
              SELECT id, ROW_NUMBER() OVER (
                ORDER BY kanban_position ASC NULLS LAST, priority ASC, created_at DESC, id ASC
              ) - 1 AS position
              FROM tasks WHERE EXISTS (SELECT 1 FROM allowed)
            ), slots AS MATERIALIZED (
              SELECT position, ROW_NUMBER() OVER (ORDER BY position) - 1 AS ordinal
              FROM ordered WHERE id IN (SELECT id FROM requested)
            ), ranks AS MATERIALIZED (
              SELECT ordered.id, COALESCE(slots.position, ordered.position) AS position,
                     requested.id IS NOT NULL AS submitted
              FROM ordered
              LEFT JOIN requested ON requested.id = ordered.id
              LEFT JOIN slots ON slots.ordinal = requested.ordinal
            )
            UPDATE tasks SET kanban_position = ranks.position,
              deferral_revision = CASE WHEN ranks.submitted AND ${taskTimestampMs("tasks.updated_at")} = 9007199254740991
                THEN lower(hex(randomblob(16))) ELSE deferral_revision END,
              updated_at = CASE WHEN ranks.submitted THEN ${nextTaskTimestampMs("tasks.updated_at")} ELSE updated_at END
            FROM ranks WHERE tasks.id = ranks.id
              AND (ranks.submitted OR tasks.kanban_position IS NOT ranks.position)`,
      args: [JSON.stringify(ids), Date.now()],
    })
    return result.rowsAffected > 0
  }

  /** Place a card in the shared order while preserving every other card's relative order. */
  async reorderKanbanCard(input: { id: string; anchorId: string; lane: string; before: boolean }): Promise<boolean> {
    // Lane membership and promotion group are checked before ranking the full
    // board. The underlying order is shared across lanes, filters and groups.
    // Leave the unranked suffix alone; it still sorts by the same tie-breaks.
    const result = await this.client.execute({
      sql: `WITH requested(moved_id, anchor_id, lane, after_anchor) AS (VALUES (?, ?, ?, ?)),
            allowed AS MATERIALIZED (
              SELECT requested.*
              FROM requested
              WHERE (
                SELECT COUNT(*) = 2 AND MIN(is_promoted) = MAX(is_promoted) FROM tasks
                WHERE id IN (requested.moved_id, requested.anchor_id)
                  AND deferred_at IS NULL
                  AND status IN (
                    SELECT value FROM json_each((SELECT includes FROM kanban_lanes WHERE key = requested.lane))
                  )
              )
            ),
            ordered AS MATERIALIZED (
              SELECT id, kanban_position, ROW_NUMBER() OVER (
                ORDER BY kanban_position ASC NULLS LAST, priority ASC, created_at DESC, id ASC
              ) AS position
              FROM tasks
              WHERE EXISTS (SELECT 1 FROM allowed)
            ),
            move AS MATERIALIZED (
              SELECT moved_id, source.position AS from_position,
                     anchor.position + after_anchor - (source.position < anchor.position) AS to_position
              FROM allowed
              JOIN ordered AS source ON source.id = moved_id
              JOIN ordered AS anchor ON anchor.id = anchor_id
            ),
            updated_order AS MATERIALIZED (
              SELECT ordered.id, ordered.kanban_position AS prior_position, CASE
                WHEN from_position = to_position THEN kanban_position
                ELSE (CASE
                  WHEN ordered.id = moved_id THEN to_position
                  WHEN position > from_position AND position <= to_position THEN position - 1
                  WHEN position >= to_position AND position < from_position THEN position + 1
                  ELSE position
                END) - 1
              END AS position
              FROM ordered CROSS JOIN move
              WHERE from_position != to_position OR ordered.id = moved_id
            )
            UPDATE tasks
            SET kanban_position = updated_order.position,
                inactivity_touched_at = CASE WHEN tasks.id = (SELECT moved_id FROM move WHERE from_position != to_position)
                  THEN MAX(COALESCE(inactivity_touched_at, 0), ?) ELSE inactivity_touched_at END
            FROM updated_order
            WHERE tasks.id = updated_order.id
              AND (
                tasks.id = (SELECT moved_id FROM move)
                OR (tasks.kanban_position IS NOT updated_order.position AND updated_order.position <= (
                  SELECT MAX(position) FROM updated_order
                  WHERE prior_position IS NOT NULL OR id = (SELECT moved_id FROM move)
                ))
              )`,
      args: [input.id, input.anchorId, input.lane, input.before ? 0 : 1, Date.now()],
    })
    return result.rowsAffected > 0
  }

  /** Look up custom user display name by ID */
  async getCustomUserName(userId: string): Promise<string | null> {
    try {
      const result = await this.client.execute({
        sql: "SELECT name FROM custom_users WHERE id = ? LIMIT 1",
        args: [userId],
      });
      if (result.rows.length > 0) return String((result.rows[0] as Record<string, unknown>).name);
    } catch { /* table may not exist */ }
    return null;
  }

  /** Fetch notification preferences from settings table */
  async getNotificationPreferences(): Promise<{
    enabled: boolean;
    disabledUsers: Set<string>;
    channels: { sidebar: boolean; mobile_push: boolean };
    mobileTargets: string[];
  }> {
    const defaults = {
      enabled: true,
      disabledUsers: new Set<string>(),
      channels: { sidebar: true, mobile_push: false },
      mobileTargets: [] as string[],
    };
    try {
      const result = await this.client.execute({
        sql: "SELECT value FROM settings WHERE key = 'notification_preferences' LIMIT 1",
        args: [],
      });
      if (result.rows.length > 0) {
        const raw = JSON.parse(String((result.rows[0] as Record<string, unknown>).value));
        if (typeof raw === "object" && raw !== null) {
          defaults.enabled = raw.enabled !== false;
          if (Array.isArray(raw.disabled_users)) defaults.disabledUsers = new Set(raw.disabled_users);
          if (raw.channels) defaults.channels = raw.channels;
          if (Array.isArray(raw.mobile_targets)) defaults.mobileTargets = raw.mobile_targets;
        }
      }
    } catch { /* settings not available */ }
    return defaults;
  }

  // ── Comment Methods ─────────────────────────────────────────────────

  /** List comments for a task, ordered by creation time ascending */
  async getComments(taskId: string, ownerKey: string | null) {
    const result = await this.client.execute({
      sql: `SELECT id, task_id, content, author, created_at,
                   CASE WHEN owner_key = ? THEN 1 ELSE 0 END AS can_manage
            FROM comments WHERE task_id = ? ORDER BY created_at ASC, id ASC`,
      args: [ownerKey, taskId],
    })
    return result.rows.map(row => ({ ...row, content: String(row.content), can_manage: Number(row.can_manage) === 1 }))
  }

  /** Insert and return a comment atomically with optional assignee ownership guard. */
  async addCommentChecked(
    taskId: string,
    content: string,
    author: string,
    ownerKey: string | null,
    verifiedHuman = false,
    expectedAssignedTo?: string,
  ): Promise<{ state: "created"; comment: Record<string, unknown> } | { state: "not_found" } | { state: "assignee_mismatch" }> {
    const tx = await this.client.transaction("write")
    try {
      const assigneeSql = expectedAssignedTo === undefined ? "" : " AND assigned_to = ?"
      const assigneeArgs = expectedAssignedTo === undefined ? [] : [expectedAssignedTo]
      const inserted = await tx.execute({
        sql: `INSERT INTO comments (task_id, content, author, owner_key, inactivity_spike_human)
              SELECT id, ?, ?, ?, ? FROM tasks WHERE id = ?${assigneeSql}
              RETURNING id, task_id, content, author, created_at`,
        args: [content, author, ownerKey, verifiedHuman ? 1 : 0, taskId, ...assigneeArgs],
      })
      const row = inserted.rows[0] as Record<string, unknown> | undefined
      if (row) {
        await tx.commit()
        return { state: "created", comment: row }
      }
      if (expectedAssignedTo !== undefined) {
        const current = await tx.execute({ sql: "SELECT assigned_to FROM tasks WHERE id = ?", args: [taskId] })
        await tx.commit()
        return current.rows.length > 0 ? { state: "assignee_mismatch" } : { state: "not_found" }
      }
      await tx.commit()
      return { state: "not_found" }
    } finally {
      tx.close()
    }
  }

  /** Insert and return this comment while the parent task exists. */
  async addComment(taskId: string, content: string, author: string, ownerKey: string | null, verifiedHuman = false) {
    const res = await this.addCommentChecked(taskId, content, author, ownerKey, verifiedHuman)
    return res.state === "created" ? res.comment : undefined
  }

  async getComment(taskId: string, commentId: number) {
    const result = await this.client.execute({
      sql: "SELECT id, task_id, content, author, created_at FROM comments WHERE task_id = ? AND id = ?",
      args: [taskId, commentId],
    })
    return result.rows[0]
  }

  async deleteComment(taskId: string, commentId: number, ownerKey: string): Promise<boolean> {
    const result = await this.client.execute({
      sql: "DELETE FROM comments WHERE task_id = ? AND id = ? AND owner_key = ?",
      args: [taskId, commentId, ownerKey],
    })
    return result.rowsAffected > 0
  }

  // ── Activity Log Methods ────────────────────────────────────────────

  /** Fetch paginated activity log for a task */
  async getActivityLog(taskId: string, limit: number, offset: number) {
    const where = `WHERE task_id = ? AND ${taskHistoryPredicate}`
    const [events, count] = await this.client.batch([
      {
        sql: `SELECT id, task_id, field, old_value, new_value, actor, actor_type, event_type, summary, correlation_id, created_at
              FROM task_activity_log ${where}
              ORDER BY created_at DESC
              LIMIT ? OFFSET ?`,
        args: [taskId, limit, offset],
      },
      {
        sql: `SELECT COUNT(*) AS total FROM task_activity_log ${where}`,
        args: [taskId],
      },
    ], "read")
    return { activity: events?.rows ?? [], total: Number(count?.rows[0]?.total ?? 0) }
  }

  /**
   * Unified timeline: merges activity log + comments chronologically.
   * Returns a combined view for the Immutable Audit Ledger UI.
   * Uses a single query with COUNT(*) OVER() window function for pagination.
   */
  async getTimeline(taskId: string, opts?: {
    limit?: number
    offset?: number
    event_type?: string
    actor_type?: string
  }) {
    const limit = Math.min(200, Math.max(1, opts?.limit ?? 50))
    const offset = Math.max(0, opts?.offset ?? 0)

    const conditions = ["task_id = ?", taskHistoryPredicate]
    const args: InValue[] = [taskId]

    if (opts?.event_type) {
      conditions.push("event_type = ?")
      args.push(opts.event_type)
    }
    if (opts?.actor_type) {
      conditions.push("actor_type = ?")
      args.push(opts.actor_type)
    }

    const where = conditions.join(" AND ")

    // Skip comments subquery when filtering by event_type that isn't 'comment'
    const includeComments = !opts?.event_type || opts.event_type === "comment"

    // Build unified query with COUNT(*) OVER() to avoid a second round-trip
    const commentSubquery = includeComments
      ? `UNION ALL
         SELECT id, task_id, 'comment' as field, NULL as old_value, content as new_value,
                author as actor, 'user' as actor_type, 'comment' as event_type,
                'Comment: ' || SUBSTR(content, 1, 100) as summary,
                NULL as correlation_id,
                CAST(strftime('%s', created_at) * 1000 AS INTEGER) as created_at
         FROM comments
         WHERE task_id = ?
           ${opts?.actor_type ? "AND author = ?" : ""}`
      : ""

    const commentArgs: InValue[] = includeComments
      ? [taskId, ...(opts?.actor_type ? [opts.actor_type] : [])]
      : []

    const result = await this.client.execute({
      sql: `SELECT *, COUNT(*) OVER() as _total
            FROM (
              SELECT id, task_id, field, old_value, new_value, actor, actor_type, event_type, summary, correlation_id, created_at
              FROM task_activity_log
              WHERE ${where}
              ${commentSubquery}
            )
            ORDER BY created_at DESC
            LIMIT ? OFFSET ?`,
      args: [
        ...args,
        ...commentArgs,
        limit,
        offset,
      ],
    })

    const total = result.rows.length > 0
      ? Number((result.rows[0] as Record<string, unknown>)?._total ?? 0)
      : 0

    // Strip the _total window column from output rows
    const events = result.rows.map((row) => {
      const { _total, ...rest } = row as Record<string, unknown>
      return rest
    })

    return { events, total, limit, offset }
  }

  /**
   * Purge all activity log entries for a specific task.
   * GDPR right to erasure — allows deleting audit trail without deleting the task itself.
   * @returns Number of records deleted
   */
  async purgeActivityLog(taskId: string): Promise<number> {
    const result = await this.client.execute({
      sql: "DELETE FROM task_activity_log WHERE task_id = ?",
      args: [taskId],
    })
    return result.rowsAffected
  }

  /**
   * Retention-based cleanup — delete activity log entries older than a cutoff.
   * Use for regular maintenance to prevent unbounded audit log growth.
   * @param cutoffMs - Epoch milliseconds; entries with created_at < this are deleted
   * @returns Number of records deleted
   */
  async purgeActivityLogBefore(cutoffMs: number): Promise<number> {
    const result = await this.client.execute({
      sql: "DELETE FROM task_activity_log WHERE created_at < ?",
      args: [cutoffMs],
    })
    return result.rowsAffected
  }

  // ── Task Link Methods ──────────────────────────────────────────────

  /** Get outbound links (this task → other tasks) with target info */
  async getOutboundLinks(taskId: string) {
    const result = await this.client.execute({
      sql: `SELECT tl.id, tl.source_task_id, tl.target_task_id, tl.link_type, tl.created_at,
                   t.title AS target_title, t.task_type AS target_task_type, t.ticket_number AS target_ticket_number
            FROM task_links tl
            JOIN tasks t ON t.id = tl.target_task_id
            WHERE tl.source_task_id = ?
            ORDER BY tl.created_at DESC`,
      args: [taskId],
    });
    return result.rows;
  }

  /** Get inbound links (other tasks → this task) with source info */
  async getInboundLinks(taskId: string) {
    const result = await this.client.execute({
      sql: `SELECT tl.id, tl.source_task_id, tl.target_task_id, tl.link_type, tl.created_at,
                   t.title AS source_title, t.task_type AS source_task_type, t.ticket_number AS source_ticket_number
            FROM task_links tl
            JOIN tasks t ON t.id = tl.source_task_id
            WHERE tl.target_task_id = ?
            ORDER BY tl.created_at DESC`,
      args: [taskId],
    });
    return result.rows;
  }

  /** Check if a specific link already exists (idempotency) */
  async linkExists(sourceTaskId: string, targetTaskId: string, linkType: string): Promise<boolean> {
    const result = await this.client.execute({
      sql: "SELECT id FROM task_links WHERE source_task_id = ? AND target_task_id = ? AND link_type = ?",
      args: [sourceTaskId, targetTaskId, linkType],
    });
    return result.rows.length > 0;
  }

  /** Create a task link inside a write lock with optional atomic assignee verification on both endpoints. */
  async createLinkChecked(
    id: string,
    sourceTaskId: string,
    targetTaskId: string,
    linkType: string,
    expectedAssignedTo?: string,
  ): Promise<{ ok: true; createdAt: string } | { ok: false; errorCode: "not_found" | "assignee_mismatch" }> {
    const now = new Date().toISOString()
    const tx = await this.client.transaction("write")
    try {
      if (expectedAssignedTo !== undefined) {
        const res = await tx.execute({
          sql: "SELECT id, assigned_to FROM tasks WHERE id IN (?, ?)",
          args: [sourceTaskId, targetTaskId],
        })
        const byId = new Map(res.rows.map(r => [String((r as Record<string, unknown>).id), (r as Record<string, unknown>).assigned_to]))
        if (!byId.has(sourceTaskId) || !byId.has(targetTaskId)) {
          await tx.commit()
          return { ok: false, errorCode: "not_found" }
        }
        if (byId.get(sourceTaskId) !== expectedAssignedTo || byId.get(targetTaskId) !== expectedAssignedTo) {
          await tx.commit()
          return { ok: false, errorCode: "assignee_mismatch" }
        }
      }
      await tx.execute({
        sql: "INSERT INTO task_links (id, source_task_id, target_task_id, link_type, created_at) VALUES (?, ?, ?, ?, ?)",
        args: [id, sourceTaskId, targetTaskId, linkType, now],
      })
      await tx.commit()
      return { ok: true, createdAt: now }
    } finally {
      tx.close()
    }
  }

  /** Create a new task link */
  async createLink(id: string, sourceTaskId: string, targetTaskId: string, linkType: string): Promise<string> {
    const res = await this.createLinkChecked(id, sourceTaskId, targetTaskId, linkType)
    return res.ok ? res.createdAt : new Date().toISOString()
  }

  /** Fetch endpoints for a task link belonging to the specified task */
  async getLinkEndpoints(linkId: string, taskId: string): Promise<{ source_task_id: string; target_task_id: string } | null> {
    const result = await this.client.execute({
      sql: "SELECT source_task_id, target_task_id FROM task_links WHERE id = ? AND (source_task_id = ? OR target_task_id = ?)",
      args: [linkId, taskId, taskId],
    })
    const row = result.rows[0] as Record<string, unknown> | undefined
    if (!row) return null
    return {
      source_task_id: String(row.source_task_id),
      target_task_id: String(row.target_task_id),
    }
  }

  /** Delete a task link atomically with optional assignee ownership guard on both endpoints. */
  async deleteLinkChecked(
    linkId: string,
    taskId: string,
    expectedAssignedTo?: string,
  ): Promise<{ deleted: number; assigneeMismatch: boolean }> {
    const tx = await this.client.transaction("write")
    try {
      if (expectedAssignedTo !== undefined) {
        const endpoints = await tx.execute({
          sql: "SELECT source_task_id, target_task_id FROM task_links WHERE id = ? AND (source_task_id = ? OR target_task_id = ?)",
          args: [linkId, taskId, taskId],
        })
        const ep = endpoints.rows[0] as Record<string, unknown> | undefined
        if (!ep) {
          const tRow = await tx.execute({ sql: "SELECT assigned_to FROM tasks WHERE id = ?", args: [taskId] })
          const assigneeMismatch = tRow.rows.length > 0 && (tRow.rows[0] as Record<string, unknown>).assigned_to !== expectedAssignedTo
          await tx.commit()
          return { deleted: 0, assigneeMismatch }
        }
        const taskRows = await tx.execute({
          sql: "SELECT id, assigned_to FROM tasks WHERE id IN (?, ?)",
          args: [String(ep.source_task_id), String(ep.target_task_id)],
        })
        const owned = taskRows.rows.length === 2 && taskRows.rows.every(r => (r as Record<string, unknown>).assigned_to === expectedAssignedTo)
        if (!owned) {
          await tx.commit()
          return { deleted: 0, assigneeMismatch: true }
        }
      }
      const result = await tx.execute({
        sql: "DELETE FROM task_links WHERE id = ? AND (source_task_id = ? OR target_task_id = ?)",
        args: [linkId, taskId, taskId],
      })
      await tx.commit()
      return { deleted: result.rowsAffected, assigneeMismatch: false }
    } finally {
      tx.close()
    }
  }

  /** Delete a task link (scoped to a specific task for authorization) */
  async deleteLink(linkId: string, taskId: string): Promise<number> {
    return (await this.deleteLinkChecked(linkId, taskId)).deleted
  }

  // ── Inbound Sync Batch Persistence (Track B3) ─────────────────────────

  /**
   * Batch-load existing external sync confirmation links and task timestamps in chunks of <= 200 bind parameters.
   */
  async findTasksByExternalSyncIds(lookup: ExternalSyncLookup): Promise<Map<string, ExternalSyncMatch>> {
    const matches = new Map<string, ExternalSyncMatch>()
    if (lookup.externalIds.length === 0) return matches
    const uniqueIds = [...new Set(lookup.externalIds)]
    const maxIdsPerChunk = 199
    const taskUpdatedExpr = taskTimestampMs("t.updated_at")

    for (let offset = 0; offset < uniqueIds.length; offset += maxIdsPerChunk) {
      const chunk = uniqueIds.slice(offset, offset + maxIdsPerChunk)
      const placeholders = chunk.map(() => "?").join(", ")
      let stmt: InStatement
      if (lookup.source === "ha_todo") {
        stmt = {
          sql: `SELECT c.confirmation_id, c.task_id, c.ha_todo_uid AS external_id,
                       COALESCE(c.updated_at, c.created_at, 0) AS sync_updated_at,
                       COALESCE(${taskUpdatedExpr}, 0) AS task_updated_at
                FROM todo_sync_confirmations c
                LEFT JOIN tasks t ON t.id = c.task_id
                WHERE c.ha_entity_id = ? AND c.ha_todo_uid IN (${placeholders})`,
          args: [lookup.entityId, ...chunk],
        }
      } else if (lookup.source === "calendar") {
        stmt = {
          sql: `SELECT c.confirmation_id, c.task_id, c.provider_event_id AS external_id,
                       COALESCE(c.created_at, 0) AS sync_updated_at,
                       COALESCE(${taskUpdatedExpr}, 0) AS task_updated_at
                FROM calendar_confirmations c
                LEFT JOIN tasks t ON t.id = c.task_id
                WHERE c.provider_event_id IN (${placeholders})
                  AND CASE WHEN json_valid(c.payload) THEN json_extract(c.payload, '$.entity_id') ELSE NULL END = ?`,
          args: [...chunk, lookup.entityId],
        }
      } else {
        stmt = {
          sql: `SELECT c.confirmation_id, c.task_id, c.grocy_entity_id AS external_id,
                       COALESCE(c.updated_at, c.created_at, 0) AS sync_updated_at,
                       COALESCE(${taskUpdatedExpr}, 0) AS task_updated_at
                FROM grocy_sync_confirmations c
                LEFT JOIN tasks t ON t.id = c.task_id
                WHERE c.grocy_entity_type = ? AND c.grocy_entity_id IN (${placeholders})`,
          args: [lookup.grocyEntityType, ...chunk],
        }
      }

      try {
        const result = await this.client.execute(stmt)
        for (const row of result.rows) {
          const r = row as Record<string, unknown>
          const externalId = String(r.external_id)
          matches.set(externalId, {
            confirmationId: String(r.confirmation_id),
            taskId: String(r.task_id),
            externalId,
            syncUpdatedAt: Number(r.sync_updated_at ?? 0),
            taskUpdatedAt: Number(r.task_updated_at ?? 0),
          })
        }
      } catch (err) {
        if (String(err).includes("no such table")) return matches
        throw err
      }
    }

    return matches
  }

  /**
   * Commit inbound sync create/update/link mutations in bounded <= 25-item transactions
   * with per-item SQLite SAVEPOINT isolation and cooperative setImmediate() yielding between chunks.
   */
  async commitSyncMutationChunks(
    mutations: SyncTaskMutation[],
    options?: { chunkSize?: number | undefined; signal?: AbortSignal | undefined },
  ): Promise<SyncChunkCommitResult> {
    const aggregate: SyncChunkCommitResult = {
      created: 0,
      updated: 0,
      linked: 0,
      skipped: 0,
      chunksCommitted: 0,
      ticketNumbers: [],
      errors: [],
    }
    if (mutations.length === 0) return aggregate

    if (mutations.some(m => m.confirmation?.source === "ha_todo")) {
      await ensureTodoSyncConfirmationTable(this.client)
    }
    if (mutations.some(m => m.confirmation?.source === "grocy")) {
      await ensureGrocySyncConfirmationTable(this.client)
    }

    const chunkSize = Math.max(1, Math.min(25, Math.floor(options?.chunkSize ?? 25)))
    const buildConfirmationInsert = (
      conf: SyncConfirmationTarget,
      taskId: string,
      reqId: string,
      nowMs: number,
      orIgnore: boolean,
    ): InStatement => {
      const confirmationId = conf.confirmationId ?? crypto.randomUUID()
      const insertVerb = orIgnore ? "INSERT OR IGNORE" : "INSERT"
      if (conf.source === "ha_todo") {
        return {
          sql: `${insertVerb} INTO todo_sync_confirmations (
                  confirmation_id, task_id, request_id, ha_entity_id, ha_todo_uid,
                  source, sync_direction, payload, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, 'ha.todo_sync', ?, ?, ?, ?)`,
          args: [
            confirmationId,
            taskId,
            reqId,
            conf.entityId,
            conf.externalId,
            conf.syncDirection ?? "inbound",
            conf.payload,
            nowMs,
            nowMs,
          ],
        }
      }
      if (conf.source === "calendar") {
        return {
          sql: `${insertVerb} INTO calendar_confirmations (
                  confirmation_id, task_id, request_id, provider_event_id,
                  source, payload, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          args: [
            confirmationId,
            taskId,
            reqId,
            conf.externalId,
            conf.confirmationSource ?? "ha.calendar_sync",
            conf.payload,
            nowMs,
          ],
        }
      }
      return {
        sql: `${insertVerb} INTO grocy_sync_confirmations (
                confirmation_id, task_id, grocy_entity_type, grocy_entity_id,
                sync_direction, payload, created_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          confirmationId,
          taskId,
          conf.grocyEntityType,
          conf.externalId,
          conf.syncDirection ?? "inbound",
          conf.payload,
          nowMs,
          nowMs,
        ],
      }
    }

    for (let offset = 0; offset < mutations.length; offset += chunkSize) {
      if (offset > 0) {
        options?.signal?.throwIfAborted()
        await new Promise<void>(resolve => setImmediate(resolve))
      }
      const chunk = mutations.slice(offset, offset + chunkSize)
      const chunkOutcome = await runWriteTransaction(
        this.client,
        function* (): Generator<
          InStatement[],
          {
            created: number
            updated: number
            linked: number
            skipped: number
            ticketNumbers: number[]
            errors: SyncChunkItemError[]
          },
          ResultSet[]
        > {
          let created = 0
          let updated = 0
          let linked = 0
          let skipped = 0
          const ticketNumbers: number[] = []
          const errors: SyncChunkItemError[] = []

          for (let localIdx = 0; localIdx < chunk.length; localIdx++) {
            const globalIdx = offset + localIdx
            const mutation = chunk[localIdx]!
            const sp = `sync_item_${localIdx}`
            yield [`SAVEPOINT ${sp}`]
            let step = "init"
            let candidateTaskId: string | null = null

            try {
              if (mutation.kind === "create") {
                const taskId = mutation.taskId ?? crypto.randomUUID()
                candidateTaskId = taskId
                const reqId = mutation.requestId ?? crypto.randomUUID()
                const nowMs = mutation.createdAt ?? Date.now()
                const labelsJson = typeof mutation.labels === "string"
                  ? mutation.labels
                  : JSON.stringify(mutation.labels ?? [])

                step = "task_insert"
                const [inserted] = yield [{
                  sql: `INSERT INTO tasks (
                          id, title, description, status, priority, due_date,
                          start_date, end_date, recurrence_rule,
                          labels, framework_payload, calendar_sync_state, area_id,
                          custom_fields, task_type, task_kind, ticket_number,
                          idempotency_key, request_id, created_at, updated_at
                        ) VALUES (
                          ?, ?, ?, ?, ?, ?,
                          ?, ?, ?,
                          ?, '{}', 'synced', ?,
                          '{}', ?, ?, (SELECT COALESCE(MAX(ticket_number), 0) + 1 FROM tasks),
                          ?, ?, ?, ?
                        ) RETURNING ticket_number`,
                  args: [
                    taskId,
                    mutation.title,
                    mutation.description ?? "",
                    normalizeStatus(mutation.status ?? STATUS.PENDING),
                    mutation.priority ?? 3,
                    mutation.dueDate ?? null,
                    mutation.startDate ?? null,
                    mutation.endDate ?? null,
                    mutation.recurrenceRule ?? null,
                    labelsJson,
                    mutation.areaId ?? "default",
                    mutation.taskType ?? "task",
                    mutation.taskKind ?? "standard_action",
                    mutation.idempotencyKey,
                    reqId,
                    nowMs,
                    nowMs,
                  ],
                }]

                step = "confirmation_insert"
                yield [buildConfirmationInsert(mutation.confirmation, taskId, reqId, nowMs, false)]
                yield [`RELEASE SAVEPOINT ${sp}`]
                created++
                const ticketNum = Number(inserted?.rows[0]?.ticket_number)
                if (Number.isFinite(ticketNum)) ticketNumbers.push(ticketNum)
              } else if (mutation.kind === "link") {
                const reqId = mutation.requestId ?? crypto.randomUUID()
                const nowMs = mutation.createdAt ?? Date.now()
                step = "confirmation_link"
                yield [buildConfirmationInsert(mutation.confirmation, mutation.taskId, reqId, nowMs, true)]
                yield [`RELEASE SAVEPOINT ${sp}`]
                linked++
              } else {
                const nowMs = mutation.updatedAt ?? Date.now()
                step = "task_update"

                if (mutation.confirmation?.source === "ha_todo" && mutation.confirmation.requireUnmodifiedSinceSync) {
                  const taskVersion = taskTimestampMs("tasks.updated_at")
                  const linkArgs: InValue[] = [
                    mutation.confirmation.confirmationId ?? "",
                    mutation.taskId,
                    mutation.confirmation.entityId,
                    mutation.confirmation.externalId,
                  ]
                  const matchingLink = "confirmation_id = ? AND task_id = ? AND ha_entity_id = ? AND ha_todo_uid = ?"
                  const [taskUpdateRes] = yield [{
                    sql: `UPDATE tasks SET
                            title = ?,
                            status = CASE WHEN ? AND deferred_at IS NOT NULL AND lower(status) NOT IN ${deferralTerminalStatusesSql}
                              THEN status ELSE ? END,
                            due_date = ?,
                            description = COALESCE(?, description),
                            deferral_revision = CASE WHEN ${taskVersion} = 9007199254740991
                              THEN lower(hex(randomblob(16))) ELSE deferral_revision END,
                            updated_at = ${nextTaskTimestampMs("tasks.updated_at")}
                          WHERE id = ?
                            AND EXISTS (
                              SELECT 1 FROM todo_sync_confirmations confirmation
                              WHERE ${matchingLink} AND ${taskVersion} <= ${taskTimestampMs("confirmation.updated_at")}
                            )`,
                    args: [
                      mutation.title ?? "",
                      mutation.openEcho ? 1 : 0,
                      normalizeStatus(mutation.status ?? STATUS.PENDING),
                      mutation.dueDate ?? null,
                      mutation.description ?? null,
                      nowMs,
                      mutation.taskId,
                      ...linkArgs,
                    ],
                  }]

                  if ((taskUpdateRes?.rowsAffected ?? 0) === 1) {
                    step = "confirmation_update"
                    yield [{
                      sql: `UPDATE todo_sync_confirmations
                            SET payload = ?, updated_at = (SELECT updated_at FROM tasks WHERE id = ?)
                            WHERE ${matchingLink}`,
                      args: [mutation.confirmation.payload, mutation.taskId, ...linkArgs],
                    }]
                    yield [`RELEASE SAVEPOINT ${sp}`]
                    updated++
                  } else {
                    yield [`RELEASE SAVEPOINT ${sp}`]
                    skipped++
                  }
                } else {
                  const sets: string[] = []
                  const args: InValue[] = []
                  if (mutation.title !== undefined) {
                    sets.push("title = ?")
                    args.push(mutation.title)
                  }
                  if (mutation.status !== undefined) {
                    sets.push("status = ?")
                    args.push(normalizeStatus(mutation.status))
                  }
                  if (mutation.updateDueDate === true || mutation.dueDate !== undefined) {
                    sets.push("due_date = ?")
                    args.push(mutation.dueDate ?? null)
                  }
                  if (mutation.startDate !== undefined) {
                    sets.push("start_date = ?")
                    args.push(mutation.startDate ?? null)
                  }
                  if (mutation.endDate !== undefined) {
                    sets.push("end_date = ?")
                    args.push(mutation.endDate ?? null)
                  }
                  if (mutation.recurrenceRule !== undefined) {
                    sets.push("recurrence_rule = COALESCE(?, recurrence_rule)")
                    args.push(mutation.recurrenceRule)
                  }
                  if (mutation.taskKind !== undefined) {
                    sets.push("task_kind = ?")
                    args.push(mutation.taskKind)
                  }
                  if (mutation.description !== undefined) {
                    if (mutation.replaceDescription) {
                      sets.push("description = ?")
                      args.push(mutation.description)
                    } else {
                      sets.push("description = COALESCE(?, description)")
                      args.push(mutation.description)
                    }
                  }
                  if (mutation.areaId !== undefined) {
                    sets.push("area_id = ?")
                    args.push(mutation.areaId)
                  }
                  if (mutation.ensureCalendarSyncLabel) {
                    sets.push(
                      `labels = CASE
                        WHEN labels IS NULL OR labels = '' OR labels = '[]' THEN '["calendar-sync"]'
                        WHEN json_valid(labels) AND labels NOT LIKE '%calendar-sync%'
                        THEN json_insert(labels, '$[#]', 'calendar-sync')
                        ELSE COALESCE(labels, '[]')
                      END`,
                    )
                  }
                  sets.push("updated_at = ?")
                  args.push(nowMs, mutation.taskId)

                  yield [{
                    sql: `UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`,
                    args,
                  }]

                  if (mutation.confirmation) {
                    step = "confirmation_update"
                    if (mutation.confirmation.source === "grocy") {
                      yield [{
                        sql: "UPDATE grocy_sync_confirmations SET payload = ?, updated_at = ? WHERE grocy_entity_type = ? AND grocy_entity_id = ?",
                        args: [
                          mutation.confirmation.payload,
                          nowMs,
                          mutation.confirmation.grocyEntityType,
                          mutation.confirmation.externalId,
                        ],
                      }]
                    } else if (mutation.confirmation.source === "ha_todo") {
                      yield [{
                        sql: "UPDATE todo_sync_confirmations SET payload = ?, updated_at = ? WHERE ha_entity_id = ? AND ha_todo_uid = ?",
                        args: [
                          mutation.confirmation.payload,
                          nowMs,
                          mutation.confirmation.entityId,
                          mutation.confirmation.externalId,
                        ],
                      }]
                    } else {
                      const prevId = mutation.confirmation.previousExternalId ?? mutation.confirmation.externalId
                      if (mutation.confirmation.confirmationSource === "caldav") {
                        yield [{
                          sql: `UPDATE calendar_confirmations SET payload = ?
                                WHERE task_id = ? AND provider_event_id = ? AND source = 'caldav'`,
                          args: [
                            mutation.confirmation.payload,
                            mutation.taskId,
                            mutation.confirmation.externalId,
                          ],
                        }]
                      } else {
                        yield [{
                          sql: `UPDATE calendar_confirmations SET provider_event_id = ?, payload = ?
                                WHERE task_id = ? AND provider_event_id = ? AND source = ?`,
                          args: [
                            mutation.confirmation.externalId,
                            mutation.confirmation.payload,
                            mutation.taskId,
                            prevId,
                            mutation.confirmation.confirmationSource ?? "ha.calendar_sync",
                          ],
                        }]
                      }
                    }
                  }
                  yield [`RELEASE SAVEPOINT ${sp}`]
                  updated++
                }
              }
            } catch (stepErr) {
              if ((stepErr as { name?: string } | null)?.name === "AbortError") {
                throw stepErr
              }
              const extCode = (stepErr as { extendedCode?: string } | null)?.extendedCode
              if (
                mutation.kind === "create" &&
                step === "task_insert" &&
                extCode === "SQLITE_CONSTRAINT_TRIGGER" &&
                candidateTaskId !== null
              ) {
                const [probe] = yield [{ sql: "SELECT 1 FROM tasks WHERE id = ?", args: [candidateTaskId] }]
                if ((probe?.rows.length ?? 0) === 0) {
                  yield [`RELEASE SAVEPOINT ${sp}`]
                } else {
                  yield [`ROLLBACK TO SAVEPOINT ${sp}`, `RELEASE SAVEPOINT ${sp}`]
                }
              } else {
                yield [`ROLLBACK TO SAVEPOINT ${sp}`, `RELEASE SAVEPOINT ${sp}`]
              }
              errors.push({
                index: globalIdx,
                message: stepErr instanceof Error ? stepErr.message : String(stepErr),
              })
            }
          }

          return { created, updated, linked, skipped, ticketNumbers, errors }
        },
        { signal: options?.signal },
      )

      aggregate.created += chunkOutcome.created
      aggregate.updated += chunkOutcome.updated
      aggregate.linked += chunkOutcome.linked
      aggregate.skipped += chunkOutcome.skipped
      aggregate.chunksCommitted++
      aggregate.ticketNumbers.push(...chunkOutcome.ticketNumbers)
      aggregate.errors.push(...chunkOutcome.errors)
    }

    return aggregate
  }
}
