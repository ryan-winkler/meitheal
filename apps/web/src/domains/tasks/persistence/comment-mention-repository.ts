import type { Client, Transaction } from "@libsql/client"
import { createHash } from "node:crypto"

const retentionMs = 30 * 24 * 60 * 60_000
const inboxSize = 1000
const pageSize = 25
const liveInbox = `FROM comment_mentions AS m
  JOIN comments AS c ON c.id = m.comment_id AND c.task_id = m.task_id
  JOIN tasks AS t ON t.id = m.task_id`
const liveRecipient = "m.recipient_key = ? AND m.withdrawn = 0 AND m.created_at > ?"
const commentColumns = "id, task_id, content, author, created_at"

async function reconcile(tx: Transaction, taskId: string, commentId: number, recipients: string[]) {
  const now = Date.now()
  const selected = JSON.stringify(recipients)
  await tx.batch([
    {
      sql: `UPDATE comment_mentions SET withdrawn = 1
            WHERE comment_id = ? AND withdrawn = 0
            AND recipient_key NOT IN (SELECT value FROM json_each(?))`,
      args: [commentId, selected],
    },
    {
      sql: `DELETE FROM comment_mentions WHERE created_at <= ?`,
      args: [now - retentionMs],
    },
    {
      sql: `INSERT INTO comment_mentions (task_id, comment_id, recipient_key, created_at)
            SELECT ?, ?, value, ? FROM json_each(?) WHERE true
            ON CONFLICT(comment_id, recipient_key) DO UPDATE SET withdrawn = 0`,
      args: [taskId, commentId, now, selected],
    },
    ...recipients.map(recipient => ({
      sql: `DELETE FROM comment_mentions WHERE recipient_key = ? AND id IN (
              SELECT id FROM comment_mentions WHERE recipient_key = ?
              ORDER BY id DESC LIMIT -1 OFFSET ?
            )`,
      args: [recipient, recipient, inboxSize],
    })),
  ])
}

type CommentAttempt = { key: string, issuedAt: number, rawContent: string, cutoff: number }

async function readAttempt(db: Pick<Client, "execute">, taskId: string, owner: string, key: string, digest: string) {
  const prior = (await db.execute({
    sql: `SELECT r.body_digest, c.id, c.task_id, c.content, c.author, c.created_at
          FROM comment_mention_attempts AS r
          LEFT JOIN comments AS c ON c.id = r.comment_id AND c.task_id = r.task_id
          WHERE r.task_id = ? AND r.owner_key = ? AND r.attempt_key = ?`,
    args: [taskId, owner, key],
  })).rows[0]
  if (!prior) return
  if (prior.body_digest !== digest) return { state: "conflict" } as const
  if (prior.id === null) return { state: "gone" } as const
  const { body_digest: _digest, ...comment } = prior
  return { state: "replayed", comment } as const
}

function commentDigest(content: string) {
  return createHash("sha256").update(content).digest("hex")
}

export class CommentMentionRepository {
  constructor(private readonly client: Client) {}

  replay(taskId: string, owner: string, key: string, rawContent: string) {
    return readAttempt(this.client, taskId, owner, key, commentDigest(rawContent))
  }

  async create(taskId: string, content: string, author: string, owner: string, recipients: string[], attempt: CommentAttempt, verifiedHuman = false) {
    const digest = commentDigest(attempt.rawContent)
    const tx = await this.client.transaction("write")
    try {
      const prior = await readAttempt(tx, taskId, owner, attempt.key, digest)
      if (prior) return prior
      const comment = (await tx.execute({
        sql: `INSERT INTO comments (task_id, content, author, owner_key, inactivity_spike_human)
              SELECT id, ?, ?, ?, ? FROM tasks WHERE id = ? RETURNING ${commentColumns}`,
        args: [content, author, owner, verifiedHuman ? 1 : 0, taskId],
      })).rows[0]
      if (!comment) return { state: "missing" } as const
      const commentId = Number(comment.id)
      await tx.batch([
        { sql: "DELETE FROM comment_mention_attempts WHERE issued_at <= ?", args: [attempt.cutoff] },
        {
          sql: `INSERT INTO comment_mention_attempts (task_id, owner_key, attempt_key, body_digest, comment_id, issued_at)
                VALUES (?, ?, ?, ?, ?, ?)`,
          args: [taskId, owner, attempt.key, digest, commentId, attempt.issuedAt],
        },
      ])
      if (recipients.length) await reconcile(tx, taskId, commentId, recipients)
      await tx.commit()
      return { state: "created", comment } as const
    } finally {
      tx.close()
    }
  }

  async edit(taskId: string, commentId: number, owner: string, content: string, recipients: string[]) {
    const tx = await this.client.transaction("write")
    try {
      const result = await tx.execute({
        sql: `UPDATE comments SET content = ? WHERE task_id = ? AND id = ? AND owner_key = ?
              RETURNING ${commentColumns}`,
        args: [content, taskId, commentId, owner],
      })
      const comment = result.rows[0]
      if (!comment) return
      if (recipients.length) {
        await reconcile(tx, taskId, commentId, recipients)
      } else {
        await tx.execute({ sql: "UPDATE comment_mentions SET withdrawn = 1 WHERE comment_id = ? AND withdrawn = 0", args: [commentId] })
      }
      await tx.commit()
      return comment
    } finally {
      tx.close()
    }
  }

  async page(recipient: string, before: number | null) {
    const cutoff = Date.now() - retentionMs
    const [items, count] = await this.client.batch([
      {
        sql: `SELECT m.id, m.task_id, m.comment_id, m.created_at, m.read_at, t.title
              ${liveInbox} WHERE ${liveRecipient} AND m.id < ? ORDER BY m.id DESC LIMIT ?`,
        args: [recipient, cutoff, before ?? Number.MAX_SAFE_INTEGER, pageSize + 1],
      },
      {
        sql: `SELECT COUNT(*) AS count ${liveInbox} WHERE ${liveRecipient} AND m.read_at IS NULL`,
        args: [recipient, cutoff],
      },
    ], "read")
    const rows = items!.rows.slice(0, pageSize)
    return { rows, unread: Number(count!.rows[0]?.count ?? 0), next: items!.rows.length > pageSize ? Number(rows.at(-1)?.id) : null }
  }

  async mark(recipient: string, id: number | null, read: boolean): Promise<boolean> {
    const now = Date.now()
    const result = await this.client.execute({
      sql: `UPDATE comment_mentions SET read_at = ?
            WHERE id IN (SELECT m.id ${liveInbox}
                         WHERE ${liveRecipient} AND (? IS NULL OR m.id = ?))`,
      args: [read ? now : null, recipient, now - retentionMs, id, id],
    })
    return id === null || result.rowsAffected > 0
  }
}
