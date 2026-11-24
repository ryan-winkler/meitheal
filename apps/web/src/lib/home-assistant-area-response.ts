import { apiJson, apiProblem } from "./api-response"

const headers = { "cache-control": "private, no-store" }

export function homeAssistantAreaProblem(status: number, detail: string) {
  return apiProblem({ status, detail, extraHeaders: headers })
}

export function homeAssistantAreaResponse(value: { id?: string | null; version: number; locationRevision: number }) {
  const response = apiJson(value)
  response.headers.set("cache-control", headers["cache-control"])
  return response
}

export function homeAssistantAreaMutationResponse(outcome: {
  ok: true
  value: { version: number; locationRevision: number }
} | {
  ok: false
  errorCode: "unavailable" | "denied" | "stale"
}) {
  if (outcome.ok) return homeAssistantAreaResponse(outcome.value)
  if (outcome.errorCode === "stale") return homeAssistantAreaProblem(409, "Refresh the task before changing its location.")
  if (outcome.errorCode === "denied") return homeAssistantAreaProblem(403, "Home Assistant Area access changed. Refresh the task.")
  return homeAssistantAreaProblem(404, "Task or Home Assistant Area unavailable.")
}
