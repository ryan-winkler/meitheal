import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import {
  ensureSchema,
  getPersistenceClient,
  resetPersistenceForTests,
} from "../helpers/persistence-fixture"
import { getTasksForView, getTodayTaskCounts, getTodayTaskRows, todayDueSection } from "../../apps/web/src/lib/task-queries"
import { calendarToday, formatRelativeDue } from "../../apps/web/src/lib/date"

for (const [timezone, midnight] of [
  ["Europe/Dublin", "2031-06-30T23:00:00.000Z"],
  ["America/Los_Angeles", "2031-07-01T07:00:00.000Z"],
  ["Pacific/Auckland", "2030-12-31T11:00:00.000Z"],
] as const) {
  test(`Today keeps one request clock across midnight in ${timezone}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "meitheal-today-midnight-"))
    const original = process.env.MEITHEAL_DB_URL
    process.env.MEITHEAL_DB_URL = `file:${join(directory, "today.db")}`
    resetPersistenceForTests()
    const boundary = Date.parse(midnight)
    const before = new Date(boundary - 1000)
    const after = new Date(boundary + 1000)
    const today = calendarToday(timezone, before)
    const tomorrow = calendarToday(timezone, after)
    const timedDue = new Date(boundary - 500).toISOString()

    try {
      await ensureSchema()
      const client = getPersistenceClient()
      for (const [id, due] of [["date-only", today], ["timed", timedDue], ["tomorrow", tomorrow]] as const) {
        await client.execute({
          sql: `INSERT INTO tasks
            (id, title, idempotency_key, request_id, status, due_date, is_favorite, created_at, updated_at)
            VALUES (?, ?, ?, ?, 'pending', ?, 1, 1, 1)`,
          args: [id, id, id, id, due],
        })
      }
      const read = async (now: Date) => {
        const day = calendarToday(timezone, now)
        const result = await getTodayTaskRows(day, false, timezone, now)
        return new Map(result.tasks.map(task => [task.id, {
          overdue: task.is_overdue,
          section: todayDueSection(task.due_date!, day, timezone),
          label: task.is_overdue ? "Overdue" : formatRelativeDue(task.due_date!, timezone, now),
        }]))
      }

      const first = await read(before)
      expect(first.get("date-only")).toEqual({ overdue: false, section: "due", label: "Due today" })
      expect(first.get("timed")).toMatchObject({ overdue: false, section: "due" })
      expect(first.get("tomorrow")).toEqual({ overdue: false, section: null, label: "Due tomorrow" })

      // The timed deadline passes while the captured household day stays the same.
      const deadlinePassed = await read(new Date(boundary - 250))
      expect(deadlinePassed.get("timed")).toEqual({ overdue: true, section: "due", label: "Overdue" })
      expect(deadlinePassed.get("date-only")).toEqual(first.get("date-only"))

      const nextDay = await read(after)
      expect(nextDay.get("date-only")).toEqual({ overdue: true, section: "carried", label: "Overdue" })
      expect(nextDay.get("timed")).toEqual({ overdue: true, section: "carried", label: "Overdue" })
      expect(nextDay.get("tomorrow")).toEqual({ overdue: false, section: "due", label: "Due today" })

      // Reusing the captured request time after later reads retains its original presentation.
      expect(await read(before)).toEqual(first)
    } finally {
      resetPersistenceForTests()
      if (original === undefined) delete process.env.MEITHEAL_DB_URL
      else process.env.MEITHEAL_DB_URL = original
      await rm(directory, { recursive: true, force: true })
    }
  })
}

test("Today reads full queue counts without materializing hidden rows", async () => {
  const work = await mkdtemp(join(tmpdir(), "meitheal-today-query-"))
  const original = process.env.MEITHEAL_DB_URL
  process.env.MEITHEAL_DB_URL = `file:${join(work, "today.db")}`
  resetPersistenceForTests()
  const date = "2026-11-09"
  const now = 1794250000000
  const dayStart = Date.parse(date)

  try {
    await ensureSchema()
    const client = getPersistenceClient()
    async function addTask(id: string, options: {
      status?: string
      due?: string
      favorite?: number
      payload?: string
      updated?: string | number
    } = {}) {
      await client.execute({
        sql: `INSERT INTO tasks
          (id, title, idempotency_key, request_id, created_at, updated_at, status, due_date, is_favorite, framework_payload)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [id, id, id, id, now, options.updated ?? now, options.status ?? "pending",
          options.due ?? null, options.favorite ?? 0, options.payload ?? "{}"],
      })
    }

    await addTask("ordinary")
    await addTask("empty-date", { due: "" })
    await addTask("complete-iso", { status: "complete", updated: `${date}T01:00:00Z` })
    await addTask("complete-ms", { status: "complete" })
    await addTask("complete-start", { status: "complete", updated: dayStart })
    await addTask("complete-before", { status: "complete", updated: dayStart - 1 })
    await addTask("complete-next-day", { status: "complete", updated: dayStart + 86_400_000 })
    await expect(getTodayTaskRows(date, false)).resolves.toEqual({
      completedTasks: [
        { id: "complete-ms", title: "complete-ms" },
        { id: "complete-iso", title: "complete-iso" },
        { id: "complete-start", title: "complete-start" },
      ],
      completedTodayCount: 3,
      openUnscheduledCount: 2,
      tasks: [],
    })

    await addTask("pinned", { favorite: 1 })
    await addTask("legacy-due", { due: "11/08/2026" })
    const payload = JSON.stringify({ reach: "0x10", impact: 2, confidence: true, effort: 1 })
    await addTask("rice-first", { payload })
    await addTask("rice-second", { payload })
    await addTask("archived", { status: "archived" })
    const baselineRows = await getTodayTaskRows(date, true)
    const baselineCounts = await getTodayTaskCounts(new Date(now), undefined, true)
    const baselineView = await getTasksForView()
    await client.batch([
      "INSERT INTO task_boards (id, name, visibility, ticket_prefix, created_at, updated_at) VALUES ('work', 'Work', 'restricted', 'WORKABCD', 1, 1)",
      "INSERT INTO kanban_lanes (id, key, label, board_id, created_at, updated_at) VALUES ('work-pending', 'pending', 'Pending', 'work', 1, 1)",
      { sql: `INSERT INTO tasks (id, title, status, area_id, task_board_id, board_column_id, ticket_ref, is_favorite,
          idempotency_key, request_id, created_at, updated_at)
        VALUES ('private-work', 'Private Work ticket', 'pending', '__meitheal_no_area__',
          'work', 'work-pending', 'WORKABCD-1', 1, 'work-key', 'work-req', ?, ?)`, args: [now, now] },
      { sql: `INSERT INTO tasks (id, title, status, area_id, task_board_id, board_column_id, ticket_ref,
          idempotency_key, request_id, created_at, updated_at)
        VALUES ('private-work-done', 'Private completed Work ticket', 'complete', '__meitheal_no_area__',
          'work', 'work-pending', 'WORKABCD-2', 'work-done-key', 'work-done-req', ?, ?)`, args: [now, now] },
    ], "write")
    expect(await getTodayTaskRows(date, true)).toEqual(baselineRows)
    expect(await getTodayTaskCounts(new Date(now), undefined, true)).toEqual(baselineCounts)
    expect(await getTasksForView()).toEqual(baselineView)
    const full = await getTasksForView()
    const collapsed = await getTodayTaskRows(date, false)
    const expanded = await getTodayTaskRows(date, true)

    expect(expanded.tasks).toEqual(full.tasks.filter(task => !task.is_done && task.status !== "archived"))
    expect(collapsed.tasks.map(task => [task.id, task.rice])).toEqual([
      ["rice-second", 32], ["rice-first", 32], ["legacy-due", null], ["pinned", null],
    ])
    expect(collapsed.openUnscheduledCount).toBe(5)
    expect(expanded.openUnscheduledCount).toBe(collapsed.openUnscheduledCount)
    expect(expanded.completedTodayCount).toBe(collapsed.completedTodayCount)

    await client.execute({
      sql: `WITH RECURSIVE fixtures(n) AS (
              SELECT 1 UNION ALL SELECT n + 1 FROM fixtures WHERE n < 120
            )
            INSERT INTO tasks (id, title, idempotency_key, request_id, created_at, updated_at, due_date)
            SELECT 'dated-' || n, 'Scheduled fixture', 'dated-' || n, 'dated-' || n, ?, ?, '2026-11-08'
            FROM fixtures`,
      args: [now, now],
    })
    await addTask("pinned-overdue", { favorite: 1, due: "2026-11-08" })
    await expect(getTodayTaskCounts(new Date(now))).resolves.toEqual({
      dueToday: 0, completedToday: 3, carriedForward: 121, remaining: 123, completionPercent: 2,
    })

    await test.step("a failed Today read rejects", async () => {
      await client.execute("ALTER TABLE tasks RENAME COLUMN description TO unavailable_description")
      await expect(getTodayTaskRows(date, false)).rejects.toThrow(/no such column: description/)
    })
  } finally {
    resetPersistenceForTests()
    if (original === undefined) delete process.env.MEITHEAL_DB_URL
    else process.env.MEITHEAL_DB_URL = original
    await rm(work, { recursive: true, force: true })
  }
})
