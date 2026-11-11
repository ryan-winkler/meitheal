import type { APIRoute } from "astro"
import { ensureSchema, getPersistenceClient } from "@domains/tasks/persistence/store"
import { TaskRepository } from "@domains/tasks/persistence/task-repository"
import { apiError, apiJson } from "../../../lib/api-response"
import { isFeatureEnabled } from "../../../lib/feature-flags"
import { readWithinLimit } from "../../../lib/bounded-body"
import { PUT as updateTask } from "../tasks/[id]"
import { HA_EVENT_AUTHORITY_HEADER } from "../../../lib/webhook-dispatcher"

/** Complete the uniquely assigned task through the ordinary task mutation path. */
export const POST: APIRoute = async (context) => {
  if (!(await isFeatureEnabled("nfc"))) return apiError("NFC completion is disabled", 404)
  let body: unknown
  try {
    const bytes = await readWithinLimit(context.request.body, 4096, context.request.signal)
    if (!bytes) return apiError("NFC completion request exceeds 4 KiB", 413)
    body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
  } catch { return apiError("Provide a JSON object with tag_id", 400) }
  if (!body || typeof body !== "object" || Array.isArray(body)) return apiError("Provide a JSON object with tag_id", 400)
  const input = body as Record<string, unknown>
  if (!body || typeof input.tag_id !== "string" || !input.tag_id.trim() || input.tag_id.trim().length > 255) {
    return apiError("tag_id must be 1-255 characters", 400)
  }
  await ensureSchema()
  const repo = new TaskRepository(getPersistenceClient())
  const matches = await repo.findByNfcTag(input.tag_id.trim())
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
      method: "PUT", headers, signal: context.request.signal, body: JSON.stringify({ status: "complete" }),
    }),
  })
  if (!response.ok) return response
  const result = apiJson({ ok: true, task_id: task.id, task: await response.json() })
  const authority = response.headers.get(HA_EVENT_AUTHORITY_HEADER)
  if (authority) result.headers.set(HA_EVENT_AUTHORITY_HEADER, authority)
  return result
}
