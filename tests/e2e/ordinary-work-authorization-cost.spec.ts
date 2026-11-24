import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import { ensureSchema, getPersistenceClient, resetPersistenceForTests } from "../helpers/persistence-fixture"
import { registerVerifiedPrincipal } from "../../apps/web/src/domains/tasks/board-scope"
import { BoardAccessService } from "../../apps/web/src/domains/tasks/board-access-service"
import { NamedBoardTaskRepository } from "../../apps/web/src/domains/tasks/persistence/named-board-task-repository"
import { TaskRepository } from "../../apps/web/src/domains/tasks/persistence/task-repository"
import { prepareTaskCreation } from "../../apps/web/src/domains/tasks/task-creation-service"

test("measure actual SQL work for a compound create and complete command", async () => {
  const directory = await mkdtemp(join(tmpdir(), "meitheal-work-authorization-cost-"))
  const prior = process.env.MEITHEAL_DB_URL
  process.env.MEITHEAL_DB_URL = `file:${join(directory, "work.db")}`
  try {
    await ensureSchema()
    let statements = 0
    function instrument<T extends object>(target: T): T {
      return new Proxy(target, { get(object, property) {
        const method = Reflect.get(object, property)
        if (typeof method !== "function") return method
        if (property === "execute") return (...args: unknown[]) => { statements++; return method.apply(object, args) }
        if (property === "batch") return (...args: unknown[]) => { statements += Array.isArray(args[0]) ? args[0].length : 1; return method.apply(object, args) }
        if (property === "transaction") return async (...args: unknown[]) => instrument(await method.apply(object, args))
        return typeof method === "function" ? method.bind(object) : method
      } })
    }
    const db = instrument(getPersistenceClient())
    const owner = registerVerifiedPrincipal({ kind: "ha_user", id: "parent" }, { administrator: true, expiresAt: Date.now() + 60_000 })
    const resolved = await new BoardAccessService(db).resolve(owner, "household", { resource: "task", action: "create" })
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) throw new Error(resolved.errorCode)
    const repo = new TaskRepository(db, resolved.scope)
    const prepared = await prepareTaskCreation(repo, { title: "Done at capture", status: "complete" }, { useDefaultAssignee: false })
    if (!prepared.ok) throw new Error(prepared.error)
    statements = 0
    const started = performance.now()
    const result = await repo.createWorkCommand(prepared.task)
    const metrics = { phase: process.env.MEITHEAL_AUTH_COST_PHASE ?? "measurement", statements, durationMs: Math.round(performance.now() - started) }
    console.log("ordinary-work-authorization-cost " + JSON.stringify(metrics))
    await test.info().attach("authorization-cost", { body: JSON.stringify(metrics), contentType: "application/json" })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.task.status).toBe("complete")
    statements = 0
    const viewStarted = performance.now()
    const view = await new NamedBoardTaskRepository(db, resolved.scope).view(owner, "household")
    const viewMetrics = { phase: process.env.MEITHEAL_AUTH_COST_PHASE ?? "measurement", operation: "planning-view", statements, durationMs: Math.round(performance.now() - viewStarted) }
    console.log("ordinary-work-authorization-cost " + JSON.stringify(viewMetrics))
    await test.info().attach("planning-view-cost", { body: JSON.stringify(viewMetrics), contentType: "application/json" })
    expect(view).not.toBeNull()
  } finally {
    resetPersistenceForTests()
    if (prior === undefined) delete process.env.MEITHEAL_DB_URL
    else process.env.MEITHEAL_DB_URL = prior
    await rm(directory, { recursive: true, force: true })
  }
})
