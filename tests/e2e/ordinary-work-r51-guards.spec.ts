import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import { ensureSchema, getPersistenceClient, resetPersistenceForTests } from "../helpers/persistence-fixture"
import { currentBoardScope, fixturePrincipal } from "../helpers/current-board-scope"
import { HierarchyRepository } from "../../apps/web/src/domains/tasks/persistence/hierarchy-repository"
import { TemplateRepository } from "../../apps/web/src/domains/tasks/persistence/template-repository"
import { TaskRepository } from "../../apps/web/src/domains/tasks/persistence/task-repository"
import { NamedBoardRepository } from "../../apps/web/src/domains/tasks/persistence/named-board-repository"
import { IdentityRepository } from "../../apps/web/src/domains/tasks/persistence/identity-repository"
import { changeBoardGrants, readBoardGrantRevision } from "../../apps/web/src/domains/tasks/persistence/board-grant-fence"
import { prepareTaskCreation } from "../../apps/web/src/domains/tasks/task-creation-service"
import { runWithIngressTransport } from "../../apps/web/scripts/ingress-transport.mjs"
import { verifiedBoardRequestPrincipal } from "../../apps/web/src/lib/board-request-context"
import { boardSessionProof } from "../../apps/web/src/lib/named-board-request"
import { GET as getTask, PUT as putTask } from "../../apps/web/src/pages/api/tasks/[id]"
import { GET as listTasks, POST as canonicalCreate } from "../../apps/web/src/pages/api/tasks/index"
import { GET as boardTasks } from "../../apps/web/src/pages/api/boards/[id]/index"
import { POST as compatCreate } from "../../apps/web/src/pages/api/tasks/create"
import { getTasksForView } from "../../apps/web/src/lib/task-queries"
import { generateAgentToken } from "../../packages/domain-auth/src/index"
import { createAgentToken, ensureAgentTokenSchema } from "../../apps/web/src/domains/auth/agent-token-store"
import { resolveAgentAuth } from "../../apps/web/src/lib/agent-token-guard"
import { BoardAccessService } from "../../apps/web/src/domains/tasks/board-access-service"
import { featureAudienceAllowed } from "../../apps/web/src/domains/tasks/board-feature-policy"
import { sql } from "../../apps/web/src/domains/tasks/persistence/sql-fragment"
import { projectPublicTaskFields } from "../../apps/web/src/domains/tasks/task-projection"

type Client = ReturnType<typeof getPersistenceClient>
const transport = { peer: "127.0.0.1", fromSupervisor: false, identityHeadersSafe: true, configuredPath: undefined }
function gate() { let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve }); return { wait, release } }
let directory: string, previousUrl: string | undefined
test.beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "meitheal-r51-work-")); previousUrl = process.env.MEITHEAL_DB_URL
  process.env.MEITHEAL_DB_URL = `file:${join(directory, "work.db")}`; await ensureSchema()
})
test.afterEach(async () => {
  resetPersistenceForTests()
  if (previousUrl === undefined) delete process.env.MEITHEAL_DB_URL; else process.env.MEITHEAL_DB_URL = previousUrl
  await rm(directory, { recursive: true, force: true })
})
async function board(encoding: "legacy" | "scoped", actor = fixturePrincipal()) {
  const created = await new NamedBoardRepository(getPersistenceClient()).create(actor, "Workshop")
  if (created.status !== "committed") throw new Error("Board creation failed")
  return encoding === "legacy" ? "household" : created.result.id
}
async function create(repo: TaskRepository, body: Record<string, unknown>) {
  const prepared = await prepareTaskCreation(repo, body, { useDefaultAssignee: false })
  if (!prepared.ok) throw new Error(prepared.error)
  const created = await repo.createWorkCommand(prepared.task)
  if (!created.ok) throw new Error(created.errorCode)
  return created.task
}
function context(boardId: string, userId: string, path: string, id?: string, body?: unknown) {
  const url = new URL(`http://localhost${path}`)
  return { url, params: id ? { id } : {}, locals: {}, request: new Request(url, { ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }), headers: {
    "Content-Type": "application/json", "X-Meitheal-Board-Id": boardId, "X-Meitheal-Board-Session": boardSessionProof(userId),
  } }) } as unknown as Parameters<typeof getTask>[0]
}
for (const encoding of ["legacy", "scoped"] as const) {
  for (const action of ["update", "delete"] as const) {
    test(`template ${action} reauthorizes the writer's actual placement after a public-to-private race: ${encoding}`, async () => {
      const db = getPersistenceClient(), owner = fixturePrincipal(), boardId = await board(encoding, owner), boards = new NamedBoardRepository(db)
      expect(await boards.updateMember(owner, boardId, "reader", { role: "member", denyCompletion: false, denyDeletion: false }, ["reader"])).toMatchObject({ result: "saved" })
      let ownerScope = await currentBoardScope(db, boardId, owner), hierarchy = new HierarchyRepository(db, ownerScope)
      const areaA = crypto.randomUUID(), areaB = crypto.randomUUID(), templateId = crypto.randomUUID()
      await hierarchy.createArea({ id: areaA, name: "Public" }); await hierarchy.createArea({ id: areaB, name: "Private" })
      await changeBoardGrants(db, owner, async tx => {
        await tx.execute({ sql: "INSERT INTO organization_access_policies(scope,scope_id,board_id,audience,selected_users,revision) VALUES('group',?,?,'selected',?,1)", args: [areaB, boardId, JSON.stringify([owner.id])] })
        return { next: true }
      })
      ownerScope = await currentBoardScope(db, boardId, owner)
      const manager = new TemplateRepository(db, ownerScope)
      expect(await manager.create({ id: templateId, name: "Routine", templateJson: JSON.stringify({ title: "Routine task" }), icon: "R", position: 0, isRoutine: true, areaId: areaA })).toBe(true)
      const readerScope = await currentBoardScope(db, boardId, fixturePrincipal("reader", false)), reader = new TemplateRepository(db, readerScope)
      const arrived = gate(), resume = gate(), original = reader.findById.bind(reader)
      reader.findById = async id => { const row = await original(id); arrived.release(); await resume.wait; return row }
      const pending = action === "update" ? reader.update(templateId, { templateJson: JSON.stringify({ title: "Stale replacement", area_id: areaA }) }) : reader.delete(templateId)
      await arrived.wait
      expect(await manager.update(templateId, { areaId: areaB })).toBe(true)
      const before = (await db.execute("SELECT * FROM task_templates WHERE id=?", [templateId])).rows
      resume.release()
      if (action === "update") expect(await pending).toBe(false)
      else await pending
      expect((await db.execute("SELECT * FROM task_templates WHERE id=?", [templateId])).rows).toEqual(before)
      expect(JSON.parse(String(before[0]?.template_json)).area_id).toBe(areaB)
      expect(before[0]?.retired_at).toBeNull()
    })
  }
  test(`public parent references follow the reader while physical hierarchy and user text remain intact: ${encoding}`, async () => {
    await runWithIngressTransport(transport, async () => {
      const actor = await verifiedBoardRequestPrincipal({ request: new Request("http://localhost/boards"), locals: {} as App.Locals })
      if (!actor) throw new Error("Actual operator required")
      const db = getPersistenceClient(), boardId = await board(encoding, actor)
      let scope = await currentBoardScope(db, boardId, actor), hierarchy = new HierarchyRepository(db, scope), repo = new TaskRepository(db, scope)
      const areaId = crypto.randomUUID(); await hierarchy.createArea({ id: areaId, name: "Private parent" })
      const parent = await create(repo, { title: "SECRET PARENT", area_id: areaId, task_type: "epic" })
      const child = await create(repo, { title: "Public child", parent_id: parent.id, blocked_by: "Waiting for a household discussion" })
      expect((await repo.createLinkChecked(crypto.randomUUID(), child.id, parent.id, "blocked_by")).ok).toBe(true)
      const active = await getTask(context(boardId, actor.id, `/api/tasks/${child.id}`, child.id))
      expect((await active.json()).parent_id).toBe(parent.id)
      await changeBoardGrants(db, actor, async tx => {
        await tx.execute({ sql: "INSERT INTO organization_access_policies(scope,scope_id,board_id,audience,selected_users,revision) VALUES('group',?,?,'nobody','[]',1)", args: [areaId, boardId] })
        return { next: true }
      })
      scope = await currentBoardScope(db, boardId, actor); repo = new TaskRepository(db, scope)
      const physical = await repo.findById(child.id)
      expect(physical).toMatchObject({ parent_id: parent.id, public_parent_id: null })
      expect(projectPublicTaskFields(physical!)).toMatchObject({ parent_id: null, blocked_by: "Waiting for a household discussion" })
      expect((await getTask(context(boardId, actor.id, `/api/tasks/${parent.id}`, parent.id))).status).toBe(404)
      const detail = await getTask(context(boardId, actor.id, `/api/tasks/${child.id}`, child.id))
      expect(detail.status).toBe(200); expect((await detail.json()).parent_id).toBeNull()
      const list = await listTasks(context(boardId, actor.id, "/api/tasks"))
      expect((await list.json()).tasks).toEqual([expect.objectContaining({ id: child.id, parent_id: null })])
      const view = await boardTasks(context(boardId, actor.id, `/api/boards/${boardId}?view=tasks`, boardId))
      expect((await view.json()).tasks).toEqual([expect.objectContaining({ id: child.id, parent_id: null })])
      for (const options of [{}, { slim: true }, { descriptionPreviewChars: 10 }]) expect((await getTasksForView({ ...options, requireAvailable: true }, scope)).tasks[0]?.parent_id).toBeNull()
      expect(projectPublicTaskFields((await repo.getTimelineTasks())[0]!)).toMatchObject({ parent_id: null })
      expect((await repo.exportAll())[0]?.parent_id).toBeNull()
      expect(await repo.getOutboundLinks(child.id)).toEqual([])
      expect((await db.execute("SELECT parent_id FROM tasks WHERE id=?", [child.id])).rows[0]?.parent_id).toBe(parent.id)
    })
  })
  for (const phase of ["edit", "complete", "recurrence-successor", "assignment-receipt"] as const) {
    test(`cancellation after acquired update effects rolls back ${phase}: ${encoding}`, async () => {
      const db = getPersistenceClient(), actor = fixturePrincipal(), boardId = await board(encoding, actor), scope = await currentBoardScope(db, boardId, actor)
      const repo = new TaskRepository(db, scope)
      await new IdentityRepository(db).createCustomUser("custom_target", "Target", "#146C4E", "human")
      const task = await create(repo, { title: "Original task", ...((phase === "complete" || phase === "recurrence-successor") ? { recurrence_rule: "FREQ=DAILY", due_date: "2026-11-19" } : {}) })
      const before = (await db.execute("SELECT * FROM tasks WHERE id=?", [task.id])).rows
      const counts = async () => (await db.execute("SELECT (SELECT COUNT(*) FROM tasks) AS tasks,(SELECT COUNT(*) FROM task_activity_log) AS activity,(SELECT COUNT(*) FROM integration_attempts) AS receipts,(SELECT ticket_high_water FROM task_boards WHERE id=?) AS counter", [boardId])).rows
      const baseline = await counts(), reached = gate(), resume = gate(), controller = new AbortController()
      let intercepted = false
      const wrapped = new Proxy(db, { get(target, key) {
        if (key === "transaction") return async (mode?: "read" | "write" | "deferred") => {
          const tx = await target.transaction(mode)
          return new Proxy(tx, { get(inner, operation) {
            if (operation === "execute" || operation === "batch") return async (...args: unknown[]) => {
              const result = await (Reflect.get(inner, operation) as (...args: unknown[]) => Promise<unknown>).apply(inner, args)
              const statements = Array.isArray(args[0]) ? args[0] : [args[0]]
              const sql = statements.map(item => typeof item === "string" ? item : (item as { sql?: string })?.sql ?? "").join("\n")
              const matches = phase === "assignment-receipt" ? sql.includes("INSERT INTO integration_attempts") : phase === "recurrence-successor" ? sql.includes("INSERT INTO tasks") : sql.includes("UPDATE tasks SET")
              if (mode === "write" && !intercepted && matches) { intercepted = true; reached.release(); await resume.wait }
              return result
            }
            const value = Reflect.get(inner, operation); return typeof value === "function" ? value.bind(inner) : value
          } })
        }
        const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value
      } }) as Client
      const command = new TaskRepository(wrapped, scope)
      const fields = phase === "edit" ? { title: "Cancelled edit" } : (phase === "complete" || phase === "recurrence-successor") ? { status: "complete" } : { assigned_to: "custom_target" }
      const requestId = crypto.randomUUID()
      const pending = command.updateTask(task.id, fields, { signal: controller.signal, activity: { kind: "human", personKey: actor.id },
        ...(phase === "assignment-receipt" ? { reassignmentReceipt: { key: `owned:${requestId}`, requestId, assignedTo: "custom_target" } } : {}) }).then(value => ({ value, error: null }), error => ({ value: null, error }))
      await reached.wait; controller.abort(); resume.release()
      const outcome = await pending
      expect(outcome.value).toBeNull(); expect(outcome.error).toMatchObject({ name: "AbortError" })
      expect((await db.execute("SELECT * FROM tasks WHERE id=?", [task.id])).rows).toEqual(before)
      expect(await counts()).toEqual(baseline)
    })
  }
}

test("the retained create alias accepts object framework payload and legacy description while using one canonical creation", async () => {
  await runWithIngressTransport(transport, async () => {
    const actor = await verifiedBoardRequestPrincipal({ request: new Request("http://localhost/boards"), locals: {} as App.Locals })
    if (!actor) throw new Error("Actual operator required")
    const db = getPersistenceClient(), boardId = await board("scoped", actor)
    for (const explicit of [false, true]) {
      const response = await compatCreate(context(boardId, actor.id, "/api/tasks/create", undefined, { title: "Inspect the air filter", frameworkPayload: { description: "<script>ignored()</script>Legacy note", rice: 7 }, ...(explicit ? { description: "Explicit note" } : {}) }))
      expect(response.status).toBe(201)
      const payload = await response.json()
      expect(payload).toMatchObject({ task: { title: "Inspect the air filter", description: explicit ? "Explicit note" : "Legacy note", frameworkPayload: { rice: 7 } }, events: [], integration: { calendarSyncState: "pending", confirmationId: null } })
      expect((await db.execute("SELECT description,framework_payload FROM tasks WHERE id=?", [payload.task.id])).rows[0]).toMatchObject({ description: explicit ? "Explicit note" : "Legacy note" })
    }
    expect((await db.execute("SELECT COUNT(*) AS total FROM tasks")).rows[0]?.total).toBe(2)
  })
})

for (const encoding of ["legacy", "scoped"] as const) {
  test(`the actual PUT adapter rolls back a cancellation after its update batch: ${encoding}`, async () => {
    await runWithIngressTransport(transport, async () => {
      const actor = await verifiedBoardRequestPrincipal({ request: new Request("http://localhost/boards"), locals: {} as App.Locals })
      if (!actor) throw new Error("Actual operator required")
      const db = getPersistenceClient(), boardId = await board(encoding, actor), scope = await currentBoardScope(db, boardId, actor)
      const task = await create(new TaskRepository(db, scope), { title: "HTTP original" })
      const before = (await db.execute("SELECT * FROM tasks WHERE id=?", [task.id])).rows
      const arrived = gate(), resume = gate(), controller = new AbortController(), original = db.transaction.bind(db)
      let intercepted = false
      db.transaction = async (mode?: "read" | "write" | "deferred") => {
        const tx = await original(mode)
        return new Proxy(tx, { get(target, key) {
          if (key === "batch") return async (...args: unknown[]) => {
            const result = await (Reflect.get(target, key) as (...args: unknown[]) => Promise<unknown>).apply(target, args)
            const statements = args[0] as Array<{ sql?: string } | string>
            if (mode === "write" && !intercepted && statements.some(item => (typeof item === "string" ? item : item.sql ?? "").includes("UPDATE tasks SET"))) {
              intercepted = true; arrived.release(); await resume.wait
            }
            return result
          }
          const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value
        } })
      }
      try {
        const selected = context(boardId, actor.id, `/api/tasks/${task.id}`, task.id)
        selected.request = new Request(selected.request, { method: "PUT", body: JSON.stringify({ title: "Cancelled HTTP edit", updated_at: task.updated_at }), signal: controller.signal })
        selected.locals.writeAbortSignal = controller.signal
        const pending = Promise.resolve(putTask(selected)).then(value => ({ value, error: null }), error => ({ value: null, error }))
        await arrived.wait; controller.abort(); resume.release()
        expect((await pending).error).toMatchObject({ name: "AbortError" })
        expect((await db.execute("SELECT * FROM tasks WHERE id=?", [task.id])).rows).toEqual(before)
      } finally { db.transaction = original; resume.release() }
    })
  })
}

for (const encoding of ["legacy", "scoped"] as const) {
  test(`a hidden owned ancestor cannot bypass the physical parent-cycle invariant: ${encoding}`, async () => {
    const db = getPersistenceClient(), actor = fixturePrincipal(), boardId = await board(encoding, actor)
    let scope = await currentBoardScope(db, boardId, actor), repo = new TaskRepository(db, scope)
    const privateArea = crypto.randomUUID(); await new HierarchyRepository(db, scope).createArea({ id: privateArea, name: "Hidden ancestor" })
    const first = await create(repo, { title: "Visible A" })
    const hidden = await create(repo, { title: "Hidden C", area_id: privateArea, parent_id: first.id })
    const second = await create(repo, { title: "Visible B", parent_id: hidden.id })
    await changeBoardGrants(db, actor, async tx => {
      await tx.execute({ sql: "INSERT INTO organization_access_policies(scope,scope_id,board_id,audience,selected_users,revision) VALUES('group',?,?,'nobody','[]',1)", args: [privateArea, boardId] })
      return { next: true }
    })
    scope = await currentBoardScope(db, boardId, actor); repo = new TaskRepository(db, scope)
    expect(await repo.findById(hidden.id)).toBeNull()
    expect(await repo.findById(second.id)).toMatchObject({ id: second.id, public_parent_id: null })
    const before = (await db.execute("SELECT id,parent_id,updated_at FROM tasks ORDER BY id")).rows
    expect(await repo.updateTask(first.id, { parent_id: second.id })).toEqual({ ok: false, errorCode: "unavailable" })
    expect((await db.execute("SELECT id,parent_id,updated_at FROM tasks ORDER BY id")).rows).toEqual(before)
    const foreign = await new NamedBoardRepository(db).create(actor, "Other Board")
    if (foreign.status !== "committed") throw new Error("Board creation failed")
    const other = await currentBoardScope(db, foreign.result.id, actor)
    const foreignTask = await create(new TaskRepository(db, other), { title: "Foreign parent" })
    scope = await currentBoardScope(db, boardId, actor)
    expect(await new TaskRepository(db, scope).updateTask(first.id, { parent_id: foreignTask.id })).toEqual({ ok: false, errorCode: "unavailable" })
  })
}

test("owned idempotency response headers retain current Board, actor and payload boundaries", async () => {
  await runWithIngressTransport(transport, async () => {
    const actor = await verifiedBoardRequestPrincipal({ request: new Request("http://localhost/boards"), locals: {} as App.Locals })
    if (!actor) throw new Error("Actual operator required")
    const db = getPersistenceClient(), first = await board("scoped", actor), second = await board("scoped", actor), key = crypto.randomUUID()
    const submit = async (boardId: string, title = "Same owned operation") => {
      const selected = context(boardId, actor.id, "/api/tasks", undefined, { title })
      const headers = new Headers(selected.request.headers); headers.set("Idempotency-Key", key)
      selected.request = new Request(selected.request, { headers })
      return canonicalCreate(selected)
    }
    const created = await submit(first), firstBody = await created.json()
    expect(created.status).toBe(201); expect(created.headers.get("idempotency-key-status")).toBe("processed")
    const replay = await submit(first), replayBody = await replay.json()
    expect(replay.status).toBe(201); expect(replay.headers.get("idempotency-key-status")).toBe("cached")
    expect(replayBody.id).toBe(firstBody.id)
    const elsewhere = await submit(second), otherBody = await elsewhere.json()
    expect(elsewhere.status).toBe(201); expect(elsewhere.headers.get("idempotency-key-status")).toBe("processed")
    expect(otherBody.id).not.toBe(firstBody.id)
    const changed = await submit(first, "Changed payload must not reuse receipt")
    expect(changed.status).toBe(409); expect(changed.headers.get("idempotency-key-status")).toBeNull()
    await ensureAgentTokenSchema()
    const credential = generateAgentToken()
    await createAgentToken({ id: crypto.randomUUID(), name: "Write-only owner", tokenHash: credential.tokenHash, tokenPrefix: credential.tokenPrefix, scopes: ["tasks:write"] }, await currentBoardScope(db, first, actor))
    const asAgent = async (boardId: string) => {
      const selected = context(boardId, actor.id, "/api/tasks", undefined, { title: "Different actor's operation" })
      const headers = new Headers(selected.request.headers); headers.set("Idempotency-Key", key); headers.set("Authorization", `Bearer ${credential.token}`)
      selected.request = new Request(selected.request, { headers })
      const agent = await resolveAgentAuth(selected.request)
      if (!agent) throw new Error("Actual credential resolution required")
      selected.locals.agentToken = agent
      return canonicalCreate(selected)
    }
    const own = await asAgent(first), ownBody = await own.json()
    expect(own.status).toBe(201); expect(own.headers.get("idempotency-key-status")).toBe("processed")
    expect(ownBody.id).not.toBe(firstBody.id)
    expect(Object.keys(ownBody).sort()).toEqual(["id", "ticket_key"])
    const ownReplay = await asAgent(first)
    expect(ownReplay.headers.get("idempotency-key-status")).toBe("cached")
    expect(await ownReplay.json()).toEqual(ownBody)
    const foreign = await asAgent(second)
    expect(foreign.status).toBe(404); expect(foreign.headers.get("idempotency-key-status")).toBeNull()
    expect((await db.execute("SELECT COUNT(*) AS total FROM tasks")).rows[0]?.total).toBe(3)
  })
})

for (const encoding of ["legacy", "scoped"] as const) {
  test(`logical inherited Area and feature reference audiences use one current policy: ${encoding}`, async () => {
    await runWithIngressTransport(transport, async () => {
      const freshOwner = async () => {
        const actor = await verifiedBoardRequestPrincipal({ request: new Request("http://localhost/boards"), locals: {} as App.Locals })
        if (!actor) throw new Error("Actual operator required")
        return actor
      }
      const actor = await freshOwner(), db = getPersistenceClient(), boardId = await board(encoding, actor)
      expect(await new NamedBoardRepository(db).updateMember(actor, boardId, "included", { role: "member", denyCompletion: false, denyDeletion: false }, ["included"])).toMatchObject({ result: "saved" })
      let scope = await currentBoardScope(db, boardId, actor)
      const hierarchy = new HierarchyRepository(db, scope), areaId = crypto.randomUUID(), projectId = crypto.randomUUID(), goalId = crypto.randomUUID(), unfiledId = crypto.randomUUID()
      await hierarchy.createArea({ id: areaId, name: "Inherited Area" })
      expect(await hierarchy.createGoal({ id: goalId, title: "Goal", area_id: areaId })).toBe(true)
      expect(await hierarchy.createProject({ id: projectId, title: "Project", area_id: areaId, goal_id: goalId })).toBe(true)
      expect(await hierarchy.createProject({ id: unfiledId, title: "Unfiled Project" })).toBe(true)
      const posted = await canonicalCreate(context(boardId, actor.id, "/api/tasks", undefined, { title: "Project-only capture", placement: { projectId }, goal_id: goalId }))
      expect(posted.status, await posted.clone().text()).toBe(201)
      const task = await posted.json()
      expect(task).toMatchObject({ area_id: areaId, project_id: projectId, goal_id: goalId })
      const stored = encoding === "legacy" ? await db.execute("SELECT area_id FROM tasks WHERE id=?", [task.id]) : await db.execute("SELECT area_id FROM board_task_planning WHERE task_id=?", [task.id])
      expect(stored.rows[0]?.area_id).toBe(encoding === "legacy" ? "__meitheal_no_area__" : null)
      const unfiled = await canonicalCreate(context(boardId, actor.id, "/api/tasks", undefined, { title: "Unfiled", placement: { projectId: unfiledId } }))
      expect((await unfiled.json()).area_id).toBeNull()
      const listed = await listTasks(context(boardId, actor.id, `/api/tasks?area_id=${areaId}`))
      expect((await listed.json()).tasks).toEqual([expect.objectContaining({ id: task.id, area_id: areaId })])
      scope = await currentBoardScope(db, boardId, await freshOwner())
      expect((await getTasksForView({ areaId, requireAvailable: true }, scope)).tasks).toEqual([expect.objectContaining({ id: task.id, area_id: areaId })])
      expect((await new TaskRepository(db, scope).exportAll()).find(row => row.id === task.id)?.area_id).toBe(areaId)
      await ensureAgentTokenSchema()
      const credential = generateAgentToken()
      await createAgentToken({ id: crypto.randomUUID(), name: "Task-only reference reader", tokenHash: credential.tokenHash, tokenPrefix: credential.tokenPrefix, scopes: ["tasks:read"] }, scope)
      const readAgent = async () => {
        const selected = context(boardId, actor.id, `/api/tasks/${task.id}`, task.id)
        const headers = new Headers(selected.request.headers); headers.set("Authorization", `Bearer ${credential.token}`)
        selected.request = new Request(selected.request, { headers })
        selected.locals.agentToken = (await resolveAgentAuth(selected.request))!
        const principal = await verifiedBoardRequestPrincipal(selected)
        if (!principal) throw new Error("Actual token principal required")
        expect((await new BoardAccessService(db).resolve(principal, boardId, { resource: "goal", action: "read" })).ok).toBe(false)
        const response = await getTask(selected)
        expect(response.status, await response.clone().text()).toBe(200)
        return response.json()
      }
      const configure = async (audience: "everyone" | "selected" | "nobody", features = ["groups", "projects", "goals"]) => {
        await changeBoardGrants(db, await freshOwner(), async tx => {
          for (const feature of features) await tx.execute({ sql: "INSERT INTO organization_access_policies(scope,scope_id,board_id,audience,selected_users,revision) VALUES('feature',?,'',?,?,1) ON CONFLICT(scope,scope_id,board_id) DO UPDATE SET audience=excluded.audience,selected_users=excluded.selected_users,revision=revision+1", args: [feature, audience, JSON.stringify(audience === "selected" ? ["included"] : [])] })
          return { next: true }
        })
      }
      for (const audience of ["everyone", "selected", "nobody"] as const) {
        await configure(audience)
        const included = await currentBoardScope(db, boardId, fixturePrincipal("included", false))
        const visible = projectPublicTaskFields((await new TaskRepository(db, included).findById(task.id))!)
        expect(visible).toMatchObject({ area_id: audience === "nobody" ? null : areaId, project_id: audience === "nobody" ? null : projectId, goal_id: audience === "nobody" ? null : goalId })
        const agentView = await readAgent()
        expect(agentView).toMatchObject({ area_id: audience === "everyone" ? areaId : null, project_id: audience === "everyone" ? projectId : null, goal_id: audience === "everyone" ? goalId : null })
      }
      await configure("everyone")
      // Organizer dependency masks Areas/Projects independently of Goal CRUD.
      await configure("nobody", ["organizer"])
      expect(await readAgent()).toMatchObject({ area_id: null, project_id: null, goal_id: goalId })
      await configure("everyone", ["organizer"])
      await changeBoardGrants(db, await freshOwner(), async tx => {
        await tx.execute("INSERT INTO settings(key,value) VALUES('feature_goals','false') ON CONFLICT(key) DO UPDATE SET value='false'")
        return { next: true }
      })
      expect((await readAgent()).goal_id).toBe(goalId) // explicit Everyone overrides the legacy flag
      await changeBoardGrants(db, await freshOwner(), async tx => {
        await tx.execute("DELETE FROM organization_access_policies WHERE scope='feature' AND scope_id='goals' AND board_id=''")
        return { next: true }
      })
      expect((await readAgent()).goal_id).toBeNull()
      await changeBoardGrants(db, await freshOwner(), async tx => {
        await tx.execute({ sql: "INSERT INTO organization_access_policies(scope,scope_id,board_id,audience,selected_users,revision) VALUES('group',?,?,'nobody','[]',1)", args: [areaId, boardId] })
        return { next: true }
      })
      const hidden = await getTask(context(boardId, actor.id, `/api/tasks/${task.id}`, task.id))
      expect(hidden.status).toBe(404)
    })
  })
}

test("the shared feature predicate denies malformed selected audiences with exact array-string membership", async () => {
  const db = getPersistenceClient(), actor = fixturePrincipal("included", false)
  for (const [selected, allowed] of [["[\"included\"]", 1], ["{\"id\":\"included\"}", 0], ["\"included\"", 0], ["not-json", 0], ["[1]", 0]] as const) {
    const result = await db.execute(sql`WITH organization_access_policies(scope,scope_id,board_id,audience,selected_users) AS (
      VALUES('feature','goals','','selected',${selected})
    ) SELECT ${featureAudienceAllowed(actor, "goals")} AS allowed`)
    expect(result.rows[0]?.allowed).toBe(allowed)
  }
})
