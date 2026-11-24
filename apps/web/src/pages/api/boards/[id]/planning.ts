import { journaledBoardCommandAck, withBoardScope } from "@lib/board-http"
import type { GoalShareTarget } from "@domains/tasks/persistence/shared-goal-repository"
import { isOrganizationFeatureAvailable as available } from "@lib/organization-request-context"
import type { APIRoute } from "astro"
import { ROUTINE_NEWLY_COMPLETED } from "@domains/tasks"
import { NamedBoardPlanningRepository } from "@domains/tasks/persistence/named-board-planning-repository"
import { NamedBoardTaskRepository } from "@domains/tasks/persistence/named-board-task-repository"
import { ensureSchema, getPersistenceClient } from "@domains/tasks/persistence/store"
import { apiError, apiJson } from "@lib/api-response"
import { isValidTimezone } from "@lib/date"
import { isFeatureEnabled } from "@lib/feature-flags"
import { currentBoardContext, readBoardRequest } from "@lib/named-board-request"
import { stripHtml } from "@lib/strip-html"
import { readStoredHouseholdTimezone } from "@lib/task-queries"

function shareTarget(value: unknown): GoalShareTarget | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const target = value as Record<string, unknown>
  const valid = (id: unknown): id is string => typeof id === "string" && id.length > 0 && id.length <= 150 && !id.includes("\0")
  if (!valid(target.boardId)) return null
  if (target.kind === "board" && Object.keys(target).every(key => ["kind", "boardId"].includes(key))) return { kind: "board", boardId: target.boardId }
  if (target.kind === "area" && valid(target.areaId) && Object.keys(target).every(key => ["kind", "boardId", "areaId"].includes(key))) return { kind: "area", boardId: target.boardId, areaId: target.areaId }
  if (target.kind === "project" && valid(target.projectId) && Object.keys(target).every(key => ["kind", "boardId", "projectId"].includes(key))) return { kind: "project", boardId: target.boardId, projectId: target.projectId }
  return null
}

function parseChange(body: Record<string, unknown> | null): Parameters<NamedBoardPlanningRepository["save"]>[2] | null {
  if (!body) return null
  const { action, id, areaId, projectId, goalId, enabled, status, cadence, entity, pillarId, entityType } = body
  if (action === "project-status" && typeof id === "string" &&
      (status === "active" || status === "completed" || status === "archived")) return { action, id, status }
  if (action === "goal-share" && typeof id === "string" && typeof enabled === "boolean") {
    const target = shareTarget(body.target)
    if (body.target !== undefined) return target ? { action, id, target, enabled } : null
    return typeof areaId === "string" && areaId ? { action, id, areaId, enabled } : null
  }
  if (action === "project-goal" && typeof id === "string" && (goalId === null || typeof goalId === "string")) return { action, id, goalId }
  if (action === "retire" && typeof id === "string" && (entity === "area" || entity === "goal" || entity === "project" || entity === "routine")) {
    return { action, id, entity }
  }
  if (action === "pillar-link" && typeof pillarId === "string" && typeof id === "string" && typeof enabled === "boolean" &&
      (entityType === "goal" || entityType === "routine" || entityType === "task")) {
    return { action, pillarId, id, enabled, entityType }
  }
  const title = typeof body.title === "string" ? stripHtml(body.title).trim() : ""
  const description = typeof body.description === "string" ? stripHtml(body.description).trim() : ""
  if (!title || title.length > 150 || description.length > 10000) return null
  if (action === "area" && (id === undefined || typeof id === "string")) {
    const { icon, color } = body
    if (icon !== undefined && (typeof icon !== "string" || icon.length > 24)) return null
    if (color !== undefined && (typeof color !== "string" || !/^#[0-9a-f]{6}$/i.test(color))) return null
    return { action, title, ...(id === undefined ? {} : { id }),
      ...(typeof icon === "string" ? { icon: stripHtml(icon) } : {}),
      ...(typeof color === "string" ? { color } : {}) }
  }
  if (action === "goal" && (areaId == null || typeof areaId === "string") && (id === undefined || typeof id === "string")) {
    return { action, title, description, ...(areaId === undefined ? {} : { areaId }), ...(id === undefined ? {} : { id }) }
  }
  if (action === "project-edit" && typeof id === "string") return { action, id, title, description }
  if (action === "project" && (areaId == null || typeof areaId === "string") && (goalId === null || typeof goalId === "string")) {
    return { action, title, description, ...(areaId === undefined ? {} : { areaId }), goalId }
  }
  if (action === "routine" && (areaId == null || typeof areaId === "string") && (cadence === "daily" || cadence === "weekly") &&
      (id === undefined || typeof id === "string") && (projectId === undefined || projectId === null || typeof projectId === "string")) {
    return { action, title, description, ...(areaId === undefined ? {} : { areaId }), cadence, ...(projectId === undefined ? {} : { projectId }), ...(id === undefined ? {} : { id }) }
  }
  if (action === "pillar" && (id === undefined || typeof id === "string")) {
    return { action, title, description, ...(id === undefined ? {} : { id }) }
  }
  if (action === "pillar-principle" && typeof pillarId === "string" && (id === undefined || typeof id === "string")) {
    return { action, pillarId, title, nonNegotiable: body.nonNegotiable === true, ...(id === undefined ? {} : { id }) }
  }
  return null
}

const planningOperation = { resource: "board", action: "read" } as const

export const POST: APIRoute = withBoardScope(planningOperation, async (context, scope) => {
  const { locals, params, request } = context
  const user = await currentBoardContext(context, true)
  if (!user || !params.id) return apiError("Board unavailable", 404)
  const body = await readBoardRequest(request)
  const action = typeof body?.action === "string" ? body.action : ""
  const entity = action === "retire" ? body?.entity : action.split("-")[0]
  const feature = entity === "routine" ? "routines" : entity === "goal" ? "goals"
    : entity === "project" ? "projects" : entity === "area" ? "groups"
    : action === "pillar-principle" ? "principles" : entity === "pillar" ? "pillars" : undefined
  if (feature && !available(feature)) return apiError("This feature is unavailable.", 404)

  if (body?.action === "routine" || body?.action === "routine-complete") {
    if (!await isFeatureEnabled("habits")) return apiError("Routines are disabled in settings.", 404)
  }
  if (body?.action === "routine-complete" && typeof body.id === "string" && typeof body.period === "string" &&
      /^\d{4}-\d{2}-\d{2}$/.test(body.period)) {
    await ensureSchema()
    const rawTz = locals?.timezone?.trim() ?? ""
    const timezone = isValidTimezone(rawTz) ? rawTz : await readStoredHouseholdTimezone()
    const outcome = await new NamedBoardTaskRepository(getPersistenceClient(), scope).completeRoutine(user.actor, params.id, body.id, body.period, timezone)
    if (outcome.ok) {
      let gamification: Record<string, unknown> | undefined
      if (Boolean((outcome.value as Record<symbol, unknown>)[ROUTINE_NEWLY_COMPLETED])) {
        try {
          if (await isFeatureEnabled("gamification")) {
            const { recordTaskCompletion, checkAchievements, getLevel } = await import("@domains/gamification")
            const xp = 30
            const stats = await recordTaskCompletion(scope, xp, new Date(), timezone)
            if (stats) {
              const achievements = await checkAchievements(scope, stats)
              gamification = { stats, xp, newAchievements: achievements.newlyUnlocked, level: getLevel(stats.totalPoints) }
            }
          }
        } catch { /* best-effort gamification */ }
      }
      return apiJson({ id: outcome.value.id, ...(gamification ? { gamification } : {}) })
    }
    if (outcome.errorCode === "denied") return apiError("Your Board permissions do not allow completion.", 403)
    if (outcome.errorCode === "stale") return apiError("The Routine period or its ticket changed. Refresh the Board or move the open ticket to Done.", 409)
    return apiError("Board or Routine unavailable", 404)
  }
  const change = parseChange(body)
  if (change && (
    ((change.action === "project-goal" || change.action === "project" && change.goalId !== null) && !available("goals")) ||
    (change.action === "pillar-link" && change.entityType === "goal" && !available("goals")) ||
    (change.action === "pillar-link" && change.entityType === "routine" && !available("routines"))
  )) return apiError("This organizing feature is unavailable.", 404)
  if (!change) return apiError("Choose a planning action and enter valid details.", 400)
  await ensureSchema()
  const repository = new NamedBoardPlanningRepository(getPersistenceClient(), scope)
  if (change.action === "goal-share" || change.action === "retire") {
    const outcome = await repository.saveVisibility(user.actor.id, params.id, change)
    if (outcome.status === "locked") return apiError("Named Board access is temporarily locked.", 503)
    if (outcome.result !== "saved") return apiError("Board or planning selection unavailable", 404)
    if (outcome.status === "committed") return journaledBoardCommandAck(scope, planningOperation, { accessPending: false })
    return apiJson({ ok: true, accessPending: outcome.status === "committed-locked" })
  }
  if (!await repository.save(user.actor.id, params.id, change)) return apiError("Board or planning selection unavailable", 404)
  return apiJson({ ok: true })
}, { boardParam: "id" })
