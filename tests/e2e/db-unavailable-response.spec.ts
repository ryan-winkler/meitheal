import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import { db503Response } from "../../apps/web/src/lib/db-fallback"
import { ensureSchema, getPersistenceClient, resetPersistenceForTests } from "../../apps/web/src/domains/tasks/persistence/store"
import { GET as listTasks } from "../../apps/web/src/pages/api/tasks/index"
import { GET as previewCompleted, DELETE as deleteCompleted } from "../../apps/web/src/pages/api/tasks/delete-completed"

test.beforeAll(async () => {
  // The existing API logger also appends to this fixture's local fallback log.
  await mkdir(join(process.cwd(), ".data"), { recursive: true })
})

async function expectUnavailable(response: Response, retryAfter: number) {
  expect(response.status).toBe(503)
  expect(response.headers.get("content-type")).toBe("application/problem+json")
  expect(response.headers.get("cache-control")).toBe("no-store")
  expect(response.headers.get("retry-after")).toBe(String(retryAfter))
  expect(await response.json()).toMatchObject({
    type: "https://meitheal.local/problems/database-unavailable",
    title: "Database temporarily unavailable",
    status: 503,
    error: "Database temporarily unavailable",
    retry_after: retryAfter,
  })
}

for (const retryAfter of [7, undefined]) {
  test(`database outages preserve ${retryAfter ?? "default"} retry timing in the shared problem contract`, async () => {
    await expectUnavailable(db503Response("contract-test", new Error("SQLITE_BUSY"), retryAfter), retryAfter ?? 10)
  })
}

for (const [name, handler, query] of [
  ["task list", listTasks, ""],
  ["completed-task preview", previewCompleted, "?months=3"],
  ["completed-task deletion", deleteCompleted, "?months=3&confirm=true"],
] as const) {
  test(`${name} returns the shared busy response without extra attempts or stored changes`, async () => {
    const previous = process.env.MEITHEAL_DB_URL
    const work = await mkdtemp(join(tmpdir(), "meitheal-db503-"))
    process.env.MEITHEAL_DB_URL = `file:${join(work, "tasks.db")}`
    resetPersistenceForTests()
    const client = getPersistenceClient()
    try {
      await ensureSchema()
      await client.execute({
        sql: "INSERT INTO tasks (id,title,status,idempotency_key,request_id,created_at,updated_at) VALUES (?,?,?,?,?,1,1)",
        args: ["retained", "Retain this completed task", "complete", "retained", "retained"],
      })
      const snapshot = async () => ({
        tasks: (await client.execute("SELECT * FROM tasks ORDER BY id")).rows,
        audit: (await client.execute("SELECT * FROM audit_trail ORDER BY audit_id")).rows,
      })
      const before = await snapshot()
      const execute = client.execute.bind(client)
      const batch = client.batch.bind(client)
      let attempts = 0
      const unavailable = async () => { attempts++; throw new Error("SQLITE_BUSY: fixture contention") }
      let response: Response
      client.execute = unavailable
      client.batch = unavailable
      try {
        response = await handler({ url: new URL(`http://localhost/api/tasks${query}`) } as never)
      } finally {
        client.execute = execute
        client.batch = batch
      }
      await expectUnavailable(response, 10)
      expect(attempts).toBe(1)
      expect(await snapshot()).toEqual(before)
    } finally {
      client.close()
      resetPersistenceForTests()
      if (previous === undefined) delete process.env.MEITHEAL_DB_URL
      else process.env.MEITHEAL_DB_URL = previous
      await rm(work, { recursive: true, force: true })
    }
  })
}
