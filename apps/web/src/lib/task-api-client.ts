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

// ── Types ──────────────────────────────────────────────────────────────────

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
  is_favorite?: number
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
  area_id?: string
  project_id?: string | null
  task_type?: string
  assigned_to?: string | null
  [key: string]: unknown
}

/** Reorder payload for POST /api/tasks/reorder */
export interface ReorderPayload {
  taskId: string
  status: string
  position: number
}

/** Lane definition from GET /api/lanes */
export interface LanePayload {
  id: string
  key: string
  label: string
  icon: string
  position: number
  wip_limit: number
  includes: string[]
  built_in: boolean
}

/** Area definition from GET /api/areas */
export interface AreaPayload {
  id: string
  name: string
  icon?: string
  color?: string
  position?: number
  [key: string]: unknown
}

/** Goal definition from GET /api/goals */
export interface GoalPayload {
  id: string
  title: string
  area_id?: string | null
  description?: string | null
  status: string
  target_date?: string | null
  [key: string]: unknown
}

/** Project definition from GET /api/projects */
export interface ProjectPayload {
  id: string
  title: string
  goal_id?: string | null
  description?: string | null
  status: string
  icon?: string
  color?: string
  position?: number
  [key: string]: unknown
}

/** Task link payload for POST /api/tasks/:id/links */
export interface TaskLinkPayload {
  target_task_id: string
  link_type: string
}

/** Comment payload for POST /api/tasks/:id/comments */
export interface TaskCommentPayload {
  body: string
}

// ── Helpers ────────────────────────────────────────────────────────────────

/** Standard JSON headers for POST/PATCH/PUT. */
const JSON_HEADERS: HeadersInit = {
  "Content-Type": "application/json",
}

/**
 * Parse a JSON response, throwing on non-ok status.
 * Returns undefined for 204 No Content.
 */
async function parseResponse<T>(res: Response): Promise<T | undefined> {
  if (res.status === 204) return undefined
  if (!res.ok) {
    const body = await res.text().catch(() => "")
    throw new Error(`API ${res.status}: ${body || res.statusText}`)
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
  // ── Tasks CRUD ────────────────────────────────────────────────────

  /** GET /api/tasks — list all tasks */
  async listTasks(params?: Record<string, string>): Promise<any[]> {
    const qs = params ? `?${new URLSearchParams(params).toString()}` : ""
    const res = await safeFetch(`/api/tasks${qs}`)
    return (await parseResponse<any[]>(res)) ?? []
  },

  /** GET /api/tasks?q=&limit= — search tasks */
  async searchTasks(query: string, limit = 50): Promise<any[]> {
    const qs = new URLSearchParams({ q: query, limit: String(limit) })
    const res = await safeFetch(`/api/tasks?${qs.toString()}`)
    return (await parseResponse<any[]>(res)) ?? []
  },

  /** GET /api/tasks/:id — single task */
  async getTask(id: string): Promise<any> {
    const res = await safeFetch(`/api/tasks/${enc(id)}`)
    return parseResponse<any>(res)
  },

  /** POST /api/tasks — create a task */
  async createTask(payload: TaskCreatePayload): Promise<any> {
    const res = await safeFetch("/api/tasks", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(payload),
    })
    return parseResponse<any>(res)
  },

  /** POST /api/tasks/create — alternative create endpoint */
  async createTaskAlt(payload: TaskCreatePayload): Promise<any> {
    const res = await safeFetch("/api/tasks/create", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(payload),
    })
    return parseResponse<any>(res)
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
    await safeFetch(`/api/tasks/${enc(id)}`, {
      method: "DELETE",
    })
  },

  /** POST /api/tasks/:id/duplicate — clone a task */
  async duplicateTask(id: string): Promise<any> {
    const res = await safeFetch(`/api/tasks/${enc(id)}/duplicate`, {
      method: "POST",
    })
    return parseResponse<any>(res)
  },

  /** POST /api/tasks/reorder — reorder kanban tasks */
  async reorderTasks(payload: ReorderPayload[]): Promise<any> {
    const res = await safeFetch("/api/tasks/reorder", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(payload),
    })
    return parseResponse<any>(res)
  },

  // ── Task Activity ────────────────────────────────────────────────

  /** GET /api/tasks/:id/activity — task activity log */
  async getTaskActivity(id: string): Promise<any[]> {
    const res = await safeFetch(`/api/tasks/${enc(id)}/activity`)
    return (await parseResponse<any[]>(res)) ?? []
  },

  // ── Task Comments ────────────────────────────────────────────────

  /** GET /api/tasks/:id/comments — list comments */
  async getTaskComments(id: string): Promise<any[]> {
    const res = await safeFetch(`/api/tasks/${enc(id)}/comments`)
    return (await parseResponse<any[]>(res)) ?? []
  },

  /** POST /api/tasks/:id/comments — add a comment */
  async addTaskComment(id: string, payload: TaskCommentPayload): Promise<any> {
    const res = await safeFetch(`/api/tasks/${enc(id)}/comments`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(payload),
    })
    return parseResponse<any>(res)
  },

  // ── Task Links ───────────────────────────────────────────────────

  /** GET /api/tasks/:id/links — list task links */
  async getTaskLinks(id: string): Promise<any[]> {
    const res = await safeFetch(`/api/tasks/${enc(id)}/links`)
    return (await parseResponse<any[]>(res)) ?? []
  },

  /** POST /api/tasks/:id/links — create a task link */
  async addTaskLink(id: string, payload: TaskLinkPayload): Promise<any> {
    const res = await safeFetch(`/api/tasks/${enc(id)}/links`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(payload),
    })
    return parseResponse<any>(res)
  },

  /** DELETE /api/tasks/:id/links?link_id= — remove a task link */
  async deleteTaskLink(id: string, linkId: string): Promise<void> {
    await safeFetch(
      `/api/tasks/${enc(id)}/links?link_id=${enc(linkId)}`,
      { method: "DELETE" },
    )
  },

  // ── Settings ──────────────────────────────────────────────────────

  /** GET /api/settings — fetch all settings */
  async getSettings(): Promise<Record<string, any>> {
    const res = await safeFetch("/api/settings")
    return (await parseResponse<Record<string, any>>(res)) ?? {}
  },

  /** PUT /api/settings — save settings */
  async saveSettings(payload: Record<string, unknown>): Promise<any> {
    const res = await safeFetch("/api/settings", {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify(payload),
    })
    return parseResponse<any>(res)
  },

  // ── Areas ────────────────────────────────────────────────────────

  /** GET /api/areas — list all areas */
  async listAreas(): Promise<AreaPayload[]> {
    const res = await safeFetch("/api/areas")
    return (await parseResponse<AreaPayload[]>(res)) ?? []
  },

  /** POST /api/areas — create an area */
  async createArea(payload: Partial<AreaPayload>): Promise<any> {
    const res = await safeFetch("/api/areas", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(payload),
    })
    return parseResponse<any>(res)
  },

  // ── Goals ────────────────────────────────────────────────────────

  /** GET /api/goals — list all goals */
  async listGoals(params?: Record<string, string>): Promise<GoalPayload[]> {
    const qs = params ? `?${new URLSearchParams(params).toString()}` : ""
    const res = await safeFetch(`/api/goals${qs}`)
    const data = await parseResponse<{ goals: GoalPayload[] }>(res)
    return data?.goals ?? []
  },

  /** POST /api/goals — create a goal */
  async createGoal(payload: Partial<GoalPayload>): Promise<any> {
    const res = await safeFetch("/api/goals", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(payload),
    })
    return parseResponse<any>(res)
  },

  /** PUT /api/goals/:id — update a goal */
  async updateGoal(id: string, payload: Partial<GoalPayload>): Promise<any> {
    const res = await safeFetch(`/api/goals/${enc(id)}`, {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify(payload),
    })
    return parseResponse<any>(res)
  },

  /** DELETE /api/goals/:id — delete a goal */
  async deleteGoal(id: string): Promise<void> {
    await safeFetch(`/api/goals/${enc(id)}`, { method: "DELETE" })
  },

  // ── Projects ─────────────────────────────────────────────────────

  /** GET /api/projects — list all projects */
  async listProjects(params?: Record<string, string>): Promise<ProjectPayload[]> {
    const qs = params ? `?${new URLSearchParams(params).toString()}` : ""
    const res = await safeFetch(`/api/projects${qs}`)
    const data = await parseResponse<{ projects: ProjectPayload[] }>(res)
    return data?.projects ?? []
  },

  /** POST /api/projects — create a project */
  async createProject(payload: Partial<ProjectPayload>): Promise<any> {
    const res = await safeFetch("/api/projects", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(payload),
    })
    return parseResponse<any>(res)
  },

  /** PUT /api/projects/:id — update a project */
  async updateProject(id: string, payload: Partial<ProjectPayload>): Promise<any> {
    const res = await safeFetch(`/api/projects/${enc(id)}`, {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify(payload),
    })
    return parseResponse<any>(res)
  },

  /** DELETE /api/projects/:id — delete a project */
  async deleteProject(id: string): Promise<void> {
    await safeFetch(`/api/projects/${enc(id)}`, { method: "DELETE" })
  },

  // ── Lanes ─────────────────────────────────────────────────────────

  /** GET /api/lanes — fetch kanban lanes */
  async getLanes(): Promise<LanePayload[]> {
    const res = await safeFetch("/api/lanes")
    return (await parseResponse<LanePayload[]>(res)) ?? []
  },

  /** PUT /api/lanes/:id — update a lane */
  async updateLane(id: string, payload: Partial<LanePayload>): Promise<any> {
    const res = await safeFetch(`/api/lanes/${enc(id)}`, {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify(payload),
    })
    return parseResponse<any>(res)
  },

  /** DELETE /api/lanes/:id — delete a lane */
  async deleteLane(id: string): Promise<void> {
    await safeFetch(`/api/lanes/${enc(id)}`, {
      method: "DELETE",
    })
  },

  /** POST /api/lanes — create a lane */
  async createLane(payload: Partial<LanePayload>): Promise<any> {
    const res = await safeFetch("/api/lanes", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(payload),
    })
    return parseResponse<any>(res)
  },

  // ── Users ─────────────────────────────────────────────────────────

  /** GET /api/users — list users */
  async listUsers(): Promise<any[]> {
    const res = await safeFetch("/api/users")
    return (await parseResponse<any[]>(res)) ?? []
  },

  // ── Todo Sync ─────────────────────────────────────────────────────

  /** GET /api/todo — list HA to-do entities */
  async listTodoEntities(): Promise<any[]> {
    const res = await safeFetch("/api/todo")
    return (await parseResponse<any[]>(res)) ?? []
  },

  /** POST /api/todo/sync — trigger todo sync */
  async syncTodo(payload: Record<string, unknown>): Promise<any> {
    const res = await safeFetch("/api/todo/sync", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(payload),
    })
    return parseResponse<any>(res)
  },

  // ── Export ────────────────────────────────────────────────────────

  /** GET /api/export/tasks.csv — export tasks as CSV (returns raw Response) */
  async exportTasks(): Promise<Response> {
    return safeFetch("/api/export/tasks.csv")
  },

  // ── Raw fetch (escape hatch) ──────────────────────────────────────

  /**
   * Raw safeFetch for endpoints not covered above.
   * Pass bare paths like "/api/integrations/calendar" — ingress
   * prefixing is handled by Layout.astro's fetch monkey-patch.
   */
  async raw(path: string, options?: SafeFetchOptions): Promise<Response> {
    return safeFetch(path, options)
  },
} as const
