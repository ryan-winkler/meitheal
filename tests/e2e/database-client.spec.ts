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
import { TASK_BOARD_SCHEMA_VERSION } from "../../apps/web/drizzle/migrations/task-board-upgrade.mjs"
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import {
  DATABASE_SCHEMA_VERSION,
  executeWriteWithRetry,
  getDatabaseDiagnostics,
  isSideEffectFreeQuery,
  localSnapshotGeneration,
  openDatabase,
  resetDatabaseDiagnosticsForTests,
  runWriteTransaction,
  tagTaskProjectionRead,
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

test("tagged file projections preserve result shape and use fresh bound values", async () => {
  const directory = await mkdtemp(join(tmpdir(), "meitheal-sqlite-projection-"))
  const client = openDatabase(pathToFileURL(join(directory, "tasks.db")).href)
  const reader = await client.transaction("read")
  try {
    const projection = (value: string) => tagTaskProjectionRead({ sql: "SELECT ? AS title, X'00FF' AS bytes", args: [value] }, "task-detail")
    const first = await reader.execute(projection("first"))
    expect(first.rows[0]).toMatchObject({ title: "first", bytes: Uint8Array.of(0, 255).buffer })
    expect(first.rows[0]?.[0]).toBe("first")
    expect(first.rows[0]?.length).toBe(2)
    expect(Object.keys(first.rows[0]!)).toEqual(["title", "bytes"])
    expect(first.toJSON().rows).toEqual([["first", "AP8="]])
    expect((await reader.execute(projection("second"))).toJSON().rows).toEqual([["second", "AP8="]])
    const score = tagTaskProjectionRead({ sql: "SELECT ? AS score", args: [9007199254740991n] }, "task-detail")
    expect((await reader.execute(score)).toJSON().rows).toEqual([[9007199254740991]])
    const overflow = tagTaskProjectionRead({ ...score, args: [9007199254740992n] }, "task-detail")
    await expect(reader.execute(overflow)).rejects.toBeInstanceOf(RangeError)
    const sql = "SELECT ? AS required, ? AS optional"
    const bound = (args: (number | string)[]) => tagTaskProjectionRead({ sql, args }, "task-detail")
    expect((await reader.execute(bound([1, "local value"]))).toJSON().rows).toEqual([[1, "local value"]])
    expect((await reader.execute(bound([2]))).toJSON().rows).toEqual([[2, null]])
    await reader.commit()
  } finally {
    reader.close()
    client.close()
    await rm(directory, { recursive: true, force: true })
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
  type Statement = { sql?: string; sql_id?: number; args?: unknown[] }
  type Command = { type: "execute"; stmt: Statement }
    | { type: "batch"; batch: { steps: { stmt: Statement }[] } }
    | { type: "store_sql"; sql_id: number; sql: string }
    | { type: "close" }
  const requests: Array<{ baton: string | undefined; stmt: Statement }> = []
  const storedSql = new Map<number, string>()
  const catalogSql = /FROM main\.sqlite_schema AS objects/
  const markerSql = /^SELECT value(?: AS value)? FROM (?:main\.)?app_settings/
  let version = DATABASE_SCHEMA_VERSION + 1
  let refuseWriterOnce = false
  const server = createServer(async (request, response) => {
    if (request.url !== "/v2/pipeline") {
      response.writeHead(404).end()
      return
    }
    const chunks: Uint8Array[] = []
    for await (const chunk of request) chunks.push(chunk)
    const incoming = JSON.parse(Buffer.concat(chunks).toString()) as { baton?: string; requests: Command[] }
    const textCell = (value: string) => ({ type: "text", value })
    const result = (stmt: Statement) => {
      const sql = stmt.sql ?? storedSql.get(stmt.sql_id!)
      if (!sql) throw new Error("Missing fixture SQL")
      requests.push({ baton: incoming.baton, stmt: { ...stmt, sql } })
      let cols = ["answer"]
      let rows = [[{ type: "integer", value: "42" }]]
      if (catalogSql.test(sql)) {
        cols = ["name", "type", "table_name"]
        rows = [["app_settings", "table", "app_settings"].map(textCell)]
      } else if (markerSql.test(sql)) {
        cols = ["value"]
        rows = [[textCell(String(version))]]
      } else if (/pragma_table_xinfo|__meitheal_migrations|^BEGIN/.test(sql)) {
        rows = []
      }
      return { cols: cols.map(name => ({ name })), rows, affected_row_count: 0 }
    }
    const results = incoming.requests.map(command => {
      if (command.type === "store_sql") {
        storedSql.set(command.sql_id, command.sql)
        return { type: "ok", response: { type: "store_sql" } }
      }
      if (command.type === "execute") return { type: "ok", response: { type: "execute", result: result(command.stmt) } }
      if (command.type === "batch") {
        const first = command.batch.steps[0]?.stmt
        if (refuseWriterOnce && first?.sql === "BEGIN IMMEDIATE") {
          refuseWriterOnce = false
          result(first)
          const stepErrors = command.batch.steps.map((_, i) => i === 0
            ? { message: "Fixture writer busy", code: "SQLITE_BUSY" } : null)
          return { type: "ok", response: { type: "batch", result: {
            step_results: stepErrors.map(() => null), step_errors: stepErrors,
          } } }
        }
        const stepResults = command.batch.steps.map(({ stmt }) => result(stmt))
        return { type: "ok", response: { type: "batch", result: {
          step_results: stepResults, step_errors: stepResults.map(() => null),
        } } }
      }
      return { type: "ok", response: { type: "close" } }
    })
    const closed = incoming.requests.some(command => command.type === "close")
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
      baton: closed ? undefined : "startup-read", results,
    }))
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
      stmt: expect.objectContaining({ sql: "SELECT ? AS answer", args: [{ type: "integer", value: "42" }] }),
    }))
    expect(requests).toContainEqual(expect.objectContaining({
      stmt: expect.objectContaining({ sql: expect.stringMatching(markerSql) }),
    }))

    const script = fileURLToPath(new URL("../../apps/web/scripts/migrate.mjs", import.meta.url))
    const migrate = (...args: string[]) => execFileAsync(process.execPath, [script, ...args], {
      env: { PATH: process.env.PATH, MEITHEAL_DB_URL: url, MEITHEAL_BOARD_GRANT_PATH: join(tmpdir(), `meitheal-remote-${address.port}-board-grants.json`) }, timeout: 10_000,
    })
    const takeStatements = () => requests.splice(0).map(({ baton, stmt }) => [baton, stmt.sql])
    const markerReads = [
      [undefined, expect.stringMatching(/^BEGIN.*READONLY$/)],
      [undefined, expect.stringMatching(catalogSql)],
      ["startup-read", expect.stringMatching(markerSql)],
    ]
    requests.length = 0
    for (const args of [[], ["--check"]]) {
      await expect(migrate(...args)).rejects.toMatchObject({ code: 1, stderr: expect.stringMatching(/requires a newer App/) })
      expect(takeStatements()).toEqual(markerReads)
    }
    version = TASK_BOARD_SCHEMA_VERSION - 1
    await expect(migrate("--check")).rejects.toMatchObject({ code: 1, stderr: expect.stringMatching(/Pending migrations/) })
    expect(takeStatements()).toEqual([
      ...markerReads,
      ["startup-read", expect.stringMatching(/pragma_table_xinfo/)],
      ...markerReads,
      ["startup-read", expect.stringMatching(/pragma_table_xinfo/)],
      ["startup-read", expect.stringMatching(/^SELECT 1 FROM main\.sqlite_schema .*name = '__meitheal_migrations'/)],
    ])

    refuseWriterOnce = true
    await execFileAsync(process.execPath, ["--input-type=module", "--eval", `
      import assert from "node:assert/strict"
      import { openDatabase, withStartupWriteTransaction } from ${JSON.stringify(modulePath)}
      const client = openDatabase(${JSON.stringify(url)})
      let calls = 0
      try {
        await withStartupWriteTransaction(client, async tx => {
          calls++
          await tx.execute("SELECT 2")
        })
        assert.equal(calls, 1)
      } finally { client.close() }
    `], { timeout: 10_000 })
    expect(takeStatements()).toEqual([
      [undefined, "BEGIN IMMEDIATE"],
      [undefined, "BEGIN IMMEDIATE"],
      [undefined, "SELECT 1"],
      ["startup-read", "SELECT 2"],
      ["startup-read", "COMMIT"],
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

test("reuses one writer between transactions and never pools a writer that changed connection state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "meitheal-sqlite-writer-"))
  const client = openDatabase(pathToFileURL(join(directory, "writer.db")).href)
  try {
    await client.executeMultiple("CREATE TABLE notes(id INTEGER PRIMARY KEY, body TEXT NOT NULL);")
    const first = await client.transaction("write")
    await first.execute("INSERT INTO notes(id, body) VALUES (7, 'kept')")
    await first.commit()

    // last_insert_rowid() belongs to a connection, so it shows the pooled writer.
    const second = await client.transaction("write")
    expect((await second.execute("SELECT last_insert_rowid() AS id")).rows[0]?.id).toBe(7)
    await second.execute("INSERT INTO notes(id, body) VALUES (8, 'discarded')")
    await second.rollback()

    const third = await client.transaction("write")
    expect((await third.execute("SELECT COUNT(*) AS count FROM notes")).rows[0]?.count).toBe(1)
    await third.execute("CREATE TEMP TABLE scratch(value)")
    await third.commit()

    const fourth = await client.transaction("write")
    await expect(fourth.execute("SELECT value FROM scratch")).rejects.toThrow(/no such table/)
    await fourth.executeMultiple("CREATE TEMP TABLE other(value);")
    fourth.close()

    const fifth = await client.transaction("write")
    await expect(fifth.execute("SELECT value FROM other")).rejects.toThrow(/no such table/)
    // SQLite ignores leading comments; so does the reuse decision.
    await fifth.execute("/* setup */ -- note\n CREATE TEMP TABLE commented(value)")
    await fifth.commit()

    const sixth = await client.transaction("write")
    await expect(sixth.execute("SELECT value FROM commented")).rejects.toThrow(/no such table/)
    sixth.close()
  } finally {
    client.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test("snapshot generations change exactly when a local reader can observe new data", async () => {
  const directory = await mkdtemp(join(tmpdir(), "meitheal-sqlite-generation-"))
  const url = pathToFileURL(join(directory, "generation.db")).href
  const client = openDatabase(url)
  const other = openDatabase(url)
  try {
    // The App enables WAL at startup, which lets a pinned reader coexist with a writer.
    await client.execute("PRAGMA journal_mode=WAL")
    await client.executeMultiple("CREATE TABLE notes(id INTEGER PRIMARY KEY, body TEXT NOT NULL);")
    const live = localSnapshotGeneration(client)
    expect(live).toMatch(/^live:/)
    expect(localSnapshotGeneration(client)).toBe(live)
    await client.execute("SELECT COUNT(*) FROM notes")
    expect(localSnapshotGeneration(client)).toBe(live)

    await other.execute("INSERT INTO notes(id, body) VALUES (1, 'other connection')")
    const afterOther = localSnapshotGeneration(client)
    expect(afterOther).not.toBe(live)
    await client.execute("INSERT INTO notes(id, body) VALUES (2, 'own write')")
    const afterOwn = localSnapshotGeneration(client)
    expect(afterOwn).not.toBe(afterOther)
    await client.execute("CREATE INDEX notes_body ON notes(body)")
    expect(localSnapshotGeneration(client)).not.toBe(afterOwn)

    const reader = await client.transaction("read")
    await reader.execute("SELECT COUNT(*) FROM notes")
    const pinned = localSnapshotGeneration(reader)
    await other.execute("INSERT INTO notes(id, body) VALUES (3, 'after snapshot')")
    expect((await reader.execute("SELECT COUNT(*) AS count FROM notes")).rows[0]?.count).toBe(2)
    expect(localSnapshotGeneration(reader)).toBe(pinned)
    // Restarting the snapshot must invalidate anything derived from the old one.
    await reader.executeMultiple("COMMIT; BEGIN;")
    expect(localSnapshotGeneration(reader)).not.toBe(pinned)
    expect((await reader.execute("SELECT COUNT(*) AS count FROM notes")).rows[0]?.count).toBe(3)
    const restarted = localSnapshotGeneration(reader)
    await reader.execute("COMMIT")
    expect(localSnapshotGeneration(reader)).not.toBe(restarted)
    reader.close()
    expect(localSnapshotGeneration(reader)).toBeUndefined()

    const writer = await client.transaction("write")
    const before = localSnapshotGeneration(writer)
    await writer.execute("SELECT COUNT(*) FROM notes")
    expect(localSnapshotGeneration(writer)).toBe(before)
    await writer.execute("UPDATE notes SET body = 'changed' WHERE id = 1")
    expect(localSnapshotGeneration(writer)).not.toBe(before)
    await writer.commit()

    // A reconnect starts new counters, so it must never repeat an earlier token.
    const beforeReconnect = localSnapshotGeneration(client)
    client.reconnect()
    expect(localSnapshotGeneration(client)).not.toBe(beforeReconnect)

    // Decorated clients and in-memory databases never reuse derived results.
    expect(localSnapshotGeneration({ execute: client.execute.bind(client) })).toBeUndefined()
    const memory = openDatabase("file::memory:?cache=private")
    try { expect(localSnapshotGeneration(memory)).toBeUndefined() } finally { memory.close() }
  } finally {
    other.close()
    client.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test("rows with unique columns keep libSQL access, serialization and read-only positions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "meitheal-sqlite-rows-"))
  const client = openDatabase(pathToFileURL(join(directory, "rows.db")).href)
  try {
    await client.executeMultiple("CREATE TABLE notes(id INTEGER PRIMARY KEY, body TEXT NOT NULL, data BLOB); INSERT INTO notes VALUES (1, 'alpha', X'00FF'), (2, 'beta', NULL);")
    const plain = await client.execute("SELECT id, body, data FROM notes ORDER BY id")
    const reader = await client.transaction("read")
    const tagged = await reader.execute(tagTaskProjectionRead({ sql: "SELECT id, body, data FROM notes ORDER BY id", args: [] }, "task-list"))
    reader.close()
    for (const result of [plain, tagged]) {
      const [first, second] = result.rows
      expect(first?.length).toBe(3)
      expect(first?.[0]).toBe(1)
      expect(first?.[1]).toBe("alpha")
      expect(first?.data).toEqual(Uint8Array.of(0, 255).buffer)
      expect(first?.[2]).toEqual(Uint8Array.of(0, 255).buffer)
      expect(second?.[2]).toBeNull()
      expect(Object.keys(first!)).toEqual(["id", "body", "data"])
      expect({ ...first }).toEqual({ id: 1, body: "alpha", data: Uint8Array.of(0, 255).buffer })
      expect(Array.from(first as unknown as ArrayLike<unknown>)).toEqual([1, "alpha", Uint8Array.of(0, 255).buffer])
      expect(result.toJSON().rows).toEqual([[1, "alpha", "AP8="], [2, "beta", null]])
      expect(() => { (first as unknown as Record<number, unknown>)[0] = 9 }).toThrow(TypeError)
    }
  } finally {
    client.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test("a reused SELECT returns columns another connection added and writes run once", async () => {
  const directory = await mkdtemp(join(tmpdir(), "meitheal-sqlite-schema-"))
  const url = pathToFileURL(join(directory, "schema.db")).href
  const client = openDatabase(url)
  const other = openDatabase(url)
  try {
    await client.execute("PRAGMA journal_mode=WAL")
    await client.executeMultiple("CREATE TABLE drafts(id TEXT PRIMARY KEY); INSERT INTO drafts VALUES ('draft');")
    expect((await client.execute("SELECT rowid, * FROM drafts")).rows).toEqual([{ rowid: 1, id: "draft" }])
    await other.executeMultiple("ALTER TABLE drafts ADD COLUMN board_id TEXT NOT NULL DEFAULT 'household';")
    const after = await client.execute("SELECT rowid, * FROM drafts")
    expect(after.columns).toEqual(["rowid", "id", "board_id"])
    expect(after.rows).toEqual([{ rowid: 1, id: "draft", board_id: "household" }])
    expect(after.toJSON().rows).toEqual([[1, "draft", "household"]])

    // Writes are never cached, so a repeated command still runs exactly once.
    const insert = "INSERT INTO drafts(id) VALUES (?) RETURNING id, board_id"
    expect((await client.execute(insert, ["second"])).rows).toEqual([{ id: "second", board_id: "household" }])
    expect((await client.execute(insert, ["third"])).rows).toEqual([{ id: "third", board_id: "household" }])
    expect((await client.execute("SELECT COUNT(*) AS count FROM drafts")).rows[0]?.count).toBe(3)
  } finally {
    other.close()
    client.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test("SELECT classification ignores special identifiers, refreshes renamed wildcard columns, and keeps TEMP tables on main", async () => {
  expect(isSideEffectFreeQuery("SELECT [a;b], `c;d`, [DELETE] FROM drafts")).toBe(true)
  expect(isSideEffectFreeQuery("WITH d AS (DELETE FROM drafts RETURNING *) SELECT * FROM d")).toBe(false)

  const directory = await mkdtemp(join(tmpdir(), "meitheal-sqlite-temp-rename-"))
  const url = pathToFileURL(join(directory, "schema.db")).href
  const client = openDatabase(url)
  const other = openDatabase(url)
  try {
    await client.execute("PRAGMA journal_mode=WAL")
    await client.executeMultiple("CREATE TABLE drafts(id TEXT PRIMARY KEY, board_id TEXT NOT NULL DEFAULT 'household'); INSERT INTO drafts(id) VALUES ('draft');")
    const before = await client.execute("SELECT rowid, * FROM drafts")
    expect(before.columns).toEqual(["rowid", "id", "board_id"])

    await other.execute("ALTER TABLE drafts RENAME COLUMN board_id TO workspace_id")
    const afterRename = await client.execute("SELECT rowid, * FROM drafts")
    expect(afterRename.columns).toEqual(["rowid", "id", "workspace_id"])
    expect(afterRename.rows).toEqual([{ rowid: 1, id: "draft", workspace_id: "household" }])

    await client.execute("CREATE TEMP TABLE scratch(v TEXT)")
    await client.batch(["INSERT INTO scratch VALUES ('batch-ok')"], "write")
    const txValues = await runWriteTransaction(client, function* () {
      const [inserted, read] = yield [
        { sql: "INSERT INTO scratch VALUES (?)", args: ["tx-ok"] },
        "SELECT v FROM scratch ORDER BY rowid",
      ]
      expect(inserted.rowsAffected).toBe(1)
      return read.rows.map(row => row.v)
    })
    expect(txValues).toEqual(["batch-ok", "tx-ok"])

    const [readBatch] = await client.batch(["SELECT v FROM scratch ORDER BY rowid"], "write")
    expect(readBatch?.rows.map(row => row.v)).toEqual(["batch-ok", "tx-ok"])

    client.reconnect()
    await client.execute("PRAGMA journal_mode=WAL")
    await client.executeMultiple("CREATE TEMP TABLE multi_scratch(v TEXT); INSERT INTO multi_scratch VALUES ('multi-ok');")
    const [multiBatch] = await client.batch(["SELECT v FROM multi_scratch"], "write")
    expect(multiBatch?.rows.map(row => row.v)).toEqual(["multi-ok"])
  } finally {
    other.close()
    client.close()
    await rm(directory, { recursive: true, force: true })
  }
})
