import { createHash } from "node:crypto"
import { isTaskReactionRoute, resolveAgentRouteScope } from "@meitheal/domain-auth"
import { apiProblem } from "./api-response"
import { readWithinLimit } from "./bounded-body"
import { idempotencyCache } from "./idempotency-cache"
import { taskParticipantBodyTimeout } from "./task-participant"

const MAX_KEY_LENGTH = 255
const MAX_REQUEST_BYTES = 64 * 1024
const MAX_RESPONSE_BYTES = 16 * 1024

/** Replay keys apply only to authenticated task mutations. */
export async function taskRetryKey(request: Request, url: URL, principal: string | undefined, bodySignal?: AbortSignal): Promise<string | Response | undefined> {
  const clientKey = request.headers.get("idempotency-key")
  if (clientKey === null || !principal) return
  // Deferral retries must compare against the live revision, even with a replay key.
  if (request.method === "PATCH" && /^\/api\/tasks\/[\w-]+\/deferral$/.test(url.pathname)) return

  // Reactions use their database identity so removing and adding one never replays stale data.
  if (isTaskReactionRoute(url.pathname)) return

  const scope = resolveAgentRouteScope(url.pathname, request.method)
  const compatCreate = request.method === "PUT" && /^\/api\/v1\/projects\/\d+\/tasks$/.test(url.pathname)
  if (!compatCreate && scope !== "tasks:write" && scope !== "tasks:delete") return

  if (!clientKey || clientKey.length > MAX_KEY_LENGTH || /[\u0000-\u001f\u007f]/.test(clientKey)) {
    return apiProblem({ status: 400, detail: "Idempotency-Key must contain 1 to 255 characters without control characters." })
  }

  let body: Buffer | null
  try {
    body = await readWithinLimit(request.clone().body, MAX_REQUEST_BYTES, bodySignal)
  } catch (error) {
    if (bodySignal?.aborted) return taskParticipantBodyTimeout()
    throw error
  }
  if (!body) return apiProblem({ status: 413, detail: "A retryable task request body cannot exceed 64 KiB." })

  const namespace = JSON.stringify([
    "task-v2", principal, request.method, url.pathname, url.search, request.headers.get("content-type"), clientKey,
  ])
  return createHash("sha256").update(namespace).update(body).digest("hex")
}

export async function replayTaskRequest(key: string, next: () => Promise<Response>): Promise<Response> {
  const cached = idempotencyCache.get(key)
  if (cached) {
    return new Response(cached.body, {
      status: cached.status,
      headers: { ...cached.headers, "Idempotency-Key-Status": "cached" },
    })
  }
  if (idempotencyCache.isInFlight(key)) {
    return apiProblem({ status: 409, detail: "This task request is already in progress." })
  }
  if (!idempotencyCache.markInFlight(key)) {
    return apiProblem({ status: 503, detail: "Task retry capacity is temporarily full. Try again shortly." })
  }

  try {
    const response = await next()
    const contentType = response.headers.get("content-type")
    if (response.ok && response.body && contentType?.startsWith("application/json")) {
      try {
        const body = await readWithinLimit(response.clone().body, MAX_RESPONSE_BYTES)
        if (body) {
          idempotencyCache.set(key, {
            body: body.toString("utf8"),
            status: response.status,
            headers: { "content-type": contentType },
            processedAt: Date.now(),
          })
          response.headers.set("Idempotency-Key-Status", "processed")
        }
      } catch {
        // The original response can still be delivered if buffering fails.
      }
    }
    return response
  } finally {
    if (idempotencyCache.isInFlight(key)) idempotencyCache.remove(key)
  }
}
