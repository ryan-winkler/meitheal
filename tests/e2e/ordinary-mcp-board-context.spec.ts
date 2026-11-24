import { once } from "node:events"
import { createServer, type Server } from "node:http"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import { runWithIngressTransport } from "../../apps/web/scripts/ingress-transport.mjs"
import { ensureSchema, getPersistenceClient, resetPersistenceForTests } from "../helpers/persistence-fixture"
import { verifiedBoardRequestPrincipal, resolveBoardRequestScope } from "../../apps/web/src/lib/board-request-context"
import { boardSessionProof } from "../../apps/web/src/lib/named-board-request"
import { NamedBoardRepository } from "../../apps/web/src/domains/tasks/persistence/named-board-repository"
import { IdentityRepository } from "../../apps/web/src/domains/tasks"
import { generateAgentToken } from "../../packages/domain-auth/src/index"
import { ensureAgentTokenSchema } from "../../apps/web/src/domains/auth"
import { createAgentToken } from "../../apps/web/src/domains/auth/agent-token-store"
import { resolveAgentAuth } from "../../apps/web/src/lib/agent-token-guard"
import { POST as rpc } from "../../apps/web/src/pages/api/mcp"
import { POST as createTask } from "../../apps/web/src/pages/api/tasks/index"
import { PUT as updateTask, GET as getTask } from "../../apps/web/src/pages/api/tasks/[id]"

type APIContext = Parameters<typeof rpc>[0]

// This routed module origin uses the browser Origin, not the unrelated App-server fixture Origin.
test.use({ extraHTTPHeaders: {} })

const transport = { peer: "127.0.0.1", fromSupervisor: false, identityHeadersSafe: true, configuredPath: undefined }
let directory: string, board: string, session: string, token: string, server: Server
let previousUrl: string | undefined, previousPort: string | undefined, previousCwd: string
let seen: { board: string | null, authorization: string | null, admin: string | null }[]
function ctx(request: Request, params = {}): APIContext {
  return { request, url: new URL(request.url), params, locals: {} } as APIContext
}
async function call(name: string, args: Record<string, unknown>, selection: string | null = board, query = "") {
  const request = new Request(`http://127.0.0.1/api/mcp${query}`, { method: "POST", headers: {
    "content-type": "application/json", authorization: `Bearer ${token}`,
    ...(selection === null ? {} : { "x-meitheal-board-id": selection }),
  }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) })
  const context = ctx(request)
  context.locals.agentToken = (await resolveAgentAuth(request))!
  const response = await rpc(context)
  const body = await response.json()
  return body.error ? { error: body.error.message } : JSON.parse(body.result.content[0].text)
}
async function ownTask(title = "Keep private details") {
  return runWithIngressTransport(transport, async () => {
    const response = await createTask(ctx(new Request("http://127.0.0.1/api/tasks", { method: "POST", headers: {
      "content-type": "application/json", "x-meitheal-board-id": board, "x-meitheal-board-session": session,
    }, body: JSON.stringify({ title, description: "Private body", assigned_to: "custom_mcp_agent" }) })))
    expect(response.status, await response.clone().text()).toBe(201)
    return response.json()
  })
}
test.beforeEach(async () => {
  previousCwd = process.cwd()
  process.chdir(join(import.meta.dirname, "../../apps/web"))
  previousUrl = process.env.MEITHEAL_DB_URL
  previousPort = process.env.PORT
  directory = await mkdtemp(join(tmpdir(), "meitheal-mcp-source-"))
  process.env.MEITHEAL_DB_URL = `file:${join(directory, "work.db")}`
  await ensureSchema()
  await runWithIngressTransport(transport, async () => {
    const request = new Request("http://127.0.0.1/boards")
    const principal = await verifiedBoardRequestPrincipal({ request, locals: {} as App.Locals })
    if (!principal) throw new Error("Actual local principal required")
    session = boardSessionProof(principal.id)
    const created = await new NamedBoardRepository(getPersistenceClient()).create(principal, "Work")
    if (created.status !== "committed") throw new Error("Board creation failed")
    board = created.result.id
    const managerRequest = new Request(request, { headers: { "x-meitheal-board-id": board, "x-meitheal-board-session": session } })
    const manager = await resolveBoardRequestScope({ request: managerRequest, locals: {} as App.Locals }, { operation: { resource: "board", action: "manage" }, write: true })
    if (!manager.ok) throw new Error("Actual Board manager required")
    await new IdentityRepository(getPersistenceClient()).createCustomUser("custom_mcp_agent", "MCP agent", "#146C4E", "agent")
    await ensureAgentTokenSchema()
    const credential = generateAgentToken()
    await createAgentToken({ id: crypto.randomUUID(), name: "MCP write only", tokenHash: credential.tokenHash, tokenPrefix: credential.tokenPrefix,
      scopes: ["mcp:execute", "tasks:write:assigned"], assigneeId: "custom_mcp_agent" }, manager.scope)
    token = credential.token
  })
  seen = []
  server = createServer(async (incoming, outgoing) => {
    try {
      const chunks: Buffer[] = []
      for await (const chunk of incoming) chunks.push(Buffer.from(chunk))
      const headers = new Headers()
      for (const [key, value] of Object.entries(incoming.headers)) if (typeof value === "string") headers.set(key, value)
      seen.push({ board: headers.get("x-meitheal-board-id"), authorization: headers.get("authorization"), admin: headers.get("x-ha-is-admin") })
      const request = new Request(`http://127.0.0.1${incoming.url}`, { method: incoming.method!, headers,
        ...(chunks.length ? { body: Buffer.concat(chunks) } : {}) })
      const context = ctx(request, { id: decodeURIComponent(new URL(request.url).pathname.split("/")[3]!) })
      context.locals.agentToken = (await resolveAgentAuth(request))!
      const response = incoming.method === "PUT" ? await updateTask(context) : await getTask(context)
      outgoing.writeHead(response.status, Object.fromEntries(response.headers))
      outgoing.end(await response.text())
    } catch { outgoing.writeHead(500); outgoing.end() }
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  process.env.PORT = String((server.address() as { port: number }).port)
})
test.afterEach(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
  resetPersistenceForTests()
  process.chdir(previousCwd)
  if (previousUrl === undefined) delete process.env.MEITHEAL_DB_URL
  else process.env.MEITHEAL_DB_URL = previousUrl
  if (previousPort === undefined) delete process.env.PORT
  else process.env.PORT = previousPort
  await rm(directory, { recursive: true, force: true })
})

test("MCP canonical completion retains exact selected Board and original write-only credential", async () => {
  const task = await ownTask()
  const result = await call("completeTask", { id: task.ticket_key })
  expect(result).toEqual({ id: task.id, ticket_key: task.ticket_key, status: "completed" })
  expect(seen).toEqual([{ board, authorization: `Bearer ${token}`, admin: null }])
  expect(Object.hasOwn(result, "title")).toBe(false)
})
test("MCP rejects missing, conflicting and tool-argument Board selectors before loopback", async () => {
  const task = await ownTask()
  expect(await call("completeTask", { id: task.id }, null)).toHaveProperty("error")
  expect(await call("completeTask", { id: task.id }, board, "?board_id=household")).toHaveProperty("error")
  expect(await call("completeTask", { id: task.id, board_id: "household" })).toHaveProperty("error")
  expect(seen).toHaveLength(0)
})
test("MCP selected Board cannot resolve a foreign task through its ticket or id", async () => {
  const task = await ownTask()
  expect(await call("completeTask", { id: task.id }, "household")).toHaveProperty("error")
  const row = (await getPersistenceClient().execute({ sql: "SELECT status FROM tasks WHERE id = ?", args: [task.id] })).rows[0]
  expect(row?.status).toBe("pending")
})
test("MCP handback commits one note and owned minimal retry after assigned authority is lost", async () => {
  const task = await ownTask()
  const args = { id: task.id, to: null, note: "Ready for review", request_id: crypto.randomUUID() }
  expect(await call("handBackTask", { ...args, to: "custom_mcp_agent" })).toHaveProperty("error")
  const first = await call("handBackTask", args)
  expect(first).toEqual({ id: task.id, ticket_key: task.ticket_key, handed_back_to: null, note_posted: true })
  expect(await call("handBackTask", args)).toEqual(first)
  expect(await call("handBackTask", { ...args, note: "Reused receipt must fail" })).toHaveProperty("error")
  const comments = await getPersistenceClient().execute({ sql: "SELECT content FROM comments WHERE task_id = ?", args: [task.id] })
  expect(comments.rows.map(row => row.content)).toEqual(["Ready for review"])
  expect(Object.hasOwn(first, "title")).toBe(false)
  expect(Object.hasOwn(first, "eventId")).toBe(false)
  const reassigned = await runWithIngressTransport(transport, () => updateTask(ctx(new Request(`http://127.0.0.1/api/tasks/${task.id}`, { method: "PUT", headers: {
    "content-type": "application/json", "x-meitheal-board-id": board, "x-meitheal-board-session": session,
  }, body: JSON.stringify({ assigned_to: "custom_mcp_agent" }) }), { id: task.id })))
  expect(reassigned.status, await reassigned.clone().text()).toBe(200)
  expect(await call("handBackTask", args)).toHaveProperty("error")
})

test("browser tools keep frozen Board headers and scoped links, withholding an in-flight account switch", async ({ page }) => {
  const { readFile } = await import("node:fs/promises")
  const { createRequire } = await import("node:module")
  const { resolve } = await import("node:path")
  const require = createRequire(import.meta.url)
  const ts = require("../../apps/web/node_modules/typescript/lib/typescript.js")
  const root = resolve(import.meta.dirname, "../../apps/web/src")
  let receivedBoard: string | undefined
  let release: (() => void) | undefined
  let delayed = false
  await page.route("http://127.0.0.1:8917/**", async route => {
    const url = new URL(route.request().url())
    if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body:
      '<meta name="meitheal-work-board" content="work"><meta name="meitheal-work-session" content="browser-proof"><meta name="meitheal-work-actor" content="actor-a">' })
    if (url.pathname === "/api/settings") return route.fulfill({ contentType: "application/json", body: '{"value":true}' })
    if (url.pathname === "/api/search") {
      receivedBoard = route.request().headers()["x-meitheal-board-id"]
      if (delayed) await new Promise<void>(resolve => { release = resolve })
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ sections: [{ id: "tasks", items: [{ kind: "task", taskId: "private-id", title: "Private title" }] }] }) })
    }
    if (!/^\/(lib|domains|packages)\/[a-z0-9/._-]+$/.test(url.pathname)) return route.fulfill({ status: 404 })
    try {
      const path = url.pathname.startsWith("/packages/")
        ? resolve(root, "../../../", url.pathname.slice(1)) : resolve(root, url.pathname.slice(1))
      const source = await readFile(path.endsWith(".mjs") ? path : path + ".ts", "utf8")
      const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
        .replaceAll('"@lib/', '"/lib/').replaceAll('"@domains/', '"/domains/')
        .replaceAll('"@meitheal/domain-tasks/status-values"', '"/packages/domain-tasks/src/task-status-values.mjs"')
        .replaceAll('"@meitheal/domain-tasks"', '"/packages/domain-tasks/src/index"')
      return route.fulfill({ contentType: "text/javascript", body: compiled })
    } catch { return route.fulfill({ status: 404 }) }
  })
  await page.goto("http://127.0.0.1:8917/")
  await page.evaluate(async () => {
    const tools: Record<string, any> = {}
    Object.assign(window, { sourceBrowserTools: tools })
    Object.defineProperty(document, "modelContext", { configurable: true, value: { registerTool(tool: any, { signal }: { signal: AbortSignal }) {
      tools[tool.name] = tool
      signal.addEventListener("abort", () => delete tools[tool.name], { once: true })
    } } })
    const controllerUrl = "/lib/webmcp-controller"
    await import(controllerUrl)
  })
  await expect.poll(() => page.evaluate(() => Object.keys((window as any).sourceBrowserTools))).toHaveLength(2)
  const result = await page.evaluate(() => (window as any).sourceBrowserTools.meitheal_search_tasks.execute({ query: "Private" }))
  expect(receivedBoard).toBe("work")
  expect(result).toEqual({ tasks: [{ title: "Private title", url: "/boards/work?ticket=private-id" }] })
  delayed = true
  const pending = page.evaluate(() => (window as any).sourceBrowserTools.meitheal_search_tasks.execute({ query: "Private" }))
  await expect.poll(() => Boolean(release)).toBe(true)
  await page.evaluate(() => { document.querySelector<HTMLMetaElement>('[name="meitheal-work-actor"]')!.content = "actor-b" })
  release!()
  expect(await pending).toHaveProperty("error")
  await page.evaluate(() => document.dispatchEvent(new Event("meitheal:board-hidden")))
  expect(await page.evaluate(() => Object.keys((window as any).sourceBrowserTools))).toEqual([])
})


test("generated MCP update uses the canonical writer without a task-read upgrade", async () => {
  const task = await ownTask()
  const result = await call("updateTask", { id: task.id, title: "Edited by assigned-only tool" })
  expect(result).toMatchObject({ id: task.id, ticket_key: task.ticket_key })
  expect(Object.hasOwn(result, "title")).toBe(false)
  expect(Object.hasOwn(result, "description")).toBe(false)
  expect(seen).toEqual([{ board, authorization: `Bearer ${token}`, admin: null }])
  const row = (await getPersistenceClient().execute({ sql: "SELECT title FROM tasks WHERE id = ?", args: [task.id] })).rows[0]
  expect(row?.title).toBe("Edited by assigned-only tool")
})
