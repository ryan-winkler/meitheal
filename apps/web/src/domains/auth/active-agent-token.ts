import type { Client } from "@libsql/client"
import type { AgentScope } from "@meitheal/domain-auth"

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
    (typeof token.expires_at === "string" && Date.parse(token.expires_at) > Date.now())))
}
