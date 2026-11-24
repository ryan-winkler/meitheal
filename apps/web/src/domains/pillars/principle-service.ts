import type { Client } from "@libsql/client"
import { randomUUID } from "node:crypto"
import { getPersistenceClient, sql, sourceSql, joinSql } from "@domains/tasks"
import { ensurePillarSchema } from "./pillar-service"
import { pillarOperationClient, pillarOwnedBy, type PillarOwnerScope } from "./pillar-owner"
export async function ensurePrincipleSchema(): Promise<void> {
  await ensurePillarSchema()
}
export function resetPrincipleSchemaForTests(): void {}
export interface Principle {
  id: string
  pillarId: string
  statement: string
  isNonNegotiable: boolean
  position: number
  createdAt: number
}

// ── Helpers ─────────────────────────────────────────────────────

function toPrinciple(row: Record<string, unknown>): Principle {
  return {
    id: String(row.id),
    pillarId: String(row.pillar_id),
    statement: String(row.statement),
    isNonNegotiable: Number(row.is_non_negotiable) === 1,
    position: Number(row.position),
    createdAt: Number(row.created_at)
  }
}

export async function createPrinciple(
  owner: PillarOwnerScope,
  data: { pillarId: string; statement: string; isNonNegotiable?: boolean },
  database?: Client
): Promise<Principle> {
  if (!database) await ensurePrincipleSchema()
  const id = `principle_${randomUUID()}`,
    now = Date.now()
  const {
    rows: [row]
  } = await pillarOperationClient(database ?? getPersistenceClient(), owner, "edit", "principles")
    .execute(sql`INSERT INTO principles(id,pillar_id,statement,is_non_negotiable,position,created_at)
    SELECT ${id},parent.id,${data.statement},${data.isNonNegotiable ? 1 : 0},(SELECT COALESCE(MAX(position),-1)+1 FROM principles WHERE pillar_id=parent.id),${now}
    FROM pillars AS parent WHERE parent.id=${data.pillarId} AND ${pillarOwnedBy(owner, "parent")} RETURNING *`)
  if (!row) throw new Error("Pillar is unavailable")
  return toPrinciple(row)
}
export async function getPrinciplesForPillar(
  owner: PillarOwnerScope,
  pillarId: string,
  database?: Client
): Promise<Principle[]> {
  if (!database) await ensurePrincipleSchema()
  const { rows } = await pillarOperationClient(
    database ?? getPersistenceClient(),
    owner,
    "read",
    "principles"
  )
    .execute(sql`SELECT principle.* FROM principles AS principle JOIN pillars AS parent ON parent.id=principle.pillar_id
    WHERE parent.id=${pillarId} AND ${pillarOwnedBy(owner, "parent")} ORDER BY principle.position,principle.id`)
  return rows.map(toPrinciple)
}
export async function getAllPrinciples(
  owner: PillarOwnerScope,
  database?: Client
): Promise<Map<string, Principle[]>> {
  if (!database) await ensurePrincipleSchema()
  const { rows } = await pillarOperationClient(
    database ?? getPersistenceClient(),
    owner,
    "read",
    "principles"
  )
    .execute(sql`SELECT principle.* FROM principles AS principle JOIN pillars AS parent ON parent.id=principle.pillar_id
    WHERE ${pillarOwnedBy(owner, "parent")} ORDER BY principle.pillar_id,principle.position,principle.id`)
  const map = new Map<string, Principle[]>()
  for (const row of rows) {
    const value = toPrinciple(row)
    const list = map.get(value.pillarId) ?? []
    list.push(value)
    map.set(value.pillarId, list)
  }
  return map
}
export async function getNonNegotiablePrinciples(
  owner: PillarOwnerScope,
  database?: Client
): Promise<Principle[]> {
  if (!database) await ensurePrincipleSchema()
  const { rows } = await pillarOperationClient(
    database ?? getPersistenceClient(),
    owner,
    "read",
    "principles"
  )
    .execute(sql`SELECT principle.* FROM principles AS principle JOIN pillars AS parent ON parent.id=principle.pillar_id
    WHERE principle.is_non_negotiable=1 AND parent.is_active=1 AND ${pillarOwnedBy(owner, "parent")} ORDER BY parent.weight DESC,principle.position LIMIT 15`)
  return rows.map(toPrinciple)
}
export async function updatePrinciple(
  owner: PillarOwnerScope,
  id: string,
  data: Partial<{ statement: string; isNonNegotiable: boolean; position: number }>,
  pillarId?: string,
  database?: Client
): Promise<boolean> {
  if (!database) await ensurePrincipleSchema()
  const sets = []
  if (data.statement !== undefined) sets.push(sql`statement=${data.statement}`)
  if (data.isNonNegotiable !== undefined)
    sets.push(sql`is_non_negotiable=${data.isNonNegotiable ? 1 : 0}`)
  if (data.position !== undefined) sets.push(sql`position=${data.position}`)
  if (!sets.length) return false
  const result = await pillarOperationClient(
    database ?? getPersistenceClient(),
    owner,
    "edit",
    "principles"
  ).execute(sql`UPDATE principles SET ${joinSql(sets)} WHERE id=${id}
    ${pillarId === undefined ? sourceSql("") : sql`AND pillar_id=${pillarId}`} AND EXISTS(SELECT 1 FROM pillars AS parent WHERE parent.id=principles.pillar_id AND ${pillarOwnedBy(owner, "parent")})`)
  return result.rowsAffected > 0
}
export async function deletePrinciple(
  owner: PillarOwnerScope,
  id: string,
  pillarId?: string,
  database?: Client
): Promise<boolean> {
  if (!database) await ensurePrincipleSchema()
  const result = await pillarOperationClient(
    database ?? getPersistenceClient(),
    owner,
    "delete",
    "principles"
  )
    .execute(sql`DELETE FROM principles WHERE id=${id} ${pillarId === undefined ? sourceSql("") : sql`AND pillar_id=${pillarId}`}
    AND EXISTS(SELECT 1 FROM pillars AS parent WHERE parent.id=principles.pillar_id AND ${pillarOwnedBy(owner, "parent")})`)
  return result.rowsAffected > 0
}
