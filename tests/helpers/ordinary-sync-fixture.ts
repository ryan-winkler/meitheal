import { registerVerifiedPrincipal, type BoardScope, type WorkAction } from "../../apps/web/src/domains/tasks/board-scope"
import { BoardAccessService } from "../../apps/web/src/domains/tasks/board-access-service"
import { resolveIntegrationScope } from "../../apps/web/src/domains/tasks/board-automation"
import { getPersistenceClient } from "./persistence-fixture"
import { TaskRepository } from "../../apps/web/src/domains/tasks/persistence/task-repository"
import { prepareTaskCreation } from "../../apps/web/src/domains/tasks/task-creation-service"

/** Synthetic authority setup only. Work execution always uses actual minted scopes and production commands. */
export async function syncFixture(boardId = "household") {
  const db = getPersistenceClient()
  const operations = (["read", "create", "edit", "move", "assign", "complete", "reopen", "delete"] as WorkAction[]).map(action => ({ resource: "task" as const, action }))
  const binding = { id: `calendar-fixture-${boardId}`, integration: "calendar", sourceId: "calendar.home", purpose: "calendar.sync", enabled: true, generation: 1, destination: { boardId }, allowedOperations: operations }
  const config = { version: 1, revision: "fixture-configuration", bindings: [binding] }
  await db.execute({ sql: "INSERT INTO settings(key,value,updated_at) VALUES ('work-destinations',?,1) ON CONFLICT(key) DO UPDATE SET value=excluded.value", args: [JSON.stringify(config)] })
  await db.execute({ sql: "INSERT INTO board_access_grants(board_id,principal_type,principal_id,role,authority_limits) VALUES (?,'service',?,'service',?)", args: [boardId, binding.id, JSON.stringify({ purpose: "calendar.sync", operations })] })
  const principal = registerVerifiedPrincipal({ kind: "ha_user", id: "fixture-parent" }, { administrator: true, expiresAt: Date.now() + 60_000 })
  const resolved = await new BoardAccessService(db).resolve(principal, boardId, { resource: "task", action: "create" })
  if (!resolved.ok) throw new Error(resolved.errorCode)
  const context = await resolveIntegrationScope(db, binding.id, 1, { resource: "task", action: "edit" }, resolved.scope)
  if (!context.ok) throw new Error(context.errorCode)
  return { db, binding, config, principal, scope: resolved.scope, context: context.value }
}
export async function ordinaryTask(scope: BoardScope, title: string, clientKey = title) {
  const repo = new TaskRepository(getPersistenceClient(), scope)
  const prepared = await prepareTaskCreation(repo, { title, framework_payload: JSON.stringify({ rice: 7 }) }, { useDefaultAssignee: false })
  if (!prepared.ok) throw new Error(prepared.error)
  const result = await repo.createWorkCommand(prepared.task, { clientIdempotencyKey: clientKey })
  if (!result.ok) throw new Error(result.errorCode)
  return result
}
export function syncMutation(title: string, key = title) {
  return { kind: "create" as const, title, idempotencyKey: key, taskKind: "calendar_event", confirmation: { source: "calendar" as const, entityId: "calendar.home", externalId: "provider-" + key, payload: JSON.stringify({ entity_id: "calendar.home", title }) } }
}
