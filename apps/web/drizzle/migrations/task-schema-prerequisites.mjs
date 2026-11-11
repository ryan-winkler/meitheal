import { databaseSchemaCheckSteps, runWriteTransaction } from "../../scripts/database-client.mjs"

const tables = {
  areas: {
    id: "TEXT PRIMARY KEY",
    name: "TEXT NOT NULL",
    icon: "TEXT NOT NULL DEFAULT '📋'",
    color: "TEXT NOT NULL DEFAULT '#6366F1'",
    position: "INTEGER NOT NULL DEFAULT 0",
    created_at: "INTEGER NOT NULL",
    updated_at: "INTEGER NOT NULL",
  },
  goals: {
    id: "TEXT PRIMARY KEY",
    area_id: "TEXT REFERENCES areas(id) ON DELETE SET NULL",
    title: "TEXT NOT NULL",
    description: "TEXT",
    status: "TEXT NOT NULL DEFAULT 'active'",
    target_date: "TEXT",
    created_at: "INTEGER NOT NULL",
    updated_at: "INTEGER NOT NULL",
  },
  projects: {
    id: "TEXT PRIMARY KEY",
    goal_id: "TEXT REFERENCES goals(id) ON DELETE SET NULL",
    title: "TEXT NOT NULL",
    description: "TEXT",
    status: "TEXT NOT NULL DEFAULT 'active'",
    icon: "TEXT NOT NULL DEFAULT '📋'",
    color: "TEXT NOT NULL DEFAULT '#6366F1'",
    position: "INTEGER NOT NULL DEFAULT 0",
    created_at: "INTEGER NOT NULL",
    updated_at: "INTEGER NOT NULL",
  },
  app_settings: {
    key: "TEXT PRIMARY KEY",
    value: "TEXT NOT NULL",
    updated_at: "INTEGER NOT NULL",
  },
  kanban_lanes: {
    id: "TEXT PRIMARY KEY",
    key: "TEXT NOT NULL UNIQUE",
    label: "TEXT NOT NULL",
    icon: "TEXT NOT NULL DEFAULT '📌'",
    position: "INTEGER NOT NULL DEFAULT 0",
    wip_limit: "INTEGER NOT NULL DEFAULT 0",
    includes: "TEXT NOT NULL DEFAULT '[]'",
    built_in: "INTEGER NOT NULL DEFAULT 0",
    created_at: "INTEGER NOT NULL",
    updated_at: "INTEGER NOT NULL",
  },
  comments: {
    id: "INTEGER PRIMARY KEY AUTOINCREMENT",
    task_id: "INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE",
    content: "TEXT NOT NULL",
    author: "TEXT NOT NULL DEFAULT 'user'",
    created_at: "TEXT NOT NULL DEFAULT (datetime('now'))",
  },
}

/** @type {Record<string, Record<string, string>>} */
const addedColumns = {
  areas: {
    wip_limit: "INTEGER NOT NULL DEFAULT 0",
    energy_budget: "REAL NOT NULL DEFAULT 0",
    review_cadence: "INTEGER NOT NULL DEFAULT 0",
    last_reviewed_at: "INTEGER",
  },
  goals: {
    metric_type: "TEXT",
    metric_target: "REAL",
    metric_current: "REAL NOT NULL DEFAULT 0",
  },
  projects: {
    is_default: "INTEGER NOT NULL DEFAULT 0",
    area_id: "TEXT REFERENCES areas(id) ON DELETE SET NULL",
  },
  tasks: {
    area_id: "TEXT NOT NULL DEFAULT 'default'",
    goal_id: "TEXT",
    project_id: "TEXT",
    kanban_position: "INTEGER",
    ticket_number: "INTEGER",
  },
  comments: {
    // Legacy display names cannot establish comment ownership.
    owner_key: "TEXT",
  },
}

const requiredColumns = {
  ...Object.fromEntries(Object.entries(tables).map(([name, columns]) => [name, Object.keys(columns)])),
  tasks: ["id", "status"],
}

const foreignKeys = [
  ["goals", "area_id", "areas", "SET NULL"],
  ["projects", "goal_id", "goals", "SET NULL"],
  ["projects", "area_id", "areas", "SET NULL"],
  ["comments", "task_id", "tasks", "CASCADE"],
]

/** @typedef {{ name: string, table: string, columns: string[], unique?: boolean }} Index */
const areaStatusIndex = { name: "tasks_board_status_idx", table: "tasks", columns: ["area_id", "status"] }
const legacyBoardStatusIndex = { ...areaStatusIndex, columns: ["board_id", "status"] }

/** @type {Index[]} */
const indexes = [
  { name: "goals_area_id_idx", table: "goals", columns: ["area_id"] },
  { name: "goals_status_idx", table: "goals", columns: ["status"] },
  { name: "projects_goal_id_idx", table: "projects", columns: ["goal_id"] },
  { name: "projects_status_idx", table: "projects", columns: ["status"] },
  { name: "projects_goal_status_idx", table: "projects", columns: ["goal_id", "status"] },
  { name: "projects_area_id_idx", table: "projects", columns: ["area_id"] },
  { name: "projects_area_status_idx", table: "projects", columns: ["area_id", "status"] },
  { name: "tasks_area_id_idx", table: "tasks", columns: ["area_id"] },
  { name: "tasks_goal_id_idx", table: "tasks", columns: ["goal_id"] },
  { name: "tasks_project_id_idx", table: "tasks", columns: ["project_id"] },
  { name: "tasks_project_status_idx", table: "tasks", columns: ["project_id", "status"] },
  { name: "tasks_kanban_position_idx", table: "tasks", columns: ["status", "kanban_position"] },
  areaStatusIndex,
  { name: "tasks_ticket_number_idx", table: "tasks", columns: ["ticket_number"], unique: true },
  { name: "kanban_lanes_position_idx", table: "kanban_lanes", columns: ["position"] },
  { name: "comments_task_created_idx", table: "comments", columns: ["task_id", "created_at DESC"] },
  { name: "comments_id_task_idx", table: "comments", columns: ["id", "task_id"], unique: true },
  { name: "comments_task_id_idx", table: "comments", columns: ["task_id"] },
]

const tableStatements = Object.entries(tables).map(([table, columns]) =>
  `CREATE TABLE IF NOT EXISTS ${table} (${Object.entries(columns).map(([name, type]) => `${name} ${type}`).join(", ")})`,
)

const columnMetadata = {
  sql: `SELECT lower(schema.name) AS table_name, lower(column_info.name) AS column_name,
          column_info.pk AS primary_key_position, upper(column_info.type) AS column_type,
          column_info.dflt_value AS default_value,
          CASE WHEN lower(schema.name) = 'comments' AND lower(column_info.name) = 'id'
            THEN schema.sql END AS table_sql
        FROM sqlite_schema AS schema JOIN pragma_table_info(schema.name) AS column_info
        WHERE schema.type = 'table' AND lower(schema.name) IN (${Object.keys(requiredColumns).map(() => "?").join(", ")})`,
  args: Object.keys(requiredColumns),
}

const indexMetadata = {
  sql: `SELECT lower(schema.name) AS table_name, lower(index_info.name) AS index_name,
          index_info."unique" AS is_unique, index_info.partial AS is_partial,
          lower(index_column.name) AS column_name, index_column.desc AS descending,
          lower(index_column.coll) AS collation, index_info.origin AS index_origin
        FROM sqlite_schema AS schema
        JOIN pragma_index_list(schema.name) AS index_info
        JOIN pragma_index_xinfo(index_info.name) AS index_column
        WHERE schema.type = 'table' AND index_column.key = 1
          AND (lower(index_info.name) IN (${indexes.map(() => "?").join(", ")})
            OR (lower(schema.name) = 'comments' AND index_info.origin = 'pk')
            OR (lower(schema.name) = 'kanban_lanes' AND index_info."unique" = 1))
        ORDER BY index_info.name, index_column.seqno`,
  args: indexes.map(index => index.name),
}

const foreignKeyMetadata = `
  SELECT lower(schema.name) AS table_name, lower(fk."from") AS column_name,
    lower(fk."table") AS parent_table, lower(fk."to") AS parent_column,
    fk.on_delete AS delete_action, count(*) OVER (PARTITION BY schema.name, fk.id) AS key_columns
  FROM sqlite_schema AS schema JOIN pragma_foreign_key_list(schema.name) AS fk
  WHERE schema.type = 'table' AND lower(schema.name) IN ('goals', 'projects', 'comments', 'comment_mentions')
`

// Resolve the child foreign key in the write transaction without adding or scanning rows.
const commentParentProbe = `INSERT INTO comment_mentions (task_id, comment_id, recipient_key, created_at)
  SELECT NULL, NULL, NULL, NULL WHERE 0`

/** @typedef {import("@libsql/core/api").Client} Client */
/** @typedef {import("@libsql/core/api").InStatement} InStatement */
/** @typedef {import("@libsql/core/api").ResultSet} ResultSet */

/** @param {ResultSet} metadata */
function readColumns(metadata) {
  return Object.fromEntries(Object.keys(requiredColumns).map(table => [table, new Set(
    metadata.rows.filter(row => row.table_name === table).map(row => row.column_name),
  )]))
}

/** @param {ResultSet} indexInfo @param {Index} index */
function matchesIndex(indexInfo, { name, table, columns, unique }) {
  const keys = indexInfo.rows.filter(row => row.index_name === name)
  return keys.length === columns.length && keys.every((key, index) => {
    const column = `${key.column_name}${Number(key.descending) === 1 ? " DESC" : ""}`
    return key.table_name === table && Number(key.is_unique) === Number(Boolean(unique)) &&
      Number(key.is_partial) === 0 && key.collation === "binary" && column === columns[index]
  })
}

/** @param {Index} index */
function createIndex({ name, table, columns, unique }) {
  return `CREATE ${unique ? "UNIQUE " : ""}INDEX IF NOT EXISTS ${name} ON ${table} (${columns.join(", ")})`
}

/** @param {ResultSet} columnInfo @param {ResultSet} indexInfo @param {ResultSet} foreignKeyInfo */
function validateMetadata(columnInfo, indexInfo, foreignKeyInfo) {
  const existingColumns = readColumns(columnInfo)
  for (const [table, columns] of Object.entries(requiredColumns)) {
    if (!existingColumns[table].size) throw new Error(`Missing task prerequisite table: ${table}`)
    for (const column of [...columns, ...Object.keys(addedColumns[table] ?? {})]) {
      if (!existingColumns[table].has(column)) throw new Error(`Missing task prerequisite column: ${table}.${column}`)
    }
    const primaryKey = table === "app_settings" ? "key" : "id"
    const keys = columnInfo.rows.filter(row => row.table_name === table && Number(row.primary_key_position) > 0)
    if (keys.length !== 1 || keys[0].column_name !== primaryKey) {
      throw new Error(`Unexpected task prerequisite primary key: ${table}.${primaryKey}`)
    }
  }

  for (const [table, column, parent, action] of foreignKeys) {
    if (!foreignKeyInfo.rows.some(key => key.table_name === table && key.column_name === column &&
      key.parent_table === parent && (key.parent_column === null || key.parent_column === "id") &&
      key.delete_action === action && Number(key.key_columns) === 1)) {
      throw new Error(`Unexpected task prerequisite foreign key: ${table}.${column}`)
    }
  }

  const commentId = columnInfo.rows.find(row => row.table_name === "comments" && row.column_name === "id")
  const commentPrimaryIndex = indexInfo.rows.some(row => row.table_name === "comments" && row.index_origin === "pk")
  const commentDefinition = String(commentId?.table_sql)
    .replace(/--[^\r\n]*|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]/g, " ")
  // Comment attempts keep their original IDs after deletion, so later inserts must not reuse them.
  if (commentId?.column_type !== "INTEGER" || commentPrimaryIndex || !/\bAUTOINCREMENT\b/i.test(commentDefinition)) {
    throw new Error("Unexpected task prerequisite generated key: comments.id")
  }
  const createdAt = columnInfo.rows.find(row => row.table_name === "comments" && row.column_name === "created_at")
  const clockDefault = String(createdAt?.default_value).replace(/\s/g, "").toLowerCase()
  if (clockDefault !== "datetime('now')" && clockDefault !== "current_timestamp") {
    throw new Error("Unexpected task prerequisite timestamp default: comments.created_at")
  }

  const uniqueLaneIndexes = indexInfo.rows.filter(row => row.table_name === "kanban_lanes" && Number(row.is_unique) === 1)
  const hasUniqueLaneKey = uniqueLaneIndexes.some(key => key.column_name === "key" && Number(key.is_partial) === 0 &&
    uniqueLaneIndexes.filter(row => row.index_name === key.index_name).length === 1)
  if (!hasUniqueLaneKey) throw new Error("Missing task prerequisite unique key: kanban_lanes.key")

  for (const index of indexes) {
    if (!matchesIndex(indexInfo, index)) throw new Error(`Unexpected task prerequisite index: ${index.name}`)
  }
}

/** @param {ResultSet} metadata */
function hasCommentMentionsForeignKey(metadata) {
  return metadata.rows.some(row => row.table_name === "comment_mentions")
}

const lanes = [
  ["backlog", "Backlog", "📥", 0, `["backlog"]`],
  ["pending", "Todo", "📋", 1, `["pending","todo"]`],
  ["active", "In Progress", "⚡", 2, `["active","in_progress"]`],
  ["complete", "Done", "✅", 3, `["complete","done"]`],
]

/** @param {number} now @param {(typeof lanes)[number]} lane @returns {InStatement} */
function insertLane(now, [key, label, icon, position, includes]) {
  return {
    sql: `INSERT INTO kanban_lanes (id, key, label, icon, position, wip_limit, includes, built_in, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, 0, ?, 1, ?, ?)`,
    args: [`lane-${key}`, key, label, icon, position, includes, now, now],
  }
}

/** @returns {Generator<InStatement[], void, ResultSet[]>} */
function* reconcileSteps() {
  yield* databaseSchemaCheckSteps()
  const now = Date.now()
  const results = yield [...tableStatements, columnMetadata]
  const existingColumns = readColumns(results[tableStatements.length])
  /** @type {InStatement[]} */
  const changes = []

  if (!existingColumns.areas.has("name") && existingColumns.areas.has("title")) {
    changes.push("ALTER TABLE areas RENAME COLUMN title TO name")
  }
  for (const [table, columns] of Object.entries(addedColumns)) {
    for (const [name, type] of Object.entries(columns)) {
      if (!existingColumns[table].has(name)) changes.push(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`)
    }
  }
  changes.push({
    sql: `INSERT INTO areas (id, name, icon, color, position, created_at, updated_at)
          SELECT 'default', 'Default', '📋', '#6366F1', 0, ?, ? WHERE NOT EXISTS (SELECT 1 FROM areas)`,
    args: [now, now],
  })
  if (!existingColumns.tasks.has("ticket_number")) {
    // Preserve numbers issued by the runtime and issue rowid-based numbers only on first addition.
    changes.push("UPDATE tasks SET ticket_number = rowid WHERE ticket_number IS NULL")
  }
  if (!existingColumns.projects.has("area_id")) {
    changes.push(`UPDATE projects SET area_id = (SELECT goals.area_id FROM goals WHERE goals.id = projects.goal_id)
                  WHERE goal_id IS NOT NULL AND area_id IS NULL`)
  }

  const setup = yield [...changes,
    {
      sql: `INSERT INTO projects (id, goal_id, title, description, status, icon, color, position, is_default, created_at, updated_at)
            SELECT 'every-day', NULL, 'Every Day', 'Your daily tasks and quick captures', 'active', '☀️', '#F59E0B', -1, 1, ?, ?
            WHERE NOT EXISTS (SELECT 1 FROM projects WHERE is_default = 1)`,
      args: [now, now],
    },
    ...indexes.map(createIndex),
    indexMetadata,
    `SELECT EXISTS(SELECT 1 FROM kanban_lanes) AS has_lanes,
            EXISTS(SELECT 1 FROM kanban_lanes WHERE key = 'backlog') AS has_backlog`,
  ]

  /** @type {InStatement[]} */
  const repairs = []
  if (matchesIndex(setup[setup.length - 2], legacyBoardStatusIndex)) {
    // The Board-to-Area upgrade kept this index name on installed databases.
    repairs.push("DROP INDEX tasks_board_status_idx", createIndex(areaStatusIndex))
  }
  const [laneState] = setup[setup.length - 1].rows
  if (Number(laneState.has_lanes) === 0) {
    repairs.push(...lanes.map(lane => insertLane(now, lane)))
  }
  for (const [key, oldLabel, label] of [["pending", "Pending", "Todo"], ["active", "Active", "In Progress"], ["complete", "Complete", "Done"]]) {
    repairs.push({ sql: "UPDATE kanban_lanes SET label = ? WHERE key = ? AND label = ? AND built_in = 1", args: [label, key, oldLabel] })
  }
  if (Number(laneState.has_lanes) === 1 && Number(laneState.has_backlog) === 0) {
    repairs.push("UPDATE kanban_lanes SET position = position + 1", insertLane(now, lanes[0]))
  }

  const verification = yield [...repairs, columnMetadata, indexMetadata, foreignKeyMetadata]
  const [columnInfo, indexInfo, foreignKeyInfo] = verification.slice(repairs.length)
  validateMetadata(columnInfo, indexInfo, foreignKeyInfo)
  if (hasCommentMentionsForeignKey(foreignKeyInfo)) yield [commentParentProbe]
}

/** @param {Client} client */
export function reconcileTaskSchemaPrerequisites(client) {
  return runWriteTransaction(client, reconcileSteps)
}

/** @param {Pick<Client, "execute">} db */
export async function validateTaskSchemaPrerequisites(db) {
  const [columnInfo, indexInfo, foreignKeyInfo] = await Promise.all([
    db.execute(columnMetadata),
    db.execute(indexMetadata),
    db.execute(foreignKeyMetadata),
  ])
  validateMetadata(columnInfo, indexInfo, foreignKeyInfo)
  if (hasCommentMentionsForeignKey(foreignKeyInfo)) {
    const { rows } = await db.execute("SELECT 1 FROM pragma_foreign_key_check('comment_mentions') LIMIT 1")
    if (rows.length > 0) throw new Error("Unexpected comment mention reference")
  }
}
