import { execFileSync, fork } from "../helpers/isolated-process"
import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, test } from "@playwright/test"
import { resolveAgentRouteAccess } from "../../packages/domain-auth/src/agent-route-policy"

import { currentBoardWriteHeaders } from "../helpers/current-board-http"

test("the assigned-only grant covers single-task changes and nothing wider", () => {
  const assigned = ["tasks:read", "tasks:write:assigned"] as const
  const access = (path: string, method: string) => resolveAgentRouteAccess(path, method, [...assigned])
  for (const [path, method] of [
    ["/api/tasks/abc-123", "PUT"], ["/api/tasks/MTH-7", "PATCH"],
    ["/api/tasks/abc-123/comments", "POST"], ["/api/tasks/abc-123/time", "POST"],
    ["/api/tasks/abc-123/links", "POST"], ["/api/tasks/abc-123/links", "DELETE"],
    ["/api/tasks/abc-123/deferral", "PATCH"], ["/api/tasks/abc-123/comments/4", "PATCH"],
  ] as const) {
    expect(access(path, method), `${method} ${path}`).toMatchObject({ allowed: true, assignedTaskId: path.split("/")[3] })
  }
  for (const [path, method] of [
    ["/api/tasks", "POST"], ["/api/tasks/create", "POST"], ["/api/tasks/reorder", "POST"],
    ["/api/tasks/abc-123", "DELETE"], ["/api/tasks/abc-123/duplicate", "POST"],
    ["/api/tasks/abc-123/comments/4", "DELETE"],
    ["/api/tasks/abc-123/reactions", "POST"], ["/api/nfc/complete", "POST"],
    ["/api/projects", "POST"], ["/api/settings", "PUT"], ["/api/agent-tokens", "POST"],
  ] as const) {
    expect(access(path, method).allowed, `${method} ${path}`).toBe(false)
  }
  // Reads keep their own scope and need no assignment check.
  expect(access("/api/tasks/abc-123", "GET")).toEqual({ scope: "tasks:read", allowed: true })
  // The full write grant is never narrowed by also holding the assigned-only one.
  expect(resolveAgentRouteAccess("/api/tasks/abc-123", "PUT", ["tasks:write", "tasks:write:assigned"]))
    .toEqual({ scope: "tasks:write", allowed: true })
  expect(resolveAgentRouteAccess("/api/tasks/abc-123", "PUT", ["tasks:read"]).allowed).toBe(false)
})

test("an agent assignee reads, answers, updates and hands back only its own tasks over MCP", async ({ playwright }) => {
  test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires a built App and disposable ingress")
  const work = await mkdtemp(join(tmpdir(), "meitheal-mcp-assignee-"))
  const web = fileURLToPath(new URL("../../apps/web", import.meta.url))
  const env = { PATH: process.env.PATH, NODE_ENV: "production", MEITHEAL_DB_URL: `file:${join(work, "assignee.db")}`, MEITHEAL_TEST_CORE_USER_LOOKUP: "1" }
  const api = await playwright.request.newContext({ extraHTTPHeaders: {} })
  const agentApi = await playwright.request.newContext({ extraHTTPHeaders: {} })
  let child: ReturnType<typeof fork> | undefined
  try {
    execFileSync(process.execPath, ["scripts/migrate.mjs"], { cwd: web, env })
    child = fork(fileURLToPath(new URL("../scripts/feedback-ingress-fixture.mjs", import.meta.url)), { cwd: web, env, stdio: ["ignore", "ignore", "inherit", "ipc"] })
    const [info] = await once(child, "message", { signal: AbortSignal.timeout(10_000) })
    const origin = `http://127.0.0.1:${info.port}`
    const base = origin + info.configuredPath
    const admin = await currentBoardWriteHeaders(api, "household", { origin, cookie: "feedback-fixture=admin" }, base)

    const createAssignee = async (name: string, kind?: string) => {
      const response = await api.post(base + "/api/users/custom", { headers: admin, data: { name, ...(kind ? { kind } : {}) } })
      expect(response.status(), await response.text()).toBe(201)
      return (await response.json()) as { id: string; kind: string }
    }
    const claude = await createAssignee("Claude", "agent")
    const codex = await createAssignee("Codex", "agent")
    const person = await createAssignee("Aoife")
    expect(claude.kind).toBe("agent")
    expect(person.kind).toBe("human")
    expect((await api.post(base + "/api/users/custom", { headers: admin, data: { name: "Robot", kind: "bot" } })).status()).toBe(400)

    const listed = await (await api.get(base + "/api/users", { headers: admin })).json()
    expect(listed.users).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: claude.id, kind: "agent" }),
      expect.objectContaining({ id: person.id, kind: "human" }),
    ]))

    const agentScopes = ["mcp:execute", "tasks:read", "tasks:write:assigned", "search:read"]
    const enroll = (data: Record<string, unknown>) => api.post(base + "/api/agent-tokens", { headers: admin, data })
    // A token can only act as an agent, and the assigned-only grant needs one.
    expect((await enroll({ name: "As a person", scopes: agentScopes, assigneeId: person.id })).status()).toBe(400)
    expect((await enroll({ name: "As nobody", scopes: agentScopes })).status()).toBe(400)
    expect((await enroll({ name: "As unknown", scopes: ["mcp:execute"], assigneeId: "custom_missing" })).status()).toBe(400)

    const token = async (name: string, scopes: string[], assigneeId?: string) => {
      const response = await enroll({ name, scopes, ...(assigneeId ? { assigneeId } : {}) })
      expect(response.status(), await response.text()).toBe(201)
      const body = await response.json()
      expect(body.assigneeId).toBe(assigneeId ?? null)
      return { authorization: `Bearer ${body.token}`, "content-type": "application/json", "x-meitheal-board-id": "household" }
    }
    const claudeToken = await token("Claude", agentScopes, claude.id)
    expect((await agentApi.get(base + "/api/tasks", { headers: claudeToken })).status()).toBe(403)
    const codexToken = await token("Codex", agentScopes, codex.id)
    const writeOnlyToken = await token("WriteOnly", ["mcp:execute", "tasks:write:assigned"], claude.id)
    const automation = await token("n8n", ["mcp:execute", "tasks:read", "tasks:write"])
    const tokens = await (await api.get(base + "/api/agent-tokens", { headers: admin })).json()
    expect(tokens).toEqual(expect.arrayContaining([expect.objectContaining({ name: "Claude", assigneeId: claude.id })]))

    const call = async (headers: Record<string, string>, name: string, args: Record<string, unknown> = {}) => {
      const response = await agentApi.post(origin + "/api/mcp", { headers, data: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } } })
      expect(response.status()).toBe(200)
      const body = await response.json()
      if (body.error) return { failed: true, message: String(body.error.message), data: null as never }
      return { failed: body.result.isError === true, message: "", data: JSON.parse(body.result.content[0].text) }
    }
    const newTask = async (title: string, assigned_to: string | null) => {
      const response = await agentApi.post(origin + "/api/tasks", { headers: automation, data: { title, ...(assigned_to ? { assigned_to } : {}) } })
      expect(response.status(), await response.text()).toBe(201)
      return (await response.json()).id as string
    }
    const mine = await newTask("Draft the heating schedule", claude.id)
    const done = await newTask("Already finished", claude.id)
    const theirs = await newTask("Review the garden plan", codex.id)
    const household = await newTask("Buy oat milk", person.id)
    expect((await agentApi.put(origin + `/api/tasks/${done}`, { headers: automation, data: { status: "complete" } })).status()).toBe(200)

    // Tools: identity tools are offered, creating and deleting are not.
    const toolList = await agentApi.post(origin + "/api/mcp", { headers: claudeToken, data: { jsonrpc: "2.0", id: 1, method: "tools/list" } })
    const tools = ((await toolList.json()).result.tools as Array<{ name: string }>).map(tool => tool.name)
    expect(tools).toEqual(expect.arrayContaining(["whoAmI", "listMyTasks", "handBackTask", "completeTask", "updateTask", "getTask"]))
    expect(tools).not.toContain("createTask")
    expect(tools).not.toContain("deleteTask")

    const writeOnlyTools = ((await (await agentApi.post(origin + "/api/mcp", {
      headers: writeOnlyToken,
      data: { jsonrpc: "2.0", id: 2, method: "tools/list" },
    })).json()).result.tools as Array<{ name: string }>).map(tool => tool.name)
    expect(writeOnlyTools).toEqual(expect.arrayContaining(["whoAmI", "completeTask", "handBackTask"]))
    expect(writeOnlyTools).not.toContain("getTask")
    expect(writeOnlyTools).not.toContain("listTasks")
    expect(writeOnlyTools).not.toContain("listMyTasks")

    const identity = await call(claudeToken, "whoAmI")
    expect(identity.data).toMatchObject({ token_name: "Claude", assignee: { id: claude.id, name: "Claude" }, can_change: "assigned_tasks" })
    expect((await call(automation, "whoAmI")).data).toMatchObject({ assignee: null, can_change: "any_task" })
    expect((await call(automation, "listMyTasks")).failed).toBe(true)

    // "My tasks" comes from the credential. An assigned_to argument cannot widen it.
    const open = await call(claudeToken, "listMyTasks", { assigned_to: codex.id })
    expect(open.failed).toBe(false)
    expect(open.data.tasks.map((task: { id: string }) => task.id)).toEqual([mine])
    const all = await call(claudeToken, "listMyTasks", { include_completed: true })
    expect(all.data.tasks.map((task: { id: string }) => task.id).sort()).toEqual([mine, done].sort())
    expect((await call(codexToken, "listMyTasks")).data.tasks.map((task: { id: string }) => task.id)).toEqual([theirs])
    const archived = await newTask("Archived old chore", claude.id)
    expect((await agentApi.put(origin + `/api/tasks/${archived}`, { headers: automation, data: { status: "complete" } })).status()).toBe(200)
    expect((await api.post(base + "/api/tasks/clear-completed", { headers: admin, data: {} })).status()).toBe(200)
    expect(await (await agentApi.get(origin + `/api/tasks/${archived}`, { headers: automation })).json()).toMatchObject({ status: "archived" })
    expect((await call(claudeToken, "listMyTasks")).data.tasks.map((task: { id: string }) => task.id)).toEqual([mine])

    // A task's own status survives the MCP wrapper.
    const read = await call(claudeToken, "getTask", { id: mine })
    expect(read.data).toMatchObject({ id: mine, status: "pending", assigned_to: claude.id })
    // The task was created already assigned, by a route that never sets the owner.
    expect(read.data.owner).toBe("bot:Claude")

    // The agent may change its own task and nobody else's.
    const updated = await call(claudeToken, "updateTask", { id: mine, status: "active" })
    expect(updated.failed).toBe(false)
    expect(updated.data).toMatchObject({ id: mine, status: "active" })
    for (const other of [theirs, household]) {
      expect((await call(claudeToken, "updateTask", { id: other, title: "Hijacked" })).failed).toBe(true)
      expect((await call(claudeToken, "completeTask", { id: other })).failed).toBe(true)
      const denied = await agentApi.put(origin + `/api/tasks/${other}`, { headers: claudeToken, data: { title: "Hijacked" } })
      expect(denied.status()).toBe(404)
      expect(await denied.json()).toEqual({ error: "Task not found" })
      const deniedComment = await agentApi.post(origin + `/api/tasks/${other}/comments`, { headers: claudeToken, data: { content: "Not mine" } })
      expect(deniedComment.status()).toBe(404)
      expect(await deniedComment.json()).toMatchObject({ status: 404, detail: "Task not found." })
      const retainedComments = await (await agentApi.get(origin + `/api/tasks/${other}/comments`, { headers: automation })).json()
      expect(retainedComments.comments.map((entry: { content: string }) => entry.content)).not.toContain("Not mine")
      const kept = await (await agentApi.get(origin + `/api/tasks/${other}`, { headers: claudeToken })).json()
      expect(kept.title).not.toBe("Hijacked")
    }
    expect((await agentApi.post(origin + "/api/tasks", { headers: claudeToken, data: { title: "Not allowed" } })).status()).toBe(403)
    expect((await agentApi.delete(origin + `/api/tasks/${mine}`, { headers: claudeToken })).status()).toBe(403)

    // The agent answers on its task, and its changes are named in the history.
    const comment = await agentApi.post(origin + `/api/tasks/${mine}/comments`, { headers: claudeToken, data: { content: "Schedule drafted. Two questions inside." } })
    expect(comment.status(), await comment.text()).toBe(201)
    expect((await comment.json()).author).toBe("Automation: Claude")
    const history = await call(claudeToken, "getTaskActivity", { id: mine })
    expect(history.data.activity).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "status", new_value: "active", actor: "Claude", actor_type: "agent" }),
    ]))

    // Handing back returns the task to whoever held it before, with the note attached.
    expect((await agentApi.put(origin + `/api/tasks/${household}`, { headers: automation, data: { assigned_to: claude.id } })).status()).toBe(200)
    expect((await call(claudeToken, "handBackTask", { id: theirs })).failed).toBe(true)
    const returned = await call(claudeToken, "handBackTask", {
      id: household,
      note: "This needs a person at the shop.",
      request_id: "handback-household-1",
    })
    expect(returned.failed).toBe(false)
    expect(returned.data).toMatchObject({ id: household, handed_back_to: person.id, note_posted: true })
    // Retrying handBackTask with the same request_id replays the original receipt without duplicating the comment.
    const retried = await call(claudeToken, "handBackTask", {
      id: household,
      note: "This needs a person at the shop.",
      request_id: "handback-household-1",
    })
    expect(retried.failed).toBe(false)
    expect(retried.data).toEqual(returned.data)
    const after = await (await agentApi.get(origin + `/api/tasks/${household}`, { headers: automation })).json()
    expect(after.assigned_to).toBe(person.id)
    expect(after.owner).toBe("human")
    const notes = await (await agentApi.get(origin + `/api/tasks/${household}/comments`, { headers: automation })).json()
    expect(notes.comments.filter((c: { content: string }) => c.content.includes("needs a person"))).toHaveLength(1)
    expect(notes.comments.at(-1)).toMatchObject({ author: "Claude", content: expect.stringContaining("needs a person") })
    // Once handed back it is no longer the agent's to change.
    expect((await call(claudeToken, "completeTask", { id: household })).failed).toBe(true)

    // A task created for the agent has no earlier holder: it goes to the default assignee.
    const fresh = await newTask("Summarise the boiler manual", claude.id)
    expect((await api.put(base + "/api/users/default", { headers: { ...admin, "content-type": "application/json" }, data: { user_id: person.id } })).status()).toBe(200)
    expect((await call(claudeToken, "handBackTask", { id: fresh })).data).toMatchObject({ handed_back_to: person.id })

    // A task cannot be handed to someone who does not exist, and the note is not posted for nothing.
    const nobody = await call(claudeToken, "handBackTask", { id: mine, note: "Over to you.", to: "custom_nobody" })
    expect(nobody.failed).toBe(true)
    expect((await call(claudeToken, "getTask", { id: mine })).data.assigned_to).toBe(claude.id)
    const kept = await (await agentApi.get(origin + `/api/tasks/${mine}/comments`, { headers: automation })).json()
    expect(kept.comments.map((entry: { content: string }) => entry.content).join(" ")).not.toContain("Over to you.")

    // Known-task handback is a command, not a task-read upgrade.
    const blind = await newTask("Private no-read handback", claude.id)
    const blindArgs = { id: blind, to: null, request_id: "blind-handback-1" }
    const blindReceipt = await call(writeOnlyToken, "handBackTask", blindArgs)
    expect(blindReceipt.failed).toBe(false)
    expect(blindReceipt.data).toMatchObject({ id: blind, handed_back_to: null, note_posted: false })
    expect(Object.keys(blindReceipt.data).sort()).toEqual(["handed_back_to", "id", "note_posted", "ticket_key"])
    expect((await call(writeOnlyToken, "handBackTask", blindArgs)).data).toEqual(blindReceipt.data)
    expect((await call(writeOnlyToken, "getTask", { id: blind })).failed).toBe(true)
    expect(JSON.stringify(blindReceipt.data)).not.toContain("Private no-read handback")

    const unassigned = await call(claudeToken, "handBackTask", { id: mine, to: null })
    expect(unassigned.data).toMatchObject({ id: mine, handed_back_to: null, note_posted: false })
    expect((await call(claudeToken, "listMyTasks")).data.tasks).toEqual([])

    // Removing the assignee detaches its token and leaves no task identity behind.
    const removed = await api.delete(base + `/api/users/custom?id=${codex.id}`, { headers: { ...admin, "content-type": "application/json" } })
    expect(removed.status(), await removed.text()).toBe(200)
    expect((await call(codexToken, "whoAmI")).data.assignee).toBeNull()
    expect((await call(codexToken, "listMyTasks")).failed).toBe(true)
    expect((await agentApi.put(origin + `/api/tasks/${theirs}`, { headers: codexToken, data: { title: "Orphaned" } })).status()).toBe(403)

    // An MCP client that connects without a token is challenged, not sent a CSRF error.
    const probe = await agentApi.post(origin + "/api/mcp", { headers: { "content-type": "application/json" }, data: { jsonrpc: "2.0", id: 1, method: "initialize", params: {} } })
    expect(probe.status()).toBe(401)
    expect(probe.headers()["www-authenticate"]).toContain("Bearer")
  } finally {
    await agentApi.dispose()
    await api.dispose()
    if (child && child.exitCode === null) {
      const stopped = once(child, "exit")
      child.kill("SIGTERM")
      await stopped
    }
    await rm(work, { recursive: true, force: true })
  }
})
