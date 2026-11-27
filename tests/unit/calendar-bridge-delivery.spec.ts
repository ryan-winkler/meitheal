import { randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import { pushTaskToCalendar } from "../../apps/web/src/domains/calendar"
import { closeHAConnection } from "../../apps/web/src/domains/ha/ha-connection"
import { TaskRepository } from "../../apps/web/src/domains/tasks"
import { integrationFixture } from "../helpers/ordinary-integration-fixture"
import {
  ensureSchema,
  getPersistenceClient,
  resetPersistenceForTests,
} from "../helpers/persistence-fixture"
import { startHAWebSocketFixture } from "../scripts/ha-websocket-fixture"

test("manual delivery uses the saved event start and refuses imported, echoed, or unscheduled tasks", async () => {
  const keys = ["MEITHEAL_DB_URL", "SUPERVISOR_TOKEN", "HA_BASE_URL", "HA_TOKEN"] as const
  const previous = keys.map(key => process.env[key])
  const directory = await mkdtemp(join(tmpdir(), "meitheal-calendar-bridge-delivery-"))
  const ha = await startHAWebSocketFixture()
  process.env.MEITHEAL_DB_URL = `file:${join(directory, "tasks.db")}`
  delete process.env.SUPERVISOR_TOKEN
  process.env.HA_BASE_URL = ha.url
  process.env.HA_TOKEN = "calendar-delivery-fixture"
  resetPersistenceForTests()

  try {
    await ensureSchema()
    const db = getPersistenceClient()
    const { context, scope } = await integrationFixture({
      integration: "calendar",
      sourceId: "calendar.family",
      purpose: "calendar.sync",
    })
    await db.execute({
      sql: "INSERT OR REPLACE INTO settings (key, value) VALUES ('calendar_write_ticket_details', ?)",
      args: [JSON.stringify(false)],
    })

    const repo = new TaskRepository(db, scope)
    type TaskFields = Parameters<typeof repo.createTask>[0]
    const date = "2026-12-05"
    const createTask = async (title: string, fields: Partial<TaskFields> = {}) => {
      const id = randomUUID()
      await repo.createTask({
        id,
        title,
        description: "",
        status: "pending",
        priority: 2,
        due_date: date,
        labels: "[]",
        framework_payload: "{}",
        area_id: "default",
        custom_fields: "{}",
        task_type: "task",
        progress: 0,
        parent_id: null,
        start_date: null,
        end_date: null,
        color: null,
        assigned_to: null,
        ...fields,
      })
      return id
    }

    const event = await createTask("Family appointment", {
      task_kind: "calendar_event",
      start_date: "2026-12-04",
      end_date: "2026-12-05",
    })
    const imported = await createTask("Previously imported appointment")
    await db.execute({
      sql: "UPDATE tasks SET idempotency_key = ? WHERE id = ?",
      args: ["caldav-sync-legacy-appointment", imported],
    })
    const echo = await createTask("Previously exported appointment", {
      description: "Added from Meitheal",
    })
    const unscheduled = await createTask("Draft appointment", { due_date: null })
    const optedOut = await createTask("Private appointment", { labels: '["no-sync"]' })
    const deliver = (id: string, manual: boolean) =>
      pushTaskToCalendar(context, id, "Stale title", "2026-12-01", undefined, undefined, manual)
    const calendarWrites = () => ha.serviceCalls.filter(call => call.domain === "calendar")

    expect(await deliver(event, false)).toBe(false)
    for (const id of [imported, echo, unscheduled, optedOut]) {
      expect(await deliver(id, true)).toBe(false)
    }
    expect(calendarWrites()).toHaveLength(0)

    expect(await deliver(event, true)).toBe(true)
    expect(calendarWrites()).toEqual([expect.objectContaining({
      service: "create_event",
      service_data: expect.objectContaining({
        summary: "Family appointment",
        start_date: "2026-12-04",
        end_date: "2026-12-05",
        description: "Added from Meitheal",
      }),
    })])
  } finally {
    closeHAConnection()
    await ha.close()
    resetPersistenceForTests()
    for (const [index, key] of keys.entries()) {
      const value = previous[index]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(directory, { recursive: true, force: true })
  }
})
