import { SettingsRepository } from "@domains/tasks/persistence/settings-repository"
import { ensureSchema, getPersistenceClient } from "@domains/tasks/persistence/store"
import { apiProblem } from "./api-response"

const SETTING = "agent-protocols-a2a-enabled"
export const A2A_RESPONSE_HEADERS = { "Cache-Control": "private, no-store" }

export async function checkA2aAvailability(): Promise<Response | null> {
  try {
    await ensureSchema()
    const repository = new SettingsRepository(getPersistenceClient())
    await repository.ensureSettingsTable()
    const { [SETTING]: enabled } = await repository.getByKeys([SETTING])
    if (enabled === undefined || enabled === true || enabled === "true") return null
    return apiProblem({ status: 404, detail: "A2A is disabled.", extraHeaders: A2A_RESPONSE_HEADERS })
  } catch {
    return apiProblem({ status: 503, detail: "A2A availability could not be checked.", extraHeaders: A2A_RESPONSE_HEADERS })
  }
}
