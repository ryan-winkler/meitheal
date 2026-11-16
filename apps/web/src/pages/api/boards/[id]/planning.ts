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
  const { action, id, areaId, goalId, enabled, status, cadence } = body
  if (action === "project-status" && typeof id === "string" &&
      (status === "active" || status === "completed" || status === "archived")) return { action, id, status }
  if (action === "goal-share" && typeof id === "string" && typeof areaId === "string" && typeof enabled === "boolean") {
    return { action, id, areaId, enabled }
  }
  const title = typeof body.title === "string" ? stripHtml(body.title).trim() : ""
  const description = typeof body.description === "string" ? stripHtml(body.description).trim() : ""
  if (!title || title.length > 150 || description.length > 10000) return null
  if (action === "area" && (id === undefined || typeof id === "string")) return { action, title, ...(id === undefined ? {} : { id }) }
  if (action === "goal" && typeof areaId === "string" && (id === undefined || typeof id === "string")) {
    return { action, title, description, areaId, ...(id === undefined ? {} : { id }) }
  }
  if (action === "project-edit" && typeof id === "string") return { action, id, title, description }
  if (action === "project" && typeof areaId === "string" && (goalId === null || typeof goalId === "string")) {
    return { action, title, description, areaId, goalId }
  }
  if (action === "routine" && typeof areaId === "string" && (cadence === "daily" || cadence === "weekly")) {
    return { action, title, description, areaId, cadence }
  }
  if (action === "pillar" && (id === undefined || typeof id === "string")) {
    return { action, title, description, ...(id === undefined ? {} : { id }) }
  }
  return null
}

export const POST: APIRoute = async ({ locals, params, request }) => {
  const user = await currentBoardUser(locals, request.signal, request)
  if (!user || !params.id) return apiError("Board unavailable", 404)
  const body = await readBoardRequest(request)
  if (body?.action === "routine" || body?.action === "routine-complete") {
    if (!await isFeatureEnabled("habits")) return apiError("Routines are disabled in settings.", 404)
  }
  if (body?.action === "routine-complete" && typeof body.id === "string") {
    await ensureSchema()
    const outcome = await new NamedBoardTaskRepository(getPersistenceClient()).completeRoutine(user.actor, params.id, body.id)
    if (outcome.ok) return apiJson(outcome.value)
    if (outcome.errorCode === "denied") return apiError("Your Board permissions do not allow completion.", 403)
    if (outcome.errorCode === "stale") return apiError("The ticket for this Routine is already on the Board. Move it to Done when finished.", 409)
    return apiError("Board or Routine unavailable", 404)
  }
  const change = parseChange(body)
  if (!change) return apiError("Choose a planning action and enter valid details.", 400)
  await ensureSchema()
  const repository = new NamedBoardPlanningRepository(getPersistenceClient())
  if (!await repository.save(user.actor.id, params.id, change)) return apiError("Board or planning selection unavailable", 404)
  return apiJson({ ok: true })
}
