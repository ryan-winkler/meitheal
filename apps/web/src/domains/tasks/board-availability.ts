import { apiProblem } from "@lib/api-response"
import { readWithinLimit } from "@lib/bounded-body"
import { taskParticipantBodySignal, taskParticipantBodyTimeout } from "@lib/task-participant"
import { boardRouteSelection } from "../../../scripts/board-route-selection.mjs"

export { isBoardTaskApiPath } from "../../../scripts/board-route-selection.mjs"

const noStore = { "cache-control": "private, no-store" }
const bodyLimit = 64 * 1024

export const boardDraftHeader = "X-Meitheal-Board-Id"

export function hasBoardSelection(body: unknown): boolean {
  return typeof body === "object" && body !== null &&
    (Object.hasOwn(body, "board_id") || Object.hasOwn(body, "board_name"))
}

export function unavailableBoardResponse(status: 400 | 404 = 404, bodyless = false): Response {
  if (bodyless) return new Response(null, { status, headers: noStore })
  return apiProblem({
    status,
    detail: status === 400 ? "Named Boards cannot be purged here." : "Board not found.",
    extraHeaders: noStore,
  })
}

export function rejectBoardSelectionInUrl(url: URL, routePattern: string, method: string): Response | undefined {
  if (!url.search) return
  const { searchParams } = url
  const selection = boardRouteSelection(routePattern, searchParams) ?? boardRouteSelection(url.pathname, searchParams)
  if (selection === "page") {
    return new Response(method === "HEAD" ? null : "Board not found.", { status: 404, headers: noStore })
  }
  if (selection) {
    return unavailableBoardResponse(selection === "bulk" && method === "DELETE" ? 400 : 404, method === "HEAD")
  }
}

/** Some existing mutations need no body. Check an optional JSON selector before they write. */
export async function rejectBoardSelectionInJson(request: Request, status: 400 | 404 = 404): Promise<Response | undefined> {
  if (!request.body) return
  const signal = taskParticipantBodySignal(request)
  try {
    const bytes = await readWithinLimit(request.body, bodyLimit, signal)
    if (!bytes) return apiProblem({ status: 413, detail: "This request body is limited to 64 KiB.", extraHeaders: noStore })
    if (!bytes.length) return
    const mediaType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase()
    if (mediaType !== "application/json" && !/^application\/[\w!#$%&'*+.^`|~-]+\+json$/.test(mediaType ?? "")) {
      return apiProblem({ status: 415, detail: "Send the optional body as JSON or omit it.", extraHeaders: noStore })
    }
    const body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return apiProblem({ status: 400, detail: "Send a JSON object or omit the request body.", extraHeaders: noStore })
    }
    if (hasBoardSelection(body)) return unavailableBoardResponse(status)
  } catch {
    if (signal.aborted) return taskParticipantBodyTimeout()
    return apiProblem({ status: 400, detail: "Send valid JSON or omit the request body.", extraHeaders: noStore })
  }
}
