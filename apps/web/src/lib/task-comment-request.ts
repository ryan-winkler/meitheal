import { createLogger, defaultRedactionPatterns } from "@meitheal/domain-observability"
import { apiError, apiJson } from "./api-response"
import { hasCommentMentionSelector, isIndentedCommentCode } from "./comment-mentions"
import { readWithinLimit } from "./bounded-body"
import { taskParticipantBodySignal, taskParticipantBodyTimeout } from "./task-participant"
import { sanitize } from "./sanitize"

export { activeParticipantRequired, hasCurrentTaskParticipant, resolveTaskAuthor as resolveCommentAuthor } from "./task-participant"

const maxBodyBytes = 32 * 1024
const maxContentLength = 5000

export async function readComment(request: Request): Promise<string | Response> {
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    return apiError("Send the comment as application/json", 415)
  }
  const tooLarge = () => apiError("The comment request exceeds 32 KiB", 413)
  if (Number(request.headers.get("content-length")) > maxBodyBytes) return tooLarge()

  const signal = taskParticipantBodySignal(request)
  let payload: unknown
  try {
    const bytes = await readWithinLimit(request.body, maxBodyBytes, signal)
    if (!bytes) return tooLarge()
    payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
  } catch {
    if (signal.aborted) return taskParticipantBodyTimeout()
    return apiError("Send a valid UTF-8 JSON request body", 400)
  }
  const rawContent = payload && typeof payload === "object" && "content" in payload
    && typeof payload.content === "string" ? payload.content : ""
  const trimmed = rawContent.trim()
  let content = trimmed
  if (trimmed.length <= maxContentLength) {
    if (hasCommentMentionSelector(rawContent)) {
      // Trimming away the first line's indentation could turn an example into a delivery.
      const cleaned = sanitize(rawContent).replace(/^(?:[ \t\r]*\n)+/, "").trimEnd()
      content = isIndentedCommentCode(cleaned) ? cleaned : cleaned.trimStart()
    } else {
      content = sanitize(trimmed).trim()
    }
  }
  if (!content.trim()) return apiError("content is required", 400)
  if (content.length > maxContentLength) {
    return apiError("content must be 5000 characters or less", 400)
  }
  return content
}

const logger = createLogger({
  service: "meitheal-web",
  env: process.env.NODE_ENV ?? "development",
  minLevel: "info",
  enabledCategories: ["tasks", "audit", "observability"],
  redactPatterns: defaultRedactionPatterns,
  auditEnabled: true,
})

export function commentJson(value: unknown, status = 200): Response {
  const response = apiJson(value, status)
  response.headers.set("Cache-Control", "no-store")
  return response
}

export function commentFailure(operation: "get" | "post" | "patch" | "delete", message: string): Response {
  logger.log("error", {
    event: `api.comments.${operation}.failed`,
    domain: "tasks",
    component: "comments-api",
    request_id: crypto.randomUUID(),
    message: "Internal server error",
  })
  return apiError(message)
}
