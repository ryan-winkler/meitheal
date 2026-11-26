/**
 * Manual Push Task to Calendar API
 *
 * POST /api/integrations/calendar/push
 * Body: { task_id: string, entity_id?: string }
 *
 * Pushes a single authorized task to the Board's enabled Home Assistant calendar
 * sync binding(s) on demand. Enforces board scope authorization before processing,
 * rejects imported calendar tasks and Meitheal reminder artifacts to preserve the
 * strict one-ticket-per-invite invariant.
 *
 * @domain calendar
 * @bounded-context integration
 */
import type { APIRoute } from "astro"
import {
  TaskRepository,
  getPersistenceClient,
  readWorkDestinations,
  resolveIntegrationScope,
} from "@domains/tasks"
import {
  hasCalendarSyncOptOut,
  isImportedCalendarTask,
  isMeithealOriginatedEvent,
  pushTaskToCalendar,
} from "@domains/calendar"
import { withBoardScope } from "@lib/board-http"
import { apiJson, apiError } from "@lib/api-response"
import { logApiError } from "@lib/api-logger"

export const POST: APIRoute = withBoardScope(
  { resource: "task", action: "edit" },
  async (context, scope) => {
    try {
      const raw: unknown = await context.request.json().catch(() => null)
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        return apiError("Provide a valid task_id to push to a calendar.", 400)
      }
      const body = raw as Record<string, unknown>
      if (Object.hasOwn(body, "board_id")) {
        return apiError("Select the Board using the request context.", 400)
      }
      const taskId = typeof body.task_id === "string" ? body.task_id.trim() : ""
      if (!taskId || taskId.length > 128) {
        return apiError("task_id is required.", 400)
      }
      const requestedEntityId =
        typeof body.entity_id === "string" && body.entity_id.trim()
          ? body.entity_id.trim()
          : undefined

      const db = getPersistenceClient()
      const repo = new TaskRepository(db, scope)
      const task = await repo.findById(taskId)
      if (!task) {
        return apiError("Task not found on this Board.", 404)
      }
      if (hasCalendarSyncOptOut(task.labels)) {
        return apiError("This task has the no-sync label. Remove the label to send it to a calendar.", 409)
      }

      const scheduledStart =
        task.task_kind === "calendar_event"
          ? typeof task.start_date === "string" && task.start_date.trim()
            ? task.start_date.trim()
            : task.due_date
          : task.due_date
      if (typeof scheduledStart !== "string" || !scheduledStart.trim()) {
        return apiError(
          "Set a due date or event start time before pushing to a calendar.",
          400
        )
      }

      if (
        isMeithealOriginatedEvent(
          task.title,
          typeof task.description === "string" ? task.description : null
        )
      ) {
        return apiError(
          "Calendar reminder artifacts cannot be pushed back to a calendar.",
          409
        )
      }

      const destinations = await readWorkDestinations(db)
      const bindings = (destinations?.bindings ?? []).filter(
        (binding) =>
          binding.enabled &&
          binding.destination.boardId === scope.boardId &&
          binding.purpose === "calendar.sync" &&
          binding.integration === "calendar" &&
          (!requestedEntityId || binding.sourceId === requestedEntityId)
      )

      if (bindings.length === 0) {
        return apiError(
          "No calendar sync binding is enabled for this Board. Configure one in Settings → Integrations.",
          404
        )
      }

      const pushedEntityIds: string[] = []
      let skippedImported = 0
      for (const binding of bindings) {
        const resolved = await resolveIntegrationScope(
          db,
          binding.id,
          binding.generation,
          { resource: "task", action: "read" },
          scope,
          { resource: "task", action: "edit" }
        )
        if (!resolved.ok) continue
        if (await isImportedCalendarTask(taskId, resolved.value)) {
          skippedImported++
          continue
        }
        const ok = await pushTaskToCalendar(
          resolved.value,
          taskId,
          "",
          "",
          undefined,
          undefined,
          true
        )
        if (ok) pushedEntityIds.push(binding.sourceId)
      }

      if (pushedEntityIds.length === 0) {
        if (skippedImported > 0) {
          return apiError(
            "This ticket originated from a calendar invite and is already synced.",
            409
          )
        }
        return apiError(
          "Could not push to the connected Home Assistant calendar. Verify the HA connection in Settings → Integrations.",
          502
        )
      }

      return apiJson({
        ok: true,
        pushed: pushedEntityIds.length,
        entityIds: pushedEntityIds,
      })
    } catch (error) {
      logApiError("calendar-push", "POST error", error)
      return apiError("Failed to push task to calendar.")
    }
  },
  { write: true }
)
