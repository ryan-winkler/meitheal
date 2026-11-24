/**
 * TaskApiClient — typed client-side API wrapper for task operations.
 * @domain Task Management (client-side)
 *
 * Centralizes all client-side fetch() calls that hit /api/* endpoints.
 * Wraps safeFetch for timeout + flood protection.
 *
 * Ingress prefixing is handled by Layout.astro's global fetch monkey-patch.
 * Do NOT manually prefix paths with __ingress_path here — that causes
 * double-prefixing. All paths should be bare (e.g. "/api/tasks").
 *
 * Usage (in <script> blocks or client-side TS):
 *   import { taskApi } from '@lib/task-api-client';
 *   await taskApi.updateTask(id, { status: 'complete' });
 *   const tasks = await taskApi.listTasks();
 *
 * @see safe-fetch.ts for the underlying fetch wrapper
 * @see Layout.astro lines 70-141 for the ingress fetch monkey-patch
 */

import { safeFetch, type SafeFetchOptions } from "./safe-fetch"
import { currentTaskApiContext, taskApiHeaders, type TaskApiContext } from "./task-api"

/** Canonical task versions are normalized milliseconds, including retained ISO rows. */
export function taskRecordVersion(task: Record<string, unknown>): number | null {
  const value = Object.hasOwn(task, "task_version") ? task.task_version : task.updated_at
  const number = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value)
    : typeof value === "string" && /(?:Z|[+-]\d\d:\d\d)$/.test(value) ? Date.parse(value) : NaN
  return Number.isSafeInteger(number) && number >= 0 ? number : null
}

export function sameTaskApiContext(a: TaskApiContext | null, b: TaskApiContext | null): boolean {
  return Boolean(a && b && a.boardId === b.boardId && a.session === b.session && a.actorKey === b.actorKey)
}

export type VersionedTaskSave = { ok: true; task: Record<string, unknown>; version: number }
  | { ok: false; status: number; errorCode: "conflict" | "unavailable" | "unconfirmed" | "hierarchy_invalid" | "hierarchy_conflict"; message?: string }

/** Existing browser writes retain their loaded version and original actor/Board through publication. */
export async function saveVersionedTask(id: string, fields: Record<string, unknown>, version: number | null,
  context = currentTaskApiContext(), signal?: AbortSignal): Promise<VersionedTaskSave> {
  if (version === null || !Number.isSafeInteger(version) || version < 0 || !sameTaskApiContext(context, currentTaskApiContext())) {
    return { ok: false, status: 0, errorCode: "unavailable" }
  }
  let status = 0
  try {
    const response = await safeFetch(`/api/tasks/${encodeURIComponent(id)}`, {
      method: "PUT", headers: taskApiHeaders(context!, { "content-type": "application/json" }),
      body: JSON.stringify({ ...fields, updated_at: version }), ...(signal ? { signal } : {}),
    })
    status = response.status
    if (!sameTaskApiContext(context, currentTaskApiContext()) || signal?.aborted) return { ok: false, status, errorCode: "unavailable" }
    if (!response.ok) {
      const payload = await response.json().catch(() => null) as Record<string, unknown> | null
      const serverCode = typeof payload?.errorCode === "string" ? payload.errorCode : ""
      const message = typeof payload?.error === "string" ? payload.error : typeof payload?.detail === "string" ? payload.detail : undefined
      if (status === 409 && serverCode === "hierarchy_conflict") {
        return { ok: false, status, errorCode: "hierarchy_conflict", ...(message ? { message } : {}) }
      }
      if (status === 400 && serverCode === "hierarchy_invalid") {
        return { ok: false, status, errorCode: "hierarchy_invalid", ...(message ? { message } : {}) }
      }
      return { ok: false, status, errorCode: status === 409 ? "conflict" : "unavailable" }
    }
    const task: unknown = await response.json()
    if (!sameTaskApiContext(context, currentTaskApiContext()) || signal?.aborted) return { ok: false, status, errorCode: "unavailable" }
    if (!task || typeof task !== "object" || Array.isArray(task) || !("id" in task) || task.id !== id) return { ok: false, status, errorCode: "unconfirmed" }
    const saved = task as Record<string, unknown>
    const nextVersion = taskRecordVersion(saved)
    return nextVersion === null ? { ok: false, status, errorCode: "unconfirmed" } : { ok: true, task: saved, version: nextVersion }
  } catch {
    return { ok: false, status, errorCode: "unconfirmed" }
  }
}

/** Browser deletion uses the same loaded-version and original-context preconditions as edits. */
export async function deleteVersionedTask(id: string, version: number | null,
  context = currentTaskApiContext(), signal?: AbortSignal): Promise<{ ok: true } | Exclude<VersionedTaskSave, { ok: true }>> {
  if (version === null || !Number.isSafeInteger(version) || version < 0 || !sameTaskApiContext(context, currentTaskApiContext())) {
    return { ok: false, status: 0, errorCode: "unavailable" }
  }
  let status = 0
  try {
    const response = await safeFetch(`/api/tasks/${encodeURIComponent(id)}`, {
      method: "DELETE", headers: taskApiHeaders(context!, { "content-type": "application/json" }),
      body: JSON.stringify({ version }), ...(signal ? { signal } : {}),
    })
    status = response.status
    if (!sameTaskApiContext(context, currentTaskApiContext()) || signal?.aborted) return { ok: false, status, errorCode: "unavailable" }
    return response.ok ? { ok: true } : { ok: false, status, errorCode: status === 409 ? "conflict" : "unavailable" }
  } catch {
    return { ok: false, status, errorCode: "unconfirmed" }
  }
}

const pendingStatusWrites = new Set<string>()

export function lockTaskStatusWrite(id: string): (() => void) | null {
  if (pendingStatusWrites.has(id)) return null
  pendingStatusWrites.add(id)
  return () => { pendingStatusWrites.delete(id) }
}

// ── Types ──────────────────────────────────────────────────────────────────

export interface AssigneeDirectory {
  users: Array<{ id: string; name: string; display_name?: string; color?: string; kind?: string }>
  ha_connected?: boolean
  ha_roster_verified?: boolean
}

/** Fields accepted by PATCH /api/tasks/:id */
export interface TaskPatchPayload {
  title?: string
  description?: string
  status?: string
  priority?: number
  due_date?: string | null
  start_date?: string | null
  end_date?: string | null
  labels?: string
  area_id?: string
  color?: string | null
  is_promoted?: boolean
  task_type?: string
  parent_id?: string | null
  assigned_to?: string | null
  kanban_position?: number | null
  progress?: number
  custom_fields?: string
  framework_payload?: string
  recurrence?: string | null
  [key: string]: unknown
}

/** Fields for POST /api/tasks */
export interface TaskCreatePayload {
  title: string
  description?: string
  status?: string
  priority?: number
  due_date?: string | null
  area_id?: string | null
  project_id?: string | null
  task_type?: string
  assigned_to?: string | null
  [key: string]: unknown
}

// ── Helpers ────────────────────────────────────────────────────────────────

/** Standard JSON headers for POST/PATCH/PUT. */
const JSON_HEADERS: HeadersInit = {
  "Content-Type": "application/json",
}

export class TaskApiError extends Error {
  constructor(readonly status: number, detail: string) {
    super(`API ${status}: ${detail}`)
  }
}

/**
 * Parse a JSON response, throwing on non-ok status.
 * Returns undefined for 204 No Content.
 */
async function parseResponse<T>(res: Response): Promise<T | undefined> {
  if (res.status === 204) return undefined
  if (!res.ok) {
    const body = await res.text().catch(() => "")
    throw new TaskApiError(res.status, body || res.statusText)
  }
  return res.json() as Promise<T>
}

/** URL-encode a path segment. */
function enc(id: string): string {
  return encodeURIComponent(id)
}

// ── Client ─────────────────────────────────────────────────────────────────

/**
 * Typed client-side API for task operations.
 * All methods use safeFetch under the hood for timeout + flood protection.
 * Ingress prefixing is handled by Layout.astro's fetch monkey-patch.
 */
export const taskApi = {
  /** GET /api/tasks/:id — single task */
  async getTask(id: string): Promise<any> {
    const res = await safeFetch(`/api/tasks/${enc(id)}`)
    return parseResponse<any>(res)
  },

  /** POST /api/tasks — create a task */
  async createTask(payload: TaskCreatePayload, signal?: AbortSignal, context?: TaskApiContext): Promise<any> {
    if (context && !sameTaskApiContext(context, currentTaskApiContext())) throw new Error("The selected Board changed. Your input is kept.")
    const res = await safeFetch("/api/tasks", {
      method: "POST",
      headers: context ? taskApiHeaders(context, JSON_HEADERS) : JSON_HEADERS,
      body: JSON.stringify(payload),
      ...(signal ? { signal } : {}),
    })
    const task = await parseResponse<any>(res)
    if (context && !sameTaskApiContext(context, currentTaskApiContext())) throw new Error("The save could not be confirmed in the original Board. Your input is kept.")
    return task
  },

  /** PUT /api/tasks/:id — update a task */
  async updateTask(id: string, payload: TaskPatchPayload): Promise<any> {
    const res = await safeFetch(`/api/tasks/${enc(id)}`, {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify(payload),
    })
    return parseResponse<any>(res)
  },

  /** DELETE /api/tasks/:id — delete a task */
  async deleteTask(id: string): Promise<void> {
    const res = await safeFetch(`/api/tasks/${enc(id)}`, {
      method: "DELETE",
    })
    if (res.ok) return
    void res.body?.cancel().catch(() => {})
    throw new Error(`API ${res.status}`)
  },

  /** POST /api/tasks/:id/duplicate — clone a task */
  async duplicateTask(id: string): Promise<any> {
    const res = await safeFetch(`/api/tasks/${enc(id)}/duplicate`, {
      method: "POST",
    })
    return parseResponse<any>(res)
  },

  /** GET /api/users — list users */
  async listUserDirectory(signal?: AbortSignal): Promise<AssigneeDirectory> {
    const res = await safeFetch("/api/users", signal ? { signal } : undefined)
    const data = await parseResponse<AssigneeDirectory>(res)
    if (!Array.isArray(data?.users)) throw new Error("Assignee directory unavailable")
    return data
  },

  /**
   * Raw safeFetch for endpoints not covered above.
   * Pass bare paths like "/api/integrations/calendar" — ingress
   * prefixing is handled by Layout.astro's fetch monkey-patch.
   */
  async raw(path: string, options?: SafeFetchOptions): Promise<Response> {
    return safeFetch(path, options)
  },
} as const
