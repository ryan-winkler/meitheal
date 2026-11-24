import type { Client } from "@libsql/client"
import { randomUUID } from "node:crypto"
import { ensureSchema, getPersistenceClient, sql, sourceSql, joinSql } from "@domains/tasks"
import {
  pillarOperationClient,
  pillarOwnedBy,
  pillarStorageOwner,
  type PillarOwnerScope
} from "./pillar-owner"

export const MAX_RECOMMENDED_PILLARS = 7
export const SUGGESTED_PILLAR_COUNT = { min: 3, max: 5 }
export async function ensurePillarSchema(): Promise<void> {
  await ensureSchema()
}
export function resetPillarSchemaForTests(): void {}

export interface Pillar {
  id: string
  slug: string
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

export function generateSlug(name: string): string {
  return (
    name
      .toLowerCase()
      .trim()
      .replace(/[^\w\s-]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "") || "pillar"
  )
}
export function toPillar(row: Record<string, unknown>): Pillar {
  return {
    id: String(row.id),
    slug: row.slug ? String(row.slug) : generateSlug(String(row.name)),
    userId: String(row.user_id),
    name: String(row.name),
    manifesto: row.manifesto ? String(row.manifesto) : null,
    icon: String(row.icon),
    colorHex: String(row.color_hex),
    weight: Number(row.weight),
    position: Number(row.position),
    isActive: Number(row.is_active) === 1,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at)
  }
}
export async function createPillar(
  owner: PillarOwnerScope,
  data: {
    name: string
    manifesto?: string | null
    icon?: string
    colorHex?: string
    weight?: number
  },
  database?: Client
): Promise<Pillar> {
  if (!database) await ensurePillarSchema()
  const client = pillarOperationClient(database ?? getPersistenceClient(), owner, "create")
  const id = `pillar_${randomUUID()}`
  const slug = `${generateSlug(data.name)}-${randomUUID().slice(0, 8)}`
  const now = Date.now(),
    storage = pillarStorageOwner(owner)
  const {
    rows: [row]
  } =
    await client.execute(sql`INSERT INTO pillars(id,slug,user_id,name,manifesto,icon,color_hex,weight,position,is_active,created_at,updated_at,owner_board_id)
    VALUES (${id},${slug},${storage.userId},${data.name},${data.manifesto ?? null},${data.icon ?? "🏛️"},${data.colorHex ?? "#6366f1"},${Math.max(1, Math.min(10, data.weight ?? 1))},
      (SELECT COALESCE(MAX(position),-1)+1 FROM pillars WHERE ${pillarOwnedBy(owner)}),1,${now},${now},${storage.boardId}) RETURNING *`)
  if (!row) throw new Error("Pillar creation could not be confirmed")
  return toPillar(row)
}
export async function getPillars(
  owner: PillarOwnerScope,
  opts?: { includeInactive?: boolean },
  database?: Client
): Promise<Pillar[]> {
  if (!database) await ensurePillarSchema()
  const { rows } = await pillarOperationClient(
    database ?? getPersistenceClient(),
    owner,
    "read"
  ).execute(
    sql`SELECT * FROM pillars WHERE ${pillarOwnedBy(owner)} ${opts?.includeInactive ? sourceSql("") : sourceSql("AND is_active=1")} ORDER BY position,id`
  )
  return rows.map(toPillar)
}
export async function getPillarById(
  owner: PillarOwnerScope,
  id: string,
  database?: Client
): Promise<Pillar | null> {
  if (!database) await ensurePillarSchema()
  const {
    rows: [row]
  } = await pillarOperationClient(database ?? getPersistenceClient(), owner, "read").execute(
    sql`SELECT * FROM pillars WHERE id=${id} AND ${pillarOwnedBy(owner)}`
  )
  return row ? toPillar(row) : null
}
export async function getPillarBySlug(
  owner: PillarOwnerScope,
  slug: string,
  database?: Client
): Promise<Pillar | null> {
  if (!database) await ensurePillarSchema()
  const {
    rows: [row]
  } = await pillarOperationClient(database ?? getPersistenceClient(), owner, "read").execute(
    sql`SELECT * FROM pillars WHERE slug=${slug} AND ${pillarOwnedBy(owner)}`
  )
  return row ? toPillar(row) : null
}
export async function updatePillar(
  owner: PillarOwnerScope,
  id: string,
  data: Partial<{
    name: string
    manifesto: string | null
    icon: string
    colorHex: string
    weight: number
    position: number
    isActive: boolean
  }>,
  database?: Client
): Promise<boolean> {
  if (!database) await ensurePillarSchema()
  const sets = []
  if (data.name !== undefined) sets.push(sql`name=${data.name}`)
  if (data.manifesto !== undefined) sets.push(sql`manifesto=${data.manifesto}`)
  if (data.icon !== undefined) sets.push(sql`icon=${data.icon}`)
  if (data.colorHex !== undefined) sets.push(sql`color_hex=${data.colorHex}`)
  if (data.weight !== undefined) sets.push(sql`weight=${Math.max(1, Math.min(10, data.weight))}`)
  if (data.position !== undefined) sets.push(sql`position=${data.position}`)
  if (data.isActive !== undefined) sets.push(sql`is_active=${data.isActive ? 1 : 0}`)
  if (!sets.length) return false
  sets.push(sql`updated_at=${Date.now()}`)
  const { rowsAffected } = await pillarOperationClient(
    database ?? getPersistenceClient(),
    owner,
    "edit"
  ).execute(sql`UPDATE pillars SET ${joinSql(sets)} WHERE id=${id} AND ${pillarOwnedBy(owner)}`)
  return rowsAffected > 0
}
export async function deletePillar(
  owner: PillarOwnerScope,
  id: string,
  hard = false,
  database?: Client
): Promise<boolean> {
  if (!database) await ensurePillarSchema()
  const client = pillarOperationClient(database ?? getPersistenceClient(), owner, "delete")
  const statement = hard
    ? sql`DELETE FROM pillars WHERE id=${id} AND ${pillarOwnedBy(owner)}`
    : sql`UPDATE pillars SET is_active=0,updated_at=${Date.now()} WHERE id=${id} AND ${pillarOwnedBy(owner)}`
  return (await client.execute(statement)).rowsAffected > 0
}
export async function countActivePillars(
  owner: PillarOwnerScope,
  database?: Client
): Promise<number> {
  if (!database) await ensurePillarSchema()
  const {
    rows: [row]
  } = await pillarOperationClient(database ?? getPersistenceClient(), owner, "read").execute(
    sql`SELECT COUNT(*) AS count FROM pillars WHERE is_active=1 AND ${pillarOwnedBy(owner)}`
  )
  return Number(row?.count ?? 0)
}
