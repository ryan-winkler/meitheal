import type { APIContext } from "astro"
import { FeedbackQueue, type FeedbackResult, type VerifiedFeedbackActor } from "@domains/support/feedback-queue"
import { getPersistenceClient } from "@domains/tasks/persistence/store"
import { apiProblem } from "./api-response"
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
  return apiProblem({ status, detail, extraHeaders: noStore })
}

export async function readFeedbackJson(request: Request): Promise<{ body: unknown } | { error: Response }> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase()
  if (contentType !== "application/json") {
    return { error: feedbackProblem(415, "Send feedback as application/json.") }
  }

  const length = request.headers.get("content-length")
  const tooLarge = () => ({ error: feedbackProblem(413, "The request exceeds 8 KiB. Shorten the text and try again.") })
  if (length !== null && Number(length) > maxBodyBytes) return tooLarge()

  const reader = request.body?.getReader()
  if (!reader) return { error: feedbackProblem(400, "Send a JSON request body.") }

  const bytes = new Uint8Array(maxBodyBytes)
  let offset = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value.byteLength > bytes.length - offset) {
        void reader.cancel().catch(() => {})
        return tooLarge()
      }
      bytes.set(value, offset)
      offset += value.byteLength
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, offset))
    return { body: JSON.parse(text) as unknown }
  } catch {
    return { error: feedbackProblem(400, "Send a valid UTF-8 JSON request body.") }
  } finally {
    reader.releaseLock()
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
  operation: (queue: FeedbackQueue, actor: VerifiedFeedbackActor) => Promise<FeedbackResult<T> | Response>,
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
    return feedbackProblem(...feedbackErrors.forbidden)
  }

  try {
    const result = await operation(new FeedbackQueue(getPersistenceClient()), actor)
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
