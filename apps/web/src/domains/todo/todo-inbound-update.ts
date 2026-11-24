import type { Client } from "@libsql/client"
import { TaskRepository, type IntegrationScope } from "@domains/tasks"
import type { MeithealStatus } from "./todo-status-mapper"

/** Compatibility adapter; the common binding-scoped writer owns update and confirmation atomically. */
export async function applyInboundTodoUpdate(client: Client, input: {
  confirmationId: string, taskId: string, entityId: string, uid: string, title: string,
  status: MeithealStatus, openEcho: boolean, due: string | null, description: string | null, payload: string,
}, context: IntegrationScope): Promise<boolean> {
  if (!context || context.binding.sourceId !== input.entityId || context.binding.purpose !== "todo.sync") return false
  const result = await new TaskRepository(client, context.scope).commitSyncMutationChunks([{
    kind: "update", taskId: input.taskId, title: input.title, status: input.status, openEcho: input.openEcho,
    dueDate: input.due, updateDueDate: true, description: input.description, updatedAt: Date.now(),
    confirmation: { source: "ha_todo", confirmationId: input.confirmationId, entityId: input.entityId,
      externalId: input.uid, payload: input.payload, requireUnmodifiedSinceSync: true },
  }], context)
  return result.updated === 1 && result.errors.length === 0
}
