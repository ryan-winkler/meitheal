import type { APIRoute } from "astro"
import { A2A_RESPONSE_HEADERS, checkA2aAvailability } from "@lib/a2a-availability"
import { apiProblem } from "@lib/api-response"

export const GET: APIRoute = async () =>
  await checkA2aAvailability() ?? apiProblem({
    status: 404,
    detail: "A2A task not found.",
    extraHeaders: A2A_RESPONSE_HEADERS,
  })

export const POST = GET
