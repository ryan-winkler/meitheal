export interface TaskEpicLink {
  id: string
  parent_id: string | null
  task_type: string | null
  title: string | null
  ticket_number: number | null
}

/** Resolve the nearest Epic using only tasks available to the current Board read. */
export function resolveTaskEpics(rows: readonly TaskEpicLink[]): Map<string, TaskEpicLink> {
  const byId = new Map(rows.map(row => [row.id, row]))
  const visited = new Set<string>()
  const resolved = new Map<string, TaskEpicLink>()

  for (const row of rows) {
    if (visited.has(row.id)) continue
    const path: string[] = []
    let current: TaskEpicLink | undefined = row
    while (current && !visited.has(current.id)) {
      visited.add(current.id)
      path.push(current.id)
      if (current.task_type === "epic") {
        resolved.set(current.id, current)
        break
      }
      current = current.parent_id ? byId.get(current.parent_id) : undefined
    }

    // Previously visited nodes already have a result unless their path
    // ended at a missing parent or formed a cycle.
    const epic = current && resolved.get(current.id)
    if (epic) {
      for (const id of path) resolved.set(id, epic)
    }
  }
  return resolved
}
