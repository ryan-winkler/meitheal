import {
  getPersistenceClient, readWorkDestinations, validateBoardScope, resolveIntegrationScope,
  type BoardScope, type WorkOperation, type WorkBinding,
} from "@domains/tasks"

/** Compatibility entity selectors identify one approved binding in the selected Board only. */
export async function requestIntegrationBinding(scope: BoardScope, integration: string,
  purpose: string, input: Record<string, unknown>, operation: WorkOperation) {
  const db = getPersistenceClient()
  if (!(await validateBoardScope(scope, db, operation)).ok) return null
  const configuration = await readWorkDestinations(db)
  const matches = configuration?.bindings.filter(binding => binding.enabled && binding.integration === integration &&
    binding.purpose === purpose && binding.destination.boardId === scope.boardId &&
    (input.binding_id === undefined || binding.id === input.binding_id) &&
    (input.generation === undefined || binding.generation === input.generation) &&
    (input.entity_id === undefined || binding.sourceId === input.entity_id)) ?? []
  if (matches.length !== 1) return null
  return resolveIntegrationScope(db, matches[0]!.id, matches[0]!.generation, { resource: "task", action: "read" }, scope, operation)
}
export async function visibleIntegrationBindings(scope: BoardScope, integrations: readonly string[]): Promise<readonly WorkBinding[]> {
  const db = getPersistenceClient()
  if (!(await validateBoardScope(scope, db, { resource: "task", action: "read" })).ok) return []
  return (await readWorkDestinations(db))?.bindings.filter(binding => binding.enabled &&
    integrations.includes(binding.integration) && binding.destination.boardId === scope.boardId) ?? []
}
