import { scopePermits, scopeLimits, type BoardScope } from "../board-scope"
import { ownedPlanning, storageBoardId, taskField, taskOwnedBy, taskPlacementJoin, taskProjection } from "./board-storage"
import { sql, sourceSql, type SqlFragment } from "./sql-fragment"
import { featureAudienceAllowed } from "../board-feature-policy"
import { goalEligibility } from "./shared-goal-repository"

export type TaskReadPlacement = { areaId?: string | null; projectId?: string | null }

/** Optional selected context, applied to normalized raw refs after Board/audience ownership. */
export function taskReadPlacement(placement?: TaskReadPlacement, table = "tasks"): SqlFragment {
  if (!/^[a-z][a-z0-9_]*$/i.test(table)) throw new Error("Source-owned task alias required")
  const task = sourceSql(table)
  const project = placement?.projectId ? sql`AND ${task}.project_id = ${placement.projectId}` : sourceSql("")
  const area = placement?.areaId ? sql`AND COALESCE((SELECT context_project.area_id FROM scoped_projects AS context_project
    WHERE context_project.id = ${task}.project_id), ${task}.area_id) = ${placement.areaId}` : sourceSql("")
  return sql`1 ${project} ${area}`
}

function visiblePlacement(scope: BoardScope): SqlFragment {
  const human = scope.principal.kind === "ha_user"
  const project = taskField(scope, "project_id", "work_task")
  const areaRef = taskField(scope, "area_id", "work_task")
  const area = sql`CASE WHEN ${project} IS NULL THEN ${areaRef} ELSE COALESCE((SELECT visibility_project.area_id FROM projects AS visibility_project
    WHERE visibility_project.id = ${project} AND ${ownedPlanning(scope, "visibility_project")}), ${areaRef}) END`
  // An unrestricted Board short-circuits via scalar flag hoisted in scoped_storage.
  return sql`(scoped_storage.unrestricted_placement = 1
    OR NOT EXISTS (SELECT 1 FROM organization_access_policies AS work_policy
    WHERE work_policy.board_id = ${scope.boardId} AND (
      (work_policy.scope = 'group' AND work_policy.scope_id = ${area}) OR
      (work_policy.scope = 'project' AND work_policy.scope_id = ${project})
    ) AND NOT (work_policy.audience = 'everyone' OR
      (${human ? 1 : 0} = 1 AND work_policy.audience = 'selected' AND EXISTS (
        SELECT 1 FROM json_each(CASE WHEN json_valid(work_policy.selected_users) THEN work_policy.selected_users ELSE '[]' END)
        WHERE value = ${scope.principal.id})))))`
}

export function planningVisible(scope: BoardScope, resource: "areas" | "projects" | "goals"): SqlFragment {
  const area = sourceSql(resource === "areas" ? "areas.id" : `${resource}.area_id`)
  const project = resource === "projects" ? sourceSql("projects.id") : sql`${null}`
  return sql`NOT EXISTS (SELECT 1 FROM organization_access_policies AS planning_policy WHERE planning_policy.board_id = ${scope.boardId}
    AND ((planning_policy.scope = 'group' AND planning_policy.scope_id = ${area}) OR
      (planning_policy.scope = 'project' AND planning_policy.scope_id = ${project}))
    AND NOT (planning_policy.audience = 'everyone' OR (${scope.principal.kind === "ha_user" ? 1 : 0} = 1 AND planning_policy.audience = 'selected'
      AND EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(planning_policy.selected_users) THEN planning_policy.selected_users ELSE '[]' END) WHERE value = ${scope.principal.id}))))`
}

/** Metadata visibility intersects current primary and secondary feature audiences. */
export function referenceFeatures(scope: BoardScope, features: readonly string[]): SqlFragment {
  const predicates = [scope, ...scopeLimits(scope)].flatMap(current => features.map(feature => featureAudienceAllowed(current.principal, feature)))
  return predicates.reduce((all, predicate) => sql`${all} AND (${predicate})`, sql`1`)
}

/** Public relation identifiers are separate from physical historical placement.
 * Never substitute these into ownership, policy, assignment or provider guards. */
function publicPlanningReferences(scope: BoardScope): SqlFragment {
  const area = taskField(scope, "area_id", "work_task")
  const project = taskField(scope, "project_id", "work_task")
  const goal = taskField(scope, "goal_id", "work_task")
  const effectiveArea = sql`CASE WHEN ${project} IS NULL THEN ${area} ELSE COALESCE((SELECT relation_project.area_id FROM projects AS relation_project
    WHERE relation_project.id = ${project} AND ${ownedPlanning(scope, "relation_project")}), ${area}) END`
  return sql`CASE WHEN scoped_storage.allow_area_refs = 1 AND (${area} IS NOT NULL OR ${project} IS NOT NULL)
      AND ${effectiveArea} IS NOT NULL
      AND EXISTS(SELECT 1 FROM areas WHERE areas.id = ${effectiveArea}
      AND ${ownedPlanning(scope, "areas")} AND ${planningVisible(scope, "areas")} AND areas.retired_at IS NULL)
      THEN ${effectiveArea} ELSE NULL END AS public_area_id,
    CASE WHEN scoped_storage.allow_project_refs = 1 AND ${project} IS NOT NULL AND EXISTS(SELECT 1 FROM projects WHERE projects.id = ${project}
      AND ${ownedPlanning(scope, "projects")} AND ${planningVisible(scope, "projects")} AND projects.retired_at IS NULL)
      THEN ${project} ELSE NULL END AS public_project_id,
    CASE WHEN scoped_storage.allow_goal_refs = 1 AND ${goal} IS NOT NULL AND ${goalEligibility(scope, goal, { areaId: effectiveArea, projectId: project })}
      THEN ${goal} ELSE NULL END AS public_goal_id`
}

// Internal persistence projection. Public response adapters use their own explicit
// allowlist. Receipt digests and grant/storage metadata are deliberately absent.
const taskColumns = [
  "id", "endeavor_id", "title", "description", "status", "framework_payload", "calendar_sync_state",
  "idempotency_key", "request_id", "created_at", "updated_at", "deferred_at", "deferral_revision",
  "priority", "due_date", "labels", "parent_id", "time_tracked", "area_id", "custom_fields", "start_date",
  "end_date", "progress", "color", "is_promoted", "task_type", "summary", "recurrence_rule",
  "recurrence_anchor", "rotation_mode", "nfc_tag_id", "checklists", "reminder_at", "source_template_id",
  "ticket_number", "assigned_to", "kanban_position", "table_position", "task_kind", "project_id", "goal_id",
  "owner", "lock_holder", "lock_expires_at", "handoff_state", "proposal_json", "proposal_hash",
  "time_block_start", "time_block_end", "urgency", "importance", "eisenhower_override", "effort_minutes",
  "effort_type", "blocked_by", "inactivity_touched_at", "last_activity_spike_at", "routine_template_id", "spawned_for_date",
  "task_board_id", "board_column_id", "ticket_ref", "source", "created_by",
] as const

export type TaskReadProjection = "full" | "minimal" | "records" | "search" | "kanban-order"
const readModelPrefixes = new WeakMap<BoardScope, Map<TaskReadProjection, SqlFragment>>()

/**
 * Shared read model, composed explicitly by repository source queries. This does
 * not accept or rewrite an arbitrary query. Callers reference scoped_* aliases;
 * their bound arguments follow this prefix's arguments in lexical order.
 */
export function scopedTaskRead(scope: BoardScope, query: SqlFragment, continuation: "select" | "with" | "recursive" = "select", projection: TaskReadProjection = "full"): SqlFragment {
  let prefixes = readModelPrefixes.get(scope)
  if (!prefixes) {
    prefixes = new Map()
    readModelPrefixes.set(scope, prefixes)
  }
  let prefix = prefixes.get(projection)
  if (!prefix) {
    prefix = taskReadPrefix(scope, projection)
    prefixes.set(projection, prefix)
  }
  return sql`${sourceSql(continuation === "recursive" ? "WITH RECURSIVE" : "WITH")} ${prefix}
    ${sourceSql(continuation === "select" ? "" : ",")} ${query}`
}

/** Reuse only the query template for the same issued scope. SQL still checks the current audiences. */
function taskReadPrefix(scope: BoardScope, projection: TaskReadProjection): SqlFragment {
  const columns = projection === "kanban-order" ? ["id", "is_promoted", "deferred_at", "status", "kanban_position", "priority", "created_at", "assigned_to"] : taskColumns
  const references = projection === "full" ? sql`, ${publicPlanningReferences(scope)}` : sourceSql("")
  const ticketPrefix = projection === "kanban-order" ? sourceSql("NULL") : sourceSql("scoped_storage.board_ticket_prefix")
  const unrestricted = sql`(NOT EXISTS (SELECT 1 FROM organization_access_policies
        WHERE board_id = ${scope.boardId} AND scope IN ('group', 'project') AND audience <> 'everyone')) AS unrestricted_placement`
  const storageFields = projection === "kanban-order"
    ? unrestricted
    : projection === "minimal" || projection === "records" || projection === "search"
      ? sql`(SELECT ticket_prefix FROM task_boards WHERE id = ${scope.boardId}) AS board_ticket_prefix, ${unrestricted}`
      : sql`(SELECT ticket_prefix FROM task_boards WHERE id = ${scope.boardId}) AS board_ticket_prefix,
      (${referenceFeatures(scope, ["organizer", "groups"])}) AS allow_area_refs,
      (${referenceFeatures(scope, ["organizer", "projects"])}) AS allow_project_refs,
      (${referenceFeatures(scope, ["goals"])}) AS allow_goal_refs,
      ${unrestricted}`
  const baseQuery = sql`SELECT work_task.rowid AS rowid, (work_task.task_kind = 'routine_instance' AND work_task.source_template_id IS NOT NULL) AS routine_occurrence, ${taskProjection(scope, columns, "work_task", "work_placement", ticketPrefix)}${references}
    FROM tasks AS work_task ${taskPlacementJoin(scope, "work_task", "work_placement")}
    CROSS JOIN scoped_storage
    WHERE ${taskOwnedBy(scope, "work_task")} AND ${visiblePlacement(scope)}`
  const scopedTasksCte = projection === "full"
    ? sql`scoped_task_records AS NOT MATERIALIZED (
    ${baseQuery}
  ), scoped_tasks AS NOT MATERIALIZED (
    SELECT child.*, CASE WHEN child.parent_id IS NOT NULL AND ${scopePermits(scope, { resource: "task", action: "read" }) ? 1 : 0} = 1
      THEN (SELECT parent.id FROM scoped_task_records AS parent WHERE parent.id = child.parent_id) ELSE NULL END AS public_parent_id
    FROM scoped_task_records AS child
  )`
    : projection === "records"
      ? sql`scoped_task_records AS NOT MATERIALIZED (
    ${baseQuery}
  )`
      : projection === "search"
        ? sql`scoped_task_records AS NOT MATERIALIZED (
    ${baseQuery}
  ), scoped_tasks AS NOT MATERIALIZED (
    SELECT * FROM scoped_task_records
  )`
        : sql`scoped_tasks AS NOT MATERIALIZED (
    ${baseQuery}
  )`
  return sql`scoped_storage AS MATERIALIZED (
    SELECT ${scope.boardId} AS board_id, ${storageBoardId(scope)} AS owner_board_id,
      ${storageFields}
  ), ${scopedTasksCte}, scoped_areas AS (SELECT * FROM areas WHERE ${ownedPlanning(scope, "areas")} AND ${planningVisible(scope, "areas")}),
  scoped_projects AS (SELECT * FROM projects WHERE ${ownedPlanning(scope, "projects")} AND ${planningVisible(scope, "projects")}),
  scoped_goals AS (SELECT * FROM goals WHERE ${ownedPlanning(scope, "goals")} AND ${planningVisible(scope, "goals")})`
}
