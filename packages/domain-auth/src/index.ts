import { createHash, randomBytes } from "node:crypto"

export type AgentScope =
  | "tasks:read"
  | "tasks:write"
  | "tasks:write:assigned"
  | "tasks:delete"
  | "tasks:propose"
  | "projects:read"
  | "projects:write"
  | "search:read"
  | "mcp:execute"
  | "a2a:execute"

export type ScopeCategory = "tasks" | "projects" | "search" | "protocols"

export interface ScopeDefinition {
  scope: AgentScope
  category: ScopeCategory
  description: string
}

export const AVAILABLE_SCOPES: readonly ScopeDefinition[] = [
  { scope: "tasks:read", category: "tasks", description: "Read tasks, comments, and task history" },
  { scope: "tasks:write", category: "tasks", description: "Create and update any task on permitted boards" },
  { scope: "tasks:write:assigned", category: "tasks", description: "Update only tasks assigned to this agent" },
  { scope: "tasks:delete", category: "tasks", description: "Delete tasks on permitted boards" },
  { scope: "tasks:propose", category: "tasks", description: "Claim tasks and submit proposals for human review" },
  { scope: "projects:read", category: "projects", description: "Read areas, goals, projects, and routines" },
  { scope: "projects:write", category: "projects", description: "Create and update areas, goals, and projects" },
  { scope: "search:read", category: "search", description: "Search tasks and workspace catalogs" },
  { scope: "mcp:execute", category: "protocols", description: "Invoke Model Context Protocol (MCP) tools" },
  { scope: "a2a:execute", category: "protocols", description: "Invoke Agent-to-Agent (A2A) endpoints" },
] as const

const VALID_SCOPE_SET: ReadonlySet<string> = new Set(AVAILABLE_SCOPES.map(s => s.scope))

export interface AgentTokenRecord {
  id: string
  name: string
  tokenHash: string
  tokenPrefix: string
  scopes: AgentScope[]
  assigneeId?: string | null
  createdAt: string
  expiresAt: string | null
  lastUsedAt: string | null
  revoked: boolean
}

export type PublicAgentToken = Omit<AgentTokenRecord, "tokenHash">

export function hashToken(plaintext: string): string {
  return createHash("sha256").update(plaintext, "utf8").digest("hex")
}

export function generateAgentToken(): { token: string; tokenHash: string; tokenPrefix: string } {
  const token = `mth_${randomBytes(32).toString("hex")}`
  return {
    token,
    tokenHash: hashToken(token),
    tokenPrefix: token.slice(0, 12),
  }
}

export function hasScope(scopes: readonly AgentScope[] | undefined | null, required: AgentScope): boolean {
  if (!Array.isArray(scopes)) return false
  return scopes.includes(required)
}

export function validateScopes(rawScopes: readonly string[]): { valid: AgentScope[]; invalid: string[] } {
  const valid: AgentScope[] = []
  const invalid: string[] = []
  const seen = new Set<string>()
  for (const raw of rawScopes) {
    if (VALID_SCOPE_SET.has(raw)) {
      if (!seen.has(raw)) {
        seen.add(raw)
        valid.push(raw as AgentScope)
      }
    } else {
      invalid.push(raw)
    }
  }
  return { valid, invalid }
}

export function toPublicToken(record: AgentTokenRecord): PublicAgentToken {
  const { tokenHash: _hidden, ...publicFields } = record
  return publicFields
}

export function isTaskReactionRoute(pathname: string): boolean {
  return (
    pathname === "/api/tasks/reaction-counts" ||
    /^\/api\/tasks\/[^/]+\/reactions(?:\/[^/]+)?$/.test(pathname) ||
    /^\/api\/tasks\/[^/]+\/comments\/[^/]+\/reactions(?:\/[^/]+)?$/.test(pathname)
  )
}

export function resolveAgentRouteScope(pathname: string, method: string): AgentScope | null {
  const m = method.toUpperCase()
  if (pathname === "/api/mcp" || pathname === "/.well-known/mcp.json") return "mcp:execute"
  if (pathname.startsWith("/api/a2a/") || pathname === "/.well-known/agent-card.json" || pathname === "/.well-known/agent.json") {
    return "a2a:execute"
  }
  if (pathname === "/api/search") return m === "GET" || m === "HEAD" ? "search:read" : null
  if (pathname === "/api/agent-context") return m === "GET" || m === "HEAD" ? "tasks:read" : null

  if (/^\/api\/tasks\/[^/]+\/handoff$/.test(pathname)) return "tasks:propose"
  if (/^\/api\/tasks\/[^/]+\/accept-proposal$/.test(pathname)) return "tasks:write"

  if (pathname === "/api/tasks" || pathname.startsWith("/api/tasks/") || /^\/api\/boards\/[^/]+\/tickets/.test(pathname)) {
    if (m === "GET" || m === "HEAD") return "tasks:read"
    if (m === "DELETE") return "tasks:delete"
    if (m === "POST" || m === "PUT" || m === "PATCH") return "tasks:write"
  }

  if (
    pathname.startsWith("/api/projects") ||
    pathname.startsWith("/api/areas") ||
    pathname.startsWith("/api/goals") ||
    pathname.startsWith("/api/lanes") ||
    pathname.startsWith("/api/labels") ||
    pathname.startsWith("/api/habits") ||
    pathname.startsWith("/api/templates") ||
    pathname.startsWith("/api/boards")
  ) {
    if (m === "GET" || m === "HEAD") return "projects:read"
    if (m === "POST" || m === "PUT" || m === "PATCH" || m === "DELETE") return "projects:write"
  }

  return null
}

export interface AgentRouteAccessResult {
  allowed: boolean
  scope: AgentScope | null
  assignedTaskId?: string | null
}

export function resolveAgentRouteAccess(
  pathname: string,
  method: string,
  scopes: readonly AgentScope[],
): AgentRouteAccessResult {
  const required = resolveAgentRouteScope(pathname, method)
  if (!required) return { allowed: false, scope: null }

  if (hasScope(scopes, required)) {
    return { allowed: true, scope: required }
  }

  if (required === "tasks:write" && hasScope(scopes, "tasks:write:assigned")) {
    const taskMatch = /^\/api\/tasks\/([^/]+)(?:\/|$)/.exec(pathname)
    if (taskMatch?.[1] && !["create", "reorder", "clear-completed", "delete-completed", "today-counts", "reaction-counts"].includes(taskMatch[1])) {
      return { allowed: true, scope: "tasks:write:assigned", assignedTaskId: taskMatch[1] }
    }
  }

  return { allowed: false, scope: required }
}

export type LicensePlan = "personal" | "household" | "commercial"

export type LicenseVerificationResult =
  | { valid: true; grace: true; plan: LicensePlan }
  | { valid: true; plan: LicensePlan; subject?: string; expiresAt?: string | null }
  | { valid: false; reason: string }

export function verifyLicenseKey(rawKey?: string | null): LicenseVerificationResult {
  const trimmed = typeof rawKey === "string" ? rawKey.trim() : ""
  if (!trimmed) {
    return { valid: true, grace: true, plan: "personal" }
  }
  const parts = trimmed.split(".")
  if (parts.length !== 3) {
    return { valid: false, reason: "malformed_license_key" }
  }
  try {
    const payloadJson = Buffer.from(parts[1]!, "base64url").toString("utf8")
    const payload = JSON.parse(payloadJson) as Record<string, unknown>
    const plan = payload.plan === "household" || payload.plan === "commercial" ? payload.plan : "personal"
    if (typeof payload.exp === "number" && payload.exp * 1000 < Date.now()) {
      return { valid: false, reason: "license_expired" }
    }
    return {
      valid: true,
      plan,
      ...(typeof payload.sub === "string" ? { subject: payload.sub } : {}),
      expiresAt: typeof payload.exp === "number" ? new Date(payload.exp * 1000).toISOString() : null,
    }
  } catch {
    return { valid: false, reason: "invalid_license_payload" }
  }
}
