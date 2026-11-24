import type { BoardScope } from "../board-scope"
import { STATUS } from "../../../lib/status-config"
import { scopedTaskRead } from "./board-work-query"
import { sourceSql } from "./sql-fragment"

/** Only use inside the common scoped work CTE. Both dependency endpoints belong to it. */
export function openTaskDependenciesSql(task: "?" | "tasks.id") {
  return `SELECT t.id, t.title, t.status, t.ticket_number FROM (
      SELECT target_task_id AS blocker_id FROM task_links WHERE source_task_id = ${task} AND link_type = 'blocked_by'
      UNION SELECT source_task_id AS blocker_id FROM task_links WHERE target_task_id = ${task} AND link_type = 'blocks'
    ) AS dependency JOIN scoped_tasks t ON t.id = dependency.blocker_id
    WHERE t.status NOT IN ('${STATUS.COMPLETE}', 'archived')`
}

export function openTaskDependencies(scope: BoardScope, id: string) {
  return scopedTaskRead(scope, sourceSql(openTaskDependenciesSql("?"), [id, id]), "select", "minimal")
}
