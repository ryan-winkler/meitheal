import type { APIRoute } from "astro"
import { A2A_RESPONSE_HEADERS, checkA2aAvailability } from "@lib/a2a-availability"
import { apiProblem } from "@lib/api-response"

export const POST: APIRoute = async () =>
  await checkA2aAvailability() ?? apiProblem({
    status: 501,
    title: "A2A execution unavailable",
    detail: "A2A message execution is unavailable. This installation offers experimental discovery.",
    extraHeaders: A2A_RESPONSE_HEADERS,
  })
