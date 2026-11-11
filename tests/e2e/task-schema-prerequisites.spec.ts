import { execFile } from "node:child_process"
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { expect, test as base } from "@playwright/test"
import { reconcileTaskSchemaPrerequisites } from "../../apps/web/drizzle/migrations/task-schema-prerequisites.mjs"
import { assertSupportedDatabaseSchema, DATABASE_SCHEMA_VERSION, openDatabase } from "../../apps/web/scripts/database-client.mjs"
import { ensureSchema, getPersistenceClient, resetPersistenceForTests } from "../../apps/web/src/domains/tasks/persistence/store"

const execFileAsync = promisify(execFile)
const webRoot = fileURLToPath(new URL("../../apps/web", import.meta.url))
const memberKey = "0123456789abcdef0123456789abcdef"
const test = base.extend<{ databasePath: string }>({
  databasePath: async ({}, use) => {
    const directory = await mkdtemp(join(tmpdir(), "meitheal-task-prerequisites-"))
    try {
      await use(join(directory, "meitheal.db"))
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  },
})

function migrate(databasePath: string, ...args: string[]) {
  return execFileAsync(process.execPath, ["scripts/migrate.mjs", ...args], {
    cwd: webRoot,
    env: { ...process.env, MEITHEAL_DB_URL: `file:${databasePath}` },
    timeout: 20_000,
  })
}

async function bootstrapRuntime(databasePath: string) {
  const previousDbUrl = process.env.MEITHEAL_DB_URL
  process.env.MEITHEAL_DB_URL = `file:${databasePath}`
  resetPersistenceForTests()
  let client: ReturnType<typeof getPersistenceClient> | undefined
  try {
    client = getPersistenceClient()
    await ensureSchema()
  } finally {
    client?.close()
    resetPersistenceForTests()
    if (previousDbUrl === undefined) delete process.env.MEITHEAL_DB_URL
    else process.env.MEITHEAL_DB_URL = previousDbUrl
  }
}

function withDatabase<T>(path: string, inspect: (database: DatabaseSync) => T): T {
  const database = new DatabaseSync(path, { enableForeignKeyConstraints: true })
  try {
    return inspect(database)
  } finally {
    database.close()
  }
}

function seedHierarchy(database: DatabaseSync) {
  database.exec(`
    INSERT INTO areas (id, name, wip_limit, created_at, updated_at)
      VALUES ('fixture-area', 'Household', 3, 1, 1);
    INSERT INTO goals (id, area_id, title, metric_type, metric_target, metric_current, created_at, updated_at)
      VALUES ('fixture-goal', 'fixture-area', 'Prepare the house', 'count', 5, 2, 1, 1);
    INSERT INTO projects (id, goal_id, area_id, title, created_at, updated_at)
      VALUES ('fixture-project', 'fixture-goal', 'fixture-area', 'Repairs', 1, 1);
    INSERT INTO tasks (id, area_id, goal_id, project_id, title, status, kanban_position, ticket_number,
                       idempotency_key, request_id, created_at, updated_at)
      VALUES ('fixture-task', 'fixture-area', 'fixture-goal', 'fixture-project', 'Repair door', 'pending', 7, 211,
              'fixture-task-key', 'fixture-request', 1, 1);
    INSERT INTO task_inactivity_policy (scope, area_id, days, revision)
      VALUES ('area:fixture-area', 'fixture-area', 5, '${memberKey}');
    INSERT INTO comments (task_id, content, owner_key)
      VALUES ('fixture-task', 'Check the hinges', '${memberKey}');
    INSERT INTO comment_mentions (id, task_id, comment_id, recipient_key, created_at)
      VALUES (101, 'fixture-task', last_insert_rowid(), '${memberKey}', 1);
    INSERT INTO app_settings (key, value, updated_at) VALUES ('fixture-preference', 'kept', 1);
    INSERT INTO kanban_lanes (id, key, label, position, created_at, updated_at)
      VALUES ('fixture-lane', 'fixture', 'Review', 9, 1, 1);
  `)
}

const sharedColumns = {
  areas: ["id", "name", "wip_limit", "energy_budget", "review_cadence", "last_reviewed_at"],
  goals: ["id", "area_id", "metric_type", "metric_target", "metric_current"],
  projects: ["id", "goal_id", "area_id", "is_default"],
  tasks: ["id", "area_id", "goal_id", "project_id", "priority", "is_promoted", "kanban_position", "ticket_number"],
  kanban_lanes: ["id", "key", "label", "position", "wip_limit", "includes", "built_in"],
  app_settings: ["key", "value", "updated_at"],
  comments: ["id", "task_id", "content", "author", "owner_key", "created_at"],
}

function sharedShape(database: DatabaseSync) {
  const info = database.prepare('SELECT name, type, "notnull", dflt_value, pk FROM pragma_table_info(?) ORDER BY name')
  return Object.fromEntries(Object.entries(sharedColumns).map(([table, names]) => {
    const columns = info.all(table).filter(row => names.includes(String(row.name)))
    expect(columns.map(row => row.name)).toEqual([...names].sort())
    return [table, columns]
  }))
}

function savedHierarchy(database: DatabaseSync) {
  return database.prepare(`
    SELECT a.id AS area, a.name AS area_name, a.wip_limit, g.id AS goal, g.metric_current,
           p.id AS project, t.id AS task, t.kanban_position, t.ticket_number,
           i.days, c.id AS comment, c.content, c.owner_key, m.id AS mention, m.recipient_key,
           l.id AS lane, l.label, s.value AS preference
    FROM tasks t
    JOIN projects p ON p.id = t.project_id AND p.goal_id = t.goal_id
    JOIN goals g ON g.id = t.goal_id
    JOIN areas a ON a.id = t.area_id AND a.id = g.area_id AND a.id = p.area_id
    JOIN task_inactivity_policy i ON i.area_id = a.id
    JOIN comments c ON c.task_id = t.id
    JOIN comment_mentions m ON m.comment_id = c.id AND m.task_id = t.id
    JOIN kanban_lanes l ON l.id = 'fixture-lane'
    JOIN app_settings s ON s.key = 'fixture-preference'
    WHERE t.id = 'fixture-task'
  `).get()
}

const expectedHierarchy = {
  area: "fixture-area", area_name: "Household", wip_limit: 3,
  goal: "fixture-goal", metric_current: 2, project: "fixture-project", task: "fixture-task",
  kanban_position: 7, ticket_number: 211, days: 5, comment: 1, content: "Check the hinges",
  owner_key: memberKey, mention: 101, recipient_key: memberKey,
  lane: "fixture-lane", label: "Review", preference: "kept",
}

function runtimeMarker(database: DatabaseSync) {
  return database.prepare("SELECT value FROM app_settings WHERE key = 'schema_version'").get()?.value
}

function lanes(database: DatabaseSync) {
  return database.prepare("SELECT id, key, label, position, wip_limit, includes FROM kanban_lanes ORDER BY position").all()
}

test("fresh CLI prepares writable hierarchy, policy and comments before runtime", async ({ databasePath }) => {
  await migrate(databasePath)
  await expect(migrate(databasePath, "--check")).resolves.toMatchObject({ stdout: expect.stringContaining("Migration check passed") })
  withDatabase(databasePath, database => {
    expect(runtimeMarker(database)).toBeUndefined()
    expect(database.prepare("SELECT id FROM areas").all()).toEqual([{ id: "default" }])
    expect(database.prepare("SELECT id FROM projects WHERE is_default = 1").all()).toEqual([{ id: "every-day" }])
    expect(lanes(database).map(lane => [lane.key, lane.label, lane.position])).toEqual([
      ["backlog", "Backlog", 0], ["pending", "Todo", 1], ["active", "In Progress", 2], ["complete", "Done", 3],
    ])
    seedHierarchy(database)
    const ordering = database.prepare("SELECT priority, is_promoted FROM tasks WHERE id = 'fixture-task'")
    expect(ordering.get()).toEqual({ priority: 3, is_promoted: 0 })
    expect(() => database.exec("UPDATE tasks SET is_promoted = 2 WHERE id = 'fixture-task'"))
      .toThrow(/CHECK constraint failed/i)
    expect(savedHierarchy(database)).toEqual(expectedHierarchy)
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([])
    expect(() => database.exec(`INSERT INTO goals (id, area_id, title, created_at, updated_at)
      VALUES ('invalid-goal', 'missing', 'Invalid goal', 1, 1)`)).toThrow(/FOREIGN KEY constraint failed/i)
    expect(() => database.exec(`INSERT INTO projects (id, goal_id, title, created_at, updated_at)
      VALUES ('invalid-project', 'missing', 'Invalid project', 1, 1)`)).toThrow(/FOREIGN KEY constraint failed/i)
    expect(() => database.prepare(`INSERT INTO task_inactivity_policy (scope, area_id, days, revision)
      VALUES ('area:missing', 'missing', 1, ?)`).run(memberKey)).toThrow(/FOREIGN KEY constraint failed/i)
    expect(() => database.exec(`INSERT INTO comment_mentions (task_id, comment_id, recipient_key, created_at)
      VALUES ('wrong-task', 1, 'fedcba9876543210fedcba9876543210', 1)`)).toThrow(/FOREIGN KEY constraint failed/i)
    database.exec("DELETE FROM comments WHERE id = 1")
    expect(database.prepare(`INSERT INTO comments (task_id, content)
      VALUES ('fixture-task', 'Replacement') RETURNING id, created_at`).get()).toEqual({
      id: 2, created_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/),
    })
  })
})

for (const first of ["CLI", "runtime"] as const) {
  const second = first === "CLI" ? "runtime" : "CLI"
  test(`${first} then ${second} preserves shared columns, IDs and user data`, async ({ databasePath }) => {
    const start = { CLI: migrate, runtime: bootstrapRuntime }
    await start[first](databasePath)
    const before = withDatabase(databasePath, database => {
      seedHierarchy(database)
      database.exec("UPDATE tasks SET priority = 1, is_promoted = 1 WHERE id = 'fixture-task'")
      return sharedShape(database)
    })
    await start[second](databasePath)
    await migrate(databasePath, "--check")
    withDatabase(databasePath, database => {
      expect(sharedShape(database)).toEqual(before)
      expect(savedHierarchy(database)).toEqual(expectedHierarchy)
      expect(database.prepare("SELECT priority, is_promoted FROM tasks WHERE id = 'fixture-task'").get())
        .toEqual({ priority: 1, is_promoted: 1 })
      expect(runtimeMarker(database)).toBe(String(DATABASE_SCHEMA_VERSION))
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([])
    })
  })
}

test("CLI check rejects missing prerequisites in a completed ledger without writing", async ({ databasePath }) => {
  await migrate(databasePath)
  await migrate(databasePath, "--check")
  const ledger = withDatabase(databasePath, database => {
    database.exec("DROP TABLE kanban_lanes")
    return database.prepare("SELECT name, applied_at FROM __meitheal_migrations ORDER BY name").all()
  })
  const before = await readFile(databasePath)
  const directory = dirname(databasePath)
  const beforeFiles = (await readdir(directory)).sort()
  await expect(migrate(databasePath, "--check")).rejects.toThrow(/kanban_lanes/i)
  expect(await readFile(databasePath)).toEqual(before)
  expect((await readdir(directory)).sort()).toEqual(beforeFiles)

  await migrate(databasePath)
  await migrate(databasePath, "--check")
  withDatabase(databasePath, database => {
    expect(database.prepare("SELECT name, applied_at FROM __meitheal_migrations ORDER BY name").all()).toEqual(ledger)
    expect(lanes(database).map(lane => lane.key)).toEqual(["backlog", "pending", "active", "complete"])
  })
})

test("CLI rejects an incompatible comment parent index and rolls back prerequisite repair", async ({ databasePath }) => {
  await migrate(databasePath)
  withDatabase(databasePath, database => database.exec(`
    DROP INDEX comments_id_task_idx;
    CREATE UNIQUE INDEX comments_id_task_idx ON comments(id, task_id COLLATE NOCASE);
  `))
  await expect(migrate(databasePath, "--check")).rejects.toThrow(/Unexpected task prerequisite index: comments_id_task_idx/)
  withDatabase(databasePath, database => database.exec("DROP TABLE kanban_lanes"))
  await expect(migrate(databasePath)).rejects.toThrow(/Unexpected task prerequisite index: comments_id_task_idx/)
  withDatabase(databasePath, database => {
    expect(database.prepare("SELECT name FROM sqlite_schema WHERE name = 'kanban_lanes'").get()).toBeUndefined()
  })
})

test("CLI asks SQLite to validate the comment foreign key against the declared parent collation", async ({ databasePath }) => {
  await migrate(databasePath)
  withDatabase(databasePath, database => database.exec(`
    PRAGMA foreign_keys = OFF;
    DROP TABLE comments;
    CREATE TABLE comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL COLLATE NOCASE REFERENCES tasks(id) ON DELETE CASCADE,
      content TEXT NOT NULL, author TEXT NOT NULL DEFAULT 'user', owner_key TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX comments_id_task_idx ON comments(id, task_id COLLATE BINARY);
    CREATE INDEX comments_task_id_idx ON comments(task_id COLLATE BINARY);
    CREATE INDEX comments_task_created_idx ON comments(task_id COLLATE BINARY, created_at DESC);
  `))
  const before = await readFile(databasePath)
  await expect(migrate(databasePath, "--check")).rejects.toThrow(/foreign key mismatch/i)
  expect(await readFile(databasePath)).toEqual(before)
  await expect(migrate(databasePath)).rejects.toThrow(/foreign key mismatch/i)
  expect(await readFile(databasePath)).toEqual(before)
})

for (const [definition, expected] of [
  ["INT PRIMARY KEY", /Unexpected task prerequisite generated key: comments.id/],
  ["INTEGER PRIMARY KEY /* AUTOINCREMENT */", /Unexpected task prerequisite generated key: comments.id/],
  ["INTEGER PRIMARY KEY AUTOINCREMENT", /Unexpected task prerequisite timestamp default: comments.created_at/],
] as const) {
  test(`CLI rejects unusable comments with ${definition}`, async ({ databasePath }) => {
    await seedLegacy(databasePath)
    withDatabase(databasePath, database => database.exec(`
      CREATE TABLE comments (
        id ${definition}, task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        content TEXT NOT NULL, author TEXT NOT NULL DEFAULT 'user', created_at TEXT NOT NULL
      );
    `))
    await expect(migrate(databasePath)).rejects.toThrow(expected)
  })
}

for (const [object, remove, error] of [
  ["deferral index", "DROP INDEX tasks_deferred_order_idx", /Unexpected task deferral index: tasks_deferred_order_idx/],
  ["stall column", `DROP TRIGGER tasks_stall_initial_assignment;
    DROP TRIGGER tasks_stall_transition;
    DROP TRIGGER comments_stall_burst;
    ALTER TABLE tasks DROP COLUMN last_activity_spike_at`, /Unexpected stall column: tasks.last_activity_spike_at/],
] as const) {
  test(`CLI leaves prerequisites untouched when the numbered ${object} is invalid`, async ({ databasePath }) => {
    await migrate(databasePath)
    withDatabase(databasePath, database => database.exec(`${remove}; DROP TABLE kanban_lanes;`))
    await expect(migrate(databasePath)).rejects.toThrow(error)
    withDatabase(databasePath, database => {
      expect(database.prepare("SELECT name FROM sqlite_schema WHERE name = 'kanban_lanes'").get()).toBeUndefined()
    })
  })
}

test("prerequisite writer rechecks a newer marker committed while waiting for the lock", async ({ databasePath }) => {
  await migrate(databasePath)
  const client = openDatabase(`file:${databasePath}`)
  try {
    await assertSupportedDatabaseSchema(client)
    const reconcile = withDatabase(databasePath, database => {
      database.exec("BEGIN IMMEDIATE")
      database.prepare("INSERT INTO app_settings VALUES ('schema_version', ?, 1)").run(String(DATABASE_SCHEMA_VERSION + 1))
      database.exec("DROP TABLE kanban_lanes")
      const pending = reconcileTaskSchemaPrerequisites(client)
      database.exec("COMMIT")
      return pending
    })
    await expect(reconcile).rejects.toThrow(/requires a newer App/)
    withDatabase(databasePath, database => {
      expect(runtimeMarker(database)).toBe(String(DATABASE_SCHEMA_VERSION + 1))
      expect(database.prepare("SELECT name FROM sqlite_schema WHERE name = 'kanban_lanes'").get()).toBeUndefined()
    })
  } finally {
    client.close()
  }
})

async function seedLegacy(databasePath: string) {
  const baseSchema = await readFile(join(webRoot, "drizzle/migrations/0000_iteration2_init.sql"), "utf8")
  withDatabase(databasePath, database => {
    database.exec(baseSchema)
    database.exec(`
      CREATE TABLE areas (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, icon TEXT NOT NULL DEFAULT '📋',
        color TEXT NOT NULL DEFAULT '#6366F1', position INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE goals (
        id TEXT PRIMARY KEY, area_id TEXT REFERENCES areas(id) ON DELETE SET NULL,
        title TEXT NOT NULL, description TEXT, status TEXT NOT NULL DEFAULT 'active', target_date TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE projects (
        id TEXT PRIMARY KEY, goal_id TEXT REFERENCES goals(id) ON DELETE SET NULL,
        title TEXT NOT NULL, description TEXT, status TEXT NOT NULL DEFAULT 'active',
        icon TEXT NOT NULL DEFAULT '📋', color TEXT NOT NULL DEFAULT '#6366F1', position INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE kanban_lanes (
        id TEXT PRIMARY KEY, key TEXT NOT NULL UNIQUE, label TEXT NOT NULL, icon TEXT NOT NULL DEFAULT '📌',
        position INTEGER NOT NULL DEFAULT 0, wip_limit INTEGER NOT NULL DEFAULT 0, includes TEXT NOT NULL DEFAULT '[]',
        built_in INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      INSERT INTO areas (id, title, created_at, updated_at) VALUES ('legacy-area', 'Old Household', 1, 1);
      INSERT INTO goals (id, area_id, title, created_at, updated_at)
        VALUES ('legacy-goal', 'legacy-area', 'Keep the goal', 1, 1);
      INSERT INTO projects (id, goal_id, title, created_at, updated_at)
        VALUES ('legacy-project', 'legacy-goal', 'Keep the project', 1, 1);
      INSERT INTO kanban_lanes (id, key, label, position, wip_limit, includes, built_in, created_at, updated_at) VALUES
        ('old-pending', 'pending', 'Pending', 0, 0, '["pending","todo"]', 1, 1, 1),
        ('old-active', 'active', 'Doing it', 1, 2, '["active","in_progress"]', 1, 1, 1),
        ('old-complete', 'complete', 'Complete', 2, 0, '["complete","done"]', 1, 1, 1),
        ('old-custom', 'custom', 'Review', 5, 4, '["pending"]', 0, 1, 1);
      INSERT INTO tasks (rowid, id, title, idempotency_key, request_id, created_at, updated_at) VALUES
        (4, 'old-first', 'Keep the first task', 'old-first-key', 'request', 1, 1),
        (9, 'old-last', 'Keep the last task', 'old-last-key', 'request', 1, 1);
    `)
  })
}

test("CLI restores the default Area before backfilling an imported Project", async ({ databasePath }) => {
  await seedLegacy(databasePath)
  withDatabase(databasePath, database => database.exec(`
    PRAGMA foreign_keys = OFF;
    DELETE FROM areas;
    UPDATE goals SET area_id = 'default';
  `))
  await migrate(databasePath)
  await migrate(databasePath, "--check")
  withDatabase(databasePath, database => {
    expect(database.prepare("SELECT area_id FROM projects WHERE id = 'legacy-project'").get()).toEqual({ area_id: "default" })
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([])
  })
})

test("legacy names, project Area, Backlog positions and ticket numbers upgrade once", async ({ databasePath }) => {
  await seedLegacy(databasePath)
  withDatabase(databasePath, database => database.exec(`
    ALTER TABLE tasks ADD COLUMN board_id TEXT;
    CREATE INDEX tasks_board_status_idx ON tasks(board_id, status);
    UPDATE tasks SET board_id = 'historic-board' WHERE id = 'old-first';
  `))
  await migrate(databasePath)
  const upgradedLanes = withDatabase(databasePath, database => {
    expect(database.prepare("SELECT id, name FROM areas").all()).toEqual([{ id: "legacy-area", name: "Old Household" }])
    expect(database.prepare("SELECT name FROM pragma_table_info('areas') WHERE name = 'title'").get()).toBeUndefined()
    expect(database.prepare("SELECT goal_id, area_id FROM projects WHERE id = 'legacy-project'").get()).toEqual({
      goal_id: "legacy-goal", area_id: "legacy-area",
    })
    expect(database.prepare("SELECT id, ticket_number FROM tasks ORDER BY rowid").all()).toEqual([
      { id: "old-first", ticket_number: 4 }, { id: "old-last", ticket_number: 9 },
    ])
    expect(database.prepare("SELECT name FROM pragma_index_info('tasks_board_status_idx') ORDER BY seqno").all())
      .toEqual([{ name: "area_id" }, { name: "status" }])
    expect(database.prepare("SELECT board_id FROM tasks WHERE id = 'old-first'").get()).toEqual({ board_id: "historic-board" })
    const currentLanes = lanes(database)
    expect(currentLanes).toEqual([
      { id: "lane-backlog", key: "backlog", label: "Backlog", position: 0, wip_limit: 0, includes: '["backlog"]' },
      { id: "old-pending", key: "pending", label: "Todo", position: 1, wip_limit: 0, includes: '["pending","todo"]' },
      { id: "old-active", key: "active", label: "Doing it", position: 2, wip_limit: 2, includes: '["active","in_progress"]' },
      { id: "old-complete", key: "complete", label: "Done", position: 3, wip_limit: 0, includes: '["complete","done"]' },
      { id: "old-custom", key: "custom", label: "Review", position: 6, wip_limit: 4, includes: '["pending"]' },
    ])
    database.exec(`
      UPDATE projects SET area_id = NULL WHERE id = 'legacy-project';
      INSERT INTO tasks (id, title, idempotency_key, request_id, ticket_number, created_at, updated_at)
        VALUES ('new-unnumbered', 'Intentionally unnumbered', 'new-key', 'request', NULL, 1, 1);
    `)
    return currentLanes
  })

  await bootstrapRuntime(databasePath)
  await migrate(databasePath)
  await migrate(databasePath, "--check")
  withDatabase(databasePath, database => {
    expect(lanes(database)).toEqual(upgradedLanes)
    expect(database.prepare("SELECT goal_id, area_id FROM projects WHERE id = 'legacy-project'").get()).toEqual({
      goal_id: "legacy-goal", area_id: null,
    })
    expect(database.prepare("SELECT id, ticket_number FROM tasks ORDER BY rowid").all()).toEqual([
      { id: "old-first", ticket_number: 4 }, { id: "old-last", ticket_number: 9 },
      { id: "new-unnumbered", ticket_number: null },
    ])
  })
})

test("failed Backlog insertion rolls back the shared schema upgrade", async ({ databasePath }) => {
  await seedLegacy(databasePath)
  const before = withDatabase(databasePath, database => {
    database.exec(`CREATE TRIGGER refuse_backlog BEFORE INSERT ON kanban_lanes
      WHEN NEW.key = 'backlog' BEGIN SELECT RAISE(ABORT, 'fixture refused Backlog'); END`)
    return lanes(database)
  })
  await expect(migrate(databasePath)).rejects.toThrow(/fixture refused Backlog/)
  withDatabase(databasePath, database => {
    expect(lanes(database)).toEqual(before)
    expect(database.prepare("SELECT title FROM areas WHERE id = 'legacy-area'").get()).toEqual({ title: "Old Household" })
    expect(database.prepare("SELECT name FROM pragma_table_info('projects') WHERE name = 'area_id'").get()).toBeUndefined()
    expect(database.prepare("SELECT name FROM pragma_table_info('tasks') WHERE name = 'ticket_number'").get()).toBeUndefined()
    database.exec("DROP TRIGGER refuse_backlog")
  })
  await migrate(databasePath)
  await migrate(databasePath, "--check")
  withDatabase(databasePath, database => {
    expect(lanes(database).map(lane => [lane.id, lane.position])).toEqual([
      ["lane-backlog", 0], ["old-pending", 1], ["old-active", 2], ["old-complete", 3], ["old-custom", 6],
    ])
  })
})
