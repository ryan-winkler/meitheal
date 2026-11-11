import { createRequire } from "node:module"
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


/** Replay heartbeat scheduling only; authentication, sockets, pings and close
 * handshakes still use the installed library and real loopback WebSockets. */
function captureHeartbeatTimers() {
  const original = { setInterval, clearInterval, setTimeout, clearTimeout }
  type Scheduled = { handle: ReturnType<typeof setTimeout>; callback: () => void; pending: boolean }
  const intervals: Scheduled[] = []
  const deadlines: Scheduled[] = []
  let heartbeatTick = false
  globalThis.setInterval = ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
    const handle = original.setInterval(callback, delay, ...args)
    if (delay === 30_000) intervals.push({ handle, callback: () => callback(...args), pending: true })
    return handle
  }) as typeof setInterval
  globalThis.clearInterval = (handle => {
    const scheduled = intervals.find(timer => timer.handle === handle)
    if (scheduled) scheduled.pending = false
    original.clearInterval(handle)
  }) as typeof clearInterval
  globalThis.setTimeout = ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
    const handle = original.setTimeout(callback, delay, ...args)
    if (heartbeatTick && delay === 10_000) deadlines.push({ handle, callback: () => callback(...args), pending: true })
    return handle
  }) as typeof setTimeout
  globalThis.clearTimeout = (handle => {
    const scheduled = deadlines.find(timer => timer.handle === handle)
    if (scheduled) scheduled.pending = false
    original.clearTimeout(handle)
  }) as typeof clearTimeout
  return {
    intervals, deadlines,
    tick(timer: Scheduled) {
      heartbeatTick = true
      try { timer.callback() } finally { heartbeatTick = false }
    },
    expire(timer: Scheduled) {
      if (!timer.pending) return
      original.clearTimeout(timer.handle)
      timer.pending = false
      timer.callback()
    },
    restore() {
      for (const timer of intervals) original.clearInterval(timer.handle)
      for (const timer of deadlines) original.clearTimeout(timer.handle)
      Object.assign(globalThis, original)
    },
  }
}

for (const settlement of ["pong", "close"] as const) {
  test(`retired HA heartbeat deadline and late ${settlement} cannot affect its replacement or a foreign Core connection`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "meitheal-ha-heartbeat-"))
    const previous = Object.fromEntries(["MEITHEAL_DB_URL", "SUPERVISOR_TOKEN", "HA_BASE_URL", "HA_TOKEN"].map(key => [key, process.env[key]]))
    const local = await startHAWebSocketFixture({
      holdPings: ["fixture-first", "fixture-second"],
      pauseAfterPing: ["fixture-first"],
      entities: {
        "fixture-first": { "calendar.first": { s: "on", a: {}, lc: 1, c: "fixture" } },
        "fixture-second": { "calendar.second": { s: "on", a: {}, lc: 1, c: "fixture" } },
      },
    })
    const foreignCore = await startHAWebSocketFixture()
    const store = await import("../../apps/web/src/domains/tasks/persistence/store")
    const ha = await import("../../apps/web/src/domains/ha/ha-connection")
    const entities = await import("../../apps/web/src/domains/ha/ha-entities")
    const websocket = await import(createRequire(new URL("../../apps/web/package.json", import.meta.url)).resolve("home-assistant-js-websocket"))
    const clock = captureHeartbeatTimers()
    let foreign: NonNullable<Awaited<ReturnType<typeof ha.getHAConnection>>> | undefined
    const errors: string[] = []
    const unsubscribe = ha.onHAConnectionStatus((state, detail) => { if (state === "error") errors.push(detail ?? "") })
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
      await settings.upsert("ha_url", JSON.stringify(local.url))
      await settings.upsert("ha_token", JSON.stringify("fixture-first"))
      foreign = await websocket.createConnection({ auth: websocket.createLongLivedTokenAuth(foreignCore.url, "fixture-foreign") })
      const first = await ha.getHAConnection()
      expect(first).not.toBeNull()
      await expect.poll(() => Object.keys(entities.getAllEntities())).toEqual(["calendar.first"])
      expect(clock.intervals).toHaveLength(1)
      clock.tick(clock.intervals[0]!)
      await expect.poll(() => local.pings.length).toBe(1)
      expect(clock.deadlines).toHaveLength(1)
      const oldDeadline = clock.deadlines[0]!
      const oldPing = local.pings[0]!
      expect(first!.commands.has(oldPing.id)).toBe(true)

      await settings.upsert("ha_token", JSON.stringify("fixture-second"))
      const second = await ha.getHAConnection()
      expect(second).not.toBeNull()
      expect(second).not.toBe(first)
      expect(first!.socket?.readyState).toBe(2) // Real stalled ws CLOSING, not a mocked close.
      expect(first!.commands.has(oldPing.id)).toBe(true)
      await expect.poll(() => Object.keys(entities.getAllEntities())).toEqual(["calendar.second"])
      expect(clock.intervals).toHaveLength(2)
      clock.tick(clock.intervals[1]!)
      await expect.poll(() => local.pings.length).toBe(2)
      const currentDeadline = clock.deadlines[1]!
      expect(currentDeadline.pending).toBe(true)

      // The old unanswered ping's actual production deadline becomes due first.
      const retiredDeadlinePending = oldDeadline.pending
      clock.expire(oldDeadline)
      expect(ha.getHAConnectionStatus().connected).toBe(true)
      expect(retiredDeadlinePending).toBe(false)
      expect(clock.intervals[0]!.pending).toBe(false)
      expect(second!.closeRequested).toBe(false)
      expect(errors).toEqual([])
      await expect(second!.sendMessagePromise({ type: "get_states" })).resolves.toEqual([])
      await expect(foreign!.sendMessagePromise({ type: "ping" })).resolves.toBeUndefined()
      // A retired callback must also be harmless if dispatch races retirement.
      oldDeadline.callback()
      clock.tick(clock.intervals[0]!)
      expect(clock.deadlines).toHaveLength(2)
      expect(second!.closeRequested).toBe(false)

      if (settlement === "pong") local.releasePong("fixture-first")
      else local.resume("fixture-first")
      await expect.poll(() => first!.commands.has(oldPing.id)).toBe(false)
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(currentDeadline.pending).toBe(true)
      expect(ha.getHAConnectionStatus().connected).toBe(true)
      expect(errors).toEqual([])
      clock.expire(currentDeadline)
      expect(clock.intervals[1]!.pending).toBe(false)
      expect(second!.closeRequested).toBe(true)
      expect(ha.getHAConnectionStatus().connected).toBe(false)
      expect(errors).toEqual(["heartbeat timeout"])
      expect(foreign!.connected).toBe(true)
      await expect(foreign!.sendMessagePromise({ type: "ping" })).resolves.toBeUndefined()
    } finally {
      clock.restore()
      unsubscribe()
      entities.stopEntitySubscription()
      ha.closeHAConnection()
      foreign?.close()
      await local.close()
      await foreignCore.close()
      store.resetPersistenceForTests()
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      await rm(directory, { recursive: true, force: true })
    }
  })
}
