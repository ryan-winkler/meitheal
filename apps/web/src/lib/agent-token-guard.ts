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
import { ensureDatabaseSchemaSupported } from "@domains/tasks/persistence/store"
import { apiProblem } from "./api-response"

export interface ResolvedAgent {
  tokenId: string
  tokenName: string
  scopes: AgentScope[]
  assigneeId?: string | null
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

  return { tokenId: record.id, tokenName: record.name, scopes: record.scopes, assigneeId: record.assigneeId ?? null }
}
