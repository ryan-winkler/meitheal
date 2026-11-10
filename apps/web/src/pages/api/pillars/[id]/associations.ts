import type { APIRoute } from "astro"
import { apiJson, apiError } from "../../../../lib/api-response"
import { logApiError } from "../../../../lib/api-logger"
import { getPillarById } from "@domains/pillars/pillar-service"
import {
  linkEntity,
  unlinkEntity,
  getAssociationsForPillar,
  VALID_PILLAR_ENTITY_TYPES,
  type PillarEntityType,
} from "@domains/pillars/pillar-association-service"

/**
 * Pillar Associations API — Link/Unlink entities
 *
 * GET  /api/pillars/:id/associations — List entities linked to a Pillar
 * POST /api/pillars/:id/associations — Link or unlink an entity
 *
 * @domain pillars
 * @kcs M2M associations for cross-cutting Pillar relationships.
 * @kcs Direct FK on entities is the primary mechanism; M2M is secondary.
 */

export const GET: APIRoute = async ({ params }) => {
  try {
    const pillarId = params.id
    if (!pillarId) return apiError("Pillar ID is required", 400)

    const pillar = await getPillarById(pillarId)
    if (!pillar) return apiError("Pillar not found", 404)

    const associations = await getAssociationsForPillar(pillarId)
    return apiJson({ associations })
  } catch (error) {
    logApiError("pillars", "GET associations error", error)
    return apiError("Failed to get associations")
  }
}

export const POST: APIRoute = async ({ params, request }) => {
  try {
    const pillarId = params.id
    if (!pillarId) return apiError("Pillar ID is required", 400)

    const pillar = await getPillarById(pillarId)
    if (!pillar) return apiError("Pillar not found", 404)

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
    const action = String(body.action || "link")

    const entityType = String(body.entityType || "") as PillarEntityType
    if (!VALID_PILLAR_ENTITY_TYPES.includes(entityType)) {
      return apiError(`entityType must be one of: ${VALID_PILLAR_ENTITY_TYPES.join(", ")}`, 400)
    }

    const entityId = String(body.entityId || "")
    if (!entityId) return apiError("entityId is required", 400)

    switch (action) {
      case "link": {
        const association = await linkEntity(pillarId, entityType, entityId)
        return apiJson({ association }, 201)
      }

      case "unlink": {
        const removed = await unlinkEntity(pillarId, entityType, entityId)
        if (!removed) return apiError("Association not found", 404)
        return apiJson({ ok: true })
      }

      default:
        return apiError("Invalid action. Use: link, unlink", 400)
    }
  } catch (error) {
    logApiError("pillars", "POST associations error", error)
    return apiError("Failed to manage association")
  }
}
