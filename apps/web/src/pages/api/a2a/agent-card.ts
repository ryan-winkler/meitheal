import type { APIRoute } from "astro"
import { buildAgentCard } from "@meitheal/integration-core"
import { A2A_RESPONSE_HEADERS, checkA2aAvailability } from "@lib/a2a-availability"
import { getA2ALinkOrigin } from "@lib/a2a-urls"

/**
 * Discovery for Meitheal's read-only A2A task search. The well-known
 * aliases share this handler so Home Assistant ingress keeps its scope.
 */
export const GET: APIRoute = async ({ locals, request, url }) => {
  const unavailable = await checkA2aAvailability()
  if (unavailable) return unavailable

  return Response.json(buildAgentCard({
    origin: getA2ALinkOrigin(request, url),
    basePath: locals.ingressPath ?? "",
    version: process.env.MEITHEAL_VERSION ?? "0.0.1",
  }), { headers: A2A_RESPONSE_HEADERS })
}
