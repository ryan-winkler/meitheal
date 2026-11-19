import { createHash } from "node:crypto"
import type { Client, Transaction } from "@libsql/client"
import { findUsedLabelDefinitions, boardOperationClient, canReadBoardAggregate, BoardOperationError, type BoardScope } from "@domains/tasks"
import { isWellFormedLabelName, labelNameKey as nameKey } from "./label-name"

const batchSize = 250
const pageSize = 25
const selectionBytes = 64 * 1024

export interface CleanupLabel {
  id: number
  title: string
  hexColor: string
  revision: string
}

export interface CleanupSelection {
  id: number
  revision: string
}

type Blocked = { ok: false; errorCode: "blocked" }
type Stale = { ok: false; errorCode: "stale" }
export type CleanupPreview = { ok: true; labels: CleanupLabel[]; nextAfter: number | null } | Blocked
export type CleanupRemoval = { ok: true; removed: number[] } | Blocked | Stale

function readDefinition(row: Record<string, unknown>): CleanupLabel | null {
  const id = Number(row.id)
  if (!Number.isSafeInteger(id) || id < 1 || typeof row.title !== "string" || typeof row.hex_color !== "string") return null
  const color = row.hex_color.replace(/^#/, "")
  return {
    id,
    title: row.title,
    hexColor: /^[0-9a-f]{6}$/i.test(color) ? "#" + color : "#6b7280",
    revision: createHash("sha256").update(JSON.stringify([id, row.title, row.hex_color])).digest("hex"),
  }
}

export class UnusedLabelRepository {
  constructor(private readonly client: Client, private readonly scope: BoardScope) {}
  private async session(remove = false) {
    if (!await canReadBoardAggregate(this.client, this.scope)) throw new BoardOperationError("unavailable")
    let db = boardOperationClient(this.client, this.scope, { resource: "board", action: "manage" })
    db = boardOperationClient(db, this.scope, { resource: "label", action: remove ? "delete" : "read" })
    const tx = await db.transaction(remove ? "write" : "read")
    if (!await canReadBoardAggregate(tx, this.scope)) { tx.close(); throw new BoardOperationError("unavailable") }
    return tx
  }

  async preview(afterId: number | null): Promise<CleanupPreview> {
    const tx = await this.session()
    try {
      const labels: CleanupLabel[] = []
      let cursor = afterId
      while (labels.length <= pageSize) {
        const { rows } = await tx.execute({
          sql: "SELECT id, title, hex_color FROM vikunja_labels WHERE board_id = ? AND (? IS NULL OR id > ?) ORDER BY id LIMIT ?",
          args: [this.scope.boardId, cursor, cursor, batchSize],
        })
        const definitions = rows.map(readDefinition)
        if (definitions.some(label => label === null)) return { ok: false, errorCode: "blocked" }
        const candidates = definitions as CleanupLabel[]
        const used = await findUsedLabelDefinitions(tx, this.scope, candidates, { key: nameKey, valid: isWellFormedLabelName })
        if (!used) return { ok: false, errorCode: "blocked" }
        for (const label of candidates) {
          if (!used.has(label.id)) labels.push(label)
          if (labels.length > pageSize) break
        }
        if (rows.length < batchSize) break
        cursor = candidates.at(-1)!.id
      }
      const nextAfter = labels.length > pageSize ? labels[pageSize - 1]!.id : null
      await tx.commit()
      return { ok: true, labels: labels.slice(0, pageSize), nextAfter }
    } finally {
      tx.close()
    }
  }

  async remove(selection: CleanupSelection[]): Promise<CleanupRemoval> {
    const ids = selection.map(label => label.id)
    if (!selection.length || selection.length > pageSize || new Set(ids).size !== ids.length ||
        selection.some(label => !Number.isSafeInteger(label.id) || label.id < 1 || !/^[a-f0-9]{64}$/.test(label.revision))) {
      return { ok: false, errorCode: "stale" }
    }
    const tx = await this.session(true)
    try {
      const { rows } = await tx.execute({
        sql: "SELECT id, title, hex_color FROM vikunja_labels WHERE board_id = ? AND id IN (SELECT value FROM json_each(?)) ORDER BY id",
        args: [this.scope.boardId, JSON.stringify(ids)],
      })
      const definitions = rows.map(readDefinition)
      if (definitions.some(label => label === null)) return { ok: false, errorCode: "blocked" }
      const candidates = definitions as CleanupLabel[]
      if (candidates.length !== selection.length || candidates.some(label =>
        selection.find(selected => selected.id === label.id)?.revision !== label.revision)) {
        return { ok: false, errorCode: "stale" }
      }
      const used = await findUsedLabelDefinitions(tx, this.scope, candidates, { key: nameKey, valid: isWellFormedLabelName })
      if (!used) return { ok: false, errorCode: "blocked" }
      if (used.size) return { ok: false, errorCode: "stale" }
      const deleted = await tx.execute({
        sql: "DELETE FROM vikunja_labels WHERE board_id = ? AND id IN (SELECT value FROM json_each(?)) RETURNING id",
        args: [this.scope.boardId, JSON.stringify(ids)],
      })
      if (deleted.rows.length !== ids.length) throw new Error("The selected label removal was incomplete")
      await tx.commit()
      return { ok: true, removed: ids }
    } finally {
      tx.close()
    }
  }
}
