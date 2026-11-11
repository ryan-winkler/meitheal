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
      name: "Native MCP pair fixture", scopes: ["mcp:execute", "tasks:read", "tasks:write"],
    } })
    expect(enrollment.status()).toBe(201)
    const { token } = await enrollment.json()
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
