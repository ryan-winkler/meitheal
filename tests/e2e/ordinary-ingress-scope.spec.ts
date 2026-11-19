import { resolveIntakeSubmissionScope } from "../../apps/web/src/domains/tasks/intake-scope"
import { BoardIntakeRepository } from "../../apps/web/src/domains/tasks/persistence/board-intake-repository"
import { createRequire } from "node:module"
import { randomBytes, randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import { hashToken } from "../../packages/domain-auth/src/index"
import {
  ensureSchema,
  getPersistenceClient,
  resetPersistenceForTests
} from "../helpers/persistence-fixture"
import {
  createAgentToken,
  ensureAgentTokenSchema
} from "../../apps/web/src/domains/auth/agent-token-store"
import { resolveAgentAuth } from "../../apps/web/src/lib/agent-token-guard"
import {
  verifiedBoardIngressPrincipal,
  verifiedBoardRequestPrincipal,
  resolveBoardRequestScope
} from "../../apps/web/src/lib/board-request-context"
import { boardSessionProof } from "../../apps/web/src/lib/named-board-request"
import { runWithIngressTransport } from "../../apps/web/scripts/ingress-transport.mjs"
import {
  BoardAccessService,
  validateBoardFeature,
  validateBoardPlacement
} from "../../apps/web/src/domains/tasks/board-access-service"
import {
  registerVerifiedPrincipal,
  scopePermits,
  scopeBoardAccess,
  validateBoardScope,
  type BoardScope
} from "../../apps/web/src/domains/tasks/board-scope"
import { NamedBoardRepository } from "../../apps/web/src/domains/tasks/persistence/named-board-repository"
import { HierarchyRepository } from "../../apps/web/src/domains/tasks/persistence/hierarchy-repository"
import { IdentityRepository } from "../../apps/web/src/domains/tasks/persistence/identity-repository"
import { TaskRepository } from "../../apps/web/src/domains/tasks/persistence/task-repository"
import { prepareTaskCreation } from "../../apps/web/src/domains/tasks/task-creation-service"
import { changeBoardGrants } from "../../apps/web/src/domains/tasks/persistence/board-grant-fence"

const require = createRequire(new URL("../../apps/web/package.json", import.meta.url))
const { WebSocket, WebSocketServer } =
  require("ws") as typeof import("../../apps/web/node_modules/@types/ws")
let server: InstanceType<typeof WebSocketServer>
let originalSocket: typeof globalThis.WebSocket
let directory: string
let users: {
  id: string
  is_active: boolean
  system_generated: boolean
  is_owner: boolean
  group_ids: string[]
}[]
let token: string
let tokenId: string
let agent: NonNullable<Awaited<ReturnType<typeof resolveAgentAuth>>>
const previousDb = process.env.MEITHEAL_DB_URL
const previousSupervisor = process.env.SUPERVISOR_TOKEN
const parent = () =>
  registerVerifiedPrincipal(
    { kind: "ha_user", id: "parent" },
    { expiresAt: Date.now() + 60_000, administrator: true }
  )
const operation = { resource: "task", action: "read" } as const
async function ownerScope(id = "household", action: "read" | "manage" = "read") {
  const result = await new BoardAccessService(getPersistenceClient()).resolve(parent(), id, {
    resource: action === "manage" ? "board" : "task",
    action
  })
  if (!result.ok) throw new Error(result.errorCode)
  return result.scope
}
function context(user = "child", write = false, proof = write) {
  return {
    request: new Request("http://localhost/api/tasks?board_id=household", {
      method: write ? "POST" : "GET",
      headers: {
        authorization: `Bearer ${token}`,
        ...(proof ? { "x-meitheal-board-session": boardSessionProof(user) } : {})
      }
    }),
    locals: {
      agentToken: agent,
      behindIngress: true,
      hassUserId: user,
      hassIsAdmin: true
    } as Parameters<typeof verifiedBoardRequestPrincipal>[0]["locals"]
  }
}
function ingress<T>(work: () => T) {
  return runWithIngressTransport(
    {
      peer: "172.30.32.2",
      fromSupervisor: true,
      identityHeadersSafe: true,
      configuredPath: "/api/hassio_ingress/test"
    },
    work
  )
}
async function nativeScope(user = "child", write = false): Promise<BoardScope> {
  const resolved = await ingress(() =>
    resolveBoardRequestScope(context(user, write), { boardId: "household", operation, write })
  )
  if (!resolved.ok) throw new Error(resolved.errorCode)
  return resolved.scope
}
async function createTask(
  work: BoardScope,
  fields: { area_id?: string | null; assigned_to?: string } = {}
) {
  const repository = new TaskRepository(getPersistenceClient(), work)
  const input = await prepareTaskCreation(
    repository,
    { title: "Bounded native task", area_id: null, ...fields },
    { useDefaultAssignee: false }
  )
  if (!input.ok) throw new Error(input.error)
  const result = await repository.createWorkCommand(input.task)
  if (!result.ok) throw new Error(result.errorCode)
  return result.task
}

test.beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "ordinary-ingress-scope-"))
  process.env.MEITHEAL_DB_URL = `file:${join(directory, "test.db")}`
  // Startup first: the test's Supervisor protocol is introduced only afterwards.
  delete process.env.SUPERVISOR_TOKEN
  await ensureSchema()
  await ensureAgentTokenSchema()
  users = ["parent", "child", "other"].map((id) => ({
    id,
    is_active: true,
    system_generated: false,
    is_owner: id === "parent",
    group_ids: []
  }))
  server = new WebSocketServer({ host: "127.0.0.1", port: 0 })
  await new Promise<void>((resolve) => server.once("listening", resolve))
  server.on("connection", (socket) => {
    socket.send(JSON.stringify({ type: "auth_required" }))
    socket.on("message", (bytes) => {
      const command = JSON.parse(bytes.toString())
      if (command.type === "auth") socket.send(JSON.stringify({ type: "auth_ok" }))
      else if (command.type === "config/auth/list")
        socket.send(
          JSON.stringify({ type: "result", id: command.id, success: true, result: users })
        )
      else socket.close()
    })
  })
  originalSocket = globalThis.WebSocket
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Missing test Core address")
  const corePort = address.port
  globalThis.WebSocket = class extends WebSocket {
    constructor(
      url: string | URL,
      options?: import("../../apps/web/node_modules/@types/ws").ClientOptions
    ) {
      const requested = String(url)
      if (requested !== "ws://supervisor/core/api/websocket")
        throw new Error("Unexpected Core endpoint")
      super(`ws://127.0.0.1:${corePort}`, options)
    }
  } as unknown as typeof globalThis.WebSocket
  token = `mth_${randomBytes(32).toString("hex")}`
  tokenId = randomUUID()
  await createAgentToken(
    {
      id: tokenId,
      name: "Native fixture",
      tokenHash: hashToken(token),
      tokenPrefix: token.slice(0, 12),
      scopes: ["tasks:read", "tasks:write", "tasks:delete"]
    },
    await ownerScope("household", "manage")
  )
  const result = await resolveAgentAuth(
    new Request("http://localhost/api/tasks", { headers: { authorization: `Bearer ${token}` } })
  )
  if (!result) throw new Error("Credential fixture did not authenticate")
  agent = result
  process.env.SUPERVISOR_TOKEN = "fixture-core-token"
})
test.afterEach(async () => {
  globalThis.WebSocket = originalSocket
  for (const client of server.clients) client.terminate()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  resetPersistenceForTests()
  if (previousDb === undefined) delete process.env.MEITHEAL_DB_URL
  else process.env.MEITHEAL_DB_URL = previousDb
  if (previousSupervisor === undefined) delete process.env.SUPERVISOR_TOKEN
  else process.env.SUPERVISOR_TOKEN = previousSupervisor
  await rm(directory, { recursive: true, force: true })
})

test("genuine ingress human caps a broader credential without gaining administrator rights", async () => {
  const boards = new NamedBoardRepository(getPersistenceClient())
  await boards.updateMember(
    parent(),
    "household",
    "child",
    { role: "member", denyCompletion: true, denyDeletion: true },
    ["parent", "child"]
  )
  const task = await createTask(await ownerScope())
  const work = await nativeScope("child", true)
  expect(work.principal).toMatchObject({ kind: "agent", id: tokenId, tokenId })
  expect(scopePermits(work, { resource: "task", action: "edit" })).toBe(true)
  expect(scopePermits(work, { resource: "task", action: "complete" })).toBe(false)
  expect(scopePermits(work, { resource: "task", action: "delete" })).toBe(false)
  expect(scopePermits(work, { resource: "board", action: "manage" })).toBe(false)
  expect(scopeBoardAccess(work)).toMatchObject({ denyCompletion: true, denyDeletion: true })
  const repository = new TaskRepository(getPersistenceClient(), work)
  await expect(repository.updateTask(task.id, { status: "done" })).rejects.toThrow()
  await expect(repository.deleteTask(task.id)).rejects.toThrow()
  expect(
    (await new TaskRepository(getPersistenceClient(), await ownerScope()).findById(task.id))?.status
  ).toBe("pending")
  expect(
    await new BoardAccessService(getPersistenceClient()).revalidate(work, getPersistenceClient(), {
      resource: "task",
      action: "complete"
    })
  ).toMatchObject({ ok: false })
})

test("private Work remains unavailable to an ingress administrator without Board access", async () => {
  const boards = new NamedBoardRepository(getPersistenceClient())
  const created = await boards.create(parent(), "Work")
  if (created.status !== "committed") throw new Error("Board fixture")
  await boards.updateAgent(parent(), created.result.id, tokenId, true)
  users.find((user) => user.id === "other")!.group_ids = ["system-admin"]
  const ctx = context("other")
  const result = await ingress(() =>
    resolveBoardRequestScope(ctx, { boardId: created.result.id, operation })
  )
  expect(result).toMatchObject({ ok: false, errorCode: "unavailable" })
  const principal = await verifiedBoardRequestPrincipal(context("other"))
  expect(principal?.kind).toBe("agent")
  expect(
    await new BoardAccessService(getPersistenceClient()).resolve(
      principal!,
      created.result.id,
      operation
    )
  ).toMatchObject({ ok: true })
})

test("current Core and exact browser proof fail closed without token-only fallback", async () => {
  expect(await ingress(() => verifiedBoardIngressPrincipal(context("child")))).toMatchObject({
    kind: "ha_user",
    id: "child"
  })
  expect(
    await ingress(() => verifiedBoardRequestPrincipal(context("child", true, false), true))
  ).toBeNull()
  const wrong = context("child", true)
  wrong.request.headers.set("x-meitheal-board-session", boardSessionProof("parent"))
  expect(await ingress(() => verifiedBoardRequestPrincipal(wrong, true))).toBeNull()
  users.find((user) => user.id === "child")!.is_active = false
  expect(await ingress(() => verifiedBoardRequestPrincipal(context("child")))).toBeNull()
  const missing = context("unknown")
  expect(await ingress(() => verifiedBoardRequestPrincipal(missing))).toBeNull()
  expect(
    await runWithIngressTransport(
      {
        peer: "127.0.0.1",
        fromSupervisor: false,
        identityHeadersSafe: false,
        configuredPath: undefined
      },
      () => verifiedBoardIngressPrincipal(context("parent"))
    )
  ).toBeNull()
  expect(await verifiedBoardIngressPrincipal(context("parent"))).toBeNull()
})

test("composite publication and writer rechecks reject epoch changes and token revocation", async () => {
  const work = await nativeScope()
  await getPersistenceClient().execute({
    sql: "UPDATE agent_tokens SET revoked=1 WHERE id=?",
    args: [tokenId]
  })
  expect(await validateBoardScope(work, getPersistenceClient(), operation)).toMatchObject({
    ok: false
  })
  await getPersistenceClient().execute({
    sql: "UPDATE agent_tokens SET revoked=0 WHERE id=?",
    args: [tokenId]
  })
  const current = await nativeScope()
  await changeBoardGrants(getPersistenceClient(), async (tx) => {
    await tx.execute("UPDATE board_permissions SET deny_completion=1 WHERE board_id='household'")
    return { next: true }
  })
  expect(await validateBoardScope(current, getPersistenceClient(), operation)).toMatchObject({
    ok: false,
    errorCode: "stale"
  })
})

test("selected human audiences never widen primary-agent task or feature policies", async () => {
  const work = await nativeScope()
  await changeBoardGrants(getPersistenceClient(), async (tx) => {
    await tx.execute({
      sql: "INSERT INTO organization_access_policies(scope,scope_id,board_id,audience,selected_users,revision) VALUES ('feature','routines','','selected',?,1)",
      args: [JSON.stringify(["child"])]
    })
    return { next: true }
  })
  const areaId = randomUUID()
  await new HierarchyRepository(getPersistenceClient(), await ownerScope()).createArea({
    id: areaId,
    name: "Selected Area"
  })
  const task = await createTask(await ownerScope(), { area_id: areaId })
  await changeBoardGrants(getPersistenceClient(), async (tx) => {
    await tx.execute({
      sql: "INSERT INTO organization_access_policies(scope,scope_id,board_id,audience,selected_users,revision) VALUES ('group',?,'household','selected',?,1)",
      args: [areaId, JSON.stringify(["child"])]
    })
    return { next: true }
  })
  const current = await nativeScope()
  expect(await new TaskRepository(getPersistenceClient(), current).findById(task.id)).toBeNull()
  const human = await ingress(() => verifiedBoardIngressPrincipal(context("child")))
  const humanResult = await new BoardAccessService(getPersistenceClient()).resolve(
    human!,
    "household",
    operation
  )
  if (!humanResult.ok) throw new Error(humanResult.errorCode)
  expect(
    await new TaskRepository(getPersistenceClient(), humanResult.scope).findById(task.id)
  ).toMatchObject({ id: task.id })
  expect(await validateBoardFeature(current, getPersistenceClient(), "routines")).toBe(false)
  expect(await validateBoardScope(work, getPersistenceClient(), operation)).toMatchObject({
    ok: false
  })
  await changeBoardGrants(getPersistenceClient(), async (tx) => {
    await tx.execute({
      sql: "INSERT INTO organization_access_policies(scope,scope_id,board_id,audience,selected_users,revision) VALUES ('household','','household','selected',?,1)",
      args: [JSON.stringify(["child"])]
    })
    return { next: true }
  })
  expect(await validateBoardPlacement(current, getPersistenceClient(), {})).toBe(false)
  expect(
    await ingress(() => resolveBoardRequestScope(context(), { boardId: "household", operation }))
  ).toMatchObject({ ok: false, errorCode: "denied" })
})

test("primary assigned-only ceiling survives a broader ingress parent and copied scopes", async () => {
  const identity = randomUUID()
  await new IdentityRepository(getPersistenceClient()).createCustomUser(
    identity,
    "Assigned agent",
    "#123456",
    "agent"
  )
  const assigned = await createTask(await ownerScope(), { assigned_to: identity })
  const other = await createTask(await ownerScope())
  token = `mth_${randomBytes(32).toString("hex")}`
  tokenId = randomUUID()
  await createAgentToken(
    {
      id: tokenId,
      name: "Assigned native fixture",
      tokenHash: hashToken(token),
      tokenPrefix: token.slice(0, 12),
      scopes: ["tasks:read", "tasks:write:assigned"],
      assigneeId: identity
    },
    await ownerScope("household", "manage")
  )
  agent = (await resolveAgentAuth(
    new Request("http://localhost/api/tasks", { headers: { authorization: `Bearer ${token}` } })
  ))!
  const work = await nativeScope("parent", true)
  const repository = new TaskRepository(getPersistenceClient(), work)
  expect(await repository.findById(other.id)).toMatchObject({ id: other.id })
  await repository.updateTask(assigned.id, { title: "Allowed assigned edit" })
  await expect(
    repository.updateTask(other.id, { title: "Denied foreign assignment" })
  ).rejects.toThrow()
  expect(scopePermits(work, { resource: "board", action: "manage" })).toBe(false)
  await expect(validateBoardScope({ ...work }, getPersistenceClient(), operation)).rejects.toThrow(
    "verified BoardScope"
  )
  expect(
    (await new TaskRepository(getPersistenceClient(), await ownerScope()).findById(other.id))?.title
  ).toBe("Bounded native task")
})

test("finite ingress verification expires even while the credential remains valid", async () => {
  const work = await nativeScope()
  users.find((user) => user.id === "child")!.is_active = false
  await new Promise((resolve) => setTimeout(resolve, 5_050))
  expect(await validateBoardScope(work, getPersistenceClient(), operation)).toMatchObject({
    ok: false,
    errorCode: "stale"
  })
  expect(await ingress(() => verifiedBoardRequestPrincipal(context("child")))).toBeNull()
  const direct = await verifiedBoardRequestPrincipal(context("child"))
  expect(
    await new BoardAccessService(getPersistenceClient()).resolve(direct!, "household", operation)
  ).toMatchObject({ ok: true })
})

test("native send-only intake intersects its human sender without exposing Board work", async () => {
  const boards = new NamedBoardRepository(getPersistenceClient())
  const created = await boards.create(parent(), "Private intake")
  if (created.status !== "committed") throw new Error("Board fixture")
  const workId = created.result.id
  const intakeId = randomUUID()
  await changeBoardGrants(getPersistenceClient(), async (tx) => {
    const {
      rows: [lane]
    } = await tx.execute({
      sql: "SELECT id FROM kanban_lanes WHERE board_id=? AND key='pending'",
      args: [workId]
    })
    await tx.execute({
      sql: "INSERT INTO board_intakes(id,board_id,lane_id,label) VALUES(?,?,?,'Send privately')",
      args: [intakeId, workId, String(lane!.id)]
    })
    await tx.execute({
      sql: "INSERT INTO board_intake_senders(intake_id,sender_kind,sender_id) VALUES(?,'agent',?)",
      args: [intakeId, tokenId]
    })
    return { next: true }
  })
  let principal = await ingress(() => verifiedBoardRequestPrincipal(context("child", true), true))
  const actor = { kind: "agent", id: tokenId } as const
  expect(
    await resolveIntakeSubmissionScope(getPersistenceClient(), principal!, intakeId)
  ).toMatchObject({ ok: false })
  expect(
    await new BoardIntakeRepository(getPersistenceClient(), principal!).findDestinations(actor)
  ).toEqual([])
  await changeBoardGrants(getPersistenceClient(), async (tx) => {
    await tx.execute({
      sql: "INSERT INTO board_intake_senders(intake_id,sender_kind,sender_id) VALUES(?,'ha_user','child')",
      args: [intakeId]
    })
    return { next: true }
  })
  principal = await ingress(() => verifiedBoardRequestPrincipal(context("child", true), true))
  const resolved = await resolveIntakeSubmissionScope(getPersistenceClient(), principal!, intakeId)
  expect(resolved.ok).toBe(true)
  if (!resolved.ok) throw new Error("Intake fixture")
  expect(resolved.scope.capabilities.operations).toEqual([{ resource: "task", action: "create" }])
  expect(
    await new BoardAccessService(getPersistenceClient()).resolve(principal!, workId, operation)
  ).toMatchObject({ ok: false })
  const repository = new BoardIntakeRepository(getPersistenceClient(), principal!)
  expect(await repository.findDestinations(actor)).toEqual([
    { id: intakeId, label: "Send privately", acceptsAssignment: false }
  ])
  const resumeId = randomUUID()
  expect(
    await repository.issue(actor, intakeId, Date.now(), {
      resumeId,
      title: "Blind owned request",
      description: "",
      assignToRecipient: false
    })
  ).toMatchObject({ ok: true })
  expect(await repository.findSubmissions(actor)).toEqual([
    { id: resumeId, title: "Blind owned request", acknowledgement: null }
  ])
  const accepted = await repository.retry(actor, resumeId, [])
  expect(accepted).toMatchObject({ ok: true })
  if (accepted.ok) expect(Object.keys(accepted.value)).toEqual(["acknowledgement"])
  await changeBoardGrants(getPersistenceClient(), async (tx) => {
    await tx.execute({ sql: "UPDATE board_intakes SET enabled=0 WHERE id=?", args: [intakeId] })
    return { next: true }
  })
  principal = await ingress(() => verifiedBoardRequestPrincipal(context("child", true), true))
  const closed = new BoardIntakeRepository(getPersistenceClient(), principal!)
  expect(await closed.findDestinations(actor)).toEqual([])
  expect(await closed.findSubmissions(actor)).toEqual([
    {
      id: resumeId,
      title: "Blind owned request",
      acknowledgement: accepted.ok ? accepted.value.acknowledgement : null
    }
  ])
  expect(await closed.retry(actor, resumeId, [])).toEqual(accepted)
  expect(await closed.issue(actor, intakeId)).toMatchObject({ ok: false })
  await changeBoardGrants(getPersistenceClient(), async (tx) => {
    await tx.execute({
      sql: "DELETE FROM board_intake_senders WHERE intake_id=? AND sender_kind='ha_user' AND sender_id='child'",
      args: [intakeId]
    })
    return { next: true }
  })
  expect(
    await validateBoardScope(resolved.scope, getPersistenceClient(), {
      resource: "task",
      action: "create"
    })
  ).toMatchObject({ ok: false })
  principal = await ingress(() => verifiedBoardRequestPrincipal(context("child", true), true))
  const revoked = new BoardIntakeRepository(getPersistenceClient(), principal!)
  expect(await revoked.findDestinations(actor)).toEqual([])
  expect(await revoked.findSubmissions(actor)).toEqual([])
  expect(await revoked.retry(actor, resumeId, [])).toMatchObject({ ok: false })
})

test("actual agent-context bootstrap emits only genuine human proof and intersected Board metadata", async () => {
  const { GET } = await import("../../apps/web/src/pages/api/agent-context")
  const boards = new NamedBoardRepository(getPersistenceClient())
  const work = await boards.create(parent(), "Private Work bootstrap")
  if (work.status !== "committed") throw new Error("Board fixture")
  await boards.updateAgent(parent(), work.result.id, tokenId, true)
  const request = (user: string) => {
    const fixture = context(user)
    const url = new URL("http://localhost/api/agent-context?ingressProof=1")
    return {
      ...fixture,
      request: new Request(url, { headers: { authorization: `Bearer ${token}` } }),
      url,
      params: {}
    } as Parameters<typeof GET>[0]
  }
  const child = await ingress(() => GET(request("child")))
  expect(child.status).toBe(200)
  expect(child.headers.get("X-Meitheal-Board-Session")).toBe(boardSessionProof("child"))
  expect((await child.json()).boards.map((board: { id: string }) => board.id)).toEqual([
    "household"
  ])
  const owner = await ingress(() => GET(request("parent")))
  expect(owner.headers.get("X-Meitheal-Board-Session")).toBe(boardSessionProof("parent"))
  expect((await owner.json()).boards.map((board: { id: string }) => board.id)).toEqual(
    expect.arrayContaining(["household", work.result.id])
  )
  const direct = await GET(request("child"))
  expect(direct.headers.get("X-Meitheal-Board-Session")).toBeNull()
  expect((await direct.json()).boards.map((board: { id: string }) => board.id)).toEqual(
    expect.arrayContaining(["household", work.result.id])
  )
  users.find((user) => user.id === "child")!.is_active = false
  const inactive = await ingress(() => GET(request("child")))
  expect(inactive.status).toBe(403)
  expect(inactive.headers.get("X-Meitheal-Board-Session")).toBeNull()
  const unknown = await ingress(() => GET(request("unknown")))
  expect(unknown.status).toBe(403)
  expect(unknown.headers.get("X-Meitheal-Board-Session")).toBeNull()
})
