import { createRequire } from "node:module"
import { statSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import { setTimeout as sleepMs } from "node:timers/promises"
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
/** @typedef {import("@libsql/core/api").ResultSet} ResultSet */

const localWriters = new WeakMap()
const localExecutors = new WeakMap()
/** @type {WeakMap<DatabaseSync, import("node:sqlite").StatementSync>} */
const totalChangesStatements = new WeakMap()

const DB_DIAGNOSTICS_SYMBOL = Symbol.for("meitheal.sqlite.diagnostics")
const WRITE_BACKOFF_DELAYS_MS = [5, 15, 30, 60, 120]
const READ_LEASE_SLOW_MS = 5_000
const READ_IDLE_EVICT_MS = 30_000

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

export const DATABASE_SCHEMA_VERSION = 18

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
  const previous = getTotalChanges(db)
  const { changes, lastInsertRowid } = Array.isArray(bindings) ? statement.run(...bindings) : statement.run(bindings)
  const rowsAffected = previous === getTotalChanges(db) ? 0 : Number(changes)
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
 * @param {() => T} runAttempt
 * @param {() => boolean} isAcquired
 * @param {AbortSignal | undefined} signal
 * @returns {Promise<T>}
 */
async function retryBusyOperation(runAttempt, isAcquired, signal) {
  const diag = getDiagnosticsStore()
  throwIfSignalAborted(signal)
  try {
    return runAttempt()
  } catch (firstError) {
    if (isAcquired() || !isRetryableBusyError(firstError)) throw firstError
    let lastError = firstError
    for (const delay of WRITE_BACKOFF_DELAYS_MS) {
      throwIfSignalAborted(signal)
      diag.sqliteBusyRetriesTotal += 1
      await backoffSleep(delay, signal)
      throwIfSignalAborted(signal)
      try {
        return runAttempt()
      } catch (retryError) {
        if (isAcquired() || !isRetryableBusyError(retryError)) throw retryError
        lastError = retryError
      }
    }
    diag.sqliteBusyExhaustedTotal += 1
    throw lastError
  }
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
  const local = localWriters.get(client)
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

/** @param {string} path @param {boolean} memory @param {boolean} readOnly @returns {Client} */
function openLocal(path, memory, readOnly) {
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
        if (database.prepare(schemaMarkerTable).get()) checkSchemaMarker(database.prepare(schemaMarkerRows).all())
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

  /** @param {TransactionMode} mode @returns {Transaction} */
  function transaction(mode) {
    const primary = idle()
    if (transactions.size >= 19) throw new LibsqlError("All SQLite transaction connections are in use", "TRANSACTION_ACTIVE")

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
      }
    }

    try {
      if (memory && mode === "read" && db.prepare("PRAGMA query_only").get()?.query_only === 0) {
        db.exec("PRAGMA query_only=ON")
        restoreReadOnly = true
      }
      sqliteOperation(() => begin(db, mode))
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
    async transaction(mode = "write") { return transaction(mode) },
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
  localWriters.set(client, steps => onMain(db => {
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
  }))
  localExecutors.set(client, {
    executeStatement: executeStatementWithRetry,
    batchWrite: batchWriteWithRetry,
  })
  return client
}

/** Open local SQLite or remote libSQL. The read-only option applies to local SQLite. */
/** @param {string} url @param {{ readOnly?: boolean }} [options] @returns {Client} */
export function openDatabase(url, { readOnly = false } = {}) {
  if (/^file:/i.test(url) || url === ":memory:") {
    const config = expandConfig({ url }, true)
    const authority = config.authority
    if (authority && ((authority.host && authority.host.toLowerCase() !== "localhost") ||
      authority.port !== undefined || authority.userinfo !== undefined)) {
      throw new LibsqlError("Invalid authority in local SQLite URL", "URL_INVALID")
    }
    const memory = isInMemoryConfig(config)
    return openLocal(memory ? `file:${config.path}` : config.path, memory, readOnly)
  }

  // Use the remote-only entry point, so remote loading never activates the old native SQLite engine.
  const { createClient } = require("@libsql/client/web")
  return createClient({ url })
}
