import { randomUUID } from "node:crypto"
import type { Client, Row } from "@libsql/client"
import {
  validateBoardPlacement,
  validateBoardScope,
  type BoardScope,
  type WorkAction,
  getPersistenceClient,
  boardPlanningOwnership,
  boardTaskOwnership,
  validateTaskOperation,
  sql,
  sourceSql
} from "@domains/tasks"
import { ensurePillarSchema, toPillar, type Pillar } from "./pillar-service"
import {
  isPersonalPillarScope,
  pillarOperationClient,
  pillarOwnedBy,
  type PillarOwnerScope
} from "./pillar-owner"

export const VALID_PILLAR_ENTITY_TYPES = ["goal", "routine", "task"] as const
export type PillarEntityType = (typeof VALID_PILLAR_ENTITY_TYPES)[number]
export interface PillarAssociation {
  id: string
  pillarId: string
  entityType: PillarEntityType
  entityId: string
  createdAt: number
}
export async function ensureAssociationSchema(): Promise<void> {
  await ensurePillarSchema()
}
export function resetAssociationSchemaForTests(): void {}
function mapAssociation(row: Row): PillarAssociation {
  return {
    id: String(row.id),
    pillarId: String(row.pillar_id),
    entityType: String(row.entity_type) as PillarEntityType,
    entityId: String(row.entity_id),
    createdAt: Number(row.created_at)
  }
}
function selectedTarget(owner: PillarOwnerScope, target?: BoardScope): BoardScope | null {
  if (!isPersonalPillarScope(owner))
    return target && target.boardId !== owner.boardId ? null : owner
  return target &&
    target.principal.kind === owner.principal.kind &&
    target.principal.id === owner.principal.id
    ? target
    : null
}
async function targetAvailable(
  db: Pick<Client, "execute">,
  scope: BoardScope,
  kind: PillarEntityType,
  id: string,
  action: WorkAction
): Promise<boolean> {
  if (!VALID_PILLAR_ENTITY_TYPES.includes(kind)) return false
  const authority = await validateBoardScope(scope, db, { resource: kind, action })
  if (!authority.ok) return false
  if (kind === "task") return validateTaskOperation(db, scope, id, { resource: "task", action })
  const table = { goal: "goals", routine: "task_templates" }[kind]
  const owner = boardPlanningOwnership(scope, "target")
  const area =
    kind === "routine"
      ? sourceSql("json_extract(target.template_json,'$.area_id')")
      : sourceSql("target.area_id")
  const project =
    kind === "routine"
      ? sourceSql("json_extract(target.template_json,'$.project_id')")
      : sourceSql("NULL")
  const {
    rows: [row]
  } =
    await db.execute(sql`SELECT ${area} AS area_id,${project} AS project_id FROM ${sourceSql(table)} AS target WHERE target.id=${id} AND ${owner}
    AND target.retired_at IS NULL
    ${kind === "routine" ? sourceSql("AND target.is_routine=1") : sourceSql("")}
`)
  return Boolean(
    row &&
      (await validateBoardPlacement(scope, db, {
        areaId: typeof row.area_id === "string" ? row.area_id : null,
        projectId: typeof row.project_id === "string" ? row.project_id : null
      }))
  )
}
export async function linkEntity(
  owner: PillarOwnerScope,
  pillarId: string,
  kind: PillarEntityType,
  id: string,
  target?: BoardScope,
  database?: Client
): Promise<PillarAssociation | null> {
  if (!database) await ensureAssociationSchema()
  const scope = selectedTarget(owner, target)
  if (!scope) return null
  const tx = await pillarOperationClient(
    database ?? getPersistenceClient(),
    owner,
    "edit"
  ).transaction("write")
  try {
    if (!(await targetAvailable(tx, scope, kind, id, "edit"))) return null
    await tx.execute(sql`INSERT OR IGNORE INTO pillar_associations(id,pillar_id,entity_type,entity_id,created_at)
      SELECT ${`pa_${randomUUID()}`},parent.id,${kind},${id},${Date.now()} FROM pillars AS parent WHERE parent.id=${pillarId} AND ${pillarOwnedBy(owner, "parent")}`)
    const {
      rows: [row]
    } =
      await tx.execute(sql`SELECT link.* FROM pillar_associations AS link JOIN pillars AS parent ON parent.id=link.pillar_id
      WHERE link.pillar_id=${pillarId} AND link.entity_type=${kind} AND link.entity_id=${id} AND ${pillarOwnedBy(owner, "parent")}`)
    await tx.commit()
    return row ? mapAssociation(row) : null
  } finally {
    tx.close()
  }
}
export async function unlinkEntity(
  owner: PillarOwnerScope,
  pillarId: string,
  kind: PillarEntityType,
  id: string,
  target?: BoardScope,
  database?: Client
): Promise<boolean> {
  if (!database) await ensureAssociationSchema()
  const scope = selectedTarget(owner, target)
  if (!scope) return false
  const tx = await pillarOperationClient(
    database ?? getPersistenceClient(),
    owner,
    "edit"
  ).transaction("write")
  try {
    if (!(await targetAvailable(tx, scope, kind, id, "edit"))) return false
    const result =
      await tx.execute(sql`DELETE FROM pillar_associations WHERE pillar_id=${pillarId} AND entity_type=${kind} AND entity_id=${id}
      AND EXISTS(SELECT 1 FROM pillars AS parent WHERE parent.id=pillar_associations.pillar_id AND ${pillarOwnedBy(owner, "parent")})`)
    await tx.commit()
    return result.rowsAffected > 0
  } finally {
    tx.close()
  }
}
export async function getAssociationsForPillar(
  owner: PillarOwnerScope,
  pillarId: string,
  target?: BoardScope,
  database?: Client
): Promise<PillarAssociation[]> {
  if (!database) await ensureAssociationSchema()
  const scope = selectedTarget(owner, target)
  if (!scope) return []
  const tx = await pillarOperationClient(
    database ?? getPersistenceClient(),
    owner,
    "read"
  ).transaction("read")
  try {
    const { rows } = await tx.execute(
      sql`SELECT link.* FROM pillar_associations AS link JOIN pillars AS parent ON parent.id=link.pillar_id WHERE link.pillar_id=${pillarId} AND ${pillarOwnedBy(owner, "parent")} ORDER BY link.created_at,link.id`
    )
    const result = []
    for (const row of rows)
      if (
        await targetAvailable(
          tx,
          scope,
          String(row.entity_type) as PillarEntityType,
          String(row.entity_id),
          "read"
        )
      )
        result.push(mapAssociation(row))
    await tx.commit()
    return result
  } finally {
    tx.close()
  }
}
export async function getPillarsForEntity(
  owner: PillarOwnerScope,
  kind: PillarEntityType,
  id: string,
  target?: BoardScope,
  database?: Client
): Promise<Pillar[]> {
  if (!database) await ensureAssociationSchema()
  const scope = selectedTarget(owner, target)
  if (!scope) return []
  const tx = await pillarOperationClient(
    database ?? getPersistenceClient(),
    owner,
    "read"
  ).transaction("read")
  try {
    if (!(await targetAvailable(tx, scope, kind, id, "read"))) return []
    const { rows } =
      await tx.execute(sql`SELECT parent.* FROM pillars AS parent JOIN pillar_associations AS link ON link.pillar_id=parent.id
      WHERE link.entity_type=${kind} AND link.entity_id=${id} AND parent.is_active=1 AND ${pillarOwnedBy(owner, "parent")} ORDER BY parent.weight DESC,parent.position,parent.id`)
    await tx.commit()
    return rows.map(toPillar)
  } finally {
    tx.close()
  }
}
export async function setEntityPillar(
  owner: PillarOwnerScope,
  table: "goals" | "tasks" | "task_templates",
  id: string,
  pillarId: string | null,
  database?: Client
): Promise<boolean> {
  if (isPersonalPillarScope(owner)) return false
  if (!database) await ensureAssociationSchema()
  const kind = { goals: "goal", tasks: "task", task_templates: "routine" }[
    table
  ] as PillarEntityType
  if (!kind) return false
  const tx = await pillarOperationClient(
    database ?? getPersistenceClient(),
    owner,
    "edit"
  ).transaction("write")
  try {
    if (!(await targetAvailable(tx, owner, kind, id, "edit"))) return false
    const result =
      await tx.execute(sql`UPDATE ${sourceSql(table)} SET pillar_id=${pillarId} WHERE id=${id}
      ${table === "tasks" ? sql`AND ${boardTaskOwnership(owner, table)}` : sql`AND ${boardPlanningOwnership(owner, table)}`}
      AND (${pillarId} IS NULL OR EXISTS(SELECT 1 FROM pillars AS parent WHERE parent.id=${pillarId} AND ${pillarOwnedBy(owner, "parent")}))`)
    await tx.commit()
    return result.rowsAffected > 0
  } finally {
    tx.close()
  }
}
export async function getEntityPillarId(
  owner: PillarOwnerScope,
  table: "goals" | "tasks" | "task_templates",
  id: string,
  database?: Client
): Promise<string | null> {
  if (isPersonalPillarScope(owner)) return null
  if (!database) await ensureAssociationSchema()
  const kind = { goals: "goal", tasks: "task", task_templates: "routine" }[
    table
  ] as PillarEntityType
  if (!kind) return null
  const tx = await pillarOperationClient(
    database ?? getPersistenceClient(),
    owner,
    "read"
  ).transaction("read")
  try {
    if (!(await targetAvailable(tx, owner, kind, id, "read"))) return null
    const {
      rows: [row]
    } = await tx.execute(
      sql`SELECT target.pillar_id FROM ${sourceSql(table)} AS target JOIN pillars AS parent ON parent.id=target.pillar_id WHERE target.id=${id} AND ${pillarOwnedBy(owner, "parent")}`
    )
    await tx.commit()
    return typeof row?.pillar_id === "string" ? row.pillar_id : null
  } finally {
    tx.close()
  }
}
