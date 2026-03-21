/**
 * Pillar Domain — Core Service
 *
 * @domain pillars
 * @bounded-context pillars
 *
 * Manages Pillars — permanent identity-based motivational anchors.
 * Pillars answer "WHO am I?" and are the WHY behind Goals, Routines, and Tasks.
 *
 * @kcs Pillars use identity framing: "I am someone who honors my health."
 * @kcs Shame-free design: No failure states, no streak counters, no red badges.
 * @kcs Max 7 active Pillars — cognitive load guardrail for ADHD users.
 *
 * @see docs/decisions/ADR-017-pillars-domain.md
 * @see docs/kcs/hierarchy-glossary.md
 */

import {
  ensureSchema,
  getPersistenceClient,
} from "../tasks/persistence/store"

// ── Schema ──────────────────────────────────────────────────────

let schemaEnsured = false

/** Recommended max active Pillars — cognitive load guardrail */
export const MAX_RECOMMENDED_PILLARS = 7
/** Suggested starting count for onboarding */
export const SUGGESTED_PILLAR_COUNT = { min: 3, max: 5 }

export async function ensurePillarSchema(): Promise<void> {
  if (schemaEnsured) return
  await ensureSchema()
  const client = getPersistenceClient()

  await client.execute(`
    CREATE TABLE IF NOT EXISTS pillars (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL DEFAULT 'default',
      name TEXT NOT NULL,
      manifesto TEXT,
      icon TEXT NOT NULL DEFAULT '🏛️',
      color_hex TEXT NOT NULL DEFAULT '#6366f1',
      weight INTEGER NOT NULL DEFAULT 1,
      position INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `)

  await client.execute("CREATE INDEX IF NOT EXISTS pillars_position_idx ON pillars(position)")
  await client.execute("CREATE INDEX IF NOT EXISTS pillars_active_idx ON pillars(is_active)")
  await client.execute("CREATE INDEX IF NOT EXISTS pillars_user_idx ON pillars(user_id)")

  schemaEnsured = true
}

// ── Types ───────────────────────────────────────────────────────

export interface Pillar {
  id: string
  userId: string
  name: string
  manifesto: string | null
  icon: string
  colorHex: string
  weight: number
  position: number
  isActive: boolean
  createdAt: number
  updatedAt: number
}

// ── Helpers ─────────────────────────────────────────────────────

function generateId(): string {
  return `pillar_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

function toPillar(row: Record<string, unknown>): Pillar {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    name: String(row.name),
    manifesto: row.manifesto ? String(row.manifesto) : null,
    icon: String(row.icon),
    colorHex: String(row.color_hex),
    weight: Number(row.weight),
    position: Number(row.position),
    isActive: Number(row.is_active) === 1,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
}

// ── CRUD ────────────────────────────────────────────────────────

export async function createPillar(data: {
  name: string
  manifesto?: string | null
  icon?: string
  colorHex?: string
  weight?: number
}): Promise<Pillar> {
  await ensurePillarSchema()
  const client = getPersistenceClient()
  const id = generateId()
  const now = Date.now()

  const weight = Math.max(1, Math.min(10, data.weight ?? 1))

  const posResult = await client.execute(
    "SELECT COALESCE(MAX(position), -1) + 1 as next_pos FROM pillars WHERE is_active = 1"
  )
  const position = Number((posResult.rows[0] as Record<string, unknown>).next_pos)

  await client.execute({
    sql: `INSERT INTO pillars (id, user_id, name, manifesto, icon, color_hex, weight, position, is_active, created_at, updated_at)
          VALUES (?, 'default', ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    args: [
      id,
      data.name,
      data.manifesto ?? null,
      data.icon ?? "🏛️",
      data.colorHex ?? "#6366f1",
      weight,
      position,
      now, now,
    ],
  })

  return {
    id,
    userId: "default",
    name: data.name,
    manifesto: data.manifesto ?? null,
    icon: data.icon ?? "🏛️",
    colorHex: data.colorHex ?? "#6366f1",
    weight,
    position,
    isActive: true,
    createdAt: now,
    updatedAt: now,
  }
}

export async function getPillars(opts?: { includeInactive?: boolean }): Promise<Pillar[]> {
  await ensurePillarSchema()
  const client = getPersistenceClient()
  const where = opts?.includeInactive ? "" : "WHERE is_active = 1"

  const result = await client.execute(`SELECT * FROM pillars ${where} ORDER BY position ASC`)
  return result.rows.map(row => toPillar(row as Record<string, unknown>))
}

export async function getPillarById(id: string): Promise<Pillar | null> {
  await ensurePillarSchema()
  const client = getPersistenceClient()

  const result = await client.execute({
    sql: "SELECT * FROM pillars WHERE id = ?",
    args: [id],
  })

  if (result.rows.length === 0) return null
  return toPillar(result.rows[0] as Record<string, unknown>)
}

export async function updatePillar(
  id: string,
  data: Partial<{
    name: string
    manifesto: string | null
    icon: string
    colorHex: string
    weight: number
    position: number
    isActive: boolean
  }>
): Promise<boolean> {
  await ensurePillarSchema()
  const client = getPersistenceClient()

  const sets: string[] = []
  const args: unknown[] = []

  if (data.name !== undefined) { sets.push("name = ?"); args.push(data.name) }
  if (data.manifesto !== undefined) { sets.push("manifesto = ?"); args.push(data.manifesto) }
  if (data.icon !== undefined) { sets.push("icon = ?"); args.push(data.icon) }
  if (data.colorHex !== undefined) { sets.push("color_hex = ?"); args.push(data.colorHex) }
  if (data.weight !== undefined) { sets.push("weight = ?"); args.push(Math.max(1, Math.min(10, data.weight))) }
  if (data.position !== undefined) { sets.push("position = ?"); args.push(data.position) }
  if (data.isActive !== undefined) { sets.push("is_active = ?"); args.push(data.isActive ? 1 : 0) }

  if (sets.length === 0) return false

  sets.push("updated_at = ?")
  args.push(Date.now())
  args.push(id)

  const result = await client.execute({
    sql: `UPDATE pillars SET ${sets.join(", ")} WHERE id = ?`,
    args,
  })

  return (result.rowsAffected ?? 0) > 0
}

export async function deletePillar(id: string, hard = false): Promise<boolean> {
  await ensurePillarSchema()
  const client = getPersistenceClient()

  if (hard) {
    const result = await client.execute({
      sql: "DELETE FROM pillars WHERE id = ?",
      args: [id],
    })
    return (result.rowsAffected ?? 0) > 0
  }

  const result = await client.execute({
    sql: "UPDATE pillars SET is_active = 0, updated_at = ? WHERE id = ?",
    args: [Date.now(), id],
  })
  return (result.rowsAffected ?? 0) > 0
}

export async function countActivePillars(): Promise<number> {
  await ensurePillarSchema()
  const client = getPersistenceClient()
  const result = await client.execute("SELECT COUNT(*) as cnt FROM pillars WHERE is_active = 1")
  return Number((result.rows[0] as Record<string, unknown>).cnt)
}

/** Reset for tests */
export function resetPillarSchemaForTests(): void {
  schemaEnsured = false
}
