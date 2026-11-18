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

import { pillarAssociationTableSql } from "../../../drizzle/migrations/pillar-storage-schema.mjs"
import { randomUUID } from "node:crypto"
import type { Row } from "@libsql/client"
import { getPersistenceClient } from "../tasks/persistence/store"
import { ensurePillarSchema, HOUSEHOLD_PILLAR_OWNER, type Pillar } from "./pillar-service"

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
  await client.execute(pillarAssociationTableSql)

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

const householdPillar = (id: string) => `SELECT 1 FROM pillars
  WHERE id = ${id} AND owner_board_id IS NULL AND EXISTS (SELECT 1 FROM task_boards WHERE id = 'household' AND state = 'active') AND user_id = '${HOUSEHOLD_PILLAR_OWNER}'`

const householdEntity = (kind: string, id: string) => `(
  (${kind} = 'goal' AND EXISTS (SELECT 1 FROM goals WHERE id = ${id} AND owner_board_id IS NULL AND retired_at IS NULL))
  OR (${kind} = 'routine' AND EXISTS (SELECT 1 FROM task_templates WHERE id = ${id} AND owner_board_id IS NULL AND is_routine = 1))
  OR (${kind} = 'task' AND EXISTS (SELECT 1 FROM tasks WHERE id = ${id} AND task_board_id IS NULL AND EXISTS (SELECT 1 FROM task_boards WHERE id = 'household' AND state = 'active')))
)`

function mapAssociation(row: Row): PillarAssociation {
  return {
    id: String(row.id),
    pillarId: String(row.pillar_id),
    entityType: String(row.entity_type) as PillarEntityType,
    entityId: String(row.entity_id),
    createdAt: Number(row.created_at),
  }
}

// ── M2M Association CRUD ────────────────────────────────────────

function generateId(): string {
  return `pa_${Date.now()}_${randomUUID().slice(0, 8)}`
}

export async function linkEntity(
  pillarId: string,
  entityType: PillarEntityType,
  entityId: string
): Promise<PillarAssociation | null> {
  await ensureAssociationSchema()
  const client = getPersistenceClient()

  if (!VALID_PILLAR_ENTITY_TYPES.includes(entityType)) {
    throw new Error(`Invalid entity type: ${entityType}. Must be one of: ${VALID_PILLAR_ENTITY_TYPES.join(", ")}`)
  }

  const [, existing] = await client.batch([
    {
      sql: `WITH target(kind, entity_id) AS (VALUES (?, ?))
            INSERT OR IGNORE INTO pillar_associations (id, pillar_id, entity_type, entity_id, created_at)
            SELECT ?, ?, kind, entity_id, ? FROM target
            WHERE EXISTS (${householdPillar("?")}) AND ${householdEntity("target.kind", "target.entity_id")}`,
      args: [entityType, entityId, generateId(), pillarId, Date.now(), pillarId],
    }, {
      sql: `SELECT * FROM pillar_associations AS link
            WHERE link.pillar_id = ? AND link.entity_type = ? AND link.entity_id = ?
              AND EXISTS (${householdPillar("link.pillar_id")}) AND ${householdEntity("link.entity_type", "link.entity_id")}`,
      args: [pillarId, entityType, entityId],
    },
  ], "write")
  const row = existing?.rows[0]
  return row ? mapAssociation(row) : null
}

export async function unlinkEntity(
  pillarId: string,
  entityType: PillarEntityType,
  entityId: string
): Promise<boolean> {
  await ensureAssociationSchema()
  const client = getPersistenceClient()

  const result = await client.execute({
    sql: `DELETE FROM pillar_associations AS link WHERE pillar_id = ? AND entity_type = ? AND entity_id = ?
      AND EXISTS (${householdPillar("link.pillar_id")}) AND ${householdEntity("link.entity_type", "link.entity_id")}`,
    args: [pillarId, entityType, entityId],
  })

  return (result.rowsAffected ?? 0) > 0
}

export async function getAssociationsForPillar(pillarId: string): Promise<PillarAssociation[]> {
  await ensureAssociationSchema()
  const client = getPersistenceClient()

  const result = await client.execute({
    sql: `SELECT * FROM pillar_associations AS link WHERE pillar_id = ?
      AND EXISTS (${householdPillar("link.pillar_id")}) AND ${householdEntity("link.entity_type", "link.entity_id")}
      ORDER BY created_at ASC, id ASC`,
    args: [pillarId],
  })
  return result.rows.map(mapAssociation)
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
      WHERE pa.entity_type = ? AND pa.entity_id = ? AND p.is_active = 1 AND p.owner_board_id IS NULL AND EXISTS (SELECT 1 FROM task_boards WHERE id = 'household' AND state = 'active') AND p.user_id = ?
        AND ${householdEntity("pa.entity_type", "pa.entity_id")}
      ORDER BY p.weight DESC, p.position ASC
    `,
    args: [entityType, entityId, HOUSEHOLD_PILLAR_OWNER],
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

  const scope = table === "tasks" ? "task_board_id IS NULL AND EXISTS (SELECT 1 FROM task_boards WHERE id = 'household' AND state = 'active')" : table === "goals" ? "owner_board_id IS NULL AND retired_at IS NULL" : "owner_board_id IS NULL AND is_routine = 1"
  const result = await client.execute({
    sql: `UPDATE ${table} SET pillar_id = ? WHERE id = ? AND ${scope}
      AND (pillar_id IS NULL OR EXISTS (${householdPillar(`${table}.pillar_id`)}))
      AND (? IS NULL OR EXISTS (${householdPillar("?")}))`,
    args: [pillarId, entityId, pillarId, pillarId],
  })

  return (result.rowsAffected ?? 0) > 0
}

export async function getEntityPillarId(
  table: "goals" | "tasks" | "task_templates",
  entityId: string
): Promise<string | null> {
  await ensureAssociationSchema()
  const client = getPersistenceClient()

  const scope = table === "tasks" ? "task_board_id IS NULL AND EXISTS (SELECT 1 FROM task_boards WHERE id = 'household' AND state = 'active')" : table === "goals" ? "owner_board_id IS NULL AND retired_at IS NULL" : "owner_board_id IS NULL AND is_routine = 1"
  const result = await client.execute({
    sql: `SELECT pillar_id FROM ${table} WHERE id = ? AND ${scope}
      AND EXISTS (${householdPillar(`${table}.pillar_id`)})`,
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
