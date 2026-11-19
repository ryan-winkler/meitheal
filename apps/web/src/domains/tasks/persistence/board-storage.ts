import { boardScopeStorage, scopeServiceDestination, requireBoardScope, type BoardScope } from "../board-scope"
import { sql, sourceSql, joinSql, type SqlFragment } from "./sql-fragment"

export { requireBoardScope }

function alias(value: string): string {
  if (!/^[a-z][a-z0-9_]*$/i.test(value)) throw new Error("Source-owned SQL alias required")
  return value
}

export function storageBoardId(scope: BoardScope): string | null {
  return boardScopeStorage(scope) === "legacy_null_v1" ? null : scope.boardId
}

export function taskOwnedBy(scope: BoardScope, table = "tasks"): SqlFragment {
  const column = sourceSql(`${alias(table)}.task_board_id`)
  const ownership = storageBoardId(scope) === null ? sql`${column} IS NULL` : sql`${column} = ${scope.boardId}`
  const destination = scopeServiceDestination(scope)
  if (!destination?.areaId && !destination?.projectId) return ownership
  const project = taskField(scope, "project_id", table)
  const area = sql`COALESCE((SELECT destination_project.area_id FROM projects AS destination_project
    WHERE destination_project.id = ${project} AND ${ownedPlanning(scope, "destination_project")}), ${taskField(scope, "area_id", table)})`
  return sql`(${ownership}) ${destination.projectId ? sql`AND ${project} = ${destination.projectId}` : sourceSql("")}
    ${destination.areaId ? sql`AND ${area} = ${destination.areaId}` : sourceSql("")}`
}

export function ownedPlanning(scope: BoardScope, table: string): SqlFragment {
  const column = sourceSql(`${alias(table)}.owner_board_id`)
  return storageBoardId(scope) === null ? sql`${column} IS NULL` : sql`${column} = ${scope.boardId}`
}

export function taskPlacementJoin(scope: BoardScope, task = "tasks", placement = "placement"): SqlFragment {
  requireBoardScope(scope)
  return storageBoardId(scope) === null ? sourceSql("") : sourceSql(
    `LEFT JOIN board_task_planning AS ${alias(placement)} ON ${alias(placement)}.task_id = ${alias(task)}.id`,
  )
}

/** Projection takes explicit source-owned columns so duplicate decoded names cannot shadow placement. */
export function taskProjection(scope: BoardScope, columns: readonly string[], task = "tasks", placement = "placement"): SqlFragment {
  requireBoardScope(scope)
  const legacy = storageBoardId(scope) === null
  const fields = columns.map(column => {
    alias(column)
    if (["area_id", "project_id", "goal_id"].includes(column)) {
      const owner = legacy ? alias(task) : alias(placement)
      return sourceSql(legacy && column === "area_id" ? `NULLIF(${owner}.${column}, '__meitheal_no_area__') AS ${column}` : `${owner}.${column} AS ${column}`)
    }
    return sql`${taskField(scope, column, task)} AS ${sourceSql(column)}`
  })
  return joinSql(fields)
}

/** Normalized field for predicates/subqueries without introducing an ambiguous join. */
export function taskField(scope: BoardScope, column: string, task = "tasks"): SqlFragment {
  requireBoardScope(scope)
  const table = alias(task)
  alias(column)
  if (storageBoardId(scope) !== null) {
    if (["area_id", "project_id", "goal_id"].includes(column)) {
      return sourceSql(`(SELECT work_placement.${column} FROM board_task_planning AS work_placement WHERE work_placement.task_id = ${table}.id)`)
    }
    if (column === "ticket_number") return sourceSql(`CAST(substr(${table}.ticket_ref, instr(${table}.ticket_ref, '-') + 1) AS INTEGER)`)
    return sourceSql(`${table}.${column}`)
  }
  if (column === "area_id") return sourceSql(`NULLIF(${table}.area_id, '__meitheal_no_area__')`)
  if (column === "ticket_ref") return sql`(SELECT ticket_prefix FROM task_boards WHERE id = ${scope.boardId}) || '-' || ${sourceSql(`${table}.ticket_number`)}`
  return sourceSql(`${table}.${column}`)
}
