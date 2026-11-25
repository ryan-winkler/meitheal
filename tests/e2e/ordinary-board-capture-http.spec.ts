import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import { runWithIngressTransport } from "../../apps/web/scripts/ingress-transport.mjs"
import { ensureSchema, getPersistenceClient, resetPersistenceForTests } from "../helpers/persistence-fixture"
import { verifiedBoardRequestPrincipal } from "../../apps/web/src/lib/board-request-context"
import { boardSessionProof } from "../../apps/web/src/lib/named-board-request"
import { NamedBoardRepository } from "../../apps/web/src/domains/tasks/persistence/named-board-repository"
import { generateAgentToken } from "../../packages/domain-auth/src/index"
import { ensureAgentTokenSchema } from "../../apps/web/src/domains/auth"
import { createAgentToken } from "../../apps/web/src/domains/auth/agent-token-store"
import { BoardAccessService, IdentityRepository } from "../../apps/web/src/domains/tasks"
import { resolveAgentAuth } from "../../apps/web/src/lib/agent-token-guard"
import { POST as createArea } from "../../apps/web/src/pages/api/areas/index"
import { POST as createProject } from "../../apps/web/src/pages/api/projects/index"
import { POST as createGoal } from "../../apps/web/src/pages/api/goals/index"
import { POST as manageRoutine, GET as listRoutines } from "../../apps/web/src/pages/api/habits"
import { POST as BOARD_POST, GET as BOARD_GET } from "../../apps/web/src/pages/api/boards/[id]/tickets/index"
import { PUT as updateTask, DELETE as deleteTask } from "../../apps/web/src/pages/api/tasks/[id]"
import { POST, GET } from "../../apps/web/src/pages/api/tasks/index"

type APIContext = Parameters<typeof POST>[0]

let directory: string
let previousUrl: string | undefined
let session: string
let board: string
const attempt = "114c2022-56c1-4b93-b318-b4420381097d"
const transport = { peer: "127.0.0.1", fromSupervisor: false, identityHeadersSafe: true, configuredPath: undefined }

function context(method: string, boardId: string, headers: Record<string, string> = {}, body?: unknown, query = ""): APIContext {
  const request = new Request(`http://127.0.0.1/api/tasks${query}`, {
    method, headers: { "Content-Type": "application/json", "X-Meitheal-Board-Id": boardId,
      "X-Meitheal-Board-Session": session, ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { request, url: new URL(request.url), params: {}, locals: {} } as APIContext
}

test.beforeEach(async () => {
  previousUrl = process.env.MEITHEAL_DB_URL
  directory = await mkdtemp(join(tmpdir(), "meitheal-capture-http-"))
  process.env.MEITHEAL_DB_URL = `file:${join(directory, "work.db")}`
  await ensureSchema()
  await runWithIngressTransport(transport, async () => {
    const request = new Request("http://127.0.0.1/boards")
    const principal = await verifiedBoardRequestPrincipal({ request, locals: {} as App.Locals })
    expect(principal?.kind).toBe("local_operator")
    if (!principal) throw new Error("Local operator fixture was not admitted")
    session = boardSessionProof(principal.id)
    const created = await new NamedBoardRepository(getPersistenceClient()).create(principal, "Work")
    if (created.status !== "committed") throw new Error("Work Board fixture was not committed")
    board = created.result.id
  })
})

test.afterEach(async () => {
  resetPersistenceForTests()
  if (previousUrl === undefined) delete process.env.MEITHEAL_DB_URL
  else process.env.MEITHEAL_DB_URL = previousUrl
  await rm(directory, { recursive: true, force: true })
})

for (const malformed of ["", "not-a-uuid"]) {
  test(`explicit malformed capture header writes no task: ${JSON.stringify(malformed)}`, async () => {
    const response = await runWithIngressTransport(transport, () => POST(context("POST", board,
      { "X-Meitheal-Capture-Attempt": malformed }, { title: "Must not be written" })))
    expect(response.status).toBe(400)
    expect(Number((await getPersistenceClient().execute("SELECT COUNT(*) AS count FROM tasks")).rows[0]?.count)).toBe(0)
  })
}

test("omitted capture header retains ordinary rich creation", async () => {
  const response = await runWithIngressTransport(transport, () => POST(context("POST", board, {}, {
    title: "Groceries", task_kind: "shopping_item", custom_fields: JSON.stringify({ items: [{ name: "Milk", qty: 2 }] }),
  })))
  expect(response.status, await response.clone().text()).toBe(201)
  expect(await response.json()).toMatchObject({ title: "Groceries", task_kind: "shopping_item", board_id: board })
})

test("same attempt on two explicit Boards creates independent tasks and private receipts", async () => {
  const ids: string[] = []
  for (const boardId of ["household", board]) {
    const created = await runWithIngressTransport(transport, () => POST(context("POST", boardId,
      { "X-Meitheal-Capture-Attempt": attempt }, { title: "Independent capture", task_kind: "checklist", checklists: "[]" })))
    expect(created.status, await created.clone().text()).toBe(201)
    const payload = await created.json()
    ids.push(payload.id)
    for (const privateField of ["capture_attempt_digest", "operation_owner", "operation_digest", "storage_encoding"]) {
      expect(Object.hasOwn(payload, privateField)).toBe(false)
    }
    const repeated = await runWithIngressTransport(transport, () => POST(context("POST", boardId,
      { "X-Meitheal-Capture-Attempt": attempt }, { title: "Changed text cannot overwrite the attempt" })))
    expect(repeated.status).toBe(409)
    const receipt = await runWithIngressTransport(transport, () => GET(context("GET", boardId,
      { "X-Meitheal-Capture-Attempt": attempt }, undefined, "?captureReceipt=1")))
    expect(receipt.status).toBe(200)
    expect(receipt.headers.get("cache-control")).toContain("no-store")
    expect(await receipt.json()).toEqual({ id: payload.id, ticket_key: payload.ticket_key, task_kind: "checklist" })
  }
  expect(new Set(ids).size).toBe(2)
})

test("conflicting selectors and mixed private/public retry protocols write nothing", async () => {
  const mismatch = await runWithIngressTransport(transport, () => POST(context("POST", board,
    { "X-Meitheal-Capture-Attempt": attempt }, { title: "Denied selector" }, "?board_id=household")))
  expect(mismatch.status).toBe(404)
  const mixed = await runWithIngressTransport(transport, () => POST(context("POST", board,
    { "X-Meitheal-Capture-Attempt": attempt, "Idempotency-Key": "generic-key" }, { title: "Denied protocol" })))
  expect(mixed.status).toBe(400)
  expect(Number((await getPersistenceClient().execute("SELECT COUNT(*) AS count FROM tasks")).rows[0]?.count)).toBe(0)
})

function boardAlias(method: string, body?: unknown, headers: Record<string, string> = {}, query = ""): APIContext {
  const original = context(method, board, headers, body, query)
  const url = new URL(`http://127.0.0.1/api/boards/${board}/tickets${query}`)
  return { ...original, url, params: { id: board }, request: new Request(url, original.request) } as APIContext
}

test("Board tickets alias uses rich creation and the same private receipt writer", async () => {
  const created = await runWithIngressTransport(transport, () => BOARD_POST(boardAlias("POST", {
    title: "Shared rich transport", task_kind: "shopping_item", custom_fields: JSON.stringify({ items: [{ name: "Eggs", qty: 3 }] }),
  }, { "X-Meitheal-Capture-Attempt": attempt })))
  expect(created.status, await created.clone().text()).toBe(201)
  const task = await created.json()
  expect(task).toMatchObject({ board_id: board, task_kind: "shopping_item" })
  const receipt = await runWithIngressTransport(transport, () => GET(context("GET", board,
    { "X-Meitheal-Capture-Attempt": attempt }, undefined, "?captureReceipt=1")))
  expect(receipt.status).toBe(200)
  expect(receipt.headers.get("cache-control")).toBe("private, no-store")
  expect(await receipt.json()).toEqual({ id: task.id, ticket_key: task.ticket_key, task_kind: "shopping_item" })
  const same = await runWithIngressTransport(transport, () => BOARD_GET(boardAlias("GET", undefined,
    { "X-Meitheal-Capture-Attempt": attempt }, "?captureReceipt=1")))
  expect(same.status).toBe(400)
  expect(same.headers.get("cache-control")).toBe("private, no-store")
  expect(Number((await getPersistenceClient().execute("SELECT COUNT(*) AS count FROM tasks")).rows[0]?.count)).toBe(1)
})

test("Board ticket alias rejects receipt selectors, empty attempts, mismatched path and stale browser proof", async () => {
  const lookup = await runWithIngressTransport(transport, () => BOARD_POST(boardAlias("POST",
    { title: "Denied receipt selector" }, { "X-Meitheal-Capture-Attempt": attempt }, "?captureReceipt=1")))
  expect(lookup.status).toBe(400)
  expect(lookup.headers.get("cache-control")).toBe("private, no-store")
  const malformed = await runWithIngressTransport(transport, () => BOARD_POST(boardAlias("POST", { title: "Not written" }, { "X-Meitheal-Capture-Attempt": "" })))
  expect(malformed.status).toBe(400)
  const mismatchContext = boardAlias("POST", { title: "Not written" })
  mismatchContext.params.id = "household"
  const mismatch = await runWithIngressTransport(transport, () => BOARD_POST(mismatchContext))
  expect(mismatch.status).toBe(404)
  const stale = await runWithIngressTransport(transport, () => BOARD_POST(boardAlias("POST", { title: "Not written" }, { "X-Meitheal-Board-Session": "wrong-session" })))
  expect(stale.status).toBe(403)
  expect(Number((await getPersistenceClient().execute("SELECT COUNT(*) AS count FROM tasks")).rows[0]?.count)).toBe(0)
})

function resource(path: string, method: string, body?: unknown, boardId = board, query = ""): APIContext {
  const original = context(method, boardId, {}, body)
  const url = new URL(`http://127.0.0.1/api/${path}${query}`)
  return { ...original, url, request: new Request(url, original.request) } as APIContext
}

test("Area and Project routines create one common task occurrence and stay on their Board", async () => {
  await runWithIngressTransport(transport, async () => {
    const areaResponse = await createArea(resource("areas", "POST", { name: "Garden" }))
    expect(areaResponse.status, await areaResponse.clone().text()).toBe(201)
    const area = await areaResponse.json()
    const projectResponse = await createProject(resource("projects", "POST", { title: "Spring planting", area_id: area.id }))
    expect(projectResponse.status, await projectResponse.clone().text()).toBe(201)
    const project = await projectResponse.json()
    const goalResponse = await createGoal(resource("goals", "POST", { title: "Grow vegetables", area_id: area.id, project_id: project.id }))
    expect(goalResponse.status, await goalResponse.clone().text()).toBe(201)
    const goal = await goalResponse.json()
    const routineResponse = await manageRoutine(resource("habits", "POST", { action: "create", name: "Water plants", area_id: area.id, project_id: project.id }))
    expect(routineResponse.status, await routineResponse.clone().text()).toBe(201)
    const routine = await routineResponse.json()
    const own = await listRoutines(resource("habits", "GET", undefined, board, `?project_id=${project.id}&area_id=${area.id}`))
    expect(own.status, await own.clone().text()).toBe(200)
    expect((await own.json()).habits.map((item: any) => item.id)).toEqual([routine.id])
    const foreign = await listRoutines(resource("habits", "GET", undefined, "household", `?project_id=${project.id}`))
    expect(foreign.status).toBe(404)
    const first = await manageRoutine(resource("habits", "POST", { action: "complete", templateId: routine.id }))
    expect(first.status, await first.clone().text()).toBe(200)
    const occurrence = await first.json()
    expect(occurrence.completed).toBe(true)
    const again = await manageRoutine(resource("habits", "POST", { action: "complete", templateId: routine.id }))
    expect(again.status, await again.clone().text()).toBe(200)
    expect(await again.json()).toMatchObject({ taskId: occurrence.taskId, alreadyExisted: true, completed: true })
    const tasks = await GET(context("GET", board, {}, undefined, `?project_id=${project.id}`))
    const listed = (await tasks.json()).tasks
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({ id: occurrence.taskId, board_id: board, area_id: area.id, project_id: project.id, task_kind: "routine_instance", status: "complete" })
    expect(String(listed[0].ticket_key)).not.toMatch(/^MTH-/)
    const linked = await getPersistenceClient().execute({ sql: "SELECT goal_id FROM projects WHERE id=?", args: [project.id] })
    expect(linked.rows[0]?.goal_id).toBe(goal.id)
  })
})

test("Board completion and deletion ceilings survive canonical and routine HTTP adapters", async () => {
  await runWithIngressTransport(transport, async () => {
    const created = await POST(context("POST", board, {}, { title: "Still pending" }))
    expect(created.status).toBe(201)
    const task = await created.json()
    const routineCreated = await manageRoutine(resource("habits", "POST", { action: "create", name: "Restricted Routine" }))
    expect(routineCreated.status, await routineCreated.clone().text()).toBe(201)
    const routine = await routineCreated.json()
    const principal = await verifiedBoardRequestPrincipal({ request: new Request("http://127.0.0.1/boards"), locals: {} as App.Locals })
    if (!principal) throw new Error("Verified local operator missing")
    const restriction = await new NamedBoardRepository(getPersistenceClient()).updateRestrictions(principal, board, { denyCompletion: true, denyDeletion: true, denyAgentDeletion: true })
    expect(restriction.status).toBe("committed")
    const completion = resource(`tasks/${task.id}`, "PUT", { status: "complete" })
    completion.params.id = task.id
    const denied = await updateTask(completion)
    expect(denied.status, await denied.clone().text()).toBe(403)
    const routineCheckin = await manageRoutine(resource("habits", "POST", { action: "complete", templateId: routine.id }))
    expect(routineCheckin.status, await routineCheckin.clone().text()).toBe(403)
    const deletion = resource(`tasks/${task.id}`, "DELETE")
    deletion.params.id = task.id
    expect((await deleteTask(deletion)).status).toBe(403)
    const rows = await getPersistenceClient().execute("SELECT id,status,source_template_id FROM tasks ORDER BY ticket_number")
    expect(rows.rows).toEqual([
      { id: task.id, status: "pending", source_template_id: null },
      { id: routine.taskId, status: "pending", source_template_id: routine.id },
    ])
  })
})

test("assigned-only credential gets its exact handoff receipt after losing assignment without gaining reads", async () => {
  await runWithIngressTransport(transport, async () => {
    const db = getPersistenceClient()
    const owner = await verifiedBoardRequestPrincipal({ request: new Request("http://127.0.0.1/boards"), locals: {} as App.Locals })
    if (!owner) throw new Error("Actual admitted operator required")
    await new IdentityRepository(db).createCustomUser("custom_capture_agent", "Capture agent", "#6366f1", "agent")
    const manager = await new BoardAccessService(db).resolve(owner, board, { resource: "board", action: "manage" })
    if (!manager.ok) throw new Error(manager.errorCode)
    await ensureAgentTokenSchema()
    const credential = generateAgentToken()
    await createAgentToken({ id: crypto.randomUUID(), name: "Assigned-only fixture", tokenHash: credential.tokenHash, tokenPrefix: credential.tokenPrefix,
      scopes: ["tasks:write:assigned"], assigneeId: "custom_capture_agent" }, manager.scope)
    const created = await POST(context("POST", board, {}, { title: "Private details stay private", assigned_to: "custom_capture_agent" }))
    expect(created.status, await created.clone().text()).toBe(201)
    const task = await created.json()
    expect(task.assigned_to).toBe("custom_capture_agent")
    const handoff = { assigned_to: null, updated_at: task.updated_at, request_id: crypto.randomUUID() }
    async function agentContext(method: string, body?: unknown): Promise<APIContext> {
      const selected = resource(`tasks/${task.id}`, method, body)
      selected.params.id = task.id
      const headers = new Headers(selected.request.headers)
      headers.set("Authorization", `Bearer ${credential.token}`)
      selected.request = new Request(selected.request, { headers })
      const agent = await resolveAgentAuth(selected.request)
      if (!agent) throw new Error("Actual credential resolution required")
      expect(agent.assigneeId).toBe("custom_capture_agent")
      selected.locals.agentToken = agent
      return selected
    }
    const first = await updateTask(await agentContext("PUT", handoff))
    expect(first.status, await first.clone().text()).toBe(200)
    expect(Object.hasOwn(await first.json(), "title")).toBe(false)
    const replay = await updateTask(await agentContext("PUT", handoff))
    expect(replay.status, await replay.clone().text()).toBe(200)
    expect(await replay.json()).toEqual({ id: task.id, ticket_key: task.ticket_key, assigned_to: null })
    const wrongShape = await updateTask(await agentContext("PUT", { ...handoff, title: "Must not gain edit authority" }))
    expect(wrongShape.status).toBe(404)
    const read = await GET(await agentContext("GET"))
    expect(read.status).toBe(403)
  })
})


test("keyed Board alias requires the caller original explicit header while ordinary alias remains supported", async () => {
  const keyed = boardAlias("POST", { title: "Do not infer frozen Board" }, { "X-Meitheal-Capture-Attempt": attempt })
  const headers = new Headers(keyed.request.headers)
  headers.delete("X-Meitheal-Board-Id")
  keyed.request = new Request(keyed.request, { headers })
  const rejected = await runWithIngressTransport(transport, () => BOARD_POST(keyed))
  expect(rejected.status).toBe(400)
  const ordinary = boardAlias("POST", { title: "Normal path-selected compatibility" })
  const ordinaryHeaders = new Headers(ordinary.request.headers)
  ordinaryHeaders.delete("X-Meitheal-Board-Id")
  ordinary.request = new Request(ordinary.request, { headers: ordinaryHeaders })
  const accepted = await runWithIngressTransport(transport, () => BOARD_POST(ordinary))
  expect(accepted.status, await accepted.clone().text()).toBe(201)
})
