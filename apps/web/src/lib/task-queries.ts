/**
 * Shared Task Data Loading — Server-side utilities for task view pages
 *
 * Centralizes SQL queries, RICE calculation, JSON field parsing, and overdue
 * detection. Used by tasks.astro, table.astro, and any future task view pages.
 *
 * Bounded Context: Tasks (persistence query)
 */

import {
  ensureSchema,
  getPersistenceClient,
} from "@domains/tasks/persistence/store";
import { deriveEisenhowerQuadrant } from "@meitheal/domain-tasks";
import { calendarDayFromInput, calendarToday } from "./date";
import { frameworkPayloadObject, readRiceInputs, riceLensScore } from "./rice-lens"

// =============================================================================
// Types
// =============================================================================

export interface TaskViewItem {
  id: string;
  title: string;
  description: string | null;
  status: string;
  priority: number;
  due_date: string | null;
  labels: string[];
  rice: number | null;
  calendar_sync_state: string | null;
  area_id: string;
  project_id: string | null
  custom_fields: Record<string, unknown>;
  start_date: string | null;
  end_date: string | null;
  progress: number;
  color: string | null;
  is_favorite: boolean;
  task_type: string;
  task_kind: string | null;
  parent_id: string | null;
  ticket_number: number | null;
  assigned_to: string | null;
  checklists: string | null;
  created_at: string;
  updated_at: string;
  deferred_at: number | null
  is_overdue: boolean;
  is_done: boolean;
  framework_payload: Record<string, unknown>;
  urgency: number;
  importance: number;
  eisenhower_quadrant: string;
  eisenhower_override: boolean;
  effort_minutes: number | null;
  effort_type: string | null;
  blocked_by: string | null;
}

export interface TaskViewResult {
  tasks: TaskViewItem[];
  counts: {
    total: number;
    open: number;
    active: number;
    pending: number;
    complete: number;
    overdue: number;
  };
  customFieldDefs: Array<{ name: string; type: string }>;
}

// =============================================================================
// JSON Parsing Helpers
// =============================================================================

function safeParseJson<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function safeParseLabels(value: unknown): string[] {
  const parsed = safeParseJson<unknown>(value, []);
  return Array.isArray(parsed) ? parsed.filter((l): l is string => typeof l === "string") : [];
}

// =============================================================================
// Overdue Detection
// =============================================================================

function isOverdue(dueDate: string | null, isDone: boolean, timezone = "Europe/Dublin"): boolean {
  if (!dueDate || isDone) return false;
  const dueDay = calendarDayFromInput(dueDate, timezone);
  if (!dueDay) return false;
  return dueDay < calendarToday(timezone);
}

// =============================================================================
// Main Query
// =============================================================================

const TASK_VIEW_COLUMNS = `
  id, title, description, status, priority, due_date, labels,
  framework_payload, calendar_sync_state, area_id, project_id, custom_fields,
  start_date, end_date, progress, color, is_favorite, task_type, task_kind,
  parent_id, ticket_number, assigned_to, checklists, created_at, updated_at, deferred_at,
  urgency, importance, eisenhower_override,
  effort_minutes, effort_type, blocked_by
`;

/**
 * Load all tasks with computed fields for any task view page.
 * Returns structured task items with RICE scores, overdue flags, and counts.
 */
export async function getTasksForView({ requireAvailable = false, timezone = "Europe/Dublin" } = {}): Promise<TaskViewResult> {
  const emptyResult: TaskViewResult = {
    tasks: [],
    counts: { total: 0, open: 0, active: 0, pending: 0, complete: 0, overdue: 0 },
    customFieldDefs: [],
  };

  try {
    await ensureSchema();
    const client = getPersistenceClient();
    const result = await client.execute(`SELECT ${TASK_VIEW_COLUMNS} FROM tasks ORDER BY created_at DESC`);
    const rows = result.rows as Record<string, unknown>[];

    // Load custom field definitions
    let customFieldDefs: Array<{ name: string; type: string }> = [];
    try {
      const cfRes = await client.execute(
        "SELECT value FROM settings WHERE key = 'custom_fields'",
      );
      if (cfRes.rows.length > 0 && cfRes.rows[0]) {
        customFieldDefs = JSON.parse(String(cfRes.rows[0].value));
      }
    } catch {
      /* custom fields not configured */
    }

    const counts = { total: 0, open: 0, active: 0, pending: 0, complete: 0, overdue: 0 };

    const tasks = rows.map((row) => {
      const task = toTaskViewItem(row, timezone);
      counts.total++;
      if (task.is_done) counts.complete++;
      else if (task.deferred_at === null) {
        counts.open++;
        if (task.status === "active") counts.active++;
        else counts.pending++;
      }
      if (task.is_overdue) counts.overdue++;
      return task;
    });

    return { tasks, counts, customFieldDefs };
  } catch (error) {
    if (requireAvailable) throw error
    return emptyResult;
  }
}

function toTaskViewItem(row: Record<string, unknown>, timezone = "Europe/Dublin"): TaskViewItem {
  const status = String(row.status ?? "pending");
  const priority = Number(row.priority ?? 3);
  const isDone = status === "complete";
  const dueDate = row.due_date ? String(row.due_date) : null;
  const fp = frameworkPayloadObject(safeParseJson(row.framework_payload, {}))
  const riceInputs = readRiceInputs(fp)
  const rice = riceInputs ? riceLensScore(riceInputs) : null
  const deferredAt = row.deferred_at == null ? null : Number(row.deferred_at)
  const overdue = deferredAt === null && isOverdue(dueDate, isDone, timezone);

  return {
    id: String(row.id),
    title: String(row.title),
    description: row.description ? String(row.description) : null,
    status,
    priority,
    due_date: dueDate,
    labels: safeParseLabels(row.labels),
    rice,
    calendar_sync_state: row.calendar_sync_state ? String(row.calendar_sync_state) : null,
    area_id: String(row.area_id ?? "default"),
    project_id: row.project_id == null ? null : String(row.project_id),
    custom_fields: safeParseJson<Record<string, unknown>>(row.custom_fields, {}),
    start_date: row.start_date ? String(row.start_date) : null,
    end_date: row.end_date ? String(row.end_date) : null,
    progress: Number(row.progress ?? 0),
    color: row.color ? String(row.color) : null,
    is_favorite: Boolean(row.is_favorite),
    task_type: String(row.task_type ?? "task"),
    task_kind: row.task_kind ? String(row.task_kind) : null,
    parent_id: row.parent_id ? String(row.parent_id) : null,
    ticket_number: row.ticket_number ? Number(row.ticket_number) : null,
    assigned_to: row.assigned_to ? String(row.assigned_to) : null,
    checklists: row.checklists ? String(row.checklists) : null,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    deferred_at: deferredAt,
    is_overdue: overdue,
    is_done: isDone,
    framework_payload: fp,
    urgency: Number(row.urgency ?? 0),
    importance: Number(row.importance ?? 0),
    eisenhower_quadrant: deriveEisenhowerQuadrant(Number(row.urgency ?? 0), Number(row.importance ?? 0)),
    eisenhower_override: Boolean(row.eisenhower_override),
    effort_minutes: row.effort_minutes != null ? Number(row.effort_minutes) : null,
    effort_type: row.effort_type ? String(row.effort_type) : null,
    blocked_by: row.blocked_by ? String(row.blocked_by) : null,
  };
}

const TODAY_COMPLETION_COUNT = `
  COUNT(*) FILTER (
    WHERE status = 'complete'
      AND ((updated_at >= ? AND updated_at < ?) OR substr(updated_at, 1, 10) = ?)
  )
`

function todayCompletionArgs(today: string): [number, number, string] {
  const dayStart = Date.parse(today)
  return [dayStart, dayStart + 86_400_000, today]
}

export function todayDueSection(
  dueDate: string,
  today: string,
  timezoneOrLocalDayStart?: string | Date,
): "due" | "carried" | null {
  const timezone = typeof timezoneOrLocalDayStart === "string" ? timezoneOrLocalDayStart : "Europe/Dublin"
  const dueDay = calendarDayFromInput(dueDate, timezone)
  if (!dueDay) return null
  if (dueDay < today) return "carried"
  return dueDay === today ? "due" : null
}

export function todayCompletionPercent(completed: number, remaining: number): number {
  return Math.round((completed / Math.max(1, completed + remaining)) * 100)
}

export interface TodayTaskCounts {
  dueToday: number
  completedToday: number
  carriedForward: number
  remaining: number
  completionPercent: number
}

/** Count the complete queue and read its renderable rows from one SQLite snapshot.
 * Keep nonempty framework data eligible so the existing JavaScript RICE calculation
 * can handle imported values.
 */
export async function getTodayTaskRows(
  today: string,
  includeUnscheduled: boolean,
  timezone = "Europe/Dublin",
) {
  try {
    await ensureSchema()
    const { rows } = await getPersistenceClient().execute({
      sql: `
        WITH totals AS (
          SELECT ${TODAY_COMPLETION_COUNT} AS completed_today,
                 COUNT(*) FILTER (
                   WHERE status IS NOT 'complete' AND deferred_at IS NULL AND (due_date IS NULL OR due_date = '')
                 ) AS open_unscheduled
          FROM tasks
        )
        SELECT ${TASK_VIEW_COLUMNS}, completed_today, open_unscheduled
        FROM totals
        LEFT JOIN tasks
          ON status IS NOT 'complete'
          AND deferred_at IS NULL
          AND (
            ? = 1
            OR (due_date IS NOT NULL AND due_date <> '')
            OR is_favorite NOT IN (0, '')
            OR framework_payload NOT IN ('{}', '')
          )
        ORDER BY created_at DESC, tasks.rowid DESC
      `,
      args: [...todayCompletionArgs(today), includeUnscheduled ? 1 : 0],
    })

    return {
      completedTodayCount: Number(rows[0]?.completed_today ?? 0),
      openUnscheduledCount: Number(rows[0]?.open_unscheduled ?? 0),
      tasks: rows.filter(row => row.id !== null).map(row => toTaskViewItem(row, timezone)),
    }
  } catch {
    return { completedTodayCount: 0, openUnscheduledCount: 0, tasks: [] }
  }
}

/** Refresh the visible counters without reading or serializing individual tasks. */
export async function getTodayTaskCounts(now = new Date(), timezone = "Europe/Dublin"): Promise<TodayTaskCounts> {
  const today = calendarToday(timezone, now)

  await ensureSchema()
  const { rows } = await getPersistenceClient().execute({
    sql: `
      SELECT NULL AS due_date, ${TODAY_COMPLETION_COUNT} AS completed_today,
             COUNT(*) FILTER (WHERE status IS NOT 'complete' AND deferred_at IS NULL AND is_favorite NOT IN (0, '')) AS pinned_count,
             0 AS dated_count
      FROM tasks
      UNION ALL
      SELECT due_date, 0, 0, COUNT(*)
      FROM tasks
      WHERE status IS NOT 'complete' AND deferred_at IS NULL AND COALESCE(is_favorite, 0) IN (0, '')
        AND due_date IS NOT NULL AND due_date <> ''
      GROUP BY due_date
    `,
    args: todayCompletionArgs(today),
  })

  let dueToday = 0
  let carriedForward = 0
  let completedToday = 0
  let pinned = 0
  for (const row of rows) {
    if (row.due_date === null) {
      completedToday = Number(row.completed_today)
      pinned = Number(row.pinned_count)
      continue
    }

    const section = todayDueSection(String(row.due_date), today, timezone)
    if (section === "due") dueToday += Number(row.dated_count)
    if (section === "carried") carriedForward += Number(row.dated_count)
  }

  const remaining = dueToday + carriedForward + pinned
  return {
    dueToday, completedToday, carriedForward, remaining,
    completionPercent: todayCompletionPercent(completedToday, remaining),
  }
}
