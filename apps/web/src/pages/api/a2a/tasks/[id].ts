import type { APIRoute } from "astro"
import { hasScope } from "@meitheal/domain-auth"
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
  const token = locals.agentToken
  if (!token) {
    return apiProblem({
      status: 401,
      detail: "Use a valid, active Meitheal agent token.",
      extraHeaders: { ...A2A_RESPONSE_HEADERS, "WWW-Authenticate": "Bearer" },
    })
  }
  if (
    !hasScope(token.scopes, "a2a:execute") ||
    !hasScope(token.scopes, "search:read") ||
    !hasScope(token.scopes, "tasks:read")
  ) {
    return apiProblem({
      status: 403,
      detail: "Reading A2A tasks requires a2a:execute, search:read, and tasks:read.",
      extraHeaders: A2A_RESPONSE_HEADERS,
    })
  }
  const unavailable = await checkA2aAvailability()
  if (unavailable) return unavailable
  if (request.headers.get("a2a-version") !== "1.0") {
    return apiProblem({
      status: 400,
      detail: "Use A2A-Version: 1.0.",
      extraHeaders: A2A_RESPONSE_HEADERS,
    })
  }
  const task = await getA2aTask(token, params.id ?? "", getA2ALinkOrigin(request, url) + (locals.ingressPath ?? ""))
  return task ? Response.json(task, { headers: A2A_RESPONSE_HEADERS }) : notFound()
}

/** No write operation exists on an A2A task; `:cancel` and other verbs find nothing. */
export const POST: APIRoute = async () => await checkA2aAvailability() ?? notFound()
