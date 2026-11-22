import { createRequire } from "node:module"
import { constants, lstatSync, statSync } from "node:fs"
import { open } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { setTimeout as sleepMs } from "node:timers/promises"
import { LibsqlBatchError, LibsqlError } from "@libsql/core/api"
import { expandConfig, isInMemoryConfig } from "@libsql/core/config"
import { ResultSetImpl } from "@libsql/core/util"
import { boardGrantRevisionQuery, getBoardGrantPath, registerBoardGrantContext } from "./board-grant-context.mjs"
import { TASK_EXPERIENCE_SCHEMA_VERSION } from "../drizzle/migrations/0018_task_experience.mjs"
import {
  readTaskBoardMigrationState, taskBoardMigrationStateSteps,
} from "../drizzle/migrations/task-board-upgrade.mjs"

/** @typedef {import("@libsql/core/api").Client} Client */
/** @typedef {import("@libsql/core/api").InArgs} InArgs */
/** @typedef {import("@libsql/core/api").InStatement} InStatement */
/** @typedef {import("@libsql/core/api").InValue} InValue */
/** @typedef {import("@libsql/core/api").Transaction} Transaction */
/** @typedef {import("@libsql/core/api").TransactionMode} TransactionMode */
/** @typedef {import("@libsql/core/api").Row} Row */
/** @typedef {import("@libsql/core/api").ResultSet} ResultSet */

const localWriters = new WeakMap()
const localExecutors = new WeakMap()
/** @type {WeakMap<object, Pick<Transaction, "execute" | "batch" | "executeMultiple" | "commit" | "rollback" | "close"> & { mode: "read" | "write" }>} */
const localFileTransactions = new WeakMap()
/** @type {WeakMap<object, { execute: unknown, read: () => unknown }>} */
const localGrantRevisionReaders = new WeakMap()
/** @type {WeakMap<DatabaseSync, import("node:sqlite").StatementSync>} */
const totalChangesStatements = new WeakMap()
/** @type {WeakMap<DatabaseSync, import("node:sqlite").StatementSync>} */
const grantRevisionStatements = new WeakMap()
/** @typedef {"rows" | "completed"} TodayRead */
/** @typedef {"task-list" | "task-count" | "task-detail" | "task-search" | "task-locator" | "task-command" | "task-cascade"} TaskProjectionRead */
/** @typedef {TodayRead | TaskProjectionRead | "board-policy"} ScopedRead */
/** @type {WeakMap<object, ScopedRead>} */
const scopedReads = new WeakMap()
/** @type {WeakMap<DatabaseSync, Partial<Record<ScopedRead, { sql: string, statement: import("node:sqlite").StatementSync }>>>} */
const scopedReadStatements = new WeakMap()

/** Explicitly tag a source-owned Today query for local read-batch preparation.
 * @template {Exclude<InStatement, string>} T
 * @param {T} statement
 * @param {TodayRead} kind
 * @returns {T}
 */
export function tagTodayRead(statement, kind) {
  if (kind === "rows" || kind === "completed") scopedReads.set(statement, kind)
  return statement
}

/** @template {Exclude<InStatement, string>} T @param {T} statement @returns {T} */
export function tagBoardPolicyRead(statement) {
  scopedReads.set(statement, "board-policy")
  return statement
}

/** Explicit source-owned projections consume unique named columns only.
 * @template {Exclude<InStatement, string>} T
 * @param {T} statement @param {TaskProjectionRead} kind @returns {T}
 */
export function tagTaskProjectionRead(statement, kind) {
  scopedReads.set(statement, kind)
  return statement
}

/** Only unmodified transactions using a physically read-only local SQLite handle.
 * @param {Transaction} transaction
 */
export function isLocalReadSnapshot(transaction) {
  return localFileTransactionMode(transaction) === "read"
}

/** @param {Transaction} transaction */
export function isLocalFileWriter(transaction) {
  return localFileTransactionMode(transaction) === "write"
}

/** @param {Client} client */
export function isLocalFileClient(client) {
  const executor = localExecutors.get(client)
  return executor?.fileBacked === true && client.execute === executor.execute &&
    client.transaction === executor.transaction
}

/** @param {Transaction} transaction */
function localFileTransactionMode(transaction) {
  const methods = localFileTransactions.get(transaction)
  const original = methods !== undefined && !transaction.closed && transaction.execute === methods.execute &&
    transaction.batch === methods.batch && transaction.executeMultiple === methods.executeMultiple &&
    transaction.commit === methods.commit && transaction.rollback === methods.rollback && transaction.close === methods.close
  return original ? methods.mode : undefined
}

/** Use the reader's own execute method for adapters and decorated clients.
 * @param {{ execute?: unknown }} reader
 */
export function readLocalGrantRevision(reader) {
  const registered = localGrantRevisionReaders.get(reader)
  return registered && reader.execute === registered.execute ? registered.read() ?? null : undefined
}

/** @param {DatabaseSync} db */
function readGrantRevision(db) {
  let statement = grantRevisionStatements.get(db)
  if (!statement) {
    statement = db.prepare(boardGrantRevisionQuery)
    grantRevisionStatements.set(db, statement)
  }
  return statement.get()?.revision
}

const DB_DIAGNOSTICS_SYMBOL = Symbol.for("meitheal.sqlite.diagnostics")
const WRITE_BACKOFF_DELAYS_MS = [5, 15, 30, 60, 120]
const READ_LEASE_SLOW_MS = 5_000
const READ_IDLE_EVICT_MS = 30_000
const MAX_TRANSACTION_CONNECTIONS = 19
const MAX_QUEUED_READ_TRANSACTIONS = 64
const READ_TRANSACTION_ADMISSION_MS = 5_000

function getDiagnosticsStore() {
  let store = globalThis[DB_DIAGNOSTICS_SYMBOL]
  if (!store) {
    store = {
      sqliteBusyRetriesTotal: 0,
      sqliteBusyExhaustedTotal: 0,
      readPoolHitsTotal: 0,
      readPoolOverflowTotal: 0,
      readLeaseSlowWarningsTotal: 0,
    }
    globalThis[DB_DIAGNOSTICS_SYMBOL] = store
  }
  return store
}

export function getDatabaseDiagnostics() {
  const s = getDiagnosticsStore()
  return {
    sqliteBusyRetriesTotal: s.sqliteBusyRetriesTotal,
    sqliteBusyExhaustedTotal: s.sqliteBusyExhaustedTotal,
    readPoolHitsTotal: s.readPoolHitsTotal,
    readPoolOverflowTotal: s.readPoolOverflowTotal,
    readLeaseSlowWarningsTotal: s.readLeaseSlowWarningsTotal,
  }
}

export function resetDatabaseDiagnosticsForTests() {
  const s = getDiagnosticsStore()
  s.sqliteBusyRetriesTotal = 0
  s.sqliteBusyExhaustedTotal = 0
  s.readPoolHitsTotal = 0
  s.readPoolOverflowTotal = 0
  s.readLeaseSlowWarningsTotal = 0
}

export const DATABASE_SCHEMA_VERSION = TASK_EXPERIENCE_SCHEMA_VERSION

const schemaMarkerTable = "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'app_settings' COLLATE NOCASE"
const schemaMarkerRows = "SELECT value AS value FROM app_settings WHERE key = 'schema_version' LIMIT 2"

/** @param {{ value?: unknown }[]} rows */
function checkSchemaMarker(rows) {
  if (rows.length === 0) return
  const value = rows[0]?.value
  if (rows.length !== 1 || typeof value !== "string" || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error("The Meitheal database has an invalid schema version marker")
  }
  const version = Number(value)
  if (version > DATABASE_SCHEMA_VERSION) {
    throw new Error(`Meitheal database schema ${version} requires a newer App (this App supports ${DATABASE_SCHEMA_VERSION})`)
  }
}

/** @returns {Generator<[string], void, ResultSet[]>} */
export function* databaseSchemaCheckSteps() {
  const [table] = yield [schemaMarkerTable]
  if (table.rows.length > 0) {
    const [marker] = yield [schemaMarkerRows]
    checkSchemaMarker(marker.rows)
  }
}

/** @param {Pick<Client, "execute">} client */
export async function assertSupportedDatabaseSchema(client) {
  const check = databaseSchemaCheckSteps()
  let step = check.next()
  while (!step.done) {
    const result = await client.execute(step.value[0])
    step = check.next([result])
  }
}
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

/** @param {DatabaseSync} db */
function getTotalChanges(db) {
  let stmt = totalChangesStatements.get(db)
  if (!stmt) {
    stmt = db.prepare("SELECT total_changes() AS count")
    stmt.setReadBigInts(true)
    totalChangesStatements.set(db, stmt)
  }
  return stmt.get()?.count
}

/** @param {DatabaseSync} db @param {InStatement} input @param {InArgs} [args] @param {boolean} [fileReadSnapshot] */
function execute(db, input, args = [], fileReadSnapshot = false) {
  const sql = typeof input === "string" ? input : input.sql
  const values = typeof input === "string" ? args : input.args ?? []
  const bindings = Array.isArray(values)
    ? values.map(bind)
    : Object.fromEntries(Object.entries(values).map(([key, value]) => [key.replace(/^[@$:]/, ""), bind(value)]))
  const tag = typeof input === "string" ? undefined : scopedReads.get(input)
  const kind = fileReadSnapshot || tag === "board-policy" ? tag : undefined
  const slots = kind ? scopedReadStatements.get(db) : undefined
  const cached = kind ? slots?.[kind] : undefined
  let statement = cached?.sql === sql ? cached.statement : undefined
  if (!statement) {
    if (kind) {
      statement = db.prepare(sql)
      // Each query has one slot per handle. Changes in the scoped SQL replace it.
      if (slots) slots[kind] = { sql, statement }
      else scopedReadStatements.set(db, { [kind]: { sql, statement } })
    } else {
      statement = db.prepare(sql)
      statement.setReadBigInts(true)
    }
  }
  if (kind) {
    // Native named rows already have the declared projection keys. SQLite
    // checks the safe integer range in its number mode. Add libSQL's indexed
    // fields for both key access and ResultSet JSON serialization.
    const nativeRows = Array.isArray(bindings) ? statement.all(...bindings) : statement.all(bindings)
    const metadata = statement.columns()
    const columns = metadata.map(column => column.name)
    const rows = /** @type {Row[]} */ (nativeRows.map(nativeRow => {
      const row = { ...nativeRow }
      Object.defineProperty(row, "length", { value: columns.length })
      for (let index = 0; index < columns.length; index++) {
        const name = columns[index]
        const value = nativeRow[name]
        const decoded = value instanceof Uint8Array ? new Uint8Array(value).buffer : value
        if (decoded !== value) row[name] = decoded
        Object.defineProperty(row, index, { value: decoded })
      }
      return row
    }))
    return new ResultSetImpl(columns, metadata.map(column => column.type ?? ""), rows, 0, undefined)
  }
  if (statement.columns().length) {
    statement.setReturnArrays(true)
    const rawRows = Array.isArray(bindings) ? statement.all(...bindings) : statement.all(bindings)
    // SQLite may reprepare on the first step after another connection changes the schema.
    const metadata = statement.columns()
    const columns = metadata.map(column => column.name)
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
  const previous = getTotalChanges(db)
  const { changes, lastInsertRowid } = Array.isArray(bindings) ? statement.run(...bindings) : statement.run(bindings)
  const rowsAffected = previous === getTotalChanges(db) ? 0 : Number(changes)
  return new ResultSetImpl([], [], [], rowsAffected, BigInt(lastInsertRowid))
}

/** @param {DatabaseSync} db @param {Array<InStatement | [string, InArgs?]>} statements @param {boolean} [fileReadSnapshot] */
function executeBatch(db, statements, fileReadSnapshot = false) {
  return statements.map((statement, index) => {
    try {
      if (!db.isTransaction) throw new LibsqlError("The transaction is closed", "TRANSACTION_CLOSED")
      return sqliteOperation(() => Array.isArray(statement)
        ? execute(db, statement[0], statement[1], fileReadSnapshot)
        : execute(db, statement, undefined, fileReadSnapshot))
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

/** @param {AbortSignal | undefined} signal */
function throwIfSignalAborted(signal) {
  if (!signal?.aborted) return
  const reason = signal.reason
  if (reason instanceof Error && reason.name === "AbortError") throw reason
  if (typeof DOMException !== "undefined") {
    throw new DOMException(typeof reason === "string" ? reason : "The operation was aborted", "AbortError")
  }
  const err = new Error(typeof reason === "string" ? reason : "The operation was aborted")
  err.name = "AbortError"
  throw err
}

/** @param {number} delay @param {AbortSignal | undefined} signal */
async function backoffSleep(delay, signal) {
  throwIfSignalAborted(signal)
  try {
    await sleepMs(delay, undefined, signal ? { signal } : undefined)
  } catch (err) {
    if (signal?.aborted) throwIfSignalAborted(signal)
    throw err
  }
}

/** @param {unknown} error */
function isRetryableBusyError(error) {
  return error instanceof LibsqlError && (error.code === "SQLITE_BUSY" || error.code === "TRANSACTION_ACTIVE")
}

/**
 * Execute an attempt closure with async [5, 15, 30, 60, 120] ms backoff on SQLITE_BUSY / TRANSACTION_ACTIVE
 * whenever `isAcquired()` remains false (prior to BEGIN IMMEDIATE / commit effects).
 * @template T
 * @param {() => T | Promise<T>} runAttempt
 * @param {() => boolean} isAcquired
 * @param {AbortSignal | undefined} signal
 * @returns {Promise<T>}
 */
async function retryBusyOperation(runAttempt, isAcquired, signal) {
  const diag = getDiagnosticsStore()
  throwIfSignalAborted(signal)
  try {
    return await runAttempt()
  } catch (firstError) {
    if (isAcquired() || !isRetryableBusyError(firstError)) throw firstError
    let lastError = firstError
    for (const delay of WRITE_BACKOFF_DELAYS_MS) {
      throwIfSignalAborted(signal)
      diag.sqliteBusyRetriesTotal += 1
      await backoffSleep(delay, signal)
      throwIfSignalAborted(signal)
      try {
        return await runAttempt()
      } catch (retryError) {
        if (isAcquired() || !isRetryableBusyError(retryError)) throw retryError
        lastError = retryError
      }
    }
    diag.sqliteBusyExhaustedTotal += 1
    throw lastError
  }
}

/** Retry only lock acquisition for a write that must coordinate with an external file. */
export function acquireWriteTransaction(client, options) {
  return retryBusyOperation(() => client.transaction("write"), () => false, options?.signal)
}

/**
 * Run batches whose parameters depend on earlier results in the same write.
 * Local SQLite runs all steps synchronously so other App queries cannot
 * encounter a writer lock held across a Promise continuation.
 * @template T
 * @param {Client} client
 * @param {() => Generator<InStatement[], T, ResultSet[]>} steps
 * @param {{ signal?: AbortSignal | undefined }} [options]
 * @returns {Promise<T>}
 */
export async function runWriteTransaction(client, steps, options) {
  const signal = options?.signal
  const local = localWriters.get(client)?.run
  if (!local) {
    throwIfSignalAborted(signal)
    const tx = await client.transaction("write")
    try {
      const program = steps()
      let state = program.next()
      while (!state.done) {
        throwIfSignalAborted(signal)
        let batchResult
        try {
          batchResult = await tx.batch(state.value)
        } catch (stepError) {
          state = program.throw(stepError)
          continue
        }
        state = program.next(batchResult)
      }
      throwIfSignalAborted(signal)
      await tx.commit()
      return state.value
    } finally {
      tx.close()
    }
  }

  let acquired = false
  const start = () => {
    acquired = true
    return steps()
  }
  return retryBusyOperation(() => local(start), () => acquired, signal)
}

/**
 * Execute a standalone write statement or write batch with cooperative AbortSignal
 * checking and [5, 15, 30, 60, 120] ms SQLITE_BUSY backoff.
 * @param {Client} client
 * @param {InStatement | Array<InStatement | [string, InArgs?]>} statementOrBatch
 * @param {{ signal?: AbortSignal | undefined }} [options]
 * @returns {Promise<ResultSet | ResultSet[]>}
 */
export async function executeWriteWithRetry(client, statementOrBatch, options) {
  const signal = options?.signal
  const executor = localExecutors.get(client)
  if (!executor) {
    throwIfSignalAborted(signal)
    if (Array.isArray(statementOrBatch)) {
      return client.batch(statementOrBatch, "write")
    }
    return client.execute(statementOrBatch)
  }
  if (Array.isArray(statementOrBatch)) {
    return executor.batchWrite(statementOrBatch, signal)
  }
  return executor.executeStatement(statementOrBatch, undefined, signal)
}

/** @param {InStatement} statement */
function isLikelyWriteStatement(statement) {
  const sql = (typeof statement === "string" ? statement : statement.sql).trimStart()
  return /^(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP|VACUUM|REINDEX|ANALYZE|ATTACH|DETACH)\b/i.test(sql)
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

function emitSlowReadLeaseWarning() {
  const line = JSON.stringify({
    service: "meitheal-web",
    env: process.env.NODE_ENV ?? "production",
    ts: new Date().toISOString(),
    level: "warn",
    event: "sqlite.read_lease.slow",
    domain: "observability",
    component: "database-client",
    request_id: "system",
    message: `SQLite read transaction lease exceeded ${READ_LEASE_SLOW_MS}ms`,
  })
  process.stdout.write(`${line}\n`)
}

/** @param {unknown} error */
function needsJournalRecovery(error) {
  return error instanceof LibsqlError && (error.rawCode === 264 || error.rawCode === 776)
}

/** @param {string} path @param {boolean} memory @param {boolean} readOnly @param {boolean} [inspectBoard] @returns {Client} */
function openLocal(path, memory, readOnly, inspectBoard = false) {
  verifySQLite()
  // Deliberately do not wait inside SQLite; write retries happen asynchronously on the JS event loop.
  const connectRaw = (inspectOnly = readOnly) => sqliteOperation(() => new DatabaseSync(path, { timeout: 0, readOnly: inspectOnly }))
  /** @param {DatabaseSync} db @param {boolean} inspectOnly @param {boolean} secondary */
  const configureConnection = (db, inspectOnly = readOnly, secondary = false) => sqliteOperation(() => {
    try {
      db.exec("PRAGMA foreign_keys = ON; PRAGMA mmap_size = 0;")
      if (inspectOnly) {
        db.exec("PRAGMA cache_size = -512;")
      } else if (secondary) {
        db.exec("PRAGMA synchronous = FULL; PRAGMA cache_size = -512;")
      } else {
        db.exec("PRAGMA synchronous = FULL; PRAGMA cache_size = -2000;")
      }
      return db
    } catch (err) {
      db.close()
      throw err
    }
  })
  const connect = (inspectOnly = readOnly, secondary = false) => configureConnection(connectRaw(inspectOnly), inspectOnly, secondary)

  /** @param {DatabaseSync} database */
  function inspectSchema(database) {
    sqliteOperation(() => {
      database.exec("BEGIN")
      try {
        if (inspectBoard) {
          const check = taskBoardMigrationStateSteps()
          let state = check.next()
          while (!state.done) state = check.next([execute(database, state.value[0])])
        } else if (database.prepare(schemaMarkerTable).get()) {
          checkSchemaMarker(database.prepare(schemaMarkerRows).all())
        }
      } finally {
        if (database.isTransaction) database.exec("ROLLBACK")
      }
    })
  }
  function openMain() {
    if (memory) return connect(readOnly, false)
    if (!statSync(path, { throwIfNoEntry: false })) {
      if (readOnly) throw new Error("Database does not exist. Run the migration command to create it.")
      return connect(false, false)
    }
    const inspection = connectRaw(true)
    try {
      inspectSchema(inspection)
      if (readOnly) return configureConnection(inspection, true, true)
    } catch (error) {
      inspection.close()
      // SQLite can require a writer to recover a journal left by a crashed process.
      if (readOnly || !(error instanceof LibsqlError) || (error.rawCode !== 264 && error.rawCode !== 776)) throw error
      const recovery = connectRaw(false)
      try {
        inspectSchema(recovery)
        return configureConnection(recovery, false, false)
      } catch (recoveryError) {
        recovery.close()
        throw recoveryError
      }
    }
    inspection.close()
    return connect(false, false)
  }
  let main = openMain()
  let closed = false
  const transactions = new Set()
  let readReservations = 0
  let clientGeneration = 0
  /** @type {Array<{ resolve: () => void, reject: (error: Error) => void, timer: ReturnType<typeof globalThis.setTimeout> }>} */
  const readWaiters = []

  function admitWaitingReads() {
    while (!closed && readWaiters.length && transactions.size + readReservations < MAX_TRANSACTION_CONNECTIONS) {
      const waiter = readWaiters.shift()
      if (!waiter) break
      globalThis.clearTimeout(waiter.timer)
      readReservations += 1
      waiter.resolve()
    }
  }

  /** Queue acquisition only. A query is never started, retried or replayed here. */
  async function admittedReadTransaction() {
    if (closed) throw new LibsqlError("The client is closed", "CLIENT_CLOSED")
    if (memory || !readWaiters.length && transactions.size + readReservations < MAX_TRANSACTION_CONNECTIONS) return transaction("read")
    if (readWaiters.length >= MAX_QUEUED_READ_TRANSACTIONS) throw new LibsqlError("SQLite read admission queue is full", "TRANSACTION_ACTIVE")
    const generation = clientGeneration
    await new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timer: globalThis.setTimeout(() => {
        const index = readWaiters.indexOf(waiter)
        if (index >= 0) readWaiters.splice(index, 1)
        reject(new LibsqlError("SQLite read admission deadline exceeded", "TRANSACTION_ACTIVE"))
      }, READ_TRANSACTION_ADMISSION_MS) }
      readWaiters.push(waiter)
      admitWaitingReads()
    })
    // Consume exactly this caller's reserved slot without another await. A close
    // or reconnect invalidates queued work even if admission was just signalled.
    readReservations -= 1
    try {
      if (closed || generation !== clientGeneration) throw new LibsqlError("The client is closed", "CLIENT_CLOSED")
      return transaction("read")
    } finally { admitWaitingReads() }
  }

  /** @type {DatabaseSync | null} */
  let idleReadHandle = null
  let readSlotLeased = false
  /** @type {ReturnType<typeof globalThis.setTimeout> | undefined} */
  let readIdleTimer = undefined

  function clearReadIdleTimer() {
    if (readIdleTimer !== undefined) {
      globalThis.clearTimeout(readIdleTimer)
      readIdleTimer = undefined
    }
  }

  function closeIdleReadHandle() {
    clearReadIdleTimer()
    if (idleReadHandle) {
      try {
        idleReadHandle.close()
      } finally {
        idleReadHandle = null
      }
    }
  }

  function armReadIdleEviction() {
    clearReadIdleTimer()
    readIdleTimer = globalThis.setTimeout(() => {
      readIdleTimer = undefined
      if (!readSlotLeased && idleReadHandle) {
        try {
          idleReadHandle.close()
        } finally {
          idleReadHandle = null
        }
      }
    }, READ_IDLE_EVICT_MS)
    readIdleTimer.unref?.()
  }

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

  /**
   * @param {Array<InStatement | [string, InArgs?]>} statements
   * @param {TransactionMode} mode
   * @param {boolean} migration
   * @param {() => void} [onAcquired]
   */
  function batchSync(statements, mode, migration, onAcquired) {
    return onMain(db => {
      if (migration) db.exec("PRAGMA foreign_keys=OFF")
      const queryOnly = mode === "read" && db.prepare("PRAGMA query_only").get()?.query_only === 0
      if (queryOnly) db.exec("PRAGMA query_only=ON")
      try {
        begin(db, mode)
        if (mode === "write") onAcquired?.()
        const results = executeBatch(db, statements)
        db.exec("COMMIT")
        onAcquired?.()
        return results
      } finally {
        try {
          if (db.isTransaction) db.exec("ROLLBACK")
        } finally {
          if (migration) db.exec("PRAGMA foreign_keys=ON")
          if (queryOnly) db.exec("PRAGMA query_only=OFF")
        }
      }
    })
  }

  /**
   * @param {InStatement} statement
   * @param {InArgs | undefined} args
   * @param {AbortSignal | undefined} signal
   */
  async function executeStatementWithRetry(statement, args, signal) {
    if (!signal && !isLikelyWriteStatement(statement)) {
      return onMain(db => execute(db, statement, args))
    }
    return retryBusyOperation(() => onMain(db => execute(db, statement, args)), () => false, signal)
  }

  /**
   * @param {Array<InStatement | [string, InArgs?]>} statements
   * @param {AbortSignal | undefined} signal
   */
  async function batchWriteWithRetry(statements, signal) {
    let acquired = false
    return retryBusyOperation(
      () => batchSync(statements, "write", false, () => { acquired = true }),
      () => acquired,
      signal,
    )
  }

  /** @param {TransactionMode} mode @param {boolean} [exclusive] @returns {Transaction} */
  function transaction(mode, exclusive = false) {
    const primary = idle()
    if (transactions.size + readReservations >= MAX_TRANSACTION_CONNECTIONS) throw new LibsqlError("All SQLite transaction connections are in use", "TRANSACTION_ACTIVE")

    const diag = getDiagnosticsStore()
    const useReadPool = !memory && mode === "read"
    let leasedFromPrimaryReadSlot = false
    /** @type {DatabaseSync} */
    let db
    if (memory) {
      db = primary
    } else if (useReadPool) {
      if (!readSlotLeased) {
        clearReadIdleTimer()
        readSlotLeased = true
        leasedFromPrimaryReadSlot = true
        if (idleReadHandle) {
          db = idleReadHandle
          idleReadHandle = null
          diag.readPoolHitsTotal += 1
        } else {
          try {
            db = connect(true, true)
          } catch (err) {
            readSlotLeased = false
            throw err
          }
        }
      } else {
        diag.readPoolOverflowTotal += 1
        db = connect(true, true)
      }
    } else {
      db = connect(readOnly, true)
    }

    let active = true
    let restoreReadOnly = false
    /** @type {ReturnType<typeof globalThis.setTimeout> | undefined} */
    let slowLeaseTimer = undefined

    function clearSlowLeaseTimer() {
      if (slowLeaseTimer !== undefined) {
        globalThis.clearTimeout(slowLeaseTimer)
        slowLeaseTimer = undefined
      }
    }

    function settle() {
      if (!active) return
      active = false
      clearSlowLeaseTimer()
      transactions.delete(settle)
      try {
        if (db.isTransaction) db.exec("ROLLBACK")
      } finally {
        try {
          if (memory) {
            if (restoreReadOnly) db.exec("PRAGMA query_only=OFF")
          } else if (leasedFromPrimaryReadSlot) {
            readSlotLeased = false
            if (closed) {
              db.close()
            } else {
              idleReadHandle = db
              armReadIdleEviction()
            }
          } else {
            db.close()
          }
        } finally { admitWaitingReads() }
      }
    }

    try {
      if (memory && mode === "read" && db.prepare("PRAGMA query_only").get()?.query_only === 0) {
        db.exec("PRAGMA query_only=ON")
        restoreReadOnly = true
      }
      sqliteOperation(() => exclusive ? db.exec("BEGIN EXCLUSIVE") : begin(db, mode))
      if (useReadPool) {
        slowLeaseTimer = globalThis.setTimeout(() => {
          slowLeaseTimer = undefined
          if (active) {
            diag.readLeaseSlowWarningsTotal += 1
            emitSlowReadLeaseWarning()
          }
        }, READ_LEASE_SLOW_MS)
        slowLeaseTimer.unref?.()
      }
    } catch (error) {
      settle()
      throw error
    }
    transactions.add(settle)

    function assertActive() {
      if (!active || !db.isTransaction) throw new LibsqlError("The transaction is closed", "TRANSACTION_CLOSED")
    }

    const result = {
      get closed() { return !active || !db.isTransaction },
      /** @param {InStatement} statement @param {InArgs} [args] */
      async execute(statement, args) {
        assertActive()
        return sqliteOperation(() => execute(db, statement, args, useReadPool))
      },
      async batch(statements) {
        assertActive()
        return executeBatch(db, statements, useReadPool)
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
    registerBoardGrantContext(result, { markerPath: getBoardGrantPath(client) })
    localGrantRevisionReaders.set(result, {
      execute: result.execute,
      read: () => {
        assertActive()
        return sqliteOperation(() => readGrantRevision(db))
      },
    })
    if (!memory && (mode === "read" || mode === "write")) localFileTransactions.set(result, {
      execute: result.execute,
      batch: result.batch,
      executeMultiple: result.executeMultiple,
      commit: result.commit,
      rollback: result.rollback,
      close: result.close,
      mode,
    })
    return result
  }

  function close() {
    if (closed) return
    closed = true
    clientGeneration += 1
    for (const waiter of readWaiters.splice(0)) {
      globalThis.clearTimeout(waiter.timer)
      waiter.reject(new LibsqlError("The client is closed", "CLIENT_CLOSED"))
    }
    try {
      for (const settle of transactions) settle()
    } finally {
      try {
        closeIdleReadHandle()
      } finally {
        main.close()
      }
    }
  }

  /** @type {Client} */
  const client = {
    protocol: "file",
    get closed() { return closed },
    /** @param {InStatement} statement @param {InArgs} [args] */
    async execute(statement, args) { return executeStatementWithRetry(statement, args, undefined) },
    async executeMultiple(sql) { onMain(db => db.exec(sql)) },
    /** @param {Array<InStatement | [string, InArgs?]>} statements @param {TransactionMode} [mode] */
    async batch(statements, mode = "deferred") {
      if (mode === "write") return batchWriteWithRetry(statements, undefined)
      return batchSync(statements, mode, false)
    },
    async migrate(statements) { return batchSync(statements, "deferred", true) },
    /** @param {TransactionMode} [mode] */
    async transaction(mode = "write") { return mode === "read" ? admittedReadTransaction() : transaction(mode) },
    async sync() {
      idle()
      throw new LibsqlError("Sync is unavailable for local SQLite", "SYNC_NOT_SUPPORTED")
    },
    close,
    reconnect() {
      close()
      main = openMain()
      closed = false
    },
  }
  localWriters.set(client, {
    run: steps => onMain(db => {
      begin(db, "write")
      const program = steps()
      let state = program.next()
      while (!state.done) {
        let batchResult
        try {
          batchResult = executeBatch(db, state.value)
        } catch (stepError) {
          state = program.throw(stepError)
          continue
        }
        state = program.next(batchResult)
      }
      db.exec("COMMIT")
      return state.value
    }),
    start: () => transaction("write", true),
  })
  localExecutors.set(client, {
    executeStatement: executeStatementWithRetry,
    batchWrite: batchWriteWithRetry,
    fileBacked: !memory,
    execute: client.execute,
    transaction: client.transaction,
  })
  localGrantRevisionReaders.set(client, { execute: client.execute, read: () => onMain(readGrantRevision) })
  return client
}

/** @param {string} url */
function localDatabaseLocation(url) {
  if (/^file:/i.test(url) || url === ":memory:") {
    const config = expandConfig({ url }, true)
    const authority = config.authority
    if (authority && ((authority.host && authority.host.toLowerCase() !== "localhost") ||
      authority.port !== undefined || authority.userinfo !== undefined)) {
      throw new LibsqlError("Invalid authority in local SQLite URL", "URL_INVALID")
    }
    const memory = isInMemoryConfig(config)
    return { path: memory ? `file:${config.path}` : config.path, memory }
  }
}

/** @param {string} url */
export function isMemoryDatabase(url) {
  return localDatabaseLocation(url)?.memory === true
}

/** Open local SQLite or remote libSQL. The read-only option applies to local SQLite. */
/** @param {string} url @param {{ readOnly?: boolean }} [options] @returns {Client} */
export function openDatabase(url, { readOnly = false } = {}) {
  const local = localDatabaseLocation(url)
  if (local) return openLocal(local.path, local.memory, readOnly)
  // Use the remote-only entry point, so remote loading never activates the old native SQLite engine.
  const { createClient } = require("@libsql/client/web")
  return createClient({ url })
}

/** Retry startup lock acquisition and read-only verification. An acquired writer runs once. */
/** @template T @param {() => Promise<T>} operation @returns {Promise<T>} */
export async function retryStartupLock(operation) {
  const deadline = performance.now() + 2_500
  for (;;) {
    try {
      return await operation()
    } catch (error) {
      const remaining = deadline - performance.now()
      const code = error instanceof Error && "code" in error ? error.code : undefined
      if (remaining <= 0 || typeof code !== "string" ||
        !["SQLITE_BUSY", "SQLITE_LOCKED", "TRANSACTION_ACTIVE"].includes(code)) throw error
      await sleepMs(Math.min(50, remaining))
    }
  }
}

/** @param {Client} client */
async function inspectStartupSchema(client) {
  const tx = await client.transaction("read")
  try {
    if (await readTaskBoardMigrationState(tx) === "household-v19") {
      const { validateStartupTaskSchema } = await import("./task-schema-startup.mjs")
      await validateStartupTaskSchema(tx, { allowPending: true })
    }
  } finally {
    tx.close()
  }
}

function assertRegularDatabasePath(path) {
  for (let current = resolve(path); ; current = dirname(current)) {
    const stats = lstatSync(current, { throwIfNoEntry: false })
    if (stats?.isSymbolicLink()) throw new Error("Database startup refuses symlink paths")
    if (current === resolve(path) && stats && !stats.isFile()) throw new Error("Database startup requires a regular file")
    if (dirname(current) === current) break
  }
}

function hasDatabaseFamily(path) {
  return ["-wal", "-shm", "-journal"].some(suffix => lstatSync(path + suffix, { throwIfNoEntry: false }))
}

/** Inspect existing data read-only. Only successful exclusive local creation owns first enrollment. */
/** @param {string} url @param {{ readOnly?: boolean, markerPath?: string, trustedInitialization?: { kind: "isolated-memory" } }} [options] @returns {Promise<Client>} */
export function openDatabaseForStartup(url, { readOnly = false, markerPath, trustedInitialization } = {}) {
  return retryStartupLock(async () => {
    const local = localDatabaseLocation(url)
    if (!local || local.memory) {
      if (trustedInitialization && (trustedInitialization.kind !== "isolated-memory" || !local?.memory || !markerPath || readOnly)) {
        throw new Error("Trusted initialization requires an explicit isolated memory database and marker context")
      }
      const client = openDatabase(url, { readOnly })
      try {
        await inspectStartupSchema(client)
        registerBoardGrantContext(client, { markerPath, created: !!trustedInitialization })
        if (!local) {
          const transaction = client.transaction.bind(client)
          client.transaction = async (...args) => {
            const tx = await transaction(...args)
            registerBoardGrantContext(tx, { markerPath: getBoardGrantPath(client) })
            return tx
          }
        }
        return client
      } catch (error) {
        client.close()
        throw error
      }
    }
    if (trustedInitialization) throw new Error("Local database initialization requires exclusive creation")
    assertRegularDatabasePath(local.path)
    if (!readOnly && !lstatSync(local.path, { throwIfNoEntry: false })) {
      if (hasDatabaseFamily(local.path)) throw new Error("Database family residue prevents fresh enrollment")
      let file
      try {
        file = await open(local.path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
      } catch (error) {
        // A competing creator owns its capability. Never turn EEXIST into fresh authority.
        if (error?.code === "EEXIST") throw new Error("Database creation raced; retry startup with existing data")
        throw error
      }
      const created = await file.stat()
      await file.sync()
      await file.close()
      const directory = await open(dirname(resolve(local.path)), constants.O_DIRECTORY | constants.O_RDONLY | constants.O_NOFOLLOW)
      try { await directory.sync() } finally { await directory.close() }
      assertRegularDatabasePath(local.path)
      const actual = lstatSync(local.path)
      if (!created.isFile() || actual.dev !== created.dev || actual.ino !== created.ino || hasDatabaseFamily(local.path)) {
        throw new Error("Database creation provenance is ambiguous")
      }
      const client = openLocal(local.path, false, false, true)
      const opened = lstatSync(local.path)
      if (opened.dev !== created.dev || opened.ino !== created.ino) {
        client.close()
        throw new Error("Database identity changed during creation")
      }
      registerBoardGrantContext(client, { markerPath, created: true })
      return client
    }

    let inspection
    let recovered = false
    try {
      inspection = openLocal(local.path, false, true, true)
      await inspectStartupSchema(inspection)
    } catch (error) {
      inspection?.close()
      if (readOnly || !needsJournalRecovery(error)) throw error
      // SQLite may have to restore a hot journal before any read can succeed.
      inspection = openLocal(local.path, false, false, true)
      try {
        await inspectStartupSchema(inspection)
        recovered = true
      } catch (recoveryError) {
        inspection.close()
        throw recoveryError
      }
    }
    if (readOnly || recovered) {
      registerBoardGrantContext(inspection, { markerPath })
      return inspection
    }
    inspection.close()
    const client = openLocal(local.path, false, false, true)
    registerBoardGrantContext(client, { markerPath })
    return client
  })
}

/** @param {Client} client */
export function enableStartupWal(client) {
  return retryStartupLock(() => client.execute("PRAGMA journal_mode=WAL"))
}

/** @template T @param {Client} client @param {(tx: Transaction) => Promise<T>} apply @returns {Promise<T>} */
export async function withStartupWriteTransaction(client, apply) {
  const tx = await retryStartupLock(async () => {
    const local = localWriters.get(client)
    if (local) {
      // On a rollback journal, wait for readers before DDL can spill or commit.
      return local.start()
    }
    const writer = await client.transaction("write")
    try {
      // Remote libSQL starts its transaction on the first statement.
      await writer.execute("SELECT 1")
      return writer
    } catch (error) {
      writer.close()
      throw error
    }
  })
  try {
    const value = await apply(tx)
    await tx.commit()
    return value
  } finally {
    tx.close()
  }
}
