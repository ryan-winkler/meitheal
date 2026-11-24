import type { APIRoute } from "astro"
import { getVisiblePillar, readPillarBody } from "@lib/personal-pillar-access"
import { apiJson, apiError } from "../../../../lib/api-response"
import { logApiError } from "../../../../lib/api-logger"
import {
  updatePillar,
  deletePillar,
} from "@domains/pillars"

/**
 * Pillar Detail API — Get, Update, Delete
 *
 * GET    /api/pillars/:id — Get a single Pillar
 * PATCH  /api/pillars/:id — Update a Pillar
 * DELETE /api/pillars/:id — Soft-delete a Pillar (hard-delete via ?hard=true)
 *
 * @domain pillars
 */

export const GET: APIRoute = async ({ params, request, locals }) => {
  try {
    const id = params.id
    if (!id) return apiError("Pillar ID is required", 400)

    const visible = await getVisiblePillar(id, { locals, request }, "read")
    if (visible instanceof Response) return visible
    if (!visible) return apiError("Pillar not found", 404)
    const { pillar, ownerScope } = visible

    return apiJson({ pillar })
  } catch (error) {
    logApiError("pillars", "GET [id] error", error)
    return apiError("Failed to get pillar")
  }
}

export const PATCH: APIRoute = async ({ params, request, locals }) => {
  try {
    const id = params.id
    if (!id) return apiError("Pillar ID is required", 400)

    const body = await readPillarBody(request)
    if (body instanceof Response) return body

    const visible = await getVisiblePillar(id, { locals, request }, "edit")
    if (visible instanceof Response) return visible
    if (!visible) return apiError("Pillar not found", 404)
    const { pillar, ownerScope } = visible


    if (body.audience !== undefined || body.userId !== undefined || body.user_id !== undefined) {
      return apiError("The audience is set when the Pillar is created.", 400)
    }

    if (body.weight !== undefined) {
      const weight = Number(body.weight)
      if (isNaN(weight) || weight < 1 || weight > 10) {
        return apiError("weight must be between 1 and 10", 400)
      }
    }

    if (body.name !== undefined) {
      const name = String(body.name).trim()
      if (!name) return apiError("name cannot be empty", 400)
      if (name.length > 100) return apiError("name must be 100 characters or fewer", 400)
    }

    const updates: Parameters<typeof updatePillar>[2] = {}
    if (typeof body.name === "string") updates.name = body.name.trim()
    if (body.manifesto !== undefined) updates.manifesto = body.manifesto === null ? null : String(body.manifesto)
    if (typeof body.icon === "string") updates.icon = body.icon
    if (typeof body.colorHex === "string") updates.colorHex = body.colorHex
    if (typeof body.weight === "number") updates.weight = body.weight
    if (typeof body.position === "number") updates.position = body.position
    if (typeof body.isActive === "boolean") updates.isActive = body.isActive

    const updated = await updatePillar(ownerScope, id, updates)

    if (!updated) return apiError("Pillar not found or no changes", 404)
    return apiJson({ ok: true })
  } catch (error) {
    logApiError("pillars", "PATCH [id] error", error)
    return apiError("Failed to update pillar")
  }
}

export const DELETE: APIRoute = async ({ params, url, request, locals }) => {
  try {
    const id = params.id
    if (!id) return apiError("Pillar ID is required", 400)

    const visible = await getVisiblePillar(id, { locals, request }, "delete")
    if (visible instanceof Response) return visible
    if (!visible) return apiError("Pillar not found", 404)
    const { pillar, ownerScope } = visible

    const hard = url.searchParams.get("hard") === "true"
    const deleted = await deletePillar(ownerScope, id, hard)

    if (!deleted) return apiError("Pillar not found", 404)
    return apiJson({ ok: true })
  } catch (error) {
    logApiError("pillars", "DELETE [id] error", error)
    return apiError("Failed to delete pillar")
  }
}
