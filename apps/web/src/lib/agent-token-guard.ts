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
import {
  ensureAgentTokenSchema,
  getAgentTokenByHash,
  updateAgentTokenLastUsed
} from "@domains/auth"
import {
  ensureSchema,
  getPersistenceClient,
  IdentityRepository,
  BoardAccessService,
  validateTaskOperation
} from "@domains/tasks"
import { registerVerifiedPrincipal } from "@domains/tasks/board-scope"
import { normalizeTaskLocatorKey } from "./board-request-context"
import { apiError, apiProblem } from "./api-response"

export interface ResolvedAgent {
  tokenId: string
  tokenName: string
  scopes: AgentScope[]
  /** Assignee this credential acts as. Null when the token has no task identity. */
  assigneeId?: string | null
}

/** Whether a credential is restricted to editing only tasks assigned to its linked identity. */
export function isAssignedWriteOnly(agentToken?: ResolvedAgent | null): boolean {
  return Boolean(
    agentToken &&
      agentToken.scopes.includes("tasks:write:assigned") &&
      !agentToken.scopes.includes("tasks:write")
  )
}

/** Return the enforcing assignee ID when restricted to assigned-only writes, else undefined. */
export function restrictedAssigneeId(agentToken?: ResolvedAgent | null): string | undefined {
  if (!isAssignedWriteOnly(agentToken)) return undefined
  return agentToken?.assigneeId ?? undefined
}

/**
 * Enforce assigned-only write authorization across one or more task IDs.
 * Returns a 403 Response when restricted and any target task is absent or assigned elsewhere.
 */
export async function requireAssignedTaskWriteAccess(
  agentToken: ResolvedAgent | undefined,
  findTask: (taskId: string) => Promise<{ assigned_to?: string | null } | null>,
  taskIds: string[],
  errorMessage: string
): Promise<Response | null> {
  if (!isAssignedWriteOnly(agentToken)) return null
  if (!agentToken?.assigneeId) {
    return apiError(errorMessage, 403)
  }
  const uniqueIds = [...new Set(taskIds)]
  const tasks = await Promise.all(uniqueIds.map((id) => findTask(id)))
  if (tasks.some((task) => !task || task.assigned_to !== agentToken.assigneeId)) {
    return apiError(errorMessage, 403)
  }
  return null
}

let schemaReady: Promise<void> | undefined

/** Resolve explicitly presented Meitheal credentials before evaluating the transport. */
export async function resolveAgentAuth(request: Request): Promise<ResolvedAgent | null> {
  const header = request.headers.get("authorization")
  if (!header || !/^Bearer\s+mth_/i.test(header)) return null

  const plaintext = /^Bearer\s+(mth_[a-f0-9]{64})$/i.exec(header)?.[1]
  const unauthorized = () =>
    apiProblem({
      status: 401,
      detail: "Use a valid, active Meitheal agent token.",
      extraHeaders: {
        "WWW-Authenticate": 'Bearer error="invalid_token"',
        "Cache-Control": "no-store"
      }
    })
  if (!plaintext) throw unauthorized()

  let record: AgentTokenRecord | null
  try {
    await ensureSchema()
    schemaReady ??= ensureAgentTokenSchema()
    await schemaReady
    record = await getAgentTokenByHash(hashToken(plaintext))
  } catch {
    schemaReady = undefined
    throw apiProblem({
      status: 503,
      detail: "Agent credentials are temporarily unavailable.",
      extraHeaders: { "cache-control": "private, no-store" }
    })
  }

  const active =
    record &&
    !record.revoked &&
    (record.expiresAt === null || Date.parse(record.expiresAt) > Date.now())
  if (!record || !active) throw unauthorized()

  // Avoid writing SQLite on every polling request.
  if (!record.lastUsedAt || Date.now() - Date.parse(record.lastUsedAt) >= 60_000) {
    updateAgentTokenLastUsed(record.id).catch(() => {})
  }

  let assigneeId = record.assigneeId ?? null
  if (assigneeId) {
    try {
      await ensureSchema()
      const assignee = await new IdentityRepository(getPersistenceClient()).getCustomUser(
        assigneeId
      )
      if (assignee?.kind !== "agent") assigneeId = null
    } catch {
      throw apiProblem({
        status: 503,
        detail: "Agent assignee verification is temporarily unavailable.",
        extraHeaders: { "cache-control": "private, no-store" }
      })
    }
  }

  return { tokenId: record.id, tokenName: record.name, scopes: record.scopes, assigneeId }
}

/**
 * Enforce the assigned-only write grant: the task must exist and be assigned to
 * the assignee this token acts as. Returns a problem response to send, or null.
 */
export async function checkAssignedTask(
  taskIdOrKey: string,
  agent: ResolvedAgent
): Promise<Response | null> {
  const denied = (detail: string) =>
    apiProblem({
      status: 403,
      detail,
      type: "https://meitheal.local/problems/task-not-assigned",
      extraHeaders: { "Cache-Control": "no-store" }
    })
  if (!agent.assigneeId) return denied("This token is not linked to an agent assignee.")

  const unavailable = () =>
    apiProblem({
      status: 404,
      detail: "Task not found.",
      extraHeaders: { "Cache-Control": "private, no-store" }
    })
  try {
    await ensureSchema()
    // Resolve the task exactly as the task routes do, so both agree on which task is named.
    const client = getPersistenceClient()
    const {
      rows: [located]
    } = await client.execute({
      sql: `SELECT task.id, COALESCE(task.task_board_id, legacy.id) AS board_id FROM tasks AS task
        LEFT JOIN task_boards AS legacy ON legacy.storage_encoding = 'legacy_null_v1'
        WHERE task.id = ? OR task.ticket_ref = ? OR (task.task_board_id IS NULL AND legacy.ticket_prefix || '-' || task.ticket_number = ?)`,
      args: [
        taskIdOrKey,
        normalizeTaskLocatorKey(taskIdOrKey),
        normalizeTaskLocatorKey(taskIdOrKey)
      ]
    })
    if (!located) return null
    const principal = registerVerifiedPrincipal(
      { kind: "agent", id: agent.tokenId, tokenId: agent.tokenId },
      {
        expiresAt: Date.now() + 5_000,
        administrator: false,
        tokenScopes: agent.scopes,
        assignedTo: agent.assigneeId
      }
    )
    const authorization = await new BoardAccessService(client).resolve(
      principal,
      String(located.board_id),
      { resource: "task", action: "edit" }
    )
    if (!authorization.ok) return unavailable()
    return (await validateTaskOperation(
      client,
      authorization.scope,
      String(located.id),
      { resource: "task", action: "edit" },
      agent.assigneeId
    ))
      ? null
      : unavailable()
  } catch {
    return apiProblem({
      status: 503,
      detail: "Task assignment could not be checked. Try again.",
      extraHeaders: { "Cache-Control": "no-store" }
    })
  }
}
