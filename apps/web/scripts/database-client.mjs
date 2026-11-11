import { createRequire } from "node:module"
import { DatabaseSync } from "node:sqlite"
import { LibsqlBatchError, LibsqlError } from "@libsql/core/api"
import { expandConfig, isInMemoryConfig } from "@libsql/core/config"
import { ResultSetImpl } from "@libsql/core/util"

/** @typedef {import("@libsql/core/api").Client} Client */
/** @typedef {import("@libsql/core/api").InArgs} InArgs */
/** @typedef {import("@libsql/core/api").InStatement} InStatement */
/** @typedef {import("@libsql/core/api").InValue} InValue */
/** @typedef {import("@libsql/core/api").Transaction} Transaction */
/** @typedef {import("@libsql/core/api").TransactionMode} TransactionMode */
/** @typedef {import("@libsql/core/api").Row} Row */
/** @typedef {import("node:sqlite").SQLInputValue} SQLInputValue */
/** @typedef {import("node:sqlite").SQLOutputValue} SQLOutputValue */

const require = createRequire(import.meta.url)
const sqliteCodes = [
  "OK", "ERROR", "INTERNAL", "PERM", "ABORT", "BUSY", "LOCKED", "NOMEM", "READONLY", "INTERRUPT",
  "IOERR", "CORRUPT", "NOTFOUND", "FULL", "CANTOPEN", "PROTOCOL", "EMPTY", "SCHEMA", "TOOBIG",
  "CONSTRAINT", "MISMATCH", "MISUSE", "NOLFS", "AUTH", "FORMAT", "RANGE", "NOTADB", "NOTICE", "WARNING",
]
const extendedCodes = new Map([
  [261, "SQLITE_BUSY_RECOVERY"], [517, "SQLITE_BUSY_SNAPSHOT"], [773, "SQLITE_BUSY_TIMEOUT"],
  [275, "SQLITE_CONSTRAINT_CHECK"], [531, "SQLITE_CONSTRAINT_COMMITHOOK"],
  [787, "SQLITE_CONSTRAINT_FOREIGNKEY"], [1043, "SQLITE_CONSTRAINT_FUNCTION"],
  [1299, "SQLITE_CONSTRAINT_NOTNULL"], [1555, "SQLITE_CONSTRAINT_PRIMARYKEY"],
  [1811, "SQLITE_CONSTRAINT_TRIGGER"], [2067, "SQLITE_CONSTRAINT_UNIQUE"],
  [2323, "SQLITE_CONSTRAINT_VTAB"], [2579, "SQLITE_CONSTRAINT_ROWID"],
  [2835, "SQLITE_CONSTRAINT_PINNED"], [3091, "SQLITE_CONSTRAINT_DATATYPE"],
])

/** @template T @param {() => T} operation @returns {T} */
function sqliteOperation(operation) {
  try {
    return operation()
  } catch (error) {
    if (!(error instanceof Error) || !("errcode" in error) || typeof error.errcode !== "number") throw error
    const rawCode = error.errcode
    const primary = rawCode & 0xff
    const code = "SQLITE_" + (sqliteCodes[primary] ?? `UNKNOWN_${primary}`)
    throw new LibsqlError(error.message, code, rawCode === primary ? code : extendedCodes.get(rawCode), rawCode, error)
  }
}

/** @param {InValue} value @returns {SQLInputValue} */
function bind(value) {
  if (typeof value === "boolean") return Number(value)
  if (value instanceof Date) value = value.valueOf()
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (typeof value === "number" && !Number.isFinite(value)) throw new RangeError("SQLite numbers must be finite")
  if (typeof value === "bigint" && BigInt.asIntN(64, value) !== value) throw new RangeError("SQLite integers must fit in 64 bits")
  return value
}

/** @param {SQLOutputValue} value */
function decode(value) {
  if (typeof value === "bigint") {
    const number = Number(value)
    if (!Number.isSafeInteger(number)) throw new RangeError("Received an unsafe SQLite integer")
    return number
  }
  // Node returns an owned Uint8Array. Copy just the visible BLOB bytes for libSQL's ArrayBuffer contract.
  if (value instanceof Uint8Array) return new Uint8Array(value).buffer
  return value
}

/** @param {DatabaseSync} db @param {InStatement} input @param {InArgs} [args] */
function execute(db, input, args = []) {
  const sql = typeof input === "string" ? input : input.sql
  const values = typeof input === "string" ? args : input.args ?? []
  const bindings = Array.isArray(values)
    ? values.map(bind)
    : Object.fromEntries(Object.entries(values).map(([key, value]) => [key.replace(/^[@$:]/, ""), bind(value)]))
  const statement = db.prepare(sql)
  statement.setReadBigInts(true)
  const metadata = statement.columns()
  if (metadata.length) {
    statement.setReturnArrays(true)
    const columns = metadata.map(column => column.name)
    const rawRows = Array.isArray(bindings) ? statement.all(...bindings) : statement.all(bindings)
    const rows = /** @type {SQLOutputValue[][]} */ (/** @type {unknown} */ (rawRows)).map(values => {
      const row = /** @type {Row} */ ({})
      Object.defineProperty(row, "length", { value: values.length })
      for (const [index, rawValue] of values.entries()) {
        const value = decode(rawValue)
        const name = columns[index]
        Object.defineProperty(row, index, { value })
        if (!Object.hasOwn(row, name)) {
          Object.defineProperty(row, name, { value, enumerable: true, configurable: true, writable: true })
        }
      }
      return row
    })
    return new ResultSetImpl(columns, metadata.map(column => column.type ?? ""), rows, 0, undefined)
  }
  // Node exposes sqlite3_changes(), which keeps the last DML count across DDL and PRAGMA.
  const count = db.prepare("SELECT total_changes() AS count")
  count.setReadBigInts(true)
  const previous = count.get()?.count
  const { changes, lastInsertRowid } = Array.isArray(bindings) ? statement.run(...bindings) : statement.run(bindings)
  const rowsAffected = previous === count.get()?.count ? 0 : Number(changes)
  return new ResultSetImpl([], [], [], rowsAffected, BigInt(lastInsertRowid))
}

/** @param {DatabaseSync} db @param {Array<InStatement | [string, InArgs?]>} statements */
function executeBatch(db, statements) {
  return statements.map((statement, index) => {
    try {
      if (!db.isTransaction) throw new LibsqlError("The transaction is closed", "TRANSACTION_CLOSED")
      return sqliteOperation(() => Array.isArray(statement) ? execute(db, statement[0], statement[1]) : execute(db, statement))
    } catch (error) {
      if (!(error instanceof LibsqlError)) throw error
      throw new LibsqlBatchError(error.message, index, error.code, error.extendedCode, error.rawCode,
        error.cause instanceof Error ? error.cause : undefined)
    }
  })
}

/** @param {DatabaseSync} db @param {TransactionMode} mode */
function begin(db, mode) {
  switch (mode) {
    case "write": return db.exec("BEGIN IMMEDIATE")
    case "read":
    case "deferred": return db.exec("BEGIN DEFERRED")
    default: throw new RangeError("Unknown SQLite transaction mode")
  }
}

let verifiedSQLite = false

function verifySQLite() {
  if (verifiedSQLite) return
  const probe = new DatabaseSync(":memory:")
  try {
    const version = String(probe.prepare("SELECT sqlite_version() AS version").get()?.version)
    const [major, minor, patch] = version.split(".").map(Number)
    if (!(major > 3 || major === 3 && (minor > 51 || minor === 51 && patch >= 3))) {
      throw new Error(`SQLite 3.51.3 or newer is required for safe WAL writes (found ${version})`)
    }
    verifiedSQLite = true
  } finally {
    probe.close()
  }
}

/** @param {string} path @param {boolean} memory @returns {Client} */
function openLocal(path, memory) {
  verifySQLite()
  // Deliberately do not wait inside SQLite. Busy feedback writes already retry asynchronously.
  const connect = () => sqliteOperation(() => new DatabaseSync(path, { timeout: 0 }))
  let main = connect()
  let closed = false
  const transactions = new Set()

  function idle() {
    if (closed) throw new LibsqlError("The client is closed", "CLIENT_CLOSED")
    if (memory && transactions.size) throw new LibsqlError("The in-memory connection is held by a transaction", "TRANSACTION_ACTIVE")
    return main
  }

  /** @template T @param {(db: DatabaseSync) => T} operation @returns {T} */
  function onMain(operation) {
    const db = idle()
    return sqliteOperation(() => {
      try {
        return operation(db)
      } finally {
        if (db.isTransaction) db.exec("ROLLBACK")
      }
    })
  }

  /** @param {Array<InStatement | [string, InArgs?]>} statements @param {TransactionMode} mode @param {boolean} migration */
  function batch(statements, mode, migration) {
    return onMain(db => {
      if (migration) db.exec("PRAGMA foreign_keys=OFF")
      const readOnly = mode === "read" && db.prepare("PRAGMA query_only").get()?.query_only === 0
      if (readOnly) db.exec("PRAGMA query_only=ON")
      try {
        begin(db, mode)
        const results = executeBatch(db, statements)
        db.exec("COMMIT")
        return results
      } finally {
        try {
          if (db.isTransaction) db.exec("ROLLBACK")
        } finally {
          if (migration) db.exec("PRAGMA foreign_keys=ON")
          if (readOnly) db.exec("PRAGMA query_only=OFF")
        }
      }
    })
  }

  /** @param {TransactionMode} mode @returns {Transaction} */
  function transaction(mode) {
    const primary = idle()
    if (transactions.size >= 19) throw new LibsqlError("All SQLite transaction connections are in use", "TRANSACTION_ACTIVE")
    const db = memory ? primary : connect()
    let active = true
    let restoreReadOnly = false

    function settle() {
      active = false
      transactions.delete(settle)
      try {
        if (db.isTransaction) db.exec("ROLLBACK")
      } finally {
        if (!memory) db.close()
        else if (restoreReadOnly) db.exec("PRAGMA query_only=OFF")
      }
    }

    try {
      if (mode === "read" && db.prepare("PRAGMA query_only").get()?.query_only === 0) {
        db.exec("PRAGMA query_only=ON")
        restoreReadOnly = true
      }
      sqliteOperation(() => begin(db, mode))
    } catch (error) {
      settle()
      throw error
    }
    transactions.add(settle)

    function assertActive() {
      if (!active || !db.isTransaction) throw new LibsqlError("The transaction is closed", "TRANSACTION_CLOSED")
    }

    return {
      get closed() { return !active || !db.isTransaction },
      /** @param {InStatement} statement @param {InArgs} [args] */
      async execute(statement, args) {
        assertActive()
        return sqliteOperation(() => execute(db, statement, args))
      },
      async batch(statements) {
        assertActive()
        return executeBatch(db, statements)
      },
      async executeMultiple(sql) {
        assertActive()
        sqliteOperation(() => db.exec(sql))
      },
      async commit() {
        assertActive()
        sqliteOperation(() => {
          try {
            db.exec("COMMIT")
          } finally {
            settle()
          }
        })
      },
      async rollback() {
        if (active) sqliteOperation(settle)
      },
      close() {
        if (active) sqliteOperation(settle)
      },
    }
  }

  function close() {
    if (closed) return
    closed = true
    try {
      for (const settle of transactions) settle()
    } finally {
      main.close()
    }
  }

  return {
    protocol: "file",
    get closed() { return closed },
    /** @param {InStatement} statement @param {InArgs} [args] */
    async execute(statement, args) { return onMain(db => execute(db, statement, args)) },
    async executeMultiple(sql) { onMain(db => db.exec(sql)) },
    /** @param {Array<InStatement | [string, InArgs?]>} statements @param {TransactionMode} [mode] */
    async batch(statements, mode = "deferred") { return batch(statements, mode, false) },
    async migrate(statements) { return batch(statements, "deferred", true) },
    /** @param {TransactionMode} [mode] */
    async transaction(mode = "write") { return transaction(mode) },
    async sync() {
      idle()
      throw new LibsqlError("Sync is unavailable for local SQLite", "SYNC_NOT_SUPPORTED")
    },
    close,
    reconnect() {
      close()
      main = connect()
      closed = false
    },
  }
}

/** @param {string} url @returns {Client} */
export function openDatabase(url) {
  if (/^file:/i.test(url) || url === ":memory:") {
    const config = expandConfig({ url }, true)
    const authority = config.authority
    if (authority && ((authority.host && authority.host.toLowerCase() !== "localhost") ||
      authority.port !== undefined || authority.userinfo !== undefined)) {
      throw new LibsqlError("Invalid authority in local SQLite URL", "URL_INVALID")
    }
    const memory = isInMemoryConfig(config)
    return openLocal(memory ? `file:${config.path}` : config.path, memory)
  }

  // Use the remote-only entry point, so remote loading never activates the old native SQLite engine.
  const { createClient } = require("@libsql/client/web")
  return createClient({ url })
}
