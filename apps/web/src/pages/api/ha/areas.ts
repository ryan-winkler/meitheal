import type { APIRoute } from "astro"
import { getPersistenceClient } from "@domains/tasks"
import { readHomeAssistantAreaPolicyRevision } from "@domains/tasks/persistence/home-assistant-task-area"
import { listHomeAssistantAreas } from "@domains/ha/ha-area-registry"
import { apiJson, apiProblem } from "@lib/api-response"
import { homeAssistantAreaAccess, homeAssistantAreaProof } from "@lib/home-assistant-area-access"

const noStore = { "cache-control": "private, no-store" }

export const HEAD: APIRoute = async context => {
  const revision = await homeAssistantAreaAccess(context)
  const proof = revision && homeAssistantAreaProof(context, revision)
  return new Response(null, {
    status: proof ? 204 : 404,
    headers: proof ? { ...noStore, "x-meitheal-area-context": proof } : noStore,
  })
}

export const GET: APIRoute = async context => {
  const revision = await homeAssistantAreaAccess(context)
  const proof = revision && homeAssistantAreaProof(context, revision)
  if (!proof) {
    return apiProblem({ status: 404, detail: "Home Assistant Area is unavailable.", extraHeaders: noStore })
  }
  const areas = await listHomeAssistantAreas(context.request.signal)
  if (!areas) {
    return apiProblem({ status: 503, detail: "Could not read Home Assistant Areas. Try again when Home Assistant is available.", extraHeaders: noStore })
  }
  if (!(await getPersistenceClient().execute(readHomeAssistantAreaPolicyRevision(revision))).rows.length) {
    return apiProblem({ status: 404, detail: "Home Assistant Area is unavailable.", extraHeaders: noStore })
  }
  const response = apiJson({ areas })
  response.headers.set("cache-control", noStore["cache-control"])
  response.headers.set("x-meitheal-area-context", proof)
  return response
}
