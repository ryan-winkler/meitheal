import type { APIRoute } from "astro"
import { A2A_RESPONSE_HEADERS, checkA2aAvailability, getA2ALinkOrigin } from "@domains/agents"
import { getA2aTask } from "@lib/a2a-tasks"
import { apiProblem } from "@lib/api-response"

const notFound = () => apiProblem({
  status: 404,
  detail: "A2A task not found.",
  extraHeaders: A2A_RESPONSE_HEADERS,
})

/** HTTP+JSON reading of one task. The JSON-RPC endpoint is the advertised interface. */
export const GET: APIRoute = async ({ locals, params, request, url }) => {
  const unavailable = await checkA2aAvailability()
  if (unavailable) return unavailable
  const token = locals.agentToken
  const task = token && await getA2aTask(token, params.id ?? "", getA2ALinkOrigin(request, url) + (locals.ingressPath ?? ""))
  return task ? Response.json(task, { headers: A2A_RESPONSE_HEADERS }) : notFound()
}

/** No write operation exists on an A2A task; `:cancel` and other verbs find nothing. */
export const POST: APIRoute = async () => await checkA2aAvailability() ?? notFound()
