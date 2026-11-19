import { execFileSync, type ChildProcess } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { once } from "node:events"
import { request as httpRequest } from "node:http"
import { createServer } from "node:https"
import { copyFile, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { expect, test, type PlaywrightWorkerArgs, type TestInfo } from "@playwright/test"
import { ensureSchema, getPersistenceClient, resetPersistenceForTests } from "../helpers/persistence-fixture"
import { startCoreFixture } from "../scripts/task-pins-fixture"

// This suite deliberately owns every HTTPS listener. It exercises the built Astro
// middleware, real ingress transport and Core membership fixture, never a handler
// substituted for HTTP. MEITHEAL_TEST_BROWSER need not start a shared web server.
test.describe.configure({ mode: "default" })
test.setTimeout(90_000)
const web = resolve(import.meta.dirname, "../../apps/web")
const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex")
const databasePath = (work: string) => join(work, "pins.db")
const markerPath = (work: string) => join(work, "meitheal-board-grants.json")

async function evidenceJson(info: TestInfo, name: string, value: unknown) {
  const path = info.outputPath(name)
  await writeFile(path, JSON.stringify(value, null, 2), { mode: 0o600 })
  await info.attach(name, { path, contentType: "application/json" })
}

async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return
  const ended = once(child, "exit", { signal: AbortSignal.timeout(5_000) })
  child.kill("SIGTERM")
  await ended
}

async function server(work: string, playwright: PlaywrightWorkerArgs["playwright"]) {
  const child = startCoreFixture(work, true, undefined, undefined, work)
  child.stdout?.resume()
  child.stderr?.resume()
  let gateway: ReturnType<typeof createServer> | undefined
  try {
    const [info] = await once(child, "message", { signal: AbortSignal.timeout(15_000) })
    // Supervisor terminates HTTPS while MCP calls the App's real HTTP loopback
    // listener. Preserve both actual transports rather than replacing fetch.
    gateway = createServer({ key: await readFile(join(work, "fixture-key.pem")), cert: await readFile(join(work, "fixture-cert.pem")) }, (incoming, outgoing) => {
      const upstream = httpRequest({ host: "127.0.0.1", port: info.port, method: incoming.method, path: incoming.url,
        headers: { ...incoming.headers, "x-forwarded-proto": "https" } }, response => {
        outgoing.writeHead(response.statusCode!, response.headers)
        response.pipe(outgoing)
      })
      upstream.on("error", () => { outgoing.writeHead(502); outgoing.end() })
      incoming.pipe(upstream)
      outgoing.once("close", () => upstream.destroy())
    })
    gateway.listen(0, "127.0.0.1")
    await once(gateway, "listening")
    const address = gateway.address()
    if (!address || typeof address === "string") throw new Error("HTTPS fixture did not bind")
    const origin = `https://127.0.0.1:${address.port}`
    const base = origin + info.configuredPath
    const api = await playwright.request.newContext({ ignoreHTTPSErrors: true, baseURL: base + "/", timeout: 8_000,
      extraHTTPHeaders: { origin, cookie: "feedback-fixture=admin" } })
    const directApi = await playwright.request.newContext({ ignoreHTTPSErrors: true, timeout: 8_000, extraHTTPHeaders: {} })
    return { child, api, directApi, base, origin, close: async () => {
      await directApi.dispose()
      await api.dispose()
      gateway!.closeAllConnections()
      await new Promise<void>((done, reject) => gateway!.close(error => error ? reject(error) : done()))
      await stop(child)
    } }
  } catch (error) { gateway?.closeAllConnections(); gateway?.close(); await stop(child); throw error }
}
type Server = Awaited<ReturnType<typeof server>>

function governedRecords(work: string) {
  const db = new DatabaseSync(databasePath(work), { readOnly: true })
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()
      .map(row => String(row.name)).filter(name => /^(tasks$|task_|board_|named_board_|organization_|areas$|goals$|projects$)/.test(name))
    return Object.fromEntries(tables.map(name => [name, db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]))
  } finally { db.close() }
}

async function currentCapture(app: Server, label: string) {
  const directory = await app.api.get(app.base + "/api/boards")
  expect(directory.status()).toBe(200)
  const headers = { "x-meitheal-board-session": directory.headers()["x-meitheal-board-session"]! }
  const made = await app.api.post(app.base + "/api/tasks", { headers, data: { title: `${label} Household secret` } })
  expect(made.status()).toBe(201)
  const task = await made.json()
  const project = await app.api.post(app.base + "/api/projects", { headers, data: { title: `${label} Project secret` } })
  expect(project.status()).toBe(201)
  const projectId = (await project.json()).id as string
  const board = await app.api.post(app.base + "/api/boards", { headers, data: { name: `${label} Board` } })
  expect(board.status()).toBe(201)
  const boardId = (await board.json()).id as string
  const named = await app.api.post(app.base + `/api/boards/${boardId}/tickets`, { headers, data: { title: `${label} Named secret` } })
  expect(named.status()).toBe(201)
  const namedTask = await named.json()
  const namedRead = await app.api.get(app.base + `/api/boards/${boardId}?view=tasks`)
  expect(namedRead.status()).toBe(200)
  expect(await namedRead.text()).toContain(`${label} Named secret`)
  const enrolled = await app.api.post(app.base + "/api/agent-tokens", { headers, data: {
    name: "Continuity HTTP custody", scopes: ["tasks:read", "projects:read", "search:read", "mcp:execute"],
  } })
  expect(enrolled.status()).toBe(201)
  // Keep the signed bearer only in memory; assertions must never print it.
  const token: string = (await enrolled.json()).token
  const agent = { authorization: `Bearer ${token}`, cookie: "", "x-meitheal-board-id": "household" }
  expect((await app.api.get(app.base + `/api/tasks/${task.id}`, { headers: agent })).status()).toBe(403)
  const taskRead = await app.directApi.get(app.origin + `/api/tasks/${task.id}`, { headers: agent })
  expect(taskRead.status()).toBe(200)
  expect((await taskRead.json()).id).toBe(task.id)
  const projectRead = await app.directApi.get(app.origin + `/api/projects/${projectId}`, { headers: agent })
  expect(projectRead.status()).toBe(200)
  for (const [name, id] of [["getTask", task.id], ["getProject", projectId]]) {
    const response = await app.directApi.post(app.origin + "/api/mcp", { headers: agent,
      data: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: { id } } } })
    expect(response.status(), (await response.text()).slice(0, 600)).toBe(200)
    const body = await response.json()
    expect(body.error).toBeUndefined()
    expect(body.result.isError).not.toBe(true)
    expect(JSON.parse(body.result.content[0].text).id).toBe(id)
  }
  return { agent, taskId: task.id as string, ticketKey: task.ticket_key as string, projectId, boardId, namedId: namedTask.id as string,
    secrets: [label, task.id as string, task.ticket_key as string].filter(Boolean) }
}
type Capture = Awaited<ReturnType<typeof currentCapture>>

async function locked(app: Server, work: string, capture?: Capture, extraSecrets: string[] = []) {
  const before = governedRecords(work)
  const paths = ["/", "/boards", "/tasks", "/today", "/calendar", "/goals", "/api/tasks", "/api/tasks/today-counts", "/api/goals", "/api/projects",
    "/api/search?q=secret", "/api/export/tasks.json", "/api/export/tasks.csv", "/api/export/tasks.ics", "/api/sse", "/api/boards"]
  if (capture) paths.push(`/api/tasks/${capture.taskId}`, `/api/projects/${capture.projectId}`, `/api/boards/${capture.boardId}`,
    `/boards/${capture.boardId}`, `/api/tasks/${capture.namedId}`)
  if (capture?.ticketKey) paths.push(`/api/tasks/${capture.ticketKey}`, `/tasks?task=${capture.ticketKey}`)
  const secrets = [...(capture?.secrets ?? []), ...extraSecrets]
  for (const path of paths) for (const method of ["GET", "HEAD"]) {
    const response = await app.api.fetch(app.base + path, { method, maxRedirects: 0 })
    expect(response.status(), `${method} ${path}`).toBe(503)
    expect(response.headers()["cache-control"]).toContain("no-store")
    const body = await response.text()
    if (method === "HEAD") expect(body).toBe("")
    else expect(body).toContain("continuity is locked")
    for (const secret of secrets) expect(body).not.toContain(secret)
  }
  for (const path of ["/api/tasks", "/api/projects", "/api/goals", "/api/boards"]) {
    const response = await app.api.post(app.base + path, { data: { title: "forbidden continuity write", name: "forbidden" } })
    expect(response.status(), `POST ${path}`).toBe(503)
  }
  const exported = await app.api.post(app.base + "/api/export/database.sqlite", { data: {} })
  expect(exported.status()).toBe(503)
  if (capture) {
    for (const path of [`/api/tasks/${capture.taskId}`, `/api/projects/${capture.projectId}`, "/api/tasks", "/api/tasks/today-counts", "/api/search?q=secret"]) {
      const response = await app.directApi.get(app.origin + path, { headers: capture.agent })
      expect(response.status(), `authenticated agent ${path}`).toBe(503)
      for (const secret of secrets) expect(await response.text()).not.toContain(secret)
    }
    for (const [name, id] of [["getTask", capture.taskId], ["getProject", capture.projectId]]) {
      for (const modern of [false, true]) {
        const response = await app.directApi.post(app.origin + "/api/mcp", {
          headers: { ...capture.agent, ...(modern ? { "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/call", "mcp-name": name } : {}) },
          data: { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: { id } } },
        })
        expect(response.status(), `authenticated MCP ${name}`).toBe(503)
        for (const secret of secrets) expect(await response.text()).not.toContain(secret)
      }
    }
  }
  for (const path of ["/api/health"]) {
    const response = await app.api.get(app.base + path)
    expect([200, 503]).toContain(response.status())
    const body = await response.text()
    expect(body, path).not.toContain("Installation continuity is locked")
    expect(JSON.parse(body)).toMatchObject({ service: "meitheal-web", db_status: "connected" })
    for (const secret of secrets) expect(body).not.toContain(secret)
    expect((await app.api.head(app.base + path)).status()).toBe(200)
  }
  const asset = (await readdir(join(web, "dist/client/_astro"))).find(name => name.endsWith(".js"))!
  const staticResponse = await app.api.get(app.base + "/_astro/" + asset)
  expect(staticResponse.status()).toBe(200)
  expect(hash(await staticResponse.body())).toBe(hash(await readFile(join(web, "dist/client/_astro", asset))))
  expect(governedRecords(work)).toEqual(before)
}

test("fresh actual startup and matching-current restart retain native and named capture plus signed REST/MCP", async ({ playwright }) => {
  const work = await mkdtemp(join(tmpdir(), "continuity-http-current-"))
  let app: Server | undefined
  try {
    app = await server(work, playwright)
    expect(JSON.parse(await readFile(markerPath(work), "utf8")).epoch).toMatch(/^[a-f0-9-]{36}$/)
    const capture = await currentCapture(app, "Current" + randomUUID())
    const current = await readFile(markerPath(work), "utf8")
    await app.close(); app = undefined
    const before = governedRecords(work)
    app = await server(work, playwright)
    expect(await readFile(markerPath(work), "utf8")).toBe(current)
    const read = await app.directApi.get(app.origin + `/api/tasks/${capture.taskId}`, { headers: capture.agent })
    expect(read.status()).toBe(200)
    expect((await read.json()).id).toBe(capture.taskId)
    expect(governedRecords(work)).toEqual(before)
    await currentCapture(app, "Restart" + randomUUID())
  } finally { await app?.close(); await rm(work, { recursive: true, force: true }) }
})

for (const loss of ["removed", "invalid", "different-current-epoch"] as const) {
  test(`real HTTP globally closes ${loss} marker live and after process restart`, async ({ playwright }) => {
    const work = await mkdtemp(join(tmpdir(), "continuity-http-loss-"))
    let app: Server | undefined
    try {
      app = await server(work, playwright)
      const capture = await currentCapture(app, "Private" + randomUUID())
      if (loss === "removed") await rm(markerPath(work))
      else await writeFile(markerPath(work), loss === "invalid" ? "not-json" : JSON.stringify({ epoch: randomUUID() }), { mode: 0o600 })
      await locked(app, work, capture)
      await app.close(); app = undefined
      const before = governedRecords(work)
      app = await server(work, playwright)
      await locked(app, work, capture)
      expect(governedRecords(work)).toEqual(before)
    } finally { await app?.close(); await rm(work, { recursive: true, force: true }) }
  })
}

for (const retainCurrentMarker of [false, true]) {
  test(`actual cold pre-first-grant replay denies HTTP with ${retainCurrentMarker ? "independently newer" : "excluded absent"} marker`, async ({ playwright }, testInfo) => {
    const work = await mkdtemp(join(tmpdir(), "continuity-http-cold-"))
    const database = databasePath(work)
    const marker = markerPath(work)
    const custody = await mkdtemp(join(tmpdir(), "continuity-http-external-custody-"))
    const cold = join(custody, "pre-first-grant.db")
    const previous = process.env.MEITHEAL_DB_URL
    let app: Server | undefined
    try {
      // Real existing legacy file: schema creation has no exclusive-file startup
      // capability. This is never made by deleting a current epoch row.
      process.env.MEITHEAL_DB_URL = "file:" + database
      resetPersistenceForTests()
      await writeFile(database, "", { mode: 0o600 })
      await ensureSchema({ markerPath: marker })
      const db = getPersistenceClient()
      expect((await db.execute("SELECT revision FROM board_access_epoch")).rows).toEqual([])
      await db.execute(`INSERT INTO tasks(id,title,status,ticket_number,idempotency_key,request_id,created_at,updated_at)
        VALUES ('cold-household-secret','Cold pregrant Household secret','pending',1,'cold-idempotency','cold-request',1,1)`)
      await db.execute("INSERT INTO goals(id,title,status,created_at,updated_at) VALUES ('cold-goal-secret','Cold pregrant Goal secret','active',1,1)")
      await db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
      resetPersistenceForTests()
      await copyFile(database, cold)
      const originalColdHash = hash(await readFile(cold))
      await testInfo.attach("original-cold-pre-first-grant.db", { path: cold, contentType: "application/vnd.sqlite3" })
      const identity = { installationId: "synthetic-independent-http-current", appSlug: "meitheal_canary",
        image: "ghcr.io/example/meitheal@sha256:" + "a".repeat(64), source: "b".repeat(40) }
      const manifest = { kind: "meitheal-current-legacy-checkpoint-v1", checkpointId: "independently-current-http", ...identity,
        archiveSha256: originalColdHash, databaseFamily: { database: originalColdHash, wal: null, shm: null, journal: null } }
      const manifestBytes = JSON.stringify(manifest)
      const manifestPath = join(custody, "manifest.json")
      await writeFile(manifestPath, manifestBytes, { mode: 0o600 })
      await writeFile(join(custody, "current.json"), JSON.stringify({ kind: "meitheal-current-continuity-attestation-v1", checkpointId: manifest.checkpointId,
        manifestSha256: hash(manifestBytes), ...identity, state: "current", coreOwnerVerified: true, appStopped: true,
        noNewerGrantOrLifecycleChange: true, verificationId: "independent-synthetic-owner-custody-http" }), { mode: 0o600 })
      execFileSync(process.execPath, ["scripts/enroll-legacy-continuity.mjs", "--database", database, "--marker", marker,
        "--custody-directory", custody, "--manifest", manifestPath, "--archive", cold, "--installation", identity.installationId,
        "--app-slug", identity.appSlug, "--image", identity.image, "--source", identity.source], { cwd: web, stdio: "pipe" })
      app = await server(work, playwright)
      const knownTask = await app.api.get(app.base + "/api/tasks/cold-household-secret")
      expect(knownTask.status()).toBe(200)
      expect((await knownTask.json()).title).toBe("Cold pregrant Household secret")
      const capture = await currentCapture(app, "Descendant" + randomUUID())
      const features = await app.api.get(app.base + "/api/organization-features")
      expect(features.status()).toBe(200)
      const settings = await features.json()
      expect((await app.api.put(app.base + "/api/organization-features", {
        headers: { "x-meitheal-area-admin": features.headers()["x-meitheal-area-admin"]! },
        data: { feature: "goals", audience: "nobody", users: [], revision: settings.features.goals.revision },
      })).status()).toBe(204)
      expect((await app.api.get(app.base + "/api/goals")).status()).toBe(404)
      const household = await app.api.get(app.base + "/api/boards")
      expect(household.status()).toBe(200)
      const exampleBoard = (await household.json()).boards.find((board: { id: string }) => board.id === "household")
      expect(exampleBoard).toBeDefined()
      const revision = exampleBoard.revision
      const retired = await app.api.patch(app.base + "/api/boards/household", {
        headers: { "x-meitheal-board-session": household.headers()["x-meitheal-board-session"]! }, data: { action: "retire", revision },
      })
      expect(retired.status()).toBe(200)
      const retiredRead = await app.api.get(app.base + "/api/tasks/cold-household-secret")
      expect(retiredRead.status()).toBe(403)
      const unavailable = await retiredRead.text()
      expect(unavailable).not.toContain("Cold pregrant Household secret")
      expect(unavailable).not.toContain("cold-household-secret")
      const current = await readFile(marker)
      await app.close(); app = undefined
      const restricted = governedRecords(work)
      expect((restricted.organization_access_policies as Array<{ audience: string }>).some(row => row.audience === "nobody")).toBe(true)
      expect((restricted.task_boards as Array<{ id: string; state: string }>).find(row => row.id === "household")?.state).toBe("retired")
      await evidenceJson(testInfo, "independent-descendant-restrictions.json", { originalColdHash, markerSha256: hash(current), governedRecords: restricted })
      // Offline restore replaces the entire SQLite family with the exact cold
      // bytes; the separately retained current marker is never derived from it.
      for (const suffix of ["", "-wal", "-shm", "-journal"]) await rm(database + suffix, { force: true })
      await copyFile(cold, database)
      expect(hash(await readFile(database))).toBe(originalColdHash)
      await rm(marker, { force: true })
      if (retainCurrentMarker) await writeFile(marker, current, { mode: 0o600 })
      const restored = governedRecords(work)
      app = await server(work, playwright)
      // The descendant bearer is not counted: its token does not exist in the
      // predecessor DB. Authenticated signed-agent denial is proven above.
      await locked(app, work, undefined, ["cold-household-secret", "Cold pregrant Household secret", "cold-goal-secret", "Cold pregrant Goal secret", "MTH-1", ...capture.secrets])
      expect(governedRecords(work)).toEqual(restored)
      await evidenceJson(testInfo, "cold-replay-proof.json", { originalColdHash,
        retainedIndependentlyNewerMarker: retainCurrentMarker, newerMarkerSha256: hash(current), restoredGovernedRecords: restored,
        result: "real HTTP governed GET/HEAD/POST 503; diagnostics available; unchanged governed records" })
      const replay = new DatabaseSync(database, { readOnly: true })
      try { expect(replay.prepare("SELECT revision FROM board_access_epoch").all()).toEqual([]) } finally { replay.close() }
      expect(hash(await readFile(cold))).toBe(originalColdHash)
      expect(await readFile(join(custody, "consumed/independently-current-http.json"), "utf8")).toContain("consumed-before-enrollment")
    } finally {
      resetPersistenceForTests()
      if (previous === undefined) delete process.env.MEITHEAL_DB_URL
      else process.env.MEITHEAL_DB_URL = previous
      await app?.close()
      await rm(work, { recursive: true, force: true })
      await rm(custody, { recursive: true, force: true })
    }
  })
}
