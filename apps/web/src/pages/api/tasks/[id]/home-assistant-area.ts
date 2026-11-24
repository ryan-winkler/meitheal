import { withBoardScope } from "@lib/board-http"
import type { APIRoute } from "astro"
import { ensureSchema, getPersistenceClient, TaskRepository, NamedBoardTaskRepository } from "@domains/tasks"
import {
  editTaskHomeAssistantArea, findTaskHomeAssistantArea, readHomeAssistantAreaPolicyRevision,
} from "@domains/tasks/persistence/home-assistant-task-area"
import { taskTimestampMs } from "@domains/tasks/persistence/task-timestamp"
import { homeAssistantAreaAccess, resolveHomeAssistantAreaSelection } from "@lib/home-assistant-area-access"
import { homeAssistantAreaMutationResponse, homeAssistantAreaProblem, homeAssistantAreaResponse } from "@lib/home-assistant-area-response"
import { readBoardRequest } from "@lib/named-board-request"
import { acquireWriteTransaction } from "../../../../../scripts/database-client.mjs"

export const GET: APIRoute = withBoardScope({ resource: "task", action: "read" }, async (context, scope) => {
  const revision = await homeAssistantAreaAccess(context)
  const id = context.params.id
  if (!revision || !id) return homeAssistantAreaProblem(404, "Task or Home Assistant Area unavailable.")
  await ensureSchema()
  const repo = new TaskRepository(getPersistenceClient(), scope)
  const task = await repo.resolveTaskId(id)
  const result = task ? await new NamedBoardTaskRepository(getPersistenceClient(), scope).homeAssistantArea(scope.principal, scope.boardId, task.id, revision) : null
  return result ? homeAssistantAreaResponse(result) : homeAssistantAreaProblem(404, "Task or Home Assistant Area unavailable.")
})

export const PUT: APIRoute = withBoardScope({ resource: "task", action: "edit" }, async( context, scope) => {
  const id = context.params.id
  if (!id || !await homeAssistantAreaAccess(context)) return homeAssistantAreaProblem(404, "Task or Home Assistant Area unavailable.")
  const body = await readBoardRequest(context.request)
  if (!body || typeof body.version !== "number" || !Number.isSafeInteger(body.version) || body.version < 0 ||
    typeof body.locationRevision !== "number" || !Number.isSafeInteger(body.locationRevision) || body.locationRevision < 0 ||
    body.home_assistant_area_id === undefined) {
    return homeAssistantAreaProblem(400, "Choose a Home Assistant Area and provide the current task version.")
  }
  await ensureSchema()
  const db = getPersistenceClient()
  const task = await new TaskRepository(db, scope).resolveTaskId(id, "edit")
  if (!task || task.id !== id) return homeAssistantAreaProblem(404, "Task or Home Assistant Area unavailable.")
  const field = await resolveHomeAssistantAreaSelection(context, body.home_assistant_area_id)
  if (!field.ok) return homeAssistantAreaProblem(field.status, field.detail)
  if (!field.selection) return homeAssistantAreaProblem(400, "Choose a Home Assistant Area.")
  const result = await new NamedBoardTaskRepository(db, scope).changeHomeAssistantArea(
    scope.principal, scope.boardId, task.id, body.version, body.locationRevision, field.selection,
  )
  return homeAssistantAreaMutationResponse(result)
})
