import { readBoundedCoreCommand } from "./core-bounded-command"
import { fingerprintHAConfiguration } from "./ha-configuration"
import { getHAConfiguration } from "./ha-connection"

export interface HomeAssistantArea {
  id: string
  name: string
}

export function parseHomeAssistantAreas(value: unknown): HomeAssistantArea[] | null {
  if (!Array.isArray(value) || value.length > 1_000) return null
  const byId = new Map<string, HomeAssistantArea>()
  for (const item of value) {
    if (typeof item !== "object" || !item || Array.isArray(item)) return null
    const { area_id: id, name } = item
    if (typeof id !== "string" || !id || id.length > 150 || typeof name !== "string" ||
      !name.trim() || name.length > 300 || byId.has(id)) return null
    byId.set(id, { id, name })
  }
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
}

export async function listHomeAssistantAreas(signal: AbortSignal): Promise<HomeAssistantArea[] | null> {
  try {
    const config = await getHAConfiguration({ requireComplete: true })
    if (!config || signal.aborted) return null
    const raw = await readBoundedCoreCommand("config/area_registry/list", config.token, signal, config.baseUrl)
    const current = await getHAConfiguration({ requireComplete: true })
    if (!current || signal.aborted || fingerprintHAConfiguration(config) !== fingerprintHAConfiguration(current)) return null
    return parseHomeAssistantAreas(raw)
  } catch {
    return null
  }
}
