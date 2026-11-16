/**
 * resolveCalendarEntities — Shared helper for resolving configured calendar entities.
 *
 * Used by ha/calendars.ts and integrations/calendar/sync.ts to avoid duplicating
 * the multi-entity → legacy fallback resolution logic.
 *
 * @domain calendar
 * @bounded-context integration
 */
import { ensureSchema, getPersistenceClient } from "@domains/tasks/persistence/store"
import { SettingsRepository } from "@domains/tasks/persistence/settings-repository"

/** Resolve calendar IDs from the current setting and supported legacy forms. */
export async function resolveCalendarEntities(requireAvailable = false): Promise<string[]> {
  try {
    await ensureSchema()
    const repo = new SettingsRepository(getPersistenceClient())
    await repo.ensureSettingsTable()
    const keys = ["calendar_entities", "calendar_entity", "cal_entity", "calendar-entity", "calendar-entities"]
    const settings = await repo.getByKeys(keys)
    for (const key of keys) {
      let value = settings[key]
      if (typeof value === "string" && value.trimStart().startsWith("[")) {
        try {
          value = JSON.parse(value)
        } catch {
          continue
        }
      }
      const entries = Array.isArray(value) ? value : [value]
      const ids = [...new Set(entries.filter((id): id is string =>
        typeof id === "string" && /^calendar\.[a-z0-9_]+$/.test(id)))]
      if (key === "calendar_entities" && Array.isArray(value)) return ids
      if (key === "calendar_entity" && value === "") return []
      if (ids.length) return ids
    }
  } catch (error) {
    if (requireAvailable) throw error
  }
  return []
}
