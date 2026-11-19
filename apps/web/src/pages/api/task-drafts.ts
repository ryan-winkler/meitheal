import { withBoardScope } from "@lib/board-http"
import { HierarchyRepository } from "@domains/tasks/persistence/hierarchy-repository"
import { organizationPlacementAvailable } from "@lib/organization-placement-access"
import type { APIRoute } from "astro"
import { resolveHomeAssistantAreaSelection } from "@lib/home-assistant-area-access"
import { isCurrentActiveHAUser } from "@domains/ha/ha-users"
import { boardDraftHeader, hasBoardSelection, unavailableBoardResponse } from "@domains/tasks/board-availability"
import { SettingsRepository } from "@domains/tasks/persistence/settings-repository"
import { ensureSchema, getPersistenceClient } from "@domains/tasks/persistence/store"
import { isDraftWriterBusy, TaskDraftRepository } from "@domains/tasks/persistence/task-draft-repository"
import { UserRepository } from "@domains/tasks/persistence/user-repository"
import { TaskRepository } from "@domains/tasks/persistence/task-repository"
import { dispatchTaskCreation, prepareTaskCreation, taskCreationPayload } from "@domains/tasks/task-creation-service"
import { apiProblem } from "@lib/api-response"
import { readWithinLimit } from "@lib/bounded-body"
import { matchesTaskDraftContext, taskDraftContext, taskDraftContextHeader } from "@lib/task-draft-context"
import { readTaskDraftRequest, taskDraftBodyLimit, writeTaskDraftRequest } from "@lib/task-draft-state"
import { verifiedIngressUser } from "@lib/verified-ingress-user"

const noStore = { "cache-control": "private, no-store" }

function problem(status: number, detail: string) {
  return apiProblem({ status, detail, extraHeaders: noStore })
}

function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers: noStore })
}

function validBrowserRequest(request: Request, ingressPath: string): boolean {
  if (request.headers.get("sec-fetch-site") !== "same-origin" ||
      request.headers.get("sec-fetch-mode") !== "same-origin") return false
  const origin = request.headers.get("origin")
  const referer = request.headers.get("referer")
  if (!referer || (!origin && request.method !== "HEAD")) return false
  try {
    const source = new URL(referer)
    return (source.protocol === "http:" || source.protocol === "https:") &&
      (!origin || source.origin === origin) && source.pathname.startsWith(ingressPath + "/")
  } catch {
    return false
  }
}

async function authorize(locals: App.Locals, request: Request) {
  const owner = verifiedIngressUser(locals)
  if (!owner || !locals.ingressPath || !validBrowserRequest(request, locals.ingressPath)) return null
  return await isCurrentActiveHAUser(owner.id, { fresh: request.method !== "HEAD" }) ? owner.id : null
}

async function readBody(request: Request): Promise<{ data: unknown } | Response> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase()
  if (contentType !== "application/json") return problem(415, "Send draft requests as application/json.")
  if (Number(request.headers.get("content-length")) > taskDraftBodyLimit) return problem(413, "Draft requests are limited to 64 KiB.")
  try {
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(5_000)])
    const bytes = await readWithinLimit(request.body, taskDraftBodyLimit, signal)
    if (!bytes) return problem(413, "Draft requests are limited to 64 KiB.")
    return { data: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) }
  } catch {
    return problem(400, "Send a valid UTF-8 JSON object.")
  }
}

function contextChanged() {
  return json({ error: "The Home Assistant account or App session changed.", errorCode: "ACCOUNT_CHANGED" }, 409)
}

function revisionConflict() {
  return json({ error: "The saved draft changed. Reload its current revision.", errorCode: "REVISION_CONFLICT" }, 409)
}

function denied() {
  return problem(403, "Open your draft through a verified Home Assistant session.")
}

export const ALL: APIRoute = () => new Response(null, {
  status: 405, headers: { ...noStore, allow: "POST, PUT, HEAD" },
})

export const HEAD: APIRoute = withBoardScope({ resource: "task", action: "edit" }, async ({ locals, request }, scope) => {
  const ownerId = await authorize(locals, request)
  return new Response(null, {
    status: !ownerId ? 403 : matchesTaskDraftContext(ownerId, scope.boardId, request.headers.get(taskDraftContextHeader)) ? 204 : 409,
    headers: noStore,
  })
})

export const POST: APIRoute = withBoardScope({ resource: "task", action: "edit" }, async ({ locals, request }, scope) => {
  const ownerId = await authorize(locals, request)
  if (!ownerId) return denied()
  const body = await readBody(request)
  if (body instanceof Response) return body
  if (hasBoardSelection(body.data)) return unavailableBoardResponse()
  const action = readTaskDraftRequest.safeParse(body.data)
  if (!action.success) return problem(400, "Choose a valid draft read or recovery action.")

  try {
    await ensureSchema()
    const drafts = new TaskDraftRepository(getPersistenceClient(), scope)
    return json({ context: taskDraftContext(ownerId, scope.boardId), ...await drafts.read(ownerId, action.data.resolve) })
  } catch {
    return problem(500, "Could not read your draft.")
  }
})

export const PUT: APIRoute = withBoardScope({ resource: "task", action: "edit" }, async( context, scope) => {
  const { locals, request } = context
  const ownerId = await authorize(locals, request)
  if (!ownerId) return denied()
  if (!matchesTaskDraftContext(ownerId, scope.boardId, request.headers.get(taskDraftContextHeader))) return contextChanged()
  const body = await readBody(request)
  if (body instanceof Response) return body
  if (hasBoardSelection(body.data)) return unavailableBoardResponse()
  const parsed = writeTaskDraftRequest.safeParse(body.data)
  if (!parsed.success) return problem(400, "Choose a valid draft action and check the form limits.")
  const action = parsed.data

  try {
    await ensureSchema()
    const client = getPersistenceClient()
    const drafts = new TaskDraftRepository(client, scope)
    if (action.action === "save") {
      const draft = await drafts.save(ownerId, action)
      return draft ? json({ draft }) : revisionConflict()
    }
    if (action.action === "discard") {
      return await drafts.discard(ownerId, action.expected) ? json({ draft: null }) : revisionConflict()
    }
    if (action.action === "abandon-publish") {
      const result = await drafts.abandon(ownerId, action)
      return result.receipt || result.draft ? json(result) : revisionConflict()
    }

    const replay = await drafts.replay(ownerId, action)
    if (replay) return json({ receipt: replay })
    const { task } = action
    if (!organizationPlacementAvailable(task)) return problem(404, "This organizing feature is unavailable.")
    const hierarchy = new HierarchyRepository(client, scope)
    const project = task.placement?.projectId ? await hierarchy.findProjectById(task.placement.projectId) : null
    if (task.placement?.projectId && (!project || project.status !== "active" || (task.placement.areaId && task.placement.areaId !== project.area_id))) {
      return problem(404, "Household placement unavailable. Keep the draft and choose an available Area or Project.")
    }
    const placementArea = project?.area_id ?? task.placement?.areaId ?? null
    const area = await resolveHomeAssistantAreaSelection(context, task.home_assistant_area_id)
    if (!area.ok) return problem(area.status, area.detail)
    const repo = new TaskRepository(client, scope)
    const prepared = await prepareTaskCreation(repo, {
      ...task,
      ...(task.placement ? { area_id: placementArea, project_id: task.placement.projectId } : {}),
      labels: JSON.stringify(task.labels),
      ...(task.checklists ? { checklists: JSON.stringify(task.checklists) } : {}),
      ...(task.custom_fields ? { custom_fields: JSON.stringify(task.custom_fields) } : {}),
    }, { useDefaultAssignee: false })
    const assignee = task.assigned_to?.trim() || null
    const assigneeValid = assignee?.startsWith("ha_")
      ? await isCurrentActiveHAUser(assignee.slice(3))
      : !assignee || await new UserRepository(client, scope).customUserExists(assignee)
    await new SettingsRepository(client).ensureSettingsTable()
    const now = Date.now()
    const data = prepared.ok && assigneeValid ? prepared.task : null
    const result = await drafts.publish(ownerId, action, data, now, area.selection)
    if (result.receipt) {
      if (data && result.eventId && result.ticketNumber !== null) {
        dispatchTaskCreation(taskCreationPayload(data, result.ticketNumber, now), result.eventId, result.eventId, undefined, scope)
      }
      return json({ receipt: result.receipt }, result.eventId ? 201 : 200)
    }
    if (result.conflict) return revisionConflict()
    return problem(422, "Check the title, lane, goal, assignee and labels before publishing.")
  } catch (error) {
    if (error && typeof error === "object" && "errorCode" in error && error.errorCode === "STALE_LABELS") return json({ error: "Stored labels changed. Review the draft labels before publishing.", errorCode: "STALE_LABELS" }, 409)
    if (isDraftWriterBusy(error)) return apiProblem({
      status: 503, detail: "Meitheal is busy saving. Retry the same draft action.",
      extraHeaders: { ...noStore, "retry-after": "1" },
    })
    return problem(500, "The draft action did not finish. Check its saved state before trying again.")
  }
})
