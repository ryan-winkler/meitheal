import type { APIRoute } from "astro"
import { listHomeAssistantAreas } from "@domains/ha/ha-area-registry"
import { apiJson, apiProblem } from "@lib/api-response"
import { homeAssistantAreaAccess } from "@lib/home-assistant-area-access"

const noStore = { "cache-control": "private, no-store" }

export const GET: APIRoute = async context => {
  if (!await homeAssistantAreaAccess(context)) {
    return apiProblem({ status: 404, detail: "Home Assistant Area is unavailable.", extraHeaders: noStore })
  }
  const areas = await listHomeAssistantAreas(context.request.signal)
  if (!areas) {
    return apiProblem({ status: 503, detail: "Could not read Home Assistant Areas. Try again when Home Assistant is available.", extraHeaders: noStore })
  }
  const response = apiJson({ areas })
  response.headers.set("cache-control", noStore["cache-control"])
  return response
}
