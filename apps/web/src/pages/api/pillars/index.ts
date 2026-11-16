import type { APIRoute } from "astro"
import { matchesPersonalPillarForm, readPillarBody, resolvePersonalPillarOwner } from "@lib/personal-pillar-access"
import { apiJson, apiError } from "../../../lib/api-response"
import { logApiError } from "../../../lib/api-logger"
import {
  createPillar,
  getPillars,
  countActivePillars,
  MAX_RECOMMENDED_PILLARS,
  HOUSEHOLD_PILLAR_OWNER,
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

export const GET: APIRoute = async ({ url, locals, request }) => {
  try {
    const includeInactive = url.searchParams.get("include_inactive") === "true"
    const withPersonal = url.searchParams.get("include_personal") === "true"
    const personalOwner = withPersonal ? await resolvePersonalPillarOwner(locals, request.signal) : undefined
    if (withPersonal && !personalOwner) return apiError("Personal Pillars require an active Home Assistant user.", 403)
    const pillars = await getPillars({ includeInactive, personalOwner })
    return apiJson({ pillars })
  } catch (error) {
    logApiError("pillars", "GET error", error)
    return apiError("Failed to get pillars")
  }
}

export const HEAD: APIRoute = async ({ request, locals }) => {
  const proof = request.headers.get("x-meitheal-pillar-session")
  if (!proof) return new Response(null, { status: 200 })
  const owner = await resolvePersonalPillarOwner(locals, request.signal)
  const valid = owner && matchesPersonalPillarForm(proof, owner)
  return new Response(null, { status: valid ? 204 : 403 })
}

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const body = await readPillarBody(request)
    if (body instanceof Response) return body
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

    const audience = body.audience ?? "household"
    if (audience !== "household" && audience !== "personal") {
      return apiError("Choose Household or Personal as the audience.", 400)
    }
    const owner = audience === "personal"
      ? await resolvePersonalPillarOwner(locals, request.signal) : HOUSEHOLD_PILLAR_OWNER
    if (!owner) return apiError("Personal Pillars require an active Home Assistant user.", 403)

    if (audience === "personal" && !matchesPersonalPillarForm(body.audienceProof, owner)) {
      return apiError("Refresh Progress to confirm the current account before creating a Personal Pillar.", 409)
    }

    // Cognitive load warning (soft limit, never block)
    const count = await countActivePillars(owner)
    const warning = count >= MAX_RECOMMENDED_PILLARS - 1
      ? `You have ${count} active Pillars. Research suggests 3-5 is optimal for focus.`
      : undefined

    const opts: Parameters<typeof createPillar>[0] = { name }
    if (typeof body.manifesto === "string") opts.manifesto = body.manifesto
    else opts.manifesto = null
    if (typeof body.icon === "string") opts.icon = body.icon
    if (typeof body.colorHex === "string") opts.colorHex = body.colorHex
    if (typeof body.weight === "number") opts.weight = body.weight

    const pillar = await createPillar(opts, owner)

    return apiJson({ pillar, warning }, 201)
  } catch (error) {
    logApiError("pillars", "POST error", error)
    return apiError("Failed to create pillar")
  }
}
