/**
 * Agent Token Persistence — SQLite CRUD
 *
 * Storage layer for scoped agent tokens. Uses the shared
 * persistence client from the tasks domain for SQLite access.
 *
 * @domain auth
 * @bounded-context agent-authorization
 * @kcs Token plaintext is never stored. Only SHA-256 hashes are persisted.
 */
import { getPersistenceClient } from "@domains/tasks/persistence/store"
import type { AgentTokenRecord, AgentScope } from "@meitheal/domain-auth"

// ── Schema Bootstrap ─────────────────────────────────────────────────────────

/**
 * Create the agent_tokens table if it doesn't exist.
 * Idempotent — safe to call on every startup.
 *
 * @kcs Called from ensureSchema() in store.ts during app initialization.
 */
export async function ensureAgentTokenSchema(): Promise<void> {
  const db = getPersistenceClient()
  await db.execute({
    sql: `CREATE TABLE IF NOT EXISTS agent_tokens (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      token_prefix TEXT NOT NULL,
      scopes TEXT NOT NULL DEFAULT '[]',
      assignee_id TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT,
      last_used_at TEXT,
      revoked INTEGER NOT NULL DEFAULT 0
    )`,
    args: [],
  })
  await db.execute({
    sql: `CREATE INDEX IF NOT EXISTS idx_agent_tokens_hash ON agent_tokens(token_hash)`,
    args: [],
  })
  // Links a token to the assignee it acts as, so "my tasks" comes from the credential.
  const columns = await db.execute("PRAGMA table_info(agent_tokens)")
  if (!columns.rows.some(row => row.name === "assignee_id")) {
    await db.execute("ALTER TABLE agent_tokens ADD COLUMN assignee_id TEXT").catch(async error => {
      // A concurrent bootstrap may have added the column first.
      const retry = await db.execute("PRAGMA table_info(agent_tokens)")
      if (!retry.rows.some(row => row.name === "assignee_id")) throw error
    })
  }
}

// ── CRUD Operations ──────────────────────────────────────────────────────────

interface CreateTokenInput {
  id: string
  name: string
  tokenHash: string
  tokenPrefix: string
  scopes: AgentScope[]
  assigneeId?: string | null
  expiresAt?: string | null
}

/**
 * Insert a new agent token record.
 * The caller is responsible for generating the token and hashing it.
 */
export async function createAgentToken(input: CreateTokenInput): Promise<AgentTokenRecord> {
  const db = getPersistenceClient()
  const now = new Date().toISOString()

  await db.execute({
    sql: `INSERT INTO agent_tokens (id, name, token_hash, token_prefix, scopes, assignee_id, created_at, expires_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      input.id,
      input.name,
      input.tokenHash,
      input.tokenPrefix,
      JSON.stringify(input.scopes),
      input.assigneeId ?? null,
      now,
      input.expiresAt ?? null,
    ],
  })

  return {
    id: input.id,
    name: input.name,
    tokenHash: input.tokenHash,
    tokenPrefix: input.tokenPrefix,
    scopes: input.scopes,
    assigneeId: input.assigneeId ?? null,
    createdAt: now,
    expiresAt: input.expiresAt ?? null,
    lastUsedAt: null,
    revoked: false,
  }
}

/** List all tokens (excluding revoked unless includeRevoked is true) */
export async function listAgentTokens(includeRevoked = false): Promise<AgentTokenRecord[]> {
  const db = getPersistenceClient()
  const whereClause = includeRevoked ? "" : "WHERE revoked = 0"
  const result = await db.execute({
    sql: `SELECT id, name, token_hash, token_prefix, scopes, assignee_id, created_at, expires_at, last_used_at, revoked
          FROM agent_tokens ${whereClause}
          ORDER BY created_at DESC`,
    args: [],
  })

  return result.rows.map(rowToRecord)
}

/** Look up a token by its SHA-256 hash */
export async function getAgentTokenByHash(tokenHash: string): Promise<AgentTokenRecord | null> {
  const db = getPersistenceClient()
  const result = await db.execute({
    sql: `SELECT id, name, token_hash, token_prefix, scopes, assignee_id, created_at, expires_at, last_used_at, revoked
          FROM agent_tokens
          WHERE token_hash = ?`,
    args: [tokenHash],
  })

  if (result.rows.length === 0) return null
  return rowToRecord(result.rows[0]!)
}

/** Revoke a token (soft-delete — keeps record for audit) */
export async function revokeAgentToken(id: string): Promise<boolean> {
  const db = getPersistenceClient()
  const result = await db.execute({
    sql: `UPDATE agent_tokens SET revoked = 1 WHERE id = ?`,
    args: [id],
  })
  return (result.rowsAffected ?? 0) > 0
}

/** Hard-delete a token */
export async function deleteAgentToken(id: string): Promise<boolean> {
  const db = getPersistenceClient()
  const result = await db.execute({
    sql: `DELETE FROM agent_tokens WHERE id = ?`,
    args: [id],
  })
  return (result.rowsAffected ?? 0) > 0
}

/** Update token name and/or scopes */
export async function updateAgentToken(
  id: string,
  updates: { name?: string; scopes?: AgentScope[]; assigneeId?: string | null },
): Promise<boolean> {
  const db = getPersistenceClient()
  const setClauses: string[] = []
  const args: (string | null)[] = []

  if (updates.name !== undefined) {
    setClauses.push("name = ?")
    args.push(updates.name)
  }
  if (updates.scopes !== undefined) {
    setClauses.push("scopes = ?")
    args.push(JSON.stringify(updates.scopes))
  }
  if (updates.assigneeId !== undefined) {
    setClauses.push("assignee_id = ?")
    args.push(updates.assigneeId ?? null)
  }

  if (setClauses.length === 0) return false

  args.push(id)
  const result = await db.execute({
    sql: `UPDATE agent_tokens SET ${setClauses.join(", ")} WHERE id = ?`,
    args,
  })
  return (result.rowsAffected ?? 0) > 0
}

/** Record last-used timestamp (called on successful auth) */
export async function updateAgentTokenLastUsed(id: string): Promise<void> {
  const db = getPersistenceClient()
  await db.execute({
    sql: `UPDATE agent_tokens SET last_used_at = ? WHERE id = ?`,
    args: [new Date().toISOString(), id],
  })
}

// ── Row Mapping ──────────────────────────────────────────────────────────────

function rowToRecord(row: Record<string, unknown>): AgentTokenRecord {
  let scopes: AgentScope[] = []
  try {
    const parsed = JSON.parse(String(row.scopes ?? "[]"))
    if (Array.isArray(parsed)) scopes = parsed
  } catch { /* default to empty */ }

  return {
    id: String(row.id),
    name: String(row.name),
    tokenHash: String(row.token_hash),
    tokenPrefix: String(row.token_prefix),
    scopes,
    assigneeId: typeof row.assignee_id === "string" && row.assignee_id ? row.assignee_id : null,
    createdAt: String(row.created_at),
    expiresAt: row.expires_at ? String(row.expires_at) : null,
    lastUsedAt: row.last_used_at ? String(row.last_used_at) : null,
    revoked: Boolean(row.revoked),
  }
}
