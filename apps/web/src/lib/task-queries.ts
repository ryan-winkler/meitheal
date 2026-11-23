import { projectPublicTaskFields } from "@domains/tasks"
import { tagTodayRead } from "../../scripts/database-client.mjs"
import type { BoardScope } from "../domains/tasks/board-scope"
import { boardOperationClient } from "../domains/tasks/persistence/board-operation-client"
import { scopedTaskRead, taskReadPlacement, type TaskReadPlacement } from "../domains/tasks/persistence/board-work-query"
import { sourceSql } from "../domains/tasks/persistence/sql-fragment"
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
import type { InValue, Row } from "@libsql/client";
import { deriveEisenhowerQuadrant } from "@meitheal/domain-tasks";
import { boardCustomFieldsSettingKey, normalizeCustomFieldDefs } from "./custom-field-defs"
import { parseCalendarDay } from "./calendar-day"
import { calendarDayFromInput, calendarToday, householdDayRanges, isDueOverdue, isValidTimezone, resolveTimezone, shiftCalendarDay } from "./date"
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
  area_id: string | null;
  project_id: string | null
  custom_fields: Record<string, unknown>;
  start_date: string | null;
  end_date: string | null;
  progress: number;
  table_position?: number | null;
  color: string | null;
  is_promoted: boolean;
  task_type: string;
  task_kind: string | null;
  parent_id: string | null;
  ticket_number: number | null;
  ticket_key: string | null;
  assigned_to: string | null;
  checklists: string | null;
  checklist_total?: number | undefined;
  checklist_done?: number | undefined;
  created_at: string;
  updated_at: string;
  task_version?: number;
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
  timezone?: string | undefined;
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

/** Date-only due dates are overdue after their household day; timed ones once their time passes. */
function isDueDayOverdue(dueDate: string | null, today: string, timezone = "Europe/Dublin"): boolean {
  if (!dueDate) return false;
  return isDueOverdue(dueDate, timezone, today);
}

function isOverdue(dueDate: string | null, isDone: boolean, timezone: string, now: Date): boolean {
  if (isDone) return false;
  return isDueOverdue(dueDate, timezone, calendarToday(timezone, now), now.getTime())
}

// =============================================================================
// Main Query
// =============================================================================

const TASK_VIEW_COLUMNS = `
  id, title, description, status, priority, due_date, labels,
  framework_payload, calendar_sync_state, area_id, project_id, public_area_id, public_project_id, public_goal_id, custom_fields,
  start_date, end_date, progress, table_position, color, is_promoted, task_type, task_kind,
  parent_id, public_parent_id, ticket_number, ticket_ref AS ticket_key, assigned_to, checklists, created_at, updated_at, ${taskTimestampMs("updated_at")} AS task_version, deferred_at,
  urgency, importance, eisenhower_override,
  effort_minutes, effort_type, blocked_by
`;

/**
 * Load tasks with computed fields for any task view page.
 * Supports optional SQL pushdown predicates and `slim: true` checklist scalar projection
 * while preserving global unfiltered header badge counts.
 */
export async function getTasksForView(options: TaskViewOptions = {}, scope: BoardScope): Promise<TaskViewResult> {
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
    timezone = "Europe/Dublin",
  } = options;
  const emptyResult: TaskViewResult = {
    tasks: [],
    counts: { total: 0, open: 0, active: 0, pending: 0, complete: 0, overdue: 0 },
    customFieldDefs: [],
  };

  try {
    await ensureSchema();
    const client = boardOperationClient(getPersistenceClient(), scope, { resource: "task", action: "read" });

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
        framework_payload, calendar_sync_state, area_id, project_id, public_area_id, public_project_id, public_goal_id, custom_fields,
        start_date, end_date, progress, table_position, color, is_promoted, task_type, task_kind,
        parent_id, public_parent_id, ticket_number, ticket_ref AS ticket_key, assigned_to,
        NULL AS checklists,
        CASE WHEN json_valid(checklists) THEN json_array_length(checklists) ELSE 0 END AS checklist_total,
        (SELECT COUNT(*) FROM json_each(CASE WHEN json_valid(tasks.checklists) THEN tasks.checklists ELSE '[]' END) WHERE json_extract(value, '$.done') = 1) AS checklist_done,
        created_at, updated_at, ${taskTimestampMs("updated_at")} AS task_version, deferred_at,
        urgency, importance, eisenhower_override,
        effort_minutes, effort_type, blocked_by
      `;
    } else if (previewChars !== null) {
      selectArgs.push(previewChars);
      columnsSql = `
        id, title,
        CASE WHEN description IS NOT NULL THEN substr(description, 1, ?) ELSE NULL END AS description,
        status, priority, due_date, labels,
        framework_payload, calendar_sync_state, area_id, project_id, public_area_id, public_project_id, public_goal_id, custom_fields,
        start_date, end_date, progress, table_position, color, is_promoted, task_type, task_kind,
        parent_id, public_parent_id, ticket_number, ticket_ref AS ticket_key, assigned_to, checklists, created_at, updated_at, ${taskTimestampMs("updated_at")} AS task_version, deferred_at,
        urgency, importance, eisenhower_override,
        effort_minutes, effort_type, blocked_by
      `;
    }

    const whereClauses = ["1"];
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
      whereClauses.push("public_area_id = ?");
      selectArgs.push(areaId);
    }
    if (typeof projectId === "string" && projectId.length > 0) {
      whereClauses.push("project_id = ?");
      selectArgs.push(projectId);
    }

    const hasPushdownFilter =
      whereClauses.length > 1 || (typeof limit === "number" && Number.isFinite(limit) && limit > 0);
    const whereSql = ` WHERE ${whereClauses.join(" AND ")}`;
    let limitSql = "";
    if (typeof limit === "number" && Number.isFinite(limit) && limit > 0) {
      limitSql = " LIMIT ?";
      selectArgs.push(Math.floor(limit));
    }

    const taskQuery = scopedTaskRead(scope, sourceSql(`SELECT ${columnsSql} FROM scoped_tasks AS tasks${whereSql} ORDER BY created_at DESC, id ASC${limitSql}`, selectArgs));
    const counts = { total: 0, open: 0, active: 0, pending: 0, complete: 0, overdue: 0 };
    const useGlobalCounts = slim || hasPushdownFilter;
    let rows: Record<string, unknown>[];

    // Complete the optional read before admitting the task results.
    let customFieldDefs: Array<{ name: string; type: string }> = [];
    try {
      const cfKey = boardCustomFieldsSettingKey(scope.boardId);
      const { rows: [fields] } = await client.execute({
        sql: "SELECT value FROM settings WHERE key = ?",
        args: [cfKey],
      });
      if (fields) customFieldDefs = normalizeCustomFieldDefs(fields.value);
    } catch {
      /* custom fields not configured */
    }

    if (useGlobalCounts) {
      const resolvedToday = calendarToday(timezone);
      const upperBound = shiftCalendarDay(resolvedToday, 2);
      // The returned rows and unfiltered counts share a scoped read snapshot.
      const [tasksRes, countRes, overdueRes] = await client.batch([
        taskQuery,
        scopedTaskRead(scope, sourceSql(`
            SELECT COUNT(*) AS total,
                   COUNT(*) FILTER (WHERE status = 'complete') AS complete,
                   COUNT(*) FILTER (WHERE status != 'complete' AND deferred_at IS NULL) AS open,
                   COUNT(*) FILTER (WHERE status = 'active' AND deferred_at IS NULL) AS active,
                   COUNT(*) FILTER (WHERE status != 'complete' AND status != 'active' AND deferred_at IS NULL) AS pending
            FROM scoped_tasks AS tasks WHERE 1
          `, []), "select", "minimal"),
        scopedTaskRead(scope, sourceSql(`
            SELECT due_date
            FROM scoped_tasks AS tasks
            WHERE 1 AND status != 'complete'
              AND deferred_at IS NULL
              AND due_date IS NOT NULL
              AND due_date != ''
              AND substr(due_date, 1, 10) < ?
          `, [upperBound]), "select", "minimal"),
      ], "read");
      rows = tasksRes!.rows as Record<string, unknown>[];
      const cr = (countRes!.rows[0] ?? {}) as Record<string, unknown>;
      counts.total = Number(cr.total ?? 0);
      counts.complete = Number(cr.complete ?? 0);
      counts.open = Number(cr.open ?? 0);
      counts.active = Number(cr.active ?? 0);
      counts.pending = Number(cr.pending ?? 0);
      counts.overdue = overdueRes!.rows.filter((row) =>
        isDueDayOverdue(String(row.due_date ?? ""), resolvedToday, timezone),
      ).length;

    } else {
      rows = (await client.execute(taskQuery)).rows as Record<string, unknown>[];
    }

    const tasks = rows.map((row) => toTaskViewItem(row, slim, timezone));
    if (!useGlobalCounts) {
      for (const task of tasks) {
        counts.total++;
        if (task.is_done) counts.complete++;
        else if (task.deferred_at === null) {
          counts.open++;
          if (task.status === "active") counts.active++;
          else counts.pending++;
        }
        if (task.is_overdue) counts.overdue++;
      }
    }

    return { tasks, counts, customFieldDefs };
  } catch (error) {
    if (requireAvailable) throw error
    return emptyResult;
  }
}

function toTaskViewItem(row: Record<string, unknown>, slim = false, timezone = "Europe/Dublin", now = new Date()): TaskViewItem {
  const status = String(row.status ?? "pending");
  const priority = Number(row.priority ?? 3);
  const isDone = status === "complete";
  const dueDate = row.due_date ? String(row.due_date) : null;
  const fp = frameworkPayloadObject(safeParseJson(row.framework_payload, {}))
  const riceInputs = readRiceInputs(fp)
  const rice = riceInputs ? riceLensScore(riceInputs) : null
  const deferredAt = row.deferred_at == null ? null : Number(row.deferred_at)
  const overdue = deferredAt === null && isOverdue(dueDate, isDone, timezone, now)

  const publicTask = projectPublicTaskFields(row)
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
    area_id: typeof publicTask.area_id === "string" ? publicTask.area_id : null,
    project_id: publicTask.project_id == null ? null : String(publicTask.project_id),
    custom_fields: safeParseJson<Record<string, unknown>>(row.custom_fields, {}),
    start_date: row.start_date ? String(row.start_date) : null,
    end_date: row.end_date ? String(row.end_date) : null,
    progress: Number(row.progress ?? 0),
    table_position: row.table_position == null ? null : Number(row.table_position),
    color: row.color ? String(row.color) : null,
    is_promoted: Boolean(row.is_promoted),
    task_type: String(row.task_type ?? "task"),
    task_kind: row.task_kind ? String(row.task_kind) : null,
    parent_id: typeof publicTask.parent_id === "string" ? publicTask.parent_id : null,
    ticket_key: typeof row.ticket_key === "string" ? row.ticket_key : null,
    ticket_number: row.ticket_number ? Number(row.ticket_number) : null,
    assigned_to: row.assigned_to ? String(row.assigned_to) : null,
    checklists: slim ? null : (row.checklists ? String(row.checklists) : null),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    task_version: Number(row.task_version),
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

function completedTodayQuery(scope: BoardScope, filter: ReturnType<typeof todayCompletionFilter>, placement?: TaskReadPlacement) {
  const context = taskReadPlacement(placement)
  const query = scopedTaskRead(scope, sourceSql(`SELECT id, title, ticket_ref AS ticket_key FROM scoped_tasks AS tasks WHERE ${filter.sql} AND ${context.sql}
          ORDER BY CASE WHEN typeof(updated_at) = 'text' AND updated_at NOT LIKE '%T%' AND updated_at NOT LIKE '%:%'
            THEN ? ELSE ${taskTimestampMs("updated_at")} END DESC, rowid DESC
          LIMIT 20`, [...filter.args, ...context.args, filter.firstInstant]))
  return tagTodayRead(query, "completed")
}

function completedTodaySummaries(rows: Row[]) {
  return rows.map(row => ({ id: String(row.id), title: String(row.title), ticket_key: row.ticket_key == null ? null : String(row.ticket_key) }))
}

export function todayScopeProblem(params: URLSearchParams, timezone: string, day: string) {
  const expectedDay = params.get("expected_day")
  const expectedTimezone = params.get("expected_timezone")
  if (expectedDay !== null && !parseCalendarDay(expectedDay)) {
    return { status: 400, error: "expected_day must be a calendar date" }
  }
  if (expectedTimezone !== null && !isValidTimezone(expectedTimezone)) {
    return { status: 400, error: "expected_timezone must be a valid timezone" }
  }
  if (expectedDay !== null && expectedDay !== day || expectedTimezone !== null && expectedTimezone !== timezone) {
    return { status: 409, error: "Today has changed. Refresh the view." }
  }
  return null
}

type TodayCompletionFilter = {
  readonly sql: string
  readonly args: readonly (number | string)[]
  readonly firstInstant: number | null
}

let lastCompletionFilter: { day: string; timezone: string; filter: TodayCompletionFilter } | undefined

export function todayCompletionFilter(today: string, timezone = "Europe/Dublin"): TodayCompletionFilter {
  const resolvedTimezone = resolveTimezone(timezone)
  if (lastCompletionFilter?.day === today && lastCompletionFilter.timezone === resolvedTimezone) {
    return lastCompletionFilter.filter
  }
  const ranges = householdDayRanges(today, resolvedTimezone)
  const matchesDay = (column: string) =>
    ranges.map(() => `(${column} >= ? AND ${column} < ?)`).join(" OR ") || "0"
  const bounds = ranges.flat()
  const filter: TodayCompletionFilter = {
    sql: `1 AND status = 'complete'
      AND (
        (typeof(updated_at) IN ('integer', 'real') AND (${matchesDay("updated_at")}))
        OR (typeof(updated_at) = 'text' AND (
          ((updated_at LIKE '%T%' OR updated_at LIKE '%:%') AND strftime('%s', updated_at) IS NOT NULL
            AND (${matchesDay("CAST(strftime('%s', updated_at) AS INTEGER) * 1000")}))
          OR updated_at = ?
        ))
      )`,
    args: [...bounds, ...bounds, today],
    firstInstant: ranges[0]?.[0] ?? null,
  }
  lastCompletionFilter = { day: today, timezone: resolvedTimezone, filter }
  return filter
}

export function todayDueSection(
  dueDate: string,
  today: string,
  timezone = "Europe/Dublin",
): "due" | "carried" | null {
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
  completedTasks?: Array<{ id: string; title: string; ticket_key: string | null }>
}

/** Count the complete queue and read its renderable rows from one SQLite snapshot.
 * Keep nonempty framework data eligible so the existing JavaScript RICE calculation
 * can handle imported values.
 */
export async function getTodayTaskRows(
  today: string,
  includeUnscheduled: boolean,
  timezone = "Europe/Dublin",
  now = new Date(),
  scope: BoardScope,
  placement?: TaskReadPlacement,
) {
  await ensureSchema()
  const resolvedTimezone = resolveTimezone(timezone)
  const client = boardOperationClient(getPersistenceClient(), scope, { resource: "task", action: "read" })
  const context = taskReadPlacement(placement)
  const completionFilter = todayCompletionFilter(today, resolvedTimezone)
  const tasksQuery = {
    sql: `
      totals AS (
        SELECT COUNT(*) FILTER (WHERE ${completionFilter.sql}) AS completed_today,
               COUNT(*) FILTER (
                 WHERE status IS NOT 'complete' AND status IS NOT 'archived' AND deferred_at IS NULL AND (due_date IS NULL OR due_date = '')
               ) AS open_unscheduled
        FROM scoped_tasks AS tasks WHERE ${context.sql}
      )
      SELECT ${TASK_VIEW_COLUMNS}, completed_today, open_unscheduled
      FROM totals
      LEFT JOIN scoped_tasks AS tasks
        ON ${context.sql} AND status IS NOT 'complete' AND status IS NOT 'archived'
        AND deferred_at IS NULL
        AND (
          ? = 1
          OR (due_date IS NOT NULL AND due_date <> '')
          OR is_promoted NOT IN (0, '')
          OR framework_payload NOT IN ('{}', '')
        )
      ORDER BY created_at DESC, tasks.rowid DESC
    `,
    args: [...completionFilter.args, ...context.args, ...context.args, includeUnscheduled ? 1 : 0],
  }
  const overview = tagTodayRead(scopedTaskRead(scope, sourceSql(tasksQuery.sql, tasksQuery.args), "with"), "rows")
  const [taskResult, completed] = await client.batch([overview, completedTodayQuery(scope, completionFilter, placement)], "read")
  const rows = taskResult?.rows ?? []

  return {
    completedTasks: completedTodaySummaries(completed?.rows ?? []),
    completedTodayCount: Number(rows[0]?.completed_today ?? 0),
    openUnscheduledCount: Number(rows[0]?.open_unscheduled ?? 0),
    tasks: rows.filter(row => row.id !== null).map(row => toTaskViewItem(row as Record<string, unknown>, false, resolvedTimezone, now)),
  }
}

export async function readStoredHouseholdTimezone(): Promise<string> {
  try {
    const res = await getPersistenceClient().execute({
      sql: "SELECT value FROM settings WHERE key = 'timezone' LIMIT 1",
      args: [],
    })
    let raw: unknown = res.rows[0]?.value
    if (typeof raw === "string") {
      try {
        raw = JSON.parse(raw)
      } catch {
        /* legacy plain-text setting */
      }
      if (typeof raw === "string") return resolveTimezone(raw)
    }
  } catch {
    /* ignore missing or unreadable setting */
  }
  return "Europe/Dublin"
}

/** Refresh visible counters, with the bounded completed list when requested. */
export async function getTodayTaskCounts(now = new Date(), timezone: string | undefined, includeCompleted = false, scope: BoardScope, placement?: TaskReadPlacement): Promise<TodayTaskCounts> {
  await ensureSchema()
  const trimmedTz = typeof timezone === "string" ? timezone.trim() : ""
  const resolvedTimezone = trimmedTz && isValidTimezone(trimmedTz)
    ? trimmedTz
    : await readStoredHouseholdTimezone()
  const today = calendarToday(resolvedTimezone, now)
  const client = boardOperationClient(getPersistenceClient(), scope, { resource: "task", action: "read" })
  const completionFilter = todayCompletionFilter(today, resolvedTimezone)
  const context = taskReadPlacement(placement)
  const countsQuery = {
    sql: `
      SELECT NULL AS due_date, COUNT(*) FILTER (WHERE ${completionFilter.sql}) AS completed_today,
             COUNT(*) FILTER (WHERE status IS NOT 'complete' AND status IS NOT 'archived' AND deferred_at IS NULL AND is_promoted NOT IN (0, '')) AS pinned_count,
             0 AS dated_count
      FROM scoped_tasks AS tasks WHERE ${context.sql}
      UNION ALL
      SELECT due_date, 0, 0, COUNT(*)
      FROM scoped_tasks AS tasks
      WHERE ${context.sql} AND status IS NOT 'complete' AND status IS NOT 'archived' AND deferred_at IS NULL AND COALESCE(is_promoted, 0) IN (0, '')
        AND due_date IS NOT NULL AND due_date <> ''
      GROUP BY due_date
    `,
    args: [...completionFilter.args, ...context.args, ...context.args],
  }
  const [countResult, completed] = includeCompleted
    ? await client.batch([scopedTaskRead(scope, sourceSql(countsQuery.sql, countsQuery.args)), completedTodayQuery(scope, completionFilter, placement)], "read")
    : [await client.execute(scopedTaskRead(scope, sourceSql(countsQuery.sql, countsQuery.args)))]
  const rows = countResult?.rows ?? []

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

    const section = todayDueSection(String(row.due_date), today, resolvedTimezone)
    if (section === "due") dueToday += Number(row.dated_count)
    if (section === "carried") carriedForward += Number(row.dated_count)
  }

  const remaining = dueToday + carriedForward + pinned
  return {
    dueToday, completedToday, carriedForward, remaining,
    completionPercent: todayCompletionPercent(completedToday, remaining),
    ...(includeCompleted ? {
      completedTasks: completedTodaySummaries(completed?.rows ?? []),
    } : {}),
  }
}
