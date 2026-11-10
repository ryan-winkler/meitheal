/**
 * Agent Token Guard — Shared Middleware Helper
 *
 * Extracts and validates Bearer tokens from API requests.
 * Enforces scoped authorization per route.
 * Explicit agent tokens are checked on every transport.
 *
 * @domain shared-infrastructure
 * @bounded-context agent-authorization
 * @kcs Token auth is opt-in. System functions without any tokens.
 */
import { hashToken, hasScope, type AgentScope, type AgentTokenRecord } from "@meitheal/domain-auth"
import { ensureAgentTokenSchema, getAgentTokenByHash, updateAgentTokenLastUsed } from "@domains/auth/agent-token-store"
import { apiProblem } from "./api-response"

// ── Token Resolution ─────────────────────────────────────────────────────────

export interface ResolvedAgent {
  tokenId: string
  tokenName: string
  scopes: AgentScope[]
}

let schemaReady: Promise<void> | undefined

/** Resolve explicitly presented Meitheal credentials before evaluating the transport. */
export async function resolveAgentAuth(request: Request): Promise<ResolvedAgent | null> {
  const header = request.headers.get("authorization")
  if (!header || !/^Bearer\s+mth_/i.test(header)) return null

  const plaintext = /^Bearer\s+(mth_[a-f0-9]{64})$/i.exec(header)?.[1]
  const unauthorized = () => apiProblem({
    status: 401,
    detail: "Use a valid, active Meitheal agent token.",
    extraHeaders: { "WWW-Authenticate": 'Bearer error="invalid_token"', "Cache-Control": "no-store" },
  })
  if (!plaintext) throw unauthorized()

  let record: AgentTokenRecord | null
  try {
    schemaReady ??= ensureAgentTokenSchema()
    await schemaReady
    record = await getAgentTokenByHash(hashToken(plaintext))
  } catch {
    schemaReady = undefined
    throw apiProblem({ status: 503, detail: "Agent credentials are temporarily unavailable." })
  }

  const active = record && !record.revoked &&
    (record.expiresAt === null || Date.parse(record.expiresAt) > Date.now())
  if (!record || !active) throw unauthorized()

  // Avoid writing SQLite on every polling request.
  if (!record.lastUsedAt || Date.now() - Date.parse(record.lastUsedAt) >= 60_000) {
    updateAgentTokenLastUsed(record.id).catch(() => {})
  }

  return { tokenId: record.id, tokenName: record.name, scopes: record.scopes }
}

/**
 * Check if the resolved agent has the required scope.
 * Returns a 403 problem+json Response if the scope is missing.
 * Returns null if the scope is present or if no agent auth is active.
 *
 * @kcs HA ingress and browser sessions (agent=null) always pass scope checks.
 */
export function requireScope(agent: ResolvedAgent | null, scope: AgentScope): Response | null {
  // No agent auth active — HA ingress or browser session, allow everything
  if (!agent) return null

  if (hasScope(agent.scopes, scope)) return null

  return apiProblem({
    status: 403,
    title: "Insufficient Scope",
    detail: `Token "${agent.tokenName}" requires scope "${scope}" for this operation`,
    type: "https://meitheal.local/problems/insufficient-scope",
  })
}

/**
 * Route-level scope mapping.
 * Maps API path patterns to required scopes for automated enforcement.
 */
/** Explicit token permissions; unknown routes are denied by middleware. */
export function resolveRouteScope(pathname: string, method: string): AgentScope | null {
  const read = method === "GET" || method === "HEAD"
  const at = (prefix: string) => pathname === prefix || pathname.startsWith(prefix + "/")
  if (method === "POST" && /^\/api\/tasks\/[^/]+\/handoff$/.test(pathname)) return "tasks:propose"
  if (at("/api/agent-tokens") || pathname === "/api/import/settings") return "settings:write"
  if (pathname === "/api/backup/prepare" || pathname === "/api/backup/complete") return "settings:write"
  if (pathname === "/api/nfc/complete") return "tasks:write"
  if (at("/api/tasks")) {
    if (method === "DELETE" || ["/api/tasks/delete", "/api/tasks/batch-delete", "/api/tasks/clear-completed", "/api/tasks/delete-completed"].includes(pathname)) return "tasks:delete"
    return read ? "tasks:read" : "tasks:write"
  }
  if (at("/api/mcp")) return "mcp:execute"
  if (at("/api/a2a")) return "a2a:execute"
  if (at("/api/search") || at("/api/unfurl")) return "search:read"
  if (["projects", "goals", "areas", "pillars"].some(group => at(`/api/${group}`))) return read ? "projects:read" : "projects:write"
  if (at("/api/todo")) return read ? "settings:read" : "settings:write"
  if (["settings", "rules", "frameworks", "features", "import", "export", "integrations", "ha", "grocy", "license"].some(group => at(`/api/${group}`))) return read ? "settings:read" : "settings:write"
  if (["labels", "lanes", "habits", "templates", "task-templates", "checklists", "links", "focus", "gamification", "summary", "review", "calendar", "time", "pomodoro", "reminders", "saved-filters", "sse"].some(group => at(`/api/${group}`))) return read ? "tasks:read" : "tasks:write"
  if (at("/api/users")) return read ? "tasks:read" : "settings:write"
  if (at("/api/webhooks")) return "webhooks:write"
  return null
}
