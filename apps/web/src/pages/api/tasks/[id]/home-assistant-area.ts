import type { APIRoute } from "astro"
import { ensureSchema, getPersistenceClient, TaskRepository } from "@domains/tasks"
import {
  editTaskHomeAssistantArea, findTaskHomeAssistantArea, readHomeAssistantAreaPolicyRevision,
} from "@domains/tasks/persistence/home-assistant-task-area"
import { taskTimestampMs } from "@domains/tasks/persistence/task-timestamp"
import { homeAssistantAreaAccess, resolveHomeAssistantAreaSelection } from "@lib/home-assistant-area-access"
import { homeAssistantAreaMutationResponse, homeAssistantAreaProblem, homeAssistantAreaResponse } from "@lib/home-assistant-area-response"
import { readBoardRequest } from "@lib/named-board-request"
import { acquireWriteTransaction } from "../../../../../scripts/database-client.mjs"

export const GET: APIRoute = async context => {
  const areaRevision = await homeAssistantAreaAccess(context)
  const id = context.params.id
  if (!areaRevision || !id) return homeAssistantAreaProblem(404, "Task or Home Assistant Area unavailable.")
  await ensureSchema()
  const tx = await getPersistenceClient().transaction("read")
  try {
    const { rows: [task] } = await tx.execute({
      sql: `SELECT ${taskTimestampMs("updated_at")} AS version FROM tasks WHERE id = ? AND task_board_id IS NULL`,
      args: [id],
    })
    if (!task || !(await tx.execute(readHomeAssistantAreaPolicyRevision(areaRevision))).rows.length) {
      return homeAssistantAreaProblem(404, "Task or Home Assistant Area unavailable.")
    }
    return homeAssistantAreaResponse({ id: await findTaskHomeAssistantArea(tx, id), version: Number(task.version) })
  } finally {
    tx.close()
  }
}

export const PUT: APIRoute = async context => {
  const id = context.params.id
  if (!id || !await homeAssistantAreaAccess(context)) return homeAssistantAreaProblem(404, "Task or Home Assistant Area unavailable.")
  const body = await readBoardRequest(context.request)
  if (!body || typeof body.version !== "number" || !Number.isSafeInteger(body.version) || body.version < 0 ||
    body.home_assistant_area_id === undefined) {
    return homeAssistantAreaProblem(400, "Choose a Home Assistant Area and provide the current task version.")
  }
  await ensureSchema()
  const db = getPersistenceClient()
  const task = await new TaskRepository(db).resolveTaskId(id)
  if (!task || task.id !== id) return homeAssistantAreaProblem(404, "Task or Home Assistant Area unavailable.")
  const field = await resolveHomeAssistantAreaSelection(context, body.home_assistant_area_id)
  if (!field.ok) return homeAssistantAreaProblem(field.status, field.detail)
  if (!field.selection) return homeAssistantAreaProblem(400, "Choose a Home Assistant Area.")
  const tx = await acquireWriteTransaction(db, { signal: context.locals.writeAbortSignal })
  try {
    const result = await editTaskHomeAssistantArea(tx, task.id, null, body.version, field.selection)
    if (result.ok) await tx.commit()
    return homeAssistantAreaMutationResponse(result)
  } finally {
    tx.close()
  }
}
