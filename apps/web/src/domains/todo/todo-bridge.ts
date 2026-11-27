import type { Client } from "@libsql/client"
import {
  ensureSchema, getPersistenceClient, TaskRepository, resolveIntegrationScope, validateIntegrationScope,
  validateTaskOperation, readTaskDeletionReceipt,
  scopeBoardAccess, type BoardScope, type IntegrationScope, type TaskDeletionReceipt, type SyncTaskMutation,
} from "@domains/tasks"
import { getTodoItems, addTodoItem, updateTodoItem, removeTodoItem, subscribeTodoItems, type TodoItem } from "@domains/ha"
import { sanitizeTodoTitle } from "@lib/cleanup-corrupt-titles"
import { haStatusToMeitheal, meithealStatusToHA, buildDueServiceData, type HATodoItem } from "./todo-status-mapper"

export interface TodoSyncConfig {
  bindingId: string
  generation: number
  entityId: string
  syncEnabled: boolean
  writeBack: boolean
  syncDirection: "inbound" | "outbound" | "bidirectional"
}
interface TodoSyncState {
  config: Readonly<TodoSyncConfig>
  unsub?: (() => void) | undefined
  fallback?: ReturnType<typeof setTimeout> | undefined
  sequence: number
  latest: number
  lastSyncAt: number | null
  itemCount: number
  registrationContext?: IntegrationScope | undefined
}
const activeSyncs = new Map<string, TodoSyncState>()
const inboundMerges = new Map<string, Promise<unknown>>()
const readOperation = { resource: "task", action: "read" } as const

async function client(): Promise<Client> { await ensureSchema(); return getPersistenceClient() }

/** Source metadata never supplies an actor or an implicit destination. */
async function contextFor(config: TodoSyncConfig, actor?: BoardScope): Promise<IntegrationScope | null> {
  if (!config.bindingId || !Number.isSafeInteger(config.generation) || config.generation < 1) return null
  const result = await resolveIntegrationScope(await client(), config.bindingId, config.generation, readOperation, actor,
    actor ? { resource: "board", action: "manage" } : readOperation)
  if (!result.ok || result.value.binding.purpose !== "todo.sync" || result.value.binding.integration !== "todo" || result.value.binding.sourceId !== config.entityId) return null
  return result.value
}
function providerItems(items: TodoItem[]): HATodoItem[] {
  return items.map(item => ({ summary: item.summary,
    ...(typeof item.uid === "string" ? { uid: item.uid } : {}),
    ...(item.status === "completed" || item.status === "needs_action" ? { status: item.status } : {}),
    ...(typeof item.due === "string" ? { due: item.due } : {}),
    ...(typeof item.description === "string" ? { description: item.description } : {}),
  }))
}
function current(state: TodoSyncState) { return activeSyncs.get(state.config.bindingId) === state }
async function subscriptionAllowed(state: TodoSyncState): Promise<boolean> {
  return current(state) && (!state.registrationContext ||
    (await validateIntegrationScope(state.registrationContext, await client(), readOperation)).ok) && Boolean(await contextFor(state.config))
}

export async function startTodoSync(configs: TodoSyncConfig | TodoSyncConfig[], approvedContext?: IntegrationScope): Promise<void> {
  const hydration: Promise<unknown>[] = []
  const started: TodoSyncState[] = []
  for (const input of Array.isArray(configs) ? configs : [configs]) {
    // Only the same binding is replaced. The same provider entity can serve several explicitly approved Boards.
    if (!input.bindingId || !Number.isSafeInteger(input.generation)) continue
    if (approvedContext && (approvedContext.binding.id !== input.bindingId || approvedContext.binding.generation !== input.generation ||
      approvedContext.binding.sourceId !== input.entityId || !approvedContext.originatingActor ||
      approvedContext.originatingOperation?.resource !== "board" || approvedContext.originatingOperation?.action !== "manage" ||
      !(await validateIntegrationScope(approvedContext, await client(), readOperation)).ok)) throw new Error("Todo registration is unavailable")
    if (!input.syncEnabled || !await contextFor(input)) continue
    if (approvedContext && !(await validateIntegrationScope(approvedContext, await client(), readOperation)).ok) throw new Error("Todo registration is unavailable")
    stopTodoSync(input.bindingId)
    const state: TodoSyncState = { config: Object.freeze({ ...input }), sequence: 0, latest: 0, lastSyncAt: null, itemCount: 0, ...(approvedContext ? { registrationContext: approvedContext } : {}) }
    activeSyncs.set(input.bindingId, state)
    started.push(state)
    if (input.syncDirection === "outbound") continue
    hydration.push(new Promise<void>(resolve => {
      let settled = false
      const finish = () => { if (!settled) { settled = true; resolve() } }
      state.fallback = setTimeout(() => {
        state.fallback = undefined
        if (!settled && current(state)) void subscriptionAllowed(state).then(allowed => allowed ? syncTodoFromHA(input.bindingId, state.registrationContext?.originatingActor) : undefined).finally(finish).catch(() => {})
        else finish()
      }, 3_000)
      state.fallback.unref?.()
      void subscribeTodoItems(input.entityId, items => {
        if (!current(state)) return
        if (state.fallback) clearTimeout(state.fallback)
        state.fallback = undefined
        void enqueueSnapshot(state, ++state.sequence, providerItems(items), state.registrationContext?.originatingActor).finally(finish).catch(() => {})
      }, { operationAllowed: () => subscriptionAllowed(state), throwOnError: true }).then(unsub => {
        if (current(state)) { state.unsub = unsub; state.registrationContext = undefined }
        else { unsub(); finish() }
      }).catch(() => {
        if (!settled && current(state)) {
          if (state.fallback) clearTimeout(state.fallback)
          state.fallback = undefined
          void subscriptionAllowed(state).then(allowed => allowed ? syncTodoFromHA(input.bindingId, state.registrationContext?.originatingActor) : undefined).finally(finish).catch(() => {})
        } else finish()
      })
    }))
  }
  await Promise.allSettled(hydration)
  if (approvedContext && !(await validateIntegrationScope(approvedContext, await client(), readOperation)).ok) {
    for (const state of started) if (current(state)) stopTodoSync(state.config.bindingId, state.config.generation)
    throw new Error("Todo registration is unavailable")
  }
}

async function enqueueSnapshot(state: TodoSyncState, sequence: number, items: HATodoItem[], actor?: BoardScope): Promise<boolean> {
  if (!current(state) || sequence < state.latest) return false
  state.latest = sequence
  const key = state.config.bindingId
  const queued = (inboundMerges.get(key) ?? Promise.resolve()).catch(() => {}).then(async () => {
    if (!current(state) || sequence < state.latest) return false
    const context = await contextFor(state.config, actor)
    if (!context) return false
    await mergeHATodoItems(context, items)
    if (!current(state) || sequence < state.latest || !(await validateIntegrationScope(context, await client(), readOperation)).ok) return false
    state.itemCount = items.length
    state.lastSyncAt = Date.now()
    return true
  })
  inboundMerges.set(key, queued)
  void queued.finally(() => { if (inboundMerges.get(key) === queued) inboundMerges.delete(key) }).catch(() => {})
  return queued
}

export async function syncTodoFromHA(bindingId?: string, actor?: BoardScope): Promise<{ synced: number, errors: number }> {
  const result = { synced: 0, errors: 0 }
  const states = bindingId ? [activeSyncs.get(bindingId)].filter((state): state is TodoSyncState => Boolean(state)) : [...activeSyncs.values()]
  for (const state of states) {
    if (state.config.syncDirection === "outbound") continue
    try {
      const context = await contextFor(state.config, actor)
      if (!context) { result.errors++; continue }
      const sequence = ++state.sequence
      const operationAllowed = async () => current(state) && (await validateIntegrationScope(context, await client(), readOperation)).ok
      const items = await getTodoItems(state.config.entityId, undefined, { operationAllowed, throwOnError: true })
      if (!await operationAllowed()) { result.errors++; continue }
      if (await enqueueSnapshot(state, sequence, providerItems(items), actor)) result.synced += items.length
      else result.errors++
    } catch { result.errors++ }
  }
  return result
}

/** Provider UID plus binding is the identity. Titles never merge unrelated work. */
export async function mergeHATodoItems(context: IntegrationScope, items: HATodoItem[]): Promise<void> {
  const db = await client()
  if (context.binding.purpose !== "todo.sync" || context.binding.integration !== "todo" || !(await validateIntegrationScope(context, db, readOperation)).ok) throw new Error("Todo binding unavailable")
  if (items.some(item => typeof item.uid !== "string" || !item.uid || typeof item.summary !== "string" || !sanitizeTodoTitle(item.summary, scopeBoardAccess(context.scope).ticketPrefix)) || new Set(items.map(item => item.uid)).size !== items.length) throw new Error("Todo snapshot needs unique provider IDs and valid titles")
  const candidates = items
  const repository = new TaskRepository(db, context.scope)
  const matches = await repository.findTasksByExternalSyncIds({ source: "ha_todo", entityId: context.binding.sourceId, externalIds: candidates.map(item => item.uid!) }, context)
  const mutations: SyncTaskMutation[] = []
  for (const item of candidates) {
    const uid = item.uid!
    const match = matches.get(uid)
    if (match?.taskDeleted || match?.suppressed) continue
    if (!match) {
      const normalizedDesc = (item.description ?? "").replace(/<[^>]+>/g, "\n").trim()
      if (/(?:^|\s)Added from Meitheal$/i.test(normalizedDesc)) continue
    }
    const title = sanitizeTodoTitle(item.summary, scopeBoardAccess(context.scope).ticketPrefix)
    const status = haStatusToMeitheal(item.status ?? "needs_action")
    let description = item.description ?? null
    const previousPayload = match?.payload ? parsePayload(match.payload) : {}
    const ownMarker = previousPayload.correlationMarker
    if (description && typeof ownMarker === "string" && description.includes(ownMarker)) {
      description = description.replace(ownMarker, "").replace(/\n?\n?Added from Meitheal$/i, "").trim() || null
    }
    const confirmation = { source: "ha_todo" as const, entityId: context.binding.sourceId, externalId: uid,
      payload: JSON.stringify({ summary: item.summary, status: item.status, due: item.due,
        ...(typeof previousPayload.correlationMarker === "string" ? { correlationMarker: previousPayload.correlationMarker, correlation: previousPayload.correlation, state: "confirmed" } : {}),
      }), syncDirection: "inbound" as const }
    if (match) mutations.push({ kind: "update", taskId: match.taskId, title, status, openEcho: item.status !== "completed",
      dueDate: item.due ?? null, updateDueDate: true, description, updatedAt: Date.now(),
      confirmation: { ...confirmation, confirmationId: match.confirmationId, requireUnmodifiedSinceSync: true } })
    else mutations.push({ kind: "create", taskId: crypto.randomUUID(), idempotencyKey: `todo:${uid}`, title, description: description ?? "", status,
      priority: 3, dueDate: item.due ?? null, labels: [], taskType: "task", taskKind: "standard_action", confirmation })
  }
  if (mutations.length) {
    const committed = await repository.commitSyncMutationChunks(mutations, context)
    if (committed.errors.length) throw new Error("Some Todo items could not be applied under current work permissions")
  }
}

function parsePayload(raw: string | null): Record<string, unknown> {
  try { const value = JSON.parse(raw ?? "{}"); return value && typeof value === "object" && !Array.isArray(value) ? value : {} } catch { return {} }
}
/** Recovery identifies only the original round-tripped correlation, never a same-title item. */
export function recoverTodoAdd(items: TodoItem[], baseline: readonly string[], expected: Record<string, unknown>, marker: string | null): TodoItem | null {
  if (!marker || typeof expected.description !== "string" || !expected.description.includes(marker)) return null
  const matches = items.filter(item => item.uid && !baseline.includes(item.uid) && item.summary === expected.summary &&
    typeof item.description === "string" && item.description === expected.description && item.description.includes(marker) && (item.due ?? null) === expected.due)
  return matches.length === 1 ? matches[0]! : null
}

async function permitsTask(context: IntegrationScope, taskId: string, completion?: "complete" | "reopen"): Promise<boolean> {
  const db = await client()
  if (!(await validateIntegrationScope(context, db, readOperation)).ok || !await new TaskRepository(db, context.scope).findById(taskId)) return false
  if (context.originatingActor && !await validateTaskOperation(db, context.originatingActor, taskId, context.originatingOperation ?? readOperation)) return false
  // A read-only receiver mirrors approved facts; it gains no authority to complete local Tasks.
  if (completion && context.originatingActor && !await validateTaskOperation(db, context.originatingActor, taskId, { resource: "task", action: completion })) return false
  return true
}

/** Existing public signature plus a required admitted original binding context. No unbound fallback. */
export async function pushTaskToTodoList(taskId: string, title: string, status: string, entityId: string,
  dueDate: string | null | undefined, description: string | undefined, labels: string[] | undefined, context: IntegrationScope): Promise<boolean> {
  if (!context || context.binding.purpose !== "todo.sync" || context.binding.sourceId !== entityId || labels?.includes("no-sync")) return false
  const state = activeSyncs.get(context.binding.id)
  if (!state || state.config.generation !== context.binding.generation || state.config.syncDirection === "inbound" || !state.config.writeBack) return false
  const db = await client()
  const repository = new TaskRepository(db, context.scope)
  const snapshot = await repository.findSyncConfirmation(taskId, context)
  if (!snapshot) return false
  // Read between matching versions so an old event body cannot publish stale fields.
  const liveTask = await repository.findById(taskId)
  if (!liveTask || (await repository.findSyncConfirmation(taskId, context))?.taskVersion !== snapshot.taskVersion) return false
  title = liveTask.title
  status = liveTask.status
  dueDate = liveTask.due_date
  description = liveTask.description ?? undefined
  try { const selected = JSON.parse(String(liveTask.labels ?? "[]")); labels = Array.isArray(selected) ? selected.filter((label): label is string => typeof label === "string") : [] } catch { return false }
  if (labels?.includes("no-sync")) return false
  const haStatus = meithealStatusToHA(status)
  let stored = snapshot.confirmation
  const prior = parsePayload(stored?.payload ?? null)
  const changesCompletion = haStatus === "completed" ? "complete" : prior.status === "completed" ? "reopen" : undefined
  const operationAllowed = async () => {
    if (!await permitsTask(context, taskId, changesCompletion)) return false
    return (await repository.findSyncConfirmation(taskId, context))?.taskVersion === snapshot.taskVersion
  }
  if (!await operationAllowed()) return false
  let correlation = typeof prior.correlation === "string" ? prior.correlation : null
  let correlationMarker = typeof prior.correlationMarker === "string" ? prior.correlationMarker : null
  if (!correlation && !stored) {
    const task = await repository.findById(taskId)
    if (!task) return false
    correlation = crypto.randomUUID()
    // The Supervisor ingress entry is a tokenized transport URL, not a public task link.
    // An explicit ticket reference remains useful when a safe canonical app URL is unavailable.
    correlationMarker = `Meitheal ticket ${task.ticket_key ?? task.ticket_ref ?? task.id} · reference ${correlation}`
  }
  const attributed = [description, correlationMarker, "Added from Meitheal"].filter(Boolean).join("\n\n")
  const save = (uid: string, payload: Record<string, unknown>) => repository.saveSyncConfirmationForTask(taskId,
    { source: "ha_todo", entityId, externalId: uid, ...(stored ? { confirmationId: stored.confirmationId } : {}), syncDirection: "outbound", payload: JSON.stringify({ ...payload, correlation, correlationMarker }) }, context, snapshot.taskVersion)
  let uid = stored?.externalId
  if (!stored || prior.state === "pending") {
    let baseline: string[]
    if (!stored) {
      const before = await getTodoItems(entityId, undefined, { operationAllowed, throwOnError: true })
      if (!await operationAllowed()) return false
      baseline = before.map(item => item.uid).filter((value): value is string => typeof value === "string")
      // An uncertain add remains pending. Retrying this command only checks for its original provider result.
      if (!await save(`pending:${crypto.randomUUID()}`, { state: "pending", summary: title, description: attributed, due: dueDate ?? null, knownUids: baseline })) return false
      const pending = await repository.findSyncConfirmation(taskId, context)
      if (!pending?.confirmation || pending.taskVersion !== snapshot.taskVersion) return false
      stored = pending.confirmation
      await addTodoItem(entityId, { summary: title, description: attributed, ...(dueDate ? { due: dueDate } : {}) }, { operationAllowed, throwOnError: true })
    } else baseline = Array.isArray(prior.knownUids) ? prior.knownUids.filter((value): value is string => typeof value === "string") : []
    const after = await getTodoItems(entityId, undefined, { operationAllowed, throwOnError: true })
    const expected = prior.state === "pending" ? prior : { summary: title, description: attributed, due: dueDate ?? null }
    const recovered = recoverTodoAdd(after, baseline, expected, correlationMarker)
    if (!recovered?.uid || !await operationAllowed()) return false
    uid = recovered.uid
    if (!await save(uid, { summary: expected.summary, status: recovered.status ?? "needs_action", state: "confirmed" })) return false
  }
  if (!uid || uid.startsWith("pending:") || !await operationAllowed()) return false
  const success = await updateTodoItem(entityId, uid, { summary: title, status: haStatus, description: attributed, ...buildDueServiceData(dueDate) }, { operationAllowed, throwOnError: true })
  if (!success || !await operationAllowed()) return false
  return save(uid, { summary: title, status: haStatus, state: "confirmed" })
}

/** Deleted rows cannot authorize effects. Re-read the private committed receipt for this original actor/binding. */
export async function removeTaskFromTodoList(taskId: string, context: IntegrationScope, receipt: TaskDeletionReceipt): Promise<number> {
  if (!context?.originatingActor || !receipt || receipt.id !== taskId || context.binding.purpose !== "todo.sync") return 0
  const db = await client()
  const operationAllowed = async () => {
    if (!(await validateIntegrationScope(context, db, readOperation)).ok) return false
    const current = await readTaskDeletionReceipt(db, context.originatingActor!, receipt.eventId, taskId)
    return Boolean(current?.bindingRefs.some(ref => ref.id === context.binding.id && ref.generation === context.binding.generation))
  }
  if (!await operationAllowed()) return 0
  const { rows } = await db.execute({ sql: "SELECT confirmation_id,ha_todo_uid FROM todo_sync_confirmations WHERE task_id=? AND binding_id=? AND ha_entity_id=?", args: [taskId, context.binding.id, context.binding.sourceId] })
  let removed = 0
  for (const row of rows) {
    const uid = String(row.ha_todo_uid)
    if (uid.startsWith("pending:") || !await operationAllowed()) continue
    if (await removeTodoItem(context.binding.sourceId, [uid], { operationAllowed, throwOnError: true })) removed++
  }
  // Deleted-task confirmation metadata stays available for safe idempotent retry; no foreign/unbound cleanup.
  return removed
}

export function stopTodoSync(bindingId?: string, generation?: number): void {
  for (const [id, state] of activeSyncs) {
    if (bindingId !== undefined && id !== bindingId || generation !== undefined && state.config.generation !== generation) continue
    if (state.fallback) clearTimeout(state.fallback)
    state.unsub?.()
    activeSyncs.delete(id)
  }
}
export interface TodoSyncStatus {
  bindingId: string, generation: number, entityId: string, active: true,
  direction: TodoSyncConfig["syncDirection"], writeBack: boolean, lastSyncAt: number | null, itemCount: number,
}
export function getTodoSyncStatus(bindingId: string): TodoSyncStatus | null
export function getTodoSyncStatus(): TodoSyncStatus[]
export function getTodoSyncStatus(bindingId?: string): TodoSyncStatus | TodoSyncStatus[] | null {
  const project = (state: TodoSyncState) => ({ bindingId: state.config.bindingId, generation: state.config.generation,
    entityId: state.config.entityId, active: true as const, direction: state.config.syncDirection, writeBack: state.config.writeBack,
    lastSyncAt: state.lastSyncAt, itemCount: state.itemCount })
  if (bindingId !== undefined) { const state = activeSyncs.get(bindingId); return state ? project(state) : null }
  return [...activeSyncs.values()].map(project)
}
export function getActiveTodoSyncConfigs(): TodoSyncConfig[] { return [...activeSyncs.values()].filter(state => state.config.syncDirection !== "inbound" && state.config.writeBack).map(state => ({ ...state.config })) }
