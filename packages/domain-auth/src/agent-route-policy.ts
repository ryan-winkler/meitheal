import type { AgentScope } from "./agent-tokens"

type MethodScopes = Partial<Record<string, AgentScope>>

const taskRead = { GET: "tasks:read" } satisfies MethodScopes
const taskCreate = { POST: "tasks:write" } satisfies MethodScopes
const taskDelete = { DELETE: "tasks:delete" } satisfies MethodScopes
const routes = new Map<string, MethodScopes>([
  ["/api/nfc/complete", { POST: "tasks:write" }],
  ["/api/tasks", { ...taskRead, ...taskCreate, ...taskDelete }],
  ["/api/tasks/create", taskCreate],
  ["/api/tasks/clear-completed", { POST: "tasks:delete" }],
  ["/api/tasks/delete-completed", { ...taskRead, ...taskDelete }],
  ["/api/tasks/reorder", taskCreate],
  ["/api/tasks/today-counts", taskRead],
  ["/api/tasks/reaction-counts", taskRead],
  ["/api/users", { GET: "tasks:read" }],
  ["/api/projects", { GET: "projects:read", POST: "projects:write" }],
  ["/api/search", { GET: "search:read" }],
  ["/api/mcp", { GET: "mcp:execute", POST: "mcp:execute" }],
  ["/api/a2a/agent-card", { GET: "a2a:execute" }],
  ["/api/a2a/message", { POST: "a2a:execute" }],
])
const taskRoutes = new Map<string, MethodScopes>([
  ["", { ...taskRead, PUT: "tasks:write", PATCH: "tasks:write", ...taskDelete }],
  ["handoff", { POST: "tasks:propose" }],
  ["activity", taskRead],
  ["comments", { ...taskRead, ...taskCreate }],
  ["deferral", { PATCH: "tasks:write" }],
  ["duplicate", taskCreate],
  ["links", { ...taskRead, ...taskCreate, DELETE: "tasks:write" }],
  ["time", { ...taskRead, ...taskCreate }],
  ["timeline", taskRead],
])
const reactionList: MethodScopes = { ...taskRead, ...taskCreate }
const reactionItem: MethodScopes = { DELETE: "tasks:write" }
const taskReactionPath = /^\/api\/tasks\/[\w-]+(?:\/comments\/[\w-]+)?\/reactions(?:\/([\w-]+))?$/

export function isTaskReactionRoute(pathname: string): boolean {
  return taskReactionPath.test(pathname)
}

/** Check if route targets a specific existing task and can be permitted by tasks:write:assigned */
export function isAssignedTaskScopedRoute(pathname: string, method: string): boolean {
  const verb = method === "HEAD" ? "GET" : method
  if (verb !== "PUT" && verb !== "PATCH" && verb !== "POST" && verb !== "DELETE") return false

  // Direct task update: /api/tasks/[id]
  if (/^\/api\/tasks\/[\w-]+$/.test(pathname)) return verb === "PUT" || verb === "PATCH"
  // Task comments: /api/tasks/[id]/comments or /api/tasks/[id]/comments/[commentId]
  if (/^\/api\/tasks\/[\w-]+\/comments(?:\/[\w-]+)?$/.test(pathname)) return verb === "POST" || verb === "PATCH"
  // Task links: /api/tasks/[id]/links
  if (/^\/api\/tasks\/[\w-]+\/links$/.test(pathname)) return verb === "POST" || verb === "DELETE"
  // Task time: /api/tasks/[id]/time
  if (/^\/api\/tasks\/[\w-]+\/time$/.test(pathname)) return verb === "POST"
  // Task deferral: /api/tasks/[id]/deferral
  if (/^\/api\/tasks\/[\w-]+\/deferral$/.test(pathname)) return verb === "PATCH"

  return false
}

const comment: MethodScopes = { ...taskRead, PATCH: "tasks:write", DELETE: "tasks:write" }
const project: MethodScopes = { GET: "projects:read", PUT: "projects:write", DELETE: "projects:write" }
const a2aTask: MethodScopes = { GET: "a2a:execute", POST: "a2a:execute" }

/** Every agent-accessible operation is explicitly scoped. An absent scope means deny. */
export function resolveAgentRouteScope(pathname: string, method: string): AgentScope | undefined {
  const verb = method === "HEAD" ? "GET" : method
  const exact = routes.get(pathname)
  if (exact) return exact[verb]

  if (/^\/api\/tasks\/[\w-]+\/comments\/[\w-]+$/.test(pathname)) return comment[verb]
  const reaction = pathname.match(taskReactionPath)
  if (reaction) return (reaction[1] ? reactionItem : reactionList)[verb]
  const task = pathname.match(/^\/api\/tasks\/[\w-]+(?:\/([\w-]+))?$/)
  if (task) return taskRoutes.get(task[1] ?? "")?.[verb]
  if (/^\/api\/projects\/[\w-]+$/.test(pathname)) return project[verb]
  if (/^\/api\/a2a\/tasks\/[\w-]+$/.test(pathname)) return a2aTask[verb]
}
