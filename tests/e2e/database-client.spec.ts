import { execFile } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:http"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { promisify } from "node:util"
import { expect, test } from "@playwright/test"
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import {
  DATABASE_SCHEMA_VERSION,
  executeWriteWithRetry,
  getDatabaseDiagnostics,
  openDatabase,
  resetDatabaseDiagnosticsForTests,
  runWriteTransaction,
} from "../../apps/web/scripts/database-client.mjs"

const webRequire = createRequire(new URL("../../apps/web/package.json", import.meta.url))
const execFileAsync = promisify(execFile)
const items = sqliteTable("items", {
  id: integer().primaryKey(),
  title: text().notNull(),
})

test("local results preserve libSQL row indices, metadata, bindings and JSON", async () => {
  const client = openDatabase("file::memory:?cache=private")
  try {
    expect(client.protocol).toBe("file")
    await client.executeMultiple("CREATE TABLE records(id INTEGER PRIMARY KEY, value TEXT, data BLOB);")
    const data = Uint8Array.of(0, 255).buffer
    const insert = await client.execute("INSERT INTO records VALUES (?, ?, ?)", [4n, "hello", data])
    expect(insert.toJSON()).toEqual({ columns: [], columnTypes: [], rows: [], rowsAffected: 1, lastInsertRowid: "4" })
    expect((await client.execute("CREATE INDEX records_value ON records(value)")).rowsAffected).toBe(0)

    const query = await client.execute(
      "SELECT id, value AS title, data, :flag AS title, :date AS date FROM records WHERE id = :id",
      { ":flag": true, date: new Date(1), id: 4 },
    )
    const row = query.rows[0]
    if (!row) throw new Error("Expected a local result row")
    expect(row.length).toBe(5)
    expect(row.title).toBe("hello")
    expect(row[3]).toBe(1)
    expect(row.data).toEqual(data)
    expect(Object.keys(row)).toEqual(["id", "title", "data", "date"])
    expect(query.toJSON()).toEqual({
      columns: ["id", "title", "data", "title", "date"],
      columnTypes: ["INTEGER", "TEXT", "BLOB", "", ""],
      rows: [[4, "hello", "AP8=", 1, 1]],
      rowsAffected: 0,
      lastInsertRowid: null,
    })
    const largeInsert = await client.execute("INSERT INTO records(id) VALUES (?)", [9007199254740993n])
    expect(largeInsert.lastInsertRowid).toBe(9007199254740993n)
    await expect(client.execute("SELECT id FROM records WHERE id > 4")).rejects.toThrow(RangeError)
  } finally {
    client.close()
  }
})

test("opens an existing libSQL file, keeps transactions isolated and rolls back failures", async () => {
  const directory = await mkdtemp(join(tmpdir(), "meitheal-sqlite-upgrade-"))
  const path = join(directory, "tasks with spaces.db")
  const old = webRequire("@libsql/client/sqlite3").createClient({ url: pathToFileURL(path).href })
  await old.executeMultiple("CREATE TABLE items(id INTEGER PRIMARY KEY, title TEXT NOT NULL UNIQUE); INSERT INTO items VALUES(1, 'original');")
  old.close()
  const client = openDatabase(pathToFileURL(path).href)
  try {
    expect((await client.execute("PRAGMA foreign_keys")).rows[0]?.[0]).toBe(1)
    const failed = await client.batch([
      ["INSERT INTO items VALUES (?, ?)", [2, "rolled back"]],
      ["INSERT INTO items VALUES (?, ?)", [3, "original"]],
    ], "write").catch(error => error)
    expect(failed).toMatchObject({
      statementIndex: 1, code: "SQLITE_CONSTRAINT", extendedCode: "SQLITE_CONSTRAINT_UNIQUE", rawCode: 2067,
    })
    expect((await client.execute("SELECT id FROM items")).toJSON().rows).toEqual([[1]])

    const writer = await client.transaction()
    try {
      await writer.execute({ sql: "INSERT INTO items VALUES (?, ?)", args: [2, "new"] })
      expect((await client.execute("SELECT id FROM items")).toJSON().rows).toEqual([[1]])
      await expect(client.execute("INSERT INTO items VALUES (?, ?)", [3, "busy"]))
        .rejects.toMatchObject({ code: "SQLITE_BUSY", rawCode: 5 })
      await writer.commit()
      expect(writer.closed).toBe(true)
    } finally {
      writer.close()
    }
    const { drizzle } = webRequire("drizzle-orm/libsql") as typeof import("drizzle-orm/libsql")
    const db = drizzle(client)
    expect(await db.select().from(items).orderBy(items.id)).toEqual([
      { id: 1, title: "original" }, { id: 2, title: "new" },
    ])
    const read = await client.transaction("read")
    try {
      await expect(read.execute("DELETE FROM items")).rejects.toMatchObject({ code: "SQLITE_READONLY" })
    } finally {
      read.close()
    }
    const abandoned = await client.transaction("write")
    await abandoned.executeMultiple("INSERT INTO items VALUES(3, 'uncommitted');")
    client.close()
    expect(abandoned.closed).toBe(true)
    client.reconnect()
    expect((await client.execute("SELECT id FROM items ORDER BY id")).toJSON().rows).toEqual([[1], [2]])
  } finally {
    client.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test("starts with remote transports unloaded and sends remote requests through libSQL", async () => {
  type Command = { type: string; stmt?: { sql: string } }
  const requests: Command[] = []
  let version = DATABASE_SCHEMA_VERSION + 1
  const server = createServer(async (request, response) => {
    if (request.url !== "/v2/pipeline") {
      response.writeHead(404).end()
      return
    }
    const chunks: Uint8Array[] = []
    for await (const chunk of request) chunks.push(chunk)
    const { requests: commands } = JSON.parse(Buffer.concat(chunks).toString()) as { requests: Command[] }
    requests.push(...commands)
    const results = commands.map(command => {
      if (command.type !== "execute") return { type: "ok", response: { type: "close" } }
      const marker = command.stmt?.sql.startsWith("SELECT value AS value FROM app_settings")
      const missingLedger = command.stmt?.sql.includes("name = '__meitheal_migrations'")
      const cell = marker ? { type: "text", value: String(version) } : { type: "integer", value: "42" }
      return {
        type: "ok",
        response: {
          type: "execute",
          result: { cols: [{ name: marker ? "value" : "answer" }], rows: missingLedger ? [] : [[cell]], affected_row_count: 0 },
        },
      }
    })
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ results }))
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  try {
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("No fixture port")
    const url = `libsql://127.0.0.1:${address.port}?tls=0`
    const modulePath = new URL("../../apps/web/scripts/database-client.mjs", import.meta.url).href
    await execFileAsync(process.execPath, ["--input-type=module", "--eval", `
      import assert from "node:assert/strict"
      import { createRequire } from "node:module"
      import { assertSupportedDatabaseSchema, openDatabase } from ${JSON.stringify(modulePath)}
      const require = createRequire(${JSON.stringify(modulePath)})
      const loaded = () => Object.keys(require.cache)
      const local = openDatabase(":memory:")
      assert.equal((await local.execute("SELECT 1")).rows[0][0], 1)
      local.close()
      assert.ok(loaded().every(path => !path.includes("@libsql/client")))
      const remote = openDatabase(${JSON.stringify(url)})
      assert.equal(remote.protocol, "http")
      assert.equal((await remote.execute("SELECT ? AS answer", [42n])).rows[0][0], 42)
      await assert.rejects(assertSupportedDatabaseSchema(remote), /requires a newer App/)
      remote.close()
      assert.ok(loaded().every(path => !path.endsWith("sqlite3.js") && !path.endsWith(".node")))
    `], { timeout: 10_000 })
    expect(requests).toContainEqual(expect.objectContaining({
      type: "execute",
      stmt: expect.objectContaining({ sql: "SELECT ? AS answer", args: [{ type: "integer", value: "42" }] }),
    }))
    expect(requests).toContainEqual(expect.objectContaining({
      type: "execute",
      stmt: expect.objectContaining({ sql: expect.stringMatching(/^SELECT value AS value FROM app_settings/) }),
    }))

    const script = fileURLToPath(new URL("../../apps/web/scripts/migrate.mjs", import.meta.url))
    const migrate = (...args: string[]) => execFileAsync(process.execPath, [script, ...args], {
      env: { PATH: process.env.PATH, MEITHEAL_DB_URL: url }, timeout: 10_000,
    })
    const markerReads = [
      expect.stringMatching(/^SELECT 1 FROM sqlite_schema .*name = 'app_settings' COLLATE NOCASE$/),
      expect.stringMatching(/^SELECT value AS value FROM app_settings/),
    ]
    const takeStatements = () => requests.splice(0).filter(command => command.type !== "close").map(command => command.stmt?.sql)
    requests.length = 0
    for (const args of [[], ["--check"]]) {
      await expect(migrate(...args)).rejects.toMatchObject({ code: 1, stderr: expect.stringMatching(/requires a newer App/) })
      expect(takeStatements()).toEqual(markerReads)
    }
    version = DATABASE_SCHEMA_VERSION
    await expect(migrate("--check")).rejects.toMatchObject({ code: 1, stderr: expect.stringMatching(/Pending migrations/) })
    expect(takeStatements()).toEqual([
      ...markerReads,
      expect.stringMatching(/^SELECT 1 FROM sqlite_schema .*name = '__meitheal_migrations' COLLATE NOCASE$/),
    ])
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

for (const refused of [false, true]) {
  test(`remote dependent batches share a writer and ${refused ? "close after a refused statement" : "commit"}`, async () => {
    const select = "SELECT 42 AS answer"
    const insert = "INSERT INTO items (id) VALUES (?)"
    const baton = "fixture-transaction"
    const storedSql = new Map<number, string>()
    const traffic: Array<{ baton: string | undefined; command: string; args?: unknown[] | undefined }> = []
    const emptyResult = { cols: [], rows: [], affected_row_count: 0 }
    const selectResult = { cols: [{ name: "answer" }], rows: [[{ type: "integer", value: "42" }]], affected_row_count: 0 }
    type Statement = { sql?: string; sql_id?: number; args?: unknown[] }
    type Command = { type: "batch"; batch: { steps: Array<{ stmt: Statement }> } }
      | { type: "execute"; stmt: Statement }
      | { type: "store_sql"; sql_id: number; sql: string }
      | { type: "close" }
    const server = createServer(async (request, response) => {
      if (request.url !== "/v2/pipeline") {
        response.writeHead(404).end()
        return
      }
      const chunks: Uint8Array[] = []
      for await (const chunk of request) chunks.push(chunk)
      const incoming = JSON.parse(Buffer.concat(chunks).toString()) as { baton?: string; requests: Command[] }
      const record = (stmt: Statement) => {
        const sql = stmt.sql ?? storedSql.get(stmt.sql_id!)
        if (!sql) throw new Error("Missing fixture SQL")
        traffic.push({ baton: incoming.baton, command: sql, args: stmt.args })
        return sql
      }
      const results = incoming.requests.map(command => {
        if (command.type === "store_sql") {
          storedSql.set(command.sql_id, command.sql)
          return { type: "ok", response: { type: "store_sql" } }
        }
        if (command.type === "batch") {
          const statements = command.batch.steps.map(step => record(step.stmt))
          const failed = (sql: string) => refused && sql === insert
          const stepResults = statements.map(sql => failed(sql) ? null : sql === select ? selectResult : emptyResult)
          const stepErrors = statements.map(sql => failed(sql)
            ? { message: "Fixture refused the insert", code: "SQLITE_CONSTRAINT" }
            : null)
          return { type: "ok", response: { type: "batch", result: { step_results: stepResults, step_errors: stepErrors } } }
        }
        if (command.type === "execute") {
          record(command.stmt)
          return { type: "ok", response: { type: "execute", result: emptyResult } }
        }
        traffic.push({ baton: incoming.baton, command: "close" })
        return { type: "ok", response: { type: "close" } }
      })
      const closed = incoming.requests.some(command => command.type === "close")
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ baton: closed ? undefined : baton, results }))
    })
    server.listen(0, "127.0.0.1")
    await once(server, "listening")
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("No fixture port")
    const client = openDatabase(`libsql://127.0.0.1:${address.port}?tls=0`)
    try {
      const transaction = runWriteTransaction(client, function* () {
        const [selected] = yield [select]
        const answer = Number(selected?.rows[0]?.answer)
        yield [{ sql: insert, args: [answer] }]
        return answer
      })
      if (refused) {
        await expect(transaction).rejects.toMatchObject({ code: "SQLITE_CONSTRAINT", message: expect.stringContaining("Fixture refused the insert") })
      } else {
        await expect(transaction).resolves.toBe(42)
      }
      await expect.poll(() => traffic.map(({ baton, command }) => [baton, command])).toEqual([
        [undefined, "BEGIN IMMEDIATE"],
        [undefined, select],
        [baton, insert],
        ...(refused ? [] : [[baton, "COMMIT"]]),
        [baton, "close"],
      ])
      expect(traffic.find(entry => entry.command === insert)?.args).toEqual([{ type: "float", value: 42 }])
    } finally {
      client.close()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })
}

test("pools sequential read transactions, opens overflow handles on overlap, and closes cleanly", async () => {
  const directory = await mkdtemp(join(tmpdir(), "meitheal-sqlite-readpool-"))
  const path = join(directory, "readpool.db")
  resetDatabaseDiagnosticsForTests()
  const client = openDatabase(pathToFileURL(path).href)
  try {
    await client.executeMultiple("CREATE TABLE notes(id INTEGER PRIMARY KEY, body TEXT NOT NULL);")
    const inserted = await client.execute("INSERT INTO notes(id, body) VALUES (?, ?)", [1, "alpha"])
    expect(inserted.rowsAffected).toBe(1)
    // Cached total_changes() delta must report 0 on DDL right after INSERT
    const indexRes = await client.execute("CREATE INDEX idx_notes_body ON notes(body)")
    expect(indexRes.rowsAffected).toBe(0)

    const r1 = await client.transaction("read")
    expect((await r1.execute("SELECT body FROM notes WHERE id = 1")).rows[0]?.body).toBe("alpha")
    r1.close()

    const r2 = await client.transaction("read")
    expect((await r2.execute("SELECT body FROM notes WHERE id = 1")).rows[0]?.body).toBe("alpha")
    r2.close()

    const afterSequential = getDatabaseDiagnostics()
    expect(afterSequential.readPoolHitsTotal).toBeGreaterThanOrEqual(1)
    expect(afterSequential.readPoolOverflowTotal).toBe(0)

    // Overlapping read transactions: first takes idle handle, second opens overflow handle
    const concurrentA = await client.transaction("read")
    const concurrentB = await client.transaction("read")
    try {
      expect((await concurrentA.execute("SELECT COUNT(*) AS c FROM notes")).rows[0]?.c).toBe(1)
      expect((await concurrentB.execute("SELECT COUNT(*) AS c FROM notes")).rows[0]?.c).toBe(1)
      expect(getDatabaseDiagnostics().readPoolOverflowTotal).toBe(1)
    } finally {
      concurrentB.close()
      concurrentA.close()
    }
    expect(concurrentA.closed).toBe(true)
    expect(concurrentB.closed).toBe(true)

    // Reconnect disposes idle read handle cleanly without leaking open statements
    client.reconnect()
    const r3 = await client.transaction("read")
    expect((await r3.execute("SELECT body FROM notes WHERE id = 1")).rows[0]?.body).toBe("alpha")
    r3.close()
  } finally {
    client.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test("rejects with AbortError when signal is pre-aborted or aborts during SQLITE_BUSY retry backoff", async () => {
  const directory = await mkdtemp(join(tmpdir(), "meitheal-sqlite-abort-"))
  const path = join(directory, "abort.db")
  resetDatabaseDiagnosticsForTests()
  const primary = openDatabase(pathToFileURL(path).href)
  const locker = openDatabase(pathToFileURL(path).href)
  try {
    await primary.executeMultiple("CREATE TABLE items(id INTEGER PRIMARY KEY, val TEXT);")

    // 1. Pre-aborted signal rejects before touching SQLite
    const preAborted = new AbortController()
    preAborted.abort()
    await expect(
      executeWriteWithRetry(primary, ["INSERT INTO items VALUES (1, 'skip')"], { signal: preAborted.signal }),
    ).rejects.toMatchObject({ name: "AbortError" })
    await expect(
      runWriteTransaction(primary, function* () {
        yield ["INSERT INTO items VALUES (1, 'skip')"]
        return true
      }, { signal: preAborted.signal }),
    ).rejects.toMatchObject({ name: "AbortError" })

    // 2. Abort mid-backoff while another writer holds the WAL write lock
    const lockTx = await locker.transaction("write")
    try {
      await lockTx.execute("INSERT INTO items VALUES (10, 'locked')")
      const midAbort = new AbortController()
      setTimeout(() => midAbort.abort(), 12)
      await expect(
        executeWriteWithRetry(primary, { sql: "INSERT INTO items VALUES (11, 'contended')" }, { signal: midAbort.signal }),
      ).rejects.toMatchObject({ name: "AbortError" })
      expect(getDatabaseDiagnostics().sqliteBusyRetriesTotal).toBeGreaterThanOrEqual(1)

      const txAbort = new AbortController()
      setTimeout(() => txAbort.abort(), 12)
      await expect(
        runWriteTransaction(primary, function* () {
          yield ["INSERT INTO items VALUES (12, 'contended-tx')"]
          return "ok"
        }, { signal: txAbort.signal }),
      ).rejects.toMatchObject({ name: "AbortError" })
    } finally {
      await lockTx.rollback()
      lockTx.close()
    }

    expect((await primary.execute("SELECT COUNT(*) AS c FROM items")).rows[0]?.c).toBe(0)
  } finally {
    locker.close()
    primary.close()
    await rm(directory, { recursive: true, force: true })
  }
})
