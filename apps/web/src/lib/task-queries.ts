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
  custom_fields: Record<string, unknown>;
  start_date: string | null;
  end_date: string | null;
  progress: number;
  color: string | null;
  is_favorite: boolean;
  task_type: string;
  parent_id: string | null;
  ticket_number: number | null;
  assigned_to: string | null;
  checklists: string | null;
  created_at: string;
  updated_at: string;
  is_overdue: boolean;
  is_done: boolean;
  framework_payload: Record<string, unknown>;
  urgency: number;
  importance: number;
  eisenhower_quadrant: string;
  eisenhower_override: boolean;
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
// RICE Calculation
// =============================================================================

function calculateRice(fp: Record<string, unknown>): number | null {
  const reach = Number(fp.reach);
  const impact = Number(fp.impact);
  const confidence = Number(fp.confidence);
  const effort = Number(fp.effort);

  if (!reach || !impact || !confidence || !effort) return null;

  return Math.round((reach * impact * confidence) / effort);
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

const TASK_VIEW_SQL = `
  SELECT id, title, description, status, priority, due_date, labels,
         framework_payload, calendar_sync_state, area_id, custom_fields,
         start_date, end_date, progress, color, is_favorite, task_type,
         parent_id, ticket_number, assigned_to, checklists, created_at, updated_at,
         urgency, importance, eisenhower_override
  FROM tasks
  ORDER BY created_at DESC
`;

/**
 * Load all tasks with computed fields for any task view page.
 * Returns structured task items with RICE scores, overdue flags, and counts.
 */
export async function getTasksForView(): Promise<TaskViewResult> {
  const emptyResult: TaskViewResult = {
    tasks: [],
    counts: { total: 0, open: 0, active: 0, pending: 0, complete: 0, overdue: 0 },
    customFieldDefs: [],
  };

  try {
    await ensureSchema();
    const client = getPersistenceClient();
    const result = await client.execute(TASK_VIEW_SQL);
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

    const tasks: TaskViewItem[] = rows.map((row) => {
      const status = String(row.status ?? "pending");
      const priority = Number(row.priority ?? 3);
      const isDone = status === "complete";
      const dueDate = row.due_date ? String(row.due_date) : null;
      const fp = safeParseJson<Record<string, unknown>>(row.framework_payload, {});
      const rice = calculateRice(fp);
      const overdue = isOverdue(dueDate, isDone);

      // Count
      counts.total++;
      if (isDone) counts.complete++;
      else {
        counts.open++;
        if (status === "active") counts.active++;
        else counts.pending++;
      }
      if (overdue) counts.overdue++;

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
        custom_fields: safeParseJson<Record<string, unknown>>(row.custom_fields, {}),
        start_date: row.start_date ? String(row.start_date) : null,
        end_date: row.end_date ? String(row.end_date) : null,
        progress: Number(row.progress ?? 0),
        color: row.color ? String(row.color) : null,
        is_favorite: Boolean(row.is_favorite),
        task_type: String(row.task_type ?? "task"),
        parent_id: row.parent_id ? String(row.parent_id) : null,
        ticket_number: row.ticket_number ? Number(row.ticket_number) : null,
        assigned_to: row.assigned_to ? String(row.assigned_to) : null,
        checklists: row.checklists ? String(row.checklists) : null,
        created_at: String(row.created_at),
        updated_at: String(row.updated_at),
        is_overdue: overdue,
        is_done: isDone,
        framework_payload: fp,
        urgency: Number(row.urgency ?? 0),
        importance: Number(row.importance ?? 0),
        eisenhower_quadrant: deriveEisenhowerQuadrant(Number(row.urgency ?? 0), Number(row.importance ?? 0)),
        eisenhower_override: Boolean(row.eisenhower_override),
      };
    });

    return { tasks, counts, customFieldDefs };
  } catch {
    return emptyResult;
  }
}
