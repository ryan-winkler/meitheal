import type { APIRoute } from "astro"
import { z } from "zod"
import { hasScope } from "@meitheal/domain-auth"
import { A2A_ERRORS, A2A_PROTOCOL_VERSION, A2A_TASK_SEARCH_SKILL } from "@meitheal/integration-core"
import { A2A_RESPONSE_HEADERS, checkA2aAvailability, getA2ALinkOrigin } from "@domains/agents"
import { searchMeithealCatalog } from "@domains/search"
import { ensureSchema } from "@domains/tasks"
import { getA2aTask, listA2aTasks } from "@lib/a2a-tasks"
import { apiProblem } from "@lib/api-response"
import { readWithinLimit } from "@lib/bounded-body"
import { logApiError } from "@lib/api-logger"

const MAX_BODY_BYTES = 16 * 1024
const taskNotFound = "A2A task not found."
const rpcRequest = z.object({
  jsonrpc: z.literal("2.0"),
  method: z.string().min(1),
  id: z.union([z.string(), z.number().int(), z.null()]).optional(),
  params: z.unknown().optional(),
})
const rfc3339Timestamp = z.string().datetime({ offset: true })
const taskRequest = z.object({ id: z.string().min(1), historyLength: z.number().int().nonnegative().optional() })
const listRequest = z.object({
  pageSize: z.number().int().min(1).max(100).optional(),
  pageToken: z.string().regex(/^\d{0,6}$/).optional(),
  historyLength: z.number().int().nonnegative().optional(),
  includeArtifacts: z.boolean().optional(),
  contextId: z.string().optional(),
  status: z.string().optional(),
  statusTimestampAfter: z.string().optional(),
})
const messageRequest = z.object({
  message: z.object({
    messageId: z.string().min(1).max(200),
    role: z.literal("ROLE_USER"),
    parts: z.array(z.object({
      text: z.string().optional(),
      data: z.unknown().optional(),
      mediaType: z.string().optional(),
      raw: z.unknown().optional(),
      url: z.unknown().optional(),
    })).length(1),
    contextId: z.string().max(200).optional(),
    taskId: z.string().optional(),
    referenceTaskIds: z.array(z.string()).optional(),
  }),
  configuration: z.object({
    acceptedOutputModes: z.array(z.string()).optional(),
    taskPushNotificationConfig: z.unknown().optional(),
    historyLength: z.number().int().nonnegative().optional(),
    returnImmediately: z.boolean().optional(),
  }).optional(),
})
const dataQuery = z.object({
  query: z.string(),
  skill: z.string().optional(),
})

const noStore = A2A_RESPONSE_HEADERS
type RequestId = string | number | null
function rpcError(id: RequestId, code: number, message: string): Response {
  return Response.json({ jsonrpc: "2.0", id, error: { code, message } }, { headers: noStore })
}

function rpcResult(id: RequestId, result: unknown): Response {
  return Response.json({ jsonrpc: "2.0", id, result }, { headers: noStore })
}

export const POST: APIRoute = async ({ request, locals, url }) => {
  const token = locals.agentToken
  if (!token) {
    return apiProblem({
      status: 401,
      detail: "Use a valid, active Meitheal agent token.",
      extraHeaders: { ...noStore, "WWW-Authenticate": "Bearer" },
    })
  }
  if (!hasScope(token.scopes, "a2a:execute") || !hasScope(token.scopes, "search:read")) {
    return apiProblem({ status: 403, detail: "A2A task search requires a2a:execute and search:read.", extraHeaders: noStore })
  }

  let id: RequestId = null
  try {
    const unavailable = await checkA2aAvailability()
    if (unavailable) return unavailable
    if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
      return apiProblem({ status: 415, detail: "Send A2A JSON-RPC requests as application/json.", extraHeaders: noStore })
    }
    const tooLarge = () => apiProblem({ status: 413, detail: "The A2A request exceeds 16 KiB.", extraHeaders: noStore })
    if (Number(request.headers.get("content-length")) > MAX_BODY_BYTES) return tooLarge()

    let body: unknown
    try {
      const bytes = await readWithinLimit(request.body, MAX_BODY_BYTES, request.signal)
      if (!bytes) return tooLarge()
      body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
    } catch {
      return rpcError(null, A2A_ERRORS.PARSE_ERROR, "Invalid JSON payload.")
    }

    const rpc = rpcRequest.safeParse(body)
    if (!rpc.success) return rpcError(null, A2A_ERRORS.INVALID_REQUEST, "Invalid JSON-RPC request.")
    if (rpc.data.id === undefined) return new Response(null, { status: 204, headers: noStore })
    id = rpc.data.id
    const version = request.headers.get("A2A-Version") ?? url.searchParams.get("A2A-Version")
    if ((version?.trim() || "0.3") !== A2A_PROTOCOL_VERSION) {
      return rpcError(id, A2A_ERRORS.VERSION_NOT_SUPPORTED, `Use A2A-Version: ${A2A_PROTOCOL_VERSION}.`)
    }

    const linkBase = getA2ALinkOrigin(request, url) + (locals.ingressPath ?? "")
    switch (rpc.data.method) {
      case "GetTask":
      case "CancelTask": {
        const wanted = taskRequest.safeParse(rpc.data.params)
        if (!wanted.success) return rpcError(id, A2A_ERRORS.INVALID_PARAMS, "Provide an A2A task id.")
        const task = await getA2aTask(token, wanted.data.id, linkBase)
        if (!task) return rpcError(id, A2A_ERRORS.TASK_NOT_FOUND, taskNotFound)
        // A household task is finished or handed back in Meitheal, never cancelled by a remote agent.
        return rpc.data.method === "GetTask" ? rpcResult(id, task)
          : rpcError(id, A2A_ERRORS.TASK_NOT_CANCELABLE, "Meitheal tasks cannot be cancelled over A2A.")
      }
      case "ListTasks": {
        const list = listRequest.safeParse(rpc.data.params ?? {})
        if (!list.success) return rpcError(id, A2A_ERRORS.INVALID_PARAMS, "Invalid task list parameters.")
        let statusTimestampAfterMs: number | undefined
        if (list.data.statusTimestampAfter !== undefined) {
          const ts = rfc3339Timestamp.safeParse(list.data.statusTimestampAfter)
          if (!ts.success) {
            return rpcError(id, A2A_ERRORS.INVALID_PARAMS, "Invalid statusTimestampAfter timestamp.")
          }
          statusTimestampAfterMs = Date.parse(ts.data)
        }
        return rpcResult(id, await listA2aTasks(token, linkBase, {
          pageSize: list.data.pageSize ?? 50,
          offset: Number(list.data.pageToken || 0),
          includeArtifacts: list.data.includeArtifacts ?? false,
          state: list.data.status,
          contextId: list.data.contextId,
          statusTimestampAfterMs,
        }))
      }
      case "SendStreamingMessage":
      case "SubscribeToTask":
      case "GetExtendedAgentCard":
        return rpcError(id, A2A_ERRORS.UNSUPPORTED_OPERATION, "This operation is unavailable on Meitheal.")
      case "CreateTaskPushNotificationConfig":
      case "GetTaskPushNotificationConfig":
      case "ListTaskPushNotificationConfigs":
      case "DeleteTaskPushNotificationConfig":
        return rpcError(id, A2A_ERRORS.PUSH_NOT_SUPPORTED, "A2A push notifications are unavailable.")
      case "SendMessage":
        return await searchTasks(id, rpc.data.params, linkBase)
      default:
        return rpcError(id, A2A_ERRORS.METHOD_NOT_FOUND, "Method not found.")
    }
  } catch (error) {
    logApiError("a2a", "A2A request failed", error)
    return rpcError(id, A2A_ERRORS.INTERNAL, "Could not process the A2A request.")
  }
}

async function searchTasks(id: RequestId, input: unknown, base: string): Promise<Response> {
  const parsed = messageRequest.safeParse(input)
  if (!parsed.success) return rpcError(id, A2A_ERRORS.INVALID_PARAMS, "Send a user message with a messageId and one search part.")

  const { message, configuration } = parsed.data
  if (message.taskId || message.referenceTaskIds?.length) return rpcError(id, A2A_ERRORS.TASK_NOT_FOUND, taskNotFound)
  if (configuration?.taskPushNotificationConfig) return rpcError(id, A2A_ERRORS.PUSH_NOT_SUPPORTED, "A2A push notifications are unavailable.")

  const part = message.parts[0]!
  const modes = configuration?.acceptedOutputModes
  const outputJson = !modes?.length || modes.includes("application/json")
  if (!outputJson && !modes?.includes("text/plain")) {
    return rpcError(id, A2A_ERRORS.CONTENT_TYPE_NOT_SUPPORTED, "Accept application/json or text/plain.")
  }

  const isText = part.text !== undefined && !("data" in part) && (!part.mediaType || part.mediaType === "text/plain")
  const isData = part.text === undefined && "data" in part && (!part.mediaType || part.mediaType === "application/json")
  if (("raw" in part) || ("url" in part) || (!isText && !isData)) {
    return rpcError(id, A2A_ERRORS.CONTENT_TYPE_NOT_SUPPORTED, "Send one text/plain or application/json search part.")
  }
  const data = isData ? dataQuery.safeParse(part.data) : null
  if (data?.success && data.data.skill && data.data.skill !== A2A_TASK_SEARCH_SKILL) {
    return rpcError(id, A2A_ERRORS.UNSUPPORTED_OPERATION, "A2A supports task-search only.")
  }
  const query = (isText ? part.text : data?.success ? data.data.query : "")?.trim()
  if (!query || query.length > 160) {
    return rpcError(id, A2A_ERRORS.INVALID_PARAMS, "Provide a task title search term of 1 to 160 characters.")
  }

  await ensureSchema()
  const { sections } = await searchMeithealCatalog({
    query,
    scope: "tasks",
    limit: 8,
    includeCompleted: false,
    includeArchived: false,
    sort: "relevance",
    taskFields: ["title"],
  })
  const tasks = sections.flatMap(section => section.items)
    .filter(item => item.kind === "task" && item.taskId)
    .map(item => ({ id: item.taskId, title: item.title, url: `${base}/tasks?open=${encodeURIComponent(item.taskId!)}` }))
  return rpcResult(id, {
    message: {
      role: "ROLE_AGENT",
      messageId: crypto.randomUUID(),
      contextId: message.contextId || crypto.randomUUID(),
      parts: [outputJson
        ? { data: { tasks }, mediaType: "application/json" }
        : { text: tasks.map(task => `${task.title} — ${task.url}`).join("\n") || "No matching tasks.", mediaType: "text/plain" }],
    },
  })
}
