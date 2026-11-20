/** Grocy synchronization uses the common work engine and one explicit approved destination per binding. */
import { createLogger, defaultRedactionPatterns } from "@meitheal/domain-observability"
import {
  GrocyAdapter,
  type GrocyChore,
  type GrocyTask,
  type GrocyResult
} from "@meitheal/integration-core"
import {
  TaskRepository,
  canReadBoardAggregate,
  getPersistenceClient,
  ensureSchema,
  guardWorkPersistence,
  resolveIntegrationScope,
  validateIntegrationScope,
  validateTaskOperation,
  validateBoardScope,
  readWorkDestinations,
  BoardOperationError,
  sql,
  boardTaskOwnership,
  type BoardScope,
  type IntegrationScope,
  type WorkOperation,
  type SyncTaskMutation
} from "@domains/tasks"
import { isCurrentConfiguredGrocyClient } from "../../lib/grocy-client"
import { STATUS, isDoneStatus } from "../../lib/status-config"
import { choreToTask, taskToTask, shoppingListToTask } from "./grocy-mapper"

const logger = createLogger({
  service: "meitheal-web",
  env: process.env.NODE_ENV ?? "development",
  minLevel: "info",
  enabledCategories: ["integrations", "grocy"],
  redactPatterns: defaultRedactionPatterns,
  auditEnabled: false
})
const SYS_REQ = "grocy-sync"
const read: WorkOperation = { resource: "task", action: "read" }
export interface GrocySyncConfig {
  bindingId: string
  generation: number
  syncEnabled: boolean
  syncMode: "import" | "export" | "bidirectional"
  intervalMs: number
}
type GrocySyncResult = { chores: number; tasks: number; shopping: number; errors: number }
export type GrocySyncStatusEntity = {
  bindingId: string
  generation: number
  active: boolean
  syncMode: GrocySyncConfig["syncMode"]
  intervalMs: number
  lastSyncAt: number | null
  lastSyncError: string | null
  itemCount: number | null
  choreCount: number | null
  taskCount: number | null
  shoppingCount: number | null
}
type GrocySyncState = {
  config: GrocySyncConfig
  baseAdapter: GrocyAdapter
  timer: ReturnType<typeof setInterval> | null
  lastSyncAt: number | null
  lastSyncError: string | null
  itemCount: number
  choreCount: number
  taskCount: number
  shoppingCount: number
}
const states = new Map<string, GrocySyncState>()
const destinationChoices = new Map<string, { generation: number; paused: boolean }>()
const stopListeners = new Set<() => void>()
let stopAllGeneration = 0
const activeSyncs = new Map<string, { state: GrocySyncState; promise: Promise<GrocySyncResult> }>()
const MAX_RETRIES = 2,
  RETRY_DELAY_MS = 2000
class GrocyWorkUnavailableError extends Error {
  constructor() {
    super("Grocy destination is unavailable; check current binding and provider configuration")
  }
}
function logFailure(event: string) {
  logger.log("warn", {
    event,
    domain: "integrations",
    component: "grocy-bridge",
    request_id: SYS_REQ,
    message: "Grocy operation failed; check current binding, work permissions and provider access"
  })
}

async function resolveContext(
  config: GrocySyncConfig,
  originatingActor?: BoardScope,
  originatingOperation?: WorkOperation
): Promise<IntegrationScope> {
  await ensureSchema()
  const resolved = await resolveIntegrationScope(
    getPersistenceClient(),
    config.bindingId,
    config.generation,
    read,
    originatingActor,
    originatingOperation
  )
  if (
    !resolved.ok ||
    resolved.value.binding.integration !== "grocy" ||
    resolved.value.binding.purpose !== "grocy.sync" ||
    resolved.value.binding.sourceId !== "configured-grocy"
  )
    throw new GrocyWorkUnavailableError()
  return resolved.value
}
async function operationAllowed(
  state: GrocySyncState,
  context: IntegrationScope
): Promise<boolean> {
  try {
    return (
      states.get(state.config.bindingId) === state &&
      state.config.syncEnabled &&
      state.config.generation === context.binding.generation &&
      (await isCurrentConfiguredGrocyClient(state.baseAdapter)) &&
      (await validateIntegrationScope(context, getPersistenceClient(), read)).ok
    )
  } catch {
    return false
  }
}
function scopedAdapter(
  state: GrocySyncState,
  context: IntegrationScope,
  additional?: () => Promise<boolean>
): GrocyAdapter {
  return state.baseAdapter.withOperationAllowed(
    async () => (await operationAllowed(state, context)) && (!additional || (await additional()))
  )
}
async function providerOperation<T>(
  state: GrocySyncState,
  context: IntegrationScope,
  operation: () => Promise<T>
): Promise<T> {
  if (!(await operationAllowed(state, context))) throw new GrocyWorkUnavailableError()
  const result = await operation()
  if (!(await operationAllowed(state, context))) throw new GrocyWorkUnavailableError()
  return result
}
async function withRetry<T>(
  state: GrocySyncState,
  context: IntegrationScope,
  operation: () => Promise<GrocyResult<T>>
): Promise<GrocyResult<T>> {
  for (let attempt = 0; ; attempt++) {
    const result = await providerOperation(state, context, operation)
    if (result.ok || !result.retryable || attempt === MAX_RETRIES) return result
    await new Promise<void>((resolve) => setTimeout(resolve, RETRY_DELAY_MS * (attempt + 1)))
  }
}
export async function startGrocySync(
  config: GrocySyncConfig,
  adapter: GrocyAdapter | (() => Promise<GrocyAdapter | null>),
  approval?: IntegrationScope
): Promise<boolean> {
  if (!config.syncEnabled) {
    stopGrocySync(config.bindingId, config.generation)
    return false
  }
  const choice = destinationChoices.get(config.bindingId)
  const stopGeneration = stopAllGeneration
  if (!approval && choice?.paused && choice.generation >= config.generation) return false
  const resolved = typeof adapter === "function" ? await adapter() : adapter
  if (!resolved) return false
  if (!(await isCurrentConfiguredGrocyClient(resolved))) throw new GrocyWorkUnavailableError()
  const existing = states.get(config.bindingId)
  if (!approval && existing?.config.generation === config.generation &&
    await isCurrentConfiguredGrocyClient(existing.baseAdapter)) return false
  await resolveContext(config)
  if (
    approval &&
    (approval.binding.id !== config.bindingId ||
      approval.binding.generation !== config.generation ||
      !(await validateIntegrationScope(approval, getPersistenceClient(), read)).ok)
  )
    throw new GrocyWorkUnavailableError()
  // A destination can be disabled while startup is resolving its credentials or binding.
  if (stopAllGeneration !== stopGeneration || destinationChoices.get(config.bindingId) !== choice) {
    if (approval) throw new GrocyWorkUnavailableError()
    return false
  }
  if (approval) destinationChoices.set(config.bindingId, { generation: config.generation, paused: false })
  if (states.has(config.bindingId)) stopGrocySync(config.bindingId)
  const state: GrocySyncState = {
    config: { ...config },
    baseAdapter: resolved,
    timer: null,
    lastSyncAt: null,
    lastSyncError: null,
    itemCount: 0,
    choreCount: 0,
    taskCount: 0,
    shoppingCount: 0
  }
  states.set(config.bindingId, state)
  void syncFromGrocy(config.bindingId).catch(() => logFailure("grocy.sync.initial_failed"))
  const poll = () => {
    void syncFromGrocy(state.config.bindingId).catch(() => logFailure("grocy.sync.poll_failed"))
  }
  const interval = state.config.intervalMs
  if (Number.isFinite(interval) && interval > 0)
    state.timer = setInterval(poll, interval)
  return true
}
export function onGrocySyncStopped(listener: () => void): () => void {
  stopListeners.add(listener)
  return () => {
    stopListeners.delete(listener)
  }
}
export function stopGrocySync(bindingId?: string, generation?: number): void {
  if (bindingId === undefined) stopAllGeneration++
  if (bindingId !== undefined && generation !== undefined) {
    const choice = destinationChoices.get(bindingId)
    if (!choice || generation >= choice.generation) destinationChoices.set(bindingId, { generation, paused: true })
  }
  for (const [id, state] of states) {
    if (
      (bindingId && id !== bindingId) ||
      (generation !== undefined && state.config.generation !== generation)
    )
      continue
    if (state.timer) clearInterval(state.timer)
    state.config.syncEnabled = false
    states.delete(id)
  }
  if (bindingId === undefined) for (const listener of stopListeners) listener()
}
export function getActiveGrocySyncConfig(bindingId: string): GrocySyncConfig | null {
  return states.get(bindingId)?.config ?? null
}
/** Profile-only adapter; generic stock callers still need their own configuration authority. */
export function getGrocyAdapter(bindingId: string): GrocyAdapter | null {
  return states.get(bindingId)?.baseAdapter ?? null
}
export async function getGrocySyncStatus(scope?: BoardScope) {
  const db = getPersistenceClient()
  if (scope) {
    const current = await validateBoardScope(scope, db, read)
    if (!current.ok) throw new BoardOperationError(current.errorCode)
  }
  const configuration = await readWorkDestinations(db),
    aggregate = scope ? await canReadBoardAggregate(db, scope) : false
  const entities: GrocySyncStatusEntity[] = []
  for (const state of states.values()) {
    const binding = configuration?.bindings.find((binding) => binding.id === state.config.bindingId)
    if (scope && binding?.destination.boardId !== scope.boardId) continue
    const visible = Boolean(
      scope && aggregate && binding?.enabled && binding.generation === state.config.generation
    )
    entities.push({
      bindingId: state.config.bindingId,
      generation: state.config.generation,
      active: state.config.syncEnabled,
      syncMode: state.config.syncMode,
      intervalMs: state.config.intervalMs,
      lastSyncAt: state.lastSyncAt,
      lastSyncError: state.lastSyncError,
      itemCount: visible ? state.itemCount : null,
      choreCount: visible ? state.choreCount : null,
      taskCount: visible ? state.taskCount : null,
      shoppingCount: visible ? state.shoppingCount : null
    })
  }
  if (scope) {
    const current = await validateBoardScope(scope, db, read)
    if (!current.ok) throw new BoardOperationError(current.errorCode)
    if (!(await canReadBoardAggregate(db, scope)))
      for (const entity of entities)
        entity.itemCount = entity.choreCount = entity.taskCount = entity.shoppingCount = null
  }
  const first = entities[0],
    sum = (key: "itemCount" | "choreCount" | "taskCount" | "shoppingCount") =>
      aggregate && entities.every((entity) => entity[key] !== null)
        ? entities.reduce((total, entity) => total + (entity[key] ?? 0), 0)
        : null
  return {
    active: entities.some((entity) => entity.active),
    entities,
    syncMode: first?.syncMode ?? "import",
    intervalMs: first?.intervalMs ?? 0,
    lastSyncAt: first?.lastSyncAt ?? null,
    lastSyncError: entities.find((entity) => entity.lastSyncError)?.lastSyncError ?? null,
    itemCount: sum("itemCount"),
    choreCount: sum("choreCount"),
    taskCount: sum("taskCount"),
    shoppingCount: sum("shoppingCount")
  }
}
/** Coalesce only the same binding generation and current originating authority. */
export async function syncFromGrocy(
  bindingId: string,
  originatingActor?: BoardScope,
  originatingOperation: WorkOperation = { resource: "task", action: "edit" }
): Promise<GrocySyncResult> {
  const state = states.get(bindingId)
  if (!state) return { chores: 0, tasks: 0, shopping: 0, errors: 1 }
  let context: IntegrationScope
  try {
    context = await resolveContext(state.config, originatingActor, originatingOperation)
  } catch (error) {
    if (states.get(bindingId) === state)
      state.lastSyncError =
        "Grocy destination is unavailable; check current binding and provider configuration"
    throw error
  }
  const key = JSON.stringify([
    bindingId,
    state.config.generation,
    originatingActor
      ? {
          kind: originatingActor.principal.kind,
          id: originatingActor.principal.id,
          epoch: originatingActor.authorityRevision,
          revision: originatingActor.boardRevision,
          operation: originatingOperation
        }
      : null
  ])
  const current = activeSyncs.get(key)
  if (current?.state === state) return current.promise
  const promise = performSyncFromGrocy(state, context),
    run = { state, promise }
  activeSyncs.set(key, run)
  void promise
    .finally(() => {
      if (activeSyncs.get(key) === run) activeSyncs.delete(key)
    })
    .catch(() => {})
  return promise
}
function pausedSync(state: GrocySyncState): GrocySyncResult {
  state.lastSyncError =
    "Grocy destination is unavailable; refresh the binding and provider configuration"
  return { chores: 0, tasks: 0, shopping: 0, errors: 1 }
}
async function performSyncFromGrocy(
  state: GrocySyncState,
  context: IntegrationScope
): Promise<GrocySyncResult> {
  if (!(await operationAllowed(state, context))) return pausedSync(state)
  const result: GrocySyncResult = { chores: 0, tasks: 0, shopping: 0, errors: 0 }
  if (state.config.syncMode === "export") return result
  const adapter = scopedAdapter(state, context)
  let productNames = new Map<number, string>(),
    categoryNames = new Map<number, string>()
  try {
    const products = await providerOperation(state, context, () => adapter.getProducts())
    if (products.ok) productNames = products.data
  } catch (error) {
    if (error instanceof GrocyWorkUnavailableError) return pausedSync(state)
  }
  try {
    const categories = await providerOperation(state, context, () => adapter.getCategories())
    if (categories.ok) categoryNames = categories.data
  } catch (error) {
    if (error instanceof GrocyWorkUnavailableError) return pausedSync(state)
  }
  const seen = new Set<string>()
  try {
    const chores = await withRetry(state, context, () => adapter.getChores())
    if (chores.ok) {
      for (const chore of chores.data) seen.add(`chore:${chore.choreId}`)
      const merged = await mergeGrocyChores(chores.data, context)
      result.chores = merged.count
      result.errors += merged.errors
    } else {
      result.errors++
      logFailure("grocy.sync.chores_failed")
    }
  } catch {
    if (!(await operationAllowed(state, context))) return pausedSync(state)
    result.errors++
    logFailure("grocy.sync.chores_failed")
  }
  try {
    const tasks = await withRetry(state, context, () => adapter.getTasks(true))
    if (tasks.ok) {
      for (const task of tasks.data) seen.add(`task:${task.taskId}`)
      const merged = await mergeGrocyTasks(tasks.data, context, categoryNames)
      result.tasks = merged.count
      result.errors += merged.errors
    } else {
      result.errors++
      logFailure("grocy.sync.tasks_failed")
    }
  } catch {
    if (!(await operationAllowed(state, context))) return pausedSync(state)
    result.errors++
    logFailure("grocy.sync.tasks_failed")
  }
  try {
    const shopping = await providerOperation(state, context, () => adapter.getShoppingList())
    if (shopping.ok) {
      if (shopping.data.length) {
        seen.add("shopping:list-1")
        const merged = await mergeShoppingList(
          shopping.data.map((item) => ({
            productId: item.productId,
            amount: item.amount,
            ...(typeof item.id === "number" ? { id: item.id } : {}),
            ...(typeof item.note === "string" ? { note: item.note } : {})
          })),
          context,
          productNames
        )
        result.shopping = merged.count
        result.errors += merged.errors
      }
    } else {
      result.errors++
      logFailure("grocy.sync.shopping_failed")
    }
  } catch {
    if (!(await operationAllowed(state, context))) return pausedSync(state)
    result.errors++
    logFailure("grocy.sync.shopping_failed")
  }
  if (!(await operationAllowed(state, context))) return pausedSync(state)
  if (result.errors === 0) {
    try {
      result.errors += await cleanStaleTasks(seen, context)
    } catch {
      result.errors++
      logFailure("grocy.sync.stale_cleanup_failed")
    }
  }
  if (!(await operationAllowed(state, context))) return pausedSync(state)
  state.lastSyncAt = Date.now()
  state.lastSyncError = result.errors
    ? "Grocy sync incomplete; check current binding and provider access"
    : null
  state.choreCount = result.chores
  state.taskCount = result.tasks
  state.shoppingCount = result.shopping
  state.itemCount = result.chores + result.tasks + result.shopping
  return result
}

function stateFor(context: IntegrationScope): GrocySyncState | null {
  const state = states.get(context.binding.id)
  return state &&
    state.config.generation === context.binding.generation &&
    context.binding.integration === "grocy" &&
    context.binding.purpose === "grocy.sync" &&
    context.binding.sourceId === "configured-grocy"
    ? state
    : null
}
/** Actual completion permission remains with the originating actor, even for a read-only receiver. */
export async function pushCompletionToGrocy(
  taskId: string,
  context: IntegrationScope
): Promise<boolean> {
  const state = stateFor(context)
  if (!state || state.config.syncMode === "import" || !context.originatingActor) return false
  try {
    const db = getPersistenceClient(),
      repo = new TaskRepository(db, context.scope),
      task = await repo.findById(taskId)
    if (!task || !isDoneStatus(task.status)) return false
    const snapshot = await repo.findSyncConfirmation(taskId, context)
    if (!snapshot?.confirmation) return false
    const {
      rows: [link]
    } = await db.execute(
      sql`SELECT grocy_entity_type,grocy_entity_id FROM grocy_sync_confirmations WHERE task_id=${taskId} AND binding_id=${context.binding.id} AND confirmation_id=${snapshot.confirmation.confirmationId}`
    )
    if (!link) return false
    const entityId = Number(link.grocy_entity_id)
    if (link.grocy_entity_type !== "shopping" && (!Number.isSafeInteger(entityId) || entityId < 1))
      return false
    const allowed = async () =>
      (await operationAllowed(state, context)) &&
      (await validateTaskOperation(db, context.originatingActor!, taskId, {
        resource: "task",
        action: "complete"
      })) &&
      (await repo.findSyncConfirmation(taskId, context))?.taskVersion === snapshot.taskVersion &&
      isDoneStatus((await repo.findById(taskId))?.status ?? "")
    if (!(await allowed())) return false
    const adapter = scopedAdapter(state, context, allowed)
    const result =
      link.grocy_entity_type === "chore"
        ? await providerOperation(state, context, () => adapter.trackChoreExecution(entityId))
        : link.grocy_entity_type === "task"
          ? await providerOperation(state, context, () => adapter.markTaskCompleted(entityId))
          : link.grocy_entity_type === "shopping"
            ? await providerOperation(state, context, () => adapter.clearShoppingList())
            : null
    return Boolean(result?.ok && (await allowed()))
  } catch {
    logFailure("grocy.sync.push_failed")
    return false
  }
}
/** Publish authoritative current task fields, never arbitrary caller-provided text. */
export async function pushNewTaskToGrocy(
  context: IntegrationScope,
  taskId: string,
  _title?: string,
  _options?: { description?: string | undefined; dueDate?: string | undefined }
): Promise<boolean> {
  const state = stateFor(context)
  if (!state || state.config.syncMode !== "bidirectional") return false
  try {
    const db = getPersistenceClient(),
      repo = new TaskRepository(db, context.scope),
      task = await repo.findById(taskId),
      snapshot = await repo.findSyncConfirmation(taskId, context)
    if (
      !task ||
      !snapshot ||
      snapshot.confirmation ||
      Number(task.task_version) !== snapshot.taskVersion
    )
      return false
    const allowed = async () =>
      (await operationAllowed(state, context)) &&
      (await validateTaskOperation(db, context.scope, taskId, read)) &&
      (!context.originatingActor ||
        (await validateTaskOperation(
          db,
          context.originatingActor,
          taskId,
          context.originatingOperation ?? read
        ))) &&
      (await repo.findSyncConfirmation(taskId, context))?.taskVersion === snapshot.taskVersion &&
      !(await repo.findSyncConfirmation(taskId, context))?.confirmation
    if (!(await allowed())) return false
    const adapter = scopedAdapter(state, context, allowed),
      options: { description?: string; dueDate?: string } = {}
    if (typeof task.description === "string" && task.description)
      options.description = task.description
    if (typeof task.due_date === "string" && task.due_date) options.dueDate = task.due_date
    const result = await providerOperation(state, context, () =>
      adapter.createTask(task.title, options)
    )
    if (!result.ok || !(await allowed())) return false
    return repo.saveSyncConfirmationForTask(
      taskId,
      {
        source: "grocy",
        grocyEntityType: "task",
        externalId: String(result.data.taskId),
        syncDirection: "outbound",
        payload: JSON.stringify({ title: task.title })
      },
      context,
      snapshot.taskVersion
    )
  } catch {
    logFailure("grocy.sync.create_task_failed")
    return false
  }
}

type MergeResult = { count: number; errors: number }
async function commit(
  mutations: SyncTaskMutation[],
  context: IntegrationScope
): Promise<MergeResult> {
  const result = await new TaskRepository(
    getPersistenceClient(),
    context.scope
  ).commitSyncMutationChunks(mutations, context)
  return { count: result.created + result.updated, errors: result.errors.length }
}
async function mergeGrocyChores(
  chores: GrocyChore[],
  context: IntegrationScope
): Promise<MergeResult> {
  const repo = new TaskRepository(getPersistenceClient(), context.scope),
    existing = await repo.findTasksByExternalSyncIds(
      {
        source: "grocy",
        grocyEntityType: "chore",
        externalIds: chores.map((chore) => String(chore.choreId))
      },
      context
    ),
    mutations: SyncTaskMutation[] = []
  for (const chore of chores) {
    const data = choreToTask(chore),
      match = existing.get(String(chore.choreId))
    if (
      match?.suppressed ||
      match?.taskDeleted ||
      (match && match.taskUpdatedAt > match.syncUpdatedAt)
    )
      continue
    const confirmation = {
      source: "grocy" as const,
      grocyEntityType: "chore" as const,
      externalId: String(chore.choreId),
      payload: JSON.stringify(chore)
    }
    if (match) {
      const current = await repo.findById(match.taskId)
      if (!current || Number(current.task_version) > match.syncUpdatedAt) continue
      mutations.push({
        kind: "update",
        taskId: match.taskId,
        title: data.title,
        status: data.status,
        dueDate: data.dueDate,
        updateDueDate: true,
        description: data.description,
        expected: { title: current.title, status: current.status, dueDate: current.due_date },
        confirmation
      })
    } else
      mutations.push({
        kind: "create",
        idempotencyKey: `grocy-chore-${chore.choreId}`,
        title: data.title,
        description: data.description,
        status: data.status,
        priority: data.priority,
        dueDate: data.dueDate,
        labels: data.labels,
        areaId: context.binding.destination.areaId,
        taskType: "task",
        confirmation: { ...confirmation, syncDirection: "inbound" }
      })
  }
  return commit(mutations, context)
}
async function mergeGrocyTasks(
  tasks: GrocyTask[],
  context: IntegrationScope,
  categoryNames?: Map<number, string>
): Promise<MergeResult> {
  const repo = new TaskRepository(getPersistenceClient(), context.scope),
    existing = await repo.findTasksByExternalSyncIds(
      {
        source: "grocy",
        grocyEntityType: "task",
        externalIds: tasks.map((task) => String(task.taskId))
      },
      context
    ),
    mutations: SyncTaskMutation[] = []
  for (const task of tasks) {
    const data = taskToTask(
        task,
        task.categoryId ? categoryNames?.get(task.categoryId) : undefined
      ),
      match = existing.get(String(task.taskId))
    if (match?.suppressed || match?.taskDeleted) continue
    const confirmation = {
      source: "grocy" as const,
      grocyEntityType: "task" as const,
      externalId: String(task.taskId),
      payload: JSON.stringify(task)
    }
    if (match) {
      const current = await repo.findById(match.taskId)
      if (!current) continue
      const modified = Number(current.task_version) > match.syncUpdatedAt
      if (modified && !task.done) continue
      mutations.push({
        kind: "update",
        taskId: match.taskId,
        ...(!modified
          ? {
              title: data.title,
              dueDate: data.dueDate,
              updateDueDate: true,
              description: data.description
            }
          : {}),
        status: data.status,
        expected: { title: current.title, status: current.status, dueDate: current.due_date },
        confirmation
      })
    } else
      mutations.push({
        kind: "create",
        idempotencyKey: `grocy-task-${task.taskId}`,
        title: data.title,
        description: data.description,
        status: data.status,
        priority: data.priority,
        dueDate: data.dueDate,
        labels: data.labels,
        areaId: context.binding.destination.areaId,
        taskType: "task",
        confirmation: { ...confirmation, syncDirection: "inbound" }
      })
  }
  return commit(mutations, context)
}
async function mergeShoppingList(
  items: { id?: number; productId: number; amount: number; note?: string }[],
  context: IntegrationScope,
  productNames?: Map<number, string>
): Promise<MergeResult> {
  const repo = new TaskRepository(getPersistenceClient(), context.scope),
    existing = await repo.findTasksByExternalSyncIds(
      { source: "grocy", grocyEntityType: "shopping", externalIds: ["list-1"] },
      context
    ),
    match = existing.get("list-1")
  if (match?.suppressed || match?.taskDeleted) return { count: 0, errors: 0 }
  const data = shoppingListToTask(items, productNames),
    confirmation = {
      source: "grocy" as const,
      grocyEntityType: "shopping" as const,
      externalId: "list-1",
      payload: JSON.stringify({ itemCount: items.length })
    }
  const mutation: SyncTaskMutation = match
    ? {
        kind: "update",
        taskId: match.taskId,
        title: data.title,
        description: data.description,
        replaceDescription: true,
        status: STATUS.PENDING,
        confirmation
      }
    : {
        kind: "create",
        idempotencyKey: "grocy-shopping-list-1",
        title: data.title,
        description: data.description,
        status: STATUS.PENDING,
        priority: 3,
        labels: data.labels,
        areaId: context.binding.destination.areaId,
        taskType: "task",
        confirmation: { ...confirmation, syncDirection: "inbound" }
      }
  return commit([mutation], context)
}
/** Reconciliation uses the common completion command; confirmation cleanup rechecks the same effect. */
async function cleanStaleTasks(seen: Set<string>, context: IntegrationScope): Promise<number> {
  const db = guardWorkPersistence(getPersistenceClient()),
    repo = new TaskRepository(db, context.scope)
  const { rows } = await db.execute(
    sql`SELECT confirmation_id,task_id,grocy_entity_type,grocy_entity_id FROM grocy_sync_confirmations WHERE binding_id=${context.binding.id}`
  )
  let errors = 0
  for (const ref of rows) {
    const type = String(ref.grocy_entity_type)
    if (!["chore", "task", "shopping"].includes(type) || seen.has(`${type}:${ref.grocy_entity_id}`))
      continue
    const id = String(ref.task_id),
      task = await repo.findById(id)
    if (!task) continue
    const result = await repo.commitSyncMutationChunks(
      [{ kind: "update", taskId: id, status: STATUS.COMPLETE, expected: { status: task.status } }],
      context
    )
    if (result.errors.length) {
      errors += result.errors.length
      continue
    }
    const tx = await db.transaction("write")
    try {
      if (
        !(await validateIntegrationScope(context, tx, { resource: "task", action: "complete" }))
          .ok ||
        !(await validateTaskOperation(tx, context.scope, id, {
          resource: "task",
          action: "complete"
        })) ||
        (context.originatingActor &&
          !(await validateTaskOperation(tx, context.originatingActor, id, {
            resource: "task",
            action: "complete"
          })))
      ) {
        errors++
        continue
      }
      await tx.execute(
        sql`DELETE FROM grocy_sync_confirmations WHERE confirmation_id=${String(ref.confirmation_id)} AND task_id=${id} AND binding_id=${context.binding.id} AND EXISTS(SELECT 1 FROM tasks WHERE tasks.id=${id} AND ${boardTaskOwnership(context.scope)} AND tasks.status=${STATUS.COMPLETE})`
      )
      await tx.commit()
    } finally {
      tx.close()
    }
  }
  return errors
}
