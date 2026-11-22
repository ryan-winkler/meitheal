import type { Client, Row } from "@libsql/client"
import { requireBoardScope, scopeCommentOwnerKey, type BoardScope } from "../board-scope"
import { boardOperationClient } from "./board-operation-client"
import { scopedTaskRead } from "./board-work-query"
import { taskOwnedBy } from "./board-storage"
import { sql, joinSql } from "./sql-fragment"
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
  return {
    id: Number(row.id),
    content: String(row.content),
    author: String(row.author),
    can_manage: canManage
  }
}

export class TaskReactionRepository {
  constructor(
    private readonly client: Client,
    private readonly scope: BoardScope
  ) {
    requireBoardScope(scope)
  }
  async list({ taskId, commentId }: ReactionTarget, cursor: number, owner: string | null) {
    if (owner !== null && owner !== scopeCommentOwnerKey(this.scope)) return null
    const { rows } = await boardOperationClient(
      this.client,
      this.scope,
      { resource: "task", action: "read" },
      [taskId]
    ).execute(
      scopedTaskRead(
        this.scope,
        sql`SELECT reaction.id,reaction.content,reaction.author,reaction.owner_key=${owner} AS can_manage FROM scoped_tasks AS task
      LEFT JOIN task_reactions AS reaction ON reaction.task_id=task.id AND reaction.comment_id IS ${commentId} AND reaction.id<${cursor}
      WHERE task.id=${taskId} AND (${commentId} IS NULL OR EXISTS(SELECT 1 FROM comments WHERE id=${commentId} AND task_id=task.id)) ORDER BY reaction.id DESC LIMIT ${pageSize + 1}`
      )
    )
    if (!rows.length) return null
    const reactions = rows
      .slice(0, pageSize)
      .filter((row) => row.id !== null)
      .map((row) => toReaction(row, Number(row.can_manage) === 1))
    const { rows: groupRows } = await boardOperationClient(this.client, this.scope, { resource: "task", action: "read" }, [taskId]).execute(
      scopedTaskRead(
        this.scope,
        sql`SELECT reaction.content, COUNT(*) AS count, MAX(CASE WHEN reaction.owner_key=${owner} THEN reaction.id ELSE NULL END) AS my_reaction_id
          FROM scoped_tasks AS task
          JOIN task_reactions AS reaction ON reaction.task_id=task.id AND reaction.comment_id IS ${commentId}
          WHERE task.id=${taskId} AND (${commentId} IS NULL OR EXISTS(SELECT 1 FROM comments WHERE id=${commentId} AND task_id=task.id))
          GROUP BY reaction.content ORDER BY count DESC, MIN(reaction.id) ASC`
      )
    )
    const groups = groupRows.map((row) => ({
      content: String(row.content),
      count: Number(row.count),
      reacted: row.my_reaction_id !== null && row.my_reaction_id !== undefined,
      my_reaction_id: row.my_reaction_id != null ? Number(row.my_reaction_id) : null,
    }))
    return {
      reactions,
      next_cursor: rows.length > pageSize ? String(reactions.at(-1)!.id) : null,
      ...(groups.length ? { groups } : {}),
    }
  }
  async add({ taskId, commentId }: ReactionTarget, content: string, author: string, owner: string) {
    if (owner !== scopeCommentOwnerKey(this.scope)) return null
    const {
      rows: [row]
    } = await boardOperationClient(this.client, this.scope, { resource: "task", action: "edit" }, [
      taskId
    ]).execute(sql`INSERT INTO task_reactions(task_id,comment_id,owner_key,content,author)
      SELECT id,${commentId},${owner},${content},${author} FROM tasks WHERE id=${taskId} AND ${taskOwnedBy(this.scope)}
      AND (${commentId} IS NULL OR EXISTS(SELECT 1 FROM comments WHERE id=${commentId} AND task_id=tasks.id))
      ON CONFLICT(task_id,COALESCE(comment_id,0),owner_key,content) DO UPDATE SET content=excluded.content RETURNING id,content,author`)
    return row ? toReaction(row, true) : null
  }
  async remove({ taskId, commentId }: ReactionTarget, reactionId: number, owner: string) {
    if (owner !== scopeCommentOwnerKey(this.scope)) return false
    const result = await boardOperationClient(
      this.client,
      this.scope,
      { resource: "task", action: "edit" },
      [taskId]
    )
      .execute(sql`DELETE FROM task_reactions WHERE id=${reactionId} AND task_id=${taskId} AND comment_id IS ${commentId} AND owner_key=${owner}
      AND EXISTS(SELECT 1 FROM tasks WHERE tasks.id=task_reactions.task_id AND ${taskOwnedBy(this.scope)})`)
    return result.rowsAffected > 0
  }
  async countCards(taskIds: string[]) {
    if (!taskIds.length) return {}
    const { rows } = await boardOperationClient(this.client, this.scope, {
      resource: "task",
      action: "read"
    }).execute(
      scopedTaskRead(
        this.scope,
        sql`SELECT reaction.task_id,COUNT(*) AS count FROM task_reactions AS reaction JOIN scoped_tasks AS task ON task.id=reaction.task_id
      WHERE reaction.comment_id IS NULL AND reaction.task_id IN (${joinSql(taskIds.map((id) => sql`${id}`))}) GROUP BY reaction.task_id`
      )
    )
    return Object.fromEntries(rows.map((row) => [String(row.task_id), Number(row.count)]))
  }
}
