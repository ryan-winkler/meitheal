import { STATUS } from "../../../lib/status-config"

// Outbound "blocked_by" and inbound "blocks" describe the same dependency.
export function openTaskDependenciesSql(task: "?" | "tasks.id") {
  return `SELECT t.id, t.title, t.status, t.ticket_number
    FROM (
      SELECT target_task_id AS blocker_id FROM task_links
      WHERE source_task_id = ${task} AND link_type = 'blocked_by'
      UNION
      SELECT source_task_id AS blocker_id FROM task_links
      WHERE target_task_id = ${task} AND link_type = 'blocks'
    ) AS dependency
    JOIN tasks t ON t.id = dependency.blocker_id
    WHERE t.status NOT IN ('${STATUS.COMPLETE}', 'archived')`
}

export function openTaskDependencies(id: string) {
  return { sql: openTaskDependenciesSql("?"), args: [id, id] }
}
