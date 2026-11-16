import { execFile, spawn } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import http from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { promisify } from "node:util"
import { expect, test } from "@playwright/test"
import { openDatabase } from "../../apps/web/scripts/database-client.mjs"
import { runWithIngressTransport } from "../../apps/web/scripts/ingress-transport.mjs"
import {
  commitSyncMutationChunks,
  findTasksByExternalSyncIds,
  type SyncTaskMutation,
} from "../../apps/web/src/domains/tasks"
import { ensureSchema, getPersistenceClient, resetPersistenceForTests } from "../../apps/web/src/domains/tasks/persistence/store"
import { TaskRepository } from "../../apps/web/src/domains/tasks/persistence/task-repository"
import { getTasksForView } from "../../apps/web/src/lib/task-queries"
import { onRequest, resetRateLimitsForTests } from "../../apps/web/src/middleware"
import { POST as tasksPOST } from "../../apps/web/src/pages/api/tasks/index"
import { DELETE as taskDELETE, PUT as taskPUT } from "../../apps/web/src/pages/api/tasks/[id]"

const execFileAsync = promisify(execFile)
const repoRoot = fileURLToPath(new URL("../..", import.meta.url))
const webDir = join(repoRoot, "apps/web")

function sendRawHttp(port: number, rawPathAndQuery: string, options: {
  method?: string
  headers?: Record<string, string>
  body?: string
} = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port,
      method: options.method ?? "GET",
      path: rawPathAndQuery,
      headers: options.headers,
    }, res => {
      let body = ""
      res.setEncoding("utf8")
      res.on("data", chunk => { body += chunk })
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }))
    })
    req.on("error", reject)
    if (options.body !== undefined) req.write(options.body)
    req.end()
  })
}

test("B3: commitSyncMutationChunks commits 60 items in 25/25/10 chunks, isolates SAVEPOINT failure at index 23 with zero ticket_number gap, and batches >200 sync lookups", async () => {
  const work = await mkdtemp(join(tmpdir(), "meitheal-track-b-sync-"))
  const prevDbUrl = process.env.MEITHEAL_DB_URL
  try {
    process.env.MEITHEAL_DB_URL = `file:${join(work, "sync.db")}`
    resetPersistenceForTests()
    await ensureSchema()
    const client = getPersistenceClient()

    // 60 inbound items (chunks of 25, 25, 10).
    // Item 23 inserts a task row FIRST inside SAVEPOINT sync_item_23, then hits UNIQUE constraint on
    // todo_sync_confirmations.confirmation_id by colliding with item 0's confirmationId — proving
    // ROLLBACK TO SAVEPOINT rolls back both the task row AND its provisional ticket_number=24 so
    // item 24 claims ticket_number=24 cleanly!
    const mutations: SyncTaskMutation[] = Array.from({ length: 60 }, (_, idx) => {
      const uid = `uid-${idx}`
      const confirmationId = idx === 23 ? "conf-0" : `conf-${idx}`
      return {
        kind: "create",
        title: `Inbound Todo ${idx}`,
        description: `Synced description ${idx}`,
        status: "pending",
        idempotencyKey: `todo-sync-test:${idx}`,
        confirmation: {
          source: "ha_todo",
          confirmationId,
          entityId: "todo.household",
          externalId: uid,
          payload: JSON.stringify({ entity_id: "todo.household", uid, summary: `Inbound Todo ${idx}` }),
        },
      }
    })

    const result = await commitSyncMutationChunks(mutations, { chunkSize: 25 })
    expect(result.chunksCommitted).toBe(3)
    expect(result.created).toBe(59)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]?.index).toBe(23)

    const persisted = await client.execute("SELECT ticket_number, title FROM tasks ORDER BY ticket_number ASC")
    expect(persisted.rows).toHaveLength(59)
    const ticketNumbers = persisted.rows.map(r => Number(r.ticket_number))
    expect(ticketNumbers).toEqual(Array.from({ length: 59 }, (_, i) => i + 1))

    // Add calendar (scoped across 2 entity_ids) + grocy confirmations + >200 todo IDs to verify multi-chunk lookup
    const extraTodoMutations: SyncTaskMutation[] = Array.from({ length: 210 }, (_, idx) => ({
      kind: "create",
      title: `Bulk Todo ${idx}`,
      status: "pending",
      idempotencyKey: `bulk-todo:${idx}`,
      confirmation: {
        source: "ha_todo",
        entityId: "todo.bulk",
        externalId: `bulk-uid-${idx}`,
        payload: JSON.stringify({ uid: `bulk-uid-${idx}` }),
      },
    }))
    const calAndGrocyMutations: SyncTaskMutation[] = [
      {
        kind: "create",
        title: "Family Event",
        status: "pending",
        idempotencyKey: "cal:family:ev-shared",
        confirmation: {
          source: "calendar",
          entityId: "calendar.family",
          externalId: "ev-shared",
          payload: JSON.stringify({ entity_id: "calendar.family", uid: "ev-shared" }),
        },
      },
      {
        kind: "create",
        title: "Work Event Same UID",
        status: "active",
        idempotencyKey: "cal:work:ev-shared",
        confirmation: {
          source: "calendar",
          entityId: "calendar.work",
          externalId: "ev-shared",
          payload: JSON.stringify({ entity_id: "calendar.work", uid: "ev-shared" }),
        },
      },
      {
        kind: "create",
        title: "Grocy Chore Clean Filter",
        status: "pending",
        idempotencyKey: "grocy:chore:77",
        confirmation: {
          source: "grocy",
          grocyEntityType: "chore",
          externalId: "77",
          payload: JSON.stringify({ id: "77", name: "Clean Filter" }),
        },
      },
    ]

    await commitSyncMutationChunks([...extraTodoMutations, ...calAndGrocyMutations])

    const repo = new TaskRepository(client)
    const todoMap = await findTasksByExternalSyncIds({
      source: "ha_todo",
      entityId: "todo.bulk",
      externalIds: Array.from({ length: 210 }, (_, i) => `bulk-uid-${i}`),
    })
    expect(todoMap.size).toBe(210)
    expect((await repo.findById(todoMap.get("bulk-uid-205")!.taskId))?.title).toBe("Bulk Todo 205")

    const familyCalMap = await findTasksByExternalSyncIds({
      source: "calendar",
      entityId: "calendar.family",
      externalIds: ["ev-shared"],
    })
    const workCalMap = await findTasksByExternalSyncIds({
      source: "calendar",
      entityId: "calendar.work",
      externalIds: ["ev-shared"],
    })
    expect((await repo.findById(familyCalMap.get("ev-shared")!.taskId))?.title).toBe("Family Event")
    expect((await repo.findById(workCalMap.get("ev-shared")!.taskId))?.title).toBe("Work Event Same UID")

    const grocyMap = await findTasksByExternalSyncIds({
      source: "grocy",
      grocyEntityType: "chore",
      externalIds: ["77"],
    })
    expect((await repo.findById(grocyMap.get("77")!.taskId))?.title).toBe("Grocy Chore Clean Filter")
  } finally {
    resetPersistenceForTests()
    if (prevDbUrl === undefined) delete process.env.MEITHEAL_DB_URL
    else process.env.MEITHEAL_DB_URL = prevDbUrl
    await rm(work, { recursive: true, force: true })
  }
})

test("B2/B4/D1: slim SQL projections, deep description search, /planning active tasks, MTH-N GET resolution, raw-path 400s, MCP -32602 path validation, and per-token loopback rate limits", async () => {
  test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires built dist/server/entry.mjs")
  test.setTimeout(30_000)

  const work = await mkdtemp(join(tmpdir(), "meitheal-track-b-live-"))
  const preloadPath = join(work, "preload.mjs")

  await writeFile(preloadPath, `
    import { once } from "node:events"
    import http from "node:http"
    import { createRequire } from "node:module"

    const require = createRequire(${JSON.stringify(join(webDir, "package.json"))})
    const { WebSocketServer } = require("ws")
    const core = new WebSocketServer({ host: "127.0.0.1", port: 0 })
    await once(core, "listening")
    const corePort = core.address().port
    core.on("connection", socket => {
      socket.send(JSON.stringify({ type: "auth_required", ha_version: "2026.11.0" }))
      socket.on("message", raw => {
        const msg = JSON.parse(raw.toString())
        if (msg.type === "auth") socket.send(JSON.stringify({ type: "auth_ok", ha_version: "2026.11.0" }))
        else if (msg.type === "ping") socket.send(JSON.stringify({ id: msg.id, type: "pong" }))
        else if (msg.type === "config/auth/list") {
          socket.send(JSON.stringify({
            id: msg.id,
            type: "result",
            success: true,
            result: [
              { id: "admin-b", is_active: true, system_generated: false, is_owner: true, group_ids: ["system-admin"] },
            ],
          }))
        } else {
          socket.send(JSON.stringify({ id: msg.id, type: "result", success: true, result: [] }))
        }
      })
    })
    process.once("SIGTERM", () => {
      for (const s of core.clients) s.terminate()
      core.close()
      process.exit(0)
    })

    const realRequest = http.request
    http.request = function (options, ...rest) {
      if (options?.host === "supervisor" && options.path === "/core/api/websocket") {
        options = { ...options, host: "127.0.0.1", port: corePort }
      }
      return realRequest.call(this, options, ...rest)
    }

    const origFetch = globalThis.fetch
    globalThis.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      if (url === "http://172.30.32.2/info") {
        return Response.json({ data: { supervisor: "2026.11.0" } })
      }
      if (url.startsWith("http://supervisor/")) {
        return Response.json({ data: { state: "started", addons: [] } })
      }
      return origFetch(input, init)
    }
    const origCreateServer = http.createServer
    http.createServer = function (listener) {
      const srv = origCreateServer.call(this, (req, res) => {
        if (req.headers["x-test-peer"] === "supervisor") {
          Object.defineProperty(req.socket, "remoteAddress", { value: "172.30.32.2", configurable: true })
        } else {
          delete req.socket.remoteAddress
        }
        return listener(req, res)
      })
      srv.once("listening", () => {
        const addr = srv.address()
        if (addr && typeof addr === "object") process.send?.({ type: "listening", port: addr.port })
      })
      return srv
    }
  `)

  const dbFile = join(work, "live-b.db")
  const env = {
    PATH: process.env.PATH ?? "",
    NODE_ENV: "production",
    HOST: "127.0.0.1",
    PORT: "0",
    SUPERVISOR_TOKEN: "test-sup-token-b",
    INGRESS_PATH: "/api/hassio_ingress/tok_b",
    MEITHEAL_DB_URL: `file:${dbFile}`,
  }
  await execFileAsync(process.execPath, ["scripts/migrate.mjs"], { cwd: webDir, env })

  const child = spawn(process.execPath, ["--import", preloadPath, "scripts/serve.mjs"], {
    cwd: webDir,
    env,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  })
  child.stdout?.resume()
  let childStderr = ""
  child.stderr?.on("data", chunk => {
    if (childStderr.length < 16_384) childStderr += String(chunk)
  })

  try {
    const port = await new Promise<number>((resolve, reject) => {
      const onMessage = (msg: unknown) => {
        cleanup()
        const boundPort = (msg as { port?: number } | null)?.port
        if (typeof boundPort === "number" && boundPort > 0) resolve(boundPort)
        else reject(new Error(`Unexpected IPC message: ${JSON.stringify(msg)}`))
      }
      const onExit = (code: number | null, sig: NodeJS.Signals | null) => {
        cleanup()
        reject(new Error(`serve.mjs exited before listening (code=${String(code)}, sig=${String(sig)}): ${childStderr}`))
      }
      const timer = setTimeout(() => {
        cleanup()
        reject(new Error(`serve.mjs listen timeout: ${childStderr}`))
      }, 10_000)
      function cleanup() {
        clearTimeout(timer)
        child.off("message", onMessage)
        child.off("exit", onExit)
      }
      child.once("message", onMessage)
      child.once("exit", onExit)
    })
    const healthRes = await fetch(`http://127.0.0.1:${port}/api/health`)
    expect(healthRes.status, childStderr).toBe(200)

    const origin = `http://127.0.0.1:${port}`
    const adminHeaders = {
      "x-test-peer": "supervisor",
      "x-ingress-path": "/api/hassio_ingress/tok_b",
      "x-remote-user-id": "admin-b",
      "x-remote-user-groups": "system-admin",
      origin,
    }

    // Create project + active task + deep-description task + checklist task
    const projRes = await fetch(`${origin}/api/projects`, {
      method: "POST",
      headers: { ...adminHeaders, "content-type": "application/json" },
      body: JSON.stringify({ title: "Attic Insulation", area_id: "default" }),
    })
    expect([200, 201]).toContain(projRes.status)
    const project = await projRes.json()
    const projectId = project.id ?? project.project?.id

    const deepDescription = `${"A".repeat(110)} DEEP_SEARCH_SENTINEL_98765 tail`
    const createActive = await fetch(`${origin}/api/tasks`, {
      method: "POST",
      headers: { ...adminHeaders, "content-type": "application/json" },
      body: JSON.stringify({
        title: "Install vapour barrier",
        description: deepDescription,
        status: "active",
        priority: 1,
        urgency: 8,
        importance: 9,
        project_id: projectId,
      }),
    })
    expect(createActive.status).toBe(201)
    const activeCreated = await createActive.json()
    expect(activeCreated.ticket_key).toMatch(/^MTH-\d+$/)

    // Attach 3 checklist items (2 done, 1 open) via PUT /api/tasks/[id]
    const putChecklist = await fetch(`${origin}/api/tasks/${activeCreated.id}`, {
      method: "PUT",
      headers: { ...adminHeaders, "content-type": "application/json" },
      body: JSON.stringify({
        checklists: JSON.stringify([
          { text: "Measure rafters", done: true },
          { text: "Cut rolls", done: true },
          { text: "Tape seams", done: false },
        ]),
      }),
    })
    expect(putChecklist.status).toBe(200)

    // 1. D1: GET /api/tasks/MTH-N resolves ticket key -> 200; unknown MTH-999999 -> 404
    const byTicketRes = await fetch(`${origin}/api/tasks/${activeCreated.ticket_key}`, { headers: adminHeaders })
    expect(byTicketRes.status).toBe(200)
    const byTicket = await byTicketRes.json()
    expect(byTicket.id).toBe(activeCreated.id)
    expect(byTicket.description).toBe(deepDescription)

    const missingTicketRes = await fetch(`${origin}/api/tasks/MTH-999999`, { headers: adminHeaders })
    expect(missingTicketRes.status).toBe(404)

    // 2. B2 SSR pages:
    // - /planning retains "active" tasks and renders project task counts
    const planningRes = await fetch(`${origin}/planning`, { headers: adminHeaders })
    expect(planningRes.status).toBe(200)
    const planningHtml = await planningRes.text()
    expect(planningHtml).toContain("Install vapour barrier")

    // - /tasks?view=table&search=DEEP_SEARCH_SENTINEL_98765 matches description past char 80
    const tasksSearchRes = await fetch(`${origin}/tasks?view=table&search=DEEP_SEARCH_SENTINEL_98765`, { headers: adminHeaders })
    expect(tasksSearchRes.status).toBe(200)
    const tasksSearchHtml = await tasksSearchRes.text()
    expect(tasksSearchHtml).toContain("Install vapour barrier")

    const tasksNoMatchRes = await fetch(`${origin}/tasks?view=table&search=NONEXISTENT_SENTINEL_00000`, { headers: adminHeaders })
    expect(tasksNoMatchRes.status).toBe(200)
    expect(await tasksNoMatchRes.text()).not.toContain("Install vapour barrier")

    // - /eisenhower renders 2/3 checklist badge from slim scalar checklist_done/checklist_total
    const eisenhowerRes = await fetch(`${origin}/eisenhower`, { headers: adminHeaders })
    expect(eisenhowerRes.status).toBe(200)
    const eisenhowerHtml = await eisenhowerRes.text()
    expect(eisenhowerHtml).toContain("Install vapour barrier")
    expect(eisenhowerHtml).toContain("2/3")

    // 3. B4 raw-path traversal / encoded-separator rejection over raw TCP HTTP
    const pctSlash = await sendRawHttp(port, "/api/tasks/foo%2fbar", { headers: adminHeaders })
    expect(pctSlash.status).toBe(400)

    const pctBackslash = await sendRawHttp(port, "/api/tasks/foo%5cbar", { headers: adminHeaders })
    expect(pctBackslash.status).toBe(400)

    const dotDot = await sendRawHttp(port, "/api/tasks/../diagnostics", { headers: adminHeaders })
    expect(dotDot.status).toBe(400)

    // Encoded slash in query string (?q=http%3A%2F%2Fha.local%2Ffoo) must still succeed (200)
    const searchQueryOk = await sendRawHttp(port, "/api/search?q=http%3A%2F%2Fha.local%2Ffoo", { headers: adminHeaders })
    expect(searchQueryOk.status).toBe(200)

    // 4. B4 MCP path-segment validation (-32602) & per-token loopback rate-limit isolation
    const tokARes = await fetch(`${origin}/api/agent-tokens`, {
      method: "POST",
      headers: { ...adminHeaders, "content-type": "application/json" },
      body: JSON.stringify({ name: "Token A", scopes: ["mcp:execute", "tasks:read", "tasks:write"] }),
    })
    const tokBRes = await fetch(`${origin}/api/agent-tokens`, {
      method: "POST",
      headers: { ...adminHeaders, "content-type": "application/json" },
      body: JSON.stringify({ name: "Token B", scopes: ["mcp:execute", "tasks:read", "tasks:write"] }),
    })
    expect(tokARes.status).toBe(201)
    expect(tokBRes.status).toBe(201)
    const { token: tokenA } = await tokARes.json()
    const { token: tokenB } = await tokBRes.json()

    const callMcp = async (token: string, name: string, args: Record<string, unknown>) => {
      const r = await fetch(`${origin}/api/mcp`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          origin,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name, arguments: args },
        }),
      })
      return { status: r.status, json: await r.json().catch(() => null) }
    }

    // Generic OpenAPI pathParams + customHandlers reject traversal/separators with -32602
    for (const [toolName, badArgs] of [
      ["getTask", { id: "../diagnostics" }],
      ["updateTask", { id: "foo/bar", title: "Nope" }],
      ["completeTask", { id: "../diagnostics" }],
      ["handBackTask", { id: "bad\\segment" }],
    ] as const) {
      const bad = await callMcp(tokenB, toolName, badArgs)
      expect(bad.status).toBe(200)
      expect(bad.json?.error?.code).toBe(-32602)
    }

    // Per-token loopback rate limiting: exhaust tokenA's 60/min MCP bucket, verify tokenB still gets 200
    let lastStatusA = 200
    for (let i = 0; i < 65; i++) {
      const r = await fetch(`${origin}/api/mcp`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${tokenA}`,
          origin,
          "content-type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: i + 1, method: "tools/list" }),
      })
      lastStatusA = r.status
      if (lastStatusA === 429) break
    }
    expect(lastStatusA).toBe(429)

    const tokenBStillWorks = await fetch(`${origin}/api/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${tokenB}`,
        origin,
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 999, method: "tools/list" }),
    })
    expect(tokenBStillWorks.status).toBe(200)
  } finally {
    if (child.exitCode === null) {
      const exited = once(child, "exit")
      child.kill("SIGTERM")
      await exited
    }
    await rm(work, { recursive: true, force: true })
  }
})

test("B2/B4: non-loopback IP rate limit short-circuits before SQLite token lookup, and writeAbortSignal aborts standard mutations without Idempotency-Key", async () => {
  const work = await mkdtemp(join(tmpdir(), "meitheal-track-b-unit-"))
  const dbPath = join(work, "unit.db")
  const prevDbUrl = process.env.MEITHEAL_DB_URL
  try {
    process.env.MEITHEAL_DB_URL = `file:${dbPath}`
    resetPersistenceForTests()
    resetRateLimitsForTests()
    await ensureSchema()

    const client = getPersistenceClient()
    const repo = new TaskRepository(client)

    // Direct B2 slim query verification
    const seedRes = await tasksPOST({
      request: new Request("http://127.0.0.1:3000/api/tasks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "Slim query check",
          description: `${"prefix ".repeat(20)}DIRECT_SLIM_NEEDLE`,
          status: "pending",
          priority: 2,
        }),
      }),
      locals: { behindIngress: false } as unknown as App.Locals,
    } as unknown as Parameters<typeof tasksPOST>[0])
    expect(seedRes.status).toBe(201)
    const created = (await seedRes.json()) as { id: string }

    const slimPreviewView = await getTasksForView({
      slim: true,
      descriptionPreviewChars: 80,
    })
    expect(slimPreviewView.tasks).toHaveLength(1)
    expect(slimPreviewView.tasks[0]?.has_description).toBe(true)
    expect((slimPreviewView.tasks[0]?.description ?? "").length).toBeLessThanOrEqual(80)
    expect(slimPreviewView.tasks[0]?.checklists).toBeNull()

    // 1. Non-loopback IP rate-limit short-circuits before SQLite agent_tokens lookup
    let tokenSqlQueries = 0
    const origExecute = client.execute.bind(client)
    client.execute = (async (...args: Parameters<typeof origExecute>) => {
      const stmt = args[0]
      const sql = typeof stmt === "string"
        ? stmt
        : Array.isArray(stmt)
          ? stmt[0]
          : (stmt as { sql: string }).sql
      if (sql.includes("agent_tokens")) tokenSqlQueries++
      return origExecute(...args)
    }) as typeof client.execute

    try {
      let saw429 = false
      for (let i = 0; i < 310; i++) {
        const res = (await runWithIngressTransport(
          {
            peer: "198.51.100.42",
            fromSupervisor: false,
            identityHeadersSafe: false,
            configuredPath: undefined,
          },
          () =>
            onRequest(
              {
                request: new Request("http://127.0.0.1:3000/api/tasks", {
                  headers: { authorization: `Bearer mth_invalid_token_${i}` },
                }),
                url: new URL("http://127.0.0.1:3000/api/tasks"),
                locals: {} as App.Locals,
                routePattern: "/api/tasks",
                clientAddress: "198.51.100.42",
              } as unknown as Parameters<typeof onRequest>[0],
              async () => Response.json({ ok: true }),
            ),
        )) as Response
        if (res.status === 429) {
          const queriesAtFirst429 = tokenSqlQueries
          // Send 10 more invalid tokens from the same IP; zero additional SQLite queries may fire!
          for (let j = 0; j < 10; j++) {
            const extra = (await runWithIngressTransport(
              {
                peer: "198.51.100.42",
                fromSupervisor: false,
                identityHeadersSafe: false,
                configuredPath: undefined,
              },
              () =>
                onRequest(
                  {
                    request: new Request("http://127.0.0.1:3000/api/tasks", {
                      headers: { authorization: `Bearer mth_after_limit_${j}` },
                    }),
                    url: new URL("http://127.0.0.1:3000/api/tasks"),
                    locals: {} as App.Locals,
                    routePattern: "/api/tasks",
                    clientAddress: "198.51.100.42",
                  } as unknown as Parameters<typeof onRequest>[0],
                  async () => Response.json({ ok: true }),
                ),
            )) as Response
            expect(extra.status).toBe(429)
          }
          expect(tokenSqlQueries).toBe(queriesAtFirst429)
          saw429 = true
          break
        }
      }
      expect(saw429).toBe(true)
    } finally {
      client.execute = origExecute
    }

    // 2. Cooperative writeAbortSignal propagation on POST / PUT / DELETE without Idempotency-Key
    const locker = openDatabase(pathToFileURL(dbPath).href)
    const lockTx = await locker.transaction("write")
    try {
      await lockTx.execute({ sql: "UPDATE tasks SET updated_at = updated_at WHERE id = ?", args: [created.id] })

      // POST /api/tasks with mid-backoff aborted writeAbortSignal rejects cooperatively without inserting
      const postAbort = new AbortController()
      setTimeout(() => postAbort.abort(), 12)
      await expect(
        Promise.resolve(
          tasksPOST({
            request: new Request("http://127.0.0.1:3000/api/tasks", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ title: "Aborted standard POST" }),
            }),
            locals: {
              behindIngress: false,
              writeAbortSignal: postAbort.signal,
            } as unknown as App.Locals,
          } as unknown as Parameters<typeof tasksPOST>[0]),
        ),
      ).rejects.toMatchObject({ name: "AbortError" })

      // PUT /api/tasks/[id] aborts cleanly when writeAbortSignal aborts mid-backoff
      const putAbort = new AbortController()
      setTimeout(() => putAbort.abort(), 12)
      const putResOrErr = await Promise.resolve(
        taskPUT({
          params: { id: created.id },
          request: new Request(`http://127.0.0.1:3000/api/tasks/${created.id}`, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ title: "Aborted PUT" }),
          }),
          locals: {
            behindIngress: false,
            writeAbortSignal: putAbort.signal,
          } as unknown as App.Locals,
        } as unknown as Parameters<typeof taskPUT>[0]),
      ).catch((err: unknown) => err)
      if (putResOrErr instanceof Response) {
        expect([499, 500, 503]).toContain(putResOrErr.status)
      } else {
        expect(putResOrErr).toMatchObject({ name: "AbortError" })
      }

      // DELETE /api/tasks/[id] aborts cooperatively without deleting the task
      const delAbort = new AbortController()
      setTimeout(() => delAbort.abort(), 12)
      const delResOrErr = await Promise.resolve(
        taskDELETE({
          params: { id: created.id },
          request: new Request(`http://127.0.0.1:3000/api/tasks/${created.id}`, { method: "DELETE" }),
          locals: {
            behindIngress: false,
            writeAbortSignal: delAbort.signal,
          } as unknown as App.Locals,
        } as unknown as Parameters<typeof taskDELETE>[0]),
      ).catch((err: unknown) => err)
      if (delResOrErr instanceof Response) {
        expect([499, 500, 503]).toContain(delResOrErr.status)
      } else {
        expect(delResOrErr).toMatchObject({ name: "AbortError" })
      }
    } finally {
      await lockTx.rollback()
      lockTx.close()
      locker.close()
    }

    const stillIntact = await repo.findById(created.id)
    expect(stillIntact?.title).toBe("Slim query check")
  } finally {
    resetRateLimitsForTests()
    resetPersistenceForTests()
    if (prevDbUrl === undefined) delete process.env.MEITHEAL_DB_URL
    else process.env.MEITHEAL_DB_URL = prevDbUrl
    await rm(work, { recursive: true, force: true })
  }
})
