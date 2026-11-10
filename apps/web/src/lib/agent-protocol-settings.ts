import { SettingsRepository } from "@domains/tasks/persistence/settings-repository"
import { ensureSchema, getPersistenceClient } from "@domains/tasks/persistence/store"
import { agentProtocolEnabled, agentProtocolSettingKey, type AgentProtocol } from "./agent-protocol-options"

export async function isAgentProtocolEnabled(protocol: AgentProtocol): Promise<boolean> {
  await ensureSchema()
  const repository = new SettingsRepository(getPersistenceClient())
  await repository.ensureSettingsTable()
  const key = agentProtocolSettingKey(protocol)
  const settings = await repository.getByKeys([key])
  return agentProtocolEnabled(protocol, settings[key])
}
