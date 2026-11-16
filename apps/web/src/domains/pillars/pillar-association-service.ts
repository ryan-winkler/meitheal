/**
 * Pillar Association — Service
 *
 * @domain pillars
 * @bounded-context pillars
 *
 * Manages M2M associations between Pillars and entities (Goals, Routines, Tasks).
 * Also handles the ALTER TABLE migration for direct `pillar_id` FK on entity tables.
 *
 * Dual strategy:
 * - Primary: Direct `pillar_id` FK on goals/tasks/task_templates (one Pillar per entity)
 * - Secondary: `pillar_associations` M2M table (cross-cutting, multiple Pillars per entity)
 *
 * Inheritance: Task.pillar_id ?? Goal.pillar_id ?? null ("unaligned")
 *
 * @see docs/decisions/ADR-017-pillars-domain.md
 */

import { randomUUID } from "node:crypto"
import { getPersistenceClient } from "../tasks/persistence/store"
import { ensurePillarSchema, type Pillar } from "./pillar-service"

// ── Schema ──────────────────────────────────────────────────────

let associationSchemaEnsured = false

/** Valid entity types for Pillar associations */
export const VALID_PILLAR_ENTITY_TYPES = ["goal", "routine", "task"] as const
export type PillarEntityType = typeof VALID_PILLAR_ENTITY_TYPES[number]

export async function ensureAssociationSchema(): Promise<void> {
  if (associationSchemaEnsured) return
  await ensurePillarSchema()
  const client = getPersistenceClient()

  // M2M join table
  await client.execute(`
    CREATE TABLE IF NOT EXISTS pillar_associations (
      id TEXT PRIMARY KEY,
      pillar_id TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (pillar_id) REFERENCES pillars(id) ON DELETE CASCADE,
      UNIQUE(pillar_id, entity_type, entity_id)
    )
  `)

  await client.execute("CREATE INDEX IF NOT EXISTS pillar_assoc_pillar_idx ON pillar_associations(pillar_id)")
  await client.execute("CREATE INDEX IF NOT EXISTS pillar_assoc_entity_idx ON pillar_associations(entity_type, entity_id)")

  // Direct FK columns — idempotent ALTER TABLE with error catching
  const tables = ["goals", "tasks", "task_templates"]
  for (const table of tables) {
    try {
      await client.execute(`ALTER TABLE ${table} ADD COLUMN pillar_id TEXT`)
    } catch {
      // Column already exists — safe to ignore
    }
  }

  associationSchemaEnsured = true
}

// ── Types ───────────────────────────────────────────────────────

export interface PillarAssociation {
  id: string
  pillarId: string
  entityType: PillarEntityType
  entityId: string
  createdAt: number
}

// ── M2M Association CRUD ────────────────────────────────────────

function generateId(): string {
  return `pa_${Date.now()}_${randomUUID().slice(0, 8)}`
}

export async function linkEntity(
  pillarId: string,
  entityType: PillarEntityType,
  entityId: string
): Promise<PillarAssociation> {
  await ensureAssociationSchema()
  const client = getPersistenceClient()

  if (!VALID_PILLAR_ENTITY_TYPES.includes(entityType)) {
    throw new Error(`Invalid entity type: ${entityType}. Must be one of: ${VALID_PILLAR_ENTITY_TYPES.join(", ")}`)
  }

  const id = generateId()
  const now = Date.now()

  await client.execute({
    sql: `INSERT OR IGNORE INTO pillar_associations (id, pillar_id, entity_type, entity_id, created_at)
          VALUES (?, ?, ?, ?, ?)`,
    args: [id, pillarId, entityType, entityId, now],
  })

  return { id, pillarId, entityType, entityId, createdAt: now }
}

export async function unlinkEntity(
  pillarId: string,
  entityType: PillarEntityType,
  entityId: string
): Promise<boolean> {
  await ensureAssociationSchema()
  const client = getPersistenceClient()

  const result = await client.execute({
    sql: "DELETE FROM pillar_associations WHERE pillar_id = ? AND entity_type = ? AND entity_id = ?",
    args: [pillarId, entityType, entityId],
  })

  return (result.rowsAffected ?? 0) > 0
}

export async function getAssociationsForPillar(pillarId: string): Promise<PillarAssociation[]> {
  await ensureAssociationSchema()
  const client = getPersistenceClient()

  const result = await client.execute({
    sql: "SELECT * FROM pillar_associations WHERE pillar_id = ? ORDER BY created_at ASC",
    args: [pillarId],
  })

  return result.rows.map(row => {
    const r = row as Record<string, unknown>
    return {
      id: String(r.id),
      pillarId: String(r.pillar_id),
      entityType: String(r.entity_type) as PillarEntityType,
      entityId: String(r.entity_id),
      createdAt: Number(r.created_at),
    }
  })
}

export async function getPillarsForEntity(
  entityType: PillarEntityType,
  entityId: string
): Promise<Pillar[]> {
  await ensureAssociationSchema()
  const client = getPersistenceClient()

  const result = await client.execute({
    sql: `
      SELECT p.* FROM pillars p
      INNER JOIN pillar_associations pa ON pa.pillar_id = p.id
      WHERE pa.entity_type = ? AND pa.entity_id = ? AND p.is_active = 1
      ORDER BY p.weight DESC, p.position ASC
    `,
    args: [entityType, entityId],
  })

  return result.rows.map(row => {
    const r = row as Record<string, unknown>
    return {
      id: String(r.id),
      slug: String(r.slug),
      userId: String(r.user_id),
      name: String(r.name),
      manifesto: r.manifesto ? String(r.manifesto) : null,
      icon: String(r.icon),
      colorHex: String(r.color_hex),
      weight: Number(r.weight),
      position: Number(r.position),
      isActive: Number(r.is_active) === 1,
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at),
    }
  })
}

// ── Direct FK Operations ────────────────────────────────────────

export async function setEntityPillar(
  table: "goals" | "tasks" | "task_templates",
  entityId: string,
  pillarId: string | null
): Promise<boolean> {
  await ensureAssociationSchema()
  const client = getPersistenceClient()

  const result = await client.execute({
    sql: `UPDATE ${table} SET pillar_id = ? WHERE id = ?`,
    args: [pillarId, entityId],
  })

  return (result.rowsAffected ?? 0) > 0
}

export async function getEntityPillarId(
  table: "goals" | "tasks" | "task_templates",
  entityId: string
): Promise<string | null> {
  await ensureAssociationSchema()
  const client = getPersistenceClient()

  const result = await client.execute({
    sql: `SELECT pillar_id FROM ${table} WHERE id = ?`,
    args: [entityId],
  })

  if (result.rows.length === 0) return null
  const val = (result.rows[0] as Record<string, unknown>).pillar_id
  return val ? String(val) : null
}

/** Reset for tests */
export function resetAssociationSchemaForTests(): void {
  associationSchemaEnsured = false
}
