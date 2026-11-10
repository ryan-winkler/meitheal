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

/**
 * Resolve calendar entity IDs from settings.
 * Priority: calendar_entities (array) → calendar_entity / cal_entity (legacy single).
 * Returns empty array if nothing is configured.
 */
export async function resolveCalendarEntities(): Promise<string[]> {
  try {
    await ensureSchema()
    const repo = new SettingsRepository(getPersistenceClient())
    await repo.ensureSettingsTable()

    // Try multi-entity first
    const multiSetting = await repo.getByKey("calendar_entities")
    if (multiSetting?.value) {
      const parsed = multiSetting.value
      if (Array.isArray(parsed)) {
        const entities = parsed.filter((e: unknown) => typeof e === "string" && e.length > 0)
        if (entities.length > 0) return entities
      }
    }

    // Legacy fallback — try single entity keys
    for (const legacyKey of ["calendar_entity", "cal_entity"]) {
      const setting = await repo.getByKey(legacyKey)
      if (setting?.value) {
        const entityId = typeof setting.value === "string" ? setting.value : String(setting.value)
        if (entityId.length > 0) return [entityId]
      }
    }
  } catch { /* DB not available — return empty */ }

  return []
}
