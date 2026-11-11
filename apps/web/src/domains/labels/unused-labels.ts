import { createHash } from "node:crypto"
import type { Client, Transaction } from "@libsql/client"
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

function labelNames(value: unknown, legacyObjects: boolean, emptyTaskSelection = false): string[] | null {
  if (typeof value !== "string") return null
  if (emptyTaskSelection && value.trim() === "") return []
  try {
    const parsed: unknown = JSON.parse(value)
    if (!Array.isArray(parsed)) return null
    const names: string[] = []
    for (const entry of parsed) {
      if (typeof entry === "string" && isWellFormedLabelName(entry)) names.push(nameKey(entry))
      else if (legacyObjects && entry && typeof entry === "object" && typeof entry.name === "string") {
        if (!isWellFormedLabelName(entry.name)) return null
        names.push(nameKey(entry.name))
      } else return null
    }
    return names
  } catch {
    return null
  }
}

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

// Guard the JSON envelope before calling json_extract on historical data.
const draftLabels = (field: "labels" | "newLabels") => `CASE WHEN json_valid(snapshot_json) THEN
  CASE WHEN json_type(snapshot_json) = 'object'
    AND NOT EXISTS (SELECT 1 FROM json_each(snapshot_json) WHERE instr(CAST(key AS BLOB), x'00') > 0)
    AND (SELECT count(*) FROM json_each(snapshot_json) WHERE key = 'version') = 1
    AND (SELECT count(*) FROM json_each(snapshot_json) WHERE key = 'labels') = 1
    AND (SELECT count(*) FROM json_each(snapshot_json) WHERE key = 'newLabels') = 1
    AND json_type(snapshot_json, '$.version') = 'integer' AND json_extract(snapshot_json, '$.version') = 1
    AND json_type(snapshot_json, '$.labels') = 'array' AND json_type(snapshot_json, '$.newLabels') = 'array'
  THEN json_extract(snapshot_json, '$.${field}') END END`
const templateLabels = `CASE WHEN json_valid(template_json) THEN
  CASE WHEN json_type(template_json) = 'object'
    AND NOT EXISTS (SELECT 1 FROM json_each(template_json) WHERE instr(CAST(key AS BLOB), x'00') > 0)
    AND (SELECT count(*) FROM json_each(template_json) WHERE key = 'labels') <= 1 THEN
    CASE WHEN json_type(template_json, '$.labels') IS NULL OR json_type(template_json, '$.labels') = 'null' THEN '[]'
      WHEN json_type(template_json, '$.labels') = 'array' THEN json_extract(template_json, '$.labels') END END END`
const taskLabels = `CASE WHEN labels IS NULL THEN '[]'
  WHEN typeof(labels) = 'text' THEN labels END`

const usageSources = [
  { table: "tasks", labels: taskLabels, extra: "'[]'", legacyObjects: true },
  { table: "task_drafts", labels: draftLabels("labels"), extra: draftLabels("newLabels"), legacyObjects: false },
  { table: "task_templates", labels: templateLabels, extra: "'[]'", legacyObjects: true },
]

async function usedDefinitions(tx: Transaction, definitions: CleanupLabel[]): Promise<Set<number> | null> {
  const candidates = new Set(definitions.map(label => nameKey(label.title)))
  const usedNames = new Set<string>()
  const { rows: linked } = await tx.execute({
    sql: "SELECT DISTINCT label_id FROM vikunja_task_labels WHERE label_id IN (SELECT value FROM json_each(?))",
    args: [JSON.stringify(definitions.map(label => label.id))],
  })
  const used = new Set(linked.map(row => Number(row.label_id)))
  for (const source of usageSources) {
    let cursor: string | null = null
    while (true) {
      const { rows } = await tx.execute({
        sql: `SELECT cursor,
          CASE WHEN length(CAST(selection AS BLOB)) <= ${selectionBytes} THEN selection END AS selection,
          CASE WHEN length(CAST(extra AS BLOB)) <= ${selectionBytes} THEN extra END AS extra
          FROM (SELECT CAST(rowid AS TEXT) AS cursor, ${source.labels} AS selection, ${source.extra} AS extra
            FROM ${source.table} WHERE (? IS NULL OR rowid > CAST(? AS INTEGER)) ORDER BY rowid LIMIT ${batchSize})`,
        args: [cursor, cursor],
      })
      for (const row of rows) {
        const names = labelNames(row.selection, source.legacyObjects, source.table === "tasks")
        const extra = labelNames(row.extra, source.legacyObjects)
        if (!names || !extra) return null
        for (const name of [...names, ...extra]) {
          if (name && candidates.has(name)) usedNames.add(name)
        }
      }
      if (rows.length < batchSize) break
      cursor = String(rows.at(-1)!.cursor)
    }
  }
  for (const label of definitions) {
    if (usedNames.has(nameKey(label.title))) used.add(label.id)
  }
  return used
}

export class UnusedLabelRepository {
  constructor(private client: Client) {}

  async preview(afterId: number | null): Promise<CleanupPreview> {
    const tx = await this.client.transaction("read")
    try {
      const labels: CleanupLabel[] = []
      let cursor = afterId
      while (labels.length <= pageSize) {
        const { rows } = await tx.execute({
          sql: "SELECT id, title, hex_color FROM vikunja_labels WHERE (? IS NULL OR id > ?) ORDER BY id LIMIT ?",
          args: [cursor, cursor, batchSize],
        })
        const definitions = rows.map(readDefinition)
        if (definitions.some(label => label === null)) return { ok: false, errorCode: "blocked" }
        const candidates = definitions as CleanupLabel[]
        const used = await usedDefinitions(tx, candidates)
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
    const tx = await this.client.transaction("write")
    try {
      const { rows } = await tx.execute({
        sql: "SELECT id, title, hex_color FROM vikunja_labels WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id",
        args: [JSON.stringify(ids)],
      })
      const definitions = rows.map(readDefinition)
      if (definitions.some(label => label === null)) return { ok: false, errorCode: "blocked" }
      const candidates = definitions as CleanupLabel[]
      if (candidates.length !== selection.length || candidates.some(label =>
        selection.find(selected => selected.id === label.id)?.revision !== label.revision)) {
        return { ok: false, errorCode: "stale" }
      }
      const used = await usedDefinitions(tx, candidates)
      if (!used) return { ok: false, errorCode: "blocked" }
      if (used.size) return { ok: false, errorCode: "stale" }
      const deleted = await tx.execute({
        sql: "DELETE FROM vikunja_labels WHERE id IN (SELECT value FROM json_each(?)) RETURNING id",
        args: [JSON.stringify(ids)],
      })
      if (deleted.rows.length !== ids.length) throw new Error("The selected label removal was incomplete")
      await tx.commit()
      return { ok: true, removed: ids }
    } finally {
      tx.close()
    }
  }
}
