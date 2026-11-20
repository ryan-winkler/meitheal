import type { Client, InArgs, InStatement, Transaction } from "@libsql/client"
import { acquireWriteTransaction } from "../../../../scripts/database-client.mjs"
import { principalProof, requireBoardScope, scopeAssignedTo, scopeLimits, validateBoardOperations, validateBoardScope, type BoardScope, type WorkOperation } from "../board-scope"
import { boardGrantStillCurrent, currentBoardGrantRevision } from "./board-grant-fence"
import { ContinuityLockedError, guardClientContinuity, isFencedLocalFileClient, isFencedLocalWriter, isFencedReadSnapshot } from "./continuity-client"
import { validateBoardPlacement } from "../board-access-service"
import { ownedPlanning, taskField, taskOwnedBy } from "./board-storage"
import { sql, joinSql, sourceSql } from "./sql-fragment"

type WriterIntentResolver = (reader: Pick<Client, "execute">) => Promise<readonly WorkOperation[]>
type WriterCheck = (reader: Pick<Client, "execute">) => Promise<void>
type OperationClient = { source: Client, scope: BoardScope, operations: readonly WorkOperation[], targets: readonly string[], intents: readonly WriterIntentResolver[], checks: readonly WriterCheck[], beginPrivateWrite: () => Promise<Transaction> }
const operationClients = new WeakMap<object, OperationClient>()
const admittedReads = new WeakMap<object, { scope: BoardScope, live: Client, snapshot: Transaction }>()
const admittedWriters = new WeakMap<object, { scope: BoardScope, require: (operation: WorkOperation) => Promise<void>, check: (validate: () => Promise<void>) => Promise<void> }>()

export class BoardOperationError extends Error {
  readonly status: number
  constructor(readonly errorCode: "unavailable" | "denied" | "continuity_locked" | "stale") {
    super(errorCode === "continuity_locked" ? "Current work authority is unavailable" : "This work operation is unavailable")
    this.name = "BoardOperationError"
    this.status = errorCode === "continuity_locked" ? 503 : errorCode === "stale" ? 409 : errorCode === "denied" ? 403 : 404
  }
}

/**
 * Authorization only: this adapter never inspects or changes SQL. Each domain
 * method chooses its operation explicitly. Ownership still belongs in every
 * query, and record/assignment guards still belong in the command writer.
 */
export function boardOperationClient(client: Client, scope: BoardScope, operation: WorkOperation, taskIds: readonly string[] = [],
  writerIntents?: WriterIntentResolver,
  writerCheck?: WriterCheck,
): Client {
  requireBoardScope(scope)
  // Flatten only adapters minted here for this exact scope. External proxies and
  // the independent continuity wrapper remain authoritative and are never unwrapped.
  const previous = operationClients.get(client)
  const prior = previous?.scope === scope ? previous : undefined
  const source = prior?.source ?? client
  const operations = [...(prior?.operations ?? []), operation].filter((item, index, all) =>
    all.findIndex(candidate => candidate.resource === item.resource && candidate.action === item.action) === index)
  const intents = [...(prior?.intents ?? []), ...(writerIntents ? [writerIntents] : [])]
  const checks = [...(prior?.checks ?? []), ...(writerCheck ? [writerCheck] : [])]
  const db = guardClientContinuity(source)
  const write = operations.some(item => item.action !== "read" && item.action !== "search")
  const targets = [...new Set([...(prior?.targets ?? []), ...taskIds])]
  const actorStillCurrent = () => Boolean(principalProof(scope.principal)) &&
    scopeLimits(scope).every(limit => Boolean(principalProof(limit.principal)))
  const check = async (reader: Pick<Client, "execute">, requestedOperations: readonly WorkOperation[] = operations) => {
    const result = await validateBoardOperations(scope, reader, requestedOperations)
    if (!result.ok) throw new BoardOperationError(result.errorCode)
  }
  const checkTargets = async (reader: Pick<Client, "execute">) => {
    if (!targets.length) return
    const assigned = write ? scopeAssignedTo(scope) : undefined
    const { rows } = await reader.execute(sql`SELECT id, task_kind, ${taskField(scope, "area_id")} AS area_id,
      ${taskField(scope, "project_id")} AS project_id FROM tasks WHERE ${taskOwnedBy(scope)}
      AND id IN (${joinSql(targets.map(id => sql`${id}`))})
      ${assigned === undefined ? sourceSql("") : sql`AND assigned_to = ${assigned}`}`)
    if (rows.length !== targets.length) throw new BoardOperationError("unavailable")
    for (const row of rows) {
      let areaId = typeof row.area_id === "string" ? row.area_id : null
      const projectId = typeof row.project_id === "string" ? row.project_id : null
      if (projectId) {
        const { rows: [project] } = await reader.execute(sql`SELECT area_id FROM projects WHERE id = ${projectId} AND ${ownedPlanning(scope, "projects")}`)
        if (typeof project?.area_id === "string") areaId = project.area_id
      }
      if (!await validateBoardPlacement(scope, reader, { areaId, projectId })) throw new BoardOperationError("unavailable")
    }
  }

  async function transaction(
    mode: "read" | "write" | "deferred" = write ? "write" : "read",
    holdResult = false,
  ): Promise<Transaction> {
    // A read entitlement cannot be used to acquire a writable transaction.
    if (!write && mode !== "read") throw new BoardOperationError("denied")
    // A private native reader can authorize on its actual snapshot before any
    // task query. Other clients retain the live check before opening a lease.
    const verifyOnSnapshot = mode === "read" && holdResult && isFencedLocalFileClient(db)
    if (!verifyOnSnapshot || !actorStillCurrent()) await check(db)
    let tx: Transaction
    try {
      tx = await db.transaction(mode)
    } catch (error) {
      if (verifyOnSnapshot && error instanceof ContinuityLockedError) await check(db)
      throw error
    }
    const requiredIntents = [...operations]
    const requiredChecks: Array<() => Promise<void>> = []
    const requireIntent = async (intent: WorkOperation) => {
      const allowed = await validateBoardScope(scope, tx, intent)
      if (!allowed.ok) throw new BoardOperationError(allowed.errorCode)
      if (!requiredIntents.some(item => item.resource === intent.resource && item.action === intent.action)) requiredIntents.push(intent)
    }
    try {
      if (verifyOnSnapshot && !isFencedReadSnapshot(tx)) await check(db)
      await check(tx)
      await checkTargets(tx)
      if (write) for (const resolve of intents) for (const intent of await resolve(tx)) {
        await requireIntent(intent)
      }
      if (mode !== "read") for (const validate of checks) await validate(tx)
    } catch (error) { tx.close(); throw error }
    // Admission already proved every operation on this immutable SQLite snapshot.
    // Its own guard still checks snapshot and live continuity at each operation.
    const reuseSnapshotAuthority = mode === "read" && isFencedReadSnapshot(tx)
    const withholdUntilCommit = reuseSnapshotAuthority && holdResult
    // A private file-backed writer excludes other SQLite writers and keeps its
    // data private until a fresh check of all effects on the actual commit.
    // Token and provider policy still revalidate on each use.
    const privateWriter = mode === "write" && holdResult &&
      (scope.principal.kind === "ha_user" || scope.principal.kind === "local_operator") && isFencedLocalWriter(tx)
    async function checkSnapshot(requested: readonly WorkOperation[] = operations) {
      if (!reuseSnapshotAuthority && !(privateWriter && isFencedLocalWriter(tx))) return check(tx, requested)
      if (!actorStillCurrent()) {
        throw new BoardOperationError("stale")
      }
    }
    const guarded = new Proxy(tx, {
      get(target, property) {
        if (property === "execute" || property === "batch") return async (...args: unknown[]) => {
          await checkSnapshot()
          const method = Reflect.get(target, property) as (...args: unknown[]) => Promise<unknown>
          const result = await method.apply(target, args)
          await checkSnapshot()
          if (!withholdUntilCommit && (mode === "read" || mode === "deferred")) { await check(db); await checkTargets(db) }
          return result
        }
        if (property === "commit") return async () => {
          if (privateWriter) await check(tx, requiredIntents)
          else await checkSnapshot(requiredIntents)
          if (mode !== "read") for (const validate of checks) await validate(tx)
          for (const validate of requiredChecks) await validate()
          if (!withholdUntilCommit && (mode === "read" || mode === "deferred")) { await check(db); await checkTargets(db) }
          await tx.commit()
        }
        if (property === "executeMultiple" || property === "migrate") throw new BoardOperationError("denied")
        const value = Reflect.get(target, property)
        return typeof value === "function" ? value.bind(target) : value
      },
    })
    if (mode === "read") admittedReads.set(guarded, { scope, live: db, snapshot: tx })
    else if (mode === "write") admittedWriters.set(guarded, { scope, require: requireIntent, check: async validate => { await validate(); requiredChecks.push(validate) } })
    return guarded
  }

  async function single<T>(run: (tx: Transaction) => Promise<T>, mode?: "read" | "write" | "deferred"): Promise<T> {
    const tx = await transaction(mode, true)
    try {
      const result = await run(tx)
      await tx.commit()
      // A private single read has not exposed rows to any caller. Recheck the
      // full live scope and record placement here before releasing the result.
      // A lost authority after a write stays an uncertain outcome.
      const admitted = admittedReads.get(tx)
      if (admitted && isFencedReadSnapshot(admitted.snapshot)) await checkTargets(db)
      await check(db)
      return result
    } finally { tx.close() }
  }

  const guarded = new Proxy(db, {
    get(target, property) {
      if (property === "transaction") return (mode?: "read" | "write" | "deferred") => transaction(mode)
      if (property === "execute") return (statement: InStatement, args?: InArgs) =>
        single(tx => tx.execute(typeof statement === "string" && args !== undefined ? { sql: statement, args } : statement))
      if (property === "batch") return (statements: InStatement[], mode?: "read" | "write" | "deferred") =>
        single(tx => tx.batch(statements), mode)
      if (property === "executeMultiple" || property === "migrate") throw new BoardOperationError("denied")
      const value = Reflect.get(target, property)
      return typeof value === "function" ? value.bind(target) : value
    },
  })
  operationClients.set(guarded, { source, scope, operations, targets, intents, checks, beginPrivateWrite: () => transaction("write", true) })
  return guarded
}

/** The task repository retains the command result until this writer commits. */
export function acquirePrivateBoardWriter(client: Client, scope: BoardScope, signal?: AbortSignal): Promise<Transaction> {
  const command = operationClients.get(client)
  if (!command || command.scope !== scope) throw new BoardOperationError("denied")
  return acquireWriteTransaction({ transaction: command.beginPrivateWrite }, { signal })
}

/** Private compound-command gate: an enclosing writer retains every derived intent until commit. */
export async function requireBoardWriterIntent(tx: Transaction, scope: BoardScope, operation: WorkOperation): Promise<void> {
  const admitted = admittedWriters.get(tx)
  if (!admitted || admitted.scope !== scope) throw new BoardOperationError("denied")
  await admitted.require(operation)
}

/** Private compound-command provenance check retained through the enclosing commit. */
export async function requireBoardWriterCheck(tx: Transaction, scope: BoardScope, validate: () => Promise<void>): Promise<void> {
  const admitted = admittedWriters.get(tx)
  if (!admitted || admitted.scope !== scope) throw new BoardOperationError("denied")
  await admitted.check(validate)
}

/** Internal read unit of work. Child repositories cannot finalize or widen the enclosing snapshot. */
export function boardReadTransactionClient(tx: Transaction, scope: BoardScope): Client {
  requireBoardScope(scope)
  const admitted = admittedReads.get(tx)
  if (!admitted || admitted.scope.boardId !== scope.boardId || admitted.scope.authorityRevision !== scope.authorityRevision ||
    admitted.scope.principal.kind !== scope.principal.kind || admitted.scope.principal.id !== scope.principal.id) throw new BoardOperationError("denied")
  const check = async () => {
    // The parent admitted the actor before opening this read snapshot. Every
    // child repository still validates its requested operation. Avoid routing
    // those authorization metadata queries through another actor authorizer:
    // retain the actual continuity-guarded snapshot plus independent live epoch.
    if (await boardGrantStillCurrent(admitted.snapshot, scope.authorityRevision) &&
      await boardGrantStillCurrent(admitted.live, scope.authorityRevision)) return
    throw new BoardOperationError(await currentBoardGrantRevision(admitted.live) ? "stale" : "continuity_locked")
  }
  const borrowed = new Proxy(admitted.snapshot, {
    get(target, property) {
      if (property === "commit" || property === "rollback") return async () => { await check() }
      if (property === "close") return () => {}
      if (property === "execute" || property === "batch") return async (...args: unknown[]) => {
        await check()
        const method = Reflect.get(target, property) as (...args: unknown[]) => Promise<unknown>
        const result = await method.apply(target, args)
        await check()
        return result
      }
      if (property === "executeMultiple" || property === "migrate") throw new BoardOperationError("denied")
      const value = Reflect.get(target, property)
      return typeof value === "function" ? value.bind(target) : value
    },
  })
  return new Proxy(borrowed as unknown as Client, {
    get(target, property) {
      if (property === "transaction") return async (mode: "read" | "write" | "deferred" = "write") => {
        if (mode !== "read") throw new BoardOperationError("denied")
        await check()
        return borrowed
      }
      if (property === "batch") return async (statements: InStatement[], mode: "read" | "write" | "deferred" = "read") => {
        if (mode !== "read") throw new BoardOperationError("denied")
        return borrowed.batch(statements)
      }
      const value = Reflect.get(target, property)
      return typeof value === "function" ? value.bind(target) : value
    },
  })
}

/** Historical Board totals cannot be safely split by a later hidden Area/Project. */
export async function canReadBoardAggregate(client: Pick<Client, "execute">, scope: BoardScope): Promise<boolean> {
  const allowed = await validateBoardScope(scope, client, { resource: "task", action: "read" })
  if (!allowed.ok) return false
  const { rows } = await client.execute(sql`SELECT scope, scope_id FROM organization_access_policies
    WHERE board_id = ${scope.boardId} AND scope IN ('group', 'project')`)
  for (const row of rows) {
    if (!await validateBoardPlacement(scope, client, row.scope === "group" ? { areaId: String(row.scope_id) } : { projectId: String(row.scope_id) })) return false
  }
  return (await validateBoardScope(scope, client, { resource: "task", action: "read" })).ok
}

/** Metadata-only final dispatch check; it never projects a task or grants read authority. */
export async function validateTaskOperation(client: Pick<Client, "execute">, scope: BoardScope, taskId: string, operation: WorkOperation,
  expectedAssignedTo?: string,
): Promise<boolean> {
  if (operation.resource !== "task" || !taskId) return false
  try {
    if (!(await validateBoardScope(scope, client, operation)).ok) return false
    const assigned = operation.action === "read" ? undefined : scopeAssignedTo(scope)
    const { rows: [task] } = await client.execute(sql`SELECT ${taskField(scope, "area_id")} AS area_id,
      ${taskField(scope, "project_id")} AS project_id FROM tasks WHERE id = ${taskId} AND ${taskOwnedBy(scope)}
      ${assigned === undefined ? sourceSql("") : sql`AND assigned_to = ${assigned}`}
      ${expectedAssignedTo === undefined ? sourceSql("") : sql`AND assigned_to = ${expectedAssignedTo}`}`)
    if (!task) return false
    let areaId = typeof task.area_id === "string" ? task.area_id : null
    const projectId = typeof task.project_id === "string" ? task.project_id : null
    if (projectId) {
      const { rows: [project] } = await client.execute(sql`SELECT area_id FROM projects WHERE id = ${projectId} AND ${ownedPlanning(scope, "projects")}`)
      if (!project) return false
      if (typeof project.area_id === "string") areaId = project.area_id
    }
    return await validateBoardPlacement(scope, client, { areaId, projectId }) && (await validateBoardScope(scope, client, operation)).ok
  } catch { return false }
}
