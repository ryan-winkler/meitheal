import type { APIRoute } from "astro"
import { ensureSchema, getPersistenceClient } from "@domains/tasks/persistence/store"
import { apiJson } from "../../../lib/api-response"

/**
 * GET /api/tasks/proposals — List tasks with pending bot proposals.
 * Returns tasks where handoff_state = 'proposed', ordered by updated_at desc.
 * Used by the /review page to show a queue of bot proposals awaiting human review.
 */
export const GET: APIRoute = async () => {
  try {
    await ensureSchema()
    const client = getPersistenceClient()

    const result = await client.execute({
      sql: `SELECT id, ticket_number, title, summary, status, handoff_state,
                   owner, lock_holder, proposal_json, proposal_hash,
                   updated_at, created_at
            FROM tasks
            WHERE handoff_state = 'proposed'
            ORDER BY updated_at DESC
            LIMIT 50`,
      args: [],
    })

    const proposals = result.rows.map(row => ({
      id: row.id,
      ticket_number: row.ticket_number,
      title: row.title,
      summary: row.summary,
      status: row.status,
      handoff_state: row.handoff_state,
      owner: row.owner,
      lock_holder: row.lock_holder,
      proposal_json: row.proposal_json ? JSON.parse(String(row.proposal_json)) : null,
      proposal_hash: row.proposal_hash,
      updated_at: row.updated_at,
      created_at: row.created_at,
    }))

    return apiJson({
      proposals,
      total: proposals.length,
    })
  } catch (error) {
    return apiJson(
      { error: error instanceof Error ? error.message : "Failed to fetch proposals" },
      500
    )
  }
}
