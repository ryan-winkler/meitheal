import { execFileSync, fork } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, test } from "@playwright/test"

test("scoped MCP resolves native schemas and rejects false mutation successes", async ({ playwright }) => {
  test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires a built App and disposable ingress")
  const work = await mkdtemp(join(tmpdir(), "meitheal-mcp-results-"))
  const web = fileURLToPath(new URL("../../apps/web", import.meta.url))
  const env = { PATH: process.env.PATH, NODE_ENV: "production", MEITHEAL_DB_URL: `file:${join(work, "result.db")}`, MEITHEAL_TEST_CORE_USER_LOOKUP: "1" }
  const api = await playwright.request.newContext()
  let child: ReturnType<typeof fork> | undefined
  try {
    execFileSync(process.execPath, ["scripts/migrate.mjs"], { cwd: web, env })
    child = fork(fileURLToPath(new URL("../scripts/mcp-result-fixture.mjs", import.meta.url)), { cwd: web, env, stdio: ["ignore", "ignore", "inherit", "ipc"] })
    const [info] = await once(child, "message", { signal: AbortSignal.timeout(10_000) })
    const origin = `http://127.0.0.1:${info.port}`
    const base = origin + info.configuredPath
    const enrolled = await api.post(base + "/api/agent-tokens", { headers: { origin, cookie: "feedback-fixture=admin" }, data: { name: "MCP result fixture", scopes: ["mcp:execute", "tasks:read", "tasks:write", "tasks:delete", "search:read"] } })
    expect(enrolled.status()).toBe(201)
    const { token } = await enrolled.json()
    const headers = { origin, authorization: `Bearer ${token}`, "content-type": "application/json" }
    const rpc = async (method: string, params?: Record<string, unknown>, modern = false) => {
      const version = "2026-07-28"
      const modernHeaders = modern ? { "mcp-protocol-version": version, "mcp-method": method, "mcp-name": String(params?.name ?? "") } : {}
      const supplied = modern ? { ...params, _meta: { "io.modelcontextprotocol/protocolVersion": version, "io.modelcontextprotocol/clientCapabilities": {} } } : params
      const response = await api.post(base + "/api/mcp", { headers: { ...headers, ...modernHeaders }, data: { jsonrpc: "2.0", id: 1, method, params: supplied } })
      expect(response.status()).toBe(200)
      return response.json()
    }
    const tools = (await rpc("tools/list")).result.tools
    const create = tools.find((tool: { name: string }) => tool.name === "createTask")
    expect(create.inputSchema.required).toContain("title")
    expect(create.inputSchema.properties.title.type).toBe("string")
    expect(JSON.stringify(tools)).not.toContain('"$ref"')
    expect(tools.some((tool: { name: string }) => tool.name === "replaceRules")).toBe(false)
    const search = tools.find((tool: { name: string }) => tool.name === "searchTasks")
    expect(search.inputSchema.properties.scope.enum).toEqual(["tasks"])
    const list = tools.find((tool: { name: string }) => tool.name === "listTasks")
    expect(list.inputSchema.properties).not.toHaveProperty("board_name")

    const owned: string[] = []
    const unique = `MCPResult${crypto.randomUUID().replaceAll("-", "")}`
    try {
      for (const suffix of ["heating", "garden"]) {
        const created = await api.post(base + "/api/tasks", { headers, data: { title: `${unique} ${suffix}`, description: `${unique} privateboundary` } })
        expect(created.status()).toBe(201)
        owned.push((await created.json()).id)
      }
      for (const key of ["q", "query"]) {
        const found = (await rpc("tools/call", { name: "searchTasks", arguments: { [key]: `${unique} heating`, limit: 1 } })).result
        expect(found.isError).toBe(false)
        expect(JSON.parse(found.content[0].text)).toMatchObject({ count: 1, tasks: [{ id: owned[0] }] })
      }
      for (const [task_fields, count] of [["title", 0], ["description", 1]] as const) {
        const found = (await rpc("tools/call", { name: "searchTasks", arguments: { q: `${unique} privateboundary`, task_fields, limit: 1 } })).result
        expect(found.isError).toBe(false)
        expect(JSON.parse(found.content[0].text).count).toBe(count)
      }
      const listed = (await rpc("tools/call", { name: "listTasks", arguments: { limit: 20 } })).result
      expect(listed.isError).toBe(false)
      expect(JSON.parse(listed.content[0].text).tasks).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: owned[0] }),
      ]))
      for (const [name, args] of [
        ["listTasks", { board_name: "unavailable-board" }],
        ["searchTasks", { q: unique, board_id: "unavailable-board" }],
        ["completeTask", { id: owned[0], board_id: "unavailable-board" }],
      ] as const) {
        for (const modern of [false, true]) {
          const scoped = await rpc("tools/call", { name, arguments: args }, modern)
          if (modern) expect(scoped.result.isError).toBe(true)
          else expect(scoped.error.code).toBe(-32603)
          expect(JSON.stringify(scoped)).not.toContain(unique)
        }
      }
      const retained = await api.get(base + `/api/tasks/${owned[0]}`, { headers })
      expect(await retained.json()).toMatchObject({ status: "pending" })
    } finally {
      for (const id of owned) {
        const removed = await api.delete(base + `/api/tasks/${id}`, { headers })
        expect(removed.status(), await removed.text()).toBe(204)
      }
    }

    const setResult = async (result: { status: number; body?: string }) => {
      const acknowledged = once(child!, "message", { signal: AbortSignal.timeout(5000) })
      child!.send({ type: "fixture-mcp-result", result })
      expect((await acknowledged)[0]).toEqual({ mcpResultReady: true })
    }
    for (const result of [{ status: 403, body: "{}" }, { status: 200, body: "<private-response-secret" }, { status: 200, body: "null" }, { status: 200, body: "[]" }, { status: 200, body: '{"ok":false}' }, { status: 200, body: '{"error":"rejected"}' }, { status: 200, body: '{}' }, { status: 200, body: '{"success":false}' }, { status: 200, body: '{"id":"result-fixture","status":"pending"}' }, { status: 200, body: '{"id":"different-task","status":"complete"}' }]) {
      await setResult(result)
      for (const modern of [false, true]) {
        for (const args of [{ id: "result-fixture" }, { title: "Fixture title" }]) {
          const failed = await rpc("tools/call", { name: "completeTask", arguments: args }, modern)
          if (modern) expect(failed.result.isError).toBe(true)
          else expect(failed.error.code).toBe(-32603)
          expect(JSON.stringify(failed)).not.toContain('"status":"completed"')
          expect(JSON.stringify(failed)).not.toContain("private-response-secret")
        }
      }
    }
    await setResult({ status: 204 })
    const deleted = (await rpc("tools/call", { name: "deleteTask", arguments: { id: "result-fixture" } })).result
    expect(deleted.isError).toBe(false)
    expect(JSON.parse(deleted.content[0].text)).toEqual({ ok: true })
    await setResult({ status: 200, body: '{"id":"result-fixture","title":"Fixture title","status":"complete"}' })
    for (const modern of [false, true]) {
      for (const args of [{ id: "result-fixture" }, { title: "Fixture title" }]) {
        expect((await rpc("tools/call", { name: "completeTask", arguments: args }, modern)).result.isError).toBe(false)
      }
    }
    await setResult({ status: 200, body: '{"id":"result-fixture","ticket_key":"MTH-42","status":"complete"}' })
    expect((await rpc("tools/call", { name: "completeTask", arguments: { id: "MTH-42" } })).result.isError).toBe(false)
  } finally {
    await api.dispose()
    if (child && child.exitCode === null) {
      const stopped = once(child, "exit")
      child.kill("SIGTERM")
      await stopped
    }
    await rm(work, { recursive: true, force: true })
  }
})
