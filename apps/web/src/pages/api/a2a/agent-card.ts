import type { APIRoute } from "astro"
import { buildAgentCard } from "@meitheal/integration-core"
import { A2A_RESPONSE_HEADERS, checkA2aAvailability, getA2ALinkOrigin } from "@domains/agents"

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
    version: process.env.MEITHEAL_VERSION || "0.0.1",
  }), { headers: A2A_RESPONSE_HEADERS })
}
