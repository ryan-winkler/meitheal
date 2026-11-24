import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import { ensureSchema, getPersistenceClient, resetPersistenceForTests } from "../helpers/persistence-fixture"
import { currentBoardScope } from "../helpers/current-board-scope"
import { NamedBoardRepository } from "../../apps/web/src/domains/tasks/persistence/named-board-repository"
import { HierarchyRepository } from "../../apps/web/src/domains/tasks/persistence/hierarchy-repository"
import { IdentityRepository } from "../../apps/web/src/domains/tasks/persistence/identity-repository"
import { TaskRepository } from "../../apps/web/src/domains/tasks/persistence/task-repository"
import { prepareTaskCreation } from "../../apps/web/src/domains/tasks/task-creation-service"
import { runWithIngressTransport } from "../../apps/web/scripts/ingress-transport.mjs"
import { verifiedBoardRequestPrincipal } from "../../apps/web/src/lib/board-request-context"
import { boardSessionProof } from "../../apps/web/src/lib/named-board-request"
import { POST as completeNfc } from "../../apps/web/src/pages/api/nfc/complete"
import { GET as readTask, PUT as updateTask } from "../../apps/web/src/pages/api/tasks/[id]"
import { generateAgentToken, type AgentScope } from "../../packages/domain-auth/src/index"
import { ensureAgentTokenSchema, createAgentToken } from "../../apps/web/src/domains/auth/agent-token-store"
import { resolveAgentAuth } from "../../apps/web/src/lib/agent-token-guard"
import { changeBoardGrants } from "../../apps/web/src/domains/tasks/persistence/board-grant-fence"
import { loadKanbanBoard } from "../../apps/web/src/lib/kanban-board-data"

let directory: string, previousUrl: string | undefined
const transport = { peer: "127.0.0.1", fromSupervisor: false, identityHeadersSafe: true, configuredPath: undefined }
test.beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "meitheal-r52-nfc-")); previousUrl = process.env.MEITHEAL_DB_URL
  process.env.MEITHEAL_DB_URL = `file:${join(directory, "work.db")}`; await ensureSchema()
})
test.afterEach(async () => {
  resetPersistenceForTests()
  if (previousUrl === undefined) delete process.env.MEITHEAL_DB_URL; else process.env.MEITHEAL_DB_URL = previousUrl
  await rm(directory, { recursive: true, force: true })
})
async function add(repo: TaskRepository, title: string, tag: string, assigned_to?: string, project_id?: string) {
  const prepared = await prepareTaskCreation(repo, { title, assigned_to, project_id }, { useDefaultAssignee: false })
  if (!prepared.ok) throw new Error(prepared.error)
  const result = await repo.createWorkCommand(prepared.task)
  if (!result.ok) throw new Error(result.errorCode)
  expect((await repo.updateTask(result.task.id, { nfc_tag_id: tag })).ok).toBe(true)
  return result.task.id
}
for (const encoding of ["legacy", "scoped"] as const) {
  test(`NFC completion-only metadata stays opaque and respects current assignment, duplicate and completion ceilings: ${encoding}`, async () => {
    await runWithIngressTransport(transport, async () => {
      const owner = await verifiedBoardRequestPrincipal({ request: new Request("http://localhost/boards"), locals: {} as App.Locals })
      if (!owner) throw new Error("Operator required")
      const db = getPersistenceClient(), boards = new NamedBoardRepository(db), created = await boards.create(owner, "NFC Work")
      if (created.status !== "committed") throw new Error("Board required")
      const board = encoding === "legacy" ? "household" : created.result.id
      await new IdentityRepository(db).createCustomUser("custom_nfc_agent", "NFC Agent", "#146C4E", "agent")
      let repo = new TaskRepository(db, await currentBoardScope(db, board, owner))
      const target = await add(repo, "Private NFC title", "target"), readable = await add(repo, "Readable NFC", "readable"), assigned = await add(repo, "Assigned private", "assigned", "custom_nfc_agent"), notAssigned = await add(repo, "Not assigned", "other")
      const foreign = await boards.create(owner, "Other NFC Board")
      if (foreign.status !== "committed") throw new Error("Board required")
      await add(new TaskRepository(db, await currentBoardScope(db, foreign.result.id, owner)), "Foreign title", "foreign")
      await ensureAgentTokenSchema()
      const mint = async (scopes: AgentScope[], assigneeId?: string) => {
        const credential = generateAgentToken()
        await createAgentToken({ id: crypto.randomUUID(), name: "NFC credential", tokenHash: credential.tokenHash, tokenPrefix: credential.tokenPrefix, scopes, ...(assigneeId ? { assigneeId } : {}) }, await currentBoardScope(db, board, owner))
        return credential.token
      }
      const writer = await mint(["tasks:write"]), reader = await mint(["tasks:read"]), both = await mint(["tasks:write", "tasks:read"]), assignedOnly = await mint(["tasks:write:assigned"], "custom_nfc_agent")
      const context = async (token: string, tag?: string, taskId?: string) => {
        const url = new URL(taskId ? `http://localhost/api/tasks/${taskId}` : "http://localhost/api/nfc/complete")
        const request = new Request(url, { method: taskId ? "GET" : "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, "X-Meitheal-Board-Id": board, "X-Meitheal-Board-Session": boardSessionProof(owner.id) }, ...(taskId ? {} : { body: JSON.stringify({ tag_id: tag }) }) })
        const agentToken = await resolveAgentAuth(request)
        if (!agentToken) throw new Error("Real credential required")
        return { url, request, params: taskId ? { id: taskId } : {}, locals: { agentToken } } as Parameters<typeof completeNfc>[0]
      }
      const scan = async (token: string, tag: string) => completeNfc(await context(token, tag))
      expect((await scan(reader, "target")).status).toBe(403)
      for (const tag of ["unknown", "foreign"]) expect((await scan(writer, tag)).status).toBe(404)
      const first = await scan(writer, "target")
      expect(first.status, await first.clone().text()).toBe(200); expect(await first.json()).toEqual({ ok: true })
      const activity = (await db.execute("SELECT COUNT(*) AS total FROM task_activity_log WHERE task_id=?", [target])).rows
      const replay = await scan(writer, "target"); expect(replay.status).toBe(200); expect(await replay.json()).toEqual({ ok: true })
      expect((await db.execute("SELECT COUNT(*) AS total FROM task_activity_log WHERE task_id=?", [target])).rows).toEqual(activity)
      expect((await readTask(await context(writer, undefined, target))).status).toBe(403)
      const observed = await readTask(await context(reader, undefined, target)); expect(observed.status).toBe(200); expect(await observed.json()).toMatchObject({ id: target, status: "complete" })
      const visible = await scan(both, "readable"); expect(visible.status).toBe(200); expect(await visible.json()).toMatchObject({ ok: true, task_id: readable, task: { id: readable, status: "complete" } })
      expect(await (await scan(both, "readable")).json()).toEqual({ ok: true, task_id: readable, already_complete: true })
      expect((await scan(assignedOnly, "other")).status).toBe(404)
      expect(await (await scan(assignedOnly, "assigned")).json()).toEqual({ ok: true })
      repo = new TaskRepository(db, await currentBoardScope(db, board, owner))
      expect((await repo.updateTask(assigned, { assigned_to: null })).ok).toBe(true)
      expect((await scan(assignedOnly, "assigned")).status).toBe(404)
      expect((await repo.updateTask(notAssigned, { nfc_tag_id: "target" })).ok).toBe(true)
      expect((await scan(writer, "target")).status).toBe(409)
      expect((await repo.findById(notAssigned))?.status).toBe("pending")
      expect((await repo.updateTask(notAssigned, { nfc_tag_id: "other" })).ok).toBe(true)
      await boards.updateRestrictions(owner, board, { denyCompletion: true, denyDeletion: false, denyAgentDeletion: false })
      expect((await scan(writer, "other")).status).toBe(403)
      expect((await scan(writer, "target")).status).toBe(403)
      expect((await new TaskRepository(db, await currentBoardScope(db, board, owner)).findById(notAssigned))?.status).toBe("pending")
    })
  })
  test(`canonical recurrence edits retain parser-supported RRULE prefixes and ISO UNTIL dates: ${encoding}`, async () => {
    await runWithIngressTransport(transport, async () => {
      const owner = await verifiedBoardRequestPrincipal({ request: new Request("http://localhost/boards"), locals: {} as App.Locals })
      if (!owner) throw new Error("Operator required")
      const db = getPersistenceClient(), created = await new NamedBoardRepository(db).create(owner, "Recurrence Work")
      if (created.status !== "committed") throw new Error("Board required")
      const board = encoding === "legacy" ? "household" : created.result.id, repo = new TaskRepository(db, await currentBoardScope(db, board, owner))
      const put = (id: string, body: unknown) => {
        const url = new URL(`http://localhost/api/tasks/${id}`)
        return updateTask({ url, request: new Request(url, { method: "PUT", headers: { "Content-Type": "application/json", "X-Meitheal-Board-Id": board, "X-Meitheal-Board-Session": boardSessionProof(owner.id) }, body: JSON.stringify(body) }), params: { id }, locals: {} } as unknown as Parameters<typeof updateTask>[0])
      }
      for (const rule of ["RRULE:FREQ=DAILY", "FREQ=DAILY;UNTIL=2031-07-31"]) {
        const prepared = await prepareTaskCreation(repo, { title: "Supported rule", due_date: "2031-07-10" }, { useDefaultAssignee: false })
        if (!prepared.ok) throw new Error(prepared.error)
        const task = await repo.createWorkCommand(prepared.task)
        if (!task.ok) throw new Error(task.errorCode)
        expect((await put(task.task.id, { recurrence_rule: rule })).status).toBe(200)
        expect((await repo.findById(task.task.id))?.recurrence_rule).toBe(rule)
        const before = (await repo.findAll({})).tasks.map(task => task.id)
        expect((await put(task.task.id, { status: "complete" })).status).toBe(200)
        const successors = (await repo.findAll({})).tasks.filter(task => !before.includes(task.id))
        expect(successors).toHaveLength(1); expect(successors[0]?.due_date).toBe("2031-07-11")
        expect((await put(successors[0]!.id, { recurrence_rule: null })).status).toBe(200)
        expect((await repo.findById(successors[0]!.id))?.recurrence_rule).toBeNull()
        const count = (await repo.findAll({})).total
        expect((await put(successors[0]!.id, { status: "complete" })).status).toBe(200)
        expect((await repo.findAll({})).total).toBe(count)
      }
    })
  })
  test(`Area-filtered Kanban uses the same visible effective Project Area in index and cards: ${encoding}`, async () => {
    await runWithIngressTransport(transport, async () => {
      const owner = await verifiedBoardRequestPrincipal({ request: new Request("http://localhost/boards"), locals: {} as App.Locals })
      if (!owner) throw new Error("Operator required")
      const db = getPersistenceClient(), created = await new NamedBoardRepository(db).create(owner, "Kanban Work")
      if (created.status !== "committed") throw new Error("Board required")
      const board = encoding === "legacy" ? "household" : created.result.id
      let scope = await currentBoardScope(db, board, owner), hierarchy = new HierarchyRepository(db, scope), repo = new TaskRepository(db, scope)
      const area = crypto.randomUUID(), project = crypto.randomUUID(), unfiled = crypto.randomUUID()
      await hierarchy.createArea({ id: area, name: "Kitchen" }); await hierarchy.createProject({ id: project, title: "Kitchen project", area_id: area }); await hierarchy.createProject({ id: unfiled, title: "Unfiled project" })
      const inherited = await add(repo, "Inherited", "inherited", undefined, project), noArea = await add(repo, "Unfiled", "unfiled", undefined, unfiled)
      // Preserve direct NULL physical placement; public logical Area is inherited.
      expect((await repo.updateTask(inherited, { area_id: null })).ok).toBe(true)
      const lanes = await repo.getKanbanLanes()
      const selected = await loadKanbanBoard(repo, lanes, 0, new URLSearchParams({ area }))
      expect([...selected.values()].flatMap(page => page.cards.map(card => card.id))).toEqual([inherited])
      expect([...selected.values()].flatMap(page => page.cards)).toEqual([expect.objectContaining({ id: inherited, area_id: area })])
      const index = await repo.withKanbanRead(reader => repo.getKanbanIndex(["pending"], 0, { matchText: false, matchOverdue: false }, reader))
      expect(index.find(row => row.id === inherited)?.area_id).toBe(area); expect(index.find(row => row.id === noArea)?.area_id).toBeNull()
      await changeBoardGrants(db, owner, async tx => {
        await tx.execute({ sql: "INSERT INTO organization_access_policies(scope,scope_id,board_id,audience,selected_users,revision) VALUES('group',?,?,'nobody','[]',1)", args: [area, board] })
        return { next: true }
      })
      scope = await currentBoardScope(db, board, owner); repo = new TaskRepository(db, scope)
      expect([...((await loadKanbanBoard(repo, await repo.getKanbanLanes(), 0, new URLSearchParams({ area }))).values())].flatMap(page => page.cards)).toEqual([])
      const restricted = await repo.withKanbanRead(reader => repo.getKanbanIndex(["pending"], 0, { matchText: false, matchOverdue: false }, reader))
      expect(restricted.map(row => row.id)).toEqual([noArea]); expect(restricted[0]?.area_id).toBeNull()
    })
  })
}
