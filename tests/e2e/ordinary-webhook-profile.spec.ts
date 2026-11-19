import { NamedBoardRepository } from "../../apps/web/src/domains/tasks/persistence/named-board-repository"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { once } from "node:events"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { expect, test } from "@playwright/test"
import { ensureSchema, getPersistenceClient, resetPersistenceForTests } from "../helpers/persistence-fixture"
import { BoardAccessService, TaskRepository, readWorkDestinations, saveWorkBinding, saveWorkIntegrationSettings } from "../../apps/web/src/domains/tasks"
import { registerVerifiedPrincipal } from "../../apps/web/src/domains/tasks/board-scope"
import { prepareTaskCreation } from "../../apps/web/src/domains/tasks/task-creation-service"
import { dispatchTaskEvent } from "../../apps/web/src/lib/webhook-dispatcher"

for (const retry of [false, true]) test(`a replaced webhook receives no later work or retry: retry=${retry}`, async () => {
  const directory = await mkdtemp(join(tmpdir(), "ordinary-webhook-profile-"))
  const savedEnv = { url: process.env.MEITHEAL_DB_URL, mode: process.env.NODE_ENV, supervisor: process.env.SUPERVISOR_TOKEN }
  let oldRequests = 0, newRequests = 0
  const oldServer = createServer((_request, response) => { oldRequests++; response.writeHead(retry ? 503 : 204).end() })
  const newServer = createServer((_request, response) => { newRequests++; response.writeHead(204).end() })
  oldServer.listen(0, "127.0.0.1"); newServer.listen(0, "127.0.0.1")
  await Promise.all([once(oldServer, "listening"), once(newServer, "listening")])
  const owner = () => registerVerifiedPrincipal({ kind: "ha_user", id: "owner" }, { administrator: true, expiresAt: Date.now() + 60_000 })
  try {
    process.env.MEITHEAL_DB_URL = `file:${join(directory, "work.db")}`
    process.env.NODE_ENV = "development"
    delete process.env.SUPERVISOR_TOKEN
    await ensureSchema()
    const db = getPersistenceClient()
    const created = await new NamedBoardRepository(db).create(owner(), "Work")
    if (created.status !== "committed") throw new Error("Expected current Work Board")
    const boardId = created.result.id
    expect(await saveWorkIntegrationSettings(db, owner(), [{ key: "webhook_endpoint", value: JSON.stringify(`http://127.0.0.1:${(oldServer.address() as AddressInfo).port}/`) }])).toBe(true)
    const configuration = await readWorkDestinations(db)
    if (!configuration) throw new Error("Expected integration configuration")
    const binding = await saveWorkBinding(db, owner(), configuration.revision, { id: crypto.randomUUID(), generation: 1, integration: "webhook", sourceId: "generic-webhook", purpose: "webhook.delivery", enabled: true, destination: { boardId }, allowedOperations: [{ resource: "task", action: "read" }] })
    if (!binding.ok) throw new Error("Expected approved webhook")
    const scope = async () => {
      const result = await new BoardAccessService(db).resolve(owner(), boardId, { resource: "task", action: "create" })
      if (!result.ok) throw new Error(result.errorCode)
      return result.scope
    }
    const initialScope = await scope()
    const repo = new TaskRepository(db, initialScope)
    const prepared = await prepareTaskCreation(repo, { title: "Private Work" }, { useDefaultAssignee: false })
    if (!prepared.ok) throw new Error(prepared.error)
    const task = await repo.createWorkCommand(prepared.task)
    if (!task.ok) throw new Error(task.errorCode)
    await dispatchTaskEvent("task.created", task.task, "first", undefined, undefined, undefined, initialScope)
    await expect.poll(() => oldRequests).toBe(1)
    expect(await saveWorkIntegrationSettings(db, owner(), [{ key: "webhook_endpoint", value: JSON.stringify(`http://127.0.0.1:${(newServer.address() as AddressInfo).port}/`) }])).toBe(true)
    const currentScope = await scope()
    await dispatchTaskEvent("task.updated", task.task, "second", undefined, undefined, undefined, currentScope)
    await expect.poll(() => newRequests).toBe(1)
    // A retry waits one second. The old queued authority must fail after replacement.
    if (retry) await new Promise(resolve => setTimeout(resolve, 1250))
    expect(oldRequests).toBe(1)
  } finally {
    resetPersistenceForTests()
    for (const [key, value] of [["MEITHEAL_DB_URL", savedEnv.url], ["NODE_ENV", savedEnv.mode], ["SUPERVISOR_TOKEN", savedEnv.supervisor]] as const) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    oldServer.closeAllConnections(); newServer.closeAllConnections()
    await Promise.all([new Promise<void>(resolve => oldServer.close(() => resolve())), new Promise<void>(resolve => newServer.close(() => resolve()))])
    await rm(directory, { recursive: true, force: true })
  }
})
