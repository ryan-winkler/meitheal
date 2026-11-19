import type { APIRoute } from "astro"
import { POST as createTask } from "./index"
import { apiError } from "@lib/api-response"

/** Earlier calendar capture clients use the same scoped task command as every other view. */
export const POST: APIRoute = async context => {
  if (context.request.headers.has("X-Meitheal-Capture-Attempt")) return apiError("Use the canonical task endpoint for capture receipts.", 400)
  const body: unknown = await context.request.json().catch(() => null)
  if (!body || typeof body !== "object" || Array.isArray(body)) return apiError("Send a task object.", 400)
  const input = body as Record<string, unknown>
  const calendar = input.calendar && typeof input.calendar === "object" && !Array.isArray(input.calendar)
    ? input.calendar as Record<string, unknown> : undefined
  const translated: Record<string, unknown> = {
    ...input,
    ...(input.frameworkPayload === undefined ? {} : { framework_payload: input.frameworkPayload }),
    ...(calendar ? {
      task_kind: input.task_kind ?? "calendar_event",
      start_date: input.start_date ?? calendar.startDateTime,
      end_date: input.end_date ?? calendar.endDateTime,
      due_date: input.due_date ?? calendar.startDateTime,
    } : {}),
  }
  delete translated.frameworkPayload
  delete translated.calendar
  const headers = new Headers(context.request.headers)
  headers.delete("Content-Length")
  const request = new Request(context.request.url, {
    method: "POST", headers, body: JSON.stringify(translated), signal: context.request.signal,
  })
  return createTask({ ...context, request })
}
