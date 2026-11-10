import type { APIRoute } from "astro"
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

/** GET /api/lanes — list all lanes, POST /api/lanes — create a lane */

export const GET: APIRoute = async () => {
  try {
    await ensureSchema()
    const repo = new LaneRepository(getPersistenceClient())
    const rawLanes = await repo.findAll()

    const lanes = rawLanes.map((r) => ({
      id: r.id,
      key: r.key,
      label: r.label,
      icon: r.icon,
      position: Number(r.position ?? 0),
      wip_limit: Number(r.wip_limit ?? 0),
      includes: typeof r.includes === "string" ? JSON.parse(String(r.includes)) : [],
      builtIn: Number(r.built_in ?? 0) === 1,
      created_at: r.created_at,
      updated_at: r.updated_at,
    }))

    return apiJson({ lanes })
  } catch (err) {
    logger.log("error", {
      event: "api.lanes.get.failed",
      domain: "tasks",
      component: "lanes-api",
      request_id: crypto.randomUUID(),
      message: "Internal server error",
    })
    return apiError("Failed to list lanes")
  }
}

export const POST: APIRoute = async ({ request }) => {
  try {
    await ensureSchema()
    const repo = new LaneRepository(getPersistenceClient())
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>

    const rawLabel = typeof body.label === "string" ? body.label.trim() : ""
    const label = stripHtml(rawLabel)
    if (!label || label.length < 1 || label.length > 50) {
      return apiError("label must be 1-50 characters", 400)
    }

    const key = (typeof body.key === "string" ? body.key : label)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_|_$/g, "")

    if (!key) {
      return apiError("Invalid lane key", 400)
    }

    if (await repo.keyExists(key)) {
      return apiError("Lane with this key already exists", 409)
    }

    const id = `lane-${crypto.randomUUID()}`
    const icon = typeof body.icon === "string" ? body.icon.slice(0, 4) : "📌"
    const wipLimit = typeof body.wip_limit === "number" ? Math.max(0, Math.round(body.wip_limit)) : 0
    const maxPos = await repo.getMaxPosition()
    const position = typeof body.position === "number" ? body.position : (maxPos + 1)
    const includes = JSON.stringify([key])
    const now = Date.now()

    await repo.create({ id, key, label, icon, position, wipLimit, includes })

    return apiJson({ id, key, label, icon, position, wip_limit: wipLimit, includes: [key], builtIn: false, created_at: now, updated_at: now }, 201)
  } catch (err) {
    logger.log("error", {
      event: "api.lanes.post.failed",
      domain: "tasks",
      component: "lanes-api",
      request_id: crypto.randomUUID(),
      message: "Internal server error",
    })
    return apiError("Failed to create lane")
  }
}
