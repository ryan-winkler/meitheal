import { isCurrentRetiredHouseholdResult } from "./retired-household-result"
import { guardClientContinuity } from "./continuity-client"
import type { Client, Row } from "@libsql/client"

export interface ReactionTarget {
  taskId: string
  commentId: number | null
}

export interface TaskReaction {
  id: number
  content: string
  author: string
  can_manage: boolean
}

const pageSize = 50

function toReaction(row: Row, canManage: boolean): TaskReaction {
  return { id: Number(row.id), content: String(row.content), author: String(row.author), can_manage: canManage }
}

export class TaskReactionRepository {
  private readonly client: Client

  constructor(private readonly sourceClient: Client) {
    this.client = guardClientContinuity(sourceClient)
  }

  async list({ taskId, commentId }: ReactionTarget, cursor: number, owner: string | null) {
    const result = await this.client.execute({
      sql: `SELECT r.id, r.content, r.author, r.owner_key = ? AS can_manage
            FROM tasks AS t
            LEFT JOIN task_reactions AS r ON r.task_id = t.id AND r.comment_id IS ? AND r.id < ?
            WHERE t.id = ? AND (t.task_board_id IS NOT NULL OR EXISTS (SELECT 1 FROM task_boards WHERE id = 'household' AND state = 'active')) AND (? IS NULL OR EXISTS (
              SELECT 1 FROM comments WHERE id = ? AND task_id = t.id
            ))
            ORDER BY r.id DESC LIMIT ?`,
      args: [owner, commentId, cursor, taskId, commentId, commentId, pageSize + 1],
    })
    if (!result.rows.length) return null
    const reactions = result.rows.slice(0, pageSize)
      .filter(row => row.id !== null)
      .map(row => toReaction(row, Number(row.can_manage) === 1))
    const nextCursor = result.rows.length > pageSize ? String(reactions.at(-1)!.id) : null
    return { reactions, next_cursor: nextCursor }
  }

  async add({ taskId, commentId }: ReactionTarget, content: string, author: string, owner: string) {
    try {
      // Return the existing row on a duplicate while keeping the original display author.
      const result = await this.client.execute({
        sql: `INSERT INTO task_reactions (task_id, comment_id, owner_key, content, author)
              SELECT id, ?, ?, ?, ? FROM tasks
              WHERE id = ? AND (task_board_id IS NOT NULL OR EXISTS (SELECT 1 FROM task_boards WHERE id = 'household' AND state = 'active')) AND (? IS NULL OR EXISTS (
                SELECT 1 FROM comments WHERE id = ? AND task_id = tasks.id
              ))
              ON CONFLICT (task_id, COALESCE(comment_id, 0), owner_key, content)
              DO UPDATE SET content = excluded.content
              RETURNING id, content, author`,
        args: [commentId, owner, content, author, taskId, commentId, commentId],
      })
      const row = result.rows[0]
      return row ? toReaction(row, true) : null
      } catch (error) {
      if (await isCurrentRetiredHouseholdResult(this.sourceClient, error, taskId)) return null
      throw error
    }
  }

  async remove({ taskId, commentId }: ReactionTarget, reactionId: number, owner: string) {
    try {
      const result = await this.client.execute({
        sql: `DELETE FROM task_reactions WHERE id = ? AND task_id = ? AND comment_id IS ? AND owner_key = ?
              AND EXISTS (SELECT 1 FROM tasks WHERE tasks.id = task_reactions.task_id
                AND (task_board_id IS NOT NULL OR EXISTS (SELECT 1 FROM task_boards WHERE id = 'household' AND state = 'active')))`,
        args: [reactionId, taskId, commentId, owner],
      })
      return result.rowsAffected > 0
      } catch (error) {
      if (await isCurrentRetiredHouseholdResult(this.sourceClient, error, taskId)) return false
      throw error
    }
  }

  async countCards(taskIds: string[]) {
    const result = await this.client.execute({
      sql: `SELECT task_id, COUNT(*) AS count FROM task_reactions
            WHERE EXISTS (SELECT 1 FROM tasks WHERE tasks.id = task_reactions.task_id
              AND (task_board_id IS NOT NULL OR EXISTS (SELECT 1 FROM task_boards WHERE id = 'household' AND state = 'active'))) AND comment_id IS NULL AND task_id IN (${taskIds.map(() => "?").join(",")})
            GROUP BY task_id`,
      args: taskIds,
    })
    return Object.fromEntries(result.rows.map(row => [String(row.task_id), Number(row.count)]))
  }
}
