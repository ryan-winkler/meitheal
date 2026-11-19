import { randomUUID } from "node:crypto"
import {
  matchesSql,
  assertNoInboundReferences,
  moveBoardStorageTables
} from "./board-storage-schema.mjs"
import { consumeStartupBoardAdmission } from "../../scripts/startup-board-admission.mjs"
import { enrollLegacyWorkDestinations } from "../../scripts/legacy-work-destinations.mjs"

export const ORDINARY_BOARD_SCHEMA_VERSION = 26
export const ORDINARY_BOARD_MIGRATION = "0016_ordinary_boards.mjs"
export const storageEncodingColumn =
  "storage_encoding TEXT NOT NULL DEFAULT 'scoped_v1' CHECK (storage_encoding IN ('legacy_null_v1', 'scoped_v1'))"
export const sharedRoleColumn =
  "shared_role TEXT NOT NULL DEFAULT 'member' CHECK (shared_role IN ('member', 'viewer'))"
export const sharedManagementColumn =
  "shared_admin_management INTEGER NOT NULL DEFAULT 0 CHECK (shared_admin_management IN (0, 1))"

export const ordinaryAccessObjects = {
  board_access_grants: `CREATE TABLE board_access_grants (
    board_id TEXT NOT NULL REFERENCES task_boards(id) ON DELETE RESTRICT,
    principal_type TEXT NOT NULL CHECK (principal_type IN ('ha_user', 'agent', 'service', 'local_operator')),
    principal_id TEXT NOT NULL CHECK (length(principal_id) > 0),
    role TEXT NOT NULL CHECK (
      (principal_type IN ('ha_user', 'local_operator') AND role IN ('owner', 'member', 'viewer')) OR
      (principal_type IN ('agent', 'service') AND role = 'service')
    ),
    deny_completion INTEGER NOT NULL DEFAULT 0 CHECK (deny_completion IN (0, 1)),
    deny_deletion INTEGER NOT NULL DEFAULT 0 CHECK (deny_deletion IN (0, 1)),
    authority_limits TEXT CHECK (authority_limits IS NULL OR (json_valid(authority_limits) AND json_type(authority_limits) = 'object')),
    PRIMARY KEY (board_id, principal_type, principal_id)
  )`,
  board_goal_shares: `CREATE TABLE board_goal_shares (
    goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
    area_id TEXT REFERENCES areas(id) ON DELETE CASCADE,
    receiving_board_id TEXT NOT NULL REFERENCES task_boards(id) ON DELETE RESTRICT,
    project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
    CHECK (area_id IS NULL OR project_id IS NULL)
  )`,
  board_goal_shares_area_idx: `CREATE INDEX board_goal_shares_area_idx ON board_goal_shares(area_id, receiving_board_id, goal_id)`
}

export const ordinaryLabelTable = `CREATE TABLE vikunja_labels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  hex_color TEXT NOT NULL DEFAULT '3f51b5',
  board_id TEXT NOT NULL REFERENCES task_boards(id) ON DELETE RESTRICT,
  UNIQUE (board_id, title)
)`
export const ordinaryStatsTable = `CREATE TABLE gamification_stats (
  date TEXT NOT NULL,
  completed_count INTEGER NOT NULL DEFAULT 0,
  streak_count INTEGER NOT NULL DEFAULT 0,
  points INTEGER NOT NULL DEFAULT 0,
  board_id TEXT NOT NULL REFERENCES task_boards(id) ON DELETE RESTRICT,
  PRIMARY KEY (board_id, date)
)`
export const ordinaryAchievementsTable = `CREATE TABLE gamification_achievements (
  id TEXT NOT NULL,
  unlocked_at TEXT NOT NULL,
  board_id TEXT NOT NULL REFERENCES task_boards(id) ON DELETE RESTRICT,
  PRIMARY KEY (board_id, id)
)`
export const ordinaryInactivityPolicyTable = `CREATE TABLE task_inactivity_policy (
  scope TEXT NOT NULL,
  area_id TEXT REFERENCES areas(id) ON DELETE CASCADE,
  days INTEGER NOT NULL CHECK(typeof(days) = 'integer' AND days BETWEEN -1 AND 365),
  revision TEXT NOT NULL CHECK(length(CAST(revision AS BLOB)) = 32 AND revision NOT GLOB '*[^0-9a-f]*'),
  board_id TEXT NOT NULL REFERENCES task_boards(id) ON DELETE RESTRICT,
  CHECK((scope = 'default' AND area_id IS NULL AND days >= 0)
    OR (area_id IS NOT NULL AND scope = 'area:' || area_id)),
  PRIMARY KEY (board_id, scope),
  UNIQUE (board_id, area_id)
)`
export const ordinarySavedFiltersTable = `CREATE TABLE saved_filters (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  query_json TEXT NOT NULL DEFAULT '{}',
  icon TEXT NOT NULL DEFAULT '🔍',
  position INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  board_id TEXT NOT NULL REFERENCES task_boards(id) ON DELETE RESTRICT
)`

export const legacyTimerTables = {
  pomodoro_sessions: `CREATE TABLE pomodoro_sessions (
    id TEXT PRIMARY KEY,
    task_id TEXT,
    phase TEXT NOT NULL DEFAULT 'focus',
    started_at TEXT NOT NULL,
    completed_at TEXT,
    cancelled_at TEXT,
    duration_minutes INTEGER NOT NULL DEFAULT 25,
    focus_count INTEGER NOT NULL DEFAULT 0
  )`,
  time_entries: `CREATE TABLE time_entries (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    started_at TEXT NOT NULL,
    stopped_at TEXT,
    duration_seconds INTEGER NOT NULL DEFAULT 0
  )`
}
export const ordinaryTimerTables = Object.fromEntries(
  Object.entries(legacyTimerTables).map(([name, definition]) => [
    name,
    definition.replace(
      /\n  \)$/,
      ", board_id TEXT REFERENCES task_boards(id) ON DELETE RESTRICT, principal_kind TEXT, principal_id TEXT\n  )"
    )
  ])
)

// Optional predecessor provider store is enrolled once under startup authority.
// Runtime provider code must never bootstrap an unscoped replacement table.
export const legacyGrocyConfirmationsTable = `CREATE TABLE grocy_sync_confirmations (
  confirmation_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  grocy_entity_type TEXT NOT NULL,
  grocy_entity_id TEXT NOT NULL,
  sync_direction TEXT NOT NULL DEFAULT 'inbound',
  payload TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)`
export const ordinaryGrocyConfirmationsTable = legacyGrocyConfirmationsTable.replace(
  /\n\)$/,
  ", binding_id TEXT\n)"
)
export const ordinaryGrocyIndexes = {
  idx_grocy_sync_entity: `CREATE INDEX idx_grocy_sync_entity ON grocy_sync_confirmations(grocy_entity_type, grocy_entity_id)`,
  idx_grocy_sync_task: `CREATE INDEX idx_grocy_sync_task ON grocy_sync_confirmations(task_id)`,
  grocy_sync_confirmations_binding_idx: `CREATE INDEX grocy_sync_confirmations_binding_idx ON grocy_sync_confirmations(binding_id)`
}

export const ordinaryBoardObjects = {
  task_boards_one_legacy_encoding: `CREATE UNIQUE INDEX task_boards_one_legacy_encoding ON task_boards(storage_encoding) WHERE storage_encoding = 'legacy_null_v1'`,
  task_boards_storage_encoding_guard: `CREATE TRIGGER task_boards_storage_encoding_guard BEFORE UPDATE OF storage_encoding ON task_boards
    WHEN NEW.storage_encoding IS NOT OLD.storage_encoding BEGIN SELECT RAISE(ABORT, 'Board storage encoding is immutable'); END`,
  task_boards_storage_encoding_insert: `CREATE TRIGGER task_boards_storage_encoding_insert BEFORE INSERT ON task_boards
    WHEN NEW.storage_encoding <> 'scoped_v1' BEGIN SELECT RAISE(ABORT, 'New Board requires ordinary storage encoding'); END`,
  task_boards_ordinary_identity_insert: `CREATE TRIGGER task_boards_ordinary_identity_insert BEFORE INSERT ON task_boards
    WHEN length(NEW.ticket_prefix) <> 8 OR NEW.ticket_prefix GLOB '*[^A-Z2-7]*'
    BEGIN SELECT RAISE(ABORT, 'Invalid Board ticket prefix'); END`,
  tasks_scoped_operation_key: `CREATE UNIQUE INDEX tasks_scoped_operation_key ON tasks
    (COALESCE(task_board_id, ''), operation_owner, client_idempotency_key)
    WHERE operation_owner IS NOT NULL AND client_idempotency_key IS NOT NULL`,
  tasks_capture_attempt_digest: `CREATE UNIQUE INDEX tasks_capture_attempt_digest ON tasks(capture_attempt_digest) WHERE capture_attempt_digest IS NOT NULL`,
  board_goal_shares_target_unique: `CREATE UNIQUE INDEX board_goal_shares_target_unique ON board_goal_shares
    (goal_id, receiving_board_id, COALESCE(area_id, ''), COALESCE(project_id, ''))`,
  board_goal_shares_project_idx: `CREATE INDEX board_goal_shares_project_idx ON board_goal_shares(project_id, receiving_board_id, goal_id)`,
  invalidate_project_goal_shares: `CREATE TRIGGER invalidate_project_goal_shares AFTER UPDATE OF owner_board_id ON projects
    WHEN NEW.owner_board_id IS NOT OLD.owner_board_id BEGIN DELETE FROM board_goal_shares WHERE project_id = OLD.id; END`,
  saved_filters_position_idx: `CREATE INDEX saved_filters_position_idx ON saved_filters(board_id, position)`
}

const ownerExpression = (table, alias) =>
  table === "tasks"
    ? `${alias}.task_board_id`
    : ["kanban_lanes", "task_drafts", "task_draft_receipts"].includes(table)
      ? `${alias}.board_id`
      : `${alias}.owner_board_id`
const boardTables = [
  "tasks",
  "areas",
  "projects",
  "goals",
  "task_templates",
  "pillars",
  "kanban_lanes",
  "task_drafts",
  "task_draft_receipts"
]
const relatedTables = [
  "principles",
  "pillar_associations",
  "task_pins",
  "task_reactions",
  "home_assistant_task_areas",
  "calendar_confirmations",
  "todo_sync_confirmations",
  "grocy_sync_confirmations",
  "comments",
  "comment_mentions",
  "comment_mention_attempts"
]
const retiredOwner = (
  expression
) => `EXISTS (SELECT 1 FROM task_boards AS board WHERE board.state = 'retired'
  AND (board.id = ${expression} OR (${expression} IS NULL AND board.storage_encoding = 'legacy_null_v1')))`
export const ordinaryRetirementTriggers = [...boardTables, ...relatedTables].flatMap((table) =>
  ["INSERT", "UPDATE", "DELETE"].map((event) => {
    const aliases = event === "INSERT" ? ["NEW"] : event === "DELETE" ? ["OLD"] : ["OLD", "NEW"]
    let conditions = aliases.map((alias) => {
      if (boardTables.includes(table))
        return `${table === "pillars" ? `(${alias}.user_id = 'default' OR ${alias}.owner_board_id IS NOT NULL) AND ` : ""}${retiredOwner(ownerExpression(table, alias))}`
      const pillar = table === "principles" || table === "pillar_associations"
      return `EXISTS (SELECT 1 FROM ${pillar ? "pillars" : "tasks"} AS parent WHERE parent.id = ${alias}.${pillar ? "pillar_id" : "task_id"}
      ${pillar ? "AND (parent.user_id = 'default' OR parent.owner_board_id IS NOT NULL)" : ""}
      AND ${retiredOwner(pillar ? "parent.owner_board_id" : "parent.task_board_id")})`
    })
    const replacementKey = table.startsWith("task_draft")
      ? null
      : ["calendar_confirmations", "todo_sync_confirmations", "grocy_sync_confirmations"].includes(
            table
          )
        ? "confirmation_id"
        : "id"
    if (
      event === "INSERT" &&
      replacementKey &&
      table !== "home_assistant_task_areas" &&
      !["task_pins", "comment_mention_attempts"].includes(table)
    ) {
      const parentCondition = boardTables.includes(table)
        ? `${table === "pillars" ? "(existing.user_id = 'default' OR existing.owner_board_id IS NOT NULL) AND " : ""}${retiredOwner(ownerExpression(table, "existing"))}`
        : ["principles", "pillar_associations"].includes(table)
          ? `EXISTS (SELECT 1 FROM pillars AS parent WHERE parent.id = existing.pillar_id AND (parent.user_id = 'default' OR parent.owner_board_id IS NOT NULL) AND ${retiredOwner("parent.owner_board_id")})`
          : `EXISTS (SELECT 1 FROM tasks AS parent WHERE parent.id = existing.task_id AND ${retiredOwner("parent.task_board_id")})`
      conditions.push(
        `EXISTS (SELECT 1 FROM ${table} AS existing WHERE existing.${replacementKey} = NEW.${replacementKey} AND ${parentCondition})`
      )
    }
    const name = `board_retired_${table}_${event.toLowerCase()}`
    return [
      name,
      `CREATE TRIGGER ${name} BEFORE ${event} ON ${table} WHEN (${conditions.map((item) => `(${item})`).join(" OR ")})
    BEGIN SELECT RAISE(ABORT, 'Board is deleted. Restore it from Boards to resume its work.'); END`
    ]
  })
)

async function exists(db, name) {
  const { rows } = await db.execute({
    sql: "SELECT 1 FROM sqlite_schema WHERE name = ? AND type = 'table'",
    args: [name]
  })
  return rows.length === 1
}

async function replaceSmallTable(tx, name, definition, columns, boardId) {
  if (!(await exists(tx, name))) {
    await tx.execute(definition)
    return
  }
  const { rows: objects } = await tx.execute({
    sql: "SELECT name,type,sql FROM sqlite_schema WHERE tbl_name=? AND sql IS NOT NULL",
    args: [name]
  })
  const knownIndexes = name === "saved_filters" ? ["saved_filters_position_idx"] : []
  if (objects.some((object) => object.name !== name && !knownIndexes.includes(String(object.name))))
    throw new Error(`Unexpected migration dependency on ${name}`)
  const legacyShapes = {
    vikunja_labels:
      "CREATE TABLE vikunja_labels (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL UNIQUE, hex_color TEXT NOT NULL DEFAULT '3f51b5')",
    gamification_stats:
      "CREATE TABLE gamification_stats (date TEXT PRIMARY KEY, completed_count INTEGER NOT NULL DEFAULT 0, streak_count INTEGER NOT NULL DEFAULT 0, points INTEGER NOT NULL DEFAULT 0)",
    gamification_achievements:
      "CREATE TABLE gamification_achievements (id TEXT PRIMARY KEY, unlocked_at TEXT NOT NULL)",
    saved_filters:
      "CREATE TABLE saved_filters (id TEXT PRIMARY KEY, name TEXT NOT NULL, query_json TEXT NOT NULL DEFAULT '{}', icon TEXT NOT NULL DEFAULT '🔍', position INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)"
  }
  if (
    legacyShapes[name] &&
    !matchesSql(objects.find((object) => object.name === name)?.sql, legacyShapes[name])
  )
    throw new Error(`Unexpected predecessor table: ${name}`)
  if (
    name === "saved_filters" &&
    objects.some(
      (object) =>
        object.name !== name &&
        !matchesSql(
          object.sql,
          "CREATE INDEX saved_filters_position_idx ON saved_filters(position)"
        )
    )
  )
    throw new Error("Unexpected saved-filter ordering index")
  let sequence
  if (name === "vikunja_labels") {
    const { rows: sequences } = await tx.execute(
      "SELECT CAST(seq AS TEXT) AS value, typeof(seq) AS kind FROM sqlite_sequence WHERE name='vikunja_labels'"
    )
    if (
      sequences.length > 1 ||
      (sequences[0] &&
        (sequences[0].kind !== "integer" || !/^\d+$/.test(String(sequences[0].value))))
    )
      throw new Error("Unexpected label identifier sequence")
    sequence = sequences[0]?.value
  }
  await assertNoInboundReferences(tx, [name])
  const staging = `${name}_ordinary_migration`
  await moveBoardStorageTables(tx, { [name]: staging })
  await tx.execute(definition)
  await tx.execute({
    sql: `INSERT INTO ${name} (${columns.join(", ")}, board_id) SELECT ${columns.join(", ")}, ? FROM ${staging}`,
    args: [boardId]
  })
  await tx.execute(`DROP TABLE ${staging}`)
  if (sequence !== undefined) {
    await tx.execute({
      sql: "UPDATE sqlite_sequence SET seq=MAX(seq,CAST(? AS INTEGER)) WHERE name='vikunja_labels'",
      args: [sequence]
    })
    await tx.execute({
      sql: "INSERT INTO sqlite_sequence(name,seq) SELECT 'vikunja_labels',CAST(? AS INTEGER) WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name='vikunja_labels')",
      args: [sequence]
    })
  }
}

async function captureLegacyTokenCeilings(tx, boardId) {
  if (!(await exists(tx, "agent_tokens"))) return
  const { rows: tokens } = await tx.execute(
    "SELECT id, scopes, assignee_id, expires_at FROM agent_tokens WHERE revoked = 0"
  )
  for (const token of tokens) {
    if (
      token.expires_at !== null &&
      (!Number.isFinite(Date.parse(String(token.expires_at))) ||
        Date.parse(String(token.expires_at)) <= Date.now())
    )
      continue
    let scopes
    try {
      scopes = JSON.parse(String(token.scopes))
    } catch {
      continue
    }
    if (!Array.isArray(scopes) || scopes.some((value) => typeof value !== "string")) continue
    const operations = []
    const add = (resource, ...actions) =>
      operations.push(...actions.map((action) => ({ resource, action })))
    if (scopes.includes("tasks:read")) {
      add("board", "read")
      add("task", "read")
    }
    if (scopes.includes("search:read") || scopes.includes("tasks:read")) add("task", "search")
    if (scopes.includes("tasks:write"))
      add("task", "create", "edit", "move", "assign", "complete", "reopen")
    else if (scopes.includes("tasks:write:assigned"))
      add("task", "edit", "move", "assign", "complete", "reopen")
    if (scopes.includes("tasks:delete")) add("task", "delete")
    if (scopes.includes("tasks:propose")) add("task", "propose")
    if (scopes.includes("projects:read")) add("project", "read")
    if (scopes.includes("projects:write")) add("project", "create", "edit", "delete")
    const assigned = scopes.includes("tasks:write:assigned") && !scopes.includes("tasks:write")
    const limits = JSON.stringify({
      operations,
      ...(assigned ? { assignedTo: token.assignee_id ?? null } : {})
    })
    await tx.execute({
      sql: `INSERT OR IGNORE INTO board_access_grants(board_id,principal_type,principal_id,role,authority_limits) VALUES (?,'agent',?,'service',?)`,
      args: [boardId, token.id, limits]
    })
    // Explicit predecessor grants keep their existing Board/role/deny flags;
    // their current credential is captured as a maximum ceiling, never expanded.
    await tx.execute({
      sql: "UPDATE board_access_grants SET authority_limits = ? WHERE principal_type = 'agent' AND principal_id = ? AND authority_limits IS NULL",
      args: [limits, token.id]
    })
  }
}

/** Only the untouched predecessor-created three-lane catalogue is enriched. */
async function enrichKnownPredecessorLanes(tx, now) {
  const { rows: boards } = await tx.execute(
    "SELECT id,created_at FROM task_boards WHERE storage_encoding='scoped_v1'"
  )
  const known = [
    ["pending", "To Do"],
    ["active", "In Progress"],
    ["complete", "Done"]
  ]
  for (const board of boards) {
    const { rows } = await tx.execute({
      sql: "SELECT * FROM kanban_lanes WHERE board_id=? ORDER BY position,id",
      args: [board.id]
    })
    if (
      rows.length !== 3 ||
      !rows.every((lane, index) => {
        const [key, label] = known[index]
        return (
          lane.key === key &&
          lane.label === label &&
          lane.position === index &&
          lane.icon === "📌" &&
          lane.wip_limit === 0 &&
          lane.built_in === 1 &&
          lane.includes === JSON.stringify([key]) &&
          lane.created_at === board.created_at &&
          lane.updated_at === lane.created_at &&
          typeof lane.id === "string" &&
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(lane.id)
        )
      })
    )
      continue
    // Existing lane IDs and their relative order remain unchanged.
    await tx.execute({
      sql: "INSERT INTO kanban_lanes(id,key,label,position,includes,built_in,created_at,updated_at,board_id) VALUES (?,'backlog','Backlog',-1,'[\"backlog\"]',1,?,?,?)",
      args: [randomUUID(), now, now, board.id]
    })
  }
}

/** This function may only be called with a process-local admitted startup writer. */
export async function applyOrdinaryBoardMigration(tx, admission) {
  if (!consumeStartupBoardAdmission(admission, tx))
    throw new Error("Current startup Board admission required")
  const {
    rows: [version]
  } = await tx.execute("SELECT value FROM app_settings WHERE key = 'schema_version'")
  if (Number(version?.value) !== 25)
    throw new Error("Ordinary Board migration requires validated schema 25")
  const {
    rows: [legacy]
  } = await tx.execute("SELECT id FROM task_boards WHERE id = 'household'")
  if (!legacy) throw new Error("Legacy work ownership is missing")
  const boardId = String(legacy.id)
  const { rows: oldTriggers } = await tx.execute(
    "SELECT name FROM sqlite_schema WHERE type = 'trigger' AND name LIKE 'household_retired_%'"
  )
  await tx.batch(oldTriggers.map((row) => `DROP TRIGGER ${row.name}`))
  // The bare migrator historically installed the Routine date guard before the
  // runtime's optional rich columns. Make those prerequisites real before any
  // SQLite table rename causes its dependent trigger to be parsed again.
  const {
    rows: [routineGuard]
  } = await tx.execute(
    "SELECT sql FROM sqlite_schema WHERE name = 'routine_occurrence_date_fixed' AND type = 'trigger'"
  )
  if (!routineGuard?.sql) throw new Error("Validated Routine date guard is missing")
  await tx.execute("DROP TRIGGER routine_occurrence_date_fixed")
  const ensureColumn = async (table, column, definition) => {
    const { rows } = await tx.execute(`PRAGMA table_info(${table})`)
    if (rows.some((row) => row.name === column)) return false
    await tx.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
    return true
  }
  await ensureColumn("tasks", "task_kind", "TEXT NOT NULL DEFAULT 'standard_action'")
  await ensureColumn("tasks", "due_date", "TEXT")
  await ensureColumn("tasks", "source_template_id", "TEXT")
  await ensureColumn("tasks", "recurrence_rule", "TEXT")
  if (await ensureColumn("task_templates", "is_routine", "INTEGER NOT NULL DEFAULT 0"))
    await tx.execute("UPDATE task_templates SET is_routine = is_habit")
  await ensureColumn("task_templates", "area_id", "TEXT")
  await ensureColumn("pillars", "slug", "TEXT")
  await tx.execute("UPDATE pillars SET slug = '~' || lower(hex(randomblob(16))) WHERE slug IS NULL")
  await tx.execute("CREATE UNIQUE INDEX IF NOT EXISTS pillars_slug_idx ON pillars(slug)")
  for (const table of ["tasks", "goals", "task_templates"])
    await ensureColumn(table, "pillar_id", "TEXT")
  for (const [table, definition] of Object.entries(legacyTimerTables)) {
    if (!(await exists(tx, table))) await tx.execute(definition)
    else {
      const {
        rows: [actual]
      } = await tx.execute({ sql: "SELECT sql FROM sqlite_schema WHERE name=?", args: [table] })
      if (!matchesSql(actual?.sql, definition))
        throw new Error("Unexpected predecessor timer store")
    }
    await ensureColumn(table, "board_id", "TEXT REFERENCES task_boards(id) ON DELETE RESTRICT")
    await ensureColumn(table, "principal_kind", "TEXT")
    await ensureColumn(table, "principal_id", "TEXT")
    await tx.execute({
      sql: `UPDATE ${table} SET board_id = (
      SELECT COALESCE(task.task_board_id, ?) FROM tasks AS task WHERE task.id = ${table}.task_id
    ) WHERE board_id IS NULL`,
      args: [boardId]
    })
  }
  await tx.execute(String(routineGuard.sql))
  await tx.batch([
    "DROP TRIGGER task_boards_household_identity_insert",
    "DROP TRIGGER task_boards_household_identity_update",
    "DROP TRIGGER task_boards_household_v19_delete",
    "DROP TRIGGER board_members_household_v19_insert",
    "DROP TRIGGER task_drafts_household_v19_insert",
    "DROP TRIGGER task_drafts_household_v19_update",
    "DROP TRIGGER task_draft_receipts_household_v19_insert",
    "DROP TRIGGER task_draft_receipts_household_v19_update",
    `ALTER TABLE task_boards ADD COLUMN ${storageEncodingColumn}`,
    {
      sql: "UPDATE task_boards SET storage_encoding = 'legacy_null_v1' WHERE id = ?",
      args: [boardId]
    },
    { sql: "UPDATE task_boards SET visibility = 'restricted' WHERE id <> ?", args: [boardId] },
    `ALTER TABLE board_permissions ADD COLUMN ${sharedRoleColumn}`,
    `ALTER TABLE board_permissions ADD COLUMN ${sharedManagementColumn}`,
    { sql: "INSERT OR IGNORE INTO board_permissions(board_id) VALUES (?)", args: [boardId] },
    {
      sql: "UPDATE board_permissions SET shared_admin_management = 1 WHERE board_id = ?",
      args: [boardId]
    }
  ])
  await assertNoInboundReferences(tx, ["board_access_grants", "board_goal_shares"])
  await tx.batch([
    "DROP TRIGGER invalidate_area_goal_shares",
    "DROP TRIGGER invalidate_owned_goal_shares",
    "DROP INDEX board_goal_shares_area_idx"
  ])
  await moveBoardStorageTables(tx, {
    board_access_grants: "board_access_grants_ordinary_migration",
    board_goal_shares: "board_goal_shares_ordinary_migration"
  })
  await tx.batch([
    ordinaryAccessObjects.board_access_grants,
    ordinaryAccessObjects.board_goal_shares,
    `INSERT INTO board_access_grants(board_id,principal_type,principal_id,role,deny_completion,deny_deletion)
      SELECT board_id,principal_type,principal_id,role,deny_completion,deny_deletion FROM board_access_grants_ordinary_migration`,
    `INSERT INTO board_goal_shares(goal_id,area_id,receiving_board_id) SELECT goal_id,area_id,receiving_board_id FROM board_goal_shares_ordinary_migration`,
    "DROP TABLE board_access_grants_ordinary_migration",
    "DROP TABLE board_goal_shares_ordinary_migration",
    ordinaryAccessObjects.board_goal_shares_area_idx,
    `CREATE TRIGGER invalidate_area_goal_shares AFTER UPDATE OF owner_board_id ON areas WHEN NEW.owner_board_id IS NOT OLD.owner_board_id BEGIN DELETE FROM board_goal_shares WHERE area_id = OLD.id; END`,
    `CREATE TRIGGER invalidate_owned_goal_shares AFTER UPDATE OF owner_board_id ON goals WHEN NEW.owner_board_id IS NOT OLD.owner_board_id BEGIN DELETE FROM board_goal_shares WHERE goal_id = OLD.id; END`
  ])
  for (const column of [
    "client_idempotency_key",
    "operation_owner",
    "operation_digest",
    "capture_attempt_digest"
  ])
    await tx.execute(`ALTER TABLE tasks ADD COLUMN ${column} TEXT`)
  if (!(await exists(tx, "grocy_sync_confirmations"))) {
    await tx.execute(legacyGrocyConfirmationsTable)
  } else {
    const {
      rows: [actual]
    } = await tx.execute("SELECT sql FROM sqlite_schema WHERE name='grocy_sync_confirmations'")
    if (!matchesSql(actual?.sql, legacyGrocyConfirmationsTable))
      throw new Error("Unexpected predecessor Grocy confirmation store")
  }
  for (const [name, definition] of Object.entries(ordinaryGrocyIndexes)) {
    if (name === "grocy_sync_confirmations_binding_idx") continue
    const {
      rows: [actual]
    } = await tx.execute({ sql: "SELECT sql FROM sqlite_schema WHERE name=?", args: [name] })
    if (actual && !matchesSql(actual.sql, definition))
      throw new Error("Unexpected predecessor Grocy confirmation index")
    if (!actual) await tx.execute(definition)
  }
  for (const table of [
    "integration_attempts",
    "calendar_confirmations",
    "todo_sync_confirmations",
    "grocy_sync_confirmations"
  ]) {
    if (!(await exists(tx, table))) continue
    await tx.execute(`ALTER TABLE ${table} ADD COLUMN binding_id TEXT`)
    await tx.execute(`CREATE INDEX ${table}_binding_idx ON ${table}(binding_id)`)
  }
  await replaceSmallTable(
    tx,
    "vikunja_labels",
    ordinaryLabelTable,
    ["id", "title", "hex_color"],
    boardId
  )
  await replaceSmallTable(
    tx,
    "gamification_stats",
    ordinaryStatsTable,
    ["date", "completed_count", "streak_count", "points"],
    boardId
  )
  await replaceSmallTable(
    tx,
    "gamification_achievements",
    ordinaryAchievementsTable,
    ["id", "unlocked_at"],
    boardId
  )
  await replaceSmallTable(
    tx,
    "saved_filters",
    ordinarySavedFiltersTable,
    ["id", "name", "query_json", "icon", "position", "created_at", "updated_at"],
    boardId
  )
  const { ordinaryStallTriggerDefinitions } = await import("./task-activity-schema.mjs")
  await tx.batch(ordinaryStallTriggerDefinitions.map(([name]) => `DROP TRIGGER ${name}`))
  await replaceSmallTable(
    tx,
    "task_inactivity_policy",
    ordinaryInactivityPolicyTable,
    ["scope", "area_id", "days", "revision"],
    boardId
  )
  await tx.batch(ordinaryStallTriggerDefinitions.map(([, , definition]) => definition))
  const now = Date.now()
  await enrichKnownPredecessorLanes(tx, now)
  await tx.execute({
    sql: "INSERT INTO app_settings(key,value,updated_at) SELECT ?,value,updated_at FROM app_settings WHERE key='default_assignee'",
    args: [`default_assignee:${boardId}`]
  })
  await captureLegacyTokenCeilings(tx, boardId)
  await enrollLegacyWorkDestinations(tx, boardId, now)
  const operatorId = randomUUID()
  await tx.batch([
    {
      sql: "INSERT INTO app_settings(key,value,updated_at) VALUES ('default_capture_board_id',?,?)",
      args: [boardId, now]
    },
    {
      sql: "INSERT INTO app_settings(key,value,updated_at) VALUES ('local_operator_identity',?,?)",
      args: [operatorId, now]
    },
    {
      sql: "INSERT INTO app_settings(key,value,updated_at) VALUES ('work_installation_id',?,?)",
      args: [randomUUID(), now]
    },
    {
      sql: "INSERT INTO board_access_grants(board_id,principal_type,principal_id,role) VALUES (?,'local_operator',?,'owner')",
      args: [boardId, operatorId]
    },
    ...Object.values(ordinaryBoardObjects),
    ...ordinaryRetirementTriggers.map(([, definition]) => definition),
    {
      sql: "INSERT INTO __meitheal_migrations(name,applied_at) VALUES (?,?)",
      args: [ORDINARY_BOARD_MIGRATION, now]
    },
    {
      sql: "UPDATE app_settings SET value = '26', updated_at = ? WHERE key = 'schema_version'",
      args: [now]
    }
  ])
  await readOrdinaryBoardMigrationState(tx)
  return true
}

export async function readOrdinaryBoardMigrationState(db) {
  const {
    rows: [version]
  } = await db.execute("SELECT value FROM app_settings WHERE key = 'schema_version'")
  const current = Number(version?.value) >= ORDINARY_BOARD_SCHEMA_VERSION
  const { rows: ledger } = await db.execute({
    sql: "SELECT name FROM __meitheal_migrations WHERE name = ? COLLATE NOCASE",
    args: [ORDINARY_BOARD_MIGRATION]
  })
  if (
    ledger.length !== (current ? 1 : 0) ||
    (current && ledger[0]?.name !== ORDINARY_BOARD_MIGRATION)
  )
    throw new Error("Ordinary Board schema markers disagree")
  if (!current) return false
  const objects = {
    ...ordinaryAccessObjects,
    ...ordinaryBoardObjects,
    vikunja_labels: ordinaryLabelTable,
    gamification_stats: ordinaryStatsTable,
    gamification_achievements: ordinaryAchievementsTable,
    task_inactivity_policy: ordinaryInactivityPolicyTable,
    saved_filters: ordinarySavedFiltersTable,
    grocy_sync_confirmations: ordinaryGrocyConfirmationsTable,
    ...ordinaryGrocyIndexes,
    ...ordinaryTimerTables,
    ...Object.fromEntries(ordinaryRetirementTriggers)
  }
  for (const [name, definition] of Object.entries(objects)) {
    const {
      rows: [actual]
    } = await db.execute({ sql: "SELECT sql FROM sqlite_schema WHERE name = ?", args: [name] })
    if (!matchesSql(actual?.sql, definition))
      throw new Error(`Unexpected ordinary Board object: ${name}`)
  }
  const { rows: legacy } = await db.execute(
    "SELECT id FROM task_boards WHERE storage_encoding = 'legacy_null_v1'"
  )
  if (legacy.length !== 1)
    throw new Error("Ordinary Boards require exactly one legacy storage owner")
  return true
}
