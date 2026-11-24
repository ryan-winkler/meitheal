import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import { ensureSchema, getPersistenceClient, resetPersistenceForTests } from "../helpers/persistence-fixture"
import { currentBoardScope, fixturePrincipal } from "../helpers/current-board-scope"
import { NamedBoardRepository } from "../../apps/web/src/domains/tasks/persistence/named-board-repository"
import { NamedBoardTaskRepository } from "../../apps/web/src/domains/tasks/persistence/named-board-task-repository"
import { HierarchyRepository } from "../../apps/web/src/domains/tasks/persistence/hierarchy-repository"
import { TemplateRepository, routinePeriod } from "../../apps/web/src/domains/tasks/persistence/template-repository"
import { TaskRepository } from "../../apps/web/src/domains/tasks/persistence/task-repository"
import { prepareTaskCreation } from "../../apps/web/src/domains/tasks/task-creation-service"
import { runWithIngressTransport } from "../../apps/web/scripts/ingress-transport.mjs"
import { verifiedBoardRequestPrincipal } from "../../apps/web/src/lib/board-request-context"
import { boardSessionProof } from "../../apps/web/src/lib/named-board-request"
import { GET as routines } from "../../apps/web/src/pages/api/boards/routines"
import { POST as habits } from "../../apps/web/src/pages/api/habits"
import { PUT as updateTask } from "../../apps/web/src/pages/api/tasks/[id]"
import { getTasksForView } from "../../apps/web/src/lib/task-queries"
import { changeBoardGrants } from "../../apps/web/src/domains/tasks/persistence/board-grant-fence"

let directory: string, previousUrl: string | undefined
const transport = { peer: "127.0.0.1", fromSupervisor: false, identityHeadersSafe: true, configuredPath: undefined }
function gate() { let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve }); return { wait, release } }
test.beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "meitheal-r52-common-")); previousUrl = process.env.MEITHEAL_DB_URL
  process.env.MEITHEAL_DB_URL = `file:${join(directory, "work.db")}`; await ensureSchema()
})
test.afterEach(async () => {
  resetPersistenceForTests()
  if (previousUrl === undefined) delete process.env.MEITHEAL_DB_URL; else process.env.MEITHEAL_DB_URL = previousUrl
  await rm(directory, { recursive: true, force: true })
})
async function board(encoding: "legacy" | "scoped", owner = fixturePrincipal()) {
  const created = await new NamedBoardRepository(getPersistenceClient()).create(owner, "Workshop")
  if (created.status !== "committed") throw new Error("Board creation failed")
  return encoding === "legacy" ? "household" : created.result.id
}
async function add(repo: TaskRepository, body: Record<string, unknown>) {
  const prepared = await prepareTaskCreation(repo, body, { useDefaultAssignee: false })
  if (!prepared.ok) throw new Error(prepared.error)
  const result = await repo.createWorkCommand(prepared.task)
  if (!result.ok) throw new Error(result.errorCode)
  return result.task
}
function context(boardId: string, userId: string, path: string, body?: unknown, id?: string) {
  const url = new URL(`http://localhost${path}`)
  return { url, params: id ? { id } : {}, locals: {}, request: new Request(url, { ...(body === undefined ? {} : { method: id ? "PUT" : "POST", body: JSON.stringify(body) }), headers: {
    "Content-Type": "application/json", "X-Meitheal-Board-Id": boardId, "X-Meitheal-Board-Session": boardSessionProof(userId),
  } }) } as unknown as Parameters<typeof routines>[0]
}
import { POST as reorder } from "../../apps/web/src/pages/api/tasks/reorder"
import { generateAgentToken } from "../../packages/domain-auth/src/index"
import { ensureAgentTokenSchema, createAgentToken } from "../../apps/web/src/domains/auth/agent-token-store"
import { resolveAgentAuth } from "../../apps/web/src/lib/agent-token-guard"

for (const encoding of ["legacy", "scoped"] as const) test(`anchor reorder HTTP supports overlapping Area custom lanes and rejects foreign or forbidden moves: ${encoding}`, async () => {
  await runWithIngressTransport(transport, async () => {
    const owner = await verifiedBoardRequestPrincipal({ request: new Request("http://localhost/boards"), locals: {} as App.Locals })
    if (!owner) throw new Error("Operator required")
    const db = getPersistenceClient(), boardId = await board(encoding, owner), hierarchy = new HierarchyRepository(db, await currentBoardScope(db, boardId, owner)), repo = new TaskRepository(db, await currentBoardScope(db, boardId, owner))
    const a = crypto.randomUUID(), b = crypto.randomUUID()
    await hierarchy.createArea({ id: a, name: "Kitchen" }); await hierarchy.createArea({ id: b, name: "Garden" })
    const first = await add(repo, { title: "First", area_id: a, status: "pending" }), second = await add(repo, { title: "Second", area_id: b, status: "pending" })
    await db.execute({ sql: "INSERT INTO kanban_lanes(id,key,label,board_id,position,includes,created_at,updated_at) VALUES(?,?,?,?,?,?,1,1)", args: [crypto.randomUUID(), "review", "Review", boardId, 8, '["pending","active"]'] })
    const selected = (anchorId: string) => context(boardId, owner.id, "/api/tasks/reorder", { task_id: second.id, anchor_id: anchorId, lane: "review", before: true })
    const moved = await reorder(selected(first.id))
    expect(moved.status, await moved.clone().text()).toBe(200); expect(await moved.json()).toEqual({ ok: true })
    const foreignBoard = await board("scoped", owner), foreignRepo = new TaskRepository(db, await currentBoardScope(db, foreignBoard, owner)), foreign = await add(foreignRepo, { title: "Foreign", status: "pending" })
    const snapshot = async () => (await db.execute("SELECT id,kanban_position,updated_at FROM tasks ORDER BY id")).rows
    const before = await snapshot(), conflict = await reorder(selected(foreign.id))
    expect(conflict.status).toBe(409); expect(await conflict.json()).toMatchObject({ errorCode: "TASK_ORDER_CONFLICT" })
    expect(await snapshot()).toEqual(before)
    await ensureAgentTokenSchema()
    const credential = generateAgentToken()
    await createAgentToken({ id: crypto.randomUUID(), name: "Read-only", tokenHash: credential.tokenHash, tokenPrefix: credential.tokenPrefix, scopes: ["tasks:read"] }, await currentBoardScope(db, boardId, owner))
    const readOnly = selected(first.id), headers = new Headers(readOnly.request.headers)
    headers.set("Authorization", `Bearer ${credential.token}`); readOnly.request = new Request(readOnly.request, { headers })
    readOnly.locals.agentToken = (await resolveAgentAuth(readOnly.request))!
    const deniedBefore = await snapshot(), denied = await reorder(readOnly)
    expect(denied.status).toBe(403); expect(await snapshot()).toEqual(deniedBefore)
  })
})
