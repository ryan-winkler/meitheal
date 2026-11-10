import type { APIRoute } from "astro"
import { buildAgentCard } from "@meitheal/integration-core"
import { getA2ALinkOrigin } from "@lib/a2a-urls"
import { isAgentProtocolEnabled } from "@lib/agent-protocol-settings"
import { apiProblem } from "@lib/api-response"

/** The well-known aliases share this handler so discovery follows the A2A switch. */
export const GET: APIRoute = async ({ locals, request, url }) => {
  try {
    if (!await isAgentProtocolEnabled("a2a")) {
      return apiProblem({
        status: 404,
        detail: "A2A is disabled.",
        extraHeaders: { "Cache-Control": "no-store" },
      })
    }

    return Response.json(buildAgentCard({
      origin: getA2ALinkOrigin(request, url),
      basePath: locals.ingressPath ?? "",
      version: process.env.MEITHEAL_VERSION ?? "unknown",
    }), { headers: { "Cache-Control": "no-store" } })
  } catch {
    return apiProblem({ status: 503, detail: "A2A discovery is unavailable." })
  }
}
