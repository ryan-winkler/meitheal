import { execFileSync, spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { once } from "node:events"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath } from "node:url"
import { expect, test as base } from "@playwright/test"
import { applyTaskBoardStorage, validateTaskBoardStorage } from "../../apps/web/drizzle/migrations/0009_task_boards.mjs"
import { applyTaskBoardDraftStorage } from "../../apps/web/drizzle/migrations/task-board-drafts.mjs"
import {
  applyTaskBoardUpgrade, readTaskBoardMigrationState, TASK_BOARD_MIGRATION, validateTaskBoardUpgrade,
} from "../../apps/web/drizzle/migrations/task-board-upgrade.mjs"
import { openDatabase, openDatabaseForStartup } from "../../apps/web/scripts/database-client.mjs"
import { prepareTaskBoardPredecessor, predecessorMigrationNames } from "../scripts/task-board-predecessor"

type Client = ReturnType<typeof openDatabase>

const test = base.extend<{ predecessor: Client, databaseUrl: string }>({
  databaseUrl: async ({}, use) => {
    const directory = await mkdtemp(join(tmpdir(), "meitheal-board-migration-"))
    try {
      await use(`file:${join(directory, "meitheal.db")}`)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  },
  predecessor: async ({ databaseUrl }, use) => {
    const db = openDatabase(databaseUrl)
    try {
      await prepareTaskBoardPredecessor(db)
      await db.batch([
        `CREATE TABLE boards (
          id TEXT PRIMARY KEY, title TEXT NOT NULL, icon TEXT NOT NULL DEFAULT '📋',
          color TEXT NOT NULL DEFAULT '#6366F1', position INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
          wip_limit INTEGER NOT NULL DEFAULT 0, energy_budget REAL NOT NULL DEFAULT 0,
          review_cadence INTEGER NOT NULL DEFAULT 0, last_reviewed_at INTEGER
        )`,
        `INSERT INTO boards (id, title, position, created_at, updated_at)
          VALUES ('default', 'Old default', 0, 1, 1), ('historic-board', 'Old Board', 3, 1, 2)`,
        `UPDATE boards SET wip_limit = 5, energy_budget = 2.5, review_cadence = 7, last_reviewed_at = 100
          WHERE id = 'historic-board'`,
        "ALTER TABLE tasks ADD COLUMN board_id TEXT NOT NULL DEFAULT 'default'",
        "CREATE INDEX tasks_board_id_idx ON tasks(board_id)",
        "DROP INDEX tasks_board_status_idx",
        "CREATE INDEX tasks_board_status_idx ON tasks(board_id, status)",
        `INSERT INTO areas (id, name, created_at, updated_at) VALUES ('fixture-area', 'Household Area', 1, 1)`,
        `INSERT INTO kanban_lanes (id, key, label, icon, position, wip_limit, includes, built_in, created_at, updated_at)
          VALUES ('fixture-lane', 'review', 'Review', 'R', 7, 4, '["review","in_progress"]', 0, 1, 2)`,
        `WITH RECURSIVE fixture(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM fixture WHERE n < 2000)
          INSERT INTO tasks (id, title, status, area_id, board_id, ticket_number, priority, is_promoted,
                             idempotency_key, request_id, created_at, updated_at)
          SELECT 'fixture-' || n, 'Fixture ' || n, CASE n % 2 WHEN 0 THEN 'active' ELSE 'review' END,
                 'fixture-area', CASE n % 2 WHEN 0 THEN 'default' ELSE 'historic-board' END,
                 n, 1 + n % 5, n % 2, 'fixture-' || n, 'fixture-' || n, n, n FROM fixture`,
        "UPDATE tasks SET area_id = '__meitheal_no_area__' WHERE id = 'fixture-7'",
      ], "write")
      await prepareTaskBoardPredecessor(db)
      await use(db)
    } finally {
      db.close()
    }
  },
})

async function predecessorRows(db: Client) {
  return Promise.all(["boards", "areas", "tasks", "kanban_lanes"].map(async table => {
    const { rows: columns } = await db.execute({ sql: "SELECT name FROM pragma_table_info(?) ORDER BY cid", args: [table] })
    const projection = columns.map(column => String(column.name)).filter(name =>
      name !== "owner_board_id" && (table !== "areas" || name !== "retired_at") && (table === "tasks"
        ? !["task_board_id", "board_column_id", "ticket_ref"].includes(name)
        : table !== "kanban_lanes" || name !== "board_id"),
    ).map(name => `"${name.replaceAll('"', '""')}"`).join(", ")
    const { rows } = await db.execute(`SELECT rowid AS fixture_rowid, ${projection} FROM ${table} ORDER BY rowid`)
    return { table, count: rows.length, hash: createHash("sha256").update(JSON.stringify(rows)).digest("hex") }
  }))
}

test("Board storage preserves the historical Board IDs and 2,000 Household rows", async ({ predecessor: db }) => {
  const before = await predecessorRows(db)
  expect(before.find(row => row.table === "tasks")?.count).toBe(2000)
  const abandoned = await db.transaction("write")
  try {
    await applyTaskBoardStorage(abandoned)
    await validateTaskBoardStorage(abandoned)
    await abandoned.rollback()
  } finally {
    abandoned.close()
  }
  expect(await predecessorRows(db)).toEqual(before)
  expect((await db.execute("SELECT name FROM sqlite_schema WHERE name = 'task_boards'")).rows).toEqual([])

  const upgrade = await db.transaction("write")
  try {
    expect((await upgrade.execute("PRAGMA foreign_keys")).rows[0]?.foreign_keys).toBe(1)
    await applyTaskBoardStorage(upgrade)
    await validateTaskBoardStorage(upgrade)
    await upgrade.commit()
  } finally {
    upgrade.close()
  }
  expect(await predecessorRows(db)).toEqual(before)
  expect((await db.execute("SELECT id FROM task_boards")).rows).toEqual([{ id: "household" }])
  expect((await db.execute("SELECT count(*) AS count FROM tasks WHERE task_board_id IS NULL AND board_column_id IS NULL")).rows)
    .toEqual([{ count: 2000 }])
  expect((await db.execute("SELECT id, board_id, includes FROM kanban_lanes WHERE id = 'fixture-lane'")).rows)
    .toEqual([{ id: "fixture-lane", board_id: "household", includes: '["review","in_progress"]' }])
  expect((await db.execute("SELECT name FROM pragma_index_info('tasks_board_id_idx')")).rows).toEqual([{ name: "board_id" }])
  expect((await db.execute("SELECT name FROM pragma_index_info('tasks_board_status_idx') ORDER BY seqno")).rows)
    .toEqual([{ name: "area_id" }, { name: "status" }])

  await db.execute(`INSERT INTO tasks (id, title, status, idempotency_key, request_id, created_at, updated_at)
    VALUES ('legacy-writer', 'Still Household', 'pending', 'legacy-writer', 'legacy-writer', 1, 1)`)
  expect((await db.execute("SELECT board_id, task_board_id, board_column_id FROM tasks WHERE id = 'legacy-writer'")).rows)
    .toEqual([{ board_id: "default", task_board_id: null, board_column_id: null }])
  await expect(db.execute(`UPDATE tasks SET task_board_id = 'unknown', area_id = '__meitheal_no_area__'
    WHERE id = 'legacy-writer'`)).rejects.toThrow(/FOREIGN KEY/)
  await expect(db.execute("UPDATE tasks SET board_column_id = 'fixture-lane' WHERE id = 'legacy-writer'")).rejects.toThrow(/constraint|mismatch/i)
  expect((await db.execute("PRAGMA integrity_check(1)")).rows).toEqual([{ integrity_check: "ok" }])
  expect((await db.execute("PRAGMA foreign_key_check")).rows).toEqual([])

  const named = await db.transaction("write")
  try {
    const boardA = "df6d071d-d335-421f-9e2c-1f4034a2a493"
    const boardB = "df6d071d-d335-421f-9e2c-1f4034a2a494"
    await named.execute({
      sql: `INSERT INTO task_boards (id, name, ticket_prefix, created_at, updated_at)
            VALUES (?, 'Board A', 'ABCDEFGH', 1, 1), (?, 'Board B', 'BCDEFGH2', 1, 1)`,
      args: [boardA, boardB],
    })
    await expect(named.execute({
      sql: `INSERT OR REPLACE INTO task_boards (id, name, ticket_prefix, created_at, updated_at)
            VALUES (?, 'Board B', 'CDEFGH23', 1, 1)`,
      args: [boardB],
    })).rejects.toThrow(/immutable/i)
    await named.execute({
      sql: `INSERT INTO kanban_lanes (id, board_id, key, label, created_at, updated_at)
            VALUES ('lane-a', ?, 'review', 'Review', 1, 1), ('lane-b', ?, 'review', 'Review', 1, 1)`,
      args: [boardA, boardB],
    })
    await expect(named.execute({
      sql: `INSERT OR REPLACE INTO kanban_lanes (id, board_id, key, label, created_at, updated_at)
            VALUES ('lane-b', ?, 'unused', 'Review', 1, 1)`,
      args: [boardA],
    })).rejects.toThrow(/immutable/i)
    await named.execute({
      sql: `UPDATE tasks SET task_board_id = ?, board_column_id = 'lane-a', area_id = '__meitheal_no_area__',
            goal_id = NULL, project_id = NULL WHERE id = 'fixture-1'`,
      args: [boardA],
    })
    await expect(named.execute("UPDATE tasks SET board_column_id = 'lane-b' WHERE id = 'fixture-1'"))
      .rejects.toThrow(/board|column/i)
    await expect(named.execute({ sql: "UPDATE kanban_lanes SET board_id = ?, key = 'unused' WHERE id = 'lane-a'", args: [boardB] }))
      .rejects.toThrow(/board|immutable/i)
    expect((await named.execute("SELECT task_board_id, board_column_id FROM tasks WHERE id = 'fixture-1'")).rows)
      .toEqual([{ task_board_id: boardA, board_column_id: "lane-a" }])
  } finally {
    await named.rollback()
    named.close()
  }
})

test("Board storage refuses to discard an unrecognized installed lane column", async ({ predecessor: db }) => {
  await db.execute("ALTER TABLE kanban_lanes ADD COLUMN preserved_extension TEXT")
  await db.execute("UPDATE kanban_lanes SET preserved_extension = 'keep' WHERE id = 'fixture-lane'")
  const upgrade = await db.transaction("write")
  try {
    await expect(applyTaskBoardStorage(upgrade)).rejects.toThrow(/lane/i)
  } finally {
    await upgrade.rollback()
    upgrade.close()
  }
  expect((await db.execute("SELECT preserved_extension FROM kanban_lanes WHERE id = 'fixture-lane'")).rows)
    .toEqual([{ preserved_extension: "keep" }])
  expect((await db.execute("SELECT name FROM sqlite_schema WHERE name = 'task_boards'")).rows).toEqual([])
})

test("Board storage refuses a predecessor lane dependency before rebuilding the table", async ({ predecessor: db }) => {
  await db.batch([
    "CREATE TABLE installed_lane_ref (lane_id TEXT NOT NULL REFERENCES kanban_lanes(id) ON DELETE CASCADE)",
    "INSERT INTO installed_lane_ref VALUES ('fixture-lane')",
  ], "write")
  const upgrade = await db.transaction("write")
  try {
    await expect(applyTaskBoardStorage(upgrade)).rejects.toThrow(/lane|foreign key/i)
    expect((await upgrade.execute("SELECT lane_id FROM installed_lane_ref")).rows).toEqual([{ lane_id: "fixture-lane" }])
  } finally {
    await upgrade.rollback()
    upgrade.close()
  }
  expect((await db.execute("SELECT name FROM sqlite_schema WHERE name = 'task_boards'")).rows).toEqual([])
})

test("Board storage rolls back when SQLite finds a dependent lane view", async ({ predecessor: db }) => {
  await db.execute("CREATE VIEW installed_lane_view AS SELECT id FROM kanban_lanes WHERE id = 'fixture-lane'")
  const before = await predecessorRows(db)
  const upgrade = await db.transaction("write")
  try {
    await expect(applyTaskBoardStorage(upgrade)).rejects.toThrow(/schema dependencies/i)
  } finally {
    await upgrade.rollback()
    upgrade.close()
  }
  expect(await predecessorRows(db)).toEqual(before)
  expect((await db.execute("SELECT id FROM installed_lane_view")).rows).toEqual([{ id: "fixture-lane" }])
})

test("Board storage detects temporary lane dependencies and shadowed App tables", async ({ predecessor: db }) => {
  const before = await predecessorRows(db)
  for (const [definition, error] of [
    ["CREATE TEMP VIEW installed_lane_view AS SELECT id FROM main.kanban_lanes", /schema dependencies/i],
    ["CREATE TEMP TRIGGER installed_lane_trigger AFTER UPDATE ON main.kanban_lanes BEGIN SELECT 1; END", /schema dependencies/i],
    ["CREATE TEMP TABLE kanban_lanes (id TEXT)", /shadowing an App table/i],
  ] as const) {
    const upgrade = await db.transaction("write")
    try {
      await upgrade.execute(definition)
      await expect(applyTaskBoardStorage(upgrade)).rejects.toThrow(error)
    } finally {
      await upgrade.rollback()
      upgrade.close()
    }
  }
  expect(await predecessorRows(db)).toEqual(before)
})

test("Board storage validation distinguishes SQL type names from constraints", async ({ predecessor: db }) => {
  const upgrade = await db.transaction("write")
  try {
    await applyTaskBoardStorage(upgrade)
    const { rows: [memberTable] } = await upgrade.execute("SELECT sql FROM sqlite_schema WHERE name = 'board_members'")
    const expected = String(memberTable?.sql)
    for (const declaration of ["TEXTNOT NULL", "TEXT\u00a0NOT NULL", "TEXT -- trailing comment\r NOT NULL\n"]) {
      const nullable = expected.replace("ha_user_id TEXT NOT NULL", `ha_user_id ${declaration}`)
      expect(nullable).not.toBe(expected)
      await upgrade.batch(["DROP TABLE board_members", nullable])
      expect((await upgrade.execute(`SELECT "notnull" FROM pragma_table_info('board_members') WHERE name = 'ha_user_id'`)).rows)
        .toEqual([{ notnull: 0 }])
      await expect(validateTaskBoardStorage(upgrade)).rejects.toThrow(/board_members/)
    }
  } finally {
    await upgrade.rollback()
    upgrade.close()
  }
})

test("Board storage validation checks the task constraint outside SQL comments", async ({ predecessor: db }) => {
  const upgrade = await db.transaction("write")
  try {
    await applyTaskBoardStorage(upgrade)
    const { rows: [taskTable] } = await upgrade.execute("SELECT sql FROM sqlite_schema WHERE name = 'tasks'")
    const sql = String(taskTable?.sql)
    const start = sql.indexOf(", task_board_id ")
    const end = sql.indexOf(", board_column_id ", start)
    expect(start).toBeGreaterThan(0)
    expect(end).toBeGreaterThan(start)
    const definition = sql.slice(start, end)
    const drifted = new DatabaseSync(":memory:")
    try {
      drifted.exec(`${sql.slice(0, start)}, task_board_id TEXT REFERENCES task_boards(id) ON DELETE RESTRICT
        /* ${definition} , */${sql.slice(end)}`)
      const driftedSql = String(drifted.prepare("SELECT sql FROM sqlite_schema WHERE name = 'tasks'").get()?.sql)
      const inspection = {
        async execute(statement: Parameters<Client["execute"]>[0]) {
          const result = await upgrade.execute(statement)
          if (statement === "SELECT sql FROM main.sqlite_schema WHERE name = 'tasks' AND type = 'table'" && result.rows[0]) {
            result.rows[0].sql = driftedSql
          }
          return result
        },
      }
      await expect(validateTaskBoardStorage(inspection)).rejects.toThrow(/task_board_id/)
    } finally {
      drifted.close()
    }
  } finally {
    await upgrade.rollback()
    upgrade.close()
  }
})

test("Board storage preserves an unrelated predecessor foreign-key violation", async ({ predecessor: db }) => {
  await db.execute("CREATE TABLE installed_area_ref (area_id TEXT REFERENCES areas(id))")
  await db.execute("PRAGMA foreign_keys = OFF")
  try {
    await db.execute("INSERT INTO installed_area_ref VALUES ('missing-area')")
  } finally {
    await db.execute("PRAGMA foreign_keys = ON")
  }
  const before = (await db.execute("PRAGMA foreign_key_check")).rows
  expect(before).toMatchObject([{ table: "installed_area_ref", parent: "areas" }])
  const upgrade = await db.transaction("write")
  try {
    await applyTaskBoardStorage(upgrade)
    await upgrade.commit()
  } finally {
    upgrade.close()
  }
  expect((await db.execute("PRAGMA foreign_key_check")).rows).toEqual(before)
})

const legacyDraft = `INSERT INTO task_drafts
  (rowid, owner_id, draft_id, revision, snapshot_json, save_attempt_id, save_digest, updated_at)
  VALUES (17, 'owner', 'draft', 4, '{"title":"Retain this draft"}', 'save-17', 'saved-digest', 99)`
const legacyReceipts = `INSERT INTO task_draft_receipts
  (published_seq, owner_id, draft_id, revision, attempt_id, request_digest, task_id, event_id, published_at)
  VALUES (2, 'owner', 'old-draft', 3, 'attempt-2', 'digest-2', 'already-deleted', 'event-2', 20),
         (9, 'owner', 'old-draft', 4, 'attempt-9', 'digest-9', 'fixture-2', 'event-9', 90)`
const nextReceipt = `INSERT INTO task_draft_receipts
  (owner_id, board_id, draft_id, revision, attempt_id, request_digest, task_id, event_id, published_at)
  VALUES ('owner', 'household', 'other-draft', 1, 'attempt-new', 'digest-new', 'fixture-3', 'event-new', 100)`

test("the startup CLI upgrades 2,000 historical tasks and preserves draft publication receipts", async ({ predecessor: db, databaseUrl }) => {
  await db.batch([legacyDraft, legacyReceipts, "DELETE FROM task_draft_receipts WHERE published_seq = 9"], "write")
  const before = await predecessorRows(db)
  const cwd = fileURLToPath(new URL("../../apps/web", import.meta.url))
  const env = { ...process.env, MEITHEAL_DB_URL: databaseUrl }
  const run = (...args: string[]) => execFileSync(process.execPath, ["scripts/migrate.mjs", ...args], {
    cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  })
  expect(run()).toContain("Applied migration: 0009_task_boards.mjs")
  expect(run("--check")).toContain("Migration check passed")
  expect(await predecessorRows(db)).toEqual(before)
  expect((await db.execute("SELECT COUNT(*) AS count FROM areas WHERE owner_board_id IS NOT NULL OR retired_at IS NOT NULL")).rows)
    .toEqual([{ count: 0 }])
  expect((await db.execute("SELECT board_id, draft_id, revision FROM task_drafts")).rows)
    .toEqual([{ board_id: "household", draft_id: "draft", revision: 4 }])
  expect((await db.execute("SELECT board_id, task_id, published_seq FROM task_draft_receipts")).rows)
    .toEqual([{ board_id: "household", task_id: "already-deleted", published_seq: 2 }])
  expect((await db.execute("SELECT seq FROM sqlite_sequence WHERE name = 'task_draft_receipts'")).rows)
    .toEqual([{ seq: 9 }])
})

test("the Board upgrade commits both markers, preserves receipts and keeps named rows unavailable", async ({ predecessor: db, databaseUrl }) => {
  await db.batch([legacyDraft, legacyReceipts, "DELETE FROM task_draft_receipts WHERE published_seq = 9"], "write")
  const beforeDraft = (await db.execute("SELECT rowid, * FROM task_drafts")).rows[0]
  const beforeReceipt = (await db.execute("SELECT * FROM task_draft_receipts")).rows[0]
  const beforeRows = await predecessorRows(db)
  const upgrade = await db.transaction("write")
  try {
    expect(await readTaskBoardMigrationState(upgrade)).toBe("predecessor")
    await applyTaskBoardUpgrade(upgrade, predecessorMigrationNames)
    expect(await readTaskBoardMigrationState(upgrade)).toBe("household-v19")
    await validateTaskBoardUpgrade(upgrade)
    await upgrade.commit()
  } finally {
    upgrade.close()
  }
  const reopened = await openDatabaseForStartup(databaseUrl, { readOnly: true })
  reopened.close()
  expect(await predecessorRows(db)).toEqual(beforeRows)
  expect((await db.execute("SELECT rowid, * FROM task_drafts")).rows).toEqual([{ ...beforeDraft, board_id: "household" }])
  expect((await db.execute("SELECT * FROM task_draft_receipts")).rows).toEqual([{ ...beforeReceipt, board_id: "household" }])
  expect((await db.execute(`${nextReceipt} RETURNING published_seq`)).rows).toEqual([{ published_seq: 10 }])
  await expect(db.execute(`INSERT INTO task_boards (id, name, ticket_prefix, created_at, updated_at)
    VALUES ('named', 'Named', 'ABCDEFGH', 1, 1)`)).rejects.toThrow(/Only the Household Board/)
  await expect(db.execute("UPDATE tasks SET ticket_ref = 'ABCDEFGH-1' WHERE id = 'fixture-1'")).rejects.toThrow(/Only the Household Board/)
  await expect(db.execute("UPDATE task_drafts SET board_id = 'named' WHERE owner_id = 'owner'")).rejects.toThrow(/Only the Household Board/)
  await expect(db.execute("INSERT INTO board_members (board_id, ha_user_id) VALUES ('household', 'new-member')"))
    .rejects.toThrow(/Only the Household Board/)

  const repeat = await db.transaction("write")
  try {
    const marker = `SELECT * FROM __meitheal_migrations WHERE name = '${TASK_BOARD_MIGRATION}'`
    const before = (await repeat.execute(marker)).rows
    await applyTaskBoardUpgrade(repeat, predecessorMigrationNames)
    expect((await repeat.execute(marker)).rows).toEqual(before)
    await repeat.execute("DELETE FROM app_settings WHERE key = 'schema_version'")
    await expect(readTaskBoardMigrationState(repeat)).rejects.toThrow(/markers disagree/)
  } finally {
    await repeat.rollback()
    repeat.close()
  }
})

test("draft storage carries the sequence after all receipts are deleted", async ({ predecessor: db }) => {
  await db.batch([legacyReceipts, "DELETE FROM task_draft_receipts"], "write")
  const upgrade = await db.transaction("write")
  try {
    await applyTaskBoardStorage(upgrade)
    await applyTaskBoardDraftStorage(upgrade)
    expect((await upgrade.execute(`${nextReceipt} RETURNING published_seq`)).rows).toEqual([{ published_seq: 10 }])
    await upgrade.execute(`INSERT INTO task_boards (id, name, ticket_prefix, created_at, updated_at)
      VALUES ('named', 'Named', 'ABCDEFGH', 1, 1)`)
    await upgrade.execute(nextReceipt.replace("'household'", "'named'").replace("'event-new'", "'event-named'"))
    expect((await upgrade.execute("SELECT board_id FROM task_draft_receipts ORDER BY published_seq")).rows)
      .toEqual([{ board_id: "household" }, { board_id: "named" }])
    await expect(upgrade.execute("DELETE FROM task_boards WHERE id = 'named'")).rejects.toThrow(/FOREIGN KEY/)
  } finally {
    await upgrade.rollback()
    upgrade.close()
  }
})

test("draft storage preserves the full SQLite receipt sequence without decoding it as a number", async ({ predecessor: db }) => {
  await db.batch([
    legacyReceipts,
    "DELETE FROM task_draft_receipts",
    "UPDATE sqlite_sequence SET seq = 9223372036854775806 WHERE name = 'task_draft_receipts'",
  ], "write")
  const upgrade = await db.transaction("write")
  try {
    await applyTaskBoardStorage(upgrade)
    await applyTaskBoardDraftStorage(upgrade)
    expect((await upgrade.execute(`${nextReceipt} RETURNING CAST(published_seq AS TEXT) AS sequence`)).rows)
      .toEqual([{ sequence: "9223372036854775807" }])
  } finally {
    await upgrade.rollback()
    upgrade.close()
  }
})

test("Board admission refuses unmarked modern objects and incomplete legacy ledger", async ({ predecessor: db }) => {
  const upgrade = await db.transaction("write")
  try {
    await upgrade.execute("DELETE FROM __meitheal_migrations WHERE name = '0006_task_drafts.mjs'")
    await expect(applyTaskBoardUpgrade(upgrade, predecessorMigrationNames)).rejects.toThrow(/predecessor migrations/)
    await upgrade.execute("ALTER TABLE tasks ADD COLUMN task_board_id TEXT")
    await expect(readTaskBoardMigrationState(upgrade)).rejects.toThrow(/unmarked Board storage/)
  } finally {
    await upgrade.rollback()
    upgrade.close()
  }
})

test("Board upgrade rolls back when a predecessor trigger suppresses the runtime marker", async ({ predecessor: db }) => {
  await db.execute(`CREATE TRIGGER installed_schema_marker_guard BEFORE INSERT ON app_settings
    WHEN NEW.key = 'schema_version' BEGIN SELECT RAISE(IGNORE); END`)
  const before = await predecessorRows(db)
  const upgrade = await db.transaction("write")
  try {
    await expect(applyTaskBoardUpgrade(upgrade, predecessorMigrationNames)).rejects.toThrow(/Unexpected trigger.*marker table/)
  } finally {
    await upgrade.rollback()
    upgrade.close()
  }
  expect(await predecessorRows(db)).toEqual(before)
  expect((await db.execute("SELECT name FROM sqlite_schema WHERE name = 'task_boards'")).rows).toEqual([])
})

test("Board upgrade refuses a marker trigger that would change predecessor data", async ({ predecessor: db }) => {
  await db.batch([
    "INSERT INTO app_settings VALUES ('schema_version', '18', 1)",
    `CREATE TRIGGER installed_schema_data_guard AFTER UPDATE OF value ON app_settings
      WHEN OLD.key = 'schema_version' BEGIN DELETE FROM tasks; END`,
  ], "write")
  const before = await predecessorRows(db)
  const upgrade = await db.transaction("write")
  try {
    await expect(applyTaskBoardUpgrade(upgrade, predecessorMigrationNames)).rejects.toThrow(/Unexpected trigger.*marker table/)
    expect((await upgrade.execute("SELECT value FROM app_settings WHERE key = 'schema_version'")).rows)
      .toEqual([{ value: "18" }])
  } finally {
    await upgrade.rollback()
    upgrade.close()
  }
  expect(await predecessorRows(db)).toEqual(before)
})

test("Board upgrade refuses foreign keys that could rewrite installed settings references", async ({ predecessor: db }) => {
  await db.batch([
    "INSERT INTO app_settings VALUES ('schema_version', '18', 1)",
    "CREATE UNIQUE INDEX installed_settings_value_idx ON app_settings(value)",
    `CREATE TABLE installed_settings_ref (
      value TEXT NOT NULL REFERENCES app_settings(value) ON UPDATE CASCADE
    )`,
    "INSERT INTO installed_settings_ref VALUES ('18')",
  ], "write")
  const upgrade = await db.transaction("write")
  try {
    await expect(applyTaskBoardUpgrade(upgrade, predecessorMigrationNames)).rejects.toThrow(/foreign key references/)
    expect((await upgrade.execute("SELECT value FROM installed_settings_ref")).rows).toEqual([{ value: "18" }])
  } finally {
    await upgrade.rollback()
    upgrade.close()
  }
  expect(await readTaskBoardMigrationState(db)).toBe("predecessor")
})

test("Board upgrade refuses publication that would replace a predecessor ledger row", async ({ predecessor: db }) => {
  await db.batch([
    "ALTER TABLE __meitheal_migrations RENAME TO old_ledger",
    `CREATE TABLE __meitheal_migrations (
      name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL,
      conflict_key TEXT GENERATED ALWAYS AS (CASE name
        WHEN '0009_task_boards.mjs' THEN '0008_task_stall.mjs' ELSE name END) UNIQUE ON CONFLICT REPLACE
    )`,
    "INSERT INTO __meitheal_migrations (name, applied_at) SELECT name, applied_at FROM old_ledger",
    "DROP TABLE old_ledger",
  ], "write")
  const prior = (await db.execute("SELECT * FROM __meitheal_migrations ORDER BY name")).rows
  const upgrade = await db.transaction("write")
  try {
    await expect(applyTaskBoardUpgrade(upgrade, predecessorMigrationNames)).rejects.toThrow(/changed unrelated migration/)
  } finally {
    await upgrade.rollback()
    upgrade.close()
  }
  expect((await db.execute("SELECT * FROM __meitheal_migrations ORDER BY name")).rows).toEqual(prior)
  expect(await readTaskBoardMigrationState(db)).toBe("predecessor")
})

test("Board admission requires both schema marker objects to be ordinary tables", async ({ predecessor: db }) => {
  const upgrade = await db.transaction("write")
  try {
    await upgrade.execute("ALTER TABLE app_settings RENAME TO old_app_settings")
    await upgrade.execute("CREATE VIEW app_settings AS SELECT 'schema_version' AS key, '19' AS value")
    await upgrade.execute({ sql: "INSERT INTO __meitheal_migrations VALUES (?, 1)", args: [TASK_BOARD_MIGRATION] })
    await expect(readTaskBoardMigrationState(upgrade)).rejects.toThrow(/markers must be stored in ordinary tables/)
  } finally {
    await upgrade.rollback()
    upgrade.close()
  }
})

test("Board admission rejects a virtual ledger", async ({ predecessor: db }) => {
  await db.batch([
    "ALTER TABLE __meitheal_migrations RENAME TO old_ledger",
    "CREATE VIRTUAL TABLE __meitheal_migrations USING fts5(name, applied_at)",
    "INSERT INTO __meitheal_migrations SELECT name, applied_at FROM old_ledger",
    "DROP TABLE old_ledger",
  ], "write")
  const before = await predecessorRows(db)
  await expect(readTaskBoardMigrationState(db)).rejects.toThrow(/markers must be stored in ordinary tables/)
  const upgrade = await db.transaction("write")
  try {
    await expect(applyTaskBoardUpgrade(upgrade, predecessorMigrationNames))
      .rejects.toThrow(/markers must be stored in ordinary tables/)
  } finally {
    await upgrade.rollback()
    upgrade.close()
  }
  expect(await predecessorRows(db)).toEqual(before)
})

test("Board admission rejects unrelated owned constraints on v19 lanes and Boards", async ({ predecessor: db }) => {
  const upgrade = await db.transaction("write")
  try {
    await applyTaskBoardUpgrade(upgrade, predecessorMigrationNames)
    for (const [ddl, name, type] of [
      ["CREATE UNIQUE INDEX legacy_global_lane_key ON kanban_lanes(key)", "legacy_global_lane_key", "INDEX"],
      [`CREATE TRIGGER installed_ticket_guard BEFORE UPDATE OF ticket_high_water ON task_boards
        BEGIN SELECT RAISE(IGNORE); END`, "installed_ticket_guard", "TRIGGER"],
    ] as const) {
      await upgrade.execute(ddl)
      await expect(validateTaskBoardUpgrade(upgrade)).rejects.toThrow(`Unexpected Board storage object: ${name}`)
      await upgrade.execute(`DROP ${type} ${name}`)
    }
    await validateTaskBoardUpgrade(upgrade)
  } finally {
    await upgrade.rollback()
    upgrade.close()
  }
})

async function crashSnapshot(db: Client) {
  const tables = ["task_drafts", "task_draft_receipts", "sqlite_sequence", "__meitheal_migrations", "app_settings"]
  return {
    rows: await predecessorRows(db),
    schema: (await db.execute("SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name")).rows,
    draftAndMarkerRows: await Promise.all(tables.map(async table => (await db.execute(`SELECT * FROM ${table} ORDER BY rowid`)).rows)),
  }
}

for (const journal of ["delete", "wal"] as const) {
  test(`a killed Board writer preserves the predecessor and can retry in ${journal} mode`, async ({ predecessor: db, databaseUrl }) => {
    expect((await db.execute(`PRAGMA journal_mode = ${journal}`)).rows).toEqual([{ journal_mode: journal }])
    await db.batch([legacyDraft, legacyReceipts], "write")
    const journalFile = `${databaseUrl.slice(5)}-${journal === "wal" ? "wal" : "journal"}`
    if (journal === "wal") {
      expect((await db.execute("PRAGMA wal_checkpoint(TRUNCATE)")).rows).toMatchObject([{ busy: 0 }])
      expect((await stat(journalFile)).size).toBe(0)
    }
    const before = await crashSnapshot(db)
    const web = fileURLToPath(new URL("../../apps/web", import.meta.url))
    const child = spawn(process.execPath, ["--input-type=module", "--eval", `
      import { openDatabase } from './scripts/database-client.mjs'
      import { applyTaskBoardUpgrade } from './drizzle/migrations/task-board-upgrade.mjs'
      const db = openDatabase(process.env.MEITHEAL_DB_URL)
      const tx = await db.transaction('write')
      await tx.execute('PRAGMA cache_size = 8')
      await tx.execute('PRAGMA cache_spill = ON')
      await applyTaskBoardUpgrade(tx, JSON.parse(process.env.BOARD_PREDECESSOR_MIGRATIONS))
      process.send('ready before commit')
      process.on('message', () => {})
    `], {
      cwd: web,
      env: { ...process.env, MEITHEAL_DB_URL: databaseUrl, BOARD_PREDECESSOR_MIGRATIONS: JSON.stringify(predecessorMigrationNames) },
      stdio: ["ignore", "ignore", "inherit", "ipc"],
    })
    const exited = once(child, "exit")
    try {
      expect(await once(child, "message", { signal: AbortSignal.timeout(10_000) })).toEqual(["ready before commit"])
      expect((await stat(journalFile)).size).toBeGreaterThan(512)
      if (journal === "delete") expect((await readFile(journalFile)).subarray(0, 8).toString("hex")).toBe("d9d505f920a163d7")
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
      await exited
    }
    const recovered = openDatabase(databaseUrl)
    try {
      expect(await crashSnapshot(recovered)).toEqual(before)
      const retry = await recovered.transaction("write")
      try {
        expect(await readTaskBoardMigrationState(retry)).toBe("predecessor")
        await applyTaskBoardUpgrade(retry, predecessorMigrationNames)
        expect(await readTaskBoardMigrationState(retry)).toBe("household-v19")
        await retry.commit()
      } finally {
        retry.close()
      }
      expect((await recovered.execute({ sql: "SELECT name FROM __meitheal_migrations WHERE name = ?", args: [TASK_BOARD_MIGRATION] })).rows)
        .toEqual([{ name: TASK_BOARD_MIGRATION }])
    } finally {
      recovered.close()
    }
  })
}
