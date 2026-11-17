import { isOrganizationFeatureAvailable as available } from "@lib/organization-request-context"
import type { APIRoute } from "astro"
import { NamedBoardPlanningRepository } from "@domains/tasks/persistence/named-board-planning-repository"
import { NamedBoardTaskRepository } from "@domains/tasks/persistence/named-board-task-repository"
import { ensureSchema, getPersistenceClient } from "@domains/tasks/persistence/store"
import { apiError, apiJson } from "@lib/api-response"
import { isFeatureEnabled } from "@lib/feature-flags"
import { currentBoardUser, readBoardRequest } from "@lib/named-board-request"
import { stripHtml } from "@lib/strip-html"

function parseChange(body: Record<string, unknown> | null): Parameters<NamedBoardPlanningRepository["save"]>[2] | null {
  if (!body) return null
  const { action, id, areaId, goalId, enabled, status, cadence, entity, pillarId, entityType } = body
  if (action === "project-status" && typeof id === "string" &&
      (status === "active" || status === "completed" || status === "archived")) return { action, id, status }
  if (action === "goal-share" && typeof id === "string" && typeof areaId === "string" && typeof enabled === "boolean") {
    return { action, id, areaId, enabled }
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
  if (action === "goal" && typeof areaId === "string" && (id === undefined || typeof id === "string")) {
    return { action, title, description, areaId, ...(id === undefined ? {} : { id }) }
  }
  if (action === "project-edit" && typeof id === "string") return { action, id, title, description }
  if (action === "project" && typeof areaId === "string" && (goalId === null || typeof goalId === "string")) {
    return { action, title, description, areaId, goalId }
  }
  if (action === "routine" && typeof areaId === "string" && (cadence === "daily" || cadence === "weekly") &&
      (id === undefined || typeof id === "string")) {
    return { action, title, description, areaId, cadence, ...(id === undefined ? {} : { id }) }
  }
  if (action === "pillar" && (id === undefined || typeof id === "string")) {
    return { action, title, description, ...(id === undefined ? {} : { id }) }
  }
  if (action === "pillar-principle" && typeof pillarId === "string" && (id === undefined || typeof id === "string")) {
    return { action, pillarId, title, nonNegotiable: body.nonNegotiable === true, ...(id === undefined ? {} : { id }) }
  }
  return null
}

export const POST: APIRoute = async ({ locals, params, request }) => {
  const user = await currentBoardUser(locals, request.signal, request)
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
    const outcome = await new NamedBoardTaskRepository(getPersistenceClient()).completeRoutine(user.actor, params.id, body.id, body.period)
    if (outcome.ok) return apiJson(outcome.value)
    if (outcome.errorCode === "denied") return apiError("Your Board permissions do not allow completion.", 403)
    if (outcome.errorCode === "stale") return apiError("The Routine period or its ticket changed. Refresh the Board or move the open ticket to Done.", 409)
    return apiError("Board or Routine unavailable", 404)
  }
  const change = parseChange(body)
  if (!change) return apiError("Choose a planning action and enter valid details.", 400)
  await ensureSchema()
  const repository = new NamedBoardPlanningRepository(getPersistenceClient())
  if (change.action === "goal-share" || change.action === "retire") {
    const outcome = await repository.saveVisibility(user.actor.id, params.id, change)
    if (outcome.status === "locked") return apiError("Named Board access is temporarily locked.", 503)
    if (outcome.result === "children") return apiError("Remove this Area’s active Projects, Goals, and Routines first.", 409)
    if (outcome.result !== "saved") return apiError("Board or planning selection unavailable", 404)
    return apiJson({ ok: true, accessPending: outcome.status === "committed-locked" })
  }
  if (!await repository.save(user.actor.id, params.id, change)) return apiError("Board or planning selection unavailable", 404)
  return apiJson({ ok: true })
}
