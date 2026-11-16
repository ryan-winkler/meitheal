import { assertBoardStorageWriter, assertNoInboundReferences, matchesSql, moveBoardStorageTables } from "./board-storage-schema.mjs"

const draftColumns = {
  owner_id: "TEXT NOT NULL",
  draft_id: "TEXT NOT NULL UNIQUE",
  revision: "INTEGER NOT NULL CHECK (revision > 0)",
  snapshot_json: "TEXT NOT NULL CHECK (json_valid(snapshot_json))",
  save_attempt_id: "TEXT NOT NULL",
  save_digest: "TEXT NOT NULL",
  updated_at: "INTEGER NOT NULL",
}

const receiptColumns = {
  published_seq: "INTEGER PRIMARY KEY AUTOINCREMENT",
  owner_id: "TEXT NOT NULL",
  draft_id: "TEXT NOT NULL",
  revision: "INTEGER NOT NULL CHECK (revision > 0)",
  attempt_id: "TEXT NOT NULL",
  request_digest: "TEXT NOT NULL",
  task_id: "TEXT NOT NULL",
  event_id: "TEXT NOT NULL UNIQUE",
  published_at: "INTEGER NOT NULL",
}

const boardColumn = "TEXT NOT NULL REFERENCES task_boards(id) ON DELETE RESTRICT"
const latestReceiptIndex = "task_draft_receipts_latest_idx"
const staging = {
  task_drafts: "task_drafts_board_migration",
  task_draft_receipts: "task_draft_receipts_board_migration",
}
const tables = Object.keys(staging)

export const taskBoardDraftStagingNames = Object.freeze(Object.values(staging))

function table(name, columns, ...constraints) {
  const definitions = Object.entries(columns).map(([column, type]) => `${column} ${type}`)
  return {
    name, type: "table", table: name,
    sql: `CREATE TABLE ${name} (${definitions.concat(constraints).join(", ")})`,
    columns: Object.keys(columns),
  }
}

function latestReceipt(columns) {
  return {
    name: latestReceiptIndex, type: "index", table: "task_draft_receipts",
    sql: `CREATE INDEX ${latestReceiptIndex} ON task_draft_receipts (${columns}, published_seq DESC)`,
  }
}

const legacyObjects = [
  table("task_drafts", { ...draftColumns, owner_id: "TEXT NOT NULL PRIMARY KEY" }),
  table("task_draft_receipts", receiptColumns, "UNIQUE (owner_id, draft_id, revision)", "UNIQUE (owner_id, attempt_id)"),
  latestReceipt("owner_id"),
]

const scopedObjects = [
  table("task_drafts", { ...draftColumns, board_id: boardColumn }, "PRIMARY KEY (owner_id, board_id)"),
  table("task_draft_receipts", { ...receiptColumns, board_id: boardColumn },
    "UNIQUE (owner_id, board_id, draft_id, revision)", "UNIQUE (owner_id, board_id, attempt_id)"),
  latestReceipt("owner_id, board_id"),
]

async function validateDraftObjects(db, expected, allowedObjects = []) {
  const { rows } = await db.execute(`SELECT name, type, tbl_name, sql FROM main.sqlite_schema
    WHERE tbl_name COLLATE NOCASE IN ('task_drafts', 'task_draft_receipts') AND sql IS NOT NULL`)
  const owned = rows.filter(row => !allowedObjects.includes(row.name))
  if (owned.length !== expected.length) throw new Error("Unexpected Board draft storage objects")
  for (const object of expected) {
    const installed = owned.find(row => row.name === object.name)
    if (installed?.type !== object.type || installed.tbl_name !== object.table || !matchesSql(installed.sql, object.sql)) {
      throw new Error(`Unexpected Board draft storage ${object.type}: ${object.name}`)
    }
    if (!object.columns) continue
    const { rows: columns } = await db.execute({
      sql: "SELECT name, hidden FROM pragma_table_xinfo(?, 'main') ORDER BY cid",
      args: [object.name],
    })
    if (columns.length !== object.columns.length ||
      columns.some((column, index) => column.name !== object.columns[index] || Number(column.hidden) !== 0)) {
      throw new Error(`Unexpected Board draft storage columns: ${object.name}`)
    }
  }
}

function copyToHousehold(name, columns) {
  return `INSERT INTO main.${name} (${columns}, board_id)
    SELECT ${columns}, 'household' FROM main.${staging[name]}`
}

/** Applies Board drafts in the caller's write transaction, which must roll back on failure. */
export async function applyTaskBoardDraftStorage(tx) {
  await assertBoardStorageWriter(tx, [...tables, ...taskBoardDraftStagingNames, "task_boards"])
  await validateDraftObjects(tx, legacyObjects)
  await assertNoInboundReferences(tx, tables)
  // Preserve the full SQLite integer without decoding it as a JavaScript number.
  const { rows: sequences } = await tx.execute(`SELECT CAST(seq AS TEXT) AS sequence, typeof(seq) AS kind
    FROM main.sqlite_sequence WHERE name = 'task_draft_receipts' LIMIT 2`)
  const [sequence] = sequences
  if (sequences.length > 1 || (sequence && (sequence.kind !== "integer" || !/^\d+$/.test(String(sequence.sequence))))) {
    throw new Error("Unexpected task draft receipt sequence")
  }
  await moveBoardStorageTables(tx, staging)
  await tx.batch([
    scopedObjects[0].sql,
    scopedObjects[1].sql,
    copyToHousehold("task_drafts", ["rowid", ...Object.keys(draftColumns)].join(", ")),
    copyToHousehold("task_draft_receipts", Object.keys(receiptColumns).join(", ")),
    `DROP TABLE main.${staging.task_drafts}`,
    `DROP TABLE main.${staging.task_draft_receipts}`,
    scopedObjects[2].sql,
  ])
  if (sequence) {
    await tx.batch([
      {
        sql: "UPDATE main.sqlite_sequence SET seq = max(seq, CAST(? AS INTEGER)) WHERE name = 'task_draft_receipts'",
        args: [sequence.sequence],
      },
      {
        sql: `INSERT INTO main.sqlite_sequence (name, seq)
          SELECT 'task_draft_receipts', CAST(? AS INTEGER) WHERE NOT EXISTS (
            SELECT 1 FROM main.sqlite_sequence WHERE name = 'task_draft_receipts'
          )`,
        args: [sequence.sequence],
      },
    ])
  }
  await validateTaskBoardDraftStorage(tx)
  const { rows: violations } = await tx.execute(`SELECT 1 FROM pragma_foreign_key_check('task_drafts', 'main')
    UNION ALL SELECT 1 FROM pragma_foreign_key_check('task_draft_receipts', 'main') LIMIT 1`)
  if (violations.length > 0) throw new Error("Board draft storage has foreign key violations")
}

export function validateTaskBoardDraftStorage(db, allowedObjects) {
  return validateDraftObjects(db, scopedObjects, allowedObjects)
}
