export const TASK_EXPERIENCE_SCHEMA_VERSION = 28
export const TASK_EXPERIENCE_MIGRATION = "0018_task_experience.mjs"

const expectedArchivedTableSql = `CREATE TABLE archived_task_favorites (
  task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  task_board_id TEXT NOT NULL,
  archived_at INTEGER NOT NULL
)`

const temporarilyDroppedTriggers = [
  "board_retired_tasks_update",
  "board_retired_task_templates_update",
  "board_retired_kanban_lanes_update",
  "routine_occurrence_date_fixed",
]

const legacyRiceFormulas = new Set([
  "(reach * impact * confidence) / effort",
  "reach * impact * confidence / effort",
  "({reach} * {impact} * {confidence}) / {effort}",
  "{reach} * {impact} * {confidence} / {effort}",
])

const legacyDriceFormulas = new Set([
  "(reach * impact * confidence) / (effort * dependencies)",
  "(({reach} * {impact} * {confidence}) / {effort}) * 2",
  "({reach} * {impact} * {confidence} * 2) / {effort}",
  "({reach} * {impact} * {confidence}) / {effort} * 2",
])

/** @param {string} value */
function normalizeFormula(value) {
  return value.replace(/\s+/g, " ").trim()
}

/** @param {unknown} raw */
function parsePlainObject(raw) {
  if (typeof raw !== "string" || !raw.trim()) return null
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * @param {Pick<import("@libsql/client").Client, "execute">} db
 * @param {string} table
 */
async function readTableColumns(db, table) {
  const { rows } = await db.execute(`SELECT name FROM pragma_table_info('${table}')`)
  return new Set(rows.map(row => String(row.name)))
}

/**
 * @param {Pick<import("@libsql/client").Client, "execute">} db
 * @param {string} type
 * @param {string} name
 */
async function schemaObjectExists(db, type, name) {
  const { rows } = await db.execute({
    sql: "SELECT 1 FROM main.sqlite_schema WHERE type = ? AND name = ? LIMIT 1",
    args: [type, name],
  })
  return rows.length === 1
}

/** @param {Pick<import("@libsql/client").Client, "execute">} db */
export async function readTaskExperienceMigrationState(db) {
  const { rows: [version] } = await db.execute("SELECT value FROM main.app_settings WHERE key = 'schema_version'")
  const { rows: ledger } = await db.execute({
    sql: "SELECT name FROM main.__meitheal_migrations WHERE name = ? COLLATE NOCASE LIMIT 2",
    args: [TASK_EXPERIENCE_MIGRATION],
  })
  const taskColumns = await readTableColumns(db, "tasks")
  const laneColumns = await readTableColumns(db, "kanban_lanes")
  const hasArchivedFavorites = await schemaObjectExists(db, "table", "archived_task_favorites")
  const hasTablePositionIndex = await schemaObjectExists(db, "index", "tasks_board_table_position_idx")
  const hasBoardParentIndex = await schemaObjectExists(db, "index", "tasks_board_parent_id_idx")
  const hasBoardCreatedIndex = await schemaObjectExists(db, "index", "tasks_board_created_id_idx")
  const hasFavoriteIndex = await schemaObjectExists(db, "index", "tasks_is_favorite_idx")

  const current = Number(version?.value) >= TASK_EXPERIENCE_SCHEMA_VERSION
  if (current) {
    const valid =
      ledger.length === 1 &&
      ledger[0]?.name === TASK_EXPERIENCE_MIGRATION &&
      taskColumns.has("table_position") &&
      !taskColumns.has("is_favorite") &&
      laneColumns.has("color") &&
      hasArchivedFavorites &&
      hasTablePositionIndex &&
      (!taskColumns.has("parent_id") || hasBoardParentIndex) &&
      hasBoardCreatedIndex &&
      !hasFavoriteIndex
    if (!valid) throw new Error("The Meitheal task experience schema markers disagree")
    return true
  }

  const partial =
    ledger.length > 0 ||
    taskColumns.has("table_position") ||
    laneColumns.has("color") ||
    hasArchivedFavorites ||
    hasTablePositionIndex ||
    hasBoardParentIndex ||
    hasBoardCreatedIndex
  if (partial) throw new Error("The Meitheal task experience schema markers disagree")
  return false
}

/** @param {import("@libsql/client").Transaction} tx */
export async function applyTaskExperienceMigration(tx) {
  if (await readTaskExperienceMigrationState(tx)) return false

  const now = Date.now()
  const triggerPlaceholders = temporarilyDroppedTriggers.map(() => "?").join(", ")
  const { rows: savedTriggers } = await tx.execute({
    sql: `SELECT name, sql FROM main.sqlite_schema WHERE type = 'trigger' AND name IN (${triggerPlaceholders}) AND sql IS NOT NULL`,
    args: temporarilyDroppedTriggers,
  })

  for (const trigger of savedTriggers) {
    await tx.execute(`DROP TRIGGER IF EXISTS ${String(trigger.name)}`)
  }

  try {
    await tx.execute(expectedArchivedTableSql)

    const taskColumns = await readTableColumns(tx, "tasks")
    if (taskColumns.has("is_favorite")) {
      await tx.execute({
        sql: `INSERT OR IGNORE INTO archived_task_favorites (task_id, task_board_id, archived_at)
              SELECT id, COALESCE(task_board_id, 'household'), ? FROM tasks WHERE is_favorite = 1`,
        args: [now],
      })
      await tx.execute("DROP INDEX IF EXISTS tasks_is_favorite_idx")
      await tx.execute("ALTER TABLE tasks DROP COLUMN is_favorite")
    }

    if (!taskColumns.has("table_position")) {
      await tx.execute("ALTER TABLE tasks ADD COLUMN table_position INTEGER")
    }

    await tx.execute(`
      WITH ranked AS (
        SELECT id,
               ROW_NUMBER() OVER (
                 PARTITION BY COALESCE(task_board_id, '')
                 ORDER BY COALESCE(kanban_position, 2147483647) ASC, created_at ASC, id ASC
               ) * 65536 AS pos
        FROM tasks
      )
      UPDATE tasks
      SET table_position = (SELECT pos FROM ranked WHERE ranked.id = tasks.id)
      WHERE table_position IS NULL
    `)

    if (taskColumns.has("due_date")) {
      await tx.execute("UPDATE tasks SET due_date = NULL WHERE due_date IS NOT NULL AND trim(due_date) = ''")
    }

    await tx.execute("CREATE INDEX IF NOT EXISTS tasks_board_table_position_idx ON tasks(task_board_id, table_position)")
    if (taskColumns.has("parent_id")) {
      await tx.execute("CREATE INDEX IF NOT EXISTS tasks_board_parent_id_idx ON tasks(task_board_id, parent_id)")
    }
    await tx.execute("CREATE INDEX IF NOT EXISTS tasks_board_created_id_idx ON tasks(task_board_id, created_at DESC, id ASC)")

    const laneColumns = await readTableColumns(tx, "kanban_lanes")
    if (!laneColumns.has("color")) {
      await tx.execute("ALTER TABLE kanban_lanes ADD COLUMN color TEXT")
    }

    if (await schemaObjectExists(tx, "table", "saved_filters")) {
      const { rows: filterRows } = await tx.execute("SELECT id, query_json FROM saved_filters")
      for (const row of filterRows) {
        const query = parsePlainObject(row.query_json)
        if (!query || !Object.hasOwn(query, "favorite")) continue
        const rawFav = query.favorite
        const isTruthy = rawFav === true || rawFav === 1 || rawFav === "1" || rawFav === "true"
        const next = { ...query }
        delete next.favorite
        if (isTruthy) {
          if (next.promoted === undefined) next.promoted = true
          next._migratedFromFavorite = true
        }
        await tx.execute({
          sql: "UPDATE saved_filters SET query_json = ?, updated_at = ? WHERE id = ?",
          args: [JSON.stringify(next), now, row.id],
        })
      }
    }

    if (await schemaObjectExists(tx, "table", "task_templates")) {
      const { rows: templateRows } = await tx.execute("SELECT id, template_json FROM task_templates")
      for (const row of templateRows) {
        const tpl = parsePlainObject(row.template_json)
        if (!tpl || !Object.hasOwn(tpl, "is_favorite")) continue
        const next = { ...tpl }
        delete next.is_favorite
        await tx.execute({
          sql: "UPDATE task_templates SET template_json = ?, updated_at = ? WHERE id = ?",
          args: [JSON.stringify(next), now, row.id],
        })
      }
    }

    if (await schemaObjectExists(tx, "table", "framework_configs")) {
      const { rows: frameworkRows } = await tx.execute(
        "SELECT id, framework_id, overrides FROM framework_configs WHERE framework_id IN ('rice', 'drice')"
      )
      for (const row of frameworkRows) {
        const overrides = parsePlainObject(row.overrides)
        if (!overrides) continue
        let changed = false
        const next = structuredClone(overrides)
        if (typeof next.formula === "string") {
          const norm = normalizeFormula(next.formula)
          if (row.framework_id === "rice" && legacyRiceFormulas.has(norm)) {
            next.formula = "(reach * impact * (confidence / 100)) / effort"
            changed = true
          } else if (row.framework_id === "drice" && legacyDriceFormulas.has(norm)) {
            next.formula = "(reach * impact * (confidence / 100)) / (effort * dependencies)"
            changed = true
          }
        }
        if (next.fields && typeof next.fields === "object" && !Array.isArray(next.fields)) {
          for (const field of Object.values(next.fields)) {
            if (field && typeof field === "object" && !Array.isArray(field) && Object.hasOwn(field, "min")) {
              delete field.min
              changed = true
            }
          }
        }
        if (changed) {
          await tx.execute({
            sql: "UPDATE framework_configs SET overrides = ?, updated_at = ? WHERE id = ?",
            args: [JSON.stringify(next), new Date(now).toISOString(), row.id],
          })
        }
      }
    }
  } finally {
    for (const trigger of savedTriggers) {
      await tx.execute(String(trigger.sql))
    }
  }

  await tx.batch([
    {
      sql: "INSERT INTO main.__meitheal_migrations (name, applied_at) VALUES (?, ?)",
      args: [TASK_EXPERIENCE_MIGRATION, now],
    },
    {
      sql: "UPDATE main.app_settings SET value = ?, updated_at = ? WHERE key = 'schema_version'",
      args: [String(TASK_EXPERIENCE_SCHEMA_VERSION), now],
    },
  ])

  if (!(await readTaskExperienceMigrationState(tx))) {
    throw new Error("Cannot commit task experience schema")
  }
  return true
}
