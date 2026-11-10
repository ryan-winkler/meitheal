import type { Client, InValue } from "@libsql/client"
import { z } from "zod"
import { computeProposalHash, HANDOFF_CLAIM_TTL_MS } from "@meitheal/domain-tasks"
import { taskChangedActivity, discardUnappliedTaskActivity, type RecentTaskActor } from "./recent-activity"
import { nextTaskTimestampMs, canAdvanceTaskTimestampMs } from "./task-timestamp"
import { TaskRepository } from "./task-repository"

const reviewWindow = 24 * 60 * 60 * 1000
const clearHandoff = `handoff_state = 'idle', lock_holder = NULL, lock_expires_at = NULL,
                      proposal_json = NULL, proposal_hash = NULL, agent_scratchpad = NULL`
export const handoffFields = ["title", "description"] as const
type Field = typeof handoffFields[number]
type Changes = Partial<Record<Field, { from: string | null; to: string } | undefined>>
const textChange = z.strictObject({ from: z.string().nullable(), to: z.string() })
const proposalSchema = z.strictObject({
  changes: z.strictObject({ title: textChange.optional(), description: textChange.optional() }),
  summary: z.string(),
  agent: z.string(),
  claimId: z.uuid(),
})
type Proposal = z.infer<typeof proposalSchema>
type Agent = { id: string; name: string }
type HandoffResult =
  | { ok: true; id: string; lease?: string; expiresAt?: number; hash?: string; reviewUntil?: number; changes?: Changes }
  | { ok: false; error: string; status: 404 | 409 | 422 | 499 }

function conflict(error: string): HandoffResult {
  return { ok: false, status: 409, error }
}

function parseProposal(value: unknown): Proposal | null {
  if (typeof value !== "string") return null
  try {
    const parsed = proposalSchema.safeParse(JSON.parse(value))
    return parsed.success && Object.keys(parsed.data.changes).length ? parsed.data : null
  } catch {
    return null
  }
}

export class TaskHandoff {
  constructor(private readonly db: Client) {}

  private async getTask(identifier: string) {
    const id = (await new TaskRepository(this.db).resolveTaskId(identifier))?.id
    if (!id) return null
    const { rows } = await this.db.execute({
      sql: `SELECT id, title, description, status, handoff_state, lock_holder, lock_expires_at,
                   proposal_hash, proposal_json FROM tasks WHERE id = ?`,
      args: [id],
    })
    return rows[0] ? { id, row: rows[0] } : null
  }

  async agentAction(identifier: string, agent: Agent, input:
    | { action: "claim" }
    | { action: "release"; lease: string }
    | { action: "propose"; lease: string; summary: string; updates: Partial<Record<Field, string | undefined>> },
  ): Promise<HandoffResult> {
    const found = await this.getTask(identifier)
    if (!found) return { ok: false, status: 404, error: "Task not found." }
    const { id, row: task } = found
    const now = Date.now()
    if (input.action === "claim") {
      const lease = crypto.randomUUID()
      const expiresAt = now + HANDOFF_CLAIM_TTL_MS
      // The handoff guard stores a lease nonce while claimed and a content hash once proposed.
      const result = await this.db.execute({
        sql: `UPDATE tasks SET handoff_state = 'claimed', lock_holder = ?, lock_expires_at = ?,
                     proposal_json = NULL, proposal_hash = ?, agent_scratchpad = NULL
              WHERE id = ? AND status <> 'archived' AND (handoff_state = 'idle' OR
                    (handoff_state IN ('claimed', 'proposed') AND COALESCE(lock_expires_at, 0) <= ?))`,
        args: [agent.id, expiresAt, lease, id, now],
      })
      return result.rowsAffected ? { ok: true, id, lease, expiresAt }
        : conflict("This task already has an active handoff or is archived.")
    }

    const ownsClaim = task.handoff_state === "claimed" && task.lock_holder === agent.id
      && task.proposal_hash === input.lease && Number(task.lock_expires_at) > now
    if (!ownsClaim) return conflict("The claim is unavailable. Claim the task again before proposing.")
    const condition = "id = ? AND handoff_state = 'claimed' AND lock_holder = ? AND proposal_hash = ? AND lock_expires_at > ?"

    if (input.action === "release") {
      const result = await this.db.execute({
        sql: `UPDATE tasks SET ${clearHandoff} WHERE ${condition}`,
        args: [id, agent.id, input.lease, Date.now()],
      })
      return result.rowsAffected ? { ok: true, id } : conflict("The claim has changed.")
    }

    const changes: Partial<Record<Field, { from: string | null; to: string }>> = {}
    for (const field of handoffFields) {
      const to = input.updates[field]
      const from = task[field] == null ? null : String(task[field])
      if (to !== undefined && to !== (from ?? "")) changes[field] = { from, to }
    }
    if (!Object.keys(changes).length) {
      return { ok: false, status: 422, error: "Propose a title or description that changes the task." }
    }
    const proposal = { changes, summary: input.summary, agent: agent.name, claimId: input.lease }
    const hash = await computeProposalHash(proposal)
    const reviewUntil = now + reviewWindow
    const result = await this.db.execute({
      sql: `UPDATE tasks SET handoff_state = 'proposed', proposal_json = ?, proposal_hash = ?, lock_expires_at = ?
            WHERE ${condition} AND status <> 'archived' AND title IS ? AND description IS ?`,
      args: [JSON.stringify(proposal), hash, reviewUntil, id, agent.id, input.lease, Date.now(),
        task.title ?? null, task.description ?? null],
    })
    return result.rowsAffected ? { ok: true, id, hash, reviewUntil }
      : conflict("The task or claim changed before the proposal was saved.")
  }

  async decide(identifier: string, hash: string, action: "accept" | "reject", actor: RecentTaskActor = { kind: "system", personKey: null }, signal?: AbortSignal): Promise<HandoffResult> {
    const cancelled = (): HandoffResult => ({ ok: false, status: 499, error: "Review request cancelled." })
    if (signal?.aborted) return cancelled()
    const found = await this.getTask(identifier)
    if (!found) return { ok: false, status: 404, error: "Task not found." }
    const { id, row: task } = found
    const proposal = parseProposal(task.proposal_json)
    if (!proposal || task.proposal_hash !== hash || task.handoff_state !== "proposed"
      || Number(task.lock_expires_at) <= Date.now()
      || await computeProposalHash(JSON.parse(String(task.proposal_json))) !== hash) {
      return conflict("This proposal changed, expired, or has already been reviewed.")
    }
    const active = "id = ? AND handoff_state = 'proposed' AND proposal_hash = ? AND proposal_json = ? AND lock_expires_at > ?"
    const match = [id, hash, String(task.proposal_json), Date.now()]
    if (signal?.aborted) return cancelled()
    if (action === "reject") {
      const result = await this.db.execute({ sql: `UPDATE tasks SET ${clearHandoff} WHERE ${active}`, args: match })
      return result.rowsAffected ? { ok: true, id } : conflict("This proposal is no longer pending.")
    }

    const { title, description } = proposal.changes
    const where = `WHERE ${active} AND ${canAdvanceTaskTimestampMs("updated_at")} AND status <> 'archived' AND title IS ? AND description IS ?`
    const whereArgs: InValue[] = [...match, title ? title.from : task.title ?? null, description ? description.from : task.description ?? null]
    const fields: Record<string, InValue> = { title: title?.to ?? task.title ?? null, description: description?.to ?? task.description ?? null }
    const now = Date.now()
    const eventId = crypto.randomUUID()
    if (signal?.aborted) return cancelled()
    const results = await this.db.batch([
      taskChangedActivity(fields, where, whereArgs, actor, now, eventId),
      { sql: `UPDATE tasks SET ${clearHandoff}, title = ?, description = ?, updated_at = ${nextTaskTimestampMs("updated_at")} ${where}`,
        args: [fields.title!, fields.description!, now, ...whereArgs] },
      discardUnappliedTaskActivity(eventId),
    ], "write")
    const result = results[1]!
    return result.rowsAffected ? { ok: true, id, changes: proposal.changes }
      : conflict("The task changed. Reload the queue to review its current values or reject the proposal.")
  }

  async queue(offset: number, limit: number) {
    const { rows } = await this.db.execute({
      sql: `SELECT id, ticket_number, title, description, status, proposal_json, proposal_hash, lock_expires_at
            FROM tasks WHERE handoff_state = 'proposed' AND lock_expires_at > ?
              AND proposal_json IS NOT NULL AND proposal_hash IS NOT NULL
            ORDER BY lock_expires_at DESC, id LIMIT ? OFFSET ?`,
      args: [Date.now(), limit, offset],
    })
    return rows.flatMap(row => {
      const proposal = parseProposal(row.proposal_json)
      if (!proposal) return []
      const fields = handoffFields.flatMap(field => {
        const change = proposal.changes[field]
        const current = row[field] == null ? null : String(row[field])
        return change ? [{ field, ...change, current }] : []
      })
      return [{
        id: String(row.id), ticketNumber: Number(row.ticket_number) || null, title: String(row.title),
        hash: String(row.proposal_hash), summary: proposal.summary, agent: proposal.agent,
        expiresAt: Number(row.lock_expires_at), fields,
        stale: row.status === "archived" || fields.some(field => field.current !== field.from),
      }]
    })
  }
}
