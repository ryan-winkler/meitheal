import type { APIRoute } from "astro"
import { apiProblem } from "@lib/api-response"

// A2A search returns direct messages. No asynchronous tasks exist at legacy URLs.
export const GET: APIRoute = () => apiProblem({
  status: 404,
  detail: "A2A task not found.",
  extraHeaders: { "Cache-Control": "no-store" },
})

export const POST = GET
