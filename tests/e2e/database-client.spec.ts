import { execFile } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:http"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { promisify } from "node:util"
import { expect, test } from "@playwright/test"
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { openDatabase, runWriteTransaction } from "../../apps/web/scripts/database-client.mjs"

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
  const requests: unknown[] = []
  const server = createServer(async (request, response) => {
    if (request.url !== "/v2/pipeline") {
      response.writeHead(404).end()
      return
    }
    const chunks: Uint8Array[] = []
    for await (const chunk of request) chunks.push(chunk)
    const { requests: commands } = JSON.parse(Buffer.concat(chunks).toString())
    requests.push(...commands)
    const results = commands.map((command: { type: string }) => ({
      type: "ok",
      response: command.type === "execute" ? {
        type: "execute",
        result: { cols: [{ name: "answer" }], rows: [[{ type: "integer", value: "42" }]], affected_row_count: 0 },
      } : { type: "close" },
    }))
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ results }))
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  try {
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("No fixture port")
    const modulePath = new URL("../../apps/web/scripts/database-client.mjs", import.meta.url).href
    await execFileAsync(process.execPath, ["--input-type=module", "--eval", `
      import assert from "node:assert/strict"
      import { createRequire } from "node:module"
      import { openDatabase } from ${JSON.stringify(modulePath)}
      const require = createRequire(${JSON.stringify(modulePath)})
      const loaded = () => Object.keys(require.cache)
      const local = openDatabase(":memory:")
      assert.equal((await local.execute("SELECT 1")).rows[0][0], 1)
      local.close()
      assert.ok(loaded().every(path => !path.includes("@libsql/client")))
      const remote = openDatabase(${JSON.stringify(`libsql://127.0.0.1:${address.port}?tls=0`)})
      assert.equal(remote.protocol, "http")
      assert.equal((await remote.execute("SELECT ? AS answer", [42n])).rows[0][0], 42)
      remote.close()
      assert.ok(loaded().every(path => !path.endsWith("sqlite3.js") && !path.endsWith(".node")))
    `], { timeout: 10_000 })
    expect(requests).toContainEqual(expect.objectContaining({
      type: "execute",
      stmt: expect.objectContaining({ sql: "SELECT ? AS answer", args: [{ type: "integer", value: "42" }] }),
    }))
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
