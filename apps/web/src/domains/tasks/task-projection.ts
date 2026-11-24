/** Shared public task fields. Private persistence columns are never spread into a transport. */
export const TASK_PUBLIC_FIELDS = [
  "id", "title", "description", "status", "priority", "framework_payload", "calendar_sync_state",
  "created_at", "updated_at", "task_version", "deferred_at", "due_date", "labels", "parent_id", "time_tracked",
  "custom_fields", "start_date", "end_date", "progress", "color", "is_favorite", "is_promoted", "task_type",
  "summary", "recurrence_rule", "recurrence_anchor", "rotation_mode", "nfc_tag_id", "checklists", "reminder_at",
  "source_template_id", "routine_occurrence", "assigned_to", "kanban_position", "task_kind", "handoff_state",
  "time_block_start", "time_block_end", "urgency", "importance", "eisenhower_override", "effort_minutes",
  "effort_type", "blocked_by", "area_id", "project_id", "goal_id", "ticket_number", "source", "created_by",
  "board_id", "ticket_key",
] as const

const PUBLIC_VISIBILITY_FIELDS = ["area_id", "project_id", "goal_id", "parent_id"] as const

function isStandardPersistenceRow(row: Record<string, unknown>): boolean {
  return (
    Object.hasOwn(row, "id")
    && Object.hasOwn(row, "framework_payload")
    && Object.hasOwn(row, "eisenhower_override")
    && Object.hasOwn(row, "created_by")
    && Object.hasOwn(row, "routine_occurrence")
    && Object.hasOwn(row, "summary")
    && Object.hasOwn(row, "recurrence_anchor")
    && Object.hasOwn(row, "handoff_state")
    && Object.hasOwn(row, "time_block_end")
    && Object.hasOwn(row, "blocked_by")
    && Object.hasOwn(row, "ticket_number")
  )
}

/** Actor-specific detail/review fields use their existing separately authorized projections. */
export function projectPublicTaskFields(row: Record<string, unknown>): Record<string, unknown> {
  if (isStandardPersistenceRow(row)) {
    const task: Record<string, unknown> = {
      id: row.id,
      title: row.title,
      description: row.description,
      status: row.status,
      priority: row.priority,
      framework_payload: row.framework_payload,
      calendar_sync_state: row.calendar_sync_state,
      created_at: row.created_at,
      updated_at: row.updated_at,
      deferred_at: row.deferred_at,
      due_date: row.due_date,
      labels: row.labels,
      parent_id: Object.hasOwn(row, "public_parent_id") ? row.public_parent_id : row.parent_id,
      time_tracked: row.time_tracked,
      custom_fields: row.custom_fields,
      start_date: row.start_date,
      end_date: row.end_date,
      progress: row.progress,
      color: row.color,
      is_favorite: row.is_favorite,
      is_promoted: row.is_promoted,
      task_type: row.task_type,
      summary: row.summary,
      recurrence_rule: row.recurrence_rule,
      recurrence_anchor: row.recurrence_anchor,
      rotation_mode: row.rotation_mode,
      nfc_tag_id: row.nfc_tag_id,
      checklists: row.checklists,
      reminder_at: row.reminder_at,
      source_template_id: row.source_template_id,
      routine_occurrence: row.routine_occurrence,
      assigned_to: row.assigned_to,
      kanban_position: row.kanban_position,
      task_kind: row.task_kind,
      handoff_state: row.handoff_state,
      time_block_start: row.time_block_start,
      time_block_end: row.time_block_end,
      urgency: row.urgency,
      importance: row.importance,
      eisenhower_override: row.eisenhower_override,
      effort_minutes: row.effort_minutes,
      effort_type: row.effort_type,
      blocked_by: row.blocked_by,
      area_id: Object.hasOwn(row, "public_area_id") ? row.public_area_id : row.area_id,
      project_id: Object.hasOwn(row, "public_project_id") ? row.public_project_id : row.project_id,
      goal_id: Object.hasOwn(row, "public_goal_id") ? row.public_goal_id : row.goal_id,
      ticket_number: row.ticket_number,
      source: row.source,
      created_by: row.created_by,
    }
    if (Object.hasOwn(row, "task_version")) task.task_version = row.task_version
    if (Object.hasOwn(row, "board_id")) task.board_id = row.board_id
    if (Object.hasOwn(row, "ticket_key")) task.ticket_key = row.ticket_key
    return task
  }
  const task: Record<string, unknown> = {}
  for (let i = 0; i < TASK_PUBLIC_FIELDS.length; i += 1) {
    const field = TASK_PUBLIC_FIELDS[i]!
    if (Object.hasOwn(row, field)) task[field] = row[field]
  }
  for (let i = 0; i < PUBLIC_VISIBILITY_FIELDS.length; i += 1) {
    const field = PUBLIC_VISIBILITY_FIELDS[i]!
    const visible = `public_${field}`
    if (Object.hasOwn(row, visible)) task[field] = row[visible]
  }
  return task
}
