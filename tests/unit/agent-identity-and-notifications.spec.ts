import { createServer } from "node:http"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import type { AgentScope } from "../../packages/domain-auth/src/agent-tokens"
import { notifyAgentComment } from "../../apps/web/src/domains/notifications/agent-comment"
import { SettingsRepository } from "../../apps/web/src/domains/tasks/persistence/settings-repository"
import { ensureSchema, getPersistenceClient, resetPersistenceForTests } from "../../apps/web/src/domains/tasks/persistence/store"
import { UserRepository } from "../../apps/web/src/domains/tasks/persistence/user-repository"
import { checkAssignedTask } from "../../apps/web/src/lib/agent-token-guard"
import { getA2aTask, listA2aTasks } from "../../apps/web/src/lib/a2a-tasks"
import { parseTicketKey } from "../../apps/web/src/lib/ticket-key"
import { resetWebhookCacheForTests } from "../../apps/web/src/lib/webhook-dispatcher"
import { POST as a2aMessagePost } from "../../apps/web/src/pages/api/a2a/message"

test("notifyAgentComment includes comment_id and content in webhook events and isolates webhook failures", async () => {
  const dir = await mkdtemp(join(tmpdir(), "meitheal-notify-unit-"))
  const prevDbUrl = process.env.MEITHEAL_DB_URL
  const prevSup = process.env.SUPERVISOR_TOKEN
  const delivered: Array<{ eventType: string; payload: Record<string, unknown> }> = []

  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on("data", chunk => chunks.push(Buffer.from(chunk)))
    req.on("end", () => {
      delivered.push(JSON.parse(Buffer.concat(chunks).toString("utf-8")) as {
        eventType: string
        payload: Record<string, unknown>
      })
      res.writeHead(200, { "content-type": "application/json" })
      res.end('{"ok":true}')
    })
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  const address = server.address() as { port: number }

  try {
    delete process.env.SUPERVISOR_TOKEN
    process.env.MEITHEAL_DB_URL = `file:${join(dir, "notify.db")}`
    resetPersistenceForTests()
    resetWebhookCacheForTests()
    await ensureSchema()

    const client = getPersistenceClient()
    const settings = new SettingsRepository(client)
    await settings.ensureSettingsTable()
    await settings.upsert("webhook_endpoint", JSON.stringify(`http://127.0.0.1:${address.port}/hook`))
    await settings.upsert("notification_preferences", JSON.stringify({ enabled: false }))

    const now = Date.now()
    await client.execute({
      sql: "INSERT INTO tasks (id, title, status, idempotency_key, request_id, ticket_number, created_at, updated_at) VALUES (?, ?, 'pending', ?, ?, ?, ?, ?)",
      args: ["task-notify-unit-1", "Check boiler pressure", "k1", "r1", 7, now, now],
    })

    await notifyAgentComment("task-notify-unit-1", {
      id: 42,
      author: "Automation: Claude",
      content: "Pressure checked and steady.",
    })

    await expect.poll(() => delivered.length).toBe(1)
    expect(delivered[0]).toMatchObject({
      eventType: "task.commented",
      payload: {
        id: "task-notify-unit-1",
        comment_id: 42,
        author: "Automation: Claude",
        content: "Pressure checked and steady.",
        ticket_key: "MTH-7",
        comment: { id: 42, author: "Automation: Claude", excerpt: "Pressure checked and steady.", by_agent: true },
      },
    })

    // String signature stays compatible for callers without a comment ID.
    await notifyAgentComment("task-notify-unit-1", "Codex", "Second opinion")
    await expect.poll(() => delivered.length).toBe(2)
    expect(delivered[1]?.payload).toMatchObject({
      author: "Codex",
      content: "Second opinion",
      comment: { author: "Codex", excerpt: "Second opinion", by_agent: true },
    })
    expect(delivered[1]?.payload).not.toHaveProperty("comment_id")

    // Closed webhook endpoint must never cause notifyAgentComment to throw.
    await new Promise<void>(resolve => server.close(() => resolve()))
    await notifyAgentComment("task-notify-unit-1", { id: 43, author: "Automation: Claude", content: "No throw" })
  } finally {
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
    getPersistenceClient().close()
    resetPersistenceForTests()
    resetWebhookCacheForTests()
    if (prevDbUrl === undefined) delete process.env.MEITHEAL_DB_URL
    else process.env.MEITHEAL_DB_URL = prevDbUrl
    if (prevSup !== undefined) process.env.SUPERVISOR_TOKEN = prevSup
    await rm(dir, { recursive: true, force: true })
  }
})

test("A2A task helpers resolve ticket keys, paginate past 200 rows, and enforce statusTimestampAfter before paging", async () => {
  const dir = await mkdtemp(join(tmpdir(), "meitheal-a2a-unit-"))
  const prevDbUrl = process.env.MEITHEAL_DB_URL

  try {
    process.env.MEITHEAL_DB_URL = `file:${join(dir, "a2a.db")}`
    resetPersistenceForTests()
    await ensureSchema()

    const client = getPersistenceClient()
    const users = new UserRepository(client)
    await users.createCustomUser("custom_agent_a2a", "Claude", "#6366f1", "agent")
    await users.createCustomUser("custom_human_other", "Aoife", "#f59e0b", "human")

    const settings = new SettingsRepository(client)
    await settings.ensureSettingsTable()
    await settings.upsert("agent-protocols-a2a-enabled", "true")

    const baseTime = 1_700_000_000_000
    for (let i = 0; i < 205; i++) {
      const ts = baseTime + i * 1000
      const id = i === 17 ? "a2a-task-17" : `a2a-task-${i}`
      const ticketNumber = i === 17 ? 17 : null
      await client.execute({
        sql: "INSERT INTO tasks (id, title, status, idempotency_key, request_id, ticket_number, assigned_to, created_at, updated_at) VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?)",
        args: [id, `Agent Task ${i}`, `k-${i}`, `r-${i}`, ticketNumber, "custom_agent_a2a", ts, ts],
      })
    }
    await client.execute({
      sql: "INSERT INTO tasks (id, title, status, idempotency_key, request_id, assigned_to, created_at, updated_at) VALUES (?, ?, 'complete', ?, ?, ?, ?, ?)",
      args: ["a2a-done", "Done task", "k-done", "r-done", "custom_agent_a2a", baseTime + 300_000, baseTime + 300_000],
    })
    await client.execute({
      sql: "INSERT INTO tasks (id, title, status, idempotency_key, request_id, assigned_to, created_at, updated_at) VALUES (?, ?, 'pending', ?, ?, ?, ?, ?)",
      args: ["a2a-other", "Other task", "k-other", "r-other", "custom_human_other", baseTime + 301_000, baseTime + 301_000],
    })

    const agent = {
      tokenId: "tok-1",
      tokenName: "Claude",
      scopes: ["a2a:execute", "search:read", "tasks:read"] as AgentScope[],
      assigneeId: "custom_agent_a2a",
    }

    expect(parseTicketKey("MTH-abc")).toBeNull()
    expect(parseTicketKey(`MTH-${"9".repeat(320)}`)).toBeNull()

    const byKey = await getA2aTask(agent, "MTH-17", "http://127.0.0.1")
    expect(byKey).toMatchObject({ id: "a2a-task-17", metadata: { ticket_key: "MTH-17" } })
    expect(await getA2aTask(agent, "missing-task", "http://127.0.0.1")).toBeNull()
    expect(await getA2aTask(agent, "MTH-abc", "http://127.0.0.1")).toBeNull()
    expect(await getA2aTask(agent, `MTH-${"9".repeat(320)}`, "http://127.0.0.1")).toBeNull()
    expect(await checkAssignedTask("MTH-abc", agent)).toBeNull()
    expect(await checkAssignedTask(`MTH-${"9".repeat(320)}`, agent)).toBeNull()

    const badKeyGetRes = await a2aMessagePost({
      request: new Request("http://127.0.0.1/api/a2a/message", {
        method: "POST",
        headers: { "content-type": "application/json", "A2A-Version": "1.0" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 99,
          method: "GetTask",
          params: { id: "MTH-abc" },
        }),
      }),
      locals: { agentToken: agent, ingressPath: "" },
      url: new URL("http://127.0.0.1/api/a2a/message"),
    } as unknown as Parameters<typeof a2aMessagePost>[0])
    const badKeyGetJson = await badKeyGetRes.json()
    expect(badKeyGetJson.error.code).toBe(-32001)

    const page1 = await listA2aTasks(agent, "http://127.0.0.1", { pageSize: 50, offset: 0, includeArtifacts: false })
    expect(page1.totalSize).toBe(205)
    expect(page1.tasks).toHaveLength(50)
    expect(page1.nextPageToken).toBe("50")

    const afterCutoff = new Date(baseTime + 202 * 1000).toISOString()
    const filteredRes = await a2aMessagePost({
      request: new Request("http://127.0.0.1/api/a2a/message", {
        method: "POST",
        headers: { "content-type": "application/json", "A2A-Version": "1.0" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "ListTasks",
          params: { statusTimestampAfter: afterCutoff },
        }),
      }),
      locals: { agentToken: agent, ingressPath: "" },
      url: new URL("http://127.0.0.1/api/a2a/message"),
    } as unknown as Parameters<typeof a2aMessagePost>[0])
    const filteredJson = await filteredRes.json()
    expect(filteredJson.result.totalSize).toBe(2)
    expect(filteredJson.result.nextPageToken).toBe("")
    expect(filteredJson.result.tasks.map((t: { id: string }) => t.id)).toEqual(["a2a-task-204", "a2a-task-203"])

    for (const invalidTimestamp of ["not-a-timestamp", "1", "2026-02-30T00:00:00Z"]) {
      const badTsRes = await a2aMessagePost({
        request: new Request("http://127.0.0.1/api/a2a/message", {
          method: "POST",
          headers: { "content-type": "application/json", "A2A-Version": "1.0" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            method: "ListTasks",
            params: { statusTimestampAfter: invalidTimestamp },
          }),
        }),
        locals: { agentToken: agent, ingressPath: "" },
        url: new URL("http://127.0.0.1/api/a2a/message"),
      } as unknown as Parameters<typeof a2aMessagePost>[0])
      const badTsJson = await badTsRes.json()
      expect(badTsJson.error.code).toBe(-32602)
    }
  } finally {
    getPersistenceClient().close()
    resetPersistenceForTests()
    if (prevDbUrl === undefined) delete process.env.MEITHEAL_DB_URL
    else process.env.MEITHEAL_DB_URL = prevDbUrl
    await rm(dir, { recursive: true, force: true })
  }
})
