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
import { taskTimestampMs } from "@domains/tasks/persistence/task-timestamp";
import type { InValue } from "@libsql/client";
import { deriveEisenhowerQuadrant } from "@meitheal/domain-tasks";
import { frameworkPayloadObject, readRiceInputs, riceLensScore } from "./rice-lens"

// =============================================================================
// Types
// =============================================================================

export interface TaskViewItem {
  id: string;
  title: string;
  description: string | null;
  has_description?: boolean | undefined;
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
  checklist_total?: number | undefined;
  checklist_done?: number | undefined;
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

export interface TaskViewOptions {
  requireAvailable?: boolean | undefined;
  statuses?: string[] | undefined;
  excludeStatuses?: string[] | undefined;
  includeDeferred?: boolean | undefined;
  excludeCompletedBeforeMs?: number | undefined;
  areaId?: string | undefined;
  projectId?: string | undefined;
  slim?: boolean | undefined;
  descriptionPreviewChars?: number | undefined;
  limit?: number | undefined;
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

function isOverdue(dueDate: string | null, isDone: boolean): boolean {
  if (!dueDate || isDone) return false;
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const due = new Date(dueDate);
  due.setHours(0, 0, 0, 0);
  return due < now;
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

function localTodayIso(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Load tasks with computed fields for any task view page.
 * Supports optional SQL pushdown predicates and `slim: true` checklist scalar projection
 * while preserving global unfiltered header badge counts.
 */
export async function getTasksForView(options: TaskViewOptions = {}): Promise<TaskViewResult> {
  const {
    requireAvailable = false,
    statuses,
    excludeStatuses,
    includeDeferred,
    excludeCompletedBeforeMs,
    areaId,
    projectId,
    slim = false,
    descriptionPreviewChars,
    limit,
  } = options;

  const emptyResult: TaskViewResult = {
    tasks: [],
    counts: { total: 0, open: 0, active: 0, pending: 0, complete: 0, overdue: 0 },
    customFieldDefs: [],
  };

  try {
    await ensureSchema();
    const client = getPersistenceClient();

    const selectArgs: InValue[] = [];
    const previewChars =
      typeof descriptionPreviewChars === "number" &&
      Number.isInteger(descriptionPreviewChars) &&
      descriptionPreviewChars > 0
        ? descriptionPreviewChars
        : null;

    let columnsSql = TASK_VIEW_COLUMNS;
    if (slim) {
      const descriptionExpr = previewChars !== null
        ? "CASE WHEN description IS NOT NULL THEN substr(description, 1, ?) ELSE NULL END AS description"
        : "description";
      if (previewChars !== null) selectArgs.push(previewChars);
      columnsSql = `
        id, title, ${descriptionExpr},
        CASE WHEN description IS NOT NULL AND length(trim(description)) > 0 THEN 1 ELSE 0 END AS has_description,
        status, priority, due_date, labels,
        framework_payload, calendar_sync_state, area_id, project_id, custom_fields,
        start_date, end_date, progress, color, is_favorite, task_type, task_kind,
        parent_id, ticket_number, assigned_to,
        NULL AS checklists,
        CASE WHEN json_valid(checklists) THEN json_array_length(checklists) ELSE 0 END AS checklist_total,
        (SELECT COUNT(*) FROM json_each(CASE WHEN json_valid(tasks.checklists) THEN tasks.checklists ELSE '[]' END) WHERE json_extract(value, '$.done') = 1) AS checklist_done,
        created_at, updated_at, deferred_at,
        urgency, importance, eisenhower_override,
        effort_minutes, effort_type, blocked_by
      `;
    } else if (previewChars !== null) {
      selectArgs.push(previewChars);
      columnsSql = `
        id, title,
        CASE WHEN description IS NOT NULL THEN substr(description, 1, ?) ELSE NULL END AS description,
        status, priority, due_date, labels,
        framework_payload, calendar_sync_state, area_id, project_id, custom_fields,
        start_date, end_date, progress, color, is_favorite, task_type, task_kind,
        parent_id, ticket_number, assigned_to, checklists, created_at, updated_at, deferred_at,
        urgency, importance, eisenhower_override,
        effort_minutes, effort_type, blocked_by
      `;
    }

    const whereClauses: string[] = [];
    if (Array.isArray(statuses) && statuses.length > 0) {
      whereClauses.push(`status IN (${statuses.map(() => "?").join(", ")})`);
      selectArgs.push(...statuses);
    }
    if (Array.isArray(excludeStatuses) && excludeStatuses.length > 0) {
      whereClauses.push(`status NOT IN (${excludeStatuses.map(() => "?").join(", ")})`);
      selectArgs.push(...excludeStatuses);
    }
    if (includeDeferred === false) {
      whereClauses.push("deferred_at IS NULL");
    }
    if (typeof excludeCompletedBeforeMs === "number" && Number.isFinite(excludeCompletedBeforeMs)) {
      whereClauses.push(`(status != 'complete' OR ${taskTimestampMs("updated_at")} >= ?)`);
      selectArgs.push(excludeCompletedBeforeMs);
    }
    if (typeof areaId === "string" && areaId.length > 0) {
      whereClauses.push("area_id = ?");
      selectArgs.push(areaId);
    }
    if (typeof projectId === "string" && projectId.length > 0) {
      whereClauses.push("project_id = ?");
      selectArgs.push(projectId);
    }

    const hasPushdownFilter =
      whereClauses.length > 0 || (typeof limit === "number" && Number.isFinite(limit) && limit > 0);
    const whereSql = whereClauses.length > 0 ? ` WHERE ${whereClauses.join(" AND ")}` : "";
    let limitSql = "";
    if (typeof limit === "number" && Number.isFinite(limit) && limit > 0) {
      limitSql = " LIMIT ?";
      selectArgs.push(Math.floor(limit));
    }

    const result = await client.execute({
      sql: `SELECT ${columnsSql} FROM tasks${whereSql} ORDER BY created_at DESC${limitSql}`,
      args: selectArgs,
    });
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

    if (slim || hasPushdownFilter) {
      const todayIso = localTodayIso();
      const countRes = await client.execute({
        sql: `
          SELECT COUNT(*) AS total,
                 COUNT(*) FILTER (WHERE status = 'complete') AS complete,
                 COUNT(*) FILTER (WHERE status != 'complete' AND deferred_at IS NULL) AS open,
                 COUNT(*) FILTER (WHERE status = 'active' AND deferred_at IS NULL) AS active,
                 COUNT(*) FILTER (WHERE status != 'complete' AND status != 'active' AND deferred_at IS NULL) AS pending,
                 COUNT(*) FILTER (
                   WHERE status != 'complete'
                     AND deferred_at IS NULL
                     AND due_date IS NOT NULL
                     AND due_date != ''
                     AND substr(due_date, 1, 10) < ?
                 ) AS overdue
          FROM tasks
        `,
        args: [todayIso],
      });
      const cr = (countRes.rows[0] ?? {}) as Record<string, unknown>;
      counts.total = Number(cr.total ?? 0);
      counts.complete = Number(cr.complete ?? 0);
      counts.open = Number(cr.open ?? 0);
      counts.active = Number(cr.active ?? 0);
      counts.pending = Number(cr.pending ?? 0);
      counts.overdue = Number(cr.overdue ?? 0);

      const tasks = rows.map((row) => toTaskViewItem(row, slim));
      return { tasks, counts, customFieldDefs };
    }

    const tasks = rows.map((row) => {
      const task = toTaskViewItem(row, false);
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

function toTaskViewItem(row: Record<string, unknown>, slim = false): TaskViewItem {
  const status = String(row.status ?? "pending");
  const priority = Number(row.priority ?? 3);
  const isDone = status === "complete";
  const dueDate = row.due_date ? String(row.due_date) : null;
  const fp = frameworkPayloadObject(safeParseJson(row.framework_payload, {}))
  const riceInputs = readRiceInputs(fp)
  const rice = riceInputs ? riceLensScore(riceInputs) : null
  const deferredAt = row.deferred_at == null ? null : Number(row.deferred_at)
  const overdue = deferredAt === null && isOverdue(dueDate, isDone);

  const item: TaskViewItem = {
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
    checklists: slim ? null : (row.checklists ? String(row.checklists) : null),
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

  if (slim) {
    item.has_description = Boolean(Number(row.has_description ?? 0));
    item.checklist_total = Number(row.checklist_total ?? 0);
    item.checklist_done = Number(row.checklist_done ?? 0);
  }

  return item;
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

export function todayDueSection(dueDate: string, today: string, localDayStart: Date) {
  const due = new Date(dueDate)
  due.setHours(0, 0, 0, 0)
  if (due < localDayStart) return "carried"
  return dueDate === today ? "due" : null
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
export async function getTodayTaskRows(today: string, includeUnscheduled: boolean) {
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
      tasks: rows.filter(row => row.id !== null).map(row => toTaskViewItem(row as Record<string, unknown>, false)),
    }
  } catch {
    return { completedTodayCount: 0, openUnscheduledCount: 0, tasks: [] }
  }
}

/** Refresh the visible counters without reading or serializing individual tasks. */
export async function getTodayTaskCounts(now = new Date()): Promise<TodayTaskCounts> {
  const today = now.toISOString().slice(0, 10)
  const localDayStart = new Date(now)
  localDayStart.setHours(0, 0, 0, 0)

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

    const section = todayDueSection(String(row.due_date), today, localDayStart)
    if (section === "due") dueToday += Number(row.dated_count)
    if (section === "carried") carriedForward += Number(row.dated_count)
  }

  const remaining = dueToday + carriedForward + pinned
  return {
    dueToday, completedToday, carriedForward, remaining,
    completionPercent: todayCompletionPercent(completedToday, remaining),
  }
}
