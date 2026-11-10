import type { APIRoute } from "astro"
import type { InValue } from "@libsql/client"
import { ensureSchema, getPersistenceClient } from "@domains/tasks/persistence/store"
import { LaneRepository } from "@domains/tasks/persistence/lane-repository"
import { stripHtml } from "../../../lib/strip-html"
import { apiError, apiJson } from "../../../lib/api-response"
import { createLogger, defaultRedactionPatterns } from "@meitheal/domain-observability"

const logger = createLogger({
  service: "meitheal-web",
  env: process.env.NODE_ENV ?? "development",
  minLevel: "info",
  enabledCategories: ["tasks", "audit", "observability"],
  redactPatterns: defaultRedactionPatterns,
  auditEnabled: true,
})

/** PUT /api/lanes/[id], DELETE /api/lanes/[id] */

export const PUT: APIRoute = async ({ params, request }) => {
  try {
    await ensureSchema()
    const repo = new LaneRepository(getPersistenceClient())
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>

    const existing = await repo.findById(params.id!)
    if (!existing) {
      return apiError("Lane not found", 404)
    }

    const isBuiltIn = Number(existing.built_in ?? 0) === 1

    if (isBuiltIn && (body.key !== undefined || body.includes !== undefined)) {
      return apiError("Cannot change key or includes on built-in lanes", 403)
    }

    const fields: Record<string, InValue> = {}

    if (typeof body.label === "string") {
      const label = stripHtml(body.label.trim())
      if (!label || label.length < 1 || label.length > 50) {
        return apiError("label must be 1-50 characters", 400)
      }
      fields.label = label
    }
    if (typeof body.icon === "string") {
      fields.icon = body.icon.slice(0, 4)
    }
    if (typeof body.position === "number") {
      fields.position = Math.max(0, Math.round(body.position))
    }
    if (typeof body.wip_limit === "number") {
      fields.wip_limit = Math.max(0, Math.round(body.wip_limit))
    }
    if (typeof body.includes === "string") {
      try {
        const parsed = JSON.parse(body.includes)
        if (Array.isArray(parsed)) {
          fields.includes = body.includes
        }
      } catch { /* skip invalid JSON */ }
    }

    if (Object.keys(fields).length === 0) {
      return apiError("No fields to update", 400)
    }

    const updated = await repo.update(params.id!, fields)
    if (!updated) {
      return apiError("Update failed", 500)
    }

    return apiJson({
      id: updated.id,
      key: updated.key,
      label: updated.label,
      icon: updated.icon,
      position: Number(updated.position ?? 0),
      wip_limit: Number(updated.wip_limit ?? 0),
      includes: typeof updated.includes === "string" ? JSON.parse(String(updated.includes)) : [],
      builtIn: Number(updated.built_in ?? 0) === 1,
      created_at: updated.created_at,
      updated_at: updated.updated_at,
    })
  } catch (err) {
    logger.log("error", {
      event: "api.lanes.put.failed",
      domain: "tasks",
      component: "lanes-api",
      request_id: crypto.randomUUID(),
      message: "Internal server error",
    })
    return apiError("Failed to update lane")
  }
}

export const DELETE: APIRoute = async ({ params }) => {
  try {
    await ensureSchema()
    const repo = new LaneRepository(getPersistenceClient())

    const existing = await repo.findForDelete(params.id!)
    if (!existing) {
      return apiError("Lane not found", 404)
    }

    if (Number(existing.built_in ?? 0) === 1) {
      return apiError("Cannot delete built-in lane", 403)
    }

    const key = String(existing.key)
    await repo.delete(params.id!, key)

    return apiJson({ deleted: true, tasksReassigned: key })
  } catch (err) {
    logger.log("error", {
      event: "api.lanes.delete.failed",
      domain: "tasks",
      component: "lanes-api",
      request_id: crypto.randomUUID(),
      message: "Internal server error",
    })
    return apiError("Failed to delete lane")
  }
}
