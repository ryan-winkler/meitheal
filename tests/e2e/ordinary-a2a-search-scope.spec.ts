import { randomBytes, randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { expect, test } from "@playwright/test"
import { hashToken } from "../../packages/domain-auth/src/index"
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
import { prepareTaskCreation } from "../../apps/web/src/domains/tasks/task-creation-service"
import { POST as a2a } from "../../apps/web/src/pages/api/a2a/message"
import { GET as detail } from "../../apps/web/src/pages/api/tasks/[id]"
import { runWithIngressTransport } from "../../apps/web/scripts/ingress-transport.mjs"
import { verifiedBoardRequestPrincipal } from "../../apps/web/src/lib/board-request-context"
import { BoardAccessService } from "../../apps/web/src/domains/tasks/board-access-service"
import { scopePermits } from "../../apps/web/src/domains/tasks/board-scope"
import { changeBoardGrants } from "../../apps/web/src/domains/tasks/persistence/board-grant-fence"

let directory: string,
  stop: () => Promise<void>,
  board: string,
  taskId: string,
  token: string,
  tokenId: string,
  agent: NonNullable<Awaited<ReturnType<typeof resolveAgentAuth>>>
const prior = process.env.MEITHEAL_DB_URL
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
async function context(
  method = "SendMessage",
  query = "Visible search task",
  selected = board,
  user = "owner"
) {
  const url = new URL("http://localhost/api/a2a/message?board_id=" + selected),
    request = new Request(url, {
      method: "POST",
      headers: {
        authorization: "Bearer " + token,
        "content-type": "application/json",
        "A2A-Version": "1.0"
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method,
        params:
          method === "SendMessage"
            ? { message: { role: "ROLE_USER", messageId: randomUUID(), parts: [{ text: query }] } }
            : { id: taskId }
      })
    })
  return {
    request,
    url,
    params: {},
    locals: {
      behindIngress: true,
      hassUserId: user,
      hassIsAdmin: user === "owner",
      agentToken: agent
    }
  } as Parameters<typeof a2a>[0]
}
test.beforeEach(async () => {
  stop = async () => {}
  directory = await mkdtemp(join(tmpdir(), "ordinary-a2a-search-"))
  process.env.MEITHEAL_DB_URL = "file:" + join(directory, "test.db")
  await ensureSchema()
  await ensureAgentTokenSchema()
  const db = getPersistenceClient(),
    owner = fixturePrincipal("owner"),
    created = await new NamedBoardRepository(db).create(owner, "Search-only private Board")
  if (created.status !== "committed") throw new Error("Board fixture")
  board = created.result.id
  const scope = await currentBoardScope(db, board, owner),
    repo = new TaskRepository(db, scope),
    prepared = await prepareTaskCreation(
      repo,
      {
        title: "Visible search task",
        description: "PRIVATE-DESCRIPTION-SENTINEL",
        labels: ["PRIVATE-LABEL-SENTINEL"],
        custom_fields: JSON.stringify({ secret: "PRIVATE-CUSTOM-SENTINEL" })
      },
      { useDefaultAssignee: false }
    )
  if (!prepared.ok) throw new Error(prepared.error)
  const result = await repo.createWorkCommand(prepared.task)
  if (!result.ok) throw new Error(result.errorCode)
  taskId = result.task.id
  token = "mth_" + randomBytes(32).toString("hex")
  tokenId = randomUUID()
  await createAgentToken(
    {
      id: tokenId,
      name: "Least-privilege A2A",
      tokenHash: hashToken(token),
      tokenPrefix: token.slice(0, 12),
      scopes: ["a2a:execute", "search:read"]
    },
    await currentBoardScope(db, board, owner, { resource: "board", action: "manage" })
  )
  const admitted = await resolveAgentAuth(
    new Request("http://localhost/api/a2a/message", {
      headers: { authorization: "Bearer " + token }
    })
  )
  if (!admitted) throw new Error("Actual stored credential required")
  agent = admitted
  stop = await startCoreRosterFixture(["owner", "member"])
})
test.afterEach(async () => {
  await stop()
  resetPersistenceForTests()
  if (prior === undefined) delete process.env.MEITHEAL_DB_URL
  else process.env.MEITHEAL_DB_URL = prior
  await rm(directory, { recursive: true, force: true })
})

test("actual A2A SendMessage preserves minimal search without broad Task read or private-field matching", async () => {
  const ctx = await context(),
    principal = await ingress(() => verifiedBoardRequestPrincipal(ctx))
  expect(principal).not.toBeNull()
  const selected = await new BoardAccessService(getPersistenceClient()).resolve(principal!, board, {
    resource: "task",
    action: "search"
  })
  expect(selected.ok).toBe(true)
  if (!selected.ok) return
  expect(scopePermits(selected.scope, { resource: "task", action: "read" })).toBe(false)
  const response = (await ingress(() => a2a(ctx))) as Response
  expect(response.status).toBe(200)
  const value = await response.json()
  expect(value.error).toBeUndefined()
  expect(value.result.message.parts[0].data.tasks).toEqual([
    {
      id: taskId,
      title: "Visible search task",
      url: expect.stringContaining("/boards/" + board + "?open=" + taskId)
    }
  ])
  const body = JSON.stringify(value)
  for (const hidden of [
    "PRIVATE-DESCRIPTION-SENTINEL",
    "PRIVATE-LABEL-SENTINEL",
    "PRIVATE-CUSTOM-SENTINEL"
  ])
    expect(body).not.toContain(hidden)
  for (const q of [
    "PRIVATE-DESCRIPTION-SENTINEL",
    "PRIVATE-LABEL-SENTINEL",
    "PRIVATE-CUSTOM-SENTINEL"
  ]) {
    const r = (await ingress(async () => a2a(await context("SendMessage", q)))) as Response
    expect((await r.json()).result.message.parts[0].data.tasks).toEqual([])
  }
  expect(((await ingress(async () => a2a(await context("GetTask")))) as Response).status).toBe(403)
  const direct = await context()
  direct.params = { id: taskId }
  direct.request = new Request("http://localhost/api/tasks/" + taskId + "?board_id=" + board, {
    headers: { authorization: "Bearer " + token }
  })
  direct.url = new URL(direct.request.url)
  expect(((await ingress(() => detail(direct))) as Response).status).toBe(403)
})

test("search never grants a current ingress outsider private Board access", async () => {
  expect(
    (
      (await ingress(async () =>
        a2a(await context("SendMessage", "Visible search task", board, "member"))
      )) as Response
    ).status
  ).toBe(404)
})

test("already-current explicit grant without search ceiling remains denied until owner reapproval", async () => {
  await changeBoardGrants(getPersistenceClient(), fixturePrincipal("owner"), async (tx) => {
    await tx.execute({
      sql: "UPDATE board_access_grants SET authority_limits=? WHERE board_id=? AND principal_type='agent' AND principal_id=?",
      args: [JSON.stringify({ operations: [] }), board, tokenId]
    })
    return { next: true }
  })
  expect(((await ingress(async () => a2a(await context()))) as Response).status).toBe(403)
})

test("A2A retains current epoch through the narrow search publication boundary", async () => {
  const original = TaskRepository.prototype.searchTaskTitles
  let resume!: () => void, held!: () => void
  const wait = new Promise<void>((r) => {
      resume = r
    }),
    seen = new Promise<void>((r) => {
      held = r
    })
  TaskRepository.prototype.searchTaskTitles = async function (opts) {
    const value = await original.call(this, opts)
    held()
    await wait
    return value
  }
  let pending: Promise<Response> | undefined
  try {
    pending = ingress(async () => a2a(await context())) as Promise<Response>
    await seen
    await new NamedBoardRepository(getPersistenceClient()).updateAgent(
      fixturePrincipal("owner"),
      board,
      tokenId,
      false
    )
    resume()
    const response = await pending
    expect(response.status).toBe(409)
    expect(await response.text()).not.toContain("Visible search task")
  } finally {
    resume()
    await pending?.catch(() => {})
    TaskRepository.prototype.searchTaskTitles = original
  }
})
