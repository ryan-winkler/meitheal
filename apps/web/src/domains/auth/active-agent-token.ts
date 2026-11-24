import type { Client } from "@libsql/client"
import type { AgentScope } from "@meitheal/domain-auth"

/** Pure expiration check shared across Settings and Board Settings views. */
export function isAgentTokenExpired(expiresAt: string | null | undefined, nowMs = Date.now()): boolean {
  if (!expiresAt) return false
  const parsed = Date.parse(expiresAt)
  return !Number.isFinite(parsed) || parsed <= nowMs
}

/** Pure active-token eligibility check (not revoked and not expired). */
export function isAgentTokenActive(
  token: { revoked?: boolean; expiresAt?: string | null },
  nowMs = Date.now()
): boolean {
  return token.revoked !== true && !isAgentTokenExpired(token.expiresAt, nowMs)
}

/** Recheck a previously authenticated credential in the transaction that uses it. */
export async function isActiveAgentToken(db: Pick<Client, "execute">, id: string, scope?: AgentScope): Promise<boolean> {
  const { rows: [token] } = await db.execute({
    sql: `SELECT expires_at FROM agent_tokens WHERE id = ? AND revoked = 0
      AND (? IS NULL OR EXISTS (
        SELECT 1 FROM json_each(CASE WHEN json_valid(scopes) THEN scopes ELSE '[]' END) WHERE value = ?
      ))`,
    args: [id, scope ?? null, scope ?? null],
  })
  return Boolean(token && (token.expires_at === null ||
    (typeof token.expires_at === "string" && !isAgentTokenExpired(token.expires_at))))
}
