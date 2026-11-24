import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test, expect } from "@playwright/test"
import { ensureSchema, resetPersistenceForTests, getSchemaVersion, getPersistenceClient } from "../../apps/web/src/domains/tasks/persistence/store"
import { registerVerifiedPrincipal } from "../../apps/web/src/domains/tasks/board-scope"
import { NamedBoardRepository } from "../../apps/web/src/domains/tasks/persistence/named-board-repository"
import { DATABASE_SCHEMA_VERSION } from "../../apps/web/scripts/database-client.mjs"

test("real runtime preparation reopens admitted schema26 without repairing or rejecting its known triggers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ordinary-runtime-restart-"))
  const previous = process.env.MEITHEAL_DB_URL
  process.env.MEITHEAL_DB_URL = `file:${join(directory, "tasks.db")}`
  const markerPath = join(directory, "grants.json")
  try {
    await ensureSchema({ markerPath })
    const db = getPersistenceClient()
    const actor = registerVerifiedPrincipal({ kind: "ha_user", id: "parent" }, { administrator: true, expiresAt: Date.now() + 60_000 })
    const created = await new NamedBoardRepository(db).create(actor, "Church")
    expect(created.status).toBe("committed")
    const triggers = (await db.execute("SELECT name,sql FROM sqlite_schema WHERE type='trigger' ORDER BY name")).rows
    const boards = (await db.execute("SELECT id,name,revision FROM task_boards ORDER BY id")).rows
    resetPersistenceForTests()
    // Production ensureSchema supplies initializeRuntimeTables to the admitted
    // startup writer, unlike read-only schema checks or migration-only fixtures.
    await ensureSchema({ markerPath })
    expect(getSchemaVersion()).toBe(DATABASE_SCHEMA_VERSION)
    expect((await getPersistenceClient().execute("SELECT name,sql FROM sqlite_schema WHERE type='trigger' ORDER BY name")).rows).toEqual(triggers)
    expect((await getPersistenceClient().execute("SELECT id,name,revision FROM task_boards ORDER BY id")).rows).toEqual(boards)
  } finally {
    resetPersistenceForTests()
    if (previous === undefined) delete process.env.MEITHEAL_DB_URL; else process.env.MEITHEAL_DB_URL = previous
    await rm(directory, { recursive: true, force: true })
  }
})
