import type { Client } from "@libsql/client"
import type { WorkOperation } from "./board-scope"

export const WORK_DESTINATIONS_KEY = "work-destinations"

/** Authority metadata and other users' choices are not generic settings payloads. */
export function isPrivateWorkSetting(key: string): boolean {
  return key === WORK_DESTINATIONS_KEY
    || key === "capture-board-preferences"
    || key.startsWith("custom_fields:board:")
}

export type WorkDestination = Readonly<{ boardId: string, areaId?: string, projectId?: string }>
export type WorkBinding = Readonly<{
  id: string
  generation: number
  integration: string
  sourceId: string
  enabled: boolean
  retired?: true
  destination: WorkDestination
  allowedOperations: readonly WorkOperation[]
  purpose: string
  recipientUserIds?: readonly string[]
}>
export type WorkDestinations = Readonly<{ version: 1, revision: string, bindings: readonly WorkBinding[] }>

const resources = new Set(["board", "task", "area", "project", "goal", "routine", "pillar", "label"])
const actions = new Set(["read", "create", "edit", "move", "assign", "complete", "reopen", "delete", "manage", "retire", "restore", "propose"])
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
const identifier = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f]/.test(value)

/** Decode only the versioned authority metadata. Malformed data never gains a default destination. */
export function parseWorkDestinations(value: unknown): WorkDestinations | null {
  let candidate: unknown = value
  if (typeof candidate === "string") {
    try { candidate = JSON.parse(candidate) } catch { return null }
  }
  if (!object(candidate) || candidate.version !== 1 || !identifier(candidate.revision) || !Array.isArray(candidate.bindings)) return null
  const ids = new Set<string>()
  const bindings: WorkBinding[] = []
  for (const item of candidate.bindings) {
    if (!object(item) || !identifier(item.id) || ids.has(item.id) ||
      !Number.isSafeInteger(item.generation) || Number(item.generation) < 1 ||
      !identifier(item.integration) || !identifier(item.sourceId) || typeof item.enabled !== "boolean" ||
      item.retired !== undefined && item.retired !== true || item.retired === true && item.enabled ||
      !identifier(item.purpose) || !object(item.destination) || !identifier(item.destination.boardId) ||
      (item.recipientUserIds !== undefined && (!Array.isArray(item.recipientUserIds) ||
        !item.recipientUserIds.every(identifier) || new Set(item.recipientUserIds).size !== item.recipientUserIds.length)) ||
      (item.destination.areaId !== undefined && !identifier(item.destination.areaId)) ||
      (item.destination.projectId !== undefined && !identifier(item.destination.projectId)) ||
      !Array.isArray(item.allowedOperations)) return null
    const operations: WorkOperation[] = []
    const operationKeys = new Set<string>()
    for (const operation of item.allowedOperations) {
      if (!object(operation) || typeof operation.resource !== "string" || !resources.has(operation.resource) ||
        typeof operation.action !== "string" || !actions.has(operation.action)) return null
      const key = `${operation.resource}:${operation.action}`
      if (operationKeys.has(key)) return null
      operationKeys.add(key)
      operations.push(Object.freeze({ resource: operation.resource, action: operation.action }) as WorkOperation)
    }
    if (item.enabled && operations.length === 0) return null
    ids.add(item.id)
    bindings.push(Object.freeze({
      id: item.id, generation: Number(item.generation), integration: item.integration, sourceId: item.sourceId,
      enabled: item.enabled, purpose: item.purpose, ...(item.retired === true ? { retired: true as const } : {}),
      ...(item.recipientUserIds === undefined ? {} : { recipientUserIds: Object.freeze([...item.recipientUserIds as string[]]) }),
      destination: Object.freeze({ boardId: item.destination.boardId,
        ...(item.destination.areaId === undefined ? {} : { areaId: item.destination.areaId }),
        ...(item.destination.projectId === undefined ? {} : { projectId: item.destination.projectId }),
      }), allowedOperations: Object.freeze(operations),
    }))
  }
  return Object.freeze({ version: 1, revision: candidate.revision, bindings: Object.freeze(bindings) })
}

/** Internal metadata discovery only. This result supplies no work-reading authority. */
export async function readWorkDestinations(db: Pick<Client, "execute">): Promise<WorkDestinations | null> {
  const { rows: [row] } = await db.execute({ sql: "SELECT value FROM settings WHERE key = ?", args: [WORK_DESTINATIONS_KEY] })
  return row ? parseWorkDestinations(row.value) : null
}

export function bindingAllows(binding: WorkBinding, operation: WorkOperation): boolean {
  return binding.enabled && binding.allowedOperations.some(item => item.resource === operation.resource && item.action === operation.action)
}

/** Never substitute a replacement binding for a disabled, missing or stale original. */
export function selectWorkBinding(configuration: WorkDestinations | null, id: string, generation?: number): WorkBinding | null {
  const binding = configuration?.bindings.find(item => item.id === id)
  return binding?.enabled && !binding.retired && (generation === undefined || generation === binding.generation) ? binding : null
}
