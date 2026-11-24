import type { Client, InArgs, InStatement, Transaction } from "@libsql/client"
import { acquireWriteTransaction, isLocalFileClient, isLocalFileWriter, isLocalReadSnapshot, isSideEffectFreeQuery, localSnapshotGeneration, registerReaderCacheSource } from "../../../../scripts/database-client.mjs"
import { databaseRevision, getBoardGrantPath, readBoardGrantRevision } from "../../../../scripts/board-grant-journal.mjs"
import { principalProof, registerFencedScopeReader, validateBoardOperations } from "../board-scope"
import { boardGrantStillCurrent, currentBoardGrantRevision } from "./board-grant-fence"

export class ContinuityLockedError extends Error {
  readonly status = 503
  readonly errorCode = "continuity_locked"
  constructor() {
    super("Current installation continuity is unavailable. Governed work remains locked until the current operator checkpoint is verified.")
    this.name = "ContinuityLockedError"
  }
}

const guardedClients = new WeakSet<Client>()
const clientGuards = new WeakMap<Client, Client>()
const guardSources = new WeakMap<object, Client>()
const fencedReadSnapshots = new WeakSet<Transaction>()
const fencedLocalWriters = new WeakMap<Transaction, Transaction>()
const singleReadRunners = new WeakMap<Client, <T>(
  authorizeSnapshot: (raw: Transaction, revision: string) => Promise<void>,
  runOnSnapshot: (raw: Transaction) => Promise<T>,
  onLockedBeforeAdmission: () => Promise<void>,
) => Promise<T>>()

export function isFencedReadSnapshot(transaction: Transaction): boolean {
  return fencedReadSnapshots.has(transaction)
}

export function isFencedLocalWriter(transaction: Transaction): boolean {
  const raw = fencedLocalWriters.get(transaction)
  return raw !== undefined && isLocalFileWriter(raw)
}

export function isFencedLocalFileClient(guarded: Client): boolean {
  const raw = guardSources.get(guarded)
  return raw !== undefined && isLocalFileClient(raw)
}

/** Return true when the client passes through a continuity guard wrapper. */
export function isGuardedContinuityClient(client: object): boolean {
  return guardSources.has(client) || (
    Symbol.for("meitheal.boardGrantClient") in client &&
    (client as Record<symbol, unknown>)[Symbol.for("meitheal.boardGrantClient")] !== client
  )
}

export function executeFencedSingleRead<T>(
  guarded: Client,
  authorizeSnapshot: (raw: Transaction, revision: string) => Promise<void>,
  runOnSnapshot: (raw: Transaction) => Promise<T>,
  onLockedBeforeAdmission: () => Promise<void>,
): Promise<T> | undefined {
  if (!isFencedLocalFileClient(guarded)) return undefined
  const runner = singleReadRunners.get(guarded)
  return runner ? runner(authorizeSnapshot, runOnSnapshot, onLockedBeforeAdmission) : undefined
}

async function staleOrLockedError(live: Pick<Client, "execute">, marker: string): Promise<Error> {
  const current = await databaseRevision(live)
  if (current && await readBoardGrantRevision(marker) === current) {
    const error = new Error("Current permissions changed. Retry the operation with current authority.")
    return Object.assign(error, { status: 409, errorCode: "stale" })
  }
  return new ContinuityLockedError()
}

/** Only controlled journal writers and synthetic fixtures may bypass an actual guard.
 * Do not unwrap transparent/adversarial proxies: their transaction barriers remain authoritative. */
export function unwrapRegisteredContinuityClient<T extends object>(client: T): T {
  return (guardSources.get(client) ?? client) as T
}

/** Guard repository and worker SQL, including the actual mutation commit boundary. */
export function guardClientContinuity(client: Client): Client {
  if (guardedClients.has(client)) return client
  const existing = clientGuards.get(client)
  if (existing) return existing
  const marker = getBoardGrantPath(client)
  const source = (client as unknown as Record<symbol, Client>)[Symbol.for("meitheal.boardGrantClient")] ?? client
  let writerTail = Promise.resolve()

  async function writerLease() {
    let release!: () => void
    const previous = writerTail
    writerTail = new Promise<void>(resolve => { release = resolve })
    await previous
    return release
  }

  async function transaction(mode?: "read" | "write" | "deferred"): Promise<Transaction> {
    const release = mode === "write" || mode === undefined ? await writerLease() : () => {}
    let released = false
    const settle = () => { if (!released) { released = true; release() } }
    let revision: string | null
    let raw: Transaction
    try {
      revision = await currentBoardGrantRevision(client, marker)
      if (!revision) throw new ContinuityLockedError()
      raw = mode === "write" || mode === undefined ? await acquireWriteTransaction(client) : await (client.transaction as (mode?: "read" | "write" | "deferred") => Promise<Transaction>)(mode)
    } catch (error) { settle(); throw error }
    const pinnedLocalRead = mode === "read" && isLocalReadSnapshot(raw)
    let pinnedEpochChecked = false
    let verifiedWriterGen: string | undefined
    const check = async () => {
      // A read/deferred transaction can retain an old WAL snapshot after an
      // authority writer commits. Its old epoch plus an unpublished old marker
      // is not evidence that the live installation still admits this result.
      const live = mode === "read" || mode === "deferred" ? client : raw
      // For an immutable local snapshot, compare its stored epoch before the
      // fresh live marker and epoch check.
      const immutableSnapshot = pinnedLocalRead && isLocalReadSnapshot(raw)
      let snapshotCurrent: boolean
      if (immutableSnapshot) {
        snapshotCurrent = (!raw.closed && pinnedEpochChecked) || await databaseRevision(raw) === revision
        pinnedEpochChecked = snapshotCurrent
      } else if (mode === "write" && isLocalFileWriter(raw) && !raw.closed) {
        const markerOk = await readBoardGrantRevision(marker) === revision
        const writerGen = markerOk ? localSnapshotGeneration(raw) : undefined
        if (markerOk && writerGen !== undefined && verifiedWriterGen === writerGen) {
          snapshotCurrent = true
        } else {
          snapshotCurrent = markerOk && await databaseRevision(raw) === revision
          verifiedWriterGen = snapshotCurrent ? writerGen : undefined
        }
      } else {
        snapshotCurrent = await boardGrantStillCurrent(raw, revision!, marker)
      }
      // The initial SELECT pins an immutable SQLite snapshot. The live marker
      // and live database epoch still have to agree at every boundary.
      if (snapshotCurrent && (live === raw || await boardGrantStillCurrent(live, revision!, marker))) return
      throw await staleOrLockedError(live, marker)
    }
    try { await check() } catch (error) { raw.close(); settle(); throw error }
    const guarded = new Proxy(raw, {
      get(target, property) {
        // An already guarded transaction may expose this non-configurable
        // descriptor through another authorization proxy. Preserve its actual
        // value rather than substituting that proxy (which violates JS Proxy
        // invariants); both resolve to the same pinned transaction context.
        if (property === Symbol.for("meitheal.boardGrantClient")) return Reflect.get(raw, property) ?? raw
        if (property === "execute" || property === "batch" || property === "executeMultiple") {
          return async (...args: unknown[]) => {
            await check()
            const operation = Reflect.get(target, property) as (...args: unknown[]) => Promise<unknown>
            // Multiple statements are allowed on this continuity adapter.
            // Discard the pinned proof if any can replace its transaction.
            let result: unknown
            try { result = await operation.apply(target, args) }
            finally {
              if (property === "executeMultiple") {
                pinnedEpochChecked = false
                verifiedWriterGen = undefined
              }
            }
            await check()
            return result
          }
        }
        if (property === "commit") return async () => {
          try { await check(); await raw.commit() }
          catch (error) { raw.close(); throw error }
          finally { settle() }
        }
        if (property === "close") return () => { try { raw.close() } finally { settle() } }
        if (property === "rollback") return async () => { try { await raw.rollback() } finally { settle() } }
        const value = Reflect.get(target, property)
        return typeof value === "function" ? value.bind(target) : value
      },
    })
    registerFencedScopeReader(guarded, async (scope, operations) => {
      // Scope validation begins with the same marker and scoped epoch. Withhold
      // even a denial until the guarded transaction has checked live continuity.
      const result = await validateBoardOperations(scope, raw, operations)
      await check()
      if (!result.ok) return result
      return principalProof(scope.principal) ? result : { ok: false, errorCode: "stale" }
    })
    if (pinnedLocalRead) fencedReadSnapshots.add(guarded)
    if (isLocalFileWriter(raw)) fencedLocalWriters.set(guarded, raw)
    registerReaderCacheSource(guarded, raw)
    return guarded
  }

  async function single<T>(operation: (tx: Transaction) => Promise<T>, mode: "read" | "write" | "deferred" = "write"): Promise<T> {
    const tx = await transaction(mode)
    try {
      const result = await operation(tx)
      await tx.commit()
      return result
    } finally { tx.close() }
  }

  const guarded = new Proxy(client, {
    get(target, property) {
      if (property === Symbol.for("meitheal.boardGrantClient")) return source
      if (property === "transaction") return transaction
      if (property === "execute") return async (statement: InStatement, args?: InArgs) => {
        const normalized = typeof statement === "string" && args !== undefined ? { sql: statement, args } : statement
        const rawSql = typeof statement === "string" ? statement : statement.sql
        if (!isSideEffectFreeQuery(rawSql) && !/^\s*EXPLAIN\b/i.test(rawSql)) {
          return single(tx => tx.execute(normalized))
        }
        // One SQLite SELECT is already an atomic snapshot. Keep independent reads
        // independent, then withhold its result if authority changed during it.
        const revision = await currentBoardGrantRevision(client, marker)
        if (!revision) throw new ContinuityLockedError()
        const result = await client.execute(normalized)
        if (!await boardGrantStillCurrent(client, revision, marker)) throw new ContinuityLockedError()
        return result
      }
      if (property === "batch") return (statements: InStatement[], mode: "read" | "write" | "deferred" = "write") => single(tx => tx.batch(statements), mode)
      if (property === "executeMultiple") return (sql: string) => single(tx => tx.executeMultiple(sql))
      if (property === "migrate") throw new Error("Governed repository clients cannot run migrations")
      const value = Reflect.get(target, property)
      return typeof value === "function" ? value.bind(target) : value
    },
  })
  guardedClients.add(guarded)
  clientGuards.set(client, guarded)
  guardSources.set(guarded, client)
  singleReadRunners.set(guarded, async (authorizeSnapshot, runOnSnapshot, onLockedBeforeAdmission) => {
    let revision: string | null
    let raw: Transaction
    try {
      revision = await currentBoardGrantRevision(client, marker)
      if (!revision) throw new ContinuityLockedError()
      raw = await (client.transaction as (mode?: "read" | "write" | "deferred") => Promise<Transaction>)("read")
    } catch (error) {
      if (error instanceof ContinuityLockedError) await onLockedBeforeAdmission()
      throw error
    }
    try {
      const snapshotCurrent = isLocalReadSnapshot(raw)
        ? await databaseRevision(raw) === revision
        : await boardGrantStillCurrent(raw, revision, marker)
      if (!snapshotCurrent || !await boardGrantStillCurrent(client, revision, marker)) {
        throw await staleOrLockedError(client, marker)
      }
      await authorizeSnapshot(raw, revision)
      const result = await runOnSnapshot(raw)
      await raw.commit()
      if (!await boardGrantStillCurrent(client, revision, marker)) {
        throw await staleOrLockedError(client, marker)
      }
      return result
    } finally { raw.close() }
  })
  registerFencedScopeReader(guarded, async (scope, operations) => {
    // BoardAccessService binds the initial authority read to the scoped epoch.
    const result = await validateBoardOperations(scope, client, operations)
    if (!result.ok) return result
    if (!await boardGrantStillCurrent(client, scope.authorityRevision, marker) || !principalProof(scope.principal)) {
      return { ok: false, errorCode: "stale" }
    }
    return result
  })
  registerReaderCacheSource(guarded, client)
  return guarded
}
