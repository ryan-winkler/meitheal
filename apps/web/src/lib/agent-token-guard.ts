/**
 * Agent Token Guard — Shared Middleware Helper
 *
 * Extracts and validates Bearer tokens from API requests.
 * Enforces scoped authorization per route.
 * An explicit agent token is checked regardless of transport.
 *
 * @domain shared-infrastructure
 * @bounded-context agent-authorization
 * @kcs Token auth is opt-in. System functions without any tokens.
 */
import { hashToken, type AgentScope, type AgentTokenRecord } from "@meitheal/domain-auth"
import { ensureAgentTokenSchema, getAgentTokenByHash, updateAgentTokenLastUsed } from "@domains/auth/agent-token-store"
import { ensureDatabaseSchemaSupported, ensureSchema, getPersistenceClient } from "@domains/tasks/persistence/store"
import { apiProblem } from "./api-response"

export interface ResolvedAgent {
  tokenId: string
  tokenName: string
  scopes: AgentScope[]
  /** Assignee this credential acts as. Null when the token has no task identity. */
  assigneeId: string | null
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
    const schemaCheck = ensureDatabaseSchemaSupported()
    if (schemaCheck) await schemaCheck
    schemaReady ??= ensureAgentTokenSchema()
    await schemaReady
    record = await getAgentTokenByHash(hashToken(plaintext))
  } catch {
    schemaReady = undefined
    throw apiProblem({
      status: 503,
      detail: "Agent credentials are temporarily unavailable.",
      extraHeaders: { "cache-control": "private, no-store" },
    })
  }

  const active = record && !record.revoked &&
    (record.expiresAt === null || Date.parse(record.expiresAt) > Date.now())
  if (!record || !active) throw unauthorized()

  // Avoid writing SQLite on every polling request.
  if (!record.lastUsedAt || Date.now() - Date.parse(record.lastUsedAt) >= 60_000) {
    updateAgentTokenLastUsed(record.id).catch(() => {})
  }

  return { tokenId: record.id, tokenName: record.name, scopes: record.scopes, assigneeId: record.assigneeId }
}

/**
 * Enforce the assigned-only write grant: the task must exist and be assigned to
 * the assignee this token acts as. Returns a problem response to send, or null.
 */
export async function checkAssignedTask(taskIdOrKey: string, agent: ResolvedAgent): Promise<Response | null> {
  const denied = (detail: string) => apiProblem({
    status: 403,
    detail,
    type: "https://meitheal.local/problems/task-not-assigned",
    extraHeaders: { "Cache-Control": "no-store" },
  })
  if (!agent.assigneeId) return denied("This token is not linked to an agent assignee.")

  let assignedTo: unknown
  try {
    await ensureSchema()
    const ticket = /^MTH-\d+$/i.test(taskIdOrKey) ? Number(taskIdOrKey.slice(4)) : null
    const result = await getPersistenceClient().execute({
      sql: "SELECT assigned_to FROM tasks WHERE id = ? OR ticket_number = ? LIMIT 1",
      args: [taskIdOrKey, ticket],
    })
    // Let the route answer for a missing task so it reports the usual 404.
    if (result.rows.length === 0) return null
    assignedTo = result.rows[0]!.assigned_to
  } catch {
    return apiProblem({
      status: 503,
      detail: "Task assignment could not be checked. Try again.",
      extraHeaders: { "Cache-Control": "no-store" },
    })
  }
  return assignedTo === agent.assigneeId ? null : denied("This token may only change tasks assigned to its agent.")
}
