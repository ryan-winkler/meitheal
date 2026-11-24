/** Shared public task fields. Private persistence columns are never spread into a transport. */
export const TASK_PUBLIC_FIELDS = [
  "id", "title", "description", "status", "priority", "framework_payload", "calendar_sync_state",
  "created_at", "updated_at", "task_version", "deferred_at", "due_date", "labels", "parent_id", "time_tracked",
  "custom_fields", "start_date", "end_date", "progress", "color", "is_promoted", "task_type",
  "summary", "recurrence_rule", "recurrence_anchor", "rotation_mode", "nfc_tag_id", "checklists", "reminder_at",
  "source_template_id", "routine_occurrence", "assigned_to", "kanban_position", "table_position", "task_kind", "handoff_state",
  "time_block_start", "time_block_end", "urgency", "importance", "eisenhower_override", "effort_minutes",
  "effort_type", "blocked_by", "area_id", "project_id", "goal_id", "ticket_number", "source", "created_by",
  "board_id", "ticket_key",
] as const

/** Actor-specific detail/review fields use their existing separately authorized projections. */
export function projectPublicTaskFields(row: Record<string, unknown>): Record<string, unknown> {
  const task: Record<string, unknown> = {}
  for (const field of TASK_PUBLIC_FIELDS) if (Object.hasOwn(row, field)) task[field] = row[field]
  for (const field of ["area_id", "project_id", "goal_id", "parent_id"] as const) {
    const visible = `public_${field}`
    if (Object.hasOwn(row, visible)) task[field] = row[visible]
  }
  return task
}
