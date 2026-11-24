import { scopePermits, scopeLimits, scopeServiceDestination, type BoardScope } from "../board-scope"
import { ownedPlanning, requireBoardScope, storageBoardId, taskField, taskOwnedBy, taskPlacementJoin } from "./board-storage"
import { joinSql, sql, sourceSql, type SqlFragment } from "./sql-fragment"
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

function recordField(scope: BoardScope, column: "area_id" | "project_id" | "goal_id"): SqlFragment {
  if (storageBoardId(scope) !== null) return sourceSql(`work_placement.${column}`)
  return column === "area_id"
    ? sourceSql("NULLIF(work_task.area_id, '__meitheal_no_area__')")
    : sourceSql(`work_task.${column}`)
}

function recordProjection(scope: BoardScope, columns: readonly string[]): SqlFragment {
  requireBoardScope(scope)
  const fields = columns.map(column => {
    if (column === "area_id" || column === "project_id" || column === "goal_id") {
      return sql`${recordField(scope, column)} AS ${sourceSql(column)}`
    }
    if (column === "ticket_ref" && storageBoardId(scope) === null) {
      return sourceSql("((SELECT ticket_prefix FROM scoped_storage) || '-' || work_task.ticket_number) AS ticket_ref")
    }
    return sql`${taskField(scope, column, "work_task")} AS ${sourceSql(column)}`
  })
  return joinSql(fields)
}

function visiblePlacement(scope: BoardScope): SqlFragment {
  const human = scope.principal.kind === "ha_user"
  const area = recordField(scope, "area_id")
  const project = recordField(scope, "project_id")
  const effectiveArea = sql`CASE WHEN ${project} IS NOT NULL THEN COALESCE((SELECT visibility_project.area_id FROM projects AS visibility_project
    WHERE visibility_project.id = ${project} AND ${ownedPlanning(scope, "visibility_project")}), ${area}) ELSE ${area} END`
  // An unrestricted Board needs no per-task placement policy lookup. Both
  // checks read the same statement snapshot, including newly restricted work.
  return sql`((SELECT has_restricted_placement FROM scoped_storage) = 0
    OR NOT EXISTS (SELECT 1 FROM organization_access_policies AS work_policy
    WHERE work_policy.board_id = ${scope.boardId} AND (
      (work_policy.scope = 'group' AND work_policy.scope_id = ${effectiveArea}) OR
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
  const area = recordField(scope, "area_id")
  const project = recordField(scope, "project_id")
  const goal = recordField(scope, "goal_id")
  const effectiveArea = sql`CASE WHEN ${project} IS NOT NULL THEN COALESCE((SELECT relation_project.area_id FROM projects AS relation_project
    WHERE relation_project.id = ${project} AND ${ownedPlanning(scope, "relation_project")}), ${area}) ELSE ${area} END`
  return sql`CASE WHEN (${effectiveArea}) IS NOT NULL AND (${referenceFeatures(scope, ["organizer", "groups"])})
      AND EXISTS(SELECT 1 FROM areas WHERE areas.id = (${effectiveArea})
      AND ${ownedPlanning(scope, "areas")} AND ${planningVisible(scope, "areas")} AND areas.retired_at IS NULL)
      THEN (${effectiveArea}) ELSE NULL END AS public_area_id,
    CASE WHEN ${project} IS NOT NULL AND (${referenceFeatures(scope, ["organizer", "projects"])}) AND EXISTS(SELECT 1 FROM projects WHERE projects.id = ${project}
      AND ${ownedPlanning(scope, "projects")} AND ${planningVisible(scope, "projects")} AND projects.retired_at IS NULL)
      THEN ${project} ELSE NULL END AS public_project_id,
    CASE WHEN ${goal} IS NOT NULL AND (${referenceFeatures(scope, ["goals"])}) AND ${goalEligibility(scope, goal, { areaId: effectiveArea, projectId: project })}
      THEN ${goal} ELSE NULL END AS public_goal_id`
}

// Internal persistence projection. Public response adapters use their own explicit
// allowlist. Receipt digests and grant/storage metadata are deliberately absent.
const taskColumns = [
  "id", "endeavor_id", "title", "description", "status", "framework_payload", "calendar_sync_state",
  "idempotency_key", "request_id", "created_at", "updated_at", "deferred_at", "deferral_revision",
  "priority", "due_date", "labels", "parent_id", "time_tracked", "area_id", "custom_fields", "start_date",
  "end_date", "progress", "color", "is_favorite", "is_promoted", "task_type", "summary", "recurrence_rule",
  "recurrence_anchor", "rotation_mode", "nfc_tag_id", "checklists", "reminder_at", "source_template_id",
  "ticket_number", "assigned_to", "kanban_position", "task_kind", "project_id", "goal_id",
  "owner", "lock_holder", "lock_expires_at", "handoff_state", "proposal_json", "proposal_hash",
  "time_block_start", "time_block_end", "urgency", "importance", "eisenhower_override", "effort_minutes",
  "effort_type", "blocked_by", "inactivity_touched_at", "last_activity_spike_at", "routine_template_id", "spawned_for_date",
  "task_board_id", "board_column_id", "ticket_ref", "source", "created_by",
] as const

const searchTaskColumns = [
  "id", "ticket_number", "ticket_ref", "title", "status", "priority", "task_kind",
  "deferred_at", "updated_at", "assigned_to", "description", "labels", "custom_fields",
] as const

type TaskReadProjection = "full" | "kanban-order" | "search" | "records"
const MAX_PREFIX_CACHE = 128
const readModelPrefixes = new Map<string, SqlFragment>()

/**
 * Shared read model, composed explicitly by repository source queries. This does
 * not accept or rewrite an arbitrary query. Callers reference scoped_* aliases;
 * their bound arguments follow this prefix's arguments in lexical order.
 */
export function scopedTaskRead(scope: BoardScope, query: SqlFragment, continuation: "select" | "with" | "recursive" = "select", projection: TaskReadProjection = "full"): SqlFragment {
  const dest = scopeServiceDestination(scope)
  const limitsKey = scopeLimits(scope).map(limit => `${limit.principal.kind}:${limit.principal.id}`).join(",")
  const canReadTask = scopePermits(scope, { resource: "task", action: "read" }) ? 1 : 0
  const key = `${projection}\0${scope.boardId}\0${storageBoardId(scope) ?? ""}\0${scope.principal.kind}:${scope.principal.id}\0${dest?.boardId ?? ""}\0${dest?.areaId ?? ""}\0${dest?.projectId ?? ""}\0${canReadTask}\0${limitsKey}`
  let prefix = readModelPrefixes.get(key)
  if (prefix) {
    readModelPrefixes.delete(key)
    readModelPrefixes.set(key, prefix)
  } else {
    prefix = taskReadPrefix(scope, projection)
    if (readModelPrefixes.size >= MAX_PREFIX_CACHE) {
      const oldest = readModelPrefixes.keys().next().value
      if (oldest !== undefined) readModelPrefixes.delete(oldest)
    }
    readModelPrefixes.set(key, prefix)
  }
  return sql`${sourceSql(continuation === "recursive" ? "WITH RECURSIVE" : "WITH")} ${prefix}
    ${sourceSql(continuation === "select" ? "" : ",")} ${query}`
}

/** Reuse only the query template for the same issued scope. SQL still checks the current audiences. */
function taskReadPrefix(scope: BoardScope, projection: TaskReadProjection): SqlFragment {
  const columns = projection === "kanban-order"
    ? ["id", "is_promoted", "deferred_at", "status", "kanban_position", "priority", "created_at", "assigned_to"]
    : projection === "search"
      ? searchTaskColumns
      : taskColumns
  const references = projection === "full" ? sql`, ${publicPlanningReferences(scope)}` : sourceSql("")
  const parent = projection === "full" ? sql`, CASE WHEN child.parent_id IS NOT NULL AND ${scopePermits(scope, { resource: "task", action: "read" }) ? 1 : 0} = 1
      THEN (SELECT parent.id FROM scoped_task_records AS parent WHERE parent.id = child.parent_id) ELSE NULL END AS public_parent_id` : sourceSql("")
  const planning = (projection === "search" || projection === "records") ? sourceSql("") : sql`, scoped_areas AS (SELECT * FROM areas WHERE ${ownedPlanning(scope, "areas")} AND ${planningVisible(scope, "areas")}),
  scoped_projects AS (SELECT * FROM projects WHERE ${ownedPlanning(scope, "projects")} AND ${planningVisible(scope, "projects")}),
  scoped_goals AS (SELECT * FROM goals WHERE ${ownedPlanning(scope, "goals")} AND ${planningVisible(scope, "goals")})`
  return sql`scoped_storage AS MATERIALIZED (
    SELECT ${scope.boardId} AS board_id, ${storageBoardId(scope)} AS owner_board_id,
      (SELECT ticket_prefix FROM task_boards WHERE id = ${scope.boardId}) AS ticket_prefix,
      EXISTS (SELECT 1 FROM organization_access_policies
        WHERE board_id = ${scope.boardId} AND scope IN ('group', 'project') AND audience <> 'everyone') AS has_restricted_placement
  ), scoped_task_records AS NOT MATERIALIZED (
    SELECT work_task.rowid AS rowid, (work_task.task_kind = 'routine_instance' AND work_task.source_template_id IS NOT NULL) AS routine_occurrence, ${recordProjection(scope, columns)}${references}
    FROM tasks AS work_task ${taskPlacementJoin(scope, "work_task", "work_placement")}
    WHERE ${taskOwnedBy(scope, "work_task")} AND ${visiblePlacement(scope)}
  ), scoped_tasks AS NOT MATERIALIZED (
    SELECT child.*${parent}
    FROM scoped_task_records AS child
  )${planning}`
}
