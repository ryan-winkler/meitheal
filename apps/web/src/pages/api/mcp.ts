import { readFileSync, existsSync } from "node:fs"
import { resolve } from "node:path"
import type { APIRoute } from "astro"
import { parse } from "yaml"
import { hasScope, resolveAgentRouteAccess, type AgentScope } from "@meitheal/domain-auth"
import {
  checkMcpAvailability,
  MCP_LEGACY_VERSION,
  MCP_PROTOCOL_VERSION,
  MCP_SUPPORTED_VERSIONS,
  resolveMcpSchema,
} from "@domains/agents"
import {
  ensureSchema,
  getPersistenceClient,
  hasBoardSelection,
  isBoardTaskApiPath,
  unavailableBoardResponse,
  UserRepository,
} from "@domains/tasks"
import { apiJson, apiError, apiProblem } from "@lib/api-response"
import { readWithinLimit } from "@lib/bounded-body"
import { isClosedStatus, isDoneStatus } from "@lib/status-config"
import type { ResolvedAgent } from "@lib/agent-token-guard"

/**
 * POST /api/mcp — MCP (Model Context Protocol) Server Endpoint
 *
 * Dynamically generates tool definitions from the OpenAPI spec at startup,
 * then routes JSON-RPC 2.0 tool calls to internal API endpoints.
 *
 * Tool catalog is derived from openapi.yaml operationIds — no hardcoded
 * switch/case. Custom tool overrides can be registered for operations
 * that need special argument mapping or response shaping.
 *
 * @see https://modelcontextprotocol.io/
 * @see /openapi.yaml for the source of truth
 * @domain integration-core
 * @bounded-context agent-protocols
 */

// ─── Types ────────────────────────────────────────────────────────────────────

interface McpTool {
  name: string
  description: string
  inputSchema: {
    type: "object"
    properties: Record<string, unknown>
    required?: string[]
  }
}

interface RouteMapping {
  method: string
  path: string
  hasBody: boolean
  pathParams: string[]
  queryParams: string[]
}

type CustomToolHandler = (
  args: Record<string, unknown>,
  requestApi: (path: string, init?: RequestInit) => Promise<Response>,
  agent: ResolvedAgent,
) => Promise<Record<string, unknown>>

// ─── OpenAPI → MCP Tool Discovery ────────────────────────────────────────────

/** Operations to exclude from MCP tools (internal/system endpoints) */
const EXCLUDED_OPS = new Set([
  "reviewTaskProposal", "acceptTaskProposal", // Human-only proposal decisions
  "createRule", "replaceRules", "updateRule", "deleteRule", "restoreRuleDefaults",
  "createFramework", "updateFramework", "deleteFramework", // Human administrator settings mutations
  "useLabelCleanup",
  "updateLabel", "deleteLabel", // Shared vocabulary requires a current administrator, never an agent token
  "taskInactivity",
  "mcpEndpoint",       // Self-reference
  "getA2AAgentCard", "sendA2AMessage", "getA2ATask", // Separate A2A protocol boundary
  "healthPing",        // HEAD-only liveness
  "subscribeSSE",      // SSE streaming, not callable
  "exportDatabase",    // Large binary download
  "exportSettings",    // File downloads
  "importSettings",    // File upload
  "setTaskDeferral",   // Requires the exact current workflow and deferral versions
  "readTaskPins", "verifyTaskPinContext", "setTaskPin", // Verified Home Assistant browser only
  "findCommentPeople", "useMentionInbox",
  "readTaskDraft", "verifyTaskDraftContext", "writeTaskDraft",
])

/** Operations where method names should be used as-is (no camelCase conversion) */
const FRIENDLY_NAMES: Record<string, string> = {
  searchMeitheal: "searchTasks",
  getHealth: "getSystemHealth",
}

let _toolCache: McpTool[] | null = null
let _routeCache: Map<string, RouteMapping> | null = null
let _cacheTime = 0

/** In dev, invalidate cache every 30s so hot-reloaded specs are picked up */
const CACHE_TTL_MS = process.env.NODE_ENV === "development" ? 30_000 : Infinity

function loadOpenAPISpec(): { tools: McpTool[], routes: Map<string, RouteMapping> } {
  const now = Date.now()
  if (_toolCache && _routeCache && (now - _cacheTime) < CACHE_TTL_MS) {
    return { tools: _toolCache, routes: _routeCache }
  }

  const tools: McpTool[] = []
  const routes = new Map<string, RouteMapping>()

  // Try multiple paths (Docker, dev, relative)
  const specPaths = [
    resolve(process.cwd(), "public/openapi.yaml"),
    resolve(process.cwd(), "dist/client/openapi.yaml"),
    "./public/openapi.yaml",
  ]

  let specContent: string | null = null
  for (const p of specPaths) {
    try {
      if (existsSync(p)) {
        specContent = readFileSync(p, "utf-8")
        break
      }
    } catch { /* try next */ }
  }

  if (!specContent) {
    console.warn("[MCP] OpenAPI spec not found — tools will be empty")
    _toolCache = tools
    _routeCache = routes
    return { tools, routes }
  }

  const spec = parse(specContent) as {
    paths?: Record<string, Record<string, {
      operationId?: string
      summary?: string
      description?: string
      parameters?: Array<{
        name: string
        in: string
        required?: boolean
        description?: string
        schema?: Record<string, unknown>
      }>
      requestBody?: {
        required?: boolean
        content?: Record<string, { schema?: Record<string, unknown> }>
      }
    }>>
  }

  if (!spec.paths) {
    _toolCache = tools
    _routeCache = routes
    return { tools, routes }
  }

  for (const [path, methods] of Object.entries(spec.paths)) {
    if (path === "/api/feedback" || path.startsWith("/api/feedback/")) continue
    for (const [method, op] of Object.entries(methods)) {
      if (!op.operationId || EXCLUDED_OPS.has(op.operationId)) continue

      const toolName = FRIENDLY_NAMES[op.operationId] ?? op.operationId
      const properties: Record<string, unknown> = {}
      const required: string[] = []
      const pathParams: string[] = []
      const queryParams: string[] = []

      // Extract path and query parameters
      if (op.parameters) {
        for (const param of op.parameters) {
          if (param.in === "header") continue // Skip headers
          const paramSchema = resolveMcpSchema(param.schema ?? { type: "string" }, spec)
          properties[param.name] = {
            ...paramSchema,
            description: param.description ?? `${param.name} parameter`,
          }
          if (param.required) required.push(param.name)
          if (param.in === "path") pathParams.push(param.name)
          if (param.in === "query") queryParams.push(param.name)
        }
      }

      // Extract request body properties
      const hasBody = method === "post" || method === "put" || method === "patch"
      if (hasBody && op.requestBody?.content?.["application/json"]?.schema) {
        const bodySchema = resolveMcpSchema(op.requestBody.content["application/json"].schema, spec)
        if (bodySchema.properties) {
          for (const [propName, propSchema] of Object.entries(bodySchema.properties as Record<string, Record<string, unknown>>)) {
            properties[propName] = propSchema
          }
          if (bodySchema.required && Array.isArray(bodySchema.required)) {
            for (const r of bodySchema.required) {
              if (!required.includes(r as string)) required.push(r as string)
            }
          }
        }
      }

      if (toolName === "searchTasks") {
        properties.scope = { type: "string", enum: ["tasks"], default: "tasks" }
        properties.query = { type: "string", description: "Search text (alias for q)." }
        properties.status = {
          type: "string",
          description: "Filter by status (backlog, pending, active, complete, todo, in_progress, done).",
        }
      }

      tools.push({
        name: toolName,
        description: toolName === "searchTasks"
          ? getCustomToolDescription(toolName)
          : (op.description ?? op.summary ?? `${method.toUpperCase()} ${path}`),
        inputSchema: {
          type: "object",
          properties,
          ...(required.length > 0 ? { required } : {}),
        },
      })

      routes.set(toolName, {
        method: method.toUpperCase(),
        path,
        hasBody,
        pathParams,
        queryParams,
      })
    }
  }

  _toolCache = tools
  _routeCache = routes
  _cacheTime = Date.now()
  console.log(`[MCP] Loaded ${tools.length} tools from OpenAPI spec`)
  return { tools, routes }
}

function scopedApi(authorization: string) {
  const port = process.env.PORT ?? (import.meta.env.DEV ? "4321" : "3000")
  const origin = `http://127.0.0.1:${port}`
  return async (path: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(path, origin)
    if (url.origin !== origin || !url.pathname.startsWith("/api/")) throw new Error("Invalid tool route")

    const response = await fetch(url, {
      ...init,
      headers: { "content-type": "application/json", authorization, "x-automation-source": "mcp" },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) {
      // Pass on the API's own reason so the agent can correct the call.
      const errBody = (await response.json().catch(() => null)) as Record<string, unknown> | null
      const detail = typeof errBody?.detail === "string" ? errBody.detail
        : typeof errBody?.error === "string" ? errBody.error : null
      throw new Error(detail ? `Tool request failed with HTTP ${response.status}: ${detail.slice(0, 300)}` : `Tool request failed with HTTP ${response.status}`)
    }
    return response
  }
}

// ─── Custom Tool Overrides ────────────────────────────────────────────────────
// Some tools need special response shaping or multi-step logic.

const customHandlers = new Map<string, CustomToolHandler>()

// completeTask: supports both ID and title-based completion
customHandlers.set("completeTask", async (args, requestApi, agent) => {
  const id = typeof args.id === "string" ? args.id.trim() : args.id != null ? String(args.id).trim() : ""
  if (id) {
    const safeId = encodeURIComponent(id)
    const res = await requestApi(`/api/tasks/${safeId}`, {
      method: "PUT",
      body: JSON.stringify({ status: "complete" }),
    })
    return acknowledgedCompletion(res, id)
  }
  const title = typeof args.title === "string" ? args.title.trim() : args.title != null ? String(args.title).trim() : ""
  if (title) {
    const searchParams = new URLSearchParams({ q: title, scope: "tasks", task_fields: "title", limit: "12" })
    if (agent?.scopes.includes("tasks:write:assigned") && !agent.scopes.includes("tasks:write") && agent.assigneeId) {
      searchParams.set("assigned_to", agent.assigneeId)
    }
    const searchRes = await requestApi(`/api/search?${searchParams}`)
    const data = (await checkedJson(searchRes)) as {
      sections?: Array<{ id?: string, items?: Array<Record<string, unknown>> }>
    }
    const taskSection = data.sections?.find((s) => s.id === "tasks")
    const matches = (taskSection?.items ?? []).filter(
      (t) => String(t.title ?? "").trim().toLowerCase() === title.toLowerCase(),
    )
    if (matches.length > 1) {
      return { error: "Multiple tasks have that title; provide a task ID" }
    }
    if (matches.length === 1) {
      const taskId = matches[0]!.taskId ?? matches[0]!.id
      const response = await requestApi(`/api/tasks/${encodeURIComponent(String(taskId))}`, {
        method: "PUT",
        body: JSON.stringify({ status: "complete" }),
      })
      return acknowledgedCompletion(response, String(taskId))
    }
    return { status: "not_found", title }
  }
  return { status: "error", message: "Provide id or title" }
})

// searchTasks: reshape search response for cleaner AI consumption
customHandlers.set("searchTasks", async (args, requestApi) => {
  const params = new URLSearchParams()
  const query = args.q != null ? args.q : args.query
  if (query != null) params.set("q", String(query))
  for (const key of ["status", "priority", "assigned_to", "limit", "sort", "task_fields"]) {
    if (args[key] != null) params.set(key, String(args[key]))
  }
  const includeCompleted = args.include_completed === true ||
    (args.include_completed == null && typeof args.status === "string" && isDoneStatus(args.status.trim()))
  if (includeCompleted) params.set("include_completed", "1")
  if (args.include_archived === true) params.set("include_archived", "1")
  params.set("scope", "tasks")
  const res = await requestApi(`/api/search?${params}`)
  const data = (await checkedJson(res)) as {
    sections?: Array<{ id?: string, items?: Array<Record<string, unknown>> }>
  }
  const taskSection = data.sections?.find((s) => s.id === "tasks")
  return {
    tasks: (taskSection?.items ?? []).map((item) => ({
      id: item.taskId ?? item.id,
      title: item.title,
      description: item.description,
      status: (item.meta as Record<string, unknown> | undefined)?.status,
      priority: (item.meta as Record<string, unknown> | undefined)?.priority,
    })),
    count: taskSection?.items?.length ?? 0,
  }
})

// ─── Agent identity tools ─────────────────────────────────────────────────────
// The assignee always comes from the credential, never from an argument, so an
// agent cannot read or answer as another assignee by passing a different ID.

const NO_ASSIGNEE = "This token is not linked to an agent assignee. Ask a Home Assistant administrator to choose one in Settings, Agent tokens."

async function agentAssignee(agent: ResolvedAgent): Promise<{ id: string, name: string } | null> {
  if (!agent.assigneeId) return null
  await ensureSchema()
  const assignee = await new UserRepository(getPersistenceClient()).getCustomUser(agent.assigneeId)
  return assignee?.kind === "agent" ? { id: assignee.id, name: assignee.name } : null
}

function taskSummary(task: Record<string, unknown>): Record<string, unknown> {
  return {
    id: task.id,
    ticket_key: task.ticket_key ?? null,
    title: task.title,
    description: task.description ?? "",
    status: task.status,
    priority: task.priority,
    due_date: task.due_date ?? null,
    labels: task.labels,
    parent_id: task.parent_id ?? null,
    updated_at: task.updated_at,
  }
}

customHandlers.set("whoAmI", async (_args, _requestApi, agent) => {
  const assignee = await agentAssignee(agent)
  return {
    token_name: agent.tokenName,
    scopes: agent.scopes,
    assignee,
    can_change: hasScope(agent.scopes, "tasks:write") ? "any_task"
      : hasScope(agent.scopes, "tasks:write:assigned") ? "assigned_tasks" : "nothing",
    ...(assignee ? {} : { note: NO_ASSIGNEE }),
  }
})

customHandlers.set("listMyTasks", async (args, requestApi, agent) => {
  const assignee = await agentAssignee(agent)
  if (!assignee) return { error: NO_ASSIGNEE }
  const includeCompleted = args.include_completed === true
  const limit = Math.min(200, Math.max(1, Math.round(Number(args.limit)) || 50))
  const wanted = typeof args.status === "string" && args.status.trim() ? args.status.trim() : null

  const tasks: Record<string, unknown>[] = []
  let total = 0
  // Completed tasks are filtered here, so page until the limit is met.
  for (let offset = 0; tasks.length < limit; offset += 200) {
    const params = new URLSearchParams({ assigned_to: assignee.id, limit: "200", offset: String(offset), sort: "updated_at" })
    if (wanted) params.set("status", wanted)
    const page = await checkedJson(await requestApi(`/api/tasks?${params}`))
    const rows = Array.isArray(page.tasks) ? page.tasks.filter(isRecord) : []
    total = Number(page.total ?? rows.length)
    for (const row of rows) {
      // An explicit status filter is the caller's own choice of what to see.
      if (!wanted && !includeCompleted && isClosedStatus(String(row.status ?? ""))) continue
      if (tasks.length < limit) tasks.push(taskSummary(row))
    }
    if (rows.length < 200 || offset + rows.length >= total) break
  }
  return { assignee, assignee_id: assignee.id, tasks, count: tasks.length }
})

customHandlers.set("handBackTask", async (args, requestApi, agent) => {
  const assignee = await agentAssignee(agent)
  if (!assignee) return { error: NO_ASSIGNEE }
  if (typeof args.id !== "string" || !args.id.trim()) return { error: "Provide the task id" }
  if (args.note !== undefined && (typeof args.note !== "string" || !args.note.trim() || args.note.length > 10000)) {
    return { error: "note must be 1 to 10000 characters" }
  }
  if (args.to !== undefined && args.to !== null && (typeof args.to !== "string" || !/^(ha|custom)_[\w-]{1,128}$/.test(args.to))) {
    return { error: "to must be an assignee ID from the task history, or omitted" }
  }
  const task = await checkedJson(await requestApi(`/api/tasks/${encodeURIComponent(args.id.trim())}`))
  // Later calls use the stored ID: the history is keyed by it, not by the ticket key.
  const path = `/api/tasks/${encodeURIComponent(String(task.id))}`
  if (task.assigned_to !== assignee.id) return { error: "This task is not assigned to you", assigned_to: task.assigned_to ?? null }

  let to = typeof args.to === "string" ? args.to : null
  if (args.to === undefined) {
    // Default to whoever held the task before it was given to this agent.
    const history = await checkedJson(await requestApi(`${path}/activity?limit=200`))
    const handoff = (Array.isArray(history.activity) ? history.activity.filter(isRecord) : [])
      .find(entry => entry.field === "assigned_to" && entry.new_value === assignee.id)
    const previous = typeof handoff?.old_value === "string" ? handoff.old_value : ""
    if (/^(ha|custom)_[\w-]{1,128}$/.test(previous) && previous !== assignee.id) to = previous
    // A task created for the agent has no earlier holder, so it goes to the household's default assignee.
    if (!to) {
      const fallback = await new UserRepository(getPersistenceClient()).getDefaultAssigneeSetting()
      if (fallback && fallback !== assignee.id) to = fallback
    }
  }
  if (typeof args.to === "string" && args.to !== assignee.id) {
    // A named person must be real: someone this task has been assigned to, or a custom assignee.
    const users = new UserRepository(getPersistenceClient())
    const history = await checkedJson(await requestApi(`${path}/activity?limit=200`))
    const known = (Array.isArray(history.activity) ? history.activity.filter(isRecord) : [])
      .some(entry => entry.field === "assigned_to" && (entry.old_value === args.to || entry.new_value === args.to))
    if (!known && args.to !== await users.getDefaultAssigneeSetting() && !await users.getCustomUser(args.to)) {
      return { error: "to must be an assignee ID from the task history, or omitted" }
    }
  }
  if (to === assignee.id) return { error: "Choose someone else to hand the task back to" }

  // The note goes first: once the task is reassigned an assigned-only token can no longer comment on it.
  if (typeof args.note === "string") {
    await checkedJson(await requestApi(`${path}/comments`, { method: "POST", body: JSON.stringify({ content: args.note.trim() }) }))
  }
  const notePosted = typeof args.note === "string"
  let updated: Record<string, unknown>
  try {
    updated = await checkedJson(await requestApi(path, { method: "PUT", body: JSON.stringify({ assigned_to: to }) }))
    if ((updated.assigned_to ?? null) !== to) throw new Error("Task hand back returned an invalid acknowledgement")
  } catch (error) {
    if (!notePosted) throw error
    // The note is already on the task. Say so, or a retry with the same note posts it twice.
    return {
      error: "Your note was posted, but the task could not be reassigned. Call handBackTask again without a note.",
      note_posted: true,
      still_assigned_to: assignee.id,
    }
  }
  return { id: updated.id, ticket_key: updated.ticket_key ?? null, handed_back_to: to, note_posted: notePosted }
})

/** Custom tools are granted by scope. "write" accepts either task write grant. */
const customToolScopes: ReadonlyMap<string, AgentScope | "write" | "read_and_write"> = new Map([
  ["completeTask", "write"],
  ["searchTasks", "search:read"],
  ["whoAmI", "mcp:execute"],
  ["listMyTasks", "tasks:read"],
  ["handBackTask", "read_and_write"],
])

function toolAllowed(toolName: string, route: RouteMapping | undefined, scopes: AgentScope[]): boolean {
  const custom = customToolScopes.get(toolName)
  const canWrite = hasScope(scopes, "tasks:write") || hasScope(scopes, "tasks:write:assigned")
  if (custom === "write") return canWrite
  if (custom === "read_and_write") return hasScope(scopes, "tasks:read") && canWrite
  if (custom) return hasScope(scopes, custom)
  // Each call is authorised again by the API it reaches, including the assigned-task check.
  return Boolean(route && resolveAgentRouteAccess(route.path.replace(/\{[^}]+\}/g, "resource-id"), route.method, scopes).allowed)
}

// ─── Dynamic Tool Executor ────────────────────────────────────────────────────

async function executeTool(
  toolName: string,
  args: Record<string, unknown>,
  authorization: string,
  agent: ResolvedAgent,
): Promise<Record<string, unknown>> {
  const { routes } = loadOpenAPISpec()
  const route = routes.get(toolName)
  const custom = customHandlers.get(toolName)
  if ((custom || (route && isBoardTaskApiPath(route.path))) && hasBoardSelection(args)) {
    return checkedJson(unavailableBoardResponse())
  }
  const requestApi = scopedApi(authorization)
  if (custom) return custom(args, requestApi, agent)

  if (!route) {
    return { error: `Unknown tool: ${toolName}`, available: routes.size }
  }

  // Validate required path params before dispatch
  for (const param of route.pathParams) {
    if (args[param] == null) {
      return { error: `Missing required path parameter: ${param}`, tool: toolName }
    }
  }

  // Build URL with path params
  let url = route.path
  for (const param of route.pathParams) {
    url = url.replace(`{${param}}`, encodeURIComponent(String(args[param])))
  }

  // Add query params
  const qp = new URLSearchParams()
  for (const param of route.queryParams) {
    if (args[param] != null) qp.set(param, String(args[param]))
  }
  const queryString = qp.toString()
  const fullUrl = `${url}${queryString ? `?${queryString}` : ""}`

  // Build body from remaining args (exclude path/query params)
  const bodyKeys = new Set([...route.pathParams, ...route.queryParams])
  const bodyArgs: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(args)) {
    if (!bodyKeys.has(k)) bodyArgs[k] = v
  }

  const fetchOpts: RequestInit = {
    method: route.method,
  }

  if (route.hasBody && Object.keys(bodyArgs).length > 0) {
    fetchOpts.body = JSON.stringify(bodyArgs)
  }

  // Return the operation's own body: a task's `status` field must stay its workflow status.
  return checkedJson(await requestApi(fullUrl, fetchOpts))
}

async function acknowledgedCompletion(response: Response, expectedId: string): Promise<Record<string, unknown>> {
  const task = await checkedJson(response)
  const exactId = task.id === expectedId
  const exactTicket = /^MTH-\d+$/i.test(expectedId) && typeof task.ticket_key === "string" &&
    task.ticket_key.toUpperCase() === expectedId.toUpperCase()
  if (typeof task.id !== "string" || !task.id || (!exactId && !exactTicket) ||
    typeof task.status !== "string" || !isDoneStatus(task.status)) {
    throw new Error("Task completion returned an invalid acknowledgement")
  }
  return { ...task, status: "completed" }
}

async function checkedJson(response: Response): Promise<Record<string, unknown>> {
  if (!response.ok) throw new Error(`Operation failed (HTTP ${response.status})`)
  if (response.status === 204 || response.status === 205) return { ok: true }
  let data: unknown
  try { data = await response.json() } catch { throw new Error("Operation returned invalid JSON") }
  if (!isRecord(data)) throw new Error("Operation returned an invalid response")
  if (data.ok === false || data.success === false || data.error) throw new Error("Operation was rejected")
  return data
}

// ─── JSON-RPC 2.0 Handler ────────────────────────────────────────────────────

const MAX_REQUEST_BYTES = 1024 * 1024
const VERSION_META = "io.modelcontextprotocol/protocolVersion"
const CAPABILITIES_META = "io.modelcontextprotocol/clientCapabilities"
const CAPABILITIES = { tools: { listChanged: false } }

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function matchesOrigin(request: Request, behindIngress: boolean): boolean {
  const header = request.headers.get("origin")
  if (header === null) return true
  const origin = URL.parse(header)
  if (!origin || origin.origin !== header || !["http:", "https:"].includes(origin.protocol)) return false

  const requestUrl = new URL(request.url)
  if (behindIngress) {
    const forwarded = request.headers.get("x-forwarded-proto")
    const protocol = forwarded === "https" || forwarded === "http" ? `${forwarded}:` : requestUrl.protocol
    return origin.protocol === protocol && origin.host === request.headers.get("host")?.toLowerCase()
  }
  // Do not trust arbitrary Host values for direct traffic. Native clients omit Origin.
  const configured = URL.parse(process.env.SITE_URL ?? "")?.origin
  if (header === configured) return true
  return ["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname) &&
    origin.protocol === requestUrl.protocol && origin.host === request.headers.get("host")?.toLowerCase()
}

function requestName(header: string | null): string | null {
  const encoded = header?.match(/^=\?base64\?([A-Za-z0-9+/]+={0,2})\?=$/)?.[1]
  if (!encoded) return header
  const bytes = Buffer.from(encoded, "base64")
  return bytes.toString("base64") === encoded ? bytes.toString("utf8") : null
}

function mcpJson(data: unknown, status = 200): Response {
  const response = apiJson(data, status)
  response.headers.set("Cache-Control", "no-store")
  return response
}

type RequestId = string | number | null

async function checkMcpTransport(request: Request, locals: App.Locals) {
  const authorization = request.headers.get("authorization")
  const agent = locals.agentToken
  if (!agent || !authorization) {
    return apiProblem({
      status: 401,
      detail: "Use a Meitheal agent token with the mcp:execute scope.",
      extraHeaders: { "WWW-Authenticate": "Bearer" },
    })
  }
  if (!hasScope(agent.scopes, "mcp:execute")) return apiError("MCP requires the mcp:execute scope.", 403)
  if (!matchesOrigin(request, locals.behindIngress)) return apiError("MCP Origin is not allowed.", 403)
  const unavailable = await checkMcpAvailability()
  if (unavailable) return unavailable
  return { agent, authorization }
}

/** Legacy clients may probe for a standalone SSE stream. This endpoint sends JSON replies. */
export const GET: APIRoute = async ({ request, locals }) => {
  const access = await checkMcpTransport(request, locals)
  if (access instanceof Response) return access
  return new Response(null, { status: 405, headers: { Allow: "POST", "Cache-Control": "no-store" } })
}
export const HEAD = GET

export const POST: APIRoute = async ({ request, locals }) => {
  const access = await checkMcpTransport(request, locals)
  if (access instanceof Response) return access
  const { agent, authorization } = access

  const mediaType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase()
  if (mediaType !== "application/json") {
    if (!request.body?.locked) void request.body?.cancel().catch(() => undefined)
    return apiProblem({
      status: 415,
      title: "Unsupported Media Type",
      detail: "Send MCP JSON-RPC requests as application/json.",
      extraHeaders: { "Cache-Control": "no-store" },
    })
  }

  const tooLarge = () => apiProblem({
    status: 413, detail: "MCP requests may be at most 1 MiB.",
    extraHeaders: { "Cache-Control": "no-store", Connection: "close" },
  })
  if (Number(request.headers.get("content-length")) > MAX_REQUEST_BYTES) return tooLarge()
  const rpcError = (id: RequestId, code: number, message: string, status = 200, data?: Record<string, unknown>) =>
    mcpJson({ jsonrpc: "2.0", id, error: { code, message, ...(data ? { data } : {}) } }, status)

  let body: unknown
  try {
    const bytes = await readWithinLimit(request.body, MAX_REQUEST_BYTES, request.signal)
    if (!bytes) return tooLarge()
    body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
  } catch {
    return rpcError(null, -32700, "Parse error", 400)
  }

  if (!isRecord(body)) return rpcError(null, -32600, "Invalid JSON-RPC request", 400)
  const { method, id: reqId = "1", params = {} } = body
  if (typeof reqId !== "string" && typeof reqId !== "number" && reqId !== null) {
    return rpcError(null, -32600, "Invalid JSON-RPC request ID", 400)
  }
  if (!isRecord(params)) return rpcError(reqId, -32602, "Expected a params object", 400)
  const version = request.headers.get("mcp-protocol-version")
  if (version !== null && !MCP_SUPPORTED_VERSIONS.includes(version)) {
    return rpcError(reqId, -32022, "Unsupported protocol version", 400, { requested: version, supported: MCP_SUPPORTED_VERSIONS })
  }

  const meta = isRecord(params._meta) ? params._meta : {}
  const modern = version === MCP_PROTOCOL_VERSION || meta[VERSION_META] !== undefined || method === "server/discover"
  if (modern) {
    if (body.jsonrpc !== "2.0" || !Object.hasOwn(body, "id") || reqId === null || typeof method !== "string") {
      return rpcError(null, -32600, "Invalid JSON-RPC request", 400)
    }
    if (version !== MCP_PROTOCOL_VERSION || meta[VERSION_META] !== version || request.headers.get("mcp-method") !== method) {
      return rpcError(reqId, -32020, "MCP version and method headers must match the request body", 400)
    }
    if (!isRecord(meta[CAPABILITIES_META])) {
      return rpcError(reqId, -32602, "Expected MCP client capabilities", 400)
    }
    if (method === "tools/call" && requestName(request.headers.get("mcp-name")) !== params.name) {
      return rpcError(reqId, -32020, "Mcp-Name must match the requested tool name", 400)
    }
  } else if (!Object.hasOwn(body, "id") && (method === "notifications/initialized" || method === "notifications/cancelled")) {
    return new Response(null, { status: 202, headers: { "Cache-Control": "no-store" } })
  }

  const serverInfo = { name: "meitheal", version: process.env.MEITHEAL_VERSION || "0.0.1" }
  const result = (value: Record<string, unknown>) => mcpJson({
    jsonrpc: "2.0",
    id: reqId,
    result: modern ? {
      ...value,
      resultType: "complete",
      _meta: { "io.modelcontextprotocol/serverInfo": serverInfo },
    } : value,
  })

  try {
    // Initialize handshake
    if (!modern && method === "initialize") {
      const requested = params.protocolVersion
      const protocolVersion = MCP_SUPPORTED_VERSIONS.slice(1).find(version => version === requested) ?? MCP_LEGACY_VERSION
      return result({
        protocolVersion,
        capabilities: CAPABILITIES,
        serverInfo: { ...serverInfo, generatedFrom: "openapi" },
      })
    }
    if (modern && method === "server/discover") {
      return result({ supportedVersions: MCP_SUPPORTED_VERSIONS, capabilities: CAPABILITIES, ttlMs: 0, cacheScope: "private" })
    }
    if (method === "ping") return result({})

    // List tools — dynamically from OpenAPI + custom handlers
    if (method === "tools/list") {
      const { tools, routes } = loadOpenAPISpec()
      const allowed = (name: string) => toolAllowed(name, routes.get(name), agent.scopes)

      // Include scoped custom tools that do not have an OpenAPI operation.
      const customOnlyTools: McpTool[] = []
      for (const [name] of customHandlers) {
        if (allowed(name) && !routes.has(name)) {
          customOnlyTools.push({
            name,
            description: getCustomToolDescription(name),
            inputSchema: getCustomToolSchema(name),
          })
        }
      }

      return result({
        tools: [...tools.filter(tool => allowed(tool.name)), ...customOnlyTools],
        ...(modern ? { ttlMs: 0, cacheScope: "private" } : {}),
      })
    }

    // Execute tool
    if (method === "tools/call") {
      const toolName = typeof params.name === "string" ? params.name : ""
      const args = params.arguments ?? {}
      if (!toolName || !isRecord(args)) return rpcError(reqId, -32602, "Expected a tool name and arguments object")

      try {
        if (!toolAllowed(toolName, loadOpenAPISpec().routes.get(toolName), agent.scopes)) {
          return rpcError(reqId, modern ? -32602 : -32603, "Tool is unavailable to this token")
        }
        const output = await executeTool(toolName, args, authorization, agent)
        return result({
          content: [{ type: "text", text: JSON.stringify(output) }],
          ...(modern ? { structuredContent: output } : {}),
          isError: "error" in output || output.status === "not_found" || output.status === "error",
        })
      } catch (toolError) {
        const message = toolError instanceof Error && /^Tool request failed with HTTP \d{3}(?:: [\s\S]+)?$/.test(toolError.message)
          ? toolError.message : "Tool execution failed"
        if (modern) return result({ content: [{ type: "text", text: message }], isError: true })
        return rpcError(reqId, -32603, message)
      }
    }

    return rpcError(reqId, -32601, "Method not found", modern ? 404 : 400)
  } catch {
    return rpcError(reqId, -32603, "MCP server error", 500)
  }
}

// ─── Custom Tool Metadata ─────────────────────────────────────────────────────

function getCustomToolDescription(name: string): string {
  const descriptions: Record<string, string> = {
    completeTask: "Mark a task as complete by ID or title. Title lookup requires search:read and matches the full title.",
    searchTasks: "Search tasks by query text, status, priority, or assignee. Returns a clean list of matching tasks.",
    whoAmI: "Identify this connection: the token name, its scopes, the agent assignee it acts as, and whether it may change any task or only its assigned tasks. Call this first.",
    listMyTasks: "List the tasks assigned to you, the agent assignee linked to this token. Open tasks only unless include_completed is true or a status is given.",
    handBackTask: "Hand a task assigned to you back to a person. Posts your note as a comment, then reassigns the task to whoever held it before you (or to `to`, or leaves it unassigned). The household is notified.",
  }
  return descriptions[name] ?? `Custom tool: ${name}`
}

function getCustomToolSchema(name: string): McpTool["inputSchema"] {
  const schemas: Record<string, McpTool["inputSchema"]> = {
    completeTask: {
      type: "object",
      properties: {
        id: { type: "string", description: "Task ID to complete (preferred)" },
        title: { type: "string", description: "Task title for exact title matching (fallback)" },
      },
    },
    searchTasks: {
      type: "object",
      properties: {
        q: { type: "string", description: "Search query text" },
        query: { type: "string", description: "Search query text (alias for q)" },
        status: { type: "string", description: "Filter by status (backlog, pending, active, complete, todo, in_progress, done)" },
        priority: { type: "integer", description: "Filter by priority (1-5)" },
        assigned_to: { type: "string", description: "Filter by assignee" },
        include_completed: { type: "boolean", description: "Include completed tasks" },
      },
    },
    whoAmI: { type: "object", properties: {} },
    listMyTasks: {
      type: "object",
      properties: {
        status: { type: "string", description: "Filter by status (backlog, pending, active, complete, todo, in_progress, done)" },
        include_completed: { type: "boolean", description: "Include completed tasks", default: false },
        limit: { type: "integer", description: "Maximum tasks to return (1-200)", default: 50 },
      },
    },
    handBackTask: {
      type: "object",
      properties: {
        id: { type: "string", description: "Task ID or ticket key (MTH-12)" },
        note: { type: "string", description: "What you did, what is left, or what you need. Posted as a comment." },
        to: { type: ["string", "null"], description: "Assignee ID to hand back to. Omit to return it to the previous assignee; null leaves it unassigned." },
      },
      required: ["id"],
    },

  }
  return schemas[name] ?? { type: "object", properties: {} }
}
