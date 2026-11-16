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

import { principleTableSql } from "../../../drizzle/migrations/pillar-storage-schema.mjs"
import { randomUUID } from "node:crypto"
import { getPersistenceClient } from "../tasks/persistence/store"
import { ensurePillarSchema, HOUSEHOLD_PILLAR_OWNER } from "./pillar-service"

// ── Schema ──────────────────────────────────────────────────────

let principleSchemaEnsured = false

export async function ensurePrincipleSchema(): Promise<void> {
  if (principleSchemaEnsured) return
  await ensurePillarSchema()
  const client = getPersistenceClient()

  await client.execute(principleTableSql)

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
  return `princ_${Date.now()}_${randomUUID().slice(0, 8)}`
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
}, owner = HOUSEHOLD_PILLAR_OWNER): Promise<Principle> {
  await ensurePrincipleSchema()
  const client = getPersistenceClient()
  const id = generateId()
  const now = Date.now()

  const result = await client.execute({
    sql: `INSERT INTO principles (id, pillar_id, statement, is_non_negotiable, position, created_at)
          SELECT ?, parent.id, ?, ?,
            (SELECT COALESCE(MAX(position), -1) + 1 FROM principles WHERE pillar_id = parent.id), ?
          FROM pillars parent WHERE parent.id = ? AND parent.owner_board_id IS NULL AND parent.user_id = ?
          RETURNING position`,
    args: [id, data.statement, data.isNonNegotiable ? 1 : 0, now, data.pillarId, owner],
  })
  if (!result.rows[0]) throw new Error("Pillar is no longer available")

  return {
    id,
    pillarId: data.pillarId,
    statement: data.statement,
    isNonNegotiable: data.isNonNegotiable ?? false,
    position: Number(result.rows[0].position),
    createdAt: now,
  }
}

export async function getPrinciplesForPillar(pillarId: string, owner = HOUSEHOLD_PILLAR_OWNER): Promise<Principle[]> {
  await ensurePrincipleSchema()
  const client = getPersistenceClient()

  const result = await client.execute({
    sql: `SELECT p.* FROM principles p JOIN pillars parent ON parent.id = p.pillar_id
          WHERE p.pillar_id = ? AND parent.owner_board_id IS NULL AND parent.user_id = ? ORDER BY p.position ASC`,
    args: [pillarId, owner],
  })

  return result.rows.map(row => toPrinciple(row as Record<string, unknown>))
}

/**
 * Batch-fetch all principles, grouped by pillar ID.
 * Avoids N+1 queries when rendering multiple PillarCards.
 *
 * @returns Map<pillarId, Principle[]> sorted by position within each pillar
 */
export async function getAllPrinciples(personalOwner?: string): Promise<Map<string, Principle[]>> {
  await ensurePrincipleSchema()
  const client = getPersistenceClient()

  const result = await client.execute({
    sql: `SELECT p.* FROM principles p JOIN pillars pl ON pl.id = p.pillar_id
          WHERE pl.owner_board_id IS NULL AND pl.user_id IN (?, ?) ORDER BY p.pillar_id, p.position ASC`,
    args: [HOUSEHOLD_PILLAR_OWNER, personalOwner ?? HOUSEHOLD_PILLAR_OWNER],
  })

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

  const result = await client.execute({
    sql: `SELECT p.* FROM principles p JOIN pillars pl ON pl.id = p.pillar_id
          WHERE p.is_non_negotiable = 1 AND pl.is_active = 1 AND pl.owner_board_id IS NULL AND pl.user_id = ?
          ORDER BY pl.weight DESC, p.position ASC LIMIT 15`,
    args: [HOUSEHOLD_PILLAR_OWNER],
  })

  return result.rows.map(row => toPrinciple(row as Record<string, unknown>))
}

export async function updatePrinciple(
  id: string,
  data: Partial<{
    statement: string
    isNonNegotiable: boolean
    position: number
  }>,
  pillarId?: string,
  owner = HOUSEHOLD_PILLAR_OWNER,
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
  if (pillarId !== undefined) args.push(pillarId)
  args.push(owner)
  const result = await client.execute({
    sql: `UPDATE principles SET ${sets.join(", ")} WHERE id = ?${pillarId === undefined ? "" : " AND pillar_id = ?"}
          AND EXISTS (SELECT 1 FROM pillars WHERE pillars.id = principles.pillar_id AND owner_board_id IS NULL AND user_id = ?)`,
    args,
  })

  return (result.rowsAffected ?? 0) > 0
}

export async function deletePrinciple(id: string, pillarId?: string, owner = HOUSEHOLD_PILLAR_OWNER): Promise<boolean> {
  await ensurePrincipleSchema()
  const client = getPersistenceClient()

  const result = await client.execute({
    sql: `DELETE FROM principles WHERE id = ?${pillarId === undefined ? "" : " AND pillar_id = ?"}
          AND EXISTS (SELECT 1 FROM pillars WHERE pillars.id = principles.pillar_id AND owner_board_id IS NULL AND user_id = ?)`,
    args: pillarId === undefined ? [id, owner] : [id, pillarId, owner],
  })

  return (result.rowsAffected ?? 0) > 0
}

/** Reset for tests */
export function resetPrincipleSchemaForTests(): void {
  principleSchemaEnsured = false
}
