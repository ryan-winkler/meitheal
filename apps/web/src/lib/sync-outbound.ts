import {
  getPersistenceClient, readWorkDestinations, resolveIntegrationScope, readTaskDeletionReceipt,
  type BoardScope, type TaskDeletionReceipt, type WorkOperation,
} from "@domains/tasks"
import { createLogger, defaultRedactionPatterns } from "@meitheal/domain-observability"

const logger = createLogger({ service: "meitheal-web", env: process.env.NODE_ENV ?? "development",
  minLevel: "info", enabledCategories: ["integrations"], redactPatterns: defaultRedactionPatterns, auditEnabled: false })

/** One ordinary task event pipeline. Each receiver rereads current work through its approved binding. */
export async function pushToActiveSyncs(eventType: string, payload: Record<string, unknown>,
  actor: BoardScope, deletion?: TaskDeletionReceipt): Promise<void> {
  if (!["task.created", "task.updated", "task.completed", "task.deleted"].includes(eventType)) return
  const taskId = typeof payload.id === "string" ? payload.id : ""
  if (!taskId) return
  const db = getPersistenceClient()
  if (eventType === "task.deleted" && (!deletion ||
    !await readTaskDeletionReceipt(db, actor, deletion.eventId, taskId))) return
  const operation: WorkOperation = { resource: "task", action: eventType === "task.created" ? "create"
    : eventType === "task.deleted" ? "delete" : eventType === "task.completed" ? "complete" : "edit" }
  const configuration = await readWorkDestinations(db)
  for (const binding of configuration?.bindings ?? []) {
    if (!binding.enabled || binding.destination.boardId !== actor.boardId ||
      !["todo.sync", "calendar.sync", "grocy.sync"].includes(binding.purpose)) continue
    if (deletion && !deletion.bindingRefs.some(ref => ref.id === binding.id && ref.generation === binding.generation)) continue
    const resolved = await resolveIntegrationScope(db, binding.id, binding.generation,
      { resource: "task", action: "read" }, actor, operation)
    if (!resolved.ok) continue
    try {
      if (binding.purpose === "todo.sync") {
        const { pushTaskToTodoList, removeTaskFromTodoList } = await import("@domains/todo")
        if (deletion) await removeTaskFromTodoList(taskId, resolved.value, deletion)
        else await pushTaskToTodoList(taskId, "", "", binding.sourceId, undefined, undefined, undefined, resolved.value)
      } else if (binding.purpose === "calendar.sync") {
        const { pushTaskToCalendar, removeTaskCalendarEvent, isImportedCalendarTask } = await import("@domains/calendar")
        if (deletion) await removeTaskCalendarEvent(resolved.value, deletion)
        else if (!await isImportedCalendarTask(taskId, resolved.value)) {
          await pushTaskToCalendar(resolved.value, taskId, "", "")
        }
      } else if (!deletion && payload.status === "complete") {
        const { pushCompletionToGrocy } = await import("@domains/grocy")
        await pushCompletionToGrocy(taskId, resolved.value)
      }
    } catch {
      logger.log("warn", { event: "sync.outbound.unavailable", domain: "integrations", component: "sync-outbound",
        request_id: "system", message: "An approved outbound sync could not finish" })
    }
  }
}
