import type { APIRoute } from "astro"
import { updateLabel, deleteLabel } from "@domains/labels"
import { stripHtml } from "../../../lib/strip-html"
import { apiError, apiJson } from "../../../lib/api-response"
import {
  createLogger,
  defaultRedactionPatterns,
} from "@meitheal/domain-observability"

const logger = createLogger({
  service: "meitheal-web",
  env: process.env.NODE_ENV ?? "development",
  minLevel: "info",
  enabledCategories: ["tasks", "audit", "observability"],
  redactPatterns: defaultRedactionPatterns,
  auditEnabled: true,
})

/**
 * Label CRUD API — individual label operations
 * PUT /api/labels/[id] — update label { title?, hex_color? }
 * DELETE /api/labels/[id] — delete label
 */

export const PUT: APIRoute = async ({ params, request }) => {
  const id = Number(params.id)
  if (!Number.isFinite(id) || id <= 0) {
    return apiError("Invalid label ID", 400)
  }

  try {
    const body = (await request.json().catch(() => ({}))) as Record<
      string,
      unknown
    >
    const updates: { title?: string; hexColor?: string } = {}

    if (typeof body.title === "string") {
      const title = stripHtml(body.title.trim())
      if (!title) return apiError("title cannot be empty", 400)
      if (title.length > 100)
        return apiError("title must be 100 characters or less", 400)
      updates.title = title
    }

    if (typeof body.hex_color === "string") {
      if (!/^#?[0-9a-fA-F]{6}$/.test(body.hex_color)) {
        return apiError("hex_color must be a valid 6-digit hex color", 400)
      }
      updates.hexColor = body.hex_color
    }

    if (!updates.title && !updates.hexColor) {
      return apiError("At least one of title or hex_color is required", 400)
    }

    const label = await updateLabel(id, updates)
    if (!label) {
      return apiError("Label not found", 404)
    }

    return apiJson({
      id: label.id,
      title: label.title,
      hex_color: label.hexColor,
    })
  } catch (err) {
    logger.log("error", {
      event: "api.labels.put.failed",
      domain: "tasks",
      component: "labels-api",
      request_id: crypto.randomUUID(),
      message: `Failed to update label ${id}`,
    })
    return apiError("Failed to update label")
  }
}

export const DELETE: APIRoute = async ({ params }) => {
  const id = Number(params.id)
  if (!Number.isFinite(id) || id <= 0) {
    return apiError("Invalid label ID", 400)
  }

  try {
    const deleted = await deleteLabel(id)
    if (!deleted) {
      return apiError("Label not found", 404)
    }

    return apiJson({ ok: true, deleted: id })
  } catch (err) {
    logger.log("error", {
      event: "api.labels.delete.failed",
      domain: "tasks",
      component: "labels-api",
      request_id: crypto.randomUUID(),
      message: `Failed to delete label ${id}`,
    })
    return apiError("Failed to delete label")
  }
}
