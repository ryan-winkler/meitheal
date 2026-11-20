import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import { generateAgentToken } from "../../packages/domain-auth/src/index"
import { ensureSchema, getPersistenceClient, resetPersistenceForTests } from "../helpers/persistence-fixture"
import { currentBoardScope } from "../helpers/current-board-scope"
import { runWithIngressTransport } from "../../apps/web/scripts/ingress-transport.mjs"
import { verifiedBoardRequestPrincipal } from "../../apps/web/src/lib/board-request-context"
import { boardSessionProof } from "../../apps/web/src/lib/named-board-request"
import { resolveAgentAuth } from "../../apps/web/src/lib/agent-token-guard"
import { createAgentToken, ensureAgentTokenSchema } from "../../apps/web/src/domains/auth/agent-token-store"
import { NamedBoardRepository } from "../../apps/web/src/domains/tasks/persistence/named-board-repository"
import { GET as list, POST as create } from "../../apps/web/src/pages/api/boards/[id]/tickets/index"
import { PATCH as edit } from "../../apps/web/src/pages/api/boards/[id]/tickets/[ticket]"

const transport = { peer: "127.0.0.1", fromSupervisor: false, identityHeadersSafe: true, configuredPath: undefined }
let directory: string, previous: string | undefined
function context(board: string, actor: string, method: string, body?: unknown, ticket?: string) {
  const url = new URL(`http://localhost/api/boards/${board}/tickets${ticket ? "/" + ticket : ""}`)
  return { url, params: { id: board, ...(ticket ? { ticket } : {}) }, locals: {} as App.Locals,
    request: new Request(url, { method, headers: { "content-type": "application/json", "x-meitheal-board-id": board, "x-meitheal-board-session": boardSessionProof(actor) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
  } as unknown as Parameters<typeof create>[0]
}
test.beforeEach(async () => {
  previous = process.env.MEITHEAL_DB_URL
  directory = await mkdtemp(join(tmpdir(), "ordinary-ticket-compat-"))
  process.env.MEITHEAL_DB_URL = "file:" + join(directory, "tasks.db")
  await ensureSchema()
})
test.afterEach(async () => {
  resetPersistenceForTests()
  if (previous === undefined) delete process.env.MEITHEAL_DB_URL
  else process.env.MEITHEAL_DB_URL = previous
  await rm(directory, { recursive: true, force: true })
})
for (const encoding of ["legacy", "scoped"] as const) {
  test(`the legacy ticket receipt edits the same rich task with its returned version: ${encoding}`, async () => {
    await runWithIngressTransport(transport, async () => {
      const actor = await verifiedBoardRequestPrincipal({ request: new Request("http://localhost/boards"), locals: {} as App.Locals })
      if (!actor) throw new Error("Actual operator required")
      let board = "household"
      if (encoding === "scoped") {
        const result = await new NamedBoardRepository(getPersistenceClient()).create(actor, "Work")
        if (result.status !== "committed") throw new Error("Actual Board creation required")
        board = result.result.id
      }
      const response = await create(context(board, actor.id, "POST", { title: "Legacy receipt", description: "Retained rich description" }))
      expect(response.status, await response.clone().text()).toBe(201)
      const task = await response.json()
      expect(task.ticket).toBe(task.ticket_key)
      expect(task.version).toBe(task.task_version)
      expect(Number.isSafeInteger(task.version)).toBe(true)
      const listed = await list(context(board, actor.id, "GET"))
      expect((await listed.json()).tasks).toContainEqual(expect.objectContaining({ id: task.id, ticket: task.ticket, version: task.version }))
      const saved = await edit(context(board, actor.id, "PATCH", { title: "Updated through old receipt", description: "Same rich task", version: task.version }, task.id))
      expect(saved.status, await saved.clone().text()).toBe(200)
      const stale = await edit(context(board, actor.id, "PATCH", { title: "Must not overwrite", description: "Old version", version: task.version }, task.id))
      expect(stale.status).toBe(409)
      expect((await list(context(board, actor.id, "GET"))).status).toBe(200)
      expect((await getPersistenceClient().execute({ sql: "SELECT title FROM tasks WHERE id=?", args: [task.id] })).rows[0]?.title).toBe("Updated through old receipt")
    })
  })
}
test("ticket compatibility does not invent a version or private task fields in a write-only receipt", async () => {
  await runWithIngressTransport(transport, async () => {
    const actor = await verifiedBoardRequestPrincipal({ request: new Request("http://localhost/boards"), locals: {} as App.Locals })
    if (!actor) throw new Error("Actual operator required")
    const db = getPersistenceClient(), result = await new NamedBoardRepository(db).create(actor, "Blind capture")
    if (result.status !== "committed") throw new Error("Actual Board required")
    await ensureAgentTokenSchema()
    const credential = generateAgentToken()
    await createAgentToken({ id: crypto.randomUUID(), name: "Create only", tokenHash: credential.tokenHash, tokenPrefix: credential.tokenPrefix, scopes: ["tasks:write"] }, await currentBoardScope(db, result.result.id, actor))
    const selected = context(result.result.id, actor.id, "POST", { title: "Withheld private title" })
    const headers = new Headers(selected.request.headers)
    headers.set("authorization", "Bearer " + credential.token)
    selected.request = new Request(selected.request, { headers })
    const agent = await resolveAgentAuth(selected.request)
    if (!agent) throw new Error("Actual credential required")
    selected.locals.agentToken = agent
    const response = await create(selected)
    expect(response.status, await response.clone().text()).toBe(201)
    const receipt = await response.json()
    expect(Object.keys(receipt).sort()).toEqual(["id", "ticket", "ticket_key"])
    expect(receipt.ticket).toBe(receipt.ticket_key)
    expect(receipt).not.toHaveProperty("version")
    expect(receipt).not.toHaveProperty("title")
  })
})
