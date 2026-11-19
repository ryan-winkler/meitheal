import type { Client, InArgs, InStatement, Transaction } from "@libsql/client"
import { acquireWriteTransaction } from "../../../../scripts/database-client.mjs"
import { databaseRevision, getBoardGrantPath, readBoardGrantRevision } from "../../../../scripts/board-grant-journal.mjs"
import { boardGrantStillCurrent, currentBoardGrantRevision } from "./board-grant-fence"

export class ContinuityLockedError extends Error {
  readonly status = 503
  constructor() {
    super("Current installation continuity is unavailable. Governed work remains locked until the current operator checkpoint is verified.")
    this.name = "ContinuityLockedError"
  }
}

const guardedClients = new WeakSet<Client>()
const clientGuards = new WeakMap<Client, Client>()
const guardSources = new WeakMap<object, Client>()

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
    const check = async () => {
      // A read/deferred transaction can retain an old WAL snapshot after an
      // authority writer commits. Its old epoch plus an unpublished old marker
      // is not evidence that the live installation still admits this result.
      const live = mode === "read" || mode === "deferred" ? client : raw
      if (await boardGrantStillCurrent(raw, revision!, marker) &&
        (live === raw || await boardGrantStillCurrent(live, revision!, marker))) return
      const current = await databaseRevision(live)
      if (current && await readBoardGrantRevision(marker) === current) {
        const { rows: [household] } = await live.execute("SELECT state FROM task_boards WHERE id = 'household'")
        const error = new Error(household?.state === "retired"
          ? "Household Board is deleted. Restore it from Boards to resume shared work."
          : "Current permissions changed. Retry the operation with current authority.")
        Object.assign(error, { status: 409 })
        throw error
      }
      throw new ContinuityLockedError()
    }
    try { await check() } catch (error) { raw.close(); settle(); throw error }
    return new Proxy(raw, {
      get(target, property) {
        if (property === Symbol.for("meitheal.boardGrantClient")) return raw
        if (property === "execute" || property === "batch" || property === "executeMultiple") {
          return async (...args: unknown[]) => {
            await check()
            const operation = Reflect.get(target, property) as (...args: unknown[]) => Promise<unknown>
            const result = await operation.apply(target, args)
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
        if (!/^\s*(SELECT|EXPLAIN)\b/i.test(typeof statement === "string" ? statement : statement.sql)) {
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
  return guarded
}
