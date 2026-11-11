import type { APIContext } from "astro"
import { FeedbackQueue, type FeedbackResult, type VerifiedFeedbackActor } from "@domains/support/feedback-queue"
import { verifyCurrentHAAdministrator, verifyCurrentHAParticipant } from "@domains/ha/current-admin"
import { ensureSchema, getPersistenceClient } from "@domains/tasks"
import { apiProblem } from "./api-response"
import { readWithinLimit } from "./bounded-body"
import { verifiedIngressUser } from "./verified-ingress-user"

const noStore = { "cache-control": "no-store" }
const maxBodyBytes = 8 * 1024

function feedbackActor(locals: App.Locals): VerifiedFeedbackActor | null {
  const user = verifiedIngressUser(locals)
  if (!user) return null

  // Each add-on installation has its own SQLite database. Clients never select a scope.
  return {
    installationId: "local",
    actorId: user.id,
    role: user.isAdmin ? "admin" : "member",
  }
}

export function feedbackProblem(status: number, detail: string): Response {
  return apiProblem({ status, detail, extraHeaders: noStore,
    ...(status === 408 ? { title: "Request Timeout" } : {}),
    ...(status === 499 ? { title: "Request Cancelled" } : {}),
  })
}

function cancelBody(request: Request): void {
  if (request.body && !request.body.locked) void request.body.cancel().catch(() => {})
}

export async function readFeedbackJson(request: Request): Promise<{ body: unknown } | { error: Response }> {
  if (request.signal.aborted) {
    cancelBody(request)
    return { error: feedbackProblem(499, "The feedback request was cancelled.") }
  }
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase()
  if (contentType !== "application/json") {
    cancelBody(request)
    return { error: feedbackProblem(415, "Send feedback as application/json.") }
  }
  const length = request.headers.get("content-length")
  const tooLarge = () => ({ error: feedbackProblem(413, "The request exceeds 8 KiB. Shorten the text and try again.") })
  if (length !== null && Number(length) > maxBodyBytes) {
    cancelBody(request)
    return tooLarge()
  }
  const deadline = AbortSignal.timeout(5_000)
  const signal = AbortSignal.any([request.signal, deadline])
  try {
    const bytes = await readWithinLimit(request.body, maxBodyBytes, signal)
    if (bytes === null) return tooLarge()
    return { body: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown }
  } catch {
    if (request.signal.aborted) return { error: feedbackProblem(499, "The feedback request was cancelled.") }
    if (deadline.aborted) return { error: feedbackProblem(408, "Feedback took too long to arrive. Keep the form open and retry.") }
    return { error: feedbackProblem(400, "Send a valid UTF-8 JSON request body.") }
  }
}

const feedbackErrors = {
  forbidden: [403, "Open Meitheal from Home Assistant with the required access."],
  invalid_input: [400, "Check the feedback fields and text limits, then try again."],
  conflict: [409, "The report or submission has changed. Refresh the queue or edit your submission and try again."],
  queue_full: [503, "The local feedback queue is full. Ask an administrator to remove closed reports."],
  not_found: [404, "This report is no longer in the local queue."],
} as const

export async function withFeedback<T>(
  { request, locals }: APIContext,
  access: "member" | "admin",
  successStatus: 200 | 201 | 204,
  operation: (queue: FeedbackQueue, actor: VerifiedFeedbackActor, body: unknown) => Promise<FeedbackResult<T> | Response>,
): Promise<Response> {
  const actor = feedbackActor(locals)
  const fetchSite = request.headers.get("sec-fetch-site")
  // Plain forms cannot set this header. Cross-origin scripts need a CORS
  // preflight, which these routes do not allow. Fetch Metadata adds a check
  // on browsers and origins that send it.
  const browserMutation = request.headers.get("x-meitheal-feedback") === "1"
    && (fetchSite === null || fetchSite === "same-origin")
  if (!actor || (access === "admin" && actor.role !== "admin")
    || (request.method !== "GET" && !browserMutation)) {
    cancelBody(request)
    return feedbackProblem(...feedbackErrors.forbidden)
  }

  try {
    let body: unknown
    if (request.method === "POST" || request.method === "PATCH") {
      const input = await readFeedbackJson(request)
      if ("error" in input) return input.error
      body = input.body
    }
    if (request.signal.aborted) return feedbackProblem(499, "The feedback request was cancelled.")
    await ensureSchema()
    const authority = await (access === "admin" ? verifyCurrentHAAdministrator : verifyCurrentHAParticipant)(
      actor.actorId, request.signal,
    )
    if (request.signal.aborted) return feedbackProblem(499, "The feedback request was cancelled.")
    if (authority === "unavailable") {
      return feedbackProblem(503, "Home Assistant could not verify your current access. Check the Core connection and retry.")
    }
    if (authority !== "allowed") return feedbackProblem(...feedbackErrors.forbidden)
    const result = await operation(new FeedbackQueue(getPersistenceClient()), actor, body)
    if (result instanceof Response) return result
    if (!result.ok) {
      const [status, detail] = feedbackErrors[result.errorCode]
      return feedbackProblem(status, detail)
    }
    return successStatus === 204
      ? new Response(null, { status: 204, headers: noStore })
      : Response.json(result.value, { status: successStatus, headers: noStore })
  } catch (error) {
    if (typeof error === "object" && error && "code" in error && error.code === "SQLITE_BUSY") {
      return feedbackProblem(503, "Feedback storage is busy. Try again shortly.")
    }
    return feedbackProblem(500, "Feedback storage is unavailable. Ask an administrator to check the local database.")
  }
}
