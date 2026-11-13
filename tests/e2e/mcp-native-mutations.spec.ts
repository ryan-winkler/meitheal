import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test, type APIRequestContext } from "@playwright/test"
import { startCoreFixture } from "../scripts/task-pins-fixture"

test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires the built App and authenticated Core fixture")

test("generated scoped MCP updates only the NFC field and then reorders the native tasks", async ({ playwright }) => {
  const work = await mkdtemp(join(tmpdir(), "meitheal-mcp-native-pair-"))
  // The App's native loopback is HTTP even when external HA ingress uses HTTPS.
  const child = startCoreFixture(work, true)
  child.stdout?.resume()
  child.stderr?.resume()
  let bootstrap: APIRequestContext | undefined
  let agent: APIRequestContext | undefined
  try {
    const [info] = await once(child, "message", { signal: AbortSignal.timeout(10_000) })
    const origin = `http://127.0.0.1:${info.port}`
    const path = (value: string) => info.configuredPath + value
    bootstrap = await playwright.request.newContext({ baseURL: origin, extraHTTPHeaders: { origin } })
    const enrollment = await bootstrap.post(path("/api/agent-tokens"), { headers: { cookie: "feedback-fixture=admin" }, data: {
      name: "Native MCP pair fixture", scopes: ["mcp:execute", "tasks:read", "tasks:write", "search:read", "projects:read", "projects:write"],
    } })
    expect(enrollment.status()).toBe(201)
    const { token } = await enrollment.json()
    const deleteEnrollment = await bootstrap.post(path("/api/agent-tokens"), { headers: { cookie: "feedback-fixture=admin" }, data: {
      name: "Native MCP retention fixture", scopes: ["mcp:execute", "tasks:delete"],
    } })
    expect(deleteEnrollment.status()).toBe(201)
    const { token: deleteToken } = await deleteEnrollment.json()
    await bootstrap.dispose()
    bootstrap = undefined
    agent = await playwright.request.newContext({ baseURL: origin,
      extraHTTPHeaders: { authorization: `Bearer ${token}`, origin, "content-type": "application/json" } })
    const api = agent
    const rpc = async (method: string, params?: Record<string, unknown>) => {
      const response = await api.post(path("/api/mcp"), { data: { jsonrpc: "2.0", id: 1, method, params } })
      expect(response.status()).toBe(200)
      const body = await response.json()
      expect(body.error).toBeUndefined()
      return body.result
    }
    const ids: string[] = []
    for (const title of ["Keep NFC task title", "Second MCP order task"]) {
      const created = await api.post(path("/api/tasks"), { data: { title } })
      expect(created.status()).toBe(201)
      ids.push((await created.json()).id)
    }
    const tools = (await rpc("tools/list")).tools
    expect(tools.some((tool: { name: string }) => tool.name === "updateTask")).toBe(true)
    expect(tools.some((tool: { name: string }) => tool.name === "reorderTasks")).toBe(true)
    const linkTool = tools.find((tool: { name: string }) => tool.name === "linkTask")
    expect(linkTool.inputSchema.required).toEqual(expect.arrayContaining(["id", "target_task_id", "link_type"]))
    const unlinkTool = tools.find((tool: { name: string }) => tool.name === "unlinkTask")
    expect(unlinkTool.inputSchema.required).toEqual(expect.arrayContaining(["id", "link_id"]))
    const searchTool = tools.find((tool: { name: string }) => tool.name === "searchTasks")
    expect(searchTool.description).not.toContain("scope=all")
    const linked = await rpc("tools/call", {
      name: "linkTask",
      arguments: { id: ids[0], target_task_id: ids[1], link_type: "blocks" },
    })
    expect(linked.isError).toBe(false)
    const { id: linkId } = JSON.parse(linked.content[0].text)
    expect(linkId).toBeTruthy()
    const linksList = await rpc("tools/call", { name: "getTaskLinks", arguments: { id: ids[0] } })
    expect(linksList.isError).toBe(false)
    expect(JSON.parse(linksList.content[0].text).outbound).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: linkId, target_task_id: ids[1], link_type: "blocks" })]),
    )
    const unlinked = await rpc("tools/call", { name: "unlinkTask", arguments: { id: ids[0], link_id: linkId } })
    expect(unlinked.isError).toBe(false)
    expect(JSON.parse(unlinked.content[0].text)).toMatchObject({ deleted: true })
    const updated = await rpc("tools/call", { name: "updateTask", arguments: { id: ids[0], nfc_tag_id: "mcp-pair-tag" } })
    expect(updated.isError).toBe(false)
    expect(JSON.parse(updated.content[0].text)).toMatchObject({ id: ids[0], title: "Keep NFC task title", nfc_tag_id: "mcp-pair-tag" })
    const order = [ids[1], ids[0]]
    const reordered = await rpc("tools/call", { name: "reorderTasks", arguments: { ordered_ids: order } })
    expect(reordered.isError).toBe(false)
    expect(JSON.parse(reordered.content[0].text)).toMatchObject({ ok: true })
    const persisted = await api.get(path("/api/tasks?sort=kanban_position&order=asc"))
    expect(persisted.status()).toBe(200)
    const tasks = (await persisted.json()).tasks
    expect(tasks.map((task: { id: string }) => task.id)).toEqual(order)
    expect(tasks.find((task: { id: string }) => task.id === ids[0])).toMatchObject({ title: "Keep NFC task title", nfc_tag_id: "mcp-pair-tag" })
    const completed = await rpc("tools/call", { name: "completeTask", arguments: { id: ids[1] } })
    expect(completed.isError).toBe(false)
    for (const status of ["done", "complete"]) {
      const doneSearch = await rpc("tools/call", { name: "searchTasks", arguments: { q: "Second MCP order task", status } })
      expect(doneSearch.isError).toBe(false)
      expect(JSON.parse(doneSearch.content[0].text)).toMatchObject({ count: 1, tasks: [{ id: ids[1], status: "complete" }] })
    }
    const excludedDone = await rpc("tools/call", { name: "searchTasks", arguments: { q: "Second MCP order task", status: "done", include_completed: false } })
    expect(excludedDone.isError).toBe(false)
    expect(JSON.parse(excludedDone.content[0].text).count).toBe(0)

    const missingArgs = await rpc("tools/call", { name: "completeTask", arguments: {} })
    expect(missingArgs.isError).toBe(true)
    const missingTitle = await rpc("tools/call", { name: "completeTask", arguments: { title: "No such MCP task" } })
    expect(missingTitle.isError).toBe(true)
    for (const _ of [0, 1]) {
      expect((await api.post(path("/api/tasks"), { data: { title: "Ambiguous MCP title" } })).status()).toBe(201)
    }
    const ambiguous = await rpc("tools/call", { name: "completeTask", arguments: { title: "  Ambiguous MCP title  " } })
    expect(ambiguous.isError).toBe(true)
    expect(JSON.parse(ambiguous.content[0].text).error).toContain("Multiple tasks have that title")

    const createdProject = await rpc("tools/call", { name: "createProject", arguments: { title: "MCP Project" } })
    expect(createdProject.isError).toBe(false)
    const projectPayload = JSON.parse(createdProject.content[0].text)
    expect(projectPayload).toMatchObject({ title: "MCP Project", status: "active" })
    const updatedProject = await rpc("tools/call", { name: "updateProject", arguments: { id: projectPayload.id, title: "MCP Project Updated" } })
    expect(updatedProject.isError).toBe(false)
    expect(JSON.parse(updatedProject.content[0].text)).toMatchObject({ id: projectPayload.id, title: "MCP Project Updated" })

    expect(tools.some((tool: { name: string }) => tool.name === "deleteCompletedTasks")).toBe(false)
    const previewDelete = await rpc("tools/call", { name: "previewDeleteCompletedTasks", arguments: { months: 6 } })
    expect(previewDelete.isError).toBe(false)
    expect(JSON.parse(previewDelete.content[0].text)).toMatchObject({ count: 0, months: 6 })

    const deleteClient = await playwright.request.newContext({ baseURL: origin,
      extraHTTPHeaders: { authorization: `Bearer ${deleteToken}`, origin, "content-type": "application/json" } })
    try {
      const deleteCall = await deleteClient.post(path("/api/mcp"), {
        data: { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "deleteCompletedTasks", arguments: { months: 6, confirm: true } } },
      })
      expect(deleteCall.status()).toBe(200)
      const deleteResult = (await deleteCall.json()).result
      expect(deleteResult.isError).toBe(false)
      expect(JSON.parse(deleteResult.content[0].text)).toMatchObject({ ok: true, deleted: 0, months: 6 })
    } finally {
      await deleteClient.dispose()
    }
  } finally {
    await agent?.dispose()
    await bootstrap?.dispose()
    if (child.exitCode === null && child.signalCode === null) {
      const stopped = once(child, "exit")
      child.kill()
      await stopped
    }
    await rm(work, { recursive: true, force: true })
  }
})
