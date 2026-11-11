import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test as base } from "@playwright/test"
import { TaskRepository } from "../../apps/web/src/domains/tasks/persistence/task-repository"
import {
  ensureSchema, getPersistenceClient, resetPersistenceForTests,
} from "../../apps/web/src/domains/tasks/persistence/store"
import type { SearchResponse } from "../../apps/web/src/domains/search/search-types"
import { EXACT_TASK_IDENTIFIER_SCORE } from "../../apps/web/src/lib/task-search-score"
import { GET } from "../../apps/web/src/pages/api/search"

type Database = ReturnType<typeof getPersistenceClient>

const test = base.extend<{ db: Database }>({
  db: async ({}, use) => {
    const previous = process.env.MEITHEAL_DB_URL
    const work = await mkdtemp(join(tmpdir(), "meitheal-search-catalog-"))
    process.env.MEITHEAL_DB_URL = `file:${join(work, "catalog.db")}`
    resetPersistenceForTests()
    const db = getPersistenceClient()
    try {
      await ensureSchema()
      await use(db)
    } finally {
      db.close()
      resetPersistenceForTests()
      if (previous === undefined) delete process.env.MEITHEAL_DB_URL
      else process.env.MEITHEAL_DB_URL = previous
      await rm(work, { recursive: true, force: true })
    }
  },
})

async function addTask(db: Database, id: string, fields: {
  title?: string; ticket?: number; updated?: number | string; status?: string; priority?: number
  assignee?: string; description?: string; labels?: string; customFields?: string
} = {}) {
  await db.execute({
    sql: `INSERT INTO tasks (id,title,ticket_number,updated_at,created_at,status,priority,assigned_to,
          description,labels,custom_fields,idempotency_key,request_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    args: [
      id, fields.title ?? id, fields.ticket ?? null, fields.updated ?? 1, 1, fields.status ?? "pending",
      fields.priority ?? 3, fields.assignee ?? null, fields.description ?? "", fields.labels ?? "[]",
      fields.customFields ?? "{}", id, id,
    ],
  })
}

const search = (params: string) => GET({
  url: new URL("http://localhost/api/search?" + params),
} as Parameters<typeof GET>[0])

async function results(params: Record<string, string>) {
  const response = await search(new URLSearchParams({ scope: "tasks", ...params }).toString())
  expect(response.status).toBe(200)
  const result: SearchResponse = await response.json()
  return result.sections.find(section => section.id === "tasks")?.items ?? []
}

test("exact ID and padded ticket rank ahead of title decoys before the result cap", async ({ db }) => {
  await addTask(db, "OlderExact", { title: "Older exact task", ticket: 1, assignee: "member-a", priority: 2 })
  await addTask(db, "exact-title-decoy", { title: "MTH-1", updated: 100, ticket: 2 })
  await addTask(db, "closed-title", { title: "MTH-1", status: "complete", updated: 200 })
  for (let index = 0; index < 45; index++) {
    await addTask(db, `decoy-${index}`, { title: `MTH-1 mention ${index}`, updated: index + 2 })
  }

  for (const q of ["MTH-1", "mth-0001", "0001", "olderexact"]) {
    const rows = await results({ q, limit: "8" })
    expect(rows[0]).toMatchObject({ id: "OlderExact", meta: { matched_fields: ["ID"] } })
    expect(Number(rows[0]?.meta?.score)).toBeGreaterThanOrEqual(EXACT_TASK_IDENTIFIER_SCORE)
  }
  expect((await results({ q: "MTH-1", task_fields: "title" }))[0]?.id).toBe("exact-title-decoy")
  expect((await results({ q: "MTH-1", sort: "updated", include_completed: "true" }))[0]?.id).toBe("closed-title")
  expect((await results({ q: "MTH-1", priority: "2", assigned_to: "member-a" })).map(row => row.id)).toEqual(["OlderExact"])
  expect((await results({ q: "MTH-1", task_fields: "id", status: "complete" }))).toEqual([])
})

test("only selected fields provide literal matches and deterministic bounded snippets", async ({ db }) => {
  await addTask(db, "comment-task", { description: "Unrelated description" })
  await addTask(db, "literal-task", { title: "Literal 50%_\\ proof", labels: '["ordinary"]' })
  await addTask(db, "wildcard-decoy", { title: "Literal 50xxy proof" })
  await addTask(db, "lower-accent", { title: "éclair" })
  await addTask(db, "upper-accent", { title: "ÉCLAIR" })
  await addTask(db, "legacy-metadata", { customFields: "malformed_legacy" })
  const content = "x".repeat(245) + "violet-meadow".repeat(30)
  for (const text of ["violet-meadow first", content, "Alpha", "beta"]) {
    await db.execute({
      sql: "INSERT INTO comments(task_id,content,created_at) VALUES (?,?,?)",
      args: ["comment-task", text, "2026-11-10T00:00:00Z"],
    })
  }

  const literal = await results({ q: "%_\\", task_fields: "title" })
  expect(literal.map(row => row.id)).toEqual(["literal-task"])
  expect(literal[0]?.description).toBeUndefined()
  expect((await results({ q: "Éclair", task_fields: "title" })).map(row => row.id)).toEqual(["lower-accent"])
  expect((await results({ q: "malformed_legacy", task_fields: "custom_fields" }))[0]?.description).toBe("malformed_legacy")
  expect(await results({ q: "Alpha || beta", task_fields: "comments" })).toEqual([])
  expect(await results({ q: "violet-meadow", task_fields: "title,description" })).toEqual([])

  const comment = (await results({ q: "violet-meadow", task_fields: "comments" }))[0]
  expect(comment).toMatchObject({ id: "comment-task", meta: { matched_fields: ["Comments"] } })
  expect(comment?.description).toMatch(/^\.\.\.x{32}violet-meadow/)
  expect(comment?.description?.length).toBeLessThanOrEqual(180)
  const longQuery = (await results({ q: "violet-meadow".repeat(20), task_fields: "comments" }))[0]
  expect(longQuery?.description?.length).toBeLessThanOrEqual(180)
})

test("recent search handles mixed clocks and accepts only positive safe decimal limits", async ({ db }) => {
  const epoch = Date.parse("2026-11-10T00:00:00Z")
  await addTask(db, "old-iso", { updated: "2026-11-09T00:00:00Z" })
  await addTask(db, "newer-epoch", { updated: epoch, priority: 2 })
  await addTask(db, "same-clock-low-priority", { updated: epoch, priority: 4 })
  expect((await results({})).map(row => row.id)).toEqual(["newer-epoch", "same-clock-low-priority", "old-iso"])
  expect((await results({}))[0]?.meta?.score).toBe(0)

  for (const value of ["", " ", "0", "-1", "+1", "0x10", "1e1", "1.0", "1.25", "9007199254740992"]) {
    const result = await search(new URLSearchParams({ limit: value }).toString())
    expect(result.status, value).toBe(400)
    expect(await result.json()).toMatchObject({ invalidParams: [{ name: "query.limit" }] })
  }
  for (const [params, limit] of [["", 8], ["limit=20", 12], ["limit=0002&limit=bad", 2]] as const) {
    expect(await (await search(params)).json()).toMatchObject({ query: "", meta: { limit } })
  }
})

test("SQLite reads comments only when selected and uses the task index", async ({ db }) => {
  type Statement = { sql: string; args?: Parameters<Database["execute"]>[1] }
  const observed: { statement?: Statement } = {}
  const repo = new TaskRepository({
    execute: (statement: Statement) => {
      observed.statement = statement
      return db.execute(statement.sql, statement.args)
    },
  } as Database)
  for (const [query, fields, comments] of [
    ["", ["comments"], false],
    ["missing", ["title"], false],
    ["missing", ["comments"], true],
  ] as const) {
    await repo.searchCatalog({ query, fields })
    const { statement } = observed
    if (!statement) throw new Error("Expected a bound SQL statement")
    expect(statement.sql).not.toContain("GROUP_CONCAT")
    const explanation = await db.execute({ sql: "EXPLAIN QUERY PLAN " + statement.sql, args: statement.args ?? [] })
    const plan = explanation.rows.map(row => String(row.detail)).join("\n")
    if (comments) {
      expect(plan).toMatch(/SEARCH c USING INDEX comments_task_created_idx \(task_id=\?\)/)
    } else {
      expect(statement.sql).not.toMatch(/\bFROM comments\b/)
    }
  }
})
