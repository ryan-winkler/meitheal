import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import { ensureSchema, getPersistenceClient, resetPersistenceForTests } from "../helpers/persistence-fixture"
import { registerVerifiedPrincipal } from "../../apps/web/src/domains/tasks/board-scope"
import { BoardAccessService } from "../../apps/web/src/domains/tasks/board-access-service"
import { NamedBoardRepository } from "../../apps/web/src/domains/tasks/persistence/named-board-repository"
import { TaskRepository } from "../../apps/web/src/domains/tasks/persistence/task-repository"
import { HierarchyRepository } from "../../apps/web/src/domains/tasks/persistence/hierarchy-repository"
import { prepareTaskCreation } from "../../apps/web/src/domains/tasks/task-creation-service"

let directory: string
let originalUrl: string | undefined

test.beforeEach(async () => {
  originalUrl = process.env.MEITHEAL_DB_URL
  directory = await mkdtemp(join(tmpdir(), "meitheal-ordinary-work-"))
  process.env.MEITHEAL_DB_URL = `file:${join(directory, "work.db")}`
  await ensureSchema()
})
test.afterEach(async () => {
  resetPersistenceForTests()
  if (originalUrl === undefined) delete process.env.MEITHEAL_DB_URL
  else process.env.MEITHEAL_DB_URL = originalUrl
  await rm(directory, { recursive: true, force: true })
})

for (const encoding of ["legacy", "scoped"] as const) {
  test(`rich task creation and normalized planning use the same command: ${encoding}`, async () => {
    const db = getPersistenceClient()
    const owner = registerVerifiedPrincipal({ kind: "ha_user", id: "parent" }, { administrator: true, expiresAt: Date.now() + 60_000 })
    let boardId = "household"
    if (encoding === "scoped") {
      const created = await new NamedBoardRepository(db).create(owner, "Work")
      expect(created.status).toBe("committed")
      if (created.status !== "committed") throw new Error("Board creation failed")
      boardId = created.result.id
    }
    const resolved = await new BoardAccessService(db).resolve(owner, boardId, { resource: "task", action: "create" })
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) throw new Error(resolved.errorCode)
    const repo = new TaskRepository(db, resolved.scope)
    const hierarchy = new HierarchyRepository(db, resolved.scope)
    await hierarchy.createArea({ id: `${encoding}-kitchen`, name: "Kitchen" })
    await hierarchy.createProject({ id: `${encoding}-garden`, title: "Garden", area_id: `${encoding}-kitchen` })
    const prepared = await prepareTaskCreation(repo, { title: "Groceries", task_kind: "shopping_item", priority: 1, area_id: `${encoding}-kitchen`, project_id: `${encoding}-garden`, labels: ["Errands"], custom_fields: JSON.stringify({ items: [{ name: "Milk", qty: 2 }] }) })
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) throw new Error(prepared.error)
    const created = await repo.createWorkCommand(prepared.task, { captureAttemptDigest: `private-${encoding}`, clientIdempotencyKey: "same-key" })
    expect(created.ok).toBe(true)
    if (!created.ok) throw new Error(created.errorCode)
    expect(created.task).toMatchObject({ title: "Groceries", task_kind: "shopping_item", priority: 1, area_id: `${encoding}-kitchen`, project_id: `${encoding}-garden` })
    expect(await repo.findById(created.task.id)).toMatchObject({ task_kind: "shopping_item", project_id: `${encoding}-garden` })
    expect((await repo.findAll({ projectId: `${encoding}-garden` })).total).toBe(1)
    expect(await repo.findCaptureReceipt(`private-${encoding}`)).toEqual({ id: created.task.id, ticket_key: expect.any(String), task_kind: "shopping_item" })
    expect(await repo.createWorkCommand(prepared.task, { captureAttemptDigest: `private-${encoding}` })).toEqual({ ok: false, errorCode: "capture_conflict" })
  })
}
