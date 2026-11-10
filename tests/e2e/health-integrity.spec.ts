import { expect, test } from "@playwright/test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Exercise the actual health route with an injected SQLite integrity response.
test("health readiness is degraded when a reachable database fails integrity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "meitheal-health-"))
  const originalDb = process.env.MEITHEAL_DB_URL
  const originalSupervisor = process.env.SUPERVISOR_TOKEN
  const store = await import("../../apps/web/src/domains/tasks/persistence/store")
  try {
    delete process.env.SUPERVISOR_TOKEN
    process.env.MEITHEAL_DB_URL = `file:${join(directory, "test.db")}`
    store.resetPersistenceForTests()
    const client = store.getPersistenceClient()
    const execute = client.execute.bind(client)
    client.execute = ((sql: Parameters<typeof client.execute>[0]) => {
      if (sql === "PRAGMA integrity_check(1)") return Promise.resolve({ rows: [{ integrity_check: "fixture failure" }] })
      return execute(sql)
    }) as typeof client.execute
    await store.ensureSchema()
    client.execute = execute
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
