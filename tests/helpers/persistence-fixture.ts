import { fileURLToPath } from "node:url"
import { resolve } from "node:path"
import { ensureSchema as ensureProductionSchema, getPersistenceClient as getGovernedPersistenceClient } from "../../apps/web/src/domains/tasks/persistence/store"
import { unwrapRegisteredContinuityClient } from "../../apps/web/src/domains/tasks/persistence/continuity-client"

export * from "../../apps/web/src/domains/tasks/persistence/store"

/** Synthetic setup and independent post-denial inspection deliberately bypass governance.
 * Runtime behavior is exercised through production repositories/services or the production accessor. */
export function getPersistenceClient() {
  return unwrapRegisteredContinuityClient(getGovernedPersistenceClient())
}

/** Explicit isolated marker custody for synthetic test databases. Never selects /data. */
export async function ensureSchema(options: Parameters<typeof ensureProductionSchema>[0] = {}) {
  const url = process.env.MEITHEAL_DB_URL
  if (!url?.startsWith("file:") || url.includes(":memory:")) {
    if (!options.markerPath) throw new Error("A persistence fixture requires an explicit local database and marker context")
    return ensureProductionSchema(options)
  }
  const databasePath = url.startsWith("file://") ? fileURLToPath(url) : resolve(url.slice(5))
  return ensureProductionSchema({ markerPath: databasePath + ".board-grants.json", ...options })
}
