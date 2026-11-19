import { spawn, type ChildProcess } from "node:child_process"
import { createHash } from "node:crypto"
import { once } from "node:events"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
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

test("standalone fresh creation publishes continuity before HTTP capture and retains it on restart", async ({}, info) => {
  const work = await mkdtemp(join(tmpdir(), "continuity-standalone-fresh-"))
  let app: Awaited<ReturnType<typeof standalone>> | undefined
  const logs: string[] = []
  try {
    app = await standalone(work)
    const initial = state(work)
    expect(initial).toEqual({ epoch: expect.stringMatching(/^[a-f0-9-]{36}$/), tasks: [] })
    const marker = await readFile(join(work, "grants.json"))
    expect(JSON.parse(marker.toString())).toEqual({ epoch: initial.epoch })
    const health = await fetch(app.origin + "/api/health", { signal: AbortSignal.timeout(5_000) })
    expect(health.status).toBe(200)
    const created = await fetch(app.origin + "/api/tasks", { method: "POST", signal: AbortSignal.timeout(5_000),
      headers: { origin: app.origin, "content-type": "application/json" }, body: JSON.stringify({ title: "Standalone retained capture" }) })
    expect(created.status, await created.clone().text()).toBe(201)
    const task = await created.json()
    expect(task.id).toEqual(expect.any(String))
    logs.push(app.logs())
    await app.close()
    app = await standalone(work)
    expect(state(work)).toEqual({ epoch: initial.epoch, tasks: [{ id: task.id, title: "Standalone retained capture" }] })
    expect(await readFile(join(work, "grants.json"))).toEqual(marker)
    const retained = await fetch(app.origin + `/api/tasks/${task.id}`, { signal: AbortSignal.timeout(5_000) })
    expect(retained.status).toBe(200)
    expect(await retained.json()).toMatchObject({ id: task.id, title: "Standalone retained capture" })
    logs.push(app.logs())
    await evidence(info, { fresh: initial, retained: state(work), markerSha256: createHash("sha256").update(marker).digest("hex"), logs })
  } finally { if (app) await app.close(); await rm(work, { recursive: true, force: true }) }
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
