import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import { startHAWebSocketFixture } from "../scripts/ha-websocket-fixture"

for (const heldInitial of [false, true]) {
  test(`HA credential ${heldInitial ? "rotation during authentication" : "removal and invalid replacement"} retires old snapshots`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "meitheal-ha-generation-"))
    const previous = Object.fromEntries(["MEITHEAL_DB_URL", "SUPERVISOR_TOKEN", "HA_BASE_URL", "HA_TOKEN"].map(key => [key, process.env[key]]))
    const local = await startHAWebSocketFixture({
      holdTokens: heldInitial ? ["fixture-first"] : [],
      entities: {
        "fixture-first": { "calendar.first": { s: "on", a: {}, lc: 1, c: "fixture" } },
        "fixture-second": { "calendar.second": { s: "on", a: {}, lc: 1, c: "fixture" } },
      },
    })
    const store = await import("../../apps/web/src/domains/tasks/persistence/store")
    const ha = await import("../../apps/web/src/domains/ha/ha-connection")
    const entities = await import("../../apps/web/src/domains/ha/ha-entities")
    try {
      delete process.env.SUPERVISOR_TOKEN
      delete process.env.HA_BASE_URL
      delete process.env.HA_TOKEN
      process.env.MEITHEAL_DB_URL = `file:${join(directory, "test.db")}`
      store.resetPersistenceForTests()
      await store.ensureSchema()
      const { SettingsRepository } = await import("../../apps/web/src/domains/tasks/persistence/settings-repository")
      const settings = new SettingsRepository(store.getPersistenceClient())
      await settings.ensureSettingsTable()
      const save = async (url: string, token: string) => {
        await settings.upsert("ha_url", JSON.stringify(url))
        await settings.upsert("ha_token", JSON.stringify(token))
      }
      const delivered: string[] = []
      entities.onEntityChange("calendar.second", entity => delivered.push(entity.entity_id))
      await save(local.url, "fixture-first")
      if (heldInitial) {
        const first = ha.getHAConnection()
        await expect.poll(() => local.tokens).toContain("fixture-first")
        await save(local.url, "fixture-second")
        const second = await ha.getHAConnection()
        expect(second).not.toBeNull()
        local.release("fixture-first")
        expect(await first).toBeNull()
        expect(await ha.getHAConnection()).toBe(second)
      } else {
        expect(await ha.getHAConnection()).not.toBeNull()
        await expect.poll(() => Object.keys(entities.getAllEntities())).toEqual(["calendar.first"])
        await save("", "")
        expect(await ha.getHAConnection()).toBeNull()
        expect(entities.getAllEntities()).toEqual({})
        await save(local.url, "fixture-first")
        expect(await ha.getHAConnection()).not.toBeNull()
        await expect.poll(() => Object.keys(entities.getAllEntities())).toEqual(["calendar.first"])
        await save("file:///invalid", "fixture-first")
        expect(await ha.getHAConnection()).toBeNull()
        expect(entities.getAllEntities()).toEqual({})
        await save(local.url, "invalid-fixture")
        expect(await ha.getHAConnection()).toBeNull()
        expect(entities.getAllEntities()).toEqual({})
        await save(local.url, "fixture-second")
        expect(await ha.getHAConnection()).not.toBeNull()
      }
      await expect.poll(() => Object.keys(entities.getAllEntities())).toEqual(["calendar.second"])
      await expect.poll(() => delivered).toEqual(["calendar.second"])
      expect(JSON.stringify(ha.getHAConnectionStatus())).not.toContain("fixture-")
    } finally {
      entities.stopEntitySubscription()
      ha.closeHAConnection()
      await local.close()
      store.resetPersistenceForTests()
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      await rm(directory, { recursive: true, force: true })
    }
  })
}
