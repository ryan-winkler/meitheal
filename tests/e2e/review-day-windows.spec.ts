import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import { runWithIngressTransport } from "../../apps/web/scripts/ingress-transport.mjs"
import { ensureSchema, getPersistenceClient, resetPersistenceForTests } from "../helpers/persistence-fixture"
import { calendarToday, shiftCalendarDay } from "../../apps/web/src/lib/date"
import { GET as velocity } from "../../apps/web/src/pages/api/review/velocity"
import { GET as weekly } from "../../apps/web/src/pages/api/review/weekly"

test("review reports bucket epoch timestamps by the household day", async () => {
  const previous = process.env.MEITHEAL_DB_URL
  const directory = await mkdtemp(join(tmpdir(), "meitheal-review-days-"))
  process.env.MEITHEAL_DB_URL = `file:${join(directory, "tasks.db")}`
  resetPersistenceForTests()
  await ensureSchema()
  const db = getPersistenceClient()

  try {
    const timezone = "Pacific/Kiritimati"
    const today = calendarToday(timezone)
    const start = shiftCalendarDay(today, -6)
    for (const [id, day] of [["within-window", today], ["before-window", shiftCalendarDay(start, -1)]]) {
      const timestamp = String(Date.parse(`${day}T01:00:00+14:00`))
      await db.execute({
        sql: "INSERT INTO tasks (id, title, status, idempotency_key, request_id, created_at, updated_at) VALUES (?, ?, 'complete', ?, ?, ?, ?)",
        args: [id!, id!, id!, id!, timestamp, timestamp],
      })
    }
    const transport = { peer: "127.0.0.1", fromSupervisor: false, identityHeadersSafe: true, configuredPath: undefined }
    const url = new URL("http://127.0.0.1/api/review/velocity?days=7")
    const context = { url, request: new Request(url), params: {}, locals: { timezone } }
    const [velocityResponse, weeklyResponse] = await runWithIngressTransport(transport, () => Promise.all([
      velocity(context as Parameters<typeof velocity>[0]),
      weekly(context as Parameters<typeof weekly>[0]),
    ]))
    expect(velocityResponse.status).toBe(200)
    expect(weeklyResponse.status).toBe(200)
    const trend = await velocityResponse.json()
    const summary = await weeklyResponse.json()
    expect(trend.period).toEqual({ start, end: today, days: 7 })
    expect(summary.period).toEqual(trend.period)
    expect(trend.dataPoints.at(-1)).toEqual({ date: today, count: 1 })
    expect(trend.total).toBe(1)
    expect(summary.velocity.at(-1)).toEqual({ date: today, created: 1, completed: 1 })
    expect(summary.totalCompleted).toBe(1)
  } finally {
    db.close()
    resetPersistenceForTests()
    if (previous === undefined) delete process.env.MEITHEAL_DB_URL
    else process.env.MEITHEAL_DB_URL = previous
    await rm(directory, { recursive: true, force: true })
  }
})
