/**
 * Principle Domain — Service
 *
 * @domain pillars
 * @bounded-context pillars
 *
 * Manages Principles / Non-Negotiables — behavioral boundaries within a Pillar.
 * Principles are the absolute rules governing behavior: "No screens after 9 PM."
 *
 * @kcs Principles with `isNonNegotiable = true` are injected into AI system prompts.
 * @kcs Principle violations trigger toast warnings, NEVER hard-blocks.
 *
 * @see docs/decisions/ADR-017-pillars-domain.md
 */

import { getPersistenceClient } from "../tasks/persistence/store"
import { ensurePillarSchema } from "./pillar-service"

// ── Schema ──────────────────────────────────────────────────────

let principleSchemaEnsured = false

export async function ensurePrincipleSchema(): Promise<void> {
  if (principleSchemaEnsured) return
  await ensurePillarSchema()
  const client = getPersistenceClient()

  await client.execute(`
    CREATE TABLE IF NOT EXISTS principles (
      id TEXT PRIMARY KEY,
      pillar_id TEXT NOT NULL,
      statement TEXT NOT NULL,
      is_non_negotiable INTEGER NOT NULL DEFAULT 0,
      position INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (pillar_id) REFERENCES pillars(id) ON DELETE CASCADE
    )
  `)

  await client.execute("CREATE INDEX IF NOT EXISTS principles_pillar_idx ON principles(pillar_id)")
  await client.execute("CREATE INDEX IF NOT EXISTS principles_non_neg_idx ON principles(is_non_negotiable)")

  principleSchemaEnsured = true
}

// ── Types ───────────────────────────────────────────────────────

export interface Principle {
  id: string
  pillarId: string
  statement: string
  isNonNegotiable: boolean
  position: number
  createdAt: number
}

// ── Helpers ─────────────────────────────────────────────────────

function generateId(): string {
  return `princ_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

function toPrinciple(row: Record<string, unknown>): Principle {
  return {
    id: String(row.id),
    pillarId: String(row.pillar_id),
    statement: String(row.statement),
    isNonNegotiable: Number(row.is_non_negotiable) === 1,
    position: Number(row.position),
    createdAt: Number(row.created_at),
  }
}

// ── CRUD ────────────────────────────────────────────────────────

export async function createPrinciple(data: {
  pillarId: string
  statement: string
  isNonNegotiable?: boolean
}): Promise<Principle> {
  await ensurePrincipleSchema()
  const client = getPersistenceClient()
  const id = generateId()
  const now = Date.now()

  const posResult = await client.execute({
    sql: "SELECT COALESCE(MAX(position), -1) + 1 as next_pos FROM principles WHERE pillar_id = ?",
    args: [data.pillarId],
  })
  const position = Number((posResult.rows[0] as Record<string, unknown>).next_pos)

  await client.execute({
    sql: `INSERT INTO principles (id, pillar_id, statement, is_non_negotiable, position, created_at)
          VALUES (?, ?, ?, ?, ?, ?)`,
    args: [
      id,
      data.pillarId,
      data.statement,
      data.isNonNegotiable ? 1 : 0,
      position,
      now,
    ],
  })

  return {
    id,
    pillarId: data.pillarId,
    statement: data.statement,
    isNonNegotiable: data.isNonNegotiable ?? false,
    position,
    createdAt: now,
  }
}

export async function getPrinciplesForPillar(pillarId: string): Promise<Principle[]> {
  await ensurePrincipleSchema()
  const client = getPersistenceClient()

  const result = await client.execute({
    sql: "SELECT * FROM principles WHERE pillar_id = ? ORDER BY position ASC",
    args: [pillarId],
  })

  return result.rows.map(row => toPrinciple(row as Record<string, unknown>))
}

/**
 * Batch-fetch all principles, grouped by pillar ID.
 * Avoids N+1 queries when rendering multiple PillarCards.
 *
 * @returns Map<pillarId, Principle[]> sorted by position within each pillar
 */
export async function getAllPrinciples(): Promise<Map<string, Principle[]>> {
  await ensurePrincipleSchema()
  const client = getPersistenceClient()

  const result = await client.execute(
    "SELECT * FROM principles ORDER BY pillar_id, position ASC"
  )

  const map = new Map<string, Principle[]>()
  for (const row of result.rows) {
    const p = toPrinciple(row as Record<string, unknown>)
    const list = map.get(p.pillarId) ?? []
    list.push(p)
    map.set(p.pillarId, list)
  }
  return map
}

export async function getNonNegotiablePrinciples(): Promise<Principle[]> {
  await ensurePrincipleSchema()
  const client = getPersistenceClient()

  const result = await client.execute(
    "SELECT p.* FROM principles p INNER JOIN pillars pl ON pl.id = p.pillar_id WHERE p.is_non_negotiable = 1 AND pl.is_active = 1 ORDER BY pl.weight DESC, p.position ASC LIMIT 15"
  )

  return result.rows.map(row => toPrinciple(row as Record<string, unknown>))
}

export async function updatePrinciple(
  id: string,
  data: Partial<{
    statement: string
    isNonNegotiable: boolean
    position: number
  }>
): Promise<boolean> {
  await ensurePrincipleSchema()
  const client = getPersistenceClient()

  const sets: string[] = []
  const args: any[] = []

  if (data.statement !== undefined) { sets.push("statement = ?"); args.push(data.statement) }
  if (data.isNonNegotiable !== undefined) { sets.push("is_non_negotiable = ?"); args.push(data.isNonNegotiable ? 1 : 0) }
  if (data.position !== undefined) { sets.push("position = ?"); args.push(data.position) }

  if (sets.length === 0) return false

  args.push(id)
  const result = await client.execute({
    sql: `UPDATE principles SET ${sets.join(", ")} WHERE id = ?`,
    args,
  })

  return (result.rowsAffected ?? 0) > 0
}

export async function deletePrinciple(id: string): Promise<boolean> {
  await ensurePrincipleSchema()
  const client = getPersistenceClient()

  const result = await client.execute({
    sql: "DELETE FROM principles WHERE id = ?",
    args: [id],
  })

  return (result.rowsAffected ?? 0) > 0
}

/** Reset for tests */
export function resetPrincipleSchemaForTests(): void {
  principleSchemaEnsured = false
}
