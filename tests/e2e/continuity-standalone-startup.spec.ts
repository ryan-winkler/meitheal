import { spawn, type ChildProcess } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { once } from "node:events"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { get as httpGet } from "node:http"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { expect, test, type TestInfo } from "@playwright/test"

// Exercise the shipped wrapper itself: no migrate command, preload, replacement
// handler, or test-only initialization capability precedes this child process.
const web = resolve(import.meta.dirname, "../../apps/web")
test.setTimeout(60_000)

async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return
  const ended = once(child, "exit")
  child.kill("SIGTERM")
  const timeout = setTimeout(() => child.kill("SIGKILL"), 5_000)
  try { await ended } finally { clearTimeout(timeout) }
}

async function standalone(work: string) {
  const reservation = createServer()
  reservation.listen(0, "127.0.0.1")
  await once(reservation, "listening")
  const address = reservation.address()
  if (!address || typeof address === "string") throw new Error("Port reservation did not bind")
  const port = address.port
  await new Promise<void>((done, reject) => reservation.close(error => error ? reject(error) : done()))
  const env: NodeJS.ProcessEnv = { ...process.env, HOST: "127.0.0.1", PORT: String(port),
    MEITHEAL_DB_URL: "file:" + join(work, "standalone.db"), MEITHEAL_BOARD_GRANT_PATH: join(work, "grants.json") }
  // This is a standalone startup test, not an inherited Supervisor session.
  delete env.SUPERVISOR_TOKEN
  delete env.MEITHEAL_STARTUP_BACKUP_HANDLED
  delete env.INGRESS_PATH
  delete env.HA_BASE_URL
  delete env.HA_TOKEN
  const child = spawn(process.execPath, ["scripts/serve.mjs"], { cwd: web, env, stdio: ["ignore", "pipe", "pipe"] })
  let log = ""
  const collect = (bytes: Buffer) => { log = (log + bytes.toString()).slice(-32_768) }
  child.stderr!.on("data", collect)
  child.stdout!.on("data", collect)
  try {
    await new Promise<void>((done, reject) => {
      const timeout = setTimeout(() => finish(new Error("Standalone startup timed out\n" + log)), 15_000)
      const onExit = (code: number | null, signal: string | null) => finish(new Error(`Standalone exited ${code ?? signal}\n${log}`))
      const onError = (error: Error) => finish(error)
      const onData = () => { if (log.includes(`Meitheal server listening on http://127.0.0.1:${port}`)) finish() }
      const finish = (error?: Error) => {
        clearTimeout(timeout)
        child.off("exit", onExit)
        child.off("error", onError)
        child.stdout!.off("data", onData)
        error ? reject(error) : done()
      }
      child.once("exit", onExit)
      child.once("error", onError)
      child.stdout!.on("data", onData)
      onData()
    })
    const origin = `http://127.0.0.1:${port}`
    return { origin, logs: () => log, close: () => stop(child) }
  } catch (error) { await stop(child); throw error }
}

function state(work: string) {
  const db = new DatabaseSync(join(work, "standalone.db"), { readOnly: true })
  try {
    return { epoch: db.prepare("SELECT revision FROM board_access_epoch WHERE singleton = 1").get()?.revision ?? null,
      tasks: db.prepare("SELECT id, title FROM tasks ORDER BY id").all() }
  } finally { db.close() }
}

async function evidence(info: TestInfo, value: unknown) {
  const path = info.outputPath("standalone-startup.json")
  await writeFile(path, JSON.stringify(value, null, 2))
  await info.attach("standalone-startup", { path, contentType: "application/json" })
}

test("standalone fresh startup keeps both Board capture receipts across restart", async ({}, info) => {
  const work = await mkdtemp(join(tmpdir(), "continuity-standalone-fresh-"))
  let app: Awaited<ReturnType<typeof standalone>> | undefined
  const logs: string[] = []
  try {
    app = await standalone(work)
    const initial = state(work)
    expect(initial).toEqual({ epoch: expect.stringMatching(/^[a-f0-9-]{36}$/), tasks: [] })
    expect(JSON.parse(await readFile(join(work, "grants.json"), "utf8"))).toEqual({ epoch: initial.epoch })
    const health = await fetch(app.origin + "/api/health", { signal: AbortSignal.timeout(5_000) })
    expect(health.status).toBe(200)
    expect((await health.json()).schema_version).toBe(26)
    const directory = await fetch(app.origin + "/api/boards", { signal: AbortSignal.timeout(5_000) })
    expect(directory.status).toBe(200)
    const proof = directory.headers.get("x-meitheal-board-session")
    expect(Boolean(proof && /^[a-f0-9]{64}$/.test(proof))).toBe(true)
    const post = { origin: app.origin, "content-type": "application/json", "x-meitheal-board-session": proof! }
    const board = await fetch(app.origin + "/api/boards", { method: "POST", headers: post,
      signal: AbortSignal.timeout(5_000), body: JSON.stringify({ name: "Standalone second Board" }) })
    expect(board.status, await board.clone().text()).toBe(201)
    const { id: secondId } = await board.json()
    expect(secondId).toEqual(expect.any(String))
    expect(secondId).not.toBe("household")

    const attempt = randomUUID()
    const receipts = []
    for (const [id, path, title] of [
      ["household", "/api/tasks", "Standalone first capture"],
      [secondId, "/api//boards/" + encodeURIComponent(secondId) + "/tickets", "Standalone second capture"],
    ]) {
      const created = await fetch(app.origin + path, { method: "POST", redirect: "manual", signal: AbortSignal.timeout(5_000),
        headers: { ...post, "x-meitheal-board-id": id, "x-meitheal-capture-attempt": attempt }, body: JSON.stringify({ title }) })
      expect(created.status, await created.clone().text()).toBe(201)
      expect(created.headers.get("cache-control")).toBe("private, no-store")
      const task = await created.json()
      expect(task).toMatchObject({ id: expect.any(String), board_id: id, title })
      receipts.push({ boardId: id, id: task.id, ticket_key: task.ticket_key, task_kind: task.task_kind })
    }
    expect(new Set(receipts.map(receipt => receipt.id)).size).toBe(2)
    const committed = state(work)
    expect(committed.tasks).toHaveLength(2)
    const marker = await readFile(join(work, "grants.json"))
    expect(JSON.parse(marker.toString())).toEqual({ epoch: committed.epoch })
    logs.push(app.logs())
    await app.close()
    app = await standalone(work)
    expect(state(work)).toEqual(committed)
    expect(await readFile(join(work, "grants.json"))).toEqual(marker)
    for (const { boardId, ...record } of receipts) {
      const retained = await fetch(app.origin + "/api/tasks/" + encodeURIComponent(record.id), {
        headers: { "x-meitheal-board-id": boardId }, signal: AbortSignal.timeout(5_000),
      })
      expect(retained.status).toBe(200)
      expect(await retained.json()).toMatchObject({ id: record.id, board_id: boardId })
      const headers = { "x-meitheal-board-id": boardId, "x-meitheal-capture-attempt": attempt, referer: app.origin + "/today" }
      for (const path of ["/api/tasks?captureReceipt=1", "/api//tasks?captureReceipt=1"]) {
        const response = await fetch(app.origin + path, { headers, redirect: "manual", signal: AbortSignal.timeout(5_000) })
        expect(response.status, await response.clone().text()).toBe(200)
        expect(response.headers.get("cache-control")).toBe("private, no-store")
        expect(await response.json()).toEqual(record)
      }
      const head = await fetch(app.origin + "/api/tasks?captureReceipt=1", { method: "HEAD", headers, signal: AbortSignal.timeout(5_000) })
      expect(head.status).toBe(200)
      expect(head.headers.get("cache-control")).toBe("private, no-store")
      expect(await head.text()).toBe("")
    }
    logs.push(app.logs())
    expect(logs.every(log => !log.includes(attempt))).toBe(true)
    await evidence(info, { taskCount: state(work).tasks.length, recoveredBoards: receipts.length,
      markerSha256: createHash("sha256").update(marker).digest("hex") })
  } finally { if (app) await app.close(); await rm(work, { recursive: true, force: true }) }
})

test("standalone wrapper keeps receipt routing private before task handlers", async () => {
  const work = await mkdtemp(join(tmpdir(), "receipt-wrapper-"))
  let app: Awaited<ReturnType<typeof standalone>> | undefined
  try {
    app = await standalone(work)
    const before = state(work)
    const db = new DatabaseSync(join(work, "standalone.db"), { readOnly: true })
    const schemaVersion = db.prepare("SELECT value FROM app_settings WHERE key = 'schema_version'").get()?.value
    expect(schemaVersion).toBe("26")
    db.close()
    const captureHeaders = {
      "x-meitheal-capture-attempt": randomUUID(),
      "x-meitheal-board-id": "fixture-board",
    }
    const origin = app.origin
    // Fetch strips fragments before sending; pass the raw health target through Node.
    const malformedTarget = await new Promise<{ status: number | undefined; cacheControl: string | undefined }>((done, reject) => {
      const { hostname, port } = new URL(origin)
      httpGet({ hostname, port, path: "/api/health#fragment", signal: AbortSignal.timeout(5_000) }, response => {
        response.once("error", reject)
        response.once("end", () => done({ status: response.statusCode, cacheControl: response.headers["cache-control"] }))
        response.resume()
      }).once("error", reject)
    })
    expect(malformedTarget).toEqual({ status: 400, cacheControl: "private, no-store" })
    const encodedValue = await fetch(origin + "/api/health?reference=qa%23note", { signal: AbortSignal.timeout(5_000) })
    expect(encodedValue.status).toBe(200)
    const send = (path: string, method = "GET", title = "Receipt wrapper fixture", withAttempt = true) => fetch(origin + path, {
      method, redirect: "manual", signal: AbortSignal.timeout(5_000),
      headers: {
        ...(withAttempt ? captureHeaders : {}), referer: origin + "/today",
        ...(method === "POST" ? { origin, "content-type": "application/json" } : {}),
      },
      ...(method === "POST" ? { body: JSON.stringify({ title }) } : {}),
    })
    const privateResponse = (response: Response) => {
      expect(response.headers.get("cache-control")).toBe("private, no-store")
      expect(response.headers.has("location")).toBe(false)
    }

    for (const selector of ["1", "invalid"]) {
      const search = "?captureReceipt=" + selector + "&limit=17"
      const canonical = await send("/api/tasks" + search)
      const repeatedSeparators = await send("/api//tasks" + search)
      const head = await send("/api/tasks" + search, "HEAD")
      for (const response of [canonical, repeatedSeparators, head]) privateResponse(response)
      expect([400, 403, 404]).toContain(canonical.status)
      expect(canonical.headers.get("content-type")).toMatch(/^application\/(?:problem\+)?json/)
      expect(repeatedSeparators.status).toBe(canonical.status)
      expect(head.status).toBe(canonical.status)
      expect(await head.text()).toBe("")
      const body = await canonical.json()
      expect(await repeatedSeparators.json()).toEqual(body)
    }
    for (const [canonicalPath, normalizedPath] of [
      ["/api/tasks", "/api//tasks"],
      ["/api/boards/fixture-board/tickets", "/api//boards/fixture-board/tickets"],
    ] as const) {
      const canonical = await send(canonicalPath, "POST", "")
      const repeatedSeparators = await send(normalizedPath, "POST", "")
      expect([400, 403, 404]).toContain(canonical.status)
      expect(canonical.headers.get("content-type")).toMatch(/^application\/(?:problem\+)?json/)
      privateResponse(canonical)
      privateResponse(repeatedSeparators)
      expect(repeatedSeparators.status).toBe(canonical.status)
      const body = await canonical.json()
      expect(await repeatedSeparators.json()).toEqual(body)
    }
    for (const [method, path] of [
      ["GET", "/api/tasks/?captureReceipt=1"],
      ["HEAD", "/api/tasks/?captureReceipt=1"],
      ["GET", "/api/%74asks?captureReceipt=invalid"],
      ["POST", "/api/tasks/"],
      ["POST", "/api/boards/fixture-board/tickets/"],
      ["POST", "/api/boards/fixture%2Dboard/tickets"],
    ] as const) {
      const response = await send(path, method)
      expect(response.status).toBe(404)
      privateResponse(response)
    }
    for (const selector of ["1", "invalid"]) {
      const response = await send("/api/tasks?captureReceipt=" + selector, "POST", "Receipt wrapper fixture", false)
      expect(response.status).toBe(405)
      expect(response.headers.get("allow")).toBe("GET, HEAD")
      privateResponse(response)
    }
    expect(state(work)).toEqual(before)
  } finally {
    await app?.close()
    await rm(work, { recursive: true, force: true })
  }
})

for (const predecessor of ["empty", "sqlite"] as const) {
  test(`standalone pre-existing ${predecessor} epochless storage stays locked across startup and restart`, async ({}, info) => {
    const work = await mkdtemp(join(tmpdir(), "continuity-standalone-unknown-"))
    let app: Awaited<ReturnType<typeof standalone>> | undefined
    const logs: string[] = []
    try {
      const database = join(work, "standalone.db")
      if (predecessor === "empty") await writeFile(database, "")
      else {
        const db = new DatabaseSync(database)
        try { db.exec("CREATE TABLE legacy_probe (value TEXT NOT NULL); INSERT INTO legacy_probe VALUES ('retained predecessor sentinel')") }
        finally { db.close() }
      }
      for (let restart = 0; restart < 2; restart++) {
        app = await standalone(work)
        expect(state(work)).toEqual({ epoch: null, tasks: [] })
        await expect(readFile(join(work, "grants.json"))).rejects.toMatchObject({ code: "ENOENT" })
        const before = state(work)
        for (const path of ["/tasks", "/api/tasks", "/api/boards", "/api/export/tasks.json"]) {
          const response = await fetch(app.origin + path, { redirect: "manual", signal: AbortSignal.timeout(5_000) })
          expect(response.status, path).toBe(503)
          expect(response.headers.get("cache-control")).toContain("no-store")
          const body = await response.text()
          expect(body).toContain("continuity is locked")
          expect(body).not.toContain("retained predecessor sentinel")
        }
        const write = await fetch(app.origin + "/api/tasks", { method: "POST", signal: AbortSignal.timeout(5_000),
          headers: { origin: app.origin, "content-type": "application/json" }, body: JSON.stringify({ title: "Denied unknown capture" }) })
        expect(write.status).toBe(503)
        expect(state(work)).toEqual(before)
        const health = await fetch(app.origin + "/api/health", { signal: AbortSignal.timeout(5_000) })
        expect(health.status).toBe(200)
        if (predecessor === "sqlite") {
          const db = new DatabaseSync(database, { readOnly: true })
          try { expect(db.prepare("SELECT value FROM legacy_probe").get()?.value).toBe("retained predecessor sentinel") }
          finally { db.close() }
        }
        logs.push(app.logs())
        await app.close()
        app = undefined
      }
      await evidence(info, { predecessor, final: state(work), logs })
    } finally { if (app) await app.close(); await rm(work, { recursive: true, force: true }) }
  })
}
