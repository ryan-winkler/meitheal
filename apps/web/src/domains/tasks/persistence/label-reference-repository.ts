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

/** Owns task/draft/template changes inside the vocabulary owner's writer transaction. */
export async function rewriteLabelReferences(tx: Transaction, action: Rewrite): Promise<Result> {
  const utf8 = new TextEncoder()
  for (const source of sources) {
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
            FROM ${source.table} WHERE (? IS NULL OR rowid > CAST(? AS INTEGER)) ORDER BY rowid LIMIT ${batchSize})`,
        args: [cursor, cursor],
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
          sql = "UPDATE tasks SET labels=?, updated_at=? WHERE rowid=CAST(? AS INTEGER) RETURNING CAST(rowid AS TEXT) AS cursor"
          args.push(clock + 1, String(row.cursor))
        } else if (source.table === "task_drafts") {
          sql = `UPDATE task_drafts SET snapshot_json=json_set(snapshot_json,'$.labels',json(?),'$.newLabels',json(?)),
            revision=revision+1, updated_at=MAX(updated_at+1,?), save_attempt_id='', save_digest=''
            WHERE rowid=CAST(? AS INTEGER) RETURNING CAST(rowid AS TEXT) AS cursor`
          args.push(extraJson, action.now, String(row.cursor))
        } else {
          sql = `UPDATE task_templates SET template_json=json_set(template_json,'$.labels',json(?)),
            updated_at=MAX(updated_at+1,?) WHERE rowid=CAST(? AS INTEGER) RETURNING CAST(rowid AS TEXT) AS cursor`
          args.push(action.now, String(row.cursor))
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
