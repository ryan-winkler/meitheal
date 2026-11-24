import { scopeAssignedTo, scopePermits, type BoardScope } from "./board-scope"

export type TaskActionHint = "edit" | "complete" | "delete"

/** Advisory UI metadata from a minted scope, never authority to mutate a Task.
 * Commands must still validate current scope, placement and assignment in their
 * actual writer. Missing row metadata cannot satisfy an assigned-only ceiling.
 */
export function taskActionHints(scope: BoardScope, row?: { assigned_to: string | null }): TaskActionHint[] {
  const assigned = scopeAssignedTo(scope)
  if (assigned !== undefined && (typeof assigned !== "string" || !row || row.assigned_to !== assigned)) return []
  const actions: TaskActionHint[] = []
  const edit = scopePermits(scope, { resource: "task", action: "edit" })
  if (edit) actions.push("edit")
  if (edit && scopePermits(scope, { resource: "task", action: "complete" })) actions.push("complete")
  if (scopePermits(scope, { resource: "task", action: "delete" })) actions.push("delete")
  return actions
}
