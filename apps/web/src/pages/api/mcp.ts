import { readFileSync, existsSync } from "node:fs"
import { resolve } from "node:path"
import type { APIRoute } from "astro"
import { parse } from "yaml"
import { hasScope, resolveAgentRouteScope, type AgentScope } from "@meitheal/domain-auth"
import { apiJson, apiError, apiProblem } from "../../lib/api-response"

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
  requestApi: (path: string, init?: RequestInit) => Promise<Response>
) => Promise<Record<string, unknown>>

// ─── OpenAPI → MCP Tool Discovery ────────────────────────────────────────────

/** Operations to exclude from MCP tools (internal/system endpoints) */
const EXCLUDED_OPS = new Set([
  "mcpEndpoint",       // Self-reference
  "healthPing",        // HEAD-only liveness
  "subscribeSSE",      // SSE streaming, not callable
  "exportDatabase",    // Large binary download
  "exportSettings",    // File downloads
  "importSettings",    // File upload
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
          const paramSchema = param.schema ?? { type: "string" }
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
        const bodySchema = op.requestBody.content["application/json"].schema
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

      tools.push({
        name: toolName,
        description: op.description ?? op.summary ?? `${method.toUpperCase()} ${path}`,
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
      headers: { "content-type": "application/json", authorization },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error(`Tool request failed with HTTP ${response.status}`)
    }
    return response
  }
}

// ─── Custom Tool Overrides ────────────────────────────────────────────────────
// Some tools need special response shaping or multi-step logic.

const customHandlers = new Map<string, CustomToolHandler>()

// completeTask: supports both ID and title-based completion
customHandlers.set("completeTask", async (args, requestApi) => {
  if (args.id) {
    const safeId = encodeURIComponent(String(args.id))
    const res = await requestApi(`/api/tasks/${safeId}`, {
      method: "PUT",
      body: JSON.stringify({ status: "complete" }),
    })
    return { status: "completed", ...(await res.json().catch(() => ({}))) }
  }
  if (args.title) {
    const searchRes = await requestApi(`/api/search?q=${encodeURIComponent(String(args.title))}&scope=tasks`)
    const data = (await searchRes.json().catch(() => ({ sections: [] }))) as {
      sections?: Array<{ id?: string, items?: Array<Record<string, unknown>> }>
    }
    const taskSection = data.sections?.find((s) => s.id === "tasks")
    const match = taskSection?.items?.find(
      (t) => String(t.title).toLowerCase() === String(args.title).toLowerCase()
    )
    if (match) {
      const taskId = match.taskId ?? match.id
      const response = await requestApi(`/api/tasks/${encodeURIComponent(String(taskId))}`, {
        method: "PUT",
        body: JSON.stringify({ status: "complete" }),
      })
      await response.body?.cancel()
      return { status: "completed", id: taskId, title: match.title }
    }
    return { status: "not_found", title: args.title }
  }
  return { status: "error", message: "Provide id or title" }
})

// searchTasks: reshape search response for cleaner AI consumption
customHandlers.set("searchTasks", async (args, requestApi) => {
  const params = new URLSearchParams()
  if (args.query) params.set("q", String(args.query))
  if (args.status) params.set("status", String(args.status))
  if (args.priority) params.set("priority", String(args.priority))
  if (args.assigned_to) params.set("assigned_to", String(args.assigned_to))
  if (args.include_completed) params.set("include_completed", "1")
  params.set("scope", "tasks")
  const res = await requestApi(`/api/search?${params}`)
  const data = (await res.json().catch(() => ({ sections: [] }))) as {
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

const customToolScopes: ReadonlyMap<string, AgentScope> = new Map([
  ["completeTask", "tasks:write"],
  ["searchTasks", "search:read"],
])

function toolScope(toolName: string, route?: RouteMapping): AgentScope | undefined {
  return customToolScopes.get(toolName) ??
    (route && resolveAgentRouteScope(route.path.replace(/\{[^}]+\}/g, "resource-id"), route.method))
}

// ─── Dynamic Tool Executor ────────────────────────────────────────────────────

async function executeTool(
  toolName: string,
  args: Record<string, unknown>,
  authorization: string
): Promise<Record<string, unknown>> {
  const requestApi = scopedApi(authorization)

  // Check custom handlers first
  const custom = customHandlers.get(toolName)
  if (custom) return custom(args, requestApi)

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

  const res = await requestApi(fullUrl, fetchOpts)
  const data = await res.json().catch(() => ({}))
  return { status: res.status, ...data }
}

// ─── JSON-RPC 2.0 Handler ────────────────────────────────────────────────────

export const POST: APIRoute = async ({ request, locals }) => {
  const authorization = request.headers.get("authorization")
  const agent = locals.agentToken
  if (!agent || !authorization) {
    return apiProblem({
      status: 401,
      detail: "Use a Meitheal agent token with the mcp:execute scope.",
      extraHeaders: { "WWW-Authenticate": "Bearer" },
    })
  }

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
            version: "0.3.0",
            generatedFrom: "openapi",
          },
        },
      })
    }

    // List tools — dynamically from OpenAPI + custom handlers
    if (method === "tools/list") {
      const { tools, routes } = loadOpenAPISpec()
      const allowed = (name: string) => {
        const scope = toolScope(name, routes.get(name))
        return scope && hasScope(agent.scopes, scope)
      }

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

      return apiJson({
        jsonrpc: "2.0",
        id: reqId,
        result: { tools: [...tools.filter(tool => allowed(tool.name)), ...customOnlyTools] },
      })
    }

    // Execute tool
    if (method === "tools/call") {
      const toolName = (params as { name?: string }).name ?? ""
      const args = (params as { arguments?: Record<string, unknown> }).arguments ?? {}

      try {
        const scope = toolScope(toolName, loadOpenAPISpec().routes.get(toolName))
        if (!scope || !hasScope(agent.scopes, scope)) throw new Error("Tool is unavailable to this token")
        const result = await executeTool(toolName, args, authorization)
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
        // Return JSON-RPC error format — never raw 500
        return apiJson({
          jsonrpc: "2.0",
          id: reqId,
          error: {
            code: -32603,
            message: toolError instanceof Error ? toolError.message : "Tool execution failed",
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
    completeTask: "Mark a task as complete by ID or title. Title lookup requires search:read and matches the full title.",
    searchTasks: "Search tasks by query text, status, priority, or assignee. Returns a clean list of matching tasks.",
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
        query: { type: "string", description: "Search query text" },
        status: { type: "string", description: "Filter by status" },
        priority: { type: "integer", description: "Filter by priority (1-5)" },
        assigned_to: { type: "string", description: "Filter by assignee" },
        include_completed: { type: "boolean", description: "Include completed tasks" },
      },
      required: ["query"],
    },

  }
  return schemas[name] ?? { type: "object", properties: {} }
}
