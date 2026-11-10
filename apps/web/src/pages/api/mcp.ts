import { guardAgentProtocol } from "../../lib/agent-protocol-policy"
import { resolveMcpSchema } from "../../lib/mcp-schema"
import type { APIRoute } from "astro"
import { apiJson, apiError } from "../../lib/api-response"
import { readFileSync, existsSync } from "node:fs"
import { resolve } from "node:path"
import { parse } from "yaml"

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
  baseUrl: string,
  authHeaders: Record<string, string>
) => Promise<Record<string, unknown>>

// ─── OpenAPI → MCP Tool Discovery ────────────────────────────────────────────

/** Operations to exclude from MCP tools (internal/system endpoints) */
const EXCLUDED_OPS = new Set([
  "sendA2AMessage",    // Protocol transport; use domain tools directly
  "getA2AAgentCard",   // Discovery transport, not a domain tool
  "reviewTaskProposal", // Human administrator decision only
  "acceptTaskProposal", // Legacy name of the human-only decision
  "mcpEndpoint",       // Self-reference
  "createTaskLegacy",  // Canonical task creation is /api/tasks
  "healthPing",        // HEAD-only liveness
  "subscribeSSE",      // SSE streaming, not callable
  "exportDatabase",    // Large binary download
  "exportSettings",    // File downloads
  "importSettings",    // File upload
  "prepareBackup",    // Internal HA/Supervisor lifecycle hook
  "completeBackup",   // Internal HA/Supervisor lifecycle hook
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
      }
      tools.push({
        name: toolName,
        description: toolName === "searchTasks"
          ? "Search tasks by text with optional status, priority and assignee filters."
          : op.description ?? op.summary ?? `${method.toUpperCase()} ${path}`,
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

// ─── Auth Header Forwarding ───────────────────────────────────────────────────
// Internal fetches must carry the caller's auth context to prevent scope escalation.
// Without this, a token with only mcp:execute could bypass scope checks on sub-requests.

function extractAuthHeaders(request: Request): Record<string, string> {
  const headers: Record<string, string> = {}
  const auth = request.headers.get("authorization")
  if (auth) headers["authorization"] = auth
  const hassUserId = request.headers.get("x-hass-user-id")
  if (hassUserId) headers["x-hass-user-id"] = hassUserId
  const hassAdmin = request.headers.get("x-hass-is-admin")
  if (hassAdmin) headers["x-hass-is-admin"] = hassAdmin
  for (const name of ["x-remote-user-id", "x-remote-user-name", "x-remote-user-display-name", "x-remote-user-groups"]) {
    const value = request.headers.get(name)
    if (value) headers[name] = value
  }
  return headers
}

/** Build fetch headers combining auth context and content-type */
function jsonHeaders(authHeaders: Record<string, string>): Record<string, string> {
  return { "content-type": "application/json", ...authHeaders }
}

// ─── Custom Tool Overrides ────────────────────────────────────────────────────
// Some tools need special response shaping or multi-step logic.

const customHandlers = new Map<string, CustomToolHandler>()

// completeTask: supports both ID and title-based completion
customHandlers.set("completeTask", async (args, baseUrl, authHeaders) => {
  if (args.id) {
    const safeId = encodeURIComponent(String(args.id))
    const res = await fetch(`${baseUrl}/api/tasks/${safeId}`, {
      method: "PUT",
      headers: jsonHeaders(authHeaders),
      body: JSON.stringify({ status: "complete" }),
    })
    const data = await res.json().catch(() => null)
    if (!res.ok) return { error: `Task completion failed (HTTP ${res.status})`, detail: data }
    if (!data || typeof data !== "object") return { error: "Task completion returned an invalid response" }
    return { ...data, status: "completed" }
  }
  if (args.title) {
    const searchRes = await fetch(`${baseUrl}/api/search?q=${encodeURIComponent(String(args.title))}&scope=tasks`, {
      headers: authHeaders,
    })
    if (!searchRes.ok) return { error: `Task search failed (HTTP ${searchRes.status})` }
    const data = (await searchRes.json()) as {
      sections?: Array<{ id?: string, items?: Array<Record<string, unknown>> }>
    }
    const taskSection = data.sections?.find((s) => s.id === "tasks")
    const match = taskSection?.items?.find(
      (t) => String(t.title).toLowerCase() === String(args.title).toLowerCase()
    )
    if (match) {
      const taskId = match.taskId ?? match.id
      const response = await fetch(`${baseUrl}/api/tasks/${encodeURIComponent(String(taskId))}`, {
        method: "PUT",
        headers: jsonHeaders(authHeaders),
        body: JSON.stringify({ status: "complete" }),
      })
      if (!response.ok) return { error: `Task completion failed (HTTP ${response.status})`, id: taskId }
      return { ...await checkedJson(response), status: "completed", id: taskId, title: match.title }
    }
    return { status: "not_found", title: args.title }
  }
  return { status: "error", message: "Provide id or title" }
})

// searchTasks: reshape search response for cleaner AI consumption
customHandlers.set("searchTasks", async (args, baseUrl, authHeaders) => {
  const params = new URLSearchParams()
  // The generated tool schema uses the native search parameter names.
  // Keep query as a compatibility alias for existing MCP callers.
  const query = args.q ?? args.query
  if (query !== undefined) params.set("q", String(query))
  for (const key of ["status", "priority", "assigned_to", "limit", "sort", "task_fields"]) {
    if (args[key] !== undefined) params.set(key, String(args[key]))
  }
  for (const key of ["include_completed", "include_archived"]) {
    if (args[key] === true) params.set(key, "1")
  }
  params.set("scope", "tasks")
  const res = await fetch(`${baseUrl}/api/search?${params}`, { headers: authHeaders })
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

// Composite reads fail explicitly when any required source is unavailable.
customHandlers.set("dailyBriefing", async (_args, baseUrl, authHeaders) => {
  const [today_tasks, habits, weekly_review] = await Promise.all([
    fetch(`${baseUrl}/api/tasks?status=pending&sort=priority&limit=10`, { headers: authHeaders }).then(checkedJson),
    fetch(`${baseUrl}/api/habits`, { headers: authHeaders }).then(checkedJson),
    fetch(`${baseUrl}/api/review/weekly`, { headers: authHeaders }).then(checkedJson),
  ])
  return { today_tasks, habits, weekly_review }
})

// ─── Dynamic Tool Executor ────────────────────────────────────────────────────

async function executeTool(
  toolName: string,
  args: Record<string, unknown>,
  request: Request
): Promise<Record<string, unknown>> {
  // Ingress preserves HA's external Host; internal tools must call this app,
  // not the HA frontend origin. Dev uses its actual Vite server port.
  const baseUrl = import.meta.env.DEV
    ? new URL(request.url).origin
    : `http://127.0.0.1:${process.env.PORT ?? "3000"}`
  const authHeaders = extractAuthHeaders(request)

  // Check custom handlers first
  const custom = customHandlers.get(toolName)
  if (custom) return custom(args, baseUrl, authHeaders)

  // Dynamic dispatch from OpenAPI routes
  const { routes } = loadOpenAPISpec()
  const route = routes.get(toolName)
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
  const fullUrl = `${baseUrl}${url}${queryString ? `?${queryString}` : ""}`

  // Build body from remaining args (exclude path/query params)
  const bodyKeys = new Set([...route.pathParams, ...route.queryParams])
  const bodyArgs: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(args)) {
    if (!bodyKeys.has(k)) bodyArgs[k] = v
  }

  const fetchOpts: RequestInit = {
    method: route.method,
    headers: jsonHeaders(authHeaders),
  }

  if (route.hasBody && Object.keys(bodyArgs).length > 0) {
    fetchOpts.body = JSON.stringify(bodyArgs)
  }

  const res = await fetch(fullUrl, fetchOpts)
  return { status: res.status, ...await checkedJson(res) }
}

async function checkedJson(response: Response): Promise<Record<string, unknown>> {
  if (!response.ok) throw new Error(`Operation failed (HTTP ${response.status})`)
  if (response.status === 204 || response.status === 205) return { ok: true }
  const data: unknown = await response.json()
  if (!data || typeof data !== "object") throw new Error("Operation returned an invalid response")
  const result = data as Record<string, unknown>
  if (result.ok === false || result.error) throw new Error("Operation was rejected")
  return result
}

// ─── JSON-RPC 2.0 Handler ────────────────────────────────────────────────────

export const POST: APIRoute = async ({ request }) => {
  const blocked = await guardAgentProtocol("mcp")
  if (blocked) return blocked
  try {
    const body = await request.json().catch(() => null)

    if (!body || typeof body !== "object") {
      return apiJson(
        { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
        400
      )
    }

    const { method, id: reqId = "1", params = {} } = body as {
      method?: string
      id?: string
      params?: Record<string, unknown>
    }

    // Initialize handshake
    if (method === "initialize") {
      return apiJson({
        jsonrpc: "2.0",
        id: reqId,
        result: {
          protocolVersion: "2025-03-26",
          capabilities: { tools: { listChanged: false } },
          serverInfo: {
            name: "meitheal",
            version: process.env.MEITHEAL_VERSION ?? "unknown",
            toolCount: getMcpToolCount(),
            generatedFrom: "openapi",
          },
        },
      })
    }

    // List tools — dynamically from OpenAPI + custom handlers
    if (method === "tools/list") {
      const { tools } = loadOpenAPISpec()

      // Add custom-only tools not in OpenAPI (dailyBriefing, completeTask)
      const customOnlyTools: McpTool[] = []
      for (const [name] of customHandlers) {
        if (!tools.find(t => t.name === name)) {
          customOnlyTools.push({
            name,
            description: getCustomToolDescription(name),
            inputSchema: getCustomToolSchema(name),
          })
        }
      }

      return apiJson({
        jsonrpc: "2.0",
        id: reqId,
        result: { tools: [...tools, ...customOnlyTools] },
      })
    }

    // Execute tool
    if (method === "tools/call") {
      const toolName = (params as { name?: string }).name ?? ""
      const args = (params as { arguments?: Record<string, unknown> }).arguments ?? {}

      try {
        const result = await executeTool(toolName, args, request)
        const isError = "error" in result

        return apiJson({
          jsonrpc: "2.0",
          id: reqId,
          result: {
            content: [{ type: "text", text: JSON.stringify(result) }],
            isError,
          },
        })
      } catch (toolError) {
        return apiJson({
          jsonrpc: "2.0",
          id: reqId,
          result: {
            content: [{ type: "text", text: JSON.stringify({ error: toolError instanceof Error ? toolError.message : "Tool execution failed" }) }],
            isError: true,
          },
        })
      }
    }

    return apiJson(
      { jsonrpc: "2.0", id: reqId, error: { code: -32601, message: `Unknown method: ${method}` } },
      400
    )
  } catch (error) {
    return apiError(
      error instanceof Error ? error.message : "MCP server error",
      500
    )
  }
}

// ─── Custom Tool Metadata ─────────────────────────────────────────────────────

function getCustomToolDescription(name: string): string {
  const descriptions: Record<string, string> = {
    completeTask: "Mark a task as complete by ID or exact title (case-insensitive). Search for the task first when its title is uncertain.",
    searchTasks: "Search tasks by query text, status, priority, or assignee. Returns a clean list of matching tasks.",
    dailyBriefing: "Get a comprehensive daily briefing including today's tasks, habits due, and weekly review summary. Perfect for morning automation workflows.",
  }
  return descriptions[name] ?? `Custom tool: ${name}`
}

function getCustomToolSchema(name: string): McpTool["inputSchema"] {
  const schemas: Record<string, McpTool["inputSchema"]> = {
    completeTask: {
      type: "object",
      properties: {
        id: { type: "string", description: "Task ID to complete (preferred)" },
        title: { type: "string", description: "Exact task title, matched case-insensitively (fallback)" },
      },
    },
    searchTasks: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query text" },
        status: { type: "string", description: "Filter by status" },
        priority: { type: "integer", description: "Filter by priority (1-5)" },
        assigned_to: { type: "string", description: "Filter by assignee" },
        include_completed: { type: "boolean", description: "Include completed tasks" },
      },
      required: ["query"],
    },
    dailyBriefing: {
      type: "object",
      properties: {},
    },

  }
  return schemas[name] ?? { type: "object", properties: {} }
}

/** Discovery uses the same generated tool inventory as tools/list. */
export function getMcpToolCount(): number {
  const { tools } = loadOpenAPISpec()
  const names = new Set(tools.map((tool) => tool.name))
  for (const name of customHandlers.keys()) names.add(name)
  return names.size
}
