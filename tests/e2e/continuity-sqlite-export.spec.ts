import { createRequire } from "node:module"
import { mkdtemp, open, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { expect, test } from "@playwright/test"
import { POST as downloadDatabase } from "../../apps/web/src/pages/api/export/database.sqlite"
import { issueDatabaseDownloadToken } from "../../apps/web/src/lib/database-download-token"
import { runWithIngressTransport } from "../../apps/web/scripts/ingress-transport.mjs"
import { NamedBoardRepository } from "../../apps/web/src/domains/tasks/persistence/named-board-repository"
import { ensureSchema, getPersistenceClient, resetPersistenceForTests } from "../helpers/persistence-fixture"

const { WebSocket, WebSocketServer } = createRequire(new URL("../../apps/web/package.json", import.meta.url))("ws")
let work: string
let marker: string
let database: string
let knownCurrentMarker: Buffer
let core: InstanceType<typeof WebSocketServer>
let originalSocket: typeof globalThis.WebSocket
let originalEnv: Record<string, string | undefined>

function gate() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

test.beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), "continuity-sqlite-export-"))
  database = join(work, "tasks.db")
  marker = join(work, "grants.json")
  originalEnv = Object.fromEntries(["MEITHEAL_DB_URL", "SUPERVISOR_TOKEN"].map(key => [key, process.env[key]]))
  process.env.MEITHEAL_DB_URL = "file:" + database
  process.env.SUPERVISOR_TOKEN = "synthetic-export-owner"
  resetPersistenceForTests()
  await ensureSchema({ markerPath: marker })
  knownCurrentMarker = await readFile(marker)
  const db = getPersistenceClient()
  await db.execute("CREATE TABLE export_probe (id INTEGER PRIMARY KEY, payload BLOB)")
  await db.execute("WITH RECURSIVE blocks(n) AS (VALUES(1) UNION ALL SELECT n + 1 FROM blocks WHERE n < 128) INSERT INTO export_probe SELECT n, randomblob(4096) FROM blocks")
  core = new WebSocketServer({ host: "127.0.0.1", port: 0 })
  await new Promise<void>(resolve => core.once("listening", resolve))
  core.on("connection", (socket: InstanceType<typeof WebSocket>) => {
    socket.send(JSON.stringify({ type: "auth_required" }))
    socket.on("message", (raw: Buffer) => {
      const message = JSON.parse(raw.toString())
      if (message.type === "auth") socket.send(JSON.stringify({ type: "auth_ok" }))
      else if (message.type === "config/auth/list") socket.send(JSON.stringify({ type: "result", id: message.id, success: true,
        result: [{ id: "export-owner", is_active: true, system_generated: false, is_owner: true, group_ids: ["system-admin"] }] }))
    })
  })
  originalSocket = globalThis.WebSocket
  class FixtureSocket extends WebSocket {
    constructor(address: string, options: unknown) {
      if (address !== "ws://supervisor/core/api/websocket") throw new Error("Unexpected Core target")
      super(`ws://127.0.0.1:${core.address().port}`, options)
    }
  }
  globalThis.WebSocket = FixtureSocket as unknown as typeof globalThis.WebSocket
})

test.afterEach(async () => {
  globalThis.WebSocket = originalSocket
  for (const socket of core.clients) socket.terminate()
  await new Promise<void>(resolve => core.close(() => resolve()))
  resetPersistenceForTests()
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  await rm(work, { recursive: true, force: true })
})

function download(signal = new AbortController().signal) {
  const token = issueDatabaseDownloadToken("export-owner")
  const request = new Request("http://export.test/api/export/database.sqlite", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }), signal,
  })
  return runWithIngressTransport({ peer: "172.30.32.2", fromSupervisor: true, identityHeadersSafe: true, configuredPath: "/ingress",
    waitForDatabaseDownloadDrain: () => !signal.aborted }, () => downloadDatabase({
    request, locals: { behindIngress: true, hassUserId: "export-owner", hassIsAdmin: true },
  } as Parameters<typeof downloadDatabase>[0]))
}

const snapshots = async () => (await readdir(work)).filter(name => name.startsWith(".meitheal-export-"))

async function validDownload() {
  const response = await download()
  expect(response.status).toBe(200)
  expect(response.headers.get("content-disposition")).toContain("attachment;")
  const exported = join(work, "download.sqlite")
  await writeFile(exported, new Uint8Array(await response.arrayBuffer()))
  const db = new DatabaseSync(exported, { readOnly: true })
  try {
    expect(db.prepare("PRAGMA integrity_check").get()?.integrity_check).toBe("ok")
    expect(db.prepare("SELECT COUNT(*) AS count FROM export_probe").get()?.count).toBe(128)
  } finally { db.close() }
  await expect.poll(snapshots).toEqual([])
}

test("a current verified owner downloads a complete SQLite snapshot and cancellation releases the single export lease", async () => {
  await validDownload()
  const response = await download()
  expect(response.status).toBe(200)
  const reader = response.body!.getReader()
  expect((await reader.read()).value!.byteLength).toBeGreaterThan(0)
  expect((await download()).status).toBe(409)
  await reader.cancel()
  await expect.poll(snapshots).toEqual([])
  await validDownload()
})

for (const change of ["marker-loss", "new-revision"] as const) {
  test(`an in-flight snapshot withholds every next chunk after ${change}`, async () => {
    await validDownload()
    const response = await download()
    expect(response.status).toBe(200)
    const reader = response.body!.getReader()
    try {
      expect((await reader.read()).value!.byteLength).toBeGreaterThan(0)
      if (change === "marker-loss") await rm(marker)
      else expect(await new NamedBoardRepository(getPersistenceClient()).changeLifecycle({ kind: "ha_user", id: "export-owner" }, "household", "retired", 1, true))
        .toMatchObject({ status: "committed", result: "saved" })
      await expect(reader.read()).rejects.toThrow(/continuity|authority/i)
      await expect.poll(snapshots).toEqual([])
    } finally { await reader.cancel().catch(() => {}) }
    if (change === "marker-loss") {
      expect((await download()).status).toBe(503)
      // Synthetic control restores bytes retained before the loss, never derived from SQLite.
      await writeFile(marker, knownCurrentMarker)
    } else expect(await new NamedBoardRepository(getPersistenceClient()).changeLifecycle({ kind: "ha_user", id: "export-owner" }, "household", "active", 2, true))
      .toMatchObject({ status: "committed", result: "saved" })
    await validDownload()
  })

  test(`a completed real backup is withheld before body publication after ${change}`, async () => {
    const raw = getPersistenceClient()
    const execute = raw.execute.bind(raw)
    const entered = gate()
    const release = gate()
    let held = false
    raw.execute = async (...args: Parameters<typeof raw.execute>) => {
      const statement = args[0] as unknown as string | { sql: string }
      const sql = typeof statement === "string" ? statement : statement.sql
      if (!held && sql === "SELECT revision FROM board_access_epoch WHERE singleton = 1" && (await snapshots()).length) {
        const snapshotDirectory = (await snapshots())[0]!
        const completedCopy = await readFile(join(work, snapshotDirectory, "snapshot.tmp"))
        expect(completedCopy.subarray(0, 16).toString()).toBe("SQLite format 3\0")
        held = true
        entered.resolve()
        await release.promise
      }
      return execute(...args)
    }
    const pending = Promise.resolve(download())
    try {
      await Promise.race([entered.promise, pending.then(() => { throw new Error("Route published its body before the authority gate") })])
      if (change === "marker-loss") await rm(marker)
      else expect(await new NamedBoardRepository(getPersistenceClient()).changeLifecycle({ kind: "ha_user", id: "export-owner" }, "household", "retired", 1, true))
        .toMatchObject({ status: "committed", result: "saved" })
      release.resolve()
      const response = await pending
      expect(response.status).toBe(503)
      expect(response.headers.get("content-disposition")).toBeNull()
      expect(await response.text()).toContain("authority changed")
      await expect.poll(snapshots).toEqual([])
    } finally { release.resolve(); await pending.then(response => response.body?.cancel()).catch(() => {}); raw.execute = execute }
    if (change === "marker-loss") await writeFile(marker, knownCurrentMarker)
    else expect(await new NamedBoardRepository(getPersistenceClient()).changeLifecycle({ kind: "ha_user", id: "export-owner" }, "household", "active", 2, true))
      .toMatchObject({ status: "committed", result: "saved" })
    await validDownload()
  })
}

test("a real snapshot chunk read that finishes after marker loss cannot enqueue its bytes", async () => {
  const probe = await open(database, "r")
  const prototype = Object.getPrototypeOf(probe)
  await probe.close()
  const originalRead = prototype.read
  const entered = gate()
  const release = gate()
  let held = false
  prototype.read = async function (...args: unknown[]) {
    const result = await Reflect.apply(originalRead, this, args) as { bytesRead: number }
    if (!held && Buffer.isBuffer(args[0]) && args[0].byteLength === 64 * 1024) {
      held = true
      expect(result.bytesRead).toBeGreaterThan(0)
      entered.resolve()
      await release.promise
    }
    return result
  }
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  try {
    const response = await download()
    expect(response.status).toBe(200)
    reader = response.body!.getReader()
    const read = reader.read()
    const denied = expect(read).rejects.toThrow(/continuity|authority/i)
    await entered.promise
    await rm(marker)
    release.resolve()
    await denied
    await expect.poll(snapshots).toEqual([])
  } finally { release.resolve(); await reader?.cancel().catch(() => {}); prototype.read = originalRead }
  await writeFile(marker, knownCurrentMarker)
  await validDownload()
})

test("request abort while the snapshot waits for a reader closes its file and releases the lease", async () => {
  const controller = new AbortController()
  const response = await download(controller.signal)
  expect(response.status).toBe(200)
  expect(await snapshots()).toHaveLength(1)
  controller.abort()
  await expect.poll(snapshots).toEqual([])
  await response.body!.cancel().catch(() => {})
  await validDownload()
})
