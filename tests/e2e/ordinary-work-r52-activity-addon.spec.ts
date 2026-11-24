import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import { ensureSchema, getPersistenceClient, resetPersistenceForTests } from "../helpers/persistence-fixture"
import { currentBoardScope } from "../helpers/current-board-scope"
import { NamedBoardRepository } from "../../apps/web/src/domains/tasks/persistence/named-board-repository"
import { TaskRepository } from "../../apps/web/src/domains/tasks/persistence/task-repository"
import { readRecentActivity } from "../../apps/web/src/domains/tasks/persistence/recent-activity"
import { prepareTaskCreation } from "../../apps/web/src/domains/tasks/task-creation-service"
import { runWithIngressTransport } from "../../apps/web/scripts/ingress-transport.mjs"
import { verifiedBoardRequestPrincipal } from "../../apps/web/src/lib/board-request-context"
import { boardSessionProof } from "../../apps/web/src/lib/named-board-request"
import { PUT as updateTask } from "../../apps/web/src/pages/api/tasks/[id]"
import { GET as readActivity } from "../../apps/web/src/pages/api/tasks/[id]/activity"
import { generateAgentToken, type AgentScope } from "../../packages/domain-auth/src/index"
import { ensureAgentTokenSchema, createAgentToken } from "../../apps/web/src/domains/auth/agent-token-store"
import { resolveAgentAuth } from "../../apps/web/src/lib/agent-token-guard"

let directory: string, previousUrl: string | undefined
const transport = { peer: "127.0.0.1", fromSupervisor: false, identityHeadersSafe: true, configuredPath: undefined }
test.beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "meitheal-r52-activity-")); previousUrl = process.env.MEITHEAL_DB_URL
  process.env.MEITHEAL_DB_URL = `file:${join(directory, "work.db")}`; await ensureSchema()
})
test.afterEach(async () => {
  resetPersistenceForTests()
  if (previousUrl === undefined) delete process.env.MEITHEAL_DB_URL; else process.env.MEITHEAL_DB_URL = previousUrl
  await rm(directory, { recursive: true, force: true })
})
for (const encoding of ["legacy", "scoped"] as const) test(`agent activity retains typed diffs and writer-verified display without widening minimal writes: ${encoding}`, async () => {
  await runWithIngressTransport(transport, async () => {
    const owner = await verifiedBoardRequestPrincipal({ request: new Request("http://localhost/boards"), locals: {} as App.Locals })
    if (!owner) throw new Error("Operator required")
    const db = getPersistenceClient(), boards = new NamedBoardRepository(db), created = await boards.create(owner, "Activity Work")
    if (created.status !== "committed") throw new Error("Board required")
    const board = encoding === "legacy" ? "household" : created.result.id
    const repo = new TaskRepository(db, await currentBoardScope(db, board, owner))
    const prepared = await prepareTaskCreation(repo, { title: "Original private title" }, { useDefaultAssignee: false })
    if (!prepared.ok) throw new Error(prepared.error)
    const task = await repo.createWorkCommand(prepared.task)
    if (!task.ok) throw new Error(task.errorCode)
    await ensureAgentTokenSchema()
    const mint = async (name: string, scopes: AgentScope[]) => {
      const credential = generateAgentToken(), id = crypto.randomUUID()
      await createAgentToken({ id, name, tokenHash: credential.tokenHash, tokenPrefix: credential.tokenPrefix, scopes }, await currentBoardScope(db, board, owner))
      return { ...credential, id }
    }
    const writer = await mint("Codex fixture", ["tasks:write"]), reader = await mint("Activity reader", ["tasks:read"])
    const context = async (credential: typeof writer, body?: unknown) => {
      const url = new URL(`http://localhost/api/tasks/${task.task.id}${body === undefined ? "/activity" : ""}`)
      const request = new Request(url, { method: body === undefined ? "GET" : "PUT", headers: {
        "Content-Type": "application/json", Authorization: `Bearer ${credential.token}`, "X-Meitheal-Board-Id": board, "X-Meitheal-Board-Session": boardSessionProof(owner.id),
        "X-Agent-Id": "unverified-id", "X-Meitheal-Origin-Kind": "mcp", "X-Meitheal-Origin-Name": "Pretend Owner",
      }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
      const agentToken = await resolveAgentAuth(request)
      if (!agentToken) throw new Error("Credential required")
      // Even stale or caller-supplied attribution metadata is not the stored identity.
      agentToken.tokenName = "Supplied false display"
      return { url, request, params: { id: task.task.id }, locals: { agentToken } } as unknown as Parameters<typeof updateTask>[0]
    }
    const first = await updateTask(await context(writer, { status: "active", title: "New private title", actor: "Pretend Owner" }))
    expect(first.status, await first.clone().text()).toBe(200)
    const acknowledgement = await first.json(); expect(acknowledgement.id).toBe(task.task.id)
    expect(JSON.stringify(acknowledgement)).not.toContain("private title")
    const history = await readActivity(await context(reader))
    expect(history.status).toBe(200)
    const body = await history.json(), status = body.activity.filter((row: { field: string }) => row.field === "status")
    expect(status).toEqual([expect.objectContaining({ field: "status", event_type: "status_change", old_value: "pending", new_value: "active", actor: "Codex fixture", actor_type: "agent", summary: "status: pending → active" })])
    expect(body.activity.filter((row: { field: string }) => row.field === "title")).toEqual([expect.objectContaining({ event_type: "field_change", old_value: "Original private title", new_value: "New private title", actor: "Codex fixture", summary: "title: Original private title → New private title" })])
    expect(body.activity.some((row: { field: string }) => row.field === "activity")).toBe(false)
    const publicText = JSON.stringify(body)
    for (const secret of [writer.id, writer.token, writer.tokenHash, writer.tokenPrefix, "originKind", "originName", "tokenName", "Supplied false display", "Pretend Owner", "unverified-id"]) expect(publicText).not.toContain(secret)
    expect((await readActivity(await context(writer))).status).toBe(403)
    const scope = await currentBoardScope(db, board, owner), feed = await readRecentActivity(db, scope, {})
    expect(feed.items).toHaveLength(1); expect(feed.items[0]?.provenance?.tokenName).toBe("Codex fixture")
    const feedRow = (await db.execute("SELECT event_type,actor,summary FROM task_activity_log WHERE task_id=? AND field='activity'", [task.task.id])).rows
    expect(feedRow).toMatchObject([{ event_type: "status_change", actor: "Codex fixture" }])
    expect(String(feedRow[0]?.summary)).not.toContain(writer.id)
    const before = (await db.execute("SELECT COUNT(*) AS total FROM task_activity_log WHERE task_id=?", [task.task.id])).rows
    expect((await updateTask(await context(writer, { status: "active", title: "New private title" }))).status).toBe(200)
    expect((await db.execute("SELECT COUNT(*) AS total FROM task_activity_log WHERE task_id=?", [task.task.id])).rows).toEqual(before)
    // Later credential renaming cannot rewrite an earlier event's display snapshot.
    await db.execute("UPDATE agent_tokens SET name='Renamed fixture' WHERE id=?", [writer.id])
    expect((await updateTask(await context(writer, { status: "complete" }))).status).toBe(200)
    const final = await (await readActivity(await context(reader))).json()
    expect(final.activity.filter((row: { event_type: string }) => row.event_type === "status_change")).toEqual([
      expect.objectContaining({ actor: "Renamed fixture", old_value: "active", new_value: "complete" }),
      expect.objectContaining({ actor: "Codex fixture", old_value: "pending", new_value: "active" }),
    ])
  })
})
