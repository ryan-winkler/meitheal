import { withBoardScope } from "@lib/board-http"
import type { APIRoute } from "astro"
import { hasBoardSelection, unavailableBoardResponse } from "@domains/tasks/board-availability"
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

export const GET: APIRoute = withBoardScope({ resource: "task", action: "read" }, async (context, scope) => {
  try {
    await ensureSchema()
    const repo = new LaneRepository(getPersistenceClient(), scope)
    const rawLanes = await repo.findAll()

    const lanes = rawLanes.map((r) => ({
      id: r.id,
      key: r.key,
      label: r.label,
      icon: r.icon,
      color: typeof r.color === "string" && /^#[0-9a-fA-F]{6}$/.test(r.color) ? r.color : null,
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
})

export const POST: APIRoute = withBoardScope({ resource: "board", action: "manage" }, async ({ request }, scope) => {
  try {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
    if (hasBoardSelection(body)) return unavailableBoardResponse()
    await ensureSchema()
    const repo = new LaneRepository(getPersistenceClient(), scope)

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
    const rawColor = typeof body.color === "string" ? body.color.trim() : ""
    if (rawColor && !/^#[0-9a-fA-F]{6}$/.test(rawColor)) {
      return apiError("Invalid lane color (expected #RRGGBB)", 400)
    }
    const color = rawColor || null
    const wipLimit = typeof body.wip_limit === "number" ? Math.max(0, Math.round(body.wip_limit)) : 0
    const maxPos = await repo.getMaxPosition()
    const position = typeof body.position === "number" ? body.position : (maxPos + 1)
    const rawIncludes = Array.isArray(body.includes)
      ? body.includes.filter((s): s is string => typeof s === "string" && /^[a-z0-9_]{1,50}$/.test(s))
      : []
    const includesList = rawIncludes.length ? [...new Set(rawIncludes)] : [key]
    const includes = JSON.stringify(includesList)
    const now = Date.now()

    await repo.create({ id, key, label, icon, color, position, wipLimit, includes })

    return apiJson({ id, key, label, icon, color, position, wip_limit: wipLimit, includes: includesList, builtIn: false, created_at: now, updated_at: now }, 201)
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
})

export const PUT: APIRoute = withBoardScope({ resource: "board", action: "manage" }, async ({ request }, scope) => {
  try {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
    if (hasBoardSelection(body)) return unavailableBoardResponse()
    const ids = Array.isArray(body.ordered_ids) ? body.ordered_ids : null
    if (!ids || ids.length === 0 || !ids.every((id): id is string => typeof id === "string" && id.length > 0)) {
      return apiError("ordered_ids array required", 400)
    }
    await ensureSchema()
    const repo = new LaneRepository(getPersistenceClient(), scope)
    const ok = await repo.reorder(ids)
    return ok ? apiJson({ ok: true }) : apiError("Invalid lane order", 400)
  } catch {
    return apiError("Failed to reorder lanes")
  }
})
