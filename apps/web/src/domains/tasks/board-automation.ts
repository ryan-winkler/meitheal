import type { Client } from "@libsql/client"
import { BoardAccessService, validateBoardPlacement } from "./board-access-service"
import {
  registerVerifiedPrincipal, validateBoardScope, scopeServiceDestination,
  type BoardScope, type ScopeFailure, type ScopeResult, type WorkOperation,
} from "./board-scope"
import {
  bindingAllows, readWorkDestinations, selectWorkBinding,
  type WorkBinding,
} from "./integration-destinations"
import { ownedPlanning } from "./persistence/board-storage"
import { sql } from "./persistence/sql-fragment"

export type IntegrationScope = Readonly<{
  binding: WorkBinding
  scope: BoardScope
  originatingActor?: BoardScope
  originatingOperation?: WorkOperation
}>
export type IntegrationScopeResult = { ok: true, value: IntegrationScope } |
  { ok: false, errorCode: ScopeFailure | "destination_unavailable" }

const admitted = new WeakSet<IntegrationScope>()

async function placementAvailable(db: Pick<Client, "execute">, scope: BoardScope, binding: WorkBinding): Promise<boolean> {
  const { areaId, projectId } = binding.destination
  let effectiveAreaId = areaId
  if (areaId) {
    const { rows } = await db.execute(sql`SELECT area.id FROM areas AS area
      WHERE area.id = ${areaId} AND ${ownedPlanning(scope, "area")} AND area.retired_at IS NULL`)
    if (!rows.length) return false
  }
  if (projectId) {
    const { rows: [project] } = await db.execute(sql`SELECT project.id, project.area_id FROM projects AS project
      WHERE project.id = ${projectId} AND ${ownedPlanning(scope, "project")} AND project.retired_at IS NULL`)
    if (typeof project?.area_id === "string") effectiveAreaId = project.area_id
    if (!project || (project.area_id !== null && typeof project.area_id !== "string") ||
      areaId && project.area_id !== areaId) return false
    if (project.area_id !== null && !areaId) {
      const { rows } = await db.execute(sql`SELECT area.id FROM areas AS area
        WHERE area.id = ${project.area_id} AND ${ownedPlanning(scope, "area")} AND area.retired_at IS NULL`)
      if (!rows.length) return false
    }
  }
  const ceiling = scopeServiceDestination(scope)
  if (ceiling && (ceiling.boardId !== binding.destination.boardId ||
    ceiling.areaId && ceiling.areaId !== effectiveAreaId ||
    ceiling.projectId && ceiling.projectId !== projectId)) return false
  return validateBoardPlacement(scope, db, { areaId: effectiveAreaId ?? null, projectId: projectId ?? null })
}

/** Trusted server entrypoint only; HTTP headers and provider user strings never supply a principal. */
export async function resolveIntegrationScope(
  db: Client,
  bindingId: string,
  generation: number,
  operation: WorkOperation,
  originatingActor?: BoardScope,
  originatingOperation: WorkOperation = operation,
): Promise<IntegrationScopeResult> {
  const binding = selectWorkBinding(await readWorkDestinations(db), bindingId, generation)
  if (!binding || !bindingAllows(binding, operation)) return { ok: false, errorCode: "unavailable" }
  if (originatingActor) {
    if (originatingActor.boardId !== binding.destination.boardId) return { ok: false, errorCode: "denied" }
    const human = await validateBoardScope(originatingActor, db, originatingOperation)
    if (!human.ok) return human
  }
  const principal = registerVerifiedPrincipal({
    kind: "service", id: binding.id, bindingId: binding.id, bindingGeneration: binding.generation,
  }, { expiresAt: Date.now() + 30_000, administrator: false })
  const resolved = await new BoardAccessService(db).resolve(principal, binding.destination.boardId, operation)
  if (!resolved.ok) return resolved
  const value: IntegrationScope = Object.freeze({ binding, scope: resolved.scope,
    ...(originatingActor ? { originatingActor, originatingOperation: Object.freeze({ ...originatingOperation }) } : {}),
  })
  admitted.add(value)
  const current = await validateIntegrationScope(value, db, operation)
  return current.ok ? { ok: true, value } : current
}

/** Call before each provider dispatch/retry and inside the actual final SQLite writer. */
export async function validateIntegrationScope(
  context: IntegrationScope,
  db: Pick<Client, "execute">,
  operation: WorkOperation,
): Promise<{ ok: true } | { ok: false, errorCode: ScopeFailure | "destination_unavailable" }> {
  if (!admitted.has(context)) return { ok: false, errorCode: "denied" }
  const current = selectWorkBinding(await readWorkDestinations(db), context.binding.id, context.binding.generation)
  // A changed source, placement, ceiling or purpose also invalidates an in-flight
  // operation, even if a malformed writer failed to increment its generation.
  if (!current || JSON.stringify(current) !== JSON.stringify(context.binding) || !bindingAllows(current, operation)) {
    return { ok: false, errorCode: "stale" }
  }
  const service = await validateBoardScope(context.scope, db, operation)
  if (!service.ok) return service
  if (context.originatingActor) {
    const human = await validateBoardScope(context.originatingActor, db, context.originatingOperation ?? operation)
    if (!human.ok) return human
    if (!await placementAvailable(db, context.originatingActor, current)) return { ok: false, errorCode: "destination_unavailable" }
    // Reading work for an approved outward channel does not grant the sender
    // read access. A new local mutation effect still needs that actor's right.
    if (operation.action !== "read" && (operation.resource !== context.originatingOperation?.resource ||
      operation.action !== context.originatingOperation?.action)) {
      const effect = await validateBoardScope(context.originatingActor, db, operation)
      if (!effect.ok) return effect
    }
  }
  if (!await placementAvailable(db, context.scope, current)) return { ok: false, errorCode: "destination_unavailable" }
  return { ok: true }
}

export function integrationOperationAllowed(context: IntegrationScope, db: Pick<Client, "execute">, operation: WorkOperation): () => Promise<boolean> {
  return async () => (await validateIntegrationScope(context, db, operation)).ok
}

/** Verify a recipient only from an admitted channel's owner-approved audience. */
export async function resolveIntegrationRecipient(db: Client, context: IntegrationScope, userId: string): Promise<ScopeResult> {
  if (!admitted.has(context) || context.binding.purpose !== "notify.delivery" ||
    !context.binding.recipientUserIds?.includes(userId)) return { ok: false, errorCode: "denied" }
  const current = await validateIntegrationScope(context, db, { resource: "task", action: "read" })
  if (!current.ok) return { ok: false, errorCode: current.errorCode === "destination_unavailable" ? "unavailable" : current.errorCode }
  const { readCurrentHARole } = await import("../ha")
  const role = await readCurrentHARole(userId, AbortSignal.timeout(2_000))
  if (role !== "admin" && role !== "member") return { ok: false, errorCode: "unavailable" }
  const principal = registerVerifiedPrincipal({ kind: "ha_user", id: userId }, {
    administrator: role === "admin", expiresAt: Date.now() + 5_000,
  })
  return new BoardAccessService(db).resolve(principal, context.scope.boardId, { resource: "task", action: "read" })
}
