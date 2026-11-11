import { expect, test } from "@playwright/test"
import { createRequire } from "node:module"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

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
