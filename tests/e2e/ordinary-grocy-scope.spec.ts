import { randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import {
  ensureSchema,
  getPersistenceClient,
  resetPersistenceForTests
} from "../helpers/persistence-fixture"
import { BoardAccessService } from "../../apps/web/src/domains/tasks/board-access-service"
import {
  registerVerifiedPrincipal,
  type BoardScope,
  type VerifiedPrincipal
} from "../../apps/web/src/domains/tasks/board-scope"
import { NamedBoardRepository } from "../../apps/web/src/domains/tasks/persistence/named-board-repository"
import { HierarchyRepository } from "../../apps/web/src/domains/tasks/persistence/hierarchy-repository"
import { TemplateRepository } from "../../apps/web/src/domains/tasks/persistence/template-repository"
import { TaskRepository } from "../../apps/web/src/domains/tasks/persistence/task-repository"
import { prepareTaskCreation } from "../../apps/web/src/domains/tasks/task-creation-service"
import {
  changeGoalShare,
  listSharedGoals
} from "../../apps/web/src/domains/tasks/persistence/shared-goal-repository"
import {
  createPillar,
  getPillars,
  getPillarById
} from "../../apps/web/src/domains/pillars/pillar-service"
import {
  createPrinciple,
  getAllPrinciples
} from "../../apps/web/src/domains/pillars/principle-service"
import { personalPillarScope } from "../../apps/web/src/domains/pillars/pillar-owner"
import {
  linkEntity,
  getPillarsForEntity,
  setEntityPillar
} from "../../apps/web/src/domains/pillars/pillar-association-service"
import { IdentityRepository } from "../../apps/web/src/domains/tasks/persistence/identity-repository"
import { createGrocyClient } from "../../apps/web/src/lib/grocy-client"
import { GrocyAdapter } from "../../packages/integration-core/src/grocy-adapter"
import {
  startGrocySync,
  stopGrocySync,
  syncFromGrocy,
  getGrocySyncStatus,
  pushCompletionToGrocy,
  pushNewTaskToGrocy
} from "../../apps/web/src/domains/grocy/grocy-bridge"
import { changeBoardGrants } from "../../apps/web/src/domains/tasks/persistence/board-grant-fence"
import { resolveIntegrationScope } from "../../apps/web/src/domains/tasks/board-automation"
let originalFetch: typeof fetch
let provider: {
  chores: Record<string, unknown>[]
  tasks: Record<string, unknown>[]
  shopping: Record<string, unknown>[]
  calls: { method: string; path: string; body: unknown }[]
  gate: Promise<void> | null
  release: (() => void) | null
}
let pending: Promise<unknown>[]
const origin = "http://grocy-scope.example.test"
let directory: string
const previous = process.env.MEITHEAL_DB_URL
const parent = () =>
  registerVerifiedPrincipal(
    { kind: "ha_user", id: "parent" },
    { expiresAt: Date.now() + 60000, administrator: true }
  )
const child = () =>
  registerVerifiedPrincipal(
    { kind: "ha_user", id: "child" },
    { expiresAt: Date.now() + 60000, administrator: false }
  )
async function scope(principal: VerifiedPrincipal, id: string): Promise<BoardScope> {
  const result = await new BoardAccessService(getPersistenceClient()).resolve(principal, id, {
    resource: "task",
    action: "read"
  })
  if (!result.ok) throw new Error(result.errorCode)
  return result.scope
}
async function board(principal: VerifiedPrincipal, name: string) {
  const result = await new NamedBoardRepository(getPersistenceClient()).create(principal, name)
  if (result.status !== "committed") throw new Error("Board fixture failed")
  return result.result.id
}
async function task(work: BoardScope, title: string) {
  const repository = new TaskRepository(getPersistenceClient(), work)
  const parsed = await prepareTaskCreation(
    repository,
    { title, area_id: null },
    { useDefaultAssignee: false }
  )
  if (!parsed.ok) throw new Error(parsed.error)
  const result = await repository.createWorkCommand(parsed.task)
  if (!result.ok) throw new Error(result.errorCode)
  return result.task
}
test.beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "ordinary-planning-"))
  process.env.MEITHEAL_DB_URL = `file:${join(directory, "test.db")}`
  await ensureSchema()
  originalFetch = globalThis.fetch
  pending = []
  provider = {
    chores: [
      {
        chore_id: 1,
        chore_name: "Water plants",
        period_type: "daily",
        next_estimated_execution_time: "2026-11-20 09:00:00",
        is_overdue: 0
      }
    ],
    tasks: [
      {
        id: 9,
        name: "Grocy task",
        description: "Original notes",
        due_date: "2026-11-21",
        done: 0,
        category_id: 7
      }
    ],
    shopping: [{ id: 1, product_id: 1, amount: 2, note: "Oat" }],
    calls: [],
    gate: null,
    release: null
  }
  globalThis.fetch = (async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.origin !== origin) throw new Error("Unexpected fixture provider")
    const method = init?.method ?? "GET",
      body = typeof init?.body === "string" ? JSON.parse(init.body) : null
    provider.calls.push({ method, path: url.pathname, body })
    let data: unknown = []
    if (url.pathname === "/api/objects/products") {
      if (provider.gate) await provider.gate
      data = [{ id: 1, name: "Milk" }]
    } else if (url.pathname === "/api/objects/task_categories")
      data = [{ id: 7, name: "Garden chores" }]
    else if (url.pathname === "/api/chores") data = provider.chores
    else if (url.pathname === "/api/tasks") data = provider.tasks
    else if (url.pathname === "/api/objects/shopping_list") data = provider.shopping
    else if (url.pathname === "/api/objects/tasks" && method === "POST")
      data = { created_object_id: 99 }
    else data = { id: 100 }
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { "content-type": "application/json" }
    })
  }) as typeof fetch
  for (const [key, value] of [
    ["grocy_url", origin],
    ["grocy_api_key", "fixture-key"]
  ])
    await getPersistenceClient().execute({
      sql: "INSERT INTO settings(key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      args: [key!, JSON.stringify(value), Date.now()]
    })
})
test.afterEach(async () => {
  stopGrocySync()
  provider.release?.()
  await Promise.allSettled(pending)
  globalThis.fetch = originalFetch
  resetPersistenceForTests()
  if (previous === undefined) delete process.env.MEITHEAL_DB_URL
  else process.env.MEITHEAL_DB_URL = previous
  await rm(directory, { recursive: true, force: true })
})

const operations = (["read", "create", "edit", "complete", "reopen", "delete"] as const).map(
  (action) => ({ resource: "task" as const, action })
)
async function bind(
  boardId: string,
  areaId?: string,
  projectId?: string,
  allowedOperations = operations
) {
  const db = getPersistenceClient(),
    id = randomUUID(),
    binding = {
      id,
      generation: 1,
      integration: "grocy",
      sourceId: "configured-grocy",
      enabled: true,
      destination: { boardId, ...(areaId ? { areaId } : {}), ...(projectId ? { projectId } : {}) },
      allowedOperations,
      purpose: "grocy.sync"
    }
  await changeBoardGrants(db, async (tx) => {
    const {
      rows: [setting]
    } = await tx.execute("SELECT value FROM settings WHERE key='work-destinations'")
    const config = JSON.parse(String(setting!.value))
    config.bindings.push(binding)
    config.revision = randomUUID()
    await tx.execute({
      sql: "UPDATE settings SET value=? WHERE key='work-destinations'",
      args: [JSON.stringify(config)]
    })
    await tx.execute({
      sql: "INSERT INTO board_access_grants(board_id,principal_type,principal_id,role,authority_limits) VALUES (?,'service',?,'service',?)",
      args: [boardId, id, JSON.stringify({ operations: allowedOperations, purpose: "grocy.sync" })]
    })
    return { next: true }
  })
  return binding
}
async function start(
  binding: Awaited<ReturnType<typeof bind>>,
  mode: "import" | "export" | "bidirectional" = "bidirectional"
) {
  const adapter = await createGrocyClient()
  if (!adapter) throw new Error("Fixture profile unavailable")
  await startGrocySync(
    {
      bindingId: binding.id,
      generation: binding.generation,
      syncEnabled: true,
      syncMode: mode,
      intervalMs: 0
    },
    adapter
  )
  return adapter
}
for (const encoding of ["legacy", "scoped"] as const) {
  test(`${encoding}: Grocy coalesces identical authority and keeps full tasks in its approved placement`, async () => {
    const owner = parent(),
      db = getPersistenceClient(),
      id = encoding === "legacy" ? "household" : await board(owner, "Grocy Work"),
      initial = await scope(owner, id),
      hierarchy = new HierarchyRepository(db, initial),
      areaId = randomUUID(),
      projectId = randomUUID()
    await hierarchy.createArea({ id: areaId, name: "Garden" })
    await hierarchy.createProject({ id: projectId, title: "House work", area_id: areaId })
    const binding = await bind(id, areaId, projectId),
      work = await scope(owner, id),
      repo = new TaskRepository(db, work)
    provider.gate = new Promise<void>((resolve) => {
      provider.release = resolve
    })
    await start(binding)
    await expect
      .poll(() => provider.calls.filter((call) => call.path === "/api/objects/products").length)
      .toBe(1)
    const one = syncFromGrocy(binding.id),
      two = syncFromGrocy(binding.id)
    pending.push(one, two)
    await new Promise<void>((resolve) => setTimeout(resolve, 30))
    provider.release!()
    expect(await one).toMatchObject({ chores: 1, tasks: 1, shopping: 1, errors: 0 })
    expect(await two).toMatchObject({ chores: 1, tasks: 1, shopping: 1, errors: 0 })
    expect(provider.calls.filter((call) => call.path === "/api/objects/products")).toHaveLength(1)
    const items = (await repo.findAll({ limit: 500 })).tasks
    expect(items).toHaveLength(3)
    expect(items.every((item) => item.area_id === areaId && item.project_id === projectId)).toBe(
      true
    )
    expect(items.find((item) => item.title === "Grocy task")?.labels).toContain(
      "category:garden chores"
    )
    expect(items.find((item) => item.title.startsWith("🛒"))?.description).toContain("Milk ×2")
    expect((await getGrocySyncStatus()).itemCount).toBe(null)
    expect((await getGrocySyncStatus(work)).itemCount).toBe(3)
    expect(
      (await new HierarchyRepository(db, work).findAllAreas()).some(
        (area) => area.id === "daily-chores" || area.id === "garden-chores"
      )
    ).toBe(false)
    await syncFromGrocy(binding.id)
    expect((await repo.findAll({ limit: 500 })).tasks).toHaveLength(3)
  })
}

test("a read-only Grocy receiver still intersects actual completion rights", async () => {
  const owner = parent(),
    db = getPersistenceClient(),
    id = await board(owner, "Private Grocy"),
    binding = await bind(id)
  await start(binding)
  pending.push(syncFromGrocy(binding.id))
  await pending[0]
  let work = await scope(owner, id),
    repo = new TaskRepository(db, work)
  const items = (await repo.findAll({ limit: 500 })).tasks,
    item = items.find((item) => item.title === "Grocy task")!,
    shopping = items.find((item) => item.title.startsWith("🛒"))!
  expect(await repo.updateTask(item.id, { status: "complete" })).toMatchObject({ ok: true })
  expect(await repo.updateTask(shopping.id, { status: "complete" })).toMatchObject({ ok: true })
  await changeBoardGrants(db, async (tx) => {
    const {
      rows: [setting]
    } = await tx.execute("SELECT value FROM settings WHERE key='work-destinations'")
    const config = JSON.parse(String(setting!.value)),
      current = config.bindings.find((entry: { id: string }) => entry.id === binding.id)
    current.generation = 2
    current.allowedOperations = [{ resource: "task", action: "read" }]
    config.revision = randomUUID()
    await tx.execute({
      sql: "UPDATE settings SET value=? WHERE key='work-destinations'",
      args: [JSON.stringify(config)]
    })
    await tx.execute({
      sql: "UPDATE board_access_grants SET authority_limits=? WHERE board_id=? AND principal_id=?",
      args: [
        JSON.stringify({ operations: current.allowedOperations, purpose: "grocy.sync" }),
        id,
        binding.id
      ]
    })
    await tx.execute({
      sql: "INSERT INTO board_access_grants(board_id,principal_type,principal_id,role,deny_completion) VALUES (?,'ha_user','child','member',1)",
      args: [id]
    })
    return { next: true }
  })
  binding.generation = 2
  await start(binding, "export")
  work = await scope(owner, id)
  const childWork = await scope(child(), id),
    denied = await resolveIntegrationScope(
      db,
      binding.id,
      2,
      { resource: "task", action: "read" },
      childWork,
      { resource: "task", action: "edit" }
    )
  if (!denied.ok) throw new Error(denied.errorCode)
  const sends = provider.calls.length
  expect(await pushCompletionToGrocy(item.id, denied.value)).toBe(false)
  expect(provider.calls).toHaveLength(sends)
  const permitted = await resolveIntegrationScope(
    db,
    binding.id,
    2,
    { resource: "task", action: "read" },
    work,
    { resource: "task", action: "complete" }
  )
  if (!permitted.ok) throw new Error(permitted.errorCode)
  expect(await pushCompletionToGrocy(item.id, permitted.value)).toBe(true)
  expect(await pushCompletionToGrocy(shopping.id, permitted.value)).toBe(true)
  expect(provider.calls.filter((call) => call.path === "/api/tasks/9/complete")).toHaveLength(1)
  expect(
    provider.calls.filter((call) => call.path === "/api/stock/shoppinglist/clear")
  ).toHaveLength(1)
})

test("Grocy publishes authoritative new task fields through a read-only receiver", async () => {
  provider.chores = []
  provider.tasks = []
  provider.shopping = []
  const owner = parent(),
    db = getPersistenceClient(),
    id = await board(owner, "Receiver"),
    binding = await bind(id, undefined, undefined, [{ resource: "task", action: "read" }])
  await start(binding)
  pending.push(syncFromGrocy(binding.id))
  await pending[0]
  const work = await scope(owner, id),
    item = await task(work, "Actual task"),
    resolved = await resolveIntegrationScope(
      db,
      binding.id,
      1,
      { resource: "task", action: "read" },
      work,
      { resource: "task", action: "create" }
    )
  if (!resolved.ok) throw new Error(resolved.errorCode)
  expect(
    await pushNewTaskToGrocy(resolved.value, item.id, "Forged", {
      description: "Forged description"
    })
  ).toBe(true)
  expect(
    provider.calls.find((call) => call.path === "/api/objects/tasks" && call.method === "POST")
      ?.body
  ).toMatchObject({ name: "Actual task" })
  expect(await pushNewTaskToGrocy(resolved.value, item.id)).toBe(false)
  expect(
    provider.calls.filter((call) => call.path === "/api/objects/tasks" && call.method === "POST")
  ).toHaveLength(1)
})

test("Grocy rejects unproven adapters and profile changes fence a held provider request", async () => {
  const owner = parent(),
    db = getPersistenceClient(),
    id = await board(owner, "Guarded Grocy"),
    binding = await bind(id)
  await expect(
    startGrocySync(
      {
        bindingId: binding.id,
        generation: 1,
        syncEnabled: true,
        syncMode: "import",
        intervalMs: 0
      },
      new GrocyAdapter({ baseUrl: origin, apiKey: "fixture-key" })
    )
  ).rejects.toThrow("Grocy destination is unavailable")
  provider.gate = new Promise<void>((resolve) => {
    provider.release = resolve
  })
  await start(binding)
  await expect
    .poll(() => provider.calls.filter((call) => call.path === "/api/objects/products").length)
    .toBe(1)
  const running = syncFromGrocy(binding.id)
  pending.push(running)
  // This actual write can finish while provider work waits; no SQLite writer is held over HTTP.
  await db.execute({
    sql: "UPDATE settings SET value=? WHERE key='grocy_api_key'",
    args: [JSON.stringify("changed-fixture-key")]
  })
  provider.release!()
  expect(await running).toMatchObject({ errors: 1 })
  expect(provider.calls).toHaveLength(1)
  expect(
    (await new TaskRepository(db, await scope(owner, id)).findAll({ limit: 500 })).tasks
  ).toHaveLength(0)
})

test("Grocy HTTP controls require current Board management and stop only the selected binding", async () => {
  provider.chores = []
  provider.tasks = []
  provider.shopping = []
  const { runWithIngressTransport } = await import("../../apps/web/scripts/ingress-transport.mjs")
  const { verifiedBoardRequestPrincipal } = await import(
    "../../apps/web/src/lib/board-request-context"
  )
  const { boardSessionProof } = await import("../../apps/web/src/lib/named-board-request")
  const { GET, POST } = await import("../../apps/web/src/pages/api/grocy/sync")
  const transport = {
    peer: "127.0.0.1",
    fromSupervisor: false,
    identityHeadersSafe: true,
    configuredPath: undefined
  }
  const principal = await runWithIngressTransport(transport, () =>
    verifiedBoardRequestPrincipal({
      locals: {} as Parameters<typeof verifiedBoardRequestPrincipal>[0]["locals"],
      request: new Request("http://localhost/api/grocy/sync")
    })
  )
  if (!principal) throw new Error("Verified local fixture principal unavailable")
  const boards = new NamedBoardRepository(getPersistenceClient()),
    first = await boards.create(principal, "First"),
    second = await boards.create(principal, "Second")
  if (first.status !== "committed" || second.status !== "committed")
    throw new Error("Board setup failed")
  const a = await bind(first.result.id),
    b = await bind(second.result.id)
  async function request(
    boardId: string,
    method: "GET" | "POST",
    body?: Record<string, unknown>,
    proof = true
  ) {
    const url = new URL(`http://localhost/api/grocy/sync?board_id=${boardId}`)
    const req = new Request(url, {
      method,
      ...(method === "POST"
        ? {
            headers: {
              "content-type": "application/json",
              ...(proof ? { "x-meitheal-board-session": boardSessionProof(principal!.id) } : {})
            },
            body: JSON.stringify(body)
          }
        : {})
    })
    const context = { request: req, url, params: {}, locals: {} } as Parameters<typeof POST>[0]
    return runWithIngressTransport(transport, () =>
      method === "POST" ? POST(context) : GET(context)
    )
  }
  expect(
    (
      await request(first.result.id, "POST", {
        action: "enable",
        binding_id: a.id,
        generation: 1,
        interval_ms: 0
      })
    ).status
  ).toBe(200)
  expect(
    (
      await request(second.result.id, "POST", {
        action: "enable",
        binding_id: b.id,
        generation: 1,
        interval_ms: 0
      })
    ).status
  ).toBe(200)
  expect(
    (await request(first.result.id, "POST", { action: "disable", binding_id: b.id, generation: 1 }))
      .status
  ).toBe(404)
  expect(
    (
      await request(
        first.result.id,
        "POST",
        { action: "disable", binding_id: a.id, generation: 1 },
        false
      )
    ).status
  ).toBe(403)
  expect(
    (await request(first.result.id, "POST", { action: "disable", binding_id: a.id, generation: 1 }))
      .status
  ).toBe(200)
  const remaining = await (await request(second.result.id, "GET")).json()
  expect(remaining.sync).toMatchObject({ active: true, entities: [{ bindingId: b.id }] })
  pending.push(syncFromGrocy(b.id))
  await pending.at(-1)
})
