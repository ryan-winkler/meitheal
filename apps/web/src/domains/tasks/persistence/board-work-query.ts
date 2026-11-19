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
  const area = sql`COALESCE((SELECT visibility_project.area_id FROM projects AS visibility_project
    WHERE visibility_project.id = ${taskField(scope, "project_id", "work_task")} AND ${ownedPlanning(scope, "visibility_project")}), ${taskField(scope, "area_id", "work_task")})`
  return sql`NOT EXISTS (SELECT 1 FROM organization_access_policies AS work_policy
    WHERE work_policy.board_id = ${scope.boardId} AND (
      (work_policy.scope = 'group' AND work_policy.scope_id = ${area}) OR
      (work_policy.scope = 'project' AND work_policy.scope_id = ${taskField(scope, "project_id", "work_task")})
    ) AND NOT (work_policy.audience = 'everyone' OR
      (${human ? 1 : 0} = 1 AND work_policy.audience = 'selected' AND EXISTS (
        SELECT 1 FROM json_each(CASE WHEN json_valid(work_policy.selected_users) THEN work_policy.selected_users ELSE '[]' END)
        WHERE value = ${scope.principal.id}))))`
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
  const effectiveArea = sql`COALESCE((SELECT relation_project.area_id FROM projects AS relation_project
    WHERE relation_project.id = ${project} AND ${ownedPlanning(scope, "relation_project")}), ${area})`
  return sql`CASE WHEN ${effectiveArea} IS NOT NULL AND (${referenceFeatures(scope, ["organizer", "groups"])})
      AND EXISTS(SELECT 1 FROM areas WHERE areas.id = ${effectiveArea}
      AND ${ownedPlanning(scope, "areas")} AND ${planningVisible(scope, "areas")} AND areas.retired_at IS NULL)
      THEN ${effectiveArea} ELSE NULL END AS public_area_id,
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

/**
 * Shared read model, composed explicitly by repository source queries. This does
 * not accept or rewrite an arbitrary query. Callers reference scoped_* aliases;
 * their bound arguments follow this prefix's arguments in lexical order.
 */
export function scopedTaskRead(scope: BoardScope, query: SqlFragment, continuation: "select" | "with" | "recursive" = "select", projection: "full" | "kanban-order" = "full"): SqlFragment {
  const columns = projection === "kanban-order" ? ["id", "is_promoted", "deferred_at", "status", "kanban_position", "priority", "created_at", "assigned_to"] : taskColumns
  const references = projection === "full" ? sql`, ${publicPlanningReferences(scope)}` : sourceSql("")
  const parent = projection === "full" ? sql`, CASE WHEN ${scopePermits(scope, { resource: "task", action: "read" }) ? 1 : 0} = 1
      THEN (SELECT parent.id FROM scoped_task_records AS parent WHERE parent.id = child.parent_id) ELSE NULL END AS public_parent_id` : sourceSql("")
  return sql`${sourceSql(continuation === "recursive" ? "WITH RECURSIVE" : "WITH")} scoped_storage AS (
    SELECT ${scope.boardId} AS board_id, ${storageBoardId(scope)} AS owner_board_id
  ), scoped_task_records AS NOT MATERIALIZED (
    SELECT work_task.rowid AS rowid, (work_task.task_kind = 'routine_instance' AND work_task.source_template_id IS NOT NULL) AS routine_occurrence, ${taskProjection(scope, columns, "work_task", "work_placement")}${references}
    FROM tasks AS work_task ${taskPlacementJoin(scope, "work_task", "work_placement")}
    WHERE ${taskOwnedBy(scope, "work_task")} AND ${visiblePlacement(scope)}
  ), scoped_tasks AS NOT MATERIALIZED (
    SELECT child.*${parent}
    FROM scoped_task_records AS child
  ), scoped_areas AS (SELECT * FROM areas WHERE ${ownedPlanning(scope, "areas")} AND ${planningVisible(scope, "areas")}),
  scoped_projects AS (SELECT * FROM projects WHERE ${ownedPlanning(scope, "projects")} AND ${planningVisible(scope, "projects")}),
  scoped_goals AS (SELECT * FROM goals WHERE ${ownedPlanning(scope, "goals")} AND ${planningVisible(scope, "goals")})
  ${sourceSql(continuation === "select" ? "" : ",")} ${query}`
}
