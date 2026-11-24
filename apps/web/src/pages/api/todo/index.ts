import type { APIRoute } from "astro"
import {
  ensureSchema, getPersistenceClient, readWorkDestinations, resolveIntegrationScope, validateIntegrationScope,
  type BoardScope, type WorkOperation, type WorkBinding, type IntegrationScope,
} from "@domains/tasks"
import { getTodoEntities } from "@domains/ha"
import { getTodoSyncStatus } from "@domains/todo"
import { withBoardScope } from "@lib/board-http"
import { apiJson } from "@lib/api-response"

export async function todoRequestBinding(scope: BoardScope, input: Record<string, unknown>, operation: WorkOperation): Promise<IntegrationScope | null> {
  if (typeof input.binding_id !== "string" || !Number.isSafeInteger(input.generation) || Number(input.generation) < 1) return null
  await ensureSchema()
  const result = await resolveIntegrationScope(getPersistenceClient(), input.binding_id, Number(input.generation), { resource: "task", action: "read" }, scope, operation)
  if (!result.ok || result.value.binding.integration !== "todo" || result.value.binding.purpose !== "todo.sync" ||
    input.entity_id !== undefined && input.entity_id !== result.value.binding.sourceId) return null
  return result.value
}
export async function visibleTodoBindings(scope: BoardScope): Promise<WorkBinding[]> {
  await ensureSchema()
  const db = getPersistenceClient()
  const configuration = await readWorkDestinations(db)
  const bindings: WorkBinding[] = []
  for (const binding of configuration?.bindings ?? []) {
    if (!binding.enabled || binding.integration !== "todo" || binding.purpose !== "todo.sync" || binding.destination.boardId !== scope.boardId) continue
    const result = await resolveIntegrationScope(db, binding.id, binding.generation, { resource: "task", action: "read" }, scope)
    if (result.ok && (await validateIntegrationScope(result.value, db, { resource: "task", action: "read" })).ok) bindings.push(binding)
  }
  return bindings
}
export const GET: APIRoute = withBoardScope({ resource: "task", action: "read" }, async (_context, scope) => {
  const bindings = await visibleTodoBindings(scope)
  const metadata = getTodoEntities()
  return apiJson({ ok: true, entities: bindings.map(binding => {
    const entity = metadata.find(entity => entity.entity_id === binding.sourceId)
    const status = getTodoSyncStatus(binding.id)
    return { binding_id: binding.id, generation: binding.generation, board_id: scope.boardId,
      entity_id: binding.sourceId, friendly_name: entity?.attributes?.friendly_name ?? binding.sourceId,
      sync: status?.generation === binding.generation ? status : null }
  }) })
})
