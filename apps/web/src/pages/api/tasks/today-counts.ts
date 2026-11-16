import type { APIRoute } from "astro"
import { apiError } from "../../../lib/api-response"
import { getTodayTaskCounts } from "../../../lib/task-queries"

export const GET: APIRoute = async ({ locals }) => {
  try {
    const timezone = typeof locals?.timezone === "string" && locals.timezone ? locals.timezone : undefined
    return Response.json(await getTodayTaskCounts(new Date(), timezone), {
      headers: { "cache-control": "private, no-store" },
    })
  } catch {
    return apiError("Today counts are unavailable. Try again shortly.", 503)
  }
}
