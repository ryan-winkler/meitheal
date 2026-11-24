import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import { runWithIngressTransport } from "../../apps/web/scripts/ingress-transport.mjs"
import { resolveBoardRequestScope, verifiedBoardRequestPrincipal } from "../../apps/web/src/lib/board-request-context"
import { boardSessionProof } from "../../apps/web/src/lib/named-board-request"
import { db503Response } from "../../apps/web/src/lib/db-fallback"
import { ensureSchema, getPersistenceClient, resetPersistenceForTests } from "../helpers/persistence-fixture"
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
    try {
      await ensureSchema()
      const client = getPersistenceClient()
      await client.execute({
        sql: "INSERT INTO tasks (id,title,status,idempotency_key,request_id,created_at,updated_at) VALUES (?,?,?,?,?,1,1)",
        args: ["retained", "Retain this completed task", "complete", "retained", "retained"],
      })
      const snapshot = async () => ({
        tasks: (await client.execute("SELECT * FROM tasks ORDER BY id")).rows,
        audit: (await client.execute("SELECT * FROM audit_trail ORDER BY audit_id")).rows,
      })
      const before = await snapshot()
      const transport = { peer: "127.0.0.1", fromSupervisor: false, identityHeadersSafe: true, configuredPath: undefined }
      const principal = await runWithIngressTransport(transport, () => verifiedBoardRequestPrincipal({
        request: new Request("http://localhost/boards"), locals: {} as App.Locals,
      }))
      if (!principal) throw new Error("Current standalone operator fixture was not admitted")
      const url = new URL(`http://localhost/api/tasks${query}`)
      const request = new Request(url, { method: handler === deleteCompleted ? "DELETE" : "GET",
        headers: { "x-meitheal-board-id": "household", "x-meitheal-board-session": boardSessionProof(principal.id) },
      })
      const context = { url, request, locals: {} as App.Locals, params: {} }
      const admission = await runWithIngressTransport(transport, () => resolveBoardRequestScope(context, {
        operation: { resource: "task", action: handler === deleteCompleted ? "delete" : "read" },
      }))
      expect(admission.ok).toBe(true)
      const execute = client.execute.bind(client)
      const batch = client.batch.bind(client)
      let attempts = 0
      const unavailable = async () => { attempts++; throw new Error("SQLITE_BUSY: fixture contention") }
      let response: Response
      client.execute = unavailable
      client.batch = unavailable
      try {
        response = await runWithIngressTransport(transport, () => handler(context as Parameters<typeof handler>[0]))
      } finally {
        client.execute = execute
        client.batch = batch
      }
      await expectUnavailable(response, 10)
      expect(attempts).toBe(1)
      expect(await snapshot()).toEqual(before)
    } finally {
      resetPersistenceForTests()
      if (previous === undefined) delete process.env.MEITHEAL_DB_URL
      else process.env.MEITHEAL_DB_URL = previous
      await rm(work, { recursive: true, force: true })
    }
  })
}
