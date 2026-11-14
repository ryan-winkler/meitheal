import { hasScope } from "@meitheal/domain-auth"
import { TaskRepository, ensureSchema, getPersistenceClient } from "@domains/tasks"
import type { ResolvedAgent } from "./agent-token-guard"
import { isActiveStatus, isDoneStatus, normalizeStatus } from "./status-config"

/**
 * Meitheal tasks in A2A's task shape. A2A tasks here are the household's own
 * tasks, read through the token's scopes; nothing is invented for the protocol.
 */

type Row = Record<string, unknown>

function state(status: unknown): string {
  const value = normalizeStatus(String(status ?? ""))
  if (value === "cancelled" || value === "canceled") return "TASK_STATE_CANCELED"
  if (isDoneStatus(value)) return "TASK_STATE_COMPLETED"
  return isActiveStatus(value) ? "TASK_STATE_WORKING" : "TASK_STATE_SUBMITTED"
}

function updatedTimestampMs(row: Row): number | undefined {
  const value = row.task_version ?? row.updated_at
  const ms = typeof value === "number" ? value : Date.parse(String(value ?? ""))
  return Number.isFinite(ms) ? ms : undefined
}

function timestamp(value: unknown): string | undefined {
  const ms = typeof value === "number" ? value : Date.parse(String(value ?? ""))
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined
}

export function toA2aTask(row: Row, base: string, includeArtifacts = true) {
  const id = String(row.id)
  const ticket = row.ticket_number == null ? null : `MTH-${row.ticket_number}`
  const updated = timestamp(row.task_version ?? row.updated_at)
  return {
    id,
    // One conversation per task keeps follow-up reads grouped by the client.
    contextId: id,
    status: { state: state(row.status), ...(updated ? { timestamp: updated } : {}) },
    ...(includeArtifacts ? {
      artifacts: [{
        artifactId: `${id}:task`,
        name: String(row.title ?? ""),
        parts: [{
          data: {
            id,
            ticket_key: ticket,
            title: row.title,
            description: row.description ?? "",
            status: row.status,
            priority: row.priority ?? null,
            due_date: row.due_date ?? null,
            assigned_to: row.assigned_to ?? null,
            url: `${base}/tasks?open=${encodeURIComponent(id)}`,
          },
          mediaType: "application/json",
        }],
      }],
    } : {}),
    metadata: { ticket_key: ticket, meitheal_status: row.status },
  }
}

const canRead = (agent: ResolvedAgent) => hasScope(agent.scopes, "tasks:read")

/** One task by ID or ticket key, or null when it is missing or the token may not read tasks. */
export async function getA2aTask(agent: ResolvedAgent, idOrKey: string, base: string) {
  if (!canRead(agent) || !/^[\w-]{1,128}$/.test(idOrKey)) return null
  await ensureSchema()
  const repo = new TaskRepository(getPersistenceClient())
  const resolved = await repo.resolveTaskId(idOrKey)
  const row = resolved ? await repo.findById(resolved.id) : null
  return row ? toA2aTask(row as unknown as Row, base) : null
}

/** The open tasks assigned to the token's agent assignee, newest change first. */
export async function listA2aTasks(
  agent: ResolvedAgent,
  base: string,
  options: {
    pageSize: number
    offset: number
    includeArtifacts: boolean
    state?: string | undefined
    contextId?: string | undefined
    statusTimestampAfterMs?: number | undefined
  },
) {
  const empty = { tasks: [], nextPageToken: "", pageSize: options.pageSize, totalSize: 0 }
  if (!canRead(agent) || !agent.assigneeId) return empty
  await ensureSchema()
  const repo = new TaskRepository(getPersistenceClient())
  const rows: Row[] = []
  for (let offset = 0; ; offset += 200) {
    const { tasks: batch } = await repo.findAll({
      assignedTo: agent.assigneeId,
      sort: "updated_at",
      order: "DESC",
      limit: 200,
      offset,
    })
    rows.push(...(batch as unknown as Row[]))
    if (batch.length < 200) break
  }
  // Filter after the read: A2A states group several Meitheal statuses.
  const matching = rows.filter(row => {
    if (!(options.state ? state(row.status) === options.state : !isDoneStatus(normalizeStatus(String(row.status ?? ""))))) {
      return false
    }
    if (options.contextId && row.id !== options.contextId) return false
    if (options.statusTimestampAfterMs !== undefined) {
      const updatedMs = updatedTimestampMs(row)
      if (updatedMs === undefined || updatedMs <= options.statusTimestampAfterMs) return false
    }
    return true
  })
  const page = matching.slice(options.offset, options.offset + options.pageSize)
  const next = options.offset + page.length
  return {
    tasks: page.map(row => toA2aTask(row, base, options.includeArtifacts)),
    nextPageToken: next < matching.length ? String(next) : "",
    pageSize: options.pageSize,
    totalSize: matching.length,
  }
}
