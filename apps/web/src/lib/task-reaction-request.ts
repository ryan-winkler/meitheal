import type { APIContext, APIRoute } from "astro"
import { hasScope } from "@meitheal/domain-auth"
import { createLogger, defaultRedactionPatterns } from "@meitheal/domain-observability"
import { hasBoardSelection, rejectBoardSelectionInJson, unavailableBoardResponse } from "@domains/tasks/board-availability"
import { ensureSchema, getPersistenceClient } from "@domains/tasks/persistence/store"
import { TaskReactionRepository, type ReactionTarget } from "@domains/tasks/persistence/task-reaction-repository"
import { apiJson, apiProblem } from "./api-response"
import { readWithinLimit } from "./bounded-body"
import {
  activeParticipantRequired, hasCurrentTaskParticipant, resolveTaskAuthor,
  taskParticipantBodySignal, taskParticipantBodyTimeout,
} from "./task-participant"

const logger = createLogger({
  service: "meitheal-web",
  env: process.env.NODE_ENV ?? "development",
  minLevel: "info",
  enabledCategories: ["tasks", "observability"],
  redactPatterns: defaultRedactionPatterns,
  auditEnabled: false,
})

const cacheHeaders = { "Cache-Control": "private, no-store" }
const maxBodyBytes = 1024
const maxTaskIds = 100
const maxTaskIdLength = 128
const forbiddenContent = /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069\ud800-\udfff]/u

function validTaskId(value: string): boolean {
  return value.length > 0 && value.length <= maxTaskIdLength && !/[^\w-]/.test(value)
}

function parsePositiveId(value: string): number | null {
  const id = Number(value)
  return Number.isSafeInteger(id) && id > 0 && String(id) === value ? id : null
}

function targetFrom(params: APIContext["params"]): ReactionTarget | null {
  const taskId = params.id
  if (!taskId || !validTaskId(taskId)) return null
  if (params.commentId === undefined) return { taskId, commentId: null }
  const commentId = parsePositiveId(params.commentId)
  return commentId === null ? null : { taskId, commentId }
}

function reactionProblem(status: number, detail: string): Response {
  return apiProblem({ status, detail, extraHeaders: cacheHeaders })
}

function reactionJson(data: unknown, status = 200): Response {
  const response = apiJson(data, status)
  response.headers.set("Cache-Control", cacheHeaders["Cache-Control"])
  return response
}

async function readContent(request: Request): Promise<string | Response> {
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    return reactionProblem(415, "Send the reaction as application/json")
  }
  if (Number(request.headers.get("content-length")) > maxBodyBytes) {
    return reactionProblem(413, "The reaction request exceeds 1 KiB")
  }

  const signal = taskParticipantBodySignal(request)
  let payload: unknown
  try {
    const bytes = await readWithinLimit(request.body, maxBodyBytes, signal)
    if (!bytes) return reactionProblem(413, "The reaction request exceeds 1 KiB")
    payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
  } catch {
    if (signal.aborted) return taskParticipantBodyTimeout()
    return reactionProblem(400, "Send a valid UTF-8 JSON request body")
  }

  if (hasBoardSelection(payload)) return unavailableBoardResponse()
  const content = payload && typeof payload === "object" && "content" in payload
    && typeof payload.content === "string" ? payload.content.trim().normalize("NFC") : ""
  if (!content || [...content].length > 16 || forbiddenContent.test(content)) {
    return reactionProblem(400, "Use 1 to 16 characters of emoji or plain text on one line")
  }
  return content
}

function reactionRoute(
  scope: "tasks:read" | "tasks:write",
  handler: (
    context: APIContext,
    repo: TaskReactionRepository,
    actor: { author: string, owner: string },
    canReact: boolean,
  ) => Promise<Response>,
): APIRoute {
  return async context => {
    const { locals, request } = context
    const actor = resolveTaskAuthor(locals)
    const token = locals.agentToken
    if (!actor) return activeParticipantRequired()
    if (!actor.owner || (token && !hasScope(token.scopes, scope))) {
      return reactionProblem(403, "Use a verified Home Assistant session or an automation credential with the required task permission")
    }
    const canReact = !token || hasScope(token.scopes, "tasks:write")

    try {
      if (scope === "tasks:read" && !await hasCurrentTaskParticipant(locals, request.signal)) return activeParticipantRequired()
      await ensureSchema()
      return await handler(context, new TaskReactionRepository(getPersistenceClient()), { ...actor, owner: actor.owner }, canReact)
    } catch {
      logger.log("error", {
        event: "api.reactions.error",
        domain: "tasks",
        component: "reactions-api",
        request_id: crypto.randomUUID(),
        message: "Failed to process task reactions",
      })
      return reactionProblem(500, "Failed to process task reactions")
    }
  }
}

export const listReactions = reactionRoute("tasks:read", async ({ params, url }, repo, actor, canReact) => {
  const target = targetFrom(params)
  if (!target) return reactionProblem(404, "Task or comment not found")

  const cursors = url.searchParams.getAll("cursor")
  const cursor = cursors.length === 0 ? Number.MAX_SAFE_INTEGER + 1 : parsePositiveId(cursors[0]!)
  if (cursors.length > 1 || cursor === null) return reactionProblem(400, "Use the next_cursor returned by the reaction list")

  const list = await repo.list(target, cursor, canReact ? actor.owner : null)
  return list ? reactionJson({ ...list, can_react: canReact }) : reactionProblem(404, "Task or comment not found")
})

export const addReaction = reactionRoute("tasks:write", async ({ params, request, locals }, repo, actor) => {
  const target = targetFrom(params)
  if (!target) return reactionProblem(404, "Task or comment not found")
  const content = await readContent(request)
  if (content instanceof Response) return content

  if (!await hasCurrentTaskParticipant(locals, request.signal, true)) return activeParticipantRequired()
  const reaction = await repo.add(target, content, actor.author, actor.owner)
  return reaction ? reactionJson(reaction, 201) : reactionProblem(404, "Task or comment not found")
})

export const removeReaction = reactionRoute("tasks:write", async ({ params, request, locals }, repo, actor) => {
  const target = targetFrom(params)
  const reactionId = parsePositiveId(params.reactionId ?? "")
  if (!target || reactionId === null) return reactionProblem(404, "Reaction not found")
  const boardSelection = await rejectBoardSelectionInJson(request)
  if (boardSelection) return boardSelection
  if (!await hasCurrentTaskParticipant(locals, request.signal, true)) return activeParticipantRequired()
  if (!await repo.remove(target, reactionId, actor.owner)) {
    return reactionProblem(404, "Reaction not found")
  }
  return new Response(null, { status: 204, headers: cacheHeaders })
})

export const countCardReactions = reactionRoute("tasks:read", async ({ url }, repo) => {
  const values = url.searchParams.getAll("ids")
  const rawIds = values[0]
  if (values.length !== 1 || !rawIds || rawIds.length > maxTaskIds * (maxTaskIdLength + 1) - 1) {
    return reactionProblem(400, "Supply 1 to 100 comma-separated task IDs in ids")
  }
  const ids = rawIds.split(",")
  if (ids.length > maxTaskIds || !ids.every(validTaskId)) {
    return reactionProblem(400, "Supply 1 to 100 comma-separated task IDs in ids")
  }
  return reactionJson({ counts: await repo.countCards([...new Set(ids)]) })
})
