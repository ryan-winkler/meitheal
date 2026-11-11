import type { APIRoute } from "astro"
import { buildAgentCard } from "@meitheal/integration-core"
import { A2A_RESPONSE_HEADERS, checkA2aAvailability } from "@lib/a2a-availability"

/**
 * Discovery for Meitheal's experimental A2A endpoints. The well-known
 * aliases share this handler so Home Assistant ingress keeps its scope.
 */
export const GET: APIRoute = async ({ locals }) => {
  const unavailable = await checkA2aAvailability()
  if (unavailable) return unavailable

  return Response.json(buildAgentCard({ basePath: locals.ingressPath ?? "" }), { headers: A2A_RESPONSE_HEADERS })
}
