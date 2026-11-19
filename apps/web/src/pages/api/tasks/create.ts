import type { APIRoute } from "astro"
import { POST as createTask } from "./index"
import { apiError } from "@lib/api-response"

/** Earlier calendar capture clients use the same scoped task command as every other view. */
export const POST: APIRoute = async context => {
  if (context.request.headers.has("X-Meitheal-Capture-Attempt")) return apiError("Use the canonical task endpoint for capture receipts.", 400)
  const body: unknown = await context.request.json().catch(() => null)
  if (!body || typeof body !== "object" || Array.isArray(body)) return apiError("Send a task object.", 400)
  const input = body as Record<string, unknown>
  const legacyFramework = input.frameworkPayload
  if (legacyFramework !== undefined && (!legacyFramework || typeof legacyFramework !== "object" || Array.isArray(legacyFramework))) {
    return apiError("frameworkPayload must be an object.", 400)
  }
  const framework = legacyFramework as Record<string, unknown> | undefined
  const description = typeof input.description === "string" ? input.description
    : typeof framework?.description === "string" ? framework.description : ""
  const calendar = input.calendar && typeof input.calendar === "object" && !Array.isArray(input.calendar)
    ? input.calendar as Record<string, unknown> : undefined
  const translated: Record<string, unknown> = {
    ...input,
    description: description.slice(0, 10_000),
    ...(framework === undefined ? {} : { framework_payload: JSON.stringify(framework) }),
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
  const response = await createTask({ ...context, request })
  if (!response.ok) return response
  const task = await response.json() as Record<string, unknown>
  // This compatibility route retains its envelope. The canonical command owns
  // dispatch; asynchronous integration receipts are not fabricated here.
  const frameworkPayload = typeof task.framework_payload === "string" ? JSON.parse(task.framework_payload) : undefined
  const envelope = {
    task: { ...task, ...(frameworkPayload === undefined ? {} : { frameworkPayload }) },
    events: [],
    integration: { calendarSyncState: typeof task.calendar_sync_state === "string" ? task.calendar_sync_state : "pending",
      confirmationId: null, errorCode: null, retryAfterSeconds: null },
  }
  const responseHeaders = new Headers(response.headers)
  responseHeaders.delete("Content-Length")
  return new Response(JSON.stringify(envelope), { status: response.status, headers: responseHeaders })
}
