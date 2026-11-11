const policyTable = "task_inactivity_policy"
const policySql = `CREATE TABLE task_inactivity_policy (
  scope TEXT NOT NULL PRIMARY KEY,
  area_id TEXT UNIQUE REFERENCES areas(id) ON DELETE CASCADE,
  days INTEGER NOT NULL CHECK(typeof(days) = 'integer' AND days BETWEEN -1 AND 365),
  revision TEXT NOT NULL CHECK(length(CAST(revision AS BLOB)) = 32 AND revision NOT GLOB '*[^0-9a-f]*'),
  CHECK((scope = 'default' AND area_id IS NULL AND days >= 0)
    OR (area_id IS NOT NULL AND scope = 'area:' || area_id))
)`
const columnName = "inactivity_touched_at"
const touch = "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)"
const setClock = `${columnName} = MAX(COALESCE(${columnName}, 0), ${touch})`
const generationColumn = "inactivity_generation"
const triggers = [
  ["areas_inactivity_generation", "areas", `CREATE TRIGGER areas_inactivity_generation
    AFTER INSERT ON areas
    BEGIN
      UPDATE areas SET ${generationColumn} = lower(hex(randomblob(16))) WHERE id = NEW.id;
    END`],
  ["tasks_inactivity_touch", "tasks", `CREATE TRIGGER tasks_inactivity_touch
    AFTER UPDATE OF area_id, deferred_at ON tasks
    WHEN OLD.area_id IS NOT NEW.area_id OR (OLD.deferred_at IS NOT NULL AND NEW.deferred_at IS NULL
      AND lower(NEW.status) NOT IN ('complete', 'done', 'archived'))
    BEGIN
      UPDATE tasks SET ${setClock} WHERE id = NEW.id;
    END`],
  ["comments_inactivity_insert", "comments", `CREATE TRIGGER comments_inactivity_insert
    AFTER INSERT ON comments
    BEGIN
      UPDATE tasks SET ${setClock} WHERE id = NEW.task_id;
    END`],
  ["comments_inactivity_update", "comments", `CREATE TRIGGER comments_inactivity_update
    AFTER UPDATE OF content ON comments WHEN OLD.content IS NOT NEW.content
    BEGIN
      UPDATE tasks SET ${setClock} WHERE id = NEW.task_id;
    END`],
  ["comments_inactivity_delete", "comments", `CREATE TRIGGER comments_inactivity_delete
    AFTER DELETE ON comments
    BEGIN
      UPDATE tasks SET ${setClock} WHERE id = OLD.task_id;
    END`],
]

async function reconcileColumn(db, createMissing) {
  const { rows } = await db.execute("PRAGMA table_info(tasks)")
  const column = rows.find(row => row.name === columnName)
  if (!column && createMissing) {
    await db.execute(`ALTER TABLE tasks ADD COLUMN ${columnName} INTEGER`)
  } else if (!column || String(column.type).toUpperCase() !== "INTEGER" ||
    column.notnull !== 0 || column.dflt_value !== null || column.pk !== 0) {
    throw new Error("Unexpected task inactivity clock column")
  }
}

async function reconcilePolicy(db, createMissing) {
  const { rows: [table] } = await db.execute({
    sql: "SELECT type, sql FROM sqlite_schema WHERE name = ?", args: [policyTable],
  })
  if (!table && createMissing) {
    await db.execute(policySql)
  } else if (table?.type !== "table" || typeof table.sql !== "string" ||
    table.sql.trim() !== policySql.trim()) {
    throw new Error("Unexpected task inactivity policy table")
  }
}

export async function applyTaskInactivityMigration(tx) {
  await reconcileColumn(tx, true)
  await reconcilePolicy(tx, true)
}

export async function validateTaskInactivitySchema(db) {
  await reconcileColumn(db, false)
  await reconcilePolicy(db, false)
}

/** Runtime schema initialization owns the Areas and historical comments tables. */
export async function installTaskInactivityTriggers(tx) {
  const { rows } = await tx.execute("PRAGMA table_info(areas)")
  const generation = rows.find(row => row.name === generationColumn)
  if (!generation) {
    await tx.execute(`ALTER TABLE areas ADD COLUMN ${generationColumn} TEXT`)
  } else if (String(generation.type).toUpperCase() !== "TEXT" || generation.notnull !== 0 ||
      generation.dflt_value !== null || generation.pk !== 0) {
    throw new Error("Unexpected Area inactivity generation column")
  }
  await tx.execute(`UPDATE areas SET ${generationColumn} = lower(hex(randomblob(16))) WHERE ${generationColumn} IS NULL`)
  const { rows: invalid } = await tx.execute(`SELECT 1 FROM areas
    WHERE length(CAST(${generationColumn} AS BLOB)) <> 32 OR ${generationColumn} GLOB '*[^0-9a-f]*' LIMIT 1`)
  if (invalid.length) throw new Error("Unexpected Area inactivity generation")
  for (const [name, table, sql] of triggers) {
    const { rows: [object] } = await tx.execute({
      sql: "SELECT type, tbl_name, sql FROM sqlite_schema WHERE name = ?", args: [name],
    })
    if (!object) {
      await tx.execute(sql)
    } else if (object.type !== "trigger" || object.tbl_name !== table ||
      typeof object.sql !== "string" || object.sql.trim() !== sql.trim()) {
      throw new Error(`Unexpected task inactivity trigger: ${name}`)
    }
  }
}
