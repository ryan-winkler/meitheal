import type { APIRoute } from "astro"
import { apiJson, apiError } from "../../../../lib/api-response"
import { logApiError } from "../../../../lib/api-logger"
import { getPillarById } from "@domains/pillars/pillar-service"
import {
  createPrinciple,
  getPrinciplesForPillar,
  updatePrinciple,
  deletePrinciple,
} from "@domains/pillars/principle-service"

/**
 * Principles API — CRUD for Principles under a Pillar
 *
 * GET  /api/pillars/:id/principles — List Principles for a Pillar
 * POST /api/pillars/:id/principles — Create, update, or delete a Principle
 *
 * @domain pillars
 * @kcs Principles are the behavioral boundaries within a Pillar.
 * @kcs Non-Negotiable Principles are injected into AI system prompts.
 */

export const GET: APIRoute = async ({ params }) => {
  try {
    const pillarId = params.id
    if (!pillarId) return apiError("Pillar ID is required", 400)

    const pillar = await getPillarById(pillarId)
    if (!pillar) return apiError("Pillar not found", 404)

    const principles = await getPrinciplesForPillar(pillarId)
    return apiJson({ principles })
  } catch (error) {
    logApiError("pillars", "GET principles error", error)
    return apiError("Failed to get principles")
  }
}

export const POST: APIRoute = async ({ params, request }) => {
  try {
    const pillarId = params.id
    if (!pillarId) return apiError("Pillar ID is required", 400)

    const pillar = await getPillarById(pillarId)
    if (!pillar) return apiError("Pillar not found", 404)

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
    const action = String(body.action || "create")

    switch (action) {
      case "create": {
        const statement = String(body.statement || "").trim()
        if (!statement) return apiError("statement is required", 400)
        if (statement.length > 500) return apiError("statement must be 500 characters or fewer", 400)

        const principle = await createPrinciple({
          pillarId,
          statement,
          isNonNegotiable: body.isNonNegotiable === true,
        })

        return apiJson({ principle }, 201)
      }

      case "update": {
        const principleId = String(body.principleId || "")
        if (!principleId) return apiError("principleId is required", 400)

        if (body.statement !== undefined) {
          const s = String(body.statement).trim()
          if (!s) return apiError("statement cannot be empty", 400)
          if (s.length > 500) return apiError("statement must be 500 characters or fewer", 400)
        }

        const updates: Parameters<typeof updatePrinciple>[1] = {}
        if (typeof body.statement === "string") updates.statement = body.statement.trim()
        if (typeof body.isNonNegotiable === "boolean") updates.isNonNegotiable = body.isNonNegotiable
        if (typeof body.position === "number") updates.position = body.position

        const updated = await updatePrinciple(principleId, updates, pillarId)

        if (!updated) return apiError("Principle not found or no changes", 404)
        return apiJson({ ok: true })
      }

      case "delete": {
        const principleId = String(body.principleId || "")
        if (!principleId) return apiError("principleId is required", 400)

        const deleted = await deletePrinciple(principleId, pillarId)
        if (!deleted) return apiError("Principle not found", 404)
        return apiJson({ ok: true })
      }

      default:
        return apiError("Invalid action. Use: create, update, delete", 400)
    }
  } catch (error) {
    logApiError("pillars", "POST principles error", error)
    return apiError("Failed to manage principle")
  }
}
