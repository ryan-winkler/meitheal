import { readFile, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import { startHAWebSocketFixture } from "../scripts/ha-websocket-fixture"
import { fireHAEvent } from "../../apps/web/src/domains/ha/ha-events"
import { closeHAConnection } from "../../apps/web/src/domains/ha/ha-connection"
import { stopEntitySubscription } from "../../apps/web/src/domains/ha/ha-entities"
import { resetPersistenceForTests } from "../../apps/web/src/domains/tasks/persistence/store"

test("App WebSocket events match the native Core device trigger contract", async () => {
  const contract = JSON.parse(await readFile(new URL("../../integrations/home-assistant/tests/fixtures/app-task-overdue.json", import.meta.url), "utf8"))
  const directory = await mkdtemp(join(tmpdir(), "meitheal-event-contract-"))
  const keys = ["MEITHEAL_DB_URL", "SUPERVISOR_TOKEN", "HA_BASE_URL", "HA_TOKEN"]
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]))
  const ha = await startHAWebSocketFixture()
  try {
    delete process.env.SUPERVISOR_TOKEN
    process.env.HA_BASE_URL = ha.url
    process.env.HA_TOKEN = "event-fixture"
    process.env.MEITHEAL_DB_URL = `file:${join(directory, "tasks.db")}`
    resetPersistenceForTests()
    expect(await fireHAEvent(contract.event_type, {
      task_id: contract.event_data.task_id, title: contract.event_data.title,
    })).toBe(true)
    expect(ha.firedEvents).toHaveLength(1)
    const fired = ha.firedEvents[0]
    if (!fired) throw new Error("App did not emit the expected HA event")
    const { timestamp, ...eventData } = fired.event_data
    expect(typeof timestamp).toBe("string")
    expect(new Date(String(timestamp)).toISOString()).toBe(timestamp)
    expect({ event_type: fired.event_type, event_data: eventData }).toEqual(contract)
  } finally {
    stopEntitySubscription()
    closeHAConnection()
    await ha.close()
    resetPersistenceForTests()
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(directory, { recursive: true, force: true })
  }
})
