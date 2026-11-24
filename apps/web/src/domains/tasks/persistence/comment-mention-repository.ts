import { createHash } from "node:crypto"
import type { Client, Transaction } from "@libsql/client"
import {
  requireBoardScope,
  scopeAssignedTo,
  scopeCommentOwnerKey,
  scopeMentionRecipientKey,
  validateBoardScope,
  type BoardScope
} from "../board-scope"
import { boardOperationClient } from "./board-operation-client"
import { guardClientContinuity } from "./continuity-client"
import { scopedTaskRead } from "./board-work-query"
import { taskOwnedBy } from "./board-storage"
import { sql, sourceSql, type SqlFragment } from "./sql-fragment"
const retentionMs = 30 * 24 * 60 * 60000,
  inboxSize = 1000,
  pageSize = 25
const commentColumns = "id, task_id, content, author, created_at"
type CommentAttempt = {
  key: string
  issuedAt: number
  rawContent: string
  cutoff: number
  legacyPlain?: boolean
}
const commentDigest = (value: string) => createHash("sha256").update(value).digest("hex")
function parent(scope: BoardScope, reference: SqlFragment, write = false): SqlFragment {
  const assigned = write ? scopeAssignedTo(scope) : undefined
  return sql`EXISTS(SELECT 1 FROM scoped_tasks AS parent_task WHERE parent_task.id=${reference} ${assigned === undefined ? sourceSql("") : sql`AND parent_task.assigned_to=${assigned}`})`
}
function scoped(scope: BoardScope, query: SqlFragment) {
  return scopedTaskRead(scope, query)
}
async function readAttempt(
  db: Pick<Client, "execute">,
  scope: BoardScope,
  taskId: string,
  owner: string,
  key: string,
  digest: string,
  cutoff?: number
) {
  const {
    rows: [prior]
  } = await db.execute(
    scoped(
      scope,
      sql`SELECT receipt.body_digest,comment.id,comment.task_id,comment.content,comment.author,comment.created_at
    FROM comment_mention_attempts AS receipt LEFT JOIN comments AS comment ON comment.id=receipt.comment_id AND comment.task_id=receipt.task_id
    WHERE receipt.task_id=${taskId} AND receipt.owner_key=${owner} AND receipt.attempt_key=${key} ${cutoff === undefined ? sourceSql("") : sql`AND receipt.issued_at > ${cutoff}`} AND ${parent(scope, sourceSql("receipt.task_id"), true)}`
    )
  )
  if (!prior) return undefined
  if (prior.body_digest !== digest) return { state: "conflict" } as const
  if (prior.id === null) return { state: "gone" } as const
  const { body_digest: _digest, ...comment } = prior
  return { state: "replayed", comment } as const
}
async function reconcile(
  tx: Transaction,
  scope: BoardScope,
  taskId: string,
  commentId: number,
  recipients: string[]
) {
  const now = Date.now(),
    selected = JSON.stringify([...new Set(recipients)])
  await tx.execute(
    sql`UPDATE comment_mentions SET withdrawn=1 WHERE comment_id=${commentId} AND task_id=${taskId} AND withdrawn=0 AND recipient_key NOT IN(SELECT value FROM json_each(${selected}))`
  )
  await tx.execute(
    scoped(
      scope,
      sql`DELETE FROM comment_mentions WHERE created_at<=${now - retentionMs} AND ${parent(scope, sourceSql("comment_mentions.task_id"), true)}`
    )
  )
  await tx.execute(
    sql`INSERT INTO comment_mentions(task_id,comment_id,recipient_key,created_at) SELECT ${taskId},${commentId},value,${now} FROM json_each(${selected}) WHERE true ON CONFLICT(comment_id,recipient_key) DO UPDATE SET withdrawn=0`
  )
  for (const recipient of recipients)
    await tx.execute(
      scoped(
        scope,
        sql`DELETE FROM comment_mentions WHERE recipient_key=${recipient} AND ${parent(scope, sourceSql("comment_mentions.task_id"), true)} AND id IN(
    SELECT mention.id FROM comment_mentions AS mention WHERE recipient_key=${recipient} AND ${parent(scope, sourceSql("mention.task_id"), true)} ORDER BY mention.id DESC LIMIT -1 OFFSET ${inboxSize})`
      )
    )
}
export class CommentMentionRepository {
  constructor(
    private readonly client: Client,
    private readonly scope: BoardScope
  ) {
    requireBoardScope(scope)
  }
  private db(action: "read" | "edit", ids: string[] = []) {
    return boardOperationClient(this.client, this.scope, { resource: "task", action }, ids)
  }
  private owns(owner: string) {
    return owner === scopeCommentOwnerKey(this.scope)
  }
  async replay(taskId: string, owner: string, key: string, rawContent: string, cutoff?: number) {
    if (!this.owns(owner)) return undefined
    return readAttempt(
      this.db("edit", [taskId]),
      this.scope,
      taskId,
      owner,
      key,
      commentDigest(rawContent),
      cutoff
    )
  }
  async create(
    taskId: string,
    content: string,
    author: string,
    owner: string,
    recipients: string[],
    attempt: CommentAttempt,
    verifiedHuman = false
  ) {
    if (!this.owns(owner)) return { state: "missing" } as const
    const digest = commentDigest(attempt.rawContent),
      tx = await this.db("edit", [taskId]).transaction("write")
    try {
      const prior = await readAttempt(
        tx,
        this.scope,
        taskId,
        owner,
        attempt.key,
        digest,
        attempt.legacyPlain ? attempt.cutoff : undefined
      )
      if (prior) {
        await tx.commit()
        return prior
      }
      if (attempt.legacyPlain)
        await tx.execute(
          scoped(
            this.scope,
            sql`DELETE FROM comment_mention_attempts WHERE task_id=${taskId} AND owner_key=${owner}
          AND attempt_key=${attempt.key} AND issued_at<=${attempt.cutoff} AND ${parent(this.scope, sourceSql("comment_mention_attempts.task_id"), true)}`
          )
        )
      const {
        rows: [comment]
      } =
        await tx.execute(sql`INSERT INTO comments(task_id,content,author,owner_key,inactivity_spike_human)
        SELECT id,${content},${author},${owner},${verifiedHuman && this.scope.principal.kind === "ha_user" ? 1 : 0} FROM tasks WHERE id=${taskId} AND ${taskOwnedBy(this.scope)} RETURNING ${sourceSql(commentColumns)}`)
      if (!comment) return { state: "missing" } as const
      if (!attempt.legacyPlain)
        await tx.execute(
          scoped(
            this.scope,
            sql`DELETE FROM comment_mention_attempts WHERE issued_at<=${attempt.cutoff} AND ${parent(this.scope, sourceSql("comment_mention_attempts.task_id"), true)}`
          )
        )
      await tx.execute(
        sql`INSERT INTO comment_mention_attempts(task_id,owner_key,attempt_key,body_digest,comment_id,issued_at) VALUES (${taskId},${owner},${attempt.key},${digest},${Number(comment.id)},${attempt.issuedAt})`
      )
      if (recipients.length) await reconcile(tx, this.scope, taskId, Number(comment.id), recipients)
      await tx.commit()
      return { state: "created", comment } as const
    } finally {
      tx.close()
    }
  }
  async editChecked(
    taskId: string,
    commentId: number,
    owner: string,
    content: string,
    recipients: string[],
    expectedAssignedTo?: string
  ): Promise<
    | { state: "ok"; comment: Record<string, unknown> }
    | { state: "not_found" }
    | { state: "assignee_mismatch" }
  > {
    if (!this.owns(owner)) return { state: "not_found" }
    const tx = await this.db("edit", [taskId]).transaction("write")
    try {
      const {
        rows: [task]
      } = await tx.execute(
        sql`SELECT assigned_to FROM tasks WHERE id=${taskId} AND ${taskOwnedBy(this.scope)}`
      )
      if (!task) return { state: "not_found" }
      if (expectedAssignedTo !== undefined && task.assigned_to !== expectedAssignedTo)
        return { state: "assignee_mismatch" }
      const {
        rows: [comment]
      } = await tx.execute(
        sql`UPDATE comments SET content=${content} WHERE task_id=${taskId} AND id=${commentId} AND owner_key=${owner} RETURNING ${sourceSql(commentColumns)}`
      )
      if (!comment) return { state: "not_found" }
      if (recipients.length) await reconcile(tx, this.scope, taskId, commentId, recipients)
      else
        await tx.execute(
          sql`UPDATE comment_mentions SET withdrawn=1 WHERE comment_id=${commentId} AND task_id=${taskId} AND withdrawn=0`
        )
      await tx.commit()
      return { state: "ok", comment }
    } finally {
      tx.close()
    }
  }
  async edit(
    taskId: string,
    commentId: number,
    owner: string,
    content: string,
    recipients: string[]
  ) {
    const result = await this.editChecked(taskId, commentId, owner, content, recipients)
    return result.state === "ok" ? result.comment : undefined
  }
  async page(recipient: string, before: number | null) {
    if (recipient !== scopeMentionRecipientKey(this.scope))
      return { rows: [], unread: 0, next: null }
    const cutoff = Date.now() - retentionMs
    const inbox = sql`FROM comment_mentions AS mention JOIN comments AS comment ON comment.id=mention.comment_id AND comment.task_id=mention.task_id JOIN scoped_tasks AS task ON task.id=mention.task_id
      WHERE mention.recipient_key=${recipient} AND mention.withdrawn=0 AND mention.created_at>${cutoff}`
    const [items, count] = await this.db("read").batch(
      [
        scoped(
          this.scope,
          sql`SELECT mention.id,mention.task_id,mention.comment_id,mention.created_at,mention.read_at,task.title,task.ticket_ref AS ticket_key ${inbox} AND mention.id<${before ?? Number.MAX_SAFE_INTEGER} ORDER BY mention.id DESC LIMIT ${pageSize + 1}`
        ),
        scoped(this.scope, sql`SELECT COUNT(*) AS count ${inbox} AND mention.read_at IS NULL`)
      ],
      "read"
    )
    const rows = items!.rows.slice(0, pageSize)
    return {
      rows,
      unread: Number(count!.rows[0]?.count ?? 0),
      next: items!.rows.length > pageSize ? Number(rows.at(-1)?.id) : null
    }
  }
  /** Read-state belongs to the recipient and does not edit Board tasks. */
  async mark(recipient: string, id: number | null, read: boolean): Promise<boolean> {
    if (recipient !== scopeMentionRecipientKey(this.scope)) return false
    const tx = await guardClientContinuity(this.client).transaction("write")
    try {
      if (!(await validateBoardScope(this.scope, tx, { resource: "task", action: "read" })).ok)
        return false
      const now = Date.now()
      const result = await tx.execute(
        scoped(
          this.scope,
          sql`UPDATE comment_mentions SET read_at=${read ? now : null} WHERE id IN(SELECT mention.id FROM comment_mentions AS mention
        JOIN comments AS comment ON comment.id=mention.comment_id AND comment.task_id=mention.task_id JOIN scoped_tasks AS task ON task.id=mention.task_id
        WHERE mention.recipient_key=${recipient} AND mention.withdrawn=0 AND mention.created_at>${now - retentionMs} AND (${id} IS NULL OR mention.id=${id}))`
        )
      )
      if (!(await validateBoardScope(this.scope, tx, { resource: "task", action: "read" })).ok)
        return false
      await tx.commit()
      return id === null || result.rowsAffected > 0
    } finally {
      tx.close()
    }
  }
}
