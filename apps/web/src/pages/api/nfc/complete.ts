import type { APIRoute } from "astro"
import { ensureSchema, getPersistenceClient } from "@domains/tasks/persistence/store"
import { TaskRepository } from "@domains/tasks/persistence/task-repository"
import { apiError, apiJson } from "../../../lib/api-response"
import { isFeatureEnabled } from "../../../lib/feature-flags"
import { PUT as updateTask } from "../tasks/[id]"

/** Complete the uniquely assigned task through the ordinary task mutation path. */
export const POST: APIRoute = async (context) => {
  if (!(await isFeatureEnabled("nfc"))) return apiError("NFC completion is disabled", 404)
  const body = await context.request.json().catch(() => null)
  if (!body || typeof body.tag_id !== "string" || !body.tag_id.trim() || body.tag_id.trim().length > 255) {
    return apiError("tag_id must be 1-255 characters", 400)
  }
  await ensureSchema()
  const repo = new TaskRepository(getPersistenceClient())
  const matches = await repo.findByNfcTag(body.tag_id.trim())
  if (!matches.length) return apiError("No task is assigned to this NFC tag", 404)
  if (matches.length > 1) return apiError("NFC tag is assigned to multiple tasks; remove duplicate assignments", 409)
  const task = matches[0]!
  if (task.status === "complete") return apiJson({ ok: true, task_id: task.id, already_complete: true })
  const headers = new Headers(context.request.headers)
  headers.set("content-type", "application/json")
  const response = await updateTask({
    ...context,
    params: { ...context.params, id: task.id },
    request: new Request(new URL(`/api/tasks/${encodeURIComponent(task.id)}`, context.request.url), {
      method: "PUT", headers, body: JSON.stringify({ status: "complete" }),
    }),
  })
  if (!response.ok) return response
  return apiJson({ ok: true, task_id: task.id, task: await response.json() })
}
