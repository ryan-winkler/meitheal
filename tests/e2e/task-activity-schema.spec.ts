import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { expect, test as base } from "@playwright/test"
import { DATABASE_SCHEMA_VERSION } from "../../apps/web/scripts/database-client.mjs"
import { ensureSchema, getPersistenceClient, resetPersistenceForTests } from "../../apps/web/src/domains/tasks/persistence/store"

const execFileAsync = promisify(execFile)
const webRoot = fileURLToPath(new URL("../../apps/web", import.meta.url))
const generation = /^[0-9a-f]{32}$/
const triggerNames = [
  "areas_inactivity_generation",
  "comments_inactivity_delete",
  "comments_inactivity_insert",
  "comments_inactivity_update",
  "comments_stall_burst",
  "tasks_inactivity_touch",
  "tasks_stall_initial_assignment",
  "tasks_stall_transition",
]

const test = base.extend<{ databasePath: string }>({
  databasePath: async ({}, use) => {
    const directory = await mkdtemp(join(tmpdir(), "meitheal-task-activity-"))
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
  const previous = process.env.MEITHEAL_DB_URL
  process.env.MEITHEAL_DB_URL = `file:${databasePath}`
  resetPersistenceForTests()
  let client: ReturnType<typeof getPersistenceClient> | undefined
  try {
    client = getPersistenceClient()
    await ensureSchema()
  } finally {
    client?.close()
    resetPersistenceForTests()
    if (previous === undefined) delete process.env.MEITHEAL_DB_URL
    else process.env.MEITHEAL_DB_URL = previous
  }
}

function withDatabase<T>(path: string, use: (database: DatabaseSync) => T): T {
  const database = new DatabaseSync(path, { enableForeignKeyConstraints: true })
  try {
    return use(database)
  } finally {
    database.close()
  }
}

function readTriggers(database: DatabaseSync) {
  return database.prepare(`SELECT name, sql FROM sqlite_schema WHERE type = 'trigger'
    AND (name GLOB '*_inactivity_*' OR name GLOB '*_stall_*') ORDER BY name`).all()
}

function readMarker(database: DatabaseSync) {
  return database.prepare("SELECT value FROM app_settings WHERE key = 'schema_version'").get()?.value
}

function readLedger(database: DatabaseSync) {
  return database.prepare("SELECT name, applied_at FROM __meitheal_migrations ORDER BY name").all()
}

function enablePolicy(database: DatabaseSync) {
  database.exec(`INSERT INTO task_inactivity_policy (scope, days, revision)
    VALUES ('default', 30, '0123456789abcdef0123456789abcdef')`)
}

function insertTask(database: DatabaseSync, id: string, status: string) {
  database.prepare(`INSERT INTO tasks
    (id, title, status, assigned_to, idempotency_key, request_id, created_at, updated_at)
    VALUES (?, ?, ?, 'resident', ?, ?, 1, 1)`).run(id, id, status, id, id)
}

test("the standalone CLI installs working activity triggers before web startup", async ({ databasePath }) => {
  await migrate(databasePath)
  await migrate(databasePath, "--check")
  withDatabase(databasePath, database => {
    expect(readMarker(database)).toBeUndefined()
    const triggers = readTriggers(database)
    expect(triggers.map(trigger => trigger.name)).toEqual(triggerNames)
    // Existing version-18 databases store these definitions verbatim.
    expect(createHash("sha256").update(JSON.stringify(triggers)).digest("hex"))
      .toBe("630b0f9d0f1f3f7c43fe9f6df81f300698ae3faf9faced671f6dac5a4c83d2ec")
    database.exec("INSERT INTO areas (id, name, created_at, updated_at) VALUES ('new', 'New Area', 1, 1)")
    const areas = database.prepare("SELECT inactivity_generation FROM areas ORDER BY id").all()
    expect(areas).toEqual([{ inactivity_generation: expect.stringMatching(generation) }, {
      inactivity_generation: expect.stringMatching(generation),
    }])
    expect(new Set(areas.map(area => area.inactivity_generation)).size).toBe(2)

    enablePolicy(database)
    database.exec(`INSERT INTO tasks (id, title, idempotency_key, request_id, created_at, updated_at)
      VALUES ('unassigned', 'Unassigned', 'unassigned', 'unassigned', 1, 1)`)
    expect(database.prepare("SELECT assigned_to, last_activity_spike_at FROM tasks WHERE id = 'unassigned'").get())
      .toEqual({ assigned_to: null, last_activity_spike_at: null })
    insertTask(database, "assigned", "pending")
    const task = database.prepare(`SELECT inactivity_touched_at AS touched, last_activity_spike_at AS spike
      FROM tasks WHERE id = 'assigned'`)
    const readActivity = () => task.get()!
    expect(readActivity()).toEqual({ touched: null, spike: expect.any(Number) })
    expect(readActivity().spike).toBeGreaterThan(1)

    database.exec("UPDATE tasks SET status = 'done', last_activity_spike_at = 1 WHERE id = 'assigned'")
    expect(readActivity().spike).toBe(1)
    database.exec("UPDATE tasks SET status = 'todo' WHERE id = 'assigned'")
    expect(readActivity().spike).toBeGreaterThan(1)
    database.exec(`UPDATE tasks SET deferred_at = 1, last_activity_spike_at = NULL WHERE id = 'assigned';
      UPDATE tasks SET deferred_at = NULL WHERE id = 'assigned';`)
    expect(readActivity().touched).toBeGreaterThan(1)

    const comment = database.prepare(`INSERT INTO comments (task_id, content, owner_key, inactivity_spike_human)
      VALUES ('assigned', 'Activity note', ?, ?)`)
    database.exec("UPDATE tasks SET inactivity_touched_at = NULL WHERE id = 'assigned'")
    comment.run("resident", 1)
    expect(readActivity().touched).toBeGreaterThan(1)
    comment.run("resident", 1)
    comment.run("automation", 0)
    expect(readActivity().spike).toBeNull()
    comment.run("other-resident", 1)
    expect(readActivity().spike).toBeGreaterThan(1)
    database.exec(`UPDATE tasks SET inactivity_touched_at = NULL WHERE id = 'assigned';
      UPDATE comments SET content = 'Edited note' WHERE id = 1;`)
    expect(readActivity().touched).toBeGreaterThan(1)
    database.exec(`UPDATE tasks SET inactivity_touched_at = NULL WHERE id = 'assigned';
      DELETE FROM comments WHERE id = 1;`)
    expect(readActivity().touched).toBeGreaterThan(1)
  })
})

test("both startup paths refuse a column that assigns new tasks by default", async ({ databasePath }) => {
  await migrate(databasePath)
  withDatabase(databasePath, database => database.exec(`
    DROP TRIGGER tasks_stall_initial_assignment;
    DROP TRIGGER tasks_stall_transition;
    DROP INDEX tasks_assigned_to_idx;
    ALTER TABLE tasks DROP COLUMN assigned_to;
    ALTER TABLE tasks ADD COLUMN assigned_to TEXT DEFAULT 'resident';
    CREATE INDEX tasks_assigned_to_idx ON tasks(assigned_to);
  `))
  const beforeCheck = await readFile(databasePath)
  await expect(migrate(databasePath, "--check")).rejects.toThrow(/Unexpected task prerequisite assignee column/)
  expect(await readFile(databasePath)).toEqual(beforeCheck)
  withDatabase(databasePath, database => database.exec("DROP TABLE kanban_lanes"))
  const initial = await readFile(databasePath)
  await expect(migrate(databasePath)).rejects.toThrow(/Unexpected task prerequisite assignee column/)
  expect(await readFile(databasePath)).toEqual(initial)
  await expect(bootstrapRuntime(databasePath)).rejects.toThrow(/Unexpected task prerequisite assignee column/)
  withDatabase(databasePath, database => {
    expect(database.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'kanban_lanes'").get()).toBeUndefined()
    expect(readMarker(database)).toBeUndefined()
  })
})

test("startup preserves non-null imported Area generations accepted by the predecessor", async ({ databasePath }) => {
  await migrate(databasePath)
  const readGenerations = (database: DatabaseSync) => database.prepare(`
    SELECT id, typeof(inactivity_generation) AS storage, hex(inactivity_generation) AS bytes FROM areas ORDER BY id
  `).all()
  const before = withDatabase(databasePath, database => {
    database.exec(`
      INSERT INTO areas (id, name, created_at, updated_at) VALUES ('imported', 'Imported Area', 1, 1);
      UPDATE areas SET inactivity_generation = CAST('0123456789abcdef0123456789abcdef' AS BLOB) WHERE id = 'default';
      UPDATE areas SET inactivity_generation = 'a' || char(0) || '0123456789abcdef0123456789abcd' WHERE id = 'imported';
    `)
    const rows = readGenerations(database)
    expect(rows.map(row => [row.storage, String(row.bytes).length])).toEqual([["blob", 64], ["text", 64]])
    return rows
  })
  await migrate(databasePath, "--check")
  await migrate(databasePath)
  await bootstrapRuntime(databasePath)
  expect(withDatabase(databasePath, readGenerations)).toEqual(before)
})

for (const name of ["areas_inactivity_generation", "AREAS_INACTIVITY_GENERATION"]) {
  test(`both startup paths reject ${name} drift before restoring the default Area`, async ({ databasePath }) => {
    await migrate(databasePath)
    withDatabase(databasePath, database => {
      insertTask(database, "retained-task", "pending")
      database.exec(`
        DROP TRIGGER areas_inactivity_generation;
        DELETE FROM areas;
        CREATE TRIGGER ${name} AFTER INSERT ON areas
          BEGIN UPDATE tasks SET title = 'Changed by invalid trigger' WHERE id = 'retained-task'; END;
      `)
    })
    for (const start of [migrate, bootstrapRuntime]) {
      await expect(start(databasePath)).rejects.toThrow(/Unexpected task inactivity trigger: areas_inactivity_generation/)
      withDatabase(databasePath, database => {
        expect(database.prepare("SELECT title FROM tasks WHERE id = 'retained-task'").get()).toEqual({ title: "retained-task" })
        expect(database.prepare("SELECT id FROM areas").all()).toEqual([])
        expect(readMarker(database)).toBeUndefined()
      })
    }
  })
}

for (const [family, name] of [
  ["stall", "tasks_stall_transition"],
  ["deferral", "tasks_deferral_status_revision"],
] as const) {
  test(`both startup paths reject ${family} trigger drift before normalizing a legacy status`, async ({ databasePath }) => {
    await migrate(databasePath)
    withDatabase(databasePath, database => {
      insertTask(database, "retained-task", "todo")
      database.exec(`
        DROP TRIGGER ${name};
        CREATE TRIGGER ${name} AFTER UPDATE OF status ON tasks
          BEGIN UPDATE tasks SET title = 'Changed by invalid trigger' WHERE id = NEW.id; END;
      `)
    })
    for (const start of [migrate, bootstrapRuntime]) {
      await expect(start(databasePath)).rejects.toThrow(`Unexpected task ${family} trigger: ${name}`)
      withDatabase(databasePath, database => {
        expect(database.prepare("SELECT title, status FROM tasks WHERE id = 'retained-task'").get())
          .toEqual({ title: "retained-task", status: "todo" })
        expect(readMarker(database)).toBeUndefined()
      })
    }
  })
}

test("both startup paths reject case drift in a deferral trigger status literal", async ({ databasePath }) => {
  await migrate(databasePath)
  withDatabase(databasePath, database => {
    insertTask(database, "retained-task", "done")
    database.exec("UPDATE tasks SET deferred_at = 1 WHERE id = 'retained-task'")
    const { sql } = database.prepare("SELECT sql FROM sqlite_schema WHERE name = 'tasks_deferral_status_revision'").get()!
    const canonical = String(sql)
    const drifted = canonical.replace("CASE WHEN lower(NEW.status) IN ('complete'", "CASE WHEN lower(NEW.status) IN ('Complete'")
    expect(drifted).not.toBe(canonical)
    database.exec("DROP TRIGGER tasks_deferral_status_revision")
    database.exec(drifted)
  })
  const error = /Unexpected task deferral trigger: tasks_deferral_status_revision/
  await expect(migrate(databasePath, "--check")).rejects.toThrow(error)
  for (const start of [migrate, bootstrapRuntime]) {
    await expect(start(databasePath)).rejects.toThrow(error)
    withDatabase(databasePath, database => {
      expect(database.prepare("SELECT status, deferred_at FROM tasks WHERE id = 'retained-task'").get())
        .toEqual({ status: "done", deferred_at: 1 })
      expect(readMarker(database)).toBeUndefined()
    })
  }
})

test("both startup paths reject task trigger drift before backfilling ticket numbers", async ({ databasePath }) => {
  await migrate(databasePath)
  withDatabase(databasePath, database => {
    insertTask(database, "retained-task", "pending")
    database.exec(`
      DROP INDEX tasks_ticket_number_idx;
      ALTER TABLE tasks DROP COLUMN ticket_number;
      DROP TRIGGER tasks_inactivity_touch;
      CREATE TRIGGER tasks_inactivity_touch AFTER UPDATE OF ticket_number ON tasks
        BEGIN UPDATE tasks SET title = 'Changed by invalid trigger' WHERE id = NEW.id; END;
    `)
  })
  for (const start of [migrate, bootstrapRuntime]) {
    await expect(start(databasePath)).rejects.toThrow(/Unexpected task inactivity trigger: tasks_inactivity_touch/)
    withDatabase(databasePath, database => {
      expect(database.prepare("SELECT title FROM tasks WHERE id = 'retained-task'").get()).toEqual({ title: "retained-task" })
      expect(database.prepare("SELECT name FROM pragma_table_info('tasks') WHERE name = 'ticket_number'").get())
        .toBeUndefined()
    })
  }
})

for (const first of ["CLI", "runtime"] as const) {
  const second = first === "CLI" ? "runtime" : "CLI"
  test(`${first} then ${second} preserves trigger SQL, existing spikes and ledger records`, async ({ databasePath }) => {
    const start = { CLI: migrate, runtime: bootstrapRuntime }
    await start[first](databasePath)
    const before = withDatabase(databasePath, database => {
      expect(readMarker(database)).toBe(first === "CLI" ? undefined : String(DATABASE_SCHEMA_VERSION))
      enablePolicy(database)
      for (const status of ["todo", "in_progress", "done"]) insertTask(database, status, status)
      database.exec("UPDATE tasks SET last_activity_spike_at = 17")
      const triggers = readTriggers(database)
      expect(triggers.map(trigger => trigger.name)).toEqual(triggerNames)
      return {
        triggers,
        areas: database.prepare("SELECT id, inactivity_generation FROM areas ORDER BY id").all(),
        ledger: first === "CLI" ? readLedger(database) : undefined,
      }
    })

    await start[second](databasePath)
    const ledger = withDatabase(databasePath, database => {
      expect(readTriggers(database)).toEqual(before.triggers)
      return readLedger(database)
    })
    expect(ledger.map(entry => entry.name)).toEqual(expect.arrayContaining(["0007_task_inactivity.mjs", "0008_task_stall.mjs"]))
    if (before.ledger) expect(ledger).toEqual(before.ledger)
    if (first === "runtime") await bootstrapRuntime(databasePath)
    await migrate(databasePath, "--check")
    withDatabase(databasePath, database => {
      expect(readTriggers(database)).toEqual(before.triggers)
      expect(readMarker(database)).toBe(String(DATABASE_SCHEMA_VERSION))
      expect(readLedger(database)).toEqual(ledger)
      expect(database.prepare("SELECT id, inactivity_generation FROM areas ORDER BY id").all()).toEqual(before.areas)
      expect(database.prepare("SELECT id, status, last_activity_spike_at FROM tasks ORDER BY id").all()).toEqual([
        { id: "done", status: "complete", last_activity_spike_at: 17 },
        { id: "in_progress", status: "active", last_activity_spike_at: 17 },
        { id: "todo", status: "pending", last_activity_spike_at: 17 },
      ])
    })
  })
}

test("CLI check detects a missing activity trigger without writing and apply repairs it", async ({ databasePath }) => {
  await migrate(databasePath)
  const { triggers, ledger } = withDatabase(databasePath, database => {
    const before = { triggers: readTriggers(database), ledger: readLedger(database) }
    database.exec("DROP TRIGGER tasks_stall_transition")
    return before
  })
  const directory = dirname(databasePath)
  const beforeBytes = await readFile(databasePath)
  const beforeFiles = (await readdir(directory)).sort()
  await expect(migrate(databasePath, "--check")).rejects.toThrow(/tasks_stall_transition/)
  expect(await readFile(databasePath)).toEqual(beforeBytes)
  expect((await readdir(directory)).sort()).toEqual(beforeFiles)

  await migrate(databasePath)
  await migrate(databasePath, "--check")
  withDatabase(databasePath, database => {
    expect(readTriggers(database)).toEqual(triggers)
    expect(readLedger(database)).toEqual(ledger)
    expect(readMarker(database)).toBeUndefined()
  })
})

test("a malformed stall column rolls back earlier activity repairs through both entry points", async ({ databasePath }) => {
  await bootstrapRuntime(databasePath)
  await migrate(databasePath)
  const { ledger, triggers, before } = withDatabase(databasePath, database => {
    const ledger = readLedger(database)
    const triggers = readTriggers(database)
    database.exec(`DROP TRIGGER comments_inactivity_delete;
      DROP TRIGGER comments_stall_burst;
      ALTER TABLE comments DROP COLUMN inactivity_spike_human;
      ALTER TABLE comments ADD COLUMN inactivity_spike_human INTEGER NOT NULL DEFAULT 0;
      UPDATE areas SET inactivity_generation = NULL WHERE id = 'default';`)
    return { ledger, triggers, before: readTriggers(database) }
  })
  for (const start of [migrate, bootstrapRuntime]) {
    await expect(start(databasePath)).rejects.toThrow(/Unexpected stall column: comments.inactivity_spike_human/)
    withDatabase(databasePath, database => {
      expect(readTriggers(database)).toEqual(before)
      expect(readLedger(database)).toEqual(ledger)
      expect(readMarker(database)).toBe(String(DATABASE_SCHEMA_VERSION))
      expect(database.prepare("SELECT inactivity_generation FROM areas WHERE id = 'default'").get()).toEqual({
        inactivity_generation: null,
      })
      expect(database.prepare("SELECT sql FROM sqlite_schema WHERE name = 'comments'").get()?.sql)
        .not.toContain("CHECK(typeof(inactivity_spike_human)")
    })
  }

  withDatabase(databasePath, database => database.exec("ALTER TABLE comments DROP COLUMN inactivity_spike_human"))
  await migrate(databasePath)
  await migrate(databasePath, "--check")
  withDatabase(databasePath, database => {
    expect(readTriggers(database)).toEqual(triggers)
    expect(readLedger(database)).toEqual(ledger)
    expect(database.prepare("SELECT inactivity_generation FROM areas WHERE id = 'default'").get()).toEqual({
      inactivity_generation: expect.stringMatching(generation),
    })
  })
})
