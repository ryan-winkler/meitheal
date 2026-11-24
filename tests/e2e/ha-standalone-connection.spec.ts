import { expect, test } from "@playwright/test"
import { createRequire } from "node:module"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout } from "node:timers/promises"
import { startHAWebSocketFixture } from "../scripts/ha-websocket-fixture"

const appRequire = createRequire(new URL("../../apps/web/package.json", import.meta.url))
const { WebSocketServer } = appRequire("ws")

test("saved standalone credentials connect and changes replace the authenticated connection", async () => {
  const directory = await mkdtemp(join(tmpdir(), "meitheal-ha-config-"))
  const originalEnv = { MEITHEAL_DB_URL: process.env.MEITHEAL_DB_URL, SUPERVISOR_TOKEN: process.env.SUPERVISOR_TOKEN, HA_BASE_URL: process.env.HA_BASE_URL, HA_TOKEN: process.env.HA_TOKEN }
  const receivedTokens: string[] = []
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" })
  await new Promise<void>(resolve => server.once("listening", resolve))
  server.on("connection", (socket: { send(data: string): void; on(event: string, callback: (data: Buffer) => void): void }) => {
    socket.send(JSON.stringify({ type: "auth_required", ha_version: "2026.11.0" }))
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString())
      if (message.type === "auth") {
        receivedTokens.push(message.access_token)
        socket.send(JSON.stringify({ type: "auth_ok", ha_version: "2026.11.0" }))
      } else if (message.type === "ping") {
        socket.send(JSON.stringify({ id: message.id, type: "pong" }))
      } else {
        socket.send(JSON.stringify({ id: message.id, type: "result", success: true, result: message.type === "get_states" ? [] : null }))
      }
    })
  })
  const store = await import("../helpers/persistence-fixture")
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
    await settings.upsert("ha_url", JSON.stringify(`http://127.0.0.1:${server.address().port}`))
    await settings.upsert("ha_token", JSON.stringify("fixture-first"))
    const first = await ha.getHAConnection()
    expect(first).not.toBeNull()
    expect(ha.getHAConnectionStatus().connected).toBe(true)
    await settings.upsert("ha_token", JSON.stringify("fixture-second"))
    const second = await ha.getHAConnection()
    expect(second).not.toBeNull()
    expect(second).not.toBe(first)
    expect(receivedTokens).toEqual(["fixture-first", "fixture-second"])
    expect(JSON.stringify(ha.getHAConnectionStatus())).not.toContain("fixture-")
  } finally {
    entities.stopEntitySubscription()
    ha.closeHAConnection()
    for (const socket of server.clients) socket.terminate()
    await new Promise<void>(resolve => server.close(resolve))
    store.resetPersistenceForTests()
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(directory, { recursive: true, force: true })
  }
})

test("unconfigured startup reuses migrated settings and admits saved, environment and database changes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "meitheal-ha-startup-"))
  const originalEnv = Object.fromEntries(["MEITHEAL_DB_URL", "SUPERVISOR_TOKEN", "HA_BASE_URL", "HA_TOKEN"].map(key => [key, process.env[key]]))
  const fixture = await startHAWebSocketFixture()
  const store = await import("../helpers/persistence-fixture")
  const ha = await import("../../apps/web/src/domains/ha/ha-connection")
  const { initHAIntegrations, clearGrocyStartupRetry } = await import("../../apps/web/src/domains/ha/ha-startup")
  const { SettingsRepository } = await import("../../apps/web/src/domains/tasks/persistence/settings-repository")
  const { stopDueDateReminders } = await import("../../apps/web/src/domains/notifications/due-date-reminders")
  const { stopEntitySubscription } = await import("../../apps/web/src/domains/ha/ha-entities")
  let restoreSettingsObservation = () => {}
  const observeSettingsBootstrap = () => {
    restoreSettingsObservation()
    const db = store.getPersistenceClient()
    const execute = db.execute.bind(db)
    const ensureSettingsTable = SettingsRepository.prototype.ensureSettingsTable
    const observed = { bootstraps: 0, reads: 0 }
    SettingsRepository.prototype.ensureSettingsTable = async function () {
      observed.bootstraps++
      return ensureSettingsTable.call(this)
    }
    db.execute = async statement => {
      const sql = typeof statement === "string" ? statement : statement.sql
      if (sql.includes("SELECT key, value FROM settings WHERE key IN") &&
          typeof statement !== "string" && Array.isArray(statement.args) && statement.args.includes("ha_url")) observed.reads++
      return execute(statement)
    }
    restoreSettingsObservation = () => {
      db.execute = execute
      SettingsRepository.prototype.ensureSettingsTable = ensureSettingsTable
    }
    return observed
  }
  try {
    delete process.env.SUPERVISOR_TOKEN
    delete process.env.HA_BASE_URL
    delete process.env.HA_TOKEN
    process.env.MEITHEAL_DB_URL = `file:${join(directory, "first.db")}`
    ha.closeHAConnection()
    store.resetPersistenceForTests()
    await store.ensureSchema()
    const first = observeSettingsBootstrap()
    await initHAIntegrations()
    expect(first).toEqual({ bootstraps: 0, reads: 1 })
    for (let i = 0; i < 20; i++) await initHAIntegrations()
    expect(first).toEqual({ bootstraps: 0, reads: 1 })

    // Even an incomplete environment edit invalidates known-unconfigured admission.
    process.env.HA_BASE_URL = fixture.url
    await initHAIntegrations()
    expect(first).toEqual({ bootstraps: 0, reads: 2 })

    process.env.MEITHEAL_DB_URL = `file:${join(directory, "second.db")}`
    await store.ensureSchema()
    const second = observeSettingsBootstrap()
    await initHAIntegrations()
    expect(second).toEqual({ bootstraps: 0, reads: 1 })
    await initHAIntegrations()
    expect(second).toEqual({ bootstraps: 0, reads: 1 })

    // Direct/out-of-process database changes still get a bounded retry without a local revision signal.
    await setTimeout(5_050)
    await initHAIntegrations()
    expect(second).toEqual({ bootstraps: 0, reads: 2 })

    const settings = new SettingsRepository(store.getPersistenceClient())
    await settings.importBatch([
      { key: "ha_url", value: JSON.stringify(fixture.url) },
      { key: "ha_token", value: JSON.stringify("invalid-startup-fixture") },
    ])
    await initHAIntegrations()
    expect(fixture.tokens).toEqual(["invalid-startup-fixture"])
    // Configured failures retain next-request retry; they do not inherit the unconfigured cooldown.
    await initHAIntegrations()
    expect(fixture.tokens).toEqual(["invalid-startup-fixture", "invalid-startup-fixture"])

    await settings.importBatch([
      { key: "ha_url", value: JSON.stringify(fixture.url) },
      { key: "ha_token", value: JSON.stringify("startup-fixture") },
    ])
    await initHAIntegrations()
    expect(fixture.tokens).toEqual(["invalid-startup-fixture", "invalid-startup-fixture", "startup-fixture"])
    expect(ha.getHAConnectionStatus().connected).toBe(true)
    expect(JSON.stringify(ha.getHAConnectionStatus())).not.toContain("startup-fixture")
    const completed = { ...second }
    await initHAIntegrations()
    expect(second).toEqual(completed)
  } finally {
    restoreSettingsObservation()
    clearGrocyStartupRetry()
    stopDueDateReminders()
    stopEntitySubscription()
    ha.closeHAConnection()
    await fixture.close()
    store.resetPersistenceForTests()
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(directory, { recursive: true, force: true })
  }
})
