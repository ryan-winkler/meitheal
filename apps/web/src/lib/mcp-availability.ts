import { SettingsRepository } from "@domains/tasks/persistence/settings-repository"
import { ensureSchema, getPersistenceClient } from "@domains/tasks/persistence/store"
import { apiProblem } from "./api-response"

const SETTING = "agent-protocols-mcp-enabled"

/** Read current Settings for every request so an admin can disable existing clients immediately. */
export async function checkMcpAvailability(): Promise<Response | null> {
  const headers = { "Cache-Control": "no-store" }
  try {
    await ensureSchema()
    const repository = new SettingsRepository(getPersistenceClient())
    await repository.ensureSettingsTable()
    const { [SETTING]: enabled } = await repository.getByKeys([SETTING])
    if (enabled == null || enabled === true || enabled === "true") return null
    return apiProblem({ status: 404, detail: "MCP is disabled.", extraHeaders: headers })
  } catch {
    return apiProblem({
      status: 503, detail: "MCP availability could not be checked.", extraHeaders: headers,
    })
  }
}
