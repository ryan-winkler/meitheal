import type { APIRoute } from "astro"
import { z } from "zod"
import { createLogger, defaultRedactionPatterns } from "@meitheal/domain-observability"
import { deleteLabel, isWellFormedLabelName, LabelMutationError, updateLabel } from "@domains/labels"
import { ensureSchema } from "@domains/tasks"
import { readWithinLimit } from "@lib/bounded-body"
import { labelMutationContextFailure, labelMutationFailure as failure, labelMutationHeaders, requireLabelMutationAdministrator } from "@lib/label-mutation-access"
import { stripHtml } from "@lib/strip-html"

const logger = createLogger({ service: "meitheal-web", env: process.env.NODE_ENV ?? "development", minLevel: "info",
  enabledCategories: ["tasks", "audit", "observability"], redactPatterns: defaultRedactionPatterns, auditEnabled: true })
const update = z.strictObject({ title: z.string().optional(), hex_color: z.string().regex(/^#?[0-9a-fA-F]{6}$/).optional() })
  .refine(body => body.title !== undefined || body.hex_color !== undefined)
const cancelled = () => failure(499, "cancelled", "The label change was cancelled.")
const unavailable = () => failure(503, "unavailable", "Could not complete the label change. Review the current labels before trying again.")

function problem(error: unknown, action: "put" | "delete") {
  if (error instanceof LabelMutationError) {
    return error.errorCode === "conflict"
      ? failure(409, "conflict", "Another definition shares the old or new label name. Choose another name or remove a duplicate definition first.")
      : failure(409, "blocked", "Stored label selections need attention before this change. Check the Labels runbook.")
  }
  logger.log("error", { event: `api.labels.${action}.failed`, domain: "tasks", component: "labels-api",
    request_id: crypto.randomUUID(), message: "Could not complete the shared label change" })
  return unavailable()
}

export const PUT: APIRoute = async ({ params, request, locals }) => {
  const denied = labelMutationContextFailure(request, locals)
  if (denied) return denied
  const id = Number(params.id)
  if (!Number.isSafeInteger(id) || id < 1) return failure(400, "invalid", "Use a positive safe integer label ID.")
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    return failure(415, "media", "Send label changes as application/json.")
  }
  const limit = 4 * 1024
  if (Number(request.headers.get("content-length")) > limit) return failure(413, "tooLarge", "The label change must fit within 4 KiB.")
  const reading = AbortSignal.any([request.signal, AbortSignal.timeout(5000)])
  let parsed
  try {
    const body = await readWithinLimit(request.body, limit, reading)
    if (!body) return failure(413, "tooLarge", "The label change must fit within 4 KiB.")
    parsed = update.safeParse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)))
  } catch {
    if (request.signal.aborted) return cancelled()
    if (reading.aborted) return unavailable()
    return failure(400, "invalid", "Send a valid UTF-8 label change.")
  }
  if (!parsed.success) return failure(400, "invalid", "Provide a label title, a six-digit hex_color, or both, without extra fields.")
  const title = parsed.data.title === undefined ? undefined : stripHtml(parsed.data.title).trim()
  if (title !== undefined && (!title || title.length > 100 || !isWellFormedLabelName(title))) {
    return failure(400, "invalid", "Use a valid label title of 1 to 100 characters after removing HTML.")
  }
  try {
    if (request.signal.aborted) return cancelled()
    await ensureSchema()
    if (request.signal.aborted) return cancelled()
    const current = await requireLabelMutationAdministrator(request, locals)
    if (current) return current
    if (request.signal.aborted) return cancelled()
    const label = await updateLabel(id, {
      ...(title === undefined ? {} : { title }),
      ...(parsed.data.hex_color === undefined ? {} : { hexColor: parsed.data.hex_color }),
    })
    if (!label) return failure(404, "missing", "The label is no longer available. Reload Labels.")
    return Response.json({ id: label.id, title: label.title, hex_color: label.hexColor }, { headers: labelMutationHeaders })
  } catch (error) { return problem(error, "put") }
}

export const DELETE: APIRoute = async ({ params, request, locals }) => {
  const denied = labelMutationContextFailure(request, locals)
  if (denied) return denied
  const id = Number(params.id)
  if (!Number.isSafeInteger(id) || id < 1) return failure(400, "invalid", "Use a positive safe integer label ID.")
  if (request.body) {
    try {
      const body = await readWithinLimit(request.body, 0, AbortSignal.any([request.signal, AbortSignal.timeout(5000)]))
      if (!body) return failure(400, "invalid", "Send label deletion without a request body.")
    } catch { return request.signal.aborted ? cancelled() : unavailable() }
  }
  try {
    if (request.signal.aborted) return cancelled()
    await ensureSchema()
    if (request.signal.aborted) return cancelled()
    const current = await requireLabelMutationAdministrator(request, locals)
    if (current) return current
    if (request.signal.aborted) return cancelled()
    if (!await deleteLabel(id)) return failure(404, "missing", "The label is no longer available. Reload Labels.")
    return Response.json({ ok: true, deleted: id }, { headers: labelMutationHeaders })
  } catch (error) { return problem(error, "delete") }
}
