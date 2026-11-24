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
import { CUSTOM_BOARD_KEYS_SCHEMA_VERSION } from "../drizzle/migrations/0017_custom_board_keys.mjs"
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
/** @type {WeakMap<object, Pick<Transaction, "execute" | "batch" | "executeMultiple" | "commit" | "rollback" | "close"> & { db: DatabaseSync, mode: "read" | "write", generation: () => number, cacheToken: () => { owner: object, token: string } }>} */
const localFileTransactions = new WeakMap()
/** @type {WeakMap<object, { execute: unknown, read: () => unknown }>} */
const localGrantRevisionReaders = new WeakMap()
/** @type {WeakMap<DatabaseSync, import("node:sqlite").StatementSync>} */
const totalChangesStatements = new WeakMap()
/** @type {WeakMap<DatabaseSync, import("node:sqlite").StatementSync>} */
const grantRevisionStatements = new WeakMap()
/** @type {WeakMap<DatabaseSync, import("node:sqlite").StatementSync>} */
const dataVersionStatements = new WeakMap()
/** @type {WeakMap<DatabaseSync, import("node:sqlite").StatementSync>} */
const schemaVersionStatements = new WeakMap()
/** @type {WeakMap<DatabaseSync, import("node:sqlite").StatementSync>} */
const externalVersionStatements = new WeakMap()
/** @type {WeakMap<DatabaseSync, Map<string, import("node:sqlite").StatementSync>>} */
const preparedStatements = new WeakMap()
// The App issues a few hundred distinct statements. Compiling the large scoped
// projections dominates repeated reads on low-power hosts; their compiled
// programs cost a few kilobytes each.
const MAX_PREPARED_STATEMENTS = 256
// SQLite treats comments as whitespace before the first keyword. An
// unterminated comment leaves no keyword, which classifies conservatively.
const leadingTrivia = /^(?:\s+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*/
/** @param {string} sql @returns {string} */
function leadingKeyword(sql) {
  return /^[A-Za-z]+/.exec(sql.replace(leadingTrivia, ""))?.[0].toUpperCase() ?? ""
}
// Only side-effect-free statements are cached, so one can safely run again.
const nonSelectTokens = /\b(?:INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|PRAGMA|ATTACH|DETACH|VACUUM|REINDEX|BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b|\bREPLACE\s+INTO\b/i
/** Strip SQL literals and comments in a single linear pass so CTE DML detection is ReDoS-free.
 * @param {string} sql @returns {string}
 */
function stripSqlCommentsAndLiterals(sql) {
  let out = ""
  let i = 0
  while (i < sql.length) {
    const ch = sql.charCodeAt(i)
    const next = i + 1 < sql.length ? sql.charCodeAt(i + 1) : 0
    if (ch === 39 || ch === 34 || ch === 96) {
      i += 1
      while (i < sql.length) {
        if (sql.charCodeAt(i) === ch) {
          i += 1
          if (sql.charCodeAt(i) === ch) {
            i += 1
            continue
          }
          break
        }
        i += 1
      }
      out += " "
    } else if (ch === 91) {
      i += 1
      while (i < sql.length && sql.charCodeAt(i) !== 93) i += 1
      if (i < sql.length) i += 1
      out += " "
    } else if (ch === 45 && next === 45) {
      const nl = sql.indexOf("\n", i + 2)
      i = nl === -1 ? sql.length : nl + 1
      out += " "
    } else if (ch === 47 && next === 42) {
      const end = sql.indexOf("*/", i + 2)
      i = end === -1 ? sql.length : end + 2
      out += " "
    } else {
      const start = i
      while (i < sql.length) {
        const c = sql.charCodeAt(i)
        if (c === 39 || c === 34 || c === 96 || c === 91 || c === 45 || c === 47) break
        i += 1
      }
      if (i === start) {
        out += sql[i]
        i += 1
      } else {
        out += sql.slice(start, i)
      }
    }
  }
  return out
}
/** @type {WeakMap<DatabaseSync, number>} */
const handleMutationEpochs = new WeakMap()
/** @param {DatabaseSync} db */
function bumpHandleEpoch(db) {
  handleMutationEpochs.set(db, (handleMutationEpochs.get(db) ?? 0) + 1)
}
const sideEffectFreeCache = new Map()
const MAX_SIDE_EFFECT_FREE_CACHE = 512
const dmlKeywords = new Set(["INSERT", "UPDATE", "DELETE"])
const parameterMarker = /[?:@$]/
const returningStar = /\bRETURNING\s+\*/i
const PURE_TASK_OR_STATS_WRITE_RE = /^\s*(?:INSERT\s+(?:OR\s+(?:IGNORE|ABORT|FAIL|REPLACE|ROLLBACK)\s+)?INTO\s+(?:tasks|task_activity_log|gamification_stats|gamification_achievements)\b|UPDATE\s+(?:tasks|gamification_stats)\s+SET\b|DELETE\s+FROM\s+(?:tasks|task_activity_log)\b|UPDATE\s+task_boards\s+SET\s+ticket_high_water\s*=)/i
/** Return true for single-statement task/activity/gamification writes that leave shared policy and settings tables unchanged.
 * @param {string} sql @returns {boolean}
 */
function isPureTaskOrStatsWrite(sql) {
  const stripped = stripSqlCommentsAndLiterals(sql).trimEnd()
  const single = stripped.endsWith(";") ? stripped.slice(0, -1) : stripped
  return !single.includes(";") && PURE_TASK_OR_STATS_WRITE_RE.test(sql)
}
const MAIN_LOCAL_STATE_RE = /\b(?:TEMP|TEMPORARY|ATTACH|DETACH)\b|\bsqlite_temp_(?:schema|master)\b/i
const READ_OR_GLOBAL_PRAGMA_RE = /^\s*PRAGMA\s+(?:[A-Za-z0-9_]+\.)?(?:journal_mode|wal_checkpoint|table_x?info|index_x?(?:list|info)|foreign_key_(?:list|check)|integrity_check|quick_check|database_list|compile_options|function_list|module_list|pragma_list|collation_list|stats|freelist_count|page_count|page_size)\b/i
/** Return true when SQL can create or alter connection-local state on main.
 * @param {string} sql @returns {boolean}
 */
function mayCreateMainLocalState(sql) {
  const stripped = stripSqlCommentsAndLiterals(sql)
  if (MAIN_LOCAL_STATE_RE.test(stripped)) return true
  return leadingKeyword(stripped) === "PRAGMA" && /[=(]/.test(stripped) && !READ_OR_GLOBAL_PRAGMA_RE.test(stripped)
}
/** Return true only for single-statement side-effect-free SELECT or WITH ... SELECT queries.
 * @param {string} sql @returns {boolean}
 */
export function isSideEffectFreeQuery(sql) {
  const cached = sideEffectFreeCache.get(sql)
  if (cached !== undefined) return cached
  let safe = false
  const keyword = leadingKeyword(sql)
  if (keyword === "SELECT" || keyword === "WITH") {
    const stripped = stripSqlCommentsAndLiterals(sql).trimEnd()
    const single = stripped.endsWith(";") ? stripped.slice(0, -1) : stripped
    safe = !single.includes(";") && (keyword === "SELECT" || !nonSelectTokens.test(single))
  }
  if (sideEffectFreeCache.size >= MAX_SIDE_EFFECT_FREE_CACHE) {
    sideEffectFreeCache.delete(sideEffectFreeCache.keys().next().value)
  }
  sideEffectFreeCache.set(sql, safe)
  return safe
}
/** Return true for side-effect-free queries or parameterized DML statements without RETURNING *.
 * @param {string} sql @returns {boolean}
 */
function isCacheableStatement(sql) {
  if (isSideEffectFreeQuery(sql)) return true
  const keyword = leadingKeyword(sql)
  if (!dmlKeywords.has(keyword)) return false
  const stripped = stripSqlCommentsAndLiterals(sql).trimEnd()
  const single = stripped.endsWith(";") ? stripped.slice(0, -1) : stripped
  if (single.includes(";")) return false
  return parameterMarker.test(single) && !returningStar.test(single)
}
/** @param {string} sql */
const isPlainSelect = isSideEffectFreeQuery
// Only row reads and changes leave no connection state behind a transaction.
const rowStatementKeywords = new Set(["SELECT", "INSERT", "UPDATE", "DELETE", "REPLACE", "WITH", "VALUES"])
// A read-only handle can only query with these; anything else may end its snapshot.
const readSnapshotKeywords = new Set(["SELECT", "WITH", "VALUES"])
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

/**
 * A token that stays equal only while a local reader observes the same database
 * state. A read snapshot never changes. A writer advances on every statement
 * that is not a plain SELECT, so its own effects (including trigger and DDL
 * effects) invalidate results derived from earlier reads. The shared file
 * connection combines SQLite's data_version (commits by other connections),
 * total_changes() (its own row changes) and the schema cookie.
 * Undefined means the caller must not reuse derived results.
 * @param {Transaction | Pick<Client, "execute">} reader
 * @returns {string | undefined}
 */
export function localSnapshotGeneration(reader) {
  const mode = localFileTransactionMode(/** @type {Transaction} */ (reader))
  if (mode !== undefined) return mode + ":" + localFileTransactions.get(reader)?.generation()
  const executor = localExecutors.get(reader)
  if (!executor?.fileBacked || reader.execute !== executor.execute) return undefined
  return "live:" + executor.generation()
}

const readerCacheSources = new WeakMap()

/** Register an internal read/write guard wrapper so snapshot caches resolve its underlying handle.
 * @param {object} wrapper @param {object} target
 */
export function registerReaderCacheSource(wrapper, target) {
  if (wrapper && target && (typeof wrapper === "object" || typeof wrapper === "function")) {
    readerCacheSources.set(wrapper, target)
  }
}

/**
 * Return the underlying SQLite handle and snapshot token for local file readers and writers.
 * Pooled transactions share their underlying handle across requests while external commits,
 * own changes, schema changes, and rollbacks advance the token.
 * @param {Transaction | Pick<Client, "execute">} reader
 * @returns {{ owner: object, token: string } | undefined}
 */
export function localReaderCacheToken(reader) {
  let current = /** @type {unknown} */ (reader)
  for (let hop = 0; hop < 6 && current && (typeof current === "object" || typeof current === "function") && readerCacheSources.has(current); hop += 1) {
    current = readerCacheSources.get(current)
  }
  if (!current || (typeof current !== "object" && typeof current !== "function")) return undefined
  const mode = localFileTransactionMode(/** @type {Transaction} */ (current))
  if (mode !== undefined) {
    return localFileTransactions.get(current)?.cacheToken()
  }
  const executor = localExecutors.get(current)
  if (!executor?.fileBacked || /** @type {Pick<Client, "execute">} */ (current).execute !== executor.execute) return undefined
  return executor.cacheToken()
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
    statement.setReturnArrays(true)
    grantRevisionStatements.set(db, statement)
  }
  return /** @type {unknown[] | undefined} */ (statement.get())?.[0]
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

export const DATABASE_SCHEMA_VERSION = CUSTOM_BOARD_KEYS_SCHEMA_VERSION

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

/** Reuse one compiled cacheable statement per SQL text and handle.
 * @param {DatabaseSync} db @param {string} sql
 */
function preparedStatement(db, sql) {
  let cache = preparedStatements.get(db)
  let statement = cache?.get(sql)
  if (statement) {
    cache.delete(sql)
    cache.set(sql, statement)
    return statement
  }
  statement = db.prepare(sql)
  statement.setReadBigInts(true)
  if (isCacheableStatement(sql)) {
    if (!cache) preparedStatements.set(db, (cache = new Map()))
    if (cache.size >= MAX_PREPARED_STATEMENTS) cache.delete(cache.keys().next().value)
    cache.set(sql, statement)
  }
  return statement
}

/** @type {Map<string, object | null>} */
const rowPrototypes = new Map()
const MAX_ROW_PROTOTYPES = 512
/** @type {WeakMap<import("node:sqlite").StatementSync, { columns: string[], types: string[], prototype: object | null, schemaVersion: unknown }>} */
const statementMetadata = new WeakMap()

/** Compute and cache column metadata and the shared row prototype for a prepared statement.
 * @param {import("node:sqlite").StatementSync} statement
 * @param {unknown} [schemaVersion]
 */
function computeStatementMetadata(statement, schemaVersion) {
  const raw = statement.columns()
  const columns = raw.map(column => column.name)
  const types = raw.map(column => column.type ?? "")
  const prototype = columns.length ? rowPrototype(columns) : null
  const meta = { columns, types, prototype, schemaVersion }
  statementMetadata.set(statement, meta)
  return meta
}

/**
 * libSQL rows expose each column by name and by position. Keep the named
 * values as ordinary own properties and serve positions and length from one
 * shared prototype per column list. Rows then stay in V8's fast object shape,
 * which matters when a projection returns many columns.
 * Returns null when names would collide with each other or with positions.
 * @param {string[]} columns
 */
function rowPrototype(columns) {
  const key = columns.join("\u0000")
  let prototype = rowPrototypes.get(key)
  if (prototype !== undefined) return prototype
  const unique = new Set(columns).size === columns.length &&
    columns.every(name => name !== "length" && name !== "__proto__" && String(Number(name)) !== name)
  if (unique) {
    prototype = {}
    Object.defineProperty(prototype, "length", { value: columns.length })
    for (let index = 0; index < columns.length; index++) {
      const name = columns[index]
      Object.defineProperty(prototype, index, { get() { return this[name] } })
    }
  } else {
    prototype = null
  }
  if (rowPrototypes.size >= MAX_ROW_PROTOTYPES) rowPrototypes.delete(rowPrototypes.keys().next().value)
  rowPrototypes.set(key, prototype)
  return prototype
}

/** @param {DatabaseSync} db @param {string} sql */
function forgetPreparedStatement(db, sql) {
  preparedStatements.get(db)?.delete(sql)
}

/** @param {DatabaseSync} db */
function readDataVersion(db) {
  let statement = dataVersionStatements.get(db)
  if (!statement) {
    statement = db.prepare(`SELECT (SELECT data_version FROM pragma_data_version) AS data_version,
      total_changes() AS changes, (SELECT schema_version FROM pragma_schema_version) AS schema_version`)
    statement.setReturnArrays(true)
    statement.setReadBigInts(true)
    dataVersionStatements.set(db, statement)
  }
  return /** @type {unknown[]} */ (statement.get() ?? []).join(":")
}

/** @param {DatabaseSync} db */
function readExternalVersion(db) {
  let statement = externalVersionStatements.get(db)
  if (!statement) {
    statement = db.prepare("PRAGMA data_version")
    statement.setReturnArrays(true)
    statement.setReadBigInts(true)
    externalVersionStatements.set(db, statement)
  }
  const row = /** @type {unknown[] | undefined} */ (statement.get())
  return row ? String(row[0]) : "0"
}

/** @param {DatabaseSync} db */
function readSchemaVersion(db) {
  let statement = schemaVersionStatements.get(db)
  if (!statement) {
    statement = db.prepare("PRAGMA schema_version")
    statement.setReturnArrays(true)
    statement.setReadBigInts(true)
    schemaVersionStatements.set(db, statement)
  }
  const row = /** @type {unknown[] | undefined} */ (statement.get())
  return row ? row[0] : undefined
}

/** @param {DatabaseSync} db */
function getTotalChanges(db) {
  let stmt = totalChangesStatements.get(db)
  if (!stmt) {
    stmt = db.prepare("SELECT total_changes() AS count")
    stmt.setReturnArrays(true)
    stmt.setReadBigInts(true)
    totalChangesStatements.set(db, stmt)
  }
  return /** @type {unknown[] | undefined} */ (stmt.get())?.[0]
}

/** @param {DatabaseSync} db @param {InStatement} input @param {InArgs} [args] @param {boolean} [fileReadSnapshot] */
function execute(db, input, args = [], fileReadSnapshot = false) {
  const sql = typeof input === "string" ? input : input.sql
  const trackMutation = !isSideEffectFreeQuery(sql)
  if (trackMutation) bumpHandleEpoch(db)
  try {
  const values = typeof input === "string" ? args : input.args ?? []
  const bindings = Array.isArray(values)
    ? values.map(bind)
    : Object.fromEntries(Object.entries(values).map(([key, value]) => [key.replace(/^[@$:]/, ""), bind(value)]))
  const tag = typeof input === "string" ? undefined : scopedReads.get(input)
  const kind = tag
  const slots = kind ? scopedReadStatements.get(db) : undefined
  const cached = kind ? slots?.[kind] : undefined
  let statement = cached?.sql === sql ? cached.statement : undefined
  if (!statement) {
    if (kind) {
      statement = db.prepare(sql)
      statement.setReturnArrays(true)
      // Each query has one slot per handle. Changes in the scoped SQL replace it.
      if (slots) slots[kind] = { sql, statement }
      else scopedReadStatements.set(db, { [kind]: { sql, statement } })
    } else {
      statement = preparedStatement(db, sql)
    }
  }
  if (kind) {
    // Array mode avoids allocating object shapes that Object.setPrototypeOf
    // turns into dictionary mode. Use Object.create on the cached prototype.
    let rawRows = Array.isArray(bindings) ? statement.all(...bindings) : statement.all(bindings)
    const sv = readSchemaVersion(db)
    let meta = statementMetadata.get(statement) ?? computeStatementMetadata(statement, sv)
    const staleWidth = /** @type {unknown[][]} */ (/** @type {unknown} */ (rawRows)).some(values => values.length !== meta.columns.length)
    if (staleWidth || meta.schemaVersion !== sv) {
      statement = db.prepare(sql)
      statement.setReturnArrays(true)
      if (slots) slots[kind] = { sql, statement }
      else scopedReadStatements.set(db, { [kind]: { sql, statement } })
      rawRows = Array.isArray(bindings) ? statement.all(...bindings) : statement.all(bindings)
      meta = computeStatementMetadata(statement, readSchemaVersion(db))
    }
    const { columns, types, prototype } = meta
    const colCount = columns.length
    const rows = /** @type {Row[]} */ (new Array(rawRows.length))
    for (let r = 0; r < rawRows.length; r++) {
      const values = /** @type {SQLOutputValue[]} */ (/** @type {unknown} */ (rawRows[r]))
      if (prototype) {
        const row = Object.create(prototype)
        for (let index = 0; index < colCount; index++) {
          const val = values[index]
          row[columns[index]] = val instanceof Uint8Array ? new Uint8Array(val).buffer : val
        }
        rows[r] = row
      } else {
        const row = /** @type {Row} */ ({})
        Object.defineProperty(row, "length", { value: values.length })
        for (let index = 0; index < values.length; index++) {
          const rawValue = values[index]
          const value = rawValue instanceof Uint8Array ? new Uint8Array(rawValue).buffer : rawValue
          const name = columns[index]
          Object.defineProperty(row, index, { value })
          if (!Object.hasOwn(row, name)) {
            Object.defineProperty(row, name, { value, enumerable: true, configurable: true, writable: true })
          }
        }
        rows[r] = row
      }
    }
    return new ResultSetImpl(columns, types, rows, 0, undefined)
  }
  let meta = statementMetadata.get(statement)
  if (!meta) {
    const initialSv = (!db.isTransaction || fileReadSnapshot || /\bFROM\b/i.test(sql)) ? readSchemaVersion(db) : undefined
    meta = computeStatementMetadata(statement, initialSv)
    if (meta.columns.length) statement.setReturnArrays(true)
  }
  if (meta.columns.length) {
    let rawRows = Array.isArray(bindings) ? statement.all(...bindings) : statement.all(bindings)
    // Node.js 22 sizes rows before schema-change repreparation; recompile when widths or schema versions diverge.
    const currentSv = meta.schemaVersion !== undefined ? readSchemaVersion(db) : undefined
    const staleWidth = /** @type {unknown[][]} */ (/** @type {unknown} */ (rawRows)).some(values => values.length !== meta.columns.length)
    const staleSchema = staleWidth || currentSv !== meta.schemaVersion
    if (staleSchema && isPlainSelect(sql)) {
      forgetPreparedStatement(db, sql)
      statement = preparedStatement(db, sql)
      statement.setReturnArrays(true)
      rawRows = Array.isArray(bindings) ? statement.all(...bindings) : statement.all(bindings)
      meta = computeStatementMetadata(statement, currentSv !== undefined ? readSchemaVersion(db) : undefined)
    } else if (staleSchema) {
      meta = computeStatementMetadata(statement, currentSv)
    }
    const { columns, types, prototype } = meta
    const colCount = columns.length
    const rows = /** @type {Row[]} */ (new Array(rawRows.length))
    for (let r = 0; r < rawRows.length; r++) {
      const values = /** @type {SQLOutputValue[]} */ (/** @type {unknown} */ (rawRows[r]))
      if (prototype) {
        const row = Object.create(prototype)
        for (let index = 0; index < colCount; index++) row[columns[index]] = decode(values[index])
        rows[r] = row
      } else {
        const row = /** @type {Row} */ ({})
        Object.defineProperty(row, "length", { value: values.length })
        for (let index = 0; index < values.length; index++) {
          const value = decode(values[index])
          const name = columns[index]
          Object.defineProperty(row, index, { value })
          if (!Object.hasOwn(row, name)) {
            Object.defineProperty(row, name, { value, enumerable: true, configurable: true, writable: true })
          }
        }
        rows[r] = row
      }
    }
    return new ResultSetImpl(columns, types, rows, 0, undefined)
  }
  // Node exposes sqlite3_changes(), which keeps the last DML count across DDL and PRAGMA.
  const previous = getTotalChanges(db)
  const { changes, lastInsertRowid } = Array.isArray(bindings) ? statement.run(...bindings) : statement.run(bindings)
  const rowsAffected = previous === getTotalChanges(db) ? 0 : Number(changes)
  return new ResultSetImpl([], [], [], rowsAffected, BigInt(lastInsertRowid))
  } finally {
    if (trackMutation) bumpHandleEpoch(db)
  }
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

  // One writer handle is kept between transactions, like the read slot. SQLite
  // admits one writer at a time, so a pooled writer keeps its parsed schema,
  // compiled statements and page cache instead of reopening the file per command.
  /** @type {DatabaseSync | null} */
  let idleWriteHandle = null
  let writeSlotLeased = false
  /** @type {ReturnType<typeof globalThis.setTimeout> | undefined} */
  let writeIdleTimer = undefined
  const sharedCacheOwner = {}
  let nonTaskWriteEpoch = 0
  let mainHasLocalState = false
  /** @param {Array<InStatement | [string, InArgs?]>} statements */
  function markMainLocalStateFromBatch(statements) {
    if (mainHasLocalState) return
    for (const statement of statements) {
      const text = Array.isArray(statement) ? statement[0] : statement
      const sql = typeof text === "string" ? text : text.sql
      if (!isSideEffectFreeQuery(sql) && mayCreateMainLocalState(sql)) {
        mainHasLocalState = true
        return
      }
    }
  }

  function sharedPolicyToken() {
    if (memory || closed || writeSlotLeased) return undefined
    const mainEpoch = handleMutationEpochs.get(main) ?? 0
    if (idleWriteHandle) {
      const writerExt = sqliteOperation(() => readExternalVersion(idleWriteHandle))
      const key = ["shared", clientGeneration, nonTaskWriteEpoch, mainEpoch, writerExt].join(":")
      return { owner: sharedCacheOwner, token: key }
    }
    const mainExt = sqliteOperation(() => readExternalVersion(main))
    const key = ["shared0", clientGeneration, nonTaskWriteEpoch, mainEpoch, mainExt].join(":")
    return { owner: sharedCacheOwner, token: key }
  }

  function closeIdleWriteHandle() {
    nonTaskWriteEpoch += 1
    if (writeIdleTimer !== undefined) {
      globalThis.clearTimeout(writeIdleTimer)
      writeIdleTimer = undefined
    }
    if (idleWriteHandle) {
      try {
        idleWriteHandle.close()
      } finally {
        idleWriteHandle = null
      }
    }
  }

  function armWriteIdleEviction() {
    if (writeIdleTimer !== undefined) globalThis.clearTimeout(writeIdleTimer)
    writeIdleTimer = globalThis.setTimeout(() => {
      writeIdleTimer = undefined
      if (!writeSlotLeased) closeIdleWriteHandle()
    }, READ_IDLE_EVICT_MS)
    writeIdleTimer.unref?.()
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
        if (db.isTransaction) {
          db.exec("ROLLBACK")
          bumpHandleEpoch(db)
          nonTaskWriteEpoch += 1
        }
      }
    })
  }

  /**
   * Run a synchronous write on the pooled writer handle when available so main's
   * data_version stays aligned with pooled read handles across task/stats writes.
   * @template T
   * @param {(db: DatabaseSync, inspectSql: (sql: string) => void) => T} operation
   * @returns {T}
   */
  function onWriteSlot(operation) {
    idle()
    if (memory || writeSlotLeased) {
      return onMain(db => {
        nonTaskWriteEpoch += 1
        return operation(db, () => { nonTaskWriteEpoch += 1 })
      })
    }
    writeSlotLeased = true
    if (writeIdleTimer !== undefined) {
      globalThis.clearTimeout(writeIdleTimer)
      writeIdleTimer = undefined
    }
    /** @type {DatabaseSync} */
    let db
    if (idleWriteHandle) {
      db = idleWriteHandle
      idleWriteHandle = null
    } else {
      try {
        db = connect(readOnly, true)
      } catch (err) {
        writeSlotLeased = false
        throw err
      }
    }
    let reusable = true
    let touchedNonTask = false
    /** @param {string} sql */
    const inspectSql = sql => {
      if (!rowStatementKeywords.has(leadingKeyword(sql))) {
        reusable = false
        if (!touchedNonTask) {
          touchedNonTask = true
          nonTaskWriteEpoch += 1
        }
      } else if (!isSideEffectFreeQuery(sql) && !isPureTaskOrStatsWrite(sql) && !touchedNonTask) {
        touchedNonTask = true
        nonTaskWriteEpoch += 1
      }
    }
    return sqliteOperation(() => {
      try {
        return operation(db, inspectSql)
      } finally {
        try {
          if (db.isTransaction) {
            db.exec("ROLLBACK")
            bumpHandleEpoch(db)
            if (touchedNonTask) nonTaskWriteEpoch += 1
          }
        } finally {
          writeSlotLeased = false
          if (closed || !reusable || db.isTransaction) {
            nonTaskWriteEpoch += 1
            db.close()
          } else {
            idleWriteHandle = db
            armWriteIdleEviction()
          }
          admitWaitingReads()
        }
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
    const canUseWriteSlot =
      mode === "write" &&
      !migration &&
      !memory &&
      !mainHasLocalState &&
      statements.length > 0 &&
      statements.every(statement => {
        const text = Array.isArray(statement) ? statement[0] : statement
        const sql = typeof text === "string" ? text : text.sql
        return isSideEffectFreeQuery(sql) || isPureTaskOrStatsWrite(sql)
      })
    if (canUseWriteSlot) {
      return onWriteSlot((db, inspectSql) => {
        for (const statement of statements) {
          const text = Array.isArray(statement) ? statement[0] : statement
          inspectSql(typeof text === "string" ? text : text.sql)
        }
        begin(db, "write")
        onAcquired?.()
        const results = executeBatch(db, statements)
        db.exec("COMMIT")
        onAcquired?.()
        return results
      })
    }
    return onMain(db => {
      if (mode === "write" || migration) nonTaskWriteEpoch += 1
      markMainLocalStateFromBatch(statements)
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
          if (db.isTransaction) {
            db.exec("ROLLBACK")
            bumpHandleEpoch(db)
          }
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
    const sql = typeof statement === "string" ? statement : statement.sql
    if (!signal && isSideEffectFreeQuery(sql)) {
      return onMain(db => execute(db, statement, args))
    }
    return retryBusyOperation(
      () => onMain(db => {
        if (!isSideEffectFreeQuery(sql)) {
          nonTaskWriteEpoch += 1
          if (!mainHasLocalState && mayCreateMainLocalState(sql)) mainHasLocalState = true
        }
        return execute(db, statement, args)
      }),
      () => false,
      signal,
    )
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
    let leasedFromWriteSlot = false
    // Arbitrary SQL may leave connection state behind; such a writer is not reused.
    let reusable = true
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
    } else if (!writeSlotLeased) {
      writeSlotLeased = true
      leasedFromWriteSlot = true
      if (writeIdleTimer !== undefined) {
        globalThis.clearTimeout(writeIdleTimer)
        writeIdleTimer = undefined
      }
      if (idleWriteHandle) {
        db = idleWriteHandle
        idleWriteHandle = null
      } else {
        try {
          db = connect(readOnly, true)
        } catch (err) {
          writeSlotLeased = false
          throw err
        }
      }
    } else {
      if (!useReadPool) nonTaskWriteEpoch += 1
      db = connect(readOnly, true)
    }

    let active = true
    let restoreReadOnly = false
    let touchedNonTask = !useReadPool && !leasedFromWriteSlot
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
        if (db.isTransaction) {
          db.exec("ROLLBACK")
          bumpHandleEpoch(db)
          if (touchedNonTask) nonTaskWriteEpoch += 1
        }
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
          } else if (leasedFromWriteSlot) {
            writeSlotLeased = false
            if (closed || !reusable || db.isTransaction) {
              db.close()
            } else {
              idleWriteHandle = db
              armWriteIdleEviction()
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

    // A read snapshot keeps its view while it only runs queries. Any other
    // statement may end or restart it, and a writer's own changes alter it.
    let generation = 0
    let snapshotPinned = mode === "write"
    /** @type {object | undefined} */
    let cachedTxOwner = undefined
    /** @type {string | undefined} */
    let cachedTxToken = undefined
    let cachedTxGen = -1
    let cachedTxEpoch = -1
    /** @type {unknown} */
    let cachedGrantRev = undefined
    let cachedGrantGen = -1
    let cachedGrantEpoch = -1
    /** @param {InStatement | [string, InArgs?]} statement */
    const advance = statement => {
      const text = Array.isArray(statement) ? statement[0] : statement
      const sql = typeof text === "string" ? text : text.sql
      const keyword = leadingKeyword(sql)
      if (useReadPool ? !readSnapshotKeywords.has(keyword) : !isSideEffectFreeQuery(sql)) {
        generation += 1
        bumpHandleEpoch(db)
        if (!useReadPool && !isPureTaskOrStatsWrite(sql)) {
          touchedNonTask = true
          nonTaskWriteEpoch += 1
        }
      }
      if (!rowStatementKeywords.has(keyword)) reusable = false
    }
    /** Pin a fresh read transaction snapshot inside a quiescent reference-version sandwich. */
    function ensureReadSnapshotPinned() {
      if (!useReadPool || snapshotPinned) return
      const epoch = handleMutationEpochs.get(db) ?? 0
      const refDb = !writeSlotLeased && !closed ? (idleWriteHandle ?? main) : null
      if (refDb && !refDb.isTransaction && generation === 0) {
        const isShared0 = idleWriteHandle === null
        const nt1 = nonTaskWriteEpoch
        const me1 = handleMutationEpochs.get(main) ?? 0
        const v1 = sqliteOperation(() => readExternalVersion(refDb))
        sqliteOperation(() => readExternalVersion(db))
        snapshotPinned = true
        if (
          !writeSlotLeased &&
          !closed &&
          !refDb.isTransaction &&
          (idleWriteHandle ?? main) === refDb &&
          (idleWriteHandle === null) === isShared0 &&
          nt1 === nonTaskWriteEpoch &&
          me1 === (handleMutationEpochs.get(main) ?? 0) &&
          epoch === (handleMutationEpochs.get(db) ?? 0)
        ) {
          const v2 = sqliteOperation(() => readExternalVersion(refDb))
          if (v1 === v2) {
            const prefix = isShared0 ? "shared0" : "shared"
            const key = [prefix, clientGeneration, nt1, me1, v1].join(":")
            cachedTxGen = generation
            cachedTxEpoch = epoch
            cachedTxOwner = sharedCacheOwner
            cachedTxToken = key
            return
          }
        }
        return
      }
      sqliteOperation(() => readExternalVersion(db))
      snapshotPinned = true
    }
    const result = {
      get closed() { return !active || !db.isTransaction },
      /** @param {InStatement} statement @param {InArgs} [args] */
      async execute(statement, args) {
        assertActive()
        const sql = typeof statement === "string" ? statement : statement.sql
        if (useReadPool && !snapshotPinned && readSnapshotKeywords.has(leadingKeyword(sql))) {
          ensureReadSnapshotPinned()
        }
        advance(statement)
        try {
          const out = sqliteOperation(() => execute(db, statement, args, useReadPool))
          snapshotPinned = true
          return out
        } finally { advance(statement) }
      },
      async batch(statements) {
        assertActive()
        if (useReadPool && !snapshotPinned && statements.every(statement => {
          const text = Array.isArray(statement) ? statement[0] : statement
          return readSnapshotKeywords.has(leadingKeyword(typeof text === "string" ? text : text.sql))
        })) {
          ensureReadSnapshotPinned()
        }
        for (const statement of statements) advance(statement)
        try {
          const out = executeBatch(db, statements, useReadPool)
          snapshotPinned = true
          return out
        } finally { for (const statement of statements) advance(statement) }
      },
      async executeMultiple(sql) {
        assertActive()
        generation += 1
        bumpHandleEpoch(db)
        if (!useReadPool) {
          touchedNonTask = true
          nonTaskWriteEpoch += 1
        }
        reusable = false
        snapshotPinned = mode === "write"
        cachedTxOwner = undefined
        cachedTxToken = undefined
        cachedGrantRev = undefined
        try { sqliteOperation(() => db.exec(sql)) } finally { generation += 1; bumpHandleEpoch(db); cachedTxOwner = undefined; cachedTxToken = undefined; cachedGrantRev = undefined }
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
        if (useReadPool && !snapshotPinned) ensureReadSnapshotPinned()
        const epoch = handleMutationEpochs.get(db) ?? 0
        if (snapshotPinned && cachedGrantRev !== undefined && cachedGrantGen === generation && cachedGrantEpoch === epoch) {
          return cachedGrantRev
        }
        const rev = sqliteOperation(() => readGrantRevision(db)) ?? null
        snapshotPinned = true
        cachedGrantGen = generation
        cachedGrantEpoch = epoch
        cachedGrantRev = rev
        return rev
      },
    })
    if (!memory && (mode === "read" || mode === "write")) localFileTransactions.set(result, {
      execute: result.execute,
      batch: result.batch,
      executeMultiple: result.executeMultiple,
      commit: result.commit,
      rollback: result.rollback,
      close: result.close,
      db,
      mode,
      generation: () => generation,
      cacheToken: () => {
        if (mode === "read" && !snapshotPinned) ensureReadSnapshotPinned()
        const epoch = handleMutationEpochs.get(db) ?? 0
        if (snapshotPinned && cachedTxToken !== undefined && cachedTxOwner !== undefined && cachedTxGen === generation && cachedTxEpoch === epoch) {
          return { owner: cachedTxOwner, token: cachedTxToken }
        }
        if (mode === "write" && leasedFromWriteSlot && !touchedNonTask && !closed) {
          const writerExt = sqliteOperation(() => readExternalVersion(db))
          snapshotPinned = true
          const mainEpoch = handleMutationEpochs.get(main) ?? 0
          const key = ["shared", clientGeneration, nonTaskWriteEpoch, mainEpoch, writerExt].join(":")
          cachedTxGen = generation
          cachedTxEpoch = epoch
          cachedTxOwner = sharedCacheOwner
          cachedTxToken = key
          return { owner: sharedCacheOwner, token: key }
        }
        const dv = sqliteOperation(() => readDataVersion(db))
        snapshotPinned = true
        const key = ["v", clientGeneration, epoch, dv].join(":")
        cachedTxGen = generation
        cachedTxEpoch = epoch
        cachedTxOwner = db
        cachedTxToken = key
        return { owner: db, token: key }
      },
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
        try {
          closeIdleWriteHandle()
        } finally {
          main.close()
        }
      }
    }
  }

  /** @type {Client} */
  const client = {
    protocol: "file",
    get closed() { return closed },
    /** @param {InStatement} statement @param {InArgs} [args] */
    async execute(statement, args) { return executeStatementWithRetry(statement, args, undefined) },
    async executeMultiple(sql) { onMain(db => { mainHasLocalState = true; bumpHandleEpoch(db); nonTaskWriteEpoch += 1; try { db.exec(sql) } finally { bumpHandleEpoch(db); nonTaskWriteEpoch += 1 } }) },
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
      mainHasLocalState = false
      nonTaskWriteEpoch += 1
      cachedMainGrantToken = undefined
      cachedMainGrantRev = undefined
      main = openMain()
      closed = false
    },
  }
  /** @type {string | undefined} */
  let cachedMainGrantToken = undefined
  /** @type {unknown} */
  let cachedMainGrantRev = undefined
  localWriters.set(client, {
    run: steps => onMain(db => {
      nonTaskWriteEpoch += 1
      begin(db, "write")
      const program = steps()
      let state = program.next()
      while (!state.done) {
        markMainLocalStateFromBatch(state.value)
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
      nonTaskWriteEpoch += 1
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
    // A reconnect starts a new connection whose counters can repeat earlier values.
    generation: () => clientGeneration + ":" + onMain(readDataVersion),
    cacheToken: () => onMain(db => {
      const shared = sharedPolicyToken()
      if (shared) return shared
      const key = ["v", clientGeneration, handleMutationEpochs.get(db) ?? 0, readDataVersion(db)].join(":")
      return { owner: db, token: key }
    }),
  })
  localGrantRevisionReaders.set(client, {
    execute: client.execute,
    read: () => onMain(db => {
      const shared = sharedPolicyToken()
      if (shared && cachedMainGrantRev !== undefined && cachedMainGrantToken === shared.token) {
        return cachedMainGrantRev
      }
      const rev = readGrantRevision(db)
      if (shared) {
        cachedMainGrantToken = shared.token
        cachedMainGrantRev = rev
      } else {
        cachedMainGrantToken = undefined
        cachedMainGrantRev = undefined
      }
      return rev
    }),
  })
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
