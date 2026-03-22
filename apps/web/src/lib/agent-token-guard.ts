/**
 * Agent Token Guard — Shared Middleware Helper
 *
 * Extracts and validates Bearer tokens from API requests.
 * Enforces scoped authorization per route.
 * HA ingress sessions bypass token auth entirely.
 *
 * @domain shared-infrastructure
 * @bounded-context agent-authorization
 * @kcs Token auth is opt-in. System functions without any tokens.
 */
import { hashToken, hasScope, type AgentScope, type AgentTokenRecord } from "@meitheal/domain-auth"
import { getAgentTokenByHash, updateAgentTokenLastUsed } from "@domains/auth/agent-token-store"
import { apiProblem } from "./api-response"

// ── Token Resolution ─────────────────────────────────────────────────────────

export interface ResolvedAgent {
  tokenId: string
  tokenName: string
  scopes: AgentScope[]
}

/**
 * Resolve an agent token from the Authorization header.
 * Returns null if no Bearer token is present (HA ingress or browser session).
 * Returns the resolved agent info if token is valid.
 * Throws a Response if token is invalid/expired/revoked.
 *
 * @kcs HA ingress bypass: if X-Hass-User-Id is present, skip token auth.
 */
export async function resolveAgentAuth(request: Request): Promise<ResolvedAgent | null> {
  // HA ingress bypass — users authenticated via Supervisor don't need tokens
  if (request.headers.get("x-hass-user-id")) {
    return null
  }

  const authHeader = request.headers.get("authorization")
  if (!authHeader) return null

  const match = authHeader.match(/^Bearer\s+(mth_[a-f0-9]+)$/i)
  if (!match) return null  // Not an agent token (could be other auth)

  const plaintext = match[1]!
  const tokenHash = hashToken(plaintext)

  let record: AgentTokenRecord | null
  try {
    record = await getAgentTokenByHash(tokenHash)
  } catch {
    // DB not ready yet or schema not bootstrapped — allow through
    return null
  }

  if (!record) {
    throw apiProblem({
      status: 401,
      title: "Invalid Token",
      detail: "The provided agent token is not recognized",
      type: "https://meitheal.local/problems/invalid-token",
    })
  }

  if (record.revoked) {
    throw apiProblem({
      status: 401,
      title: "Token Revoked",
      detail: "This agent token has been revoked",
      type: "https://meitheal.local/problems/token-revoked",
    })
  }

  if (record.expiresAt && new Date(record.expiresAt) < new Date()) {
    throw apiProblem({
      status: 401,
      title: "Token Expired",
      detail: `This agent token expired at ${record.expiresAt}`,
      type: "https://meitheal.local/problems/token-expired",
    })
  }

  // Update last-used timestamp (fire-and-forget, don't block response)
  updateAgentTokenLastUsed(record.id).catch(() => {})

  return {
    tokenId: record.id,
    tokenName: record.name,
    scopes: record.scopes,
  }
}

// ── Scope Enforcement ────────────────────────────────────────────────────────

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
export const ROUTE_SCOPE_MAP: ReadonlyMap<string, AgentScope> = new Map([
  // Tasks
  ["/api/tasks/create", "tasks:write"],
  ["/api/tasks/update", "tasks:write"],
  ["/api/tasks/delete", "tasks:delete"],
  ["/api/tasks/batch-update", "tasks:write"],
  ["/api/tasks/batch-delete", "tasks:delete"],
  ["/api/tasks", "tasks:read"],
  // Projects
  ["/api/projects", "projects:read"],
  // Search
  ["/api/search", "search:read"],
  // Settings
  ["/api/settings", "settings:read"],
  // Protocols
  ["/api/mcp", "mcp:execute"],
  ["/api/a2a", "a2a:execute"],
])

/**
 * Resolve the required scope for a given API path and method.
 * Returns null if no scope is required (e.g., public endpoints).
 */
export function resolveRouteScope(pathname: string, method: string): AgentScope | null {
  // Write operations on settings need settings:write
  if (pathname === "/api/settings" && (method === "PUT" || method === "PATCH")) {
    return "settings:write"
  }

  // Check exact matches first
  const exact = ROUTE_SCOPE_MAP.get(pathname)
  if (exact) return exact

  // Check prefix matches (e.g., /api/tasks/123 → tasks:read)
  for (const [pattern, scope] of ROUTE_SCOPE_MAP) {
    if (pathname.startsWith(pattern + "/")) return scope
  }

  return null
}
