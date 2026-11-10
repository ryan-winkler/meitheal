import type { APIRoute } from "astro"
import { apiError } from "../../../lib/api-response"
import { getTodayTaskCounts } from "../../../lib/task-queries"

export const GET: APIRoute = async () => {
  try {
    return Response.json(await getTodayTaskCounts(), {
      headers: { "cache-control": "private, no-store" },
    })
  } catch {
    return apiError("Today counts are unavailable. Try again shortly.", 503)
  }
}
