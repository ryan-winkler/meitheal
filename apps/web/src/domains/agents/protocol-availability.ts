import { ensureSchema, getPersistenceClient, SettingsRepository } from "@domains/tasks"
import { apiProblem } from "@lib/api-response"

/** Check current Settings on every request so an administrator can disable protocols immediately. */
export async function checkProtocolAvailability(
  settingKey: string,
  protocolLabel: string,
  extraHeaders: Record<string, string>,
): Promise<Response | null> {
  try {
    await ensureSchema()
    const repository = new SettingsRepository(getPersistenceClient())
    await repository.ensureSettingsTable()
    const { [settingKey]: enabled } = await repository.getByKeys([settingKey])
    if (enabled == null || enabled === true || enabled === "true") return null
    return apiProblem({ status: 404, detail: `${protocolLabel} is disabled.`, extraHeaders })
  } catch {
    return apiProblem({
      status: 503,
      detail: `${protocolLabel} availability could not be checked.`,
      extraHeaders,
    })
  }
}
