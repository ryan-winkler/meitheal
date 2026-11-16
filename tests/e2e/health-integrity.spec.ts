import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { expect, test } from "@playwright/test"

test("health readiness is degraded when a reachable database fails integrity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "meitheal-health-"))
  const originalDb = process.env.MEITHEAL_DB_URL
  const originalSupervisor = process.env.SUPERVISOR_TOKEN
  const store = await import("../../apps/web/src/domains/tasks/persistence/store")
  try {
    delete process.env.SUPERVISOR_TOKEN
    const path = join(directory, "test.db")
    process.env.MEITHEAL_DB_URL = `file:${path}`
    store.resetPersistenceForTests()
    const seed = new DatabaseSync(path)
    try {
      seed.exec(`
        CREATE TABLE integrity_fixture (positive INTEGER CHECK (positive > 0));
        PRAGMA ignore_check_constraints = ON;
        INSERT INTO integrity_fixture VALUES (-1);
      `)
    } finally {
      seed.close()
    }

    await store.ensureSchema()
    expect(store.getDbIntegrityStatus()).toBe(false)
    const { GET, HEAD } = await import("../../apps/web/src/pages/api/health")
    const response = await GET({} as never)
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ status: "degraded", db_status: "connected", db_integrity: "failed" })
    expect((await HEAD({} as never)).status).toBe(200)
  } finally {
    store.resetPersistenceForTests()
    if (originalDb === undefined) delete process.env.MEITHEAL_DB_URL
    else process.env.MEITHEAL_DB_URL = originalDb
    if (originalSupervisor === undefined) delete process.env.SUPERVISOR_TOKEN
    else process.env.SUPERVISOR_TOKEN = originalSupervisor
    await rm(directory, { recursive: true, force: true })
  }
})
