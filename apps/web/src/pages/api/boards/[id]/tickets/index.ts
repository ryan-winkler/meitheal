import { organizationPlacementAvailable } from "@lib/organization-placement-access"
import { resolveHomeAssistantAreaSelection } from "@lib/home-assistant-area-access"
import type { APIRoute } from "astro"
import { NamedBoardTaskRepository } from "@domains/tasks/persistence/named-board-task-repository"
import { ensureSchema, getPersistenceClient } from "@domains/tasks/persistence/store"
import { parseBoardPlacement } from "@lib/board-workspace"
import { apiError, apiJson } from "@lib/api-response"
import { currentBoardTaskActor, readBoardRequest } from "@lib/named-board-request"
import { parseCalendarDay } from "@lib/calendar-day"
import { stripHtml } from "@lib/strip-html"

export const POST: APIRoute = async (context) => {
  const { locals, request, params } = context
  const body = await readBoardRequest(request)
  if (body && !organizationPlacementAvailable(body)) return apiError("This organizing feature is unavailable.", 404)
  const dueDate = body?.due_date
  if (dueDate !== undefined && dueDate !== null && (typeof dueDate !== "string" || !parseCalendarDay(dueDate))) {
    return apiError("Choose a valid due date.", 400)
  }
  const title = typeof body?.title === "string" ? stripHtml(body.title.trim()) : ""
  const description = typeof body?.description === "string" ? stripHtml(body.description.trim()) : ""
  if (!body || !title || title.length > 500 || description.length > 10_000) return apiError("Enter a valid task title and description.", 400)
  const scopes = parseBoardPlacement(body.placement)
  if (body.placement !== undefined && (!scopes || body.areaId !== undefined || body.projectId !== undefined)) {
    return apiError("Choose a valid Board group and Project.", 400)
  }
  const actor = await currentBoardTaskActor(locals, request, true)
  if (!actor || !params.id) return apiError("Board unavailable", 404)
  const homeLocation = await resolveHomeAssistantAreaSelection(context, body.home_assistant_area_id)
  if (!homeLocation.ok) return apiError(homeLocation.detail, homeLocation.status)
  await ensureSchema()
  const repository = new NamedBoardTaskRepository(getPersistenceClient())
  const result = await repository.create(actor, params.id, { title, description, ...(dueDate !== undefined ? { dueDate } : {}) }, {
    ...(homeLocation.selection ? { homeAssistantArea: homeLocation.selection } : {}),
    ...(typeof body.laneId === "string" ? { laneId: body.laneId } : {}),
    ...(scopes ? { ...(scopes.areaId ? { areaId: scopes.areaId } : {}), ...(scopes.projectId ? { projectId: scopes.projectId } : {}), local: true } : {
      ...(typeof body.areaId === "string" ? { areaId: body.areaId } : {}),
      ...(typeof body.projectId === "string" ? { projectId: body.projectId } : {}),
    }),
    ...(typeof body.goalId === "string" ? { goalId: body.goalId } : {}),
  })
  if (result.ok) return apiJson(result.value, 201)
  if (result.errorCode === "denied") return apiError("Your Board permissions do not allow this action.", 403)
  return apiError("Board or placement unavailable", 404)
}
