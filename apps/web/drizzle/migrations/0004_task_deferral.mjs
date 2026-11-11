const columns = [
  ["deferred_at", "INTEGER"],
  ["deferral_revision", "TEXT"],
]

const indexName = "tasks_deferred_order_idx"
export const taskDeferralTriggerName = "tasks_deferral_status_revision"
const indexSql = `CREATE INDEX ${indexName} ON tasks (deferred_at DESC, id ASC)
  WHERE deferred_at IS NOT NULL`
const triggerSql = `CREATE TRIGGER ${taskDeferralTriggerName} AFTER UPDATE OF status ON tasks
  WHEN OLD.status IS NOT NEW.status
    OR (NEW.deferred_at IS NOT NULL AND lower(NEW.status) IN ('complete', 'done', 'archived'))
  BEGIN
    UPDATE tasks SET
      deferred_at = CASE WHEN lower(NEW.status) IN ('complete', 'done', 'archived') THEN NULL ELSE NEW.deferred_at END,
      deferral_revision = lower(hex(randomblob(16)))
    WHERE id = NEW.id;
  END`

// SQL keywords are case-insensitive. Values such as the stored status are not.
const normalizeSql = sql => sql.split(/('(?:''|[^'])*')/)
  .map((part, index) => index % 2 === 0 ? part.replace(/\s+/g, " ").toLowerCase() : part)
  .join("").trim()

function validateDeferralObject(object, name, type, sql) {
  if (object?.type !== type || object.tbl_name !== "tasks" ||
    typeof object.sql !== "string" || normalizeSql(object.sql) !== normalizeSql(sql)) {
    throw new Error(`Unexpected task deferral ${type}: ${name}`)
  }
}

export function validateExistingTaskDeferralTrigger(object) {
  if (!object) return
  if (object.name !== taskDeferralTriggerName) throw new Error(`Unexpected task deferral trigger: ${taskDeferralTriggerName}`)
  validateDeferralObject(object, taskDeferralTriggerName, "trigger", triggerSql)
}

async function reconcileTaskDeferralSchema(db, createMissing) {
  const table = await db.execute("PRAGMA table_info(tasks)")
  for (const [name, type] of columns) {
    const column = table.rows.find(row => row.name === name)
    if (!column && createMissing) {
      await db.execute(`ALTER TABLE tasks ADD COLUMN ${name} ${type}`)
    } else if (!column || String(column.type).toUpperCase() !== type ||
        column.notnull !== 0 || column.dflt_value !== null || column.pk !== 0) {
      throw new Error(`Unexpected task deferral column: ${name}`)
    }
  }

  for (const [name, type, sql] of [[indexName, "index", indexSql], [taskDeferralTriggerName, "trigger", triggerSql]]) {
    const { rows: [object] } = await db.execute({
      sql: "SELECT type, tbl_name, sql FROM sqlite_schema WHERE name = ?",
      args: [name],
    })
    if (!object && createMissing) {
      await db.execute(sql)
    } else {
      validateDeferralObject(object, name, type, sql)
    }
  }

  const { rows } = await db.execute(`PRAGMA index_xinfo(${indexName})`)
  const keys = rows.filter(row => row.key === 1)
  if (keys.length !== 2 || keys[0]?.name !== "deferred_at" || keys[0].desc !== 1 ||
      keys[1]?.name !== "id" || keys[1].desc !== 0) {
    throw new Error(`Unexpected task deferral index order: ${indexName}`)
  }
}

export function applyTaskDeferralMigration(tx) {
  return reconcileTaskDeferralSchema(tx, true)
}

export function validateTaskDeferralSchema(db) {
  return reconcileTaskDeferralSchema(db, false)
}
