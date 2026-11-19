import { projectPublicTaskFields } from "@domains/tasks/task-projection"
import { formatTicketKey } from "./ticket-key"

/** Explicit allowlist: adding a private database column can never add it to HTTP. */
export function taskHttpProjection(row: Record<string, unknown>, boardId: string): Record<string, unknown> {
  const task = projectPublicTaskFields(row)
  // Successful create/update writers return their actual integer timestamp.
  // Read queries supply the normalized version explicitly for retained ISO rows.
  if (!Object.hasOwn(task, "task_version")) {
    const version = typeof row.updated_at === "number" ? row.updated_at
      : typeof row.updated_at === "string" && /^\d+$/.test(row.updated_at) ? Number(row.updated_at) : NaN
    if (Number.isSafeInteger(version) && version >= 0) task.task_version = version
  }
  task.board_id = boardId
  task.ticket_key = row.ticket_key ?? row.ticket_ref ?? formatTicketKey(row.ticket_number == null ? null : Number(row.ticket_number))
  return task
}

/** Detail-only state retains existing read behavior; proposal disclosure is separately authorized. */
export function taskDetailHttpProjection(row: Record<string, unknown>, boardId: string, canReview = false): Record<string, unknown> {
  const task = taskHttpProjection(row, boardId)
  for (const field of ["owner", "lock_holder", "lock_expires_at", "handoff_state", "deferral_revision"]) {
    if (Object.hasOwn(row, field)) task[field] = row[field]
  }
  if (canReview) for (const field of ["proposal_json", "proposal_hash"]) {
    if (Object.hasOwn(row, field)) task[field] = row[field]
  }
  return task
}
