import type { Client, Transaction } from "@libsql/client"
import { rewriteLabelReferences } from "@domains/tasks"
import { isWellFormedLabelName, labelNameKey as key } from "./label-name"

export class LabelMutationError extends Error {
  constructor(public readonly errorCode: "blocked" | "conflict") {
    super(errorCode === "blocked" ? "Stored label selections need attention" : "Label names conflict")
    this.name = "LabelMutationError"
  }
}

async function otherDefinitions(tx: Transaction, id: number, oldKey: string, newKey?: string) {
  let cursor: string | null = null
  let oldOther = false
  let newOther = false
  while (true) {
    const { rows } = await tx.execute({
      sql: `SELECT CAST(id AS TEXT) AS id, title FROM vikunja_labels
        WHERE (? IS NULL OR id > CAST(? AS INTEGER)) ORDER BY vikunja_labels.id LIMIT 250`,
      args: [cursor, cursor],
    })
    for (const row of rows) {
      if (typeof row.title !== "string") throw new LabelMutationError("blocked")
      if (String(row.id) === String(id)) continue
      const title = key(row.title)
      if (title === oldKey) oldOther = true
      if (newKey !== undefined && title === newKey) newOther = true
    }
    if (rows.length < 250) break
    cursor = String(rows.at(-1)!.id)
  }
  return { oldOther, newOther }
}

/** Definition and task-owned reference changes share one writer lock and commit. */
export class LabelMutationRepository {
  constructor(private client: Client, private clock: () => number = Date.now) {}

  async update(id: number, updates: { title?: string; hexColor?: string }) {
    if (updates.title !== undefined && !isWellFormedLabelName(updates.title)) throw new LabelMutationError("blocked")
    const now = this.now()
    const tx = await this.client.transaction("write")
    try {
      const { rows } = await tx.execute({ sql: "SELECT title FROM vikunja_labels WHERE id=?", args: [id] })
      const current = rows[0]
      if (!current) return null
      if (typeof current.title !== "string") throw new LabelMutationError("blocked")
      if (updates.title !== undefined && updates.title !== current.title) {
        const oldKey = key(current.title)
        const newKey = key(updates.title)
        const duplicates = await otherDefinitions(tx, id, oldKey, newKey)
        if (duplicates.oldOther || duplicates.newOther) throw new LabelMutationError("conflict")
        const rewritten = await rewriteLabelReferences(tx, {
          matchesOld: value => key(value) === oldKey,
          validName: isWellFormedLabelName,
          destination: updates.title,
          matchesDestination: value => key(value) === newKey,
          now,
        })
        if (!rewritten.ok) throw new LabelMutationError(rewritten.errorCode)
      }
      const result = await tx.execute({
        sql: `UPDATE vikunja_labels SET title=COALESCE(?,title), hex_color=COALESCE(?,hex_color)
          WHERE id=? RETURNING id,title,hex_color`,
        args: [updates.title ?? null, updates.hexColor ?? null, id],
      })
      const row = result.rows[0]
      if (!row) return null
      if (result.rows.length !== 1) throw new Error("Label update did not return one row")
      await tx.commit()
      return row
    } finally {
      tx.close()
    }
  }

  async delete(id: number): Promise<boolean> {
    const now = this.now()
    const tx = await this.client.transaction("write")
    try {
      const { rows } = await tx.execute({ sql: "SELECT title FROM vikunja_labels WHERE id=?", args: [id] })
      const current = rows[0]
      if (!current) return false
      if (typeof current.title !== "string") throw new LabelMutationError("blocked")
      const oldKey = key(current.title)
      if (!(await otherDefinitions(tx, id, oldKey)).oldOther) {
        const rewritten = await rewriteLabelReferences(tx, {
          matchesOld: value => key(value) === oldKey,
          validName: isWellFormedLabelName,
          destination: null,
          matchesDestination: () => false,
          now,
        })
        if (!rewritten.ok) throw new LabelMutationError(rewritten.errorCode)
      }
      await tx.execute({ sql: "DELETE FROM vikunja_task_labels WHERE label_id=?", args: [id] })
      const remaining = await tx.execute({ sql: "SELECT 1 FROM vikunja_task_labels WHERE label_id=? LIMIT 1", args: [id] })
      if (remaining.rows.length) throw new Error("Label junction removal was incomplete")
      const deleted = await tx.execute({ sql: "DELETE FROM vikunja_labels WHERE id=? RETURNING id", args: [id] })
      if (!deleted.rows.length) return false
      if (deleted.rows.length !== 1) throw new Error("Label deletion did not return one row")
      await tx.commit()
      return true
    } finally {
      tx.close()
    }
  }

  private now() {
    const now = this.clock()
    if (!Number.isSafeInteger(now) || now < 0 || now >= Number.MAX_SAFE_INTEGER) {
      throw new Error("The label mutation clock is unavailable")
    }
    return now
  }
}
