import { randomBytes, randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import {
  hashToken,
  resolveAgentRouteAccess,
  type AgentScope
} from "../../packages/domain-auth/src/index"
import {
  ensureSchema,
  getPersistenceClient,
  resetPersistenceForTests
} from "../helpers/persistence-fixture"
import { currentBoardScope, fixturePrincipal } from "../helpers/current-board-scope"
import { startCoreRosterFixture } from "../helpers/core-roster-fixture"
import {
  createAgentToken,
  ensureAgentTokenSchema
} from "../../apps/web/src/domains/auth/agent-token-store"
import { resolveAgentAuth } from "../../apps/web/src/lib/agent-token-guard"
import { NamedBoardRepository } from "../../apps/web/src/domains/tasks/persistence/named-board-repository"
import { TaskRepository } from "../../apps/web/src/domains/tasks/persistence/task-repository"
import { HierarchyRepository } from "../../apps/web/src/domains/tasks/persistence/hierarchy-repository"
import { prepareTaskCreation } from "../../apps/web/src/domains/tasks/task-creation-service"
import { changeBoardGrants } from "../../apps/web/src/domains/tasks/persistence/board-grant-fence"
import { GET as search } from "../../apps/web/src/pages/api/search"
import { GET as taskDetail } from "../../apps/web/src/pages/api/tasks/[id]"
import { runWithIngressTransport } from "../../apps/web/scripts/ingress-transport.mjs"

const previous = process.env.MEITHEAL_DB_URL
let directory: string,
  stop: () => Promise<void>,
  board: string,
  taskId: string,
  token: string,
  tokenId: string
const title = "Visible title search result",
  secret = "PRIVATE-DESCRIPTION-SENTINEL"
const ingress = <T>(work: () => T) =>
  runWithIngressTransport(
    {
      peer: "172.30.32.2",
      fromSupervisor: true,
      identityHeadersSafe: true,
      configuredPath: "/api/hassio_ingress/test"
    },
    work
  )
async function credential(scopes: AgentScope[]) {
  const value = "mth_" + randomBytes(32).toString("hex"),
    id = randomUUID()
  await createAgentToken(
    {
      id,
      name: "Search fixture",
      tokenHash: hashToken(value),
      tokenPrefix: value.slice(0, 12),
      scopes
    },
    await currentBoardScope(getPersistenceClient(), board, fixturePrincipal("owner"), {
      resource: "board",
      action: "manage"
    })
  )
  return { value, id }
}
async function context(
  query = title,
  selected = board,
  user = "owner",
  auth: string | null = token,
  extra = ""
) {
  const url = new URL(
    `http://localhost/api/search?board_id=${selected}&q=${encodeURIComponent(query)}${extra}`
  )
  const request = new Request(url, { headers: auth ? { authorization: "Bearer " + auth } : {} })
  const agent = auth ? await resolveAgentAuth(request) : null
  return {
    url,
    request,
    params: {},
    cookies: { get: () => undefined },
    locals: {
      behindIngress: true,
      hassUserId: user,
      hassIsAdmin: user === "owner",
      ...(agent ? { agentToken: agent } : {})
    }
  } as unknown as Parameters<typeof search>[0]
}
async function invoke(ctx: Awaited<ReturnType<typeof context>>) {
  // The serving middleware uses this same public route policy before the handler.
  const agent = ctx.locals.agentToken
  if (agent && !resolveAgentRouteAccess("/api/search", "GET", agent.scopes).allowed)
    return Response.json({ error: "Insufficient scope" }, { status: 403 })
  return (
    ctx.locals.behindIngress
      ? ingress(() => search(ctx))
      : runWithIngressTransport(
          {
            peer: "172.30.33.7",
            fromSupervisor: false,
            identityHeadersSafe: true,
            configuredPath: undefined
          },
          () => search(ctx)
        )
  ) as Promise<Response>
}
test.beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "ordinary-search-effect-"))
  process.env.MEITHEAL_DB_URL = "file:" + join(directory, "test.db")
  await ensureSchema()
  await ensureAgentTokenSchema()
  const db = getPersistenceClient(),
    created = await new NamedBoardRepository(db).create(
      fixturePrincipal("owner"),
      "Private search Board"
    )
  if (created.status !== "committed") throw new Error("Board fixture")
  board = created.result.id
  const owner = await currentBoardScope(db, board, fixturePrincipal("owner")),
    hierarchy = new HierarchyRepository(db, owner)
  await hierarchy.createArea({ id: "private-area-name", name: "PRIVATE-PLANNING-SENTINEL" })
  const repo = new TaskRepository(db, owner),
    prepared = await prepareTaskCreation(
      repo,
      {
        title,
        description: secret,
        labels: ["PRIVATE-LABEL-SENTINEL"],
        custom_fields: JSON.stringify({ secret: "PRIVATE-CUSTOM-SENTINEL" })
      },
      { useDefaultAssignee: false }
    )
  if (!prepared.ok) throw new Error(prepared.error)
  const task = await repo.createWorkCommand(prepared.task)
  if (!task.ok) throw new Error(task.errorCode)
  taskId = task.task.id
  const issued = await credential(["search:read"])
  token = issued.value
  tokenId = issued.id
  stop = await startCoreRosterFixture(["owner", "member"])
})
test.afterEach(async () => {
  await stop()
  resetPersistenceForTests()
  if (previous === undefined) delete process.env.MEITHEAL_DB_URL
  else process.env.MEITHEAL_DB_URL = previous
  await rm(directory, { recursive: true, force: true })
})

test("Search-only route returns only authorized title references, never rich task or planning metadata", async () => {
  const response = await invoke(
    await context(
      title,
      board,
      "owner",
      token,
      "&scope=all&task_fields=description,labels,custom_fields&sort=updated&status=complete&include_completed=1"
    )
  )
  expect(response.status, await response.clone().text()).toBe(200)
  const result = await response.json()
  expect(result.sections).toHaveLength(1)
  expect(result.sections[0]).toMatchObject({
    id: "tasks",
    items: [{ id: taskId, taskId, title, kind: "task" }]
  })
  expect(Object.keys(result.sections[0].items[0]).sort()).toEqual([
    "href",
    "id",
    "kind",
    "subtitle",
    "taskId",
    "title"
  ])
  expect(result.meta).toMatchObject({
    scope: "tasks",
    task_fields: ["id", "title"],
    sort: "relevance",
    include_completed: false,
    include_archived: false
  })
  expect(JSON.stringify(result)).not.toMatch(
    /PRIVATE-|priority|status|deferred|matched_fields|score/
  )
  for (const query of [
    secret,
    "PRIVATE-LABEL-SENTINEL",
    "PRIVATE-CUSTOM-SENTINEL",
    "PRIVATE-PLANNING-SENTINEL"
  ]) {
    const found = await invoke(await context(query))
    expect(found.status).toBe(200)
    expect((await found.json()).sections).toEqual([])
  }
  for (const scope of ["views", "settings", "actions"]) {
    const found = await invoke(await context("", board, "owner", token, "&scope=" + scope))
    expect(found.status).toBe(200)
    expect((await found.json()).sections).toEqual([])
  }
  const direct = await context()
  direct.locals.behindIngress = false
  direct.locals.hassUserId = undefined
  direct.locals.hassIsAdmin = false
  const directResponse = await invoke(direct)
  expect(directResponse.status).toBe(200)
  expect((await directResponse.json()).sections[0].items[0]).toMatchObject({ id: taskId, title })
  const ctx = await context()
  ctx.params.id = taskId
  expect((await ingress(() => taskDetail(ctx))).status).toBe(403)
})

test("task-read alone still lacks Search route scope, while an authorized human and read+search token retain rich search", async () => {
  const read = await credential(["tasks:read"])
  expect((await invoke(await context(title, board, "owner", read.value))).status).toBe(403)
  const full = await credential(["tasks:read", "search:read"])
  for (const auth of [null, full.value]) {
    const response = await invoke(
      await context(secret, board, "owner", auth, auth ? "&scope=tasks" : "")
    )
    expect(response.status, await response.clone().text()).toBe(200)
    expect((await response.json()).sections[0].items[0]).toMatchObject({
      id: taskId,
      description: secret,
      meta: { status: "pending", priority: 3 }
    })
  }
})

test("a broader search credential cannot lend private Board rights to its current ingress human", async () => {
  const response = await invoke(await context(title, board, "member"))
  expect(response.status).toBe(404)
  expect(await response.text()).not.toContain(title)
})

for (const failure of ["revoke", "expire"] as const)
  test(`retained Search projection is withheld after ${failure}`, async () => {
    const original = TaskRepository.prototype.searchTaskTitles,
      realNow = Date.now
    let held!: () => void, resume!: () => void
    const entered = new Promise<void>((resolve) => {
        held = resolve
      }),
      release = new Promise<void>((resolve) => {
        resume = resolve
      })
    TaskRepository.prototype.searchTaskTitles = async function (options) {
      const rows = await original.call(this, options)
      held()
      await release
      return rows
    }
    let pending: Promise<Response> | undefined
    try {
      pending = invoke(await context())
      await entered
      if (failure === "revoke")
        expect(
          await new NamedBoardRepository(getPersistenceClient()).updateAgent(
            fixturePrincipal("owner"),
            board,
            tokenId,
            false
          )
        ).toMatchObject({ status: "committed" })
      else {
        const expired = realNow() + 6000
        Date.now = () => expired
      }
      resume()
      const response = await pending
      expect(response.status).toBe(409)
      expect(await response.text()).not.toContain(title)
    } finally {
      resume()
      Date.now = realNow
      await pending?.catch(() => {})
      TaskRepository.prototype.searchTaskTitles = original
    }
  })

test("selected human placement audiences do not widen the primary search credential", async () => {
  const db = getPersistenceClient()
  let scope = await currentBoardScope(db, board, fixturePrincipal("owner")),
    repo = new TaskRepository(db, scope)
  const prepared = await prepareTaskCreation(
    repo,
    { title: "Selected private placement", area_id: "private-area-name" },
    { useDefaultAssignee: false }
  )
  if (!prepared.ok) throw new Error(prepared.error)
  expect((await repo.createWorkCommand(prepared.task)).ok).toBe(true)
  await changeBoardGrants(db, fixturePrincipal("owner"), async (tx) => {
    await tx.execute({
      sql: "INSERT INTO organization_access_policies(scope,scope_id,board_id,audience,selected_users,revision) VALUES('group',?,?,'selected',?,1)",
      args: ["private-area-name", board, JSON.stringify(["owner"])]
    })
    return { next: true }
  })
  const response = await invoke(await context("Selected private placement"))
  expect(response.status).toBe(200)
  expect((await response.json()).sections).toEqual([])
})
