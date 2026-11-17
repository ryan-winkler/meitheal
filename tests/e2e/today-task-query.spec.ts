import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import {
  ensureSchema,
  getPersistenceClient,
  resetPersistenceForTests,
} from "../../apps/web/src/domains/tasks/persistence/store"
import { getTasksForView, getTodayTaskCounts, getTodayTaskRows } from "../../apps/web/src/lib/task-queries"

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
  } finally {
    resetPersistenceForTests()
    if (original === undefined) delete process.env.MEITHEAL_DB_URL
    else process.env.MEITHEAL_DB_URL = original
    await rm(work, { recursive: true, force: true })
  }
})
