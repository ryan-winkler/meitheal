/**
 * Accept/Reject Bot Proposal — POST /api/tasks/[id]/accept-proposal
 *
 * Verifies the proposal_hash matches the current proposal_json before applying.
 * Prevents TOCTOU attacks where a bot could swap proposal content between
 * preview and accept.
 *
 * @domain Bot Orchestration — Handoff Protocol
 */
import type { APIRoute } from "astro"
import type { InValue } from "@libsql/client"
import { ensureSchema, getPersistenceClient } from "@domains/tasks/persistence/store"
import { apiJson, apiError } from "@lib/api-response"
import { logApiError } from "@lib/api-logger"

export const POST: APIRoute = async ({ params, request }) => {

  const taskId = params.id
  if (!taskId || !/^[a-zA-Z0-9_-]+$/.test(taskId)) {
    return apiError("Invalid task ID", 400)
  }

  let body: { action: string; expected_hash?: string }
  try {
    body = await request.json()
  } catch {
    return apiError("Invalid JSON body", 400)
  }

  const action = body.action
  if (action !== "accept" && action !== "reject") {
    return apiError("action must be 'accept' or 'reject'", 400)
  }

  try {
    await ensureSchema()
    const client = getPersistenceClient()

    // Fetch current task state
    const result = await client.execute({
      sql: `SELECT id, proposal_json, proposal_hash, handoff_state, owner
            FROM tasks WHERE id = ?`,
      args: [taskId],
    })

    if (result.rows.length === 0) {
      return apiError("Task not found", 404)
    }

    const task = result.rows[0]!
    const currentState = String(task.handoff_state ?? "idle")

    // Must be in 'proposed' state to accept/reject
    if (currentState !== "proposed") {
      return apiError(
        `Cannot ${action} proposal: task is in '${currentState}' state, expected 'proposed'`,
        409,
      )
    }

    const proposalJson = task.proposal_json ? String(task.proposal_json) : null
    if (!proposalJson) {
      return apiError("No proposal_json found on this task", 409)
    }

    if (action === "accept") {
      // Verify hash matches to prevent TOCTOU
      const storedHash = task.proposal_hash ? String(task.proposal_hash) : null
      const expectedHash = body.expected_hash

      if (storedHash && expectedHash && storedHash !== expectedHash) {
        return apiError(
          "Proposal content has changed since you previewed it (hash mismatch). Please review again.",
          409,
        )
      }

      // Apply the proposal fields
      let proposal: Record<string, unknown>
      try {
        proposal = JSON.parse(proposalJson)
      } catch {
        return apiError("proposal_json is not valid JSON", 500)
      }

      // Build SET clause from proposal fields (only safe fields)
      const ALLOWED_FIELDS = new Set([
        "title", "description", "status", "priority", "due_date",
        "labels", "task_kind", "progress",
      ])

      const setClauses: string[] = []
      const setArgs: InValue[] = []

      for (const [key, value] of Object.entries(proposal)) {
        if (ALLOWED_FIELDS.has(key)) {
          setClauses.push(`${key} = ?`)
          setArgs.push(value as InValue)
        }
      }

      // Always transition handoff_state → accepted → idle, clear proposal
      setClauses.push("handoff_state = ?", "proposal_json = NULL", "proposal_hash = NULL")
      setClauses.push("lock_holder = NULL", "lock_expires_at = NULL")
      setClauses.push("updated_at = ?")
      setArgs.push("idle", new Date().toISOString())

      setArgs.push(taskId)

      await client.execute({
        sql: `UPDATE tasks SET ${setClauses.join(", ")} WHERE id = ?`,
        args: setArgs,
      })

      // Record in activity log
      await client.execute({
        sql: `INSERT INTO task_activity_log (task_id, field, old_value, new_value, actor, created_at)
              VALUES (?, 'proposal', ?, 'accepted', 'user', ?)`,
        args: [taskId, proposalJson, new Date().toISOString()],
      })

      return apiJson({
        ok: true,
        action: "accepted",
        taskId,
        appliedFields: Object.keys(proposal).filter((k) => ALLOWED_FIELDS.has(k)),
      })
    } else {
      // Reject — clear proposal, transition to idle
      await client.execute({
        sql: `UPDATE tasks SET handoff_state = 'idle', proposal_json = NULL, proposal_hash = NULL,
              lock_holder = NULL, lock_expires_at = NULL, updated_at = ?
              WHERE id = ?`,
        args: [new Date().toISOString(), taskId],
      })

      // Record in activity log
      await client.execute({
        sql: `INSERT INTO task_activity_log (task_id, field, old_value, new_value, actor, created_at)
              VALUES (?, 'proposal', ?, 'rejected', 'user', ?)`,
        args: [taskId, proposalJson, new Date().toISOString()],
      })

      return apiJson({
        ok: true,
        action: "rejected",
        taskId,
      })
    }
  } catch (e) {
    logApiError("tasks", "accept-proposal", e)
    return apiError("Failed to process proposal", 500)
  }
}
