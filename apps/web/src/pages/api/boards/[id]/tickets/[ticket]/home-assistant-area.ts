import type { APIRoute } from "astro"
import { ensureSchema, getPersistenceClient } from "@domains/tasks"
import { NamedBoardTaskRepository } from "@domains/tasks/persistence/named-board-task-repository"
import { homeAssistantAreaAccess, resolveHomeAssistantAreaSelection } from "@lib/home-assistant-area-access"
import { homeAssistantAreaMutationResponse, homeAssistantAreaProblem, homeAssistantAreaResponse } from "@lib/home-assistant-area-response"
import { currentBoardTaskActor, readBoardRequest } from "@lib/named-board-request"

export const GET: APIRoute = async context => {
  const { request, locals, params } = context
  const policy = await homeAssistantAreaAccess(context)
  const actor = policy ? await currentBoardTaskActor(locals, request) : null
  if (!actor || !policy || !params.id || !params.ticket) return homeAssistantAreaProblem(404, "Task or Home Assistant Area unavailable.")
  await ensureSchema()
  const result = await new NamedBoardTaskRepository(getPersistenceClient()).homeAssistantArea(actor, params.id, params.ticket, policy)
  return result ? homeAssistantAreaResponse(result) : homeAssistantAreaProblem(404, "Task or Home Assistant Area unavailable.")
}

export const PUT: APIRoute = async context => {
  const { request, locals, params } = context
  const policy = await homeAssistantAreaAccess(context)
  const actor = policy ? await currentBoardTaskActor(locals, request, true) : null
  if (!actor || !params.id || !params.ticket) return homeAssistantAreaProblem(404, "Task or Home Assistant Area unavailable.")
  const body = await readBoardRequest(request)
  if (!body || typeof body.version !== "number" || !Number.isSafeInteger(body.version) || body.version < 0 ||
    body.home_assistant_area_id === undefined) {
    return homeAssistantAreaProblem(400, "Choose a Home Assistant Area and provide the current task version.")
  }
  const field = await resolveHomeAssistantAreaSelection(context, body.home_assistant_area_id)
  if (!field.ok) return homeAssistantAreaProblem(field.status, field.detail)
  if (!field.selection) return homeAssistantAreaProblem(400, "Choose a Home Assistant Area.")
  await ensureSchema()
  const result = await new NamedBoardTaskRepository(getPersistenceClient()).changeHomeAssistantArea(
    actor, params.id, params.ticket, body.version, field.selection,
  )
  return homeAssistantAreaMutationResponse(result)
}
