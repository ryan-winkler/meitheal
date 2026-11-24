import type { Client } from "@libsql/client"
import {
  boardOperationClient, BoardOperationError, ensureSchema, getPersistenceClient,
  readWorkDestinations, resolveIntegrationRecipient, resolveIntegrationScope, TaskRepository,
  validateIntegrationScope, validateTaskOperation, recentActivityPersonKey,
  type BoardScope, type IntegrationScope, type WorkBinding,
} from "@domains/tasks"
import { isClosedStatus } from "./status-config"
import { taskHttpProjection } from "./task-http-projection"
import { dispatchTaskEvent } from "./webhook-dispatcher"

const prefix = "MEITHEAL_DONE_V1:"
const read = { resource: "task", action: "read" } as const
const complete = { resource: "task", action: "complete" } as const
const edit = { resource: "task", action: "edit" } as const
const identifier = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,149}$/.test(value)
const generation = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0
const version = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)
type Action = readonly [1, string, string, number, string, number, string, number]

function decode(value: unknown): Action | null {
  if (typeof value !== "string" || value.length > 1024 || !value.startsWith(prefix)) return null
  const encoded = value.slice(prefix.length)
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) return null
  try {
    const bytes = Buffer.from(encoded, "base64url")
    if (bytes.toString("base64url") !== encoded) return null
    const result: unknown = JSON.parse(bytes.toString("utf8"))
    return Array.isArray(result) && result.length === 8 && result[0] === 1 && identifier(result[1]) && identifier(result[2]) &&
      version(result[3]) && identifier(result[4]) && generation(result[5]) && identifier(result[6]) && generation(result[7]) ? result as unknown as Action : null
  } catch { return null }
}
function matches(binding: WorkBinding, boardId: string, target: string, integration: string, purpose: string) {
  return binding.enabled && binding.destination.boardId === boardId && binding.sourceId === target && binding.integration === integration && binding.purpose === purpose
}
async function admission(db: Client, binding: WorkBinding, taskId: string, actor?: BoardScope): Promise<IntegrationScope | null> {
  const action = binding.purpose === "notify.task.complete"
  const resolved = await resolveIntegrationScope(db, binding.id, binding.generation, action ? complete : read, actor, complete)
  if (!resolved.ok || !await validateTaskOperation(db, resolved.value.scope, taskId, action ? complete : read)) return null
  return resolved.value
}
async function permittedActor(db: Client, delivery: IntegrationScope, userId: string, taskId: string): Promise<BoardScope | null> {
  const resolved = await resolveIntegrationRecipient(db, delivery, userId)
  if (!resolved.ok) return null
  for (const operation of [read, edit, complete]) if (!await validateTaskOperation(db, resolved.scope, taskId, operation)) return null
  return resolved.scope
}

/** Public identifiers identify the approved action, never grant completion authority. */
export async function createTaskNotificationDoneAction(boardId: string, target: string, taskId: string, expectedVersion?: number): Promise<string | null> {
  if (expectedVersion !== undefined && !version(expectedVersion)) return null
  if (!identifier(boardId) || !identifier(taskId) || !/^notify\.mobile_app_[a-z0-9_]+$/.test(target)) return null
  try {
    await ensureSchema()
    const db = getPersistenceClient()
    const bindings = (await readWorkDestinations(db))?.bindings ?? []
    const deliveries: IntegrationScope[] = []
    for (const binding of bindings) {
      if (!matches(binding, boardId, target, "notification", "notify.delivery") || !binding.recipientUserIds?.length) continue
      const current = await admission(db, binding, taskId)
      if (current) deliveries.push(current)
    }
    // A physical mobile target cannot prove which of several overlapping audiences received a button.
    if (deliveries.length !== 1) return null
    const delivery = deliveries[0]!
    const task = await new TaskRepository(db, delivery.scope).findById(taskId)
    const taskVersion = task?.task_version
    if (!task || !version(taskVersion) || expectedVersion !== undefined && taskVersion !== expectedVersion || isClosedStatus(task.status)) return null
    for (const binding of bindings) {
      if (!matches(binding, boardId, target, "notification_action", "notify.task.complete") ||
        !binding.recipientUserIds?.length || !delivery.binding.recipientUserIds!.every(id => binding.recipientUserIds!.includes(id))) continue
      const action = await admission(db, binding, taskId)
      if (!action) continue
      const recipients: BoardScope[] = []
      let eligible = true
      for (const id of delivery.binding.recipientUserIds!) {
        const actor = await permittedActor(db, delivery, id, taskId)
        if (!actor) { eligible = false; break }
        recipients.push(actor)
      }
      if (!eligible) continue
      if (!(await validateIntegrationScope(delivery, db, read)).ok || !(await validateIntegrationScope(action, db, complete)).ok) continue
      for (const actor of recipients) for (const operation of [read, edit, complete]) {
        if (!await validateTaskOperation(db, actor, taskId, operation)) eligible = false
      }
      if (!eligible) continue
      const latest = await new TaskRepository(db, delivery.scope).findById(taskId)
      if (!latest || latest.task_version !== taskVersion || isClosedStatus(latest.status)) continue
      const value: Action = [1, boardId, taskId, taskVersion, binding.id, binding.generation, delivery.binding.id, delivery.binding.generation]
      const encoded = prefix + Buffer.from(JSON.stringify(value)).toString("base64url")
      return encoded.length <= 1024 ? encoded : null
    }
  } catch { /* Missing, revoked or uncertain authority leaves the ordinary notification intact. */ }
  return null
}

/** Called only by the current authenticated HA WebSocket event subscription. */
export async function handleTaskNotificationAction(event: unknown, isCurrentConnection: () => boolean): Promise<boolean> {
  try {
    if (!isCurrentConnection() || !record(event) || event.event_type !== "mobile_app_notification_action" ||
      !Object.hasOwn(event, "context") || !record(event.context) || !Object.hasOwn(event.context, "user_id") ||
      !identifier(event.context.user_id) || !record(event.data)) return false
    const action = decode(event.data.action)
    if (!action) return false
    const [, boardId, taskId, taskVersion, actionId, actionGeneration, deliveryId, deliveryGeneration] = action
    await ensureSchema()
    const db = getPersistenceClient()
    const bindings = (await readWorkDestinations(db))?.bindings ?? []
    const actionBinding = bindings.find(binding => binding.id === actionId && binding.generation === actionGeneration)
    const deliveryBinding = bindings.find(binding => binding.id === deliveryId && binding.generation === deliveryGeneration)
    if (!actionBinding || !deliveryBinding ||
      !matches(actionBinding, boardId, actionBinding.sourceId, "notification_action", "notify.task.complete") ||
      !/^notify\.mobile_app_[a-z0-9_]+$/.test(actionBinding.sourceId) ||
      !matches(deliveryBinding, boardId, actionBinding.sourceId, "notification", "notify.delivery") ||
      !actionBinding.recipientUserIds?.includes(event.context.user_id) || !deliveryBinding.recipientUserIds?.includes(event.context.user_id) ||
      !deliveryBinding.recipientUserIds.every(id => actionBinding.recipientUserIds!.includes(id))) return false
    const delivery = await admission(db, deliveryBinding, taskId)
    if (!delivery || !isCurrentConnection()) return false
    const actor = await permittedActor(db, delivery, event.context.user_id, taskId)
    if (!actor || !isCurrentConnection()) return false
    const service = await admission(db, actionBinding, taskId, actor)
    if (!service) return false
    const task = await new TaskRepository(db, actor).findById(taskId)
    if (!task || task.task_version !== taskVersion || isClosedStatus(task.status)) return false
    // This callback only restricts a common authorized human writer. It cannot add a right.
    const check = async (reader: Pick<Client, "execute">) => {
      if (!isCurrentConnection() || !(await validateIntegrationScope(delivery, reader, read)).ok ||
        !(await validateIntegrationScope(service, reader, complete)).ok) throw new BoardOperationError("denied")
      for (const [scope, operation] of [[actor, read], [actor, edit], [actor, complete], [delivery.scope, read], [service.scope, complete]] as const) {
        if (!await validateTaskOperation(reader, scope, taskId, operation)) throw new BoardOperationError("denied")
      }
      if (!isCurrentConnection()) throw new BoardOperationError("denied")
    }
    const guarded = boardOperationClient(db, actor, complete, [taskId], undefined, check)
    const updated = await new TaskRepository(guarded, actor).updateTask(taskId, { status: "complete" }, {
      version: { updatedAt: taskVersion },
      activity: { kind: "human", personKey: recentActivityPersonKey(event.context.user_id) },
      ...(typeof event.context.id === "string" && event.context.id.length <= 128 ? { activityRequestId: event.context.id } : {}),
    })
    if (!updated.ok) return false
    if (isCurrentConnection()) await dispatchTaskEvent("task.completed", taskHttpProjection(updated.task, boardId), undefined, undefined, undefined, undefined, actor)
    return true
  } catch { return false }
}
