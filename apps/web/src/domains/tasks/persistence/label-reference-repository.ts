import type { BoardScope } from "../board-scope"
import { taskOwnedBy, ownedPlanning } from "./board-storage"
import { sql as statement, type SqlFragment } from "./sql-fragment"
import type { InStatement, InValue } from "@libsql/client"
import type { Transaction } from "@libsql/client"
import { canAdvanceTaskTimestampMs, taskTimestampMs } from "./task-timestamp"

type Entry = string | { name: string; [key: string]: unknown }
type Result = { ok: true } | { ok: false; errorCode: "blocked" }
const blocked = { ok: false, errorCode: "blocked" } as const
const batchSize = 250
const selectionBytes = 64 * 1024

interface Rewrite {
  validName: (name: string) => boolean
  matchesOld: (name: string) => boolean
  destination: string | null
  matchesDestination: (name: string) => boolean
  now: number
}

function entries(value: unknown, legacy: boolean, empty = false): Entry[] | null {
  if (typeof value !== "string") return null
  if (empty && !value.trim()) return []
  try {
    // Retain primitive number tokens in arbitrary historical metadata. Parsing
    // those through IEEE numbers can silently round IDs or turn 1e999 into null.
    const parsed: unknown = JSON.parse(value, legacy ? (_key: string, entry: unknown, context?: { source?: string }) => {
      if (typeof entry !== "number") return entry
      const rawJSON = (JSON as unknown as { rawJSON?: (source: string) => unknown }).rawJSON
      if (!rawJSON || context?.source === undefined) throw new Error("Lossless JSON numbers are unavailable")
      return rawJSON(context.source)
    } : undefined)
    if (!Array.isArray(parsed)) return null
    if (!parsed.every(entry => typeof entry === "string" || (legacy && entry !== null &&
      typeof entry === "object" && !Array.isArray(entry) && typeof entry.name === "string"))) return null
    return parsed
  } catch {
    return null
  }
}

const name = (entry: Entry) => typeof entry === "string" ? entry : entry.name

function rewrite(before: Entry[], action: Rewrite) {
  if (!before.some(entry => action.matchesOld(name(entry)))) {
    return { changed: false, entries: before }
  }
  const after: Entry[] = []
  let destinationSeen = false
  for (const entry of before) {
    const old = action.matchesOld(name(entry))
    if (action.destination === null) {
      if (!old) after.push(entry)
    } else if (old || action.matchesDestination(name(entry))) {
      if (!destinationSeen) {
        after.push(typeof entry === "string" ? action.destination : { ...entry, name: action.destination })
        destinationSeen = true
      }
    } else after.push(entry)
  }
  return { changed: JSON.stringify(before) !== JSON.stringify(after), entries: after }
}

// Extract only selections. Ambiguous envelopes must not expose or rewrite private bodies.
const draftSelection = (field: "labels" | "newLabels") => `CASE WHEN json_valid(snapshot_json) THEN
  CASE WHEN json_type(snapshot_json) = 'object'
    AND NOT EXISTS (SELECT 1 FROM json_each(snapshot_json) WHERE instr(CAST(key AS BLOB), x'00') > 0)
    AND (SELECT count(*) FROM json_each(snapshot_json) WHERE key = 'version') = 1
    AND (SELECT count(*) FROM json_each(snapshot_json) WHERE key = 'labels') = 1
    AND (SELECT count(*) FROM json_each(snapshot_json) WHERE key = 'newLabels') = 1
    AND json_type(snapshot_json, '$.version') = 'integer' AND json_extract(snapshot_json, '$.version') = 1
    AND json_type(snapshot_json, '$.labels') = 'array' AND json_type(snapshot_json, '$.newLabels') = 'array'
  THEN json_extract(snapshot_json, '$.${field}') END END`
const templateSelection = `CASE WHEN json_valid(template_json) THEN
  CASE WHEN json_type(template_json) = 'object'
    AND NOT EXISTS (SELECT 1 FROM json_each(template_json) WHERE instr(CAST(key AS BLOB), x'00') > 0)
    AND (SELECT count(*) FROM json_each(template_json) WHERE key = 'labels') <= 1 THEN
    CASE WHEN json_type(template_json, '$.labels') IS NULL OR json_type(template_json, '$.labels') = 'null' THEN '[]'
      WHEN json_type(template_json, '$.labels') = 'array' THEN json_extract(template_json, '$.labels') END END END`
const integerClock = "typeof(updated_at) = 'integer' AND updated_at BETWEEN 0 AND 9007199254740990"
const revision = "typeof(revision) = 'integer' AND revision BETWEEN 1 AND 9007199254740990"
const sources = [
  { table: "tasks", selection: "CASE WHEN labels IS NULL THEN '[]' WHEN typeof(labels) = 'text' THEN labels END",
    extra: "'[]'", validClock: canAdvanceTaskTimestampMs("updated_at"), clock: taskTimestampMs("updated_at"),
    validRevision: "1", revision: "0", legacy: true },
  { table: "task_drafts", selection: draftSelection("labels"), extra: draftSelection("newLabels"),
    validClock: integerClock, clock: "updated_at", validRevision: revision, revision: "revision", legacy: false },
  { table: "task_templates", selection: templateSelection, extra: "'[]'",
    validClock: integerClock, clock: "updated_at", validRevision: "1", revision: "0", legacy: true },
] as const

function sourceOwner(scope: BoardScope, table: "tasks" | "task_drafts" | "task_templates"): SqlFragment {
  return table === "tasks" ? taskOwnedBy(scope) : table === "task_templates" ? ownedPlanning(scope, table) :
    statement`board_id = ${scope.boardId} AND owner_id = ${scope.principal.id}`
}

/** Owns task/draft/template changes inside the vocabulary owner's writer transaction. */
export async function rewriteLabelReferences(tx: Transaction, scope: BoardScope, action: Rewrite): Promise<Result> {
  const utf8 = new TextEncoder()
  for (const source of sources) {
    const ownership = sourceOwner(scope, source.table)
    let cursor: string | null = null
    while (true) {
      const { rows } = await tx.execute({
        sql: `SELECT cursor,
          CASE WHEN length(CAST(selection AS BLOB)) <= ${selectionBytes} THEN selection END AS selection,
          CASE WHEN length(CAST(extra AS BLOB)) <= ${selectionBytes} THEN extra END AS extra,
          clock_valid, clock, revision_valid, revision
          FROM (SELECT CAST(rowid AS TEXT) AS cursor, ${source.selection} AS selection, ${source.extra} AS extra,
            CASE WHEN ${source.validClock} THEN 1 ELSE 0 END AS clock_valid,
            CASE WHEN ${source.validClock} THEN ${source.clock} END AS clock,
            CASE WHEN ${source.validRevision} THEN 1 ELSE 0 END AS revision_valid,
            CASE WHEN ${source.validRevision} THEN ${source.revision} END AS revision
            FROM ${source.table} WHERE (? IS NULL OR rowid > CAST(? AS INTEGER))
              AND (${ownership.sql}) ORDER BY rowid LIMIT ${batchSize})`,
        args: [cursor, cursor, ...ownership.args],
      })
      for (const row of rows) {
        const selected = entries(row.selection, source.legacy, source.table === "tasks")
        const extra = entries(row.extra, false)
        if (!selected || !extra) return blocked
        if ([...selected, ...extra].some(entry => !action.validName(name(entry)))) return blocked
        if (source.table === "task_drafts" && !extra.every(item => selected.includes(item))) return blocked
        const result = rewrite(selected, action)
        const extraResult = rewrite(extra, action)
        if (!result.changed && !extraResult.changed) continue
        const selectionJson = JSON.stringify(result.entries)
        const extraJson = JSON.stringify(extraResult.entries)
        if (utf8.encode(selectionJson).byteLength > selectionBytes || utf8.encode(extraJson).byteLength > selectionBytes) return blocked
        if (row.clock_valid !== 1 || row.revision_valid !== 1) return blocked
        const clock = Number(row.clock)
        const args: (string | number)[] = [selectionJson]
        let sql: string
        if (source.table === "tasks") {
          sql = `UPDATE tasks SET labels=?, updated_at=? WHERE (${ownership.sql}) AND rowid=CAST(? AS INTEGER) RETURNING CAST(rowid AS TEXT) AS cursor`
          args.push(clock + 1, ...ownership.args as (string | number)[], String(row.cursor))
        } else if (source.table === "task_drafts") {
          sql = `UPDATE task_drafts SET snapshot_json=json_set(snapshot_json,'$.labels',json(?),'$.newLabels',json(?)),
            revision=revision+1, updated_at=MAX(updated_at+1,?), save_attempt_id='', save_digest=''
            WHERE (${ownership.sql}) AND rowid=CAST(? AS INTEGER) RETURNING CAST(rowid AS TEXT) AS cursor`
          args.push(extraJson, action.now, ...ownership.args as (string | number)[], String(row.cursor))
        } else {
          sql = `UPDATE task_templates SET template_json=json_set(template_json,'$.labels',json(?)),
            updated_at=MAX(updated_at+1,?) WHERE (${ownership.sql}) AND rowid=CAST(? AS INTEGER) RETURNING CAST(rowid AS TEXT) AS cursor`
          args.push(action.now, ...ownership.args as (string | number)[], String(row.cursor))
        }
        const changed = await tx.execute({ sql, args })
        if (changed.rows.length !== 1) throw new Error("Label reference write did not return its row")
      }
      if (rows.length < batchSize) break
      cursor = String(rows.at(-1)!.cursor)
    }
  }
  return { ok: true }
}

/** Add an explicitly created label only if the task write in this batch won. */
export function taskLabelInsert(scope: BoardScope, title: string, taskId: string, requestId: string): InStatement {
  return statement`INSERT INTO vikunja_labels (board_id, title, hex_color)
    SELECT ${scope.boardId}, ${title}, '6b7280' WHERE EXISTS (
      SELECT 1 FROM tasks WHERE id = ${taskId} AND request_id = ${requestId} AND ${taskOwnedBy(scope)})
      AND NOT EXISTS (SELECT 1 FROM vikunja_labels WHERE board_id = ${scope.boardId} AND lower(title) = lower(${title}))`
}


/** Label context supplies definitions; Tasks owns scanning its scoped references. */
export async function findUsedLabelDefinitions(tx: Transaction, scope: BoardScope, definitions: readonly { id: number, title: string }[], names: { key: (name: string) => string, valid: (name: string) => boolean }): Promise<Set<number> | null> {
  const usedNames = new Set<string>()
  const { rows: linked } = await tx.execute(statement`SELECT DISTINCT label_id FROM vikunja_task_labels
    WHERE label_id IN (SELECT value FROM json_each(${JSON.stringify(definitions.map(label => label.id))}))`)
  const used = new Set(linked.map(row => Number(row.label_id)))
  for (const source of sources) {
    const ownership = sourceOwner(scope, source.table)
    let cursor: string | null = null
    while (true) {
      const { rows } = await tx.execute({
        sql: `SELECT cursor, CASE WHEN length(CAST(selection AS BLOB)) <= ${selectionBytes} THEN selection END AS selection,
          CASE WHEN length(CAST(extra AS BLOB)) <= ${selectionBytes} THEN extra END AS extra
          FROM (SELECT CAST(rowid AS TEXT) AS cursor, ${source.selection} AS selection, ${source.extra} AS extra
            FROM ${source.table} WHERE (? IS NULL OR rowid > CAST(? AS INTEGER)) AND (${ownership.sql}) ORDER BY rowid LIMIT ${batchSize})`,
        args: [cursor, cursor, ...ownership.args],
      })
      for (const row of rows) {
        const selected = entries(row.selection, source.legacy, source.table === "tasks")
        const extra = entries(row.extra, false)
        if (!selected || !extra || [...selected, ...extra].some(entry => !names.valid(name(entry)))) return null
        for (const entry of [...selected, ...extra]) usedNames.add(names.key(name(entry)))
      }
      if (rows.length < batchSize) break
      cursor = String(rows.at(-1)!.cursor)
    }
  }
  for (const label of definitions) if (usedNames.has(names.key(label.title))) used.add(label.id)
  return used
}

/** Remove only this Board's junctions; reject foreign/corrupt references without disclosing them. */
export async function removeBoardLabelJunctions(tx: Transaction, scope: BoardScope, id: number): Promise<boolean> {
  await tx.execute(statement`DELETE FROM vikunja_task_labels WHERE label_id = ${id}
    AND EXISTS (SELECT 1 FROM tasks WHERE tasks.id = vikunja_task_labels.task_id AND ${taskOwnedBy(scope)})`)
  return !(await tx.execute(statement`SELECT 1 FROM vikunja_task_labels WHERE label_id = ${id} LIMIT 1`)).rows.length
}
