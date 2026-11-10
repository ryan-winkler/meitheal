import type { APIRoute } from "astro"
import { apiJson, apiError } from "../../../lib/api-response"
import { logApiError } from "../../../lib/api-logger"
import {
  createPillar,
  getPillars,
  countActivePillars,
  MAX_RECOMMENDED_PILLARS,
} from "@domains/pillars/pillar-service"

/**
 * Pillars API — List + Create
 *
 * GET  /api/pillars — List all active Pillars
 * POST /api/pillars — Create a new Pillar
 *
 * @domain pillars
 * @kcs Soft limit of 7 active Pillars — warning returned, never blocked.
 */

export const GET: APIRoute = async ({ url }) => {
  try {
    const includeInactive = url.searchParams.get("include_inactive") === "true"
    const pillars = await getPillars({ includeInactive })
    return apiJson({ pillars })
  } catch (error) {
    logApiError("pillars", "GET error", error)
    return apiError("Failed to get pillars")
  }
}

export const POST: APIRoute = async ({ request }) => {
  try {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
    const name = String(body.name || "").trim()

    if (!name) return apiError("name is required", 400)
    if (name.length > 100) return apiError("name must be 100 characters or fewer", 400)

    // Validate weight if provided
    if (body.weight !== undefined) {
      const weight = Number(body.weight)
      if (isNaN(weight) || weight < 1 || weight > 10) {
        return apiError("weight must be between 1 and 10", 400)
      }
    }

    // Cognitive load warning (soft limit, never block)
    const count = await countActivePillars()
    const warning = count >= MAX_RECOMMENDED_PILLARS - 1
      ? `You have ${count} active Pillars. Research suggests 3-5 is optimal for focus.`
      : undefined

    const opts: Parameters<typeof createPillar>[0] = { name }
    if (typeof body.manifesto === "string") opts.manifesto = body.manifesto
    else opts.manifesto = null
    if (typeof body.icon === "string") opts.icon = body.icon
    if (typeof body.colorHex === "string") opts.colorHex = body.colorHex
    if (typeof body.weight === "number") opts.weight = body.weight

    const pillar = await createPillar(opts)

    return apiJson({ pillar, warning }, 201)
  } catch (error) {
    logApiError("pillars", "POST error", error)
    return apiError("Failed to create pillar")
  }
}
