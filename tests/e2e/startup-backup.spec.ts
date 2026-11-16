import { execFile, fork } from "node:child_process"
import { createHash } from "node:crypto"
import { once } from "node:events"
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { setTimeout } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { expect, test } from "@playwright/test"
import { PERSONAL_PILLAR_MIGRATION } from "../../apps/web/drizzle/migrations/0010_personal_pillars.mjs"
import { BOARD_ACCESS_MIGRATION } from "../../apps/web/drizzle/migrations/0011_board_access.mjs"
import { TASK_BOARD_MIGRATION, TASK_BOARD_SCHEMA_VERSION } from "../../apps/web/drizzle/migrations/task-board-upgrade.mjs"
import { DATABASE_SCHEMA_VERSION, openDatabase } from "../../apps/web/scripts/database-client.mjs"
import { HierarchyRepository } from "../../apps/web/src/domains/tasks/persistence/hierarchy-repository"
import { getPillarById, getPillars } from "../../apps/web/src/domains/pillars/pillar-service"
import { readSharedGoalsForArea } from "../../apps/web/src/domains/tasks/persistence/shared-goal-repository"
import { TaskRepository } from "../../apps/web/src/domains/tasks/persistence/task-repository"
import { ensureSchema, getPersistenceClient, resetPersistenceForTests } from "../../apps/web/src/domains/tasks/persistence/store"
import { prepareTaskBoardPredecessor, predecessorMigrationNames } from "../scripts/task-board-predecessor"

const execFileAsync = promisify(execFile)
const webRoot = fileURLToPath(new URL("../../apps/web", import.meta.url))
let directory: string
let dbPath: string
const previousDbUrl = process.env.MEITHEAL_DB_URL
const previousBackupHandled = process.env.MEITHEAL_STARTUP_BACKUP_HANDLED
const predecessorVersion = String(TASK_BOARD_SCHEMA_VERSION - 1)
const futureVersion = String(DATABASE_SCHEMA_VERSION + 1)

function migrate(...args: string[]) {
  return execFileAsync(process.execPath, ["scripts/migrate.mjs", ...args], { cwd: webRoot, timeout: 20_000 })
}

function seedSchemaMarker(value: string, inWal = false) {
  const database = new DatabaseSync(dbPath)
  database.exec("CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)")
  database.prepare("INSERT INTO app_settings VALUES ('schema_version', ?, 1)").run(predecessorVersion)
  if (inWal) database.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; PRAGMA wal_checkpoint(TRUNCATE)")
  database.prepare("UPDATE app_settings SET value=? WHERE key='schema_version'").run(value)
  return database
}

const fixtureToken = `mth_${"b".repeat(64)}`

async function seedBoardPredecessor({ token = false, unsupported = false, ledger = true } = {}) {
  const client = openDatabase(`file:${dbPath}`)
  try {
    await prepareTaskBoardPredecessor(client)
    await client.batch([
      "INSERT INTO app_settings VALUES ('schema_version', '18', 1)",
      "INSERT INTO tasks (id, title, request_id, idempotency_key, created_at, updated_at) VALUES ('original', 'Retained startup task', 'original', 'original', 1, 1)",
      ...(ledger ? [] : ["DROP TABLE __meitheal_migrations"]),
      ...(unsupported ? ["CREATE INDEX fixture_unsupported_lane ON kanban_lanes(label)"] : []),
    ], "write")
    if (token) {
      await client.batch([
        `CREATE TABLE agent_tokens (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, token_prefix TEXT NOT NULL,
          scopes TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, expires_at TEXT, last_used_at TEXT,
          revoked INTEGER NOT NULL DEFAULT 0
        )`,
        {
          sql: "INSERT INTO agent_tokens (id, name, token_hash, token_prefix, scopes, created_at) VALUES (?, ?, ?, ?, ?, ?)",
          args: ["fixture-agent", "Fixture agent", createHash("sha256").update(fixtureToken).digest("hex"),
            "mth_bbbb", '["tasks:read"]', "2026-01-01T00:00:00.000Z"],
        },
      ], "write")
    }
  } finally {
    client.close()
  }
}

test.beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "meitheal-startup-backup-"))
  dbPath = join(directory, "meitheal.db")
  resetPersistenceForTests()
  process.env.MEITHEAL_DB_URL = `file:${dbPath}`
  delete process.env.MEITHEAL_STARTUP_BACKUP_HANDLED
})

test.afterEach(async () => {
  resetPersistenceForTests()
  if (previousDbUrl === undefined) delete process.env.MEITHEAL_DB_URL
  else process.env.MEITHEAL_DB_URL = previousDbUrl
  if (previousBackupHandled === undefined) delete process.env.MEITHEAL_STARTUP_BACKUP_HANDLED
  else process.env.MEITHEAL_STARTUP_BACKUP_HANDLED = previousBackupHandled
  await rm(directory, { recursive: true, force: true })
})

async function seedLegacyWal() {
  const client = openDatabase(`file:${dbPath}`)
  try {
    await client.execute("PRAGMA journal_mode=WAL")
    await client.execute("PRAGMA wal_autocheckpoint=0")
    await client.execute("CREATE TABLE legacy_probe (value TEXT NOT NULL)")
    await client.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    await client.execute("INSERT INTO legacy_probe VALUES ('committed in WAL')")
    expect((await stat(`${dbPath}-wal`)).size).toBeGreaterThan(32)

    const mainOnly = join(directory, "main-only.db")
    await copyFile(dbPath, mainOnly)
    const probe = new DatabaseSync(mainOnly, { readOnly: true })
    try {
      expect(probe.prepare("SELECT value FROM legacy_probe").get()).toBeUndefined()
    } finally {
      probe.close()
    }
    return client
  } catch (error) {
    client.close()
    throw error
  }
}

test("startup backup preserves committed legacy WAL before schema bootstrap", async () => {
  const writer = await seedLegacyWal()
  try {
    await Promise.all([ensureSchema(), ensureSchema(), ensureSchema()])
    const backupDir = join(directory, "backups")
    const names = await readdir(backupDir)
    expect(names).toHaveLength(1)
    expect(names[0]).toMatch(/^meitheal-.*\.db$/)
    const snapshot = new DatabaseSync(join(backupDir, names[0]!), { readOnly: true })
    try {
      expect(snapshot.prepare("PRAGMA integrity_check").get()?.integrity_check).toBe("ok")
      expect(snapshot.prepare("PRAGMA journal_mode").get()?.journal_mode).toBe("delete")
      expect(snapshot.prepare("SELECT value FROM legacy_probe").get()?.value).toBe("committed in WAL")
      expect(snapshot.prepare("SELECT name FROM sqlite_schema WHERE name = 'tasks'").get()).toBeUndefined()
    } finally {
      snapshot.close()
    }
  } finally {
    getPersistenceClient().close()
    writer.close()
  }
})

test("the migration command snapshots before writing the ledger and managed startup takes one backup", async () => {
  const writer = await seedLegacyWal()
  try {
    await execFileAsync(process.execPath, ["scripts/migrate.mjs"], { cwd: webRoot, timeout: 20_000 })
    const backupDir = join(directory, "backups")
    const names = await readdir(backupDir)
    expect(names).toHaveLength(1)
    const snapshot = new DatabaseSync(join(backupDir, names[0]!), { readOnly: true })
    try {
      expect(snapshot.prepare("SELECT value FROM legacy_probe").get()?.value).toBe("committed in WAL")
      expect(snapshot.prepare("SELECT name FROM sqlite_schema WHERE name = '__meitheal_migrations'").get()).toBeUndefined()
    } finally {
      snapshot.close()
    }
    await execFileAsync(process.execPath, ["scripts/migrate.mjs", "--check"], { cwd: webRoot, timeout: 20_000 })
    process.env.MEITHEAL_STARTUP_BACKUP_HANDLED = "1"
    await ensureSchema()
    const ledger = await getPersistenceClient().execute("SELECT name FROM __meitheal_migrations")
    expect(ledger.rows.length).toBeGreaterThan(0)
    expect(await readdir(backupDir)).toEqual(names)
  } finally {
    getPersistenceClient().close()
    writer.close()
  }
})

test("a fresh database gets no startup backup", async () => {
  try {
    await ensureSchema()
    expect(await readdir(directory)).not.toContain("backups")
    expect((await stat(dbPath)).size).toBeGreaterThan(0)
  } finally {
    getPersistenceClient().close()
  }
})

test("configuration returning to a superseded database can initialize again", async () => {
  const firstUrl = process.env.MEITHEAL_DB_URL!
  const first = ensureSchema()
  process.env.MEITHEAL_DB_URL = `file:${join(directory, "other.db")}`
  await expect(first).rejects.toThrow("database changed during startup")

  process.env.MEITHEAL_DB_URL = firstUrl
  await ensureSchema()
  expect(getPersistenceClient().closed).toBe(false)
})

test("concurrent configuration changes retain both pre-migration backups in the same directory", async () => {
  const secondPath = join(directory, "other.db")
  seedSchemaMarker(predecessorVersion).close()
  await copyFile(dbPath, secondPath)
  for (const [db, probe] of [[dbPath, "first"], [secondPath, "second"]] as const) {
    const source = new DatabaseSync(db)
    source.exec("CREATE TABLE identity_probe (id TEXT NOT NULL)")
    source.prepare("INSERT INTO identity_probe VALUES (?)").run(probe)
    source.close()
  }

  const first = ensureSchema()
  const firstRejected = expect(first).rejects.toThrow("database changed during startup")
  process.env.MEITHEAL_DB_URL = `file:${secondPath}`
  await ensureSchema()
  await firstRejected

  const backupDirectory = join(directory, "backups")
  const names = await readdir(backupDirectory)
  expect(names).toHaveLength(2)
  const identities = new Set()
  for (const name of names) {
    const backup = new DatabaseSync(join(backupDirectory, name), { readOnly: true })
    try {
      expect(backup.prepare("SELECT value FROM app_settings WHERE key = 'schema_version'").get()?.value).toBe(predecessorVersion)
      identities.add(backup.prepare("SELECT id FROM identity_probe").get()?.id)
    } finally {
      backup.close()
    }
  }
  expect(identities).toEqual(new Set(["first", "second"]))
})

test("migration check leaves missing storage and an untracked legacy database alone", async () => {
  const missing = join(directory, "missing", "meitheal.db")
  await expect(execFileAsync(process.execPath, ["scripts/migrate.mjs", "--check"], {
    cwd: webRoot, env: { ...process.env, MEITHEAL_DB_URL: `file:${missing}` }, timeout: 20_000,
  })).rejects.toThrow(/Database does not exist/)
  expect(await readdir(directory)).toEqual([])

  seedSchemaMarker(predecessorVersion).close()
  const before = await readFile(dbPath)
  await expect(migrate("--check")).rejects.toThrow(/Pending migrations:/)
  expect(await readFile(dbPath)).toEqual(before)
  expect(await readdir(directory)).toEqual(["meitheal.db"])
  await migrate()
  const migrated = await readFile(dbPath)
  await expect(migrate("--check")).resolves.toMatchObject({ stdout: expect.stringContaining("Migration check passed") })
  expect(await readFile(dbPath)).toEqual(migrated)

  const writer = new DatabaseSync(dbPath)
  writer.exec("PRAGMA journal_mode=WAL")
  writer.close()
  const closedWalDatabase = await readFile(dbPath)
  const backups = await readdir(join(directory, "backups"))
  await expect(migrate("--check")).resolves.toMatchObject({ stdout: expect.stringContaining("Migration check passed") })
  expect(await readFile(dbPath)).toEqual(closedWalDatabase)
  expect(await readdir(join(directory, "backups"))).toEqual(backups)
})

for (const { marker, message } of [
  { marker: futureVersion, message: /requires a newer App/ },
  { marker: "invalid-marker", message: /invalid schema version marker/ },
]) {
  test(`CLI and runtime refuse ${marker === futureVersion ? "a newer" : "an invalid"} schema committed in WAL`, async () => {
    const writer = seedSchemaMarker(marker, true)
    try {
      const backupDir = join(directory, "backups")
      await mkdir(backupDir)
      const saved = join(backupDir, "meitheal-prior.db")
      await writeFile(saved, "existing backup fixture")
      const mainBefore = await readFile(dbPath)
      const walBefore = await readFile(`${dbPath}-wal`)
      expect(walBefore.byteLength).toBeGreaterThan(32)
      await copyFile(dbPath, join(directory, "main-only.db"))
      const mainOnly = new DatabaseSync(join(directory, "main-only.db"), { readOnly: true })
      try {
        expect(mainOnly.prepare("SELECT value FROM app_settings").get()?.value).toBe(predecessorVersion)
      } finally { mainOnly.close() }

      await expect(migrate()).rejects.toThrow(message)
      await expect(migrate("--check")).rejects.toThrow(message)
      expect(() => getPersistenceClient()).toThrow(/startup has not completed/)
      await expect(ensureSchema()).rejects.toThrow(message)
      expect(await readFile(dbPath)).toEqual(mainBefore)
      expect(await readFile(`${dbPath}-wal`)).toEqual(walBefore)
      expect(await readdir(backupDir)).toEqual(["meitheal-prior.db"])
      expect(await readFile(saved, "utf8")).toBe("existing backup fixture")
      expect(writer.prepare("SELECT name FROM sqlite_schema WHERE name='__meitheal_migrations'").get()).toBeUndefined()
    } finally { writer.close() }
  })
}

test("startup recognizes an imported settings table with SQLite's identifier casing", async () => {
  const database = new DatabaseSync(dbPath)
  database.exec("CREATE TABLE APP_SETTINGS (KEY TEXT PRIMARY KEY, VALUE TEXT NOT NULL)")
  database.prepare("INSERT INTO APP_SETTINGS VALUES ('schema_version', ?)").run(futureVersion)
  database.close()
  const before = await readFile(dbPath)
  await expect(migrate()).rejects.toThrow(/requires a newer App/)
  await expect(migrate("--check")).rejects.toThrow(/requires a newer App/)
  await expect(ensureSchema()).rejects.toThrow(/requires a newer App/)
  expect(await readFile(dbPath)).toEqual(before)
  expect(await readdir(directory)).toEqual(["meitheal.db"])
})

test("writable startup can recover an interrupted SQLite transaction before checking its committed schema", async () => {
  await execFileAsync(process.execPath, ["--input-type=module", "--eval", `
    import { DatabaseSync } from "node:sqlite"
    const db = new DatabaseSync(process.argv[1])
    db.exec(\`CREATE TABLE app_settings(key TEXT PRIMARY KEY,value TEXT,updated_at INTEGER);
      INSERT INTO app_settings VALUES('schema_version','${predecessorVersion}',1);
      CREATE TABLE spill(value TEXT);
      PRAGMA cache_size=1; PRAGMA cache_spill=ON;
      BEGIN IMMEDIATE; UPDATE app_settings SET value='${futureVersion}';
      WITH RECURSIVE rows(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM rows WHERE n<100)
      INSERT INTO spill SELECT printf('%04000d',n) FROM rows;\`)
    process.exit(0)
  `, dbPath], { timeout: 10_000 })
  expect((await stat(`${dbPath}-journal`)).size).toBeGreaterThan(512)
  await expect(migrate("--check")).rejects.toThrow(/readonly|read-only/i)
  expect((await stat(`${dbPath}-journal`)).size).toBeGreaterThan(512)
  await ensureSchema()
  const database = getPersistenceClient()
  try {
    expect((await database.execute("SELECT value FROM app_settings")).rows[0]?.value).toBe(String(DATABASE_SCHEMA_VERSION))
    expect((await database.execute("SELECT COUNT(*) AS count FROM spill")).rows[0]?.count).toBe(0)
  } finally { database.close() }
})

for (const lock of ["reader", "writer"]) {
  test(`concurrent CLI and runtime starters publish once after a rollback-journal ${lock} releases`, async () => {
    await seedBoardPredecessor()
    const held = new DatabaseSync(dbPath)
    held.exec(lock === "writer" ? "BEGIN IMMEDIATE" : "BEGIN")
    held.prepare("SELECT value FROM app_settings").get()
    const cli = migrate()
    const runtime = ensureSchema()
    try {
      await setTimeout(200)
      expect(held.prepare("SELECT value FROM app_settings WHERE key = 'schema_version'").get()?.value).toBe("18")
      expect(() => getPersistenceClient()).toThrow(/startup has not completed/)
    } finally {
      held.exec("ROLLBACK")
      held.close()
    }
    await Promise.all([cli, runtime])
    const client = getPersistenceClient()
    expect((await client.execute("SELECT value FROM app_settings WHERE key = 'schema_version'")).rows).toEqual([{ value: String(DATABASE_SCHEMA_VERSION) }])
    const ledger = await client.execute("SELECT name, applied_at FROM __meitheal_migrations ORDER BY name")
    expect(ledger.rows).toHaveLength(predecessorMigrationNames.length + 3)
    expect(ledger.rows.slice(-3).map(row => row.name)).toEqual([TASK_BOARD_MIGRATION, PERSONAL_PILLAR_MIGRATION, BOARD_ACCESS_MIGRATION])
    expect(ledger.rows.slice(0, -3).every(row => row.applied_at === 1)).toBe(true)
    expect((await client.execute("SELECT title FROM tasks")).rows).toEqual([{ title: "Retained startup task" }])
    await expect(migrate("--check")).resolves.toMatchObject({ stdout: expect.stringContaining("Migration check passed") })
  })
}

test("upgraded startup restores missing Household lanes and preserves custom ordering", async () => {
  await migrate()
  const db = new DatabaseSync(dbPath)
  try {
    db.exec("DELETE FROM kanban_lanes")
    await migrate()
    expect(db.prepare("SELECT key, board_id FROM kanban_lanes ORDER BY position").all())
      .toEqual(["backlog", "pending", "active", "complete"].map(key => ({ key, board_id: "household" })))

    db.exec(`DELETE FROM kanban_lanes WHERE key = 'backlog';
      UPDATE kanban_lanes SET position = 20, label = 'Keep my lane label' WHERE key = 'active';`)
    await ensureSchema()
    expect(db.prepare("SELECT key, label, position FROM kanban_lanes WHERE key IN ('backlog', 'active') ORDER BY position").all())
      .toEqual([{ key: "backlog", label: "Backlog", position: 0 }, { key: "active", label: "Keep my lane label", position: 21 }])
    expect(db.prepare("SELECT count(*) AS count FROM __meitheal_migrations WHERE name = '0009_task_boards.mjs'").get()?.count).toBe(1)
  } finally {
    db.close()
  }
})

test("a held writer past the startup deadline leaves the predecessor ready for explicit retry", async () => {
  await seedBoardPredecessor()
  const held = new DatabaseSync(dbPath)
  held.exec("BEGIN IMMEDIATE")
  try {
    await expect(ensureSchema()).rejects.toMatchObject({ code: "SQLITE_BUSY" })
    expect(held.prepare("SELECT value FROM app_settings WHERE key = 'schema_version'").get()?.value).toBe("18")
    expect(held.prepare("SELECT name FROM sqlite_schema WHERE name = 'task_boards'").get()).toBeUndefined()
  } finally {
    held.exec("ROLLBACK")
    held.close()
  }
  await ensureSchema()
  await expect(migrate("--check")).resolves.toMatchObject({ stdout: expect.stringContaining("Migration check passed") })
})

async function withBuiltApp(run: (origin: string) => Promise<void>, supervisorToken?: string) {
  const fixture = fileURLToPath(new URL("../scripts/feedback-ingress-fixture.mjs", import.meta.url))
  const child = fork(fixture, {
    cwd: webRoot,
    env: { PATH: process.env.PATH, NODE_ENV: "production", MEITHEAL_DB_URL: `file:${dbPath}`, SUPERVISOR_TOKEN: supervisorToken },
    stdio: ["ignore", "ignore", "inherit", "ipc"],
  })
  try {
    const [{ port }] = await once(child, "message", { signal: AbortSignal.timeout(10_000) })
    await run(`http://127.0.0.1:${port}`)
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit", { signal: AbortSignal.timeout(5_000) })
      child.kill()
      await exited
    }
  }
}

test("the built runtime refuses a first agent request before touching incompatible storage", async () => {
  test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires the built Astro runtime")
  seedSchemaMarker(futureVersion).close()
  const before = await readFile(dbPath)
  await withBuiltApp(async origin => {
    const untrusted = await fetch(`${origin}/api/tasks`, { signal: AbortSignal.timeout(5_000) })
    expect(untrusted.status).toBe(401)
    await untrusted.body?.cancel()
    const malformed = await fetch(`${origin}/api/tasks`, {
      headers: { authorization: "Bearer mth_invalid" }, signal: AbortSignal.timeout(5_000),
    })
    expect(malformed.status).toBe(401)
    await malformed.body?.cancel()
    const request = await fetch(`${origin}/api/tasks`, {
      headers: { authorization: `Bearer mth_${"a".repeat(64)}` }, signal: AbortSignal.timeout(5_000),
    })
    expect(request.status).toBe(503)
    expect(request.headers.get("cache-control")).toBe("private, no-store")
    await request.body?.cancel()
    const health = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(5_000) })
    expect(health.status).toBe(503)
    expect(health.headers.get("x-request-id")).toBeTruthy()
    expect(health.headers.get("x-content-type-options")).toBe("nosniff")
    expect(await health.json()).toMatchObject({ db_status: "error", error: expect.stringMatching(/requires a newer App/) })
    expect(await readFile(dbPath)).toEqual(before)
    expect(await readdir(directory)).toEqual(["meitheal.db"])
  }, "synthetic-schema-fixture")
})

test("a first authenticated request adopts a runtime-first predecessor and waits for the full upgrade", async () => {
  test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires the built Astro runtime")
  await seedBoardPredecessor({ token: true, ledger: false })
  await withBuiltApp(async origin => {
    const tasks = await fetch(`${origin}/api/tasks`, {
      headers: { authorization: `Bearer ${fixtureToken}` }, signal: AbortSignal.timeout(8_000),
    })
    expect(tasks.status).toBe(200)
    expect(await tasks.text()).toContain("Retained startup task")
    const health = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(5_000) })
    expect(health.status).toBe(200)
    expect(await health.json()).toMatchObject({ schema_version: DATABASE_SCHEMA_VERSION })
    await expect(migrate("--check")).resolves.toMatchObject({ stdout: expect.stringContaining("Migration check passed") })
  }, "synthetic-schema-fixture")
})

for (const token of [false, true]) {
  test(`an unsupported v18 lane shape leaves ${token ? "agent last-use time" : "the absent agent token table"} intact`, async () => {
    test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires the built Astro runtime")
    await seedBoardPredecessor({ token, unsupported: true })
    const before = await readFile(dbPath)
    await withBuiltApp(async origin => {
      const tasks = await fetch(`${origin}/api/tasks`, {
        headers: { authorization: `Bearer ${fixtureToken}` }, signal: AbortSignal.timeout(8_000),
      })
      expect(tasks.status).toBe(503)
      await tasks.body?.cancel()
      expect(await readFile(dbPath)).toEqual(before)
      const probe = new DatabaseSync(dbPath, { readOnly: true })
      try {
        if (token) expect(probe.prepare("SELECT last_used_at FROM agent_tokens").get()?.last_used_at).toBeNull()
        else expect(probe.prepare("SELECT name FROM sqlite_schema WHERE name = 'agent_tokens'").get()).toBeUndefined()
      } finally {
        probe.close()
      }
    }, "synthetic-schema-fixture")
  })
}

test("the packaged wrapper refuses an invalid predecessor before listening", async () => {
  test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires the built Astro runtime")
  await seedBoardPredecessor({ unsupported: true })
  const before = await readFile(dbPath)
  await expect(execFileAsync(process.execPath, ["scripts/serve.mjs"], {
    cwd: webRoot, env: { ...process.env, HOST: "127.0.0.1", PORT: "0" }, timeout: 10_000,
  })).rejects.toMatchObject({ code: 1, stderr: expect.stringMatching(/kanban_lanes/) })
  expect(await readFile(dbPath)).toEqual(before)
})

test("the built standalone runtime rejects a different origin before opening storage", async () => {
  test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires the built Astro runtime")
  await withBuiltApp(async origin => {
    const create = (source: string) => fetch(`${origin}/api/tasks`, {
      method: "POST", headers: { origin: source, "content-type": "application/json" },
      body: JSON.stringify({ title: "Startup schema fixture" }), signal: AbortSignal.timeout(5_000),
    })
    const refused = await create("https://other.invalid")
    expect(refused.status).toBe(403)
    expect(await refused.json()).toEqual({ error: "CSRF origin mismatch" })
    expect(await readdir(directory)).toEqual([])

    seedSchemaMarker(futureVersion).close()
    const before = await readFile(dbPath)
    const sameOrigin = await create(origin)
    expect(sameOrigin.status).toBe(503)
    await sameOrigin.body?.cancel()
    expect(await readFile(dbPath)).toEqual(before)
    expect(await readdir(directory)).toEqual(["meitheal.db"])
  })
})

test("startup retains five named snapshots and leaves other files alone", async () => {
  const writer = await seedLegacyWal()
  try {
    const backupDir = join(directory, "backups")
    await mkdir(backupDir)
    await writeFile(join(backupDir, "manual.db"), "external backup")
    for (const day of [1, 2, 3, 4, 5, 6]) {
      const backup = join(backupDir, `meitheal-2025-01-0${day}.db`)
      await writeFile(backup, "previous backup")
      const time = new Date(Date.UTC(2025, 0, day))
      await utimes(backup, time, time)
    }

    await ensureSchema()
    const names = await readdir(backupDir)
    expect(names).toHaveLength(6)
    expect(names).toContain("manual.db")
    expect(names).not.toContain("meitheal-2025-01-01.db")
    expect(names).not.toContain("meitheal-2025-01-02.db")
    expect(names).not.toContainEqual(expect.stringMatching(/^\./))
  } finally {
    getPersistenceClient().close()
    writer.close()
  }
})

test("failure to create the backup directory leaves the data available", async () => {
  const writer = await seedLegacyWal()
  try {
    const blockedDirectory = join(directory, "backups")
    await writeFile(blockedDirectory, "keep this file")
    await ensureSchema()
    const rows = await getPersistenceClient().execute("SELECT value FROM legacy_probe")
    expect(rows.rows[0]?.value).toBe("committed in WAL")
    expect(await readFile(blockedDirectory, "utf8")).toBe("keep this file")
  } finally {
    getPersistenceClient().close()
    writer.close()
  }
})

test("Household task reads and cleanup exclude a named Board even by exact ID", async () => {
  await ensureSchema()
  const db = getPersistenceClient()
  const repo = new TaskRepository(db)
  await db.execute(`INSERT INTO tasks (id, title, idempotency_key, request_id, ticket_number, created_at, updated_at)
    SELECT 'household-task', 'Household fixture', 'household-fixture', 'fixture', ticket_high_water + 1, 1, 1
    FROM task_boards WHERE id = 'household'`)
  // A hypothetical successor removes these guards. Keep this storage disposable.
  await db.execute("DROP TRIGGER task_boards_household_v19_insert")
  await db.execute("DROP TRIGGER tasks_household_v19_insert")
  await db.execute(`INSERT INTO task_boards (id, name, visibility, ticket_prefix, created_at, updated_at)
    VALUES ('work-fixture', 'Work fixture', 'restricted', 'WFX', 1, 1)`)
  await db.execute(`INSERT INTO tasks (id, title, task_board_id, area_id, status, idempotency_key, request_id, created_at, updated_at)
    VALUES ('private-task', 'Private fixture', 'work-fixture', '__meitheal_no_area__', 'complete', 'private-fixture', 'fixture', 1, 1)`)

  const listing = await repo.findAll({ limit: 1 })
  expect(listing.total).toBe(1)
  expect(listing.tasks.map(task => task.id)).toEqual(["household-task"])
  expect(await repo.resolveTaskId("private-task")).toBeNull()
  expect(await repo.findById("private-task")).toBeNull()
  expect((await repo.exportAll()).map(task => task.id)).toEqual(["household-task"])
  expect((await repo.getStatusCounts()).total).toBe(1)
  expect(await repo.countCompletedBefore(2)).toBe(0)
  await repo.deleteTask("private-task")
  expect((await db.execute("SELECT id FROM tasks WHERE id = 'private-task'")).rows).toHaveLength(1)

  await db.batch([
    "INSERT INTO areas (id, name, owner_board_id, created_at, updated_at) VALUES ('work-area', 'Work area', 'work-fixture', 1, 1)",
    "INSERT INTO goals (id, area_id, title, owner_board_id, created_at, updated_at) VALUES ('work-goal', 'work-area', 'Work goal', 'work-fixture', 1, 1)",
    "INSERT INTO projects (id, goal_id, area_id, title, owner_board_id, created_at, updated_at) VALUES ('work-project', 'work-goal', 'work-area', 'Work project', 'work-fixture', 1, 1)",
    "INSERT INTO pillars (id, name, slug, owner_board_id, created_at, updated_at) VALUES ('work-pillar', 'Work pillar', '~work-pillar', 'work-fixture', 1, 1)",
  ], "write")
  const hierarchy = new HierarchyRepository(db)
  expect(await hierarchy.findAreaById("work-area")).toBeNull()
  expect(await hierarchy.findProjectById("work-project")).toBeNull()
  expect(await hierarchy.findAllGoals({ area_id: "work-area" })).toEqual([])
  expect(await hierarchy.findAllGoals({ project_id: "work-project" })).toEqual([])
  expect(await hierarchy.deleteProject("work-project")).toBe(false)
  expect(await getPillarById("work-pillar")).toBeNull()
  expect((await getPillars()).map(pillar => pillar.id)).not.toContain("work-pillar")

  const revision = "99999999-9999-4999-8999-999999999999"
  await db.batch([
    { sql: "INSERT INTO board_access_epoch (singleton, revision) VALUES (1, ?)", args: [revision] },
    "INSERT INTO board_goal_shares VALUES ('work-goal', 'default', 'household')",
    "INSERT INTO projects (id, goal_id, area_id, title, status, created_at, updated_at) VALUES ('home-project', 'work-goal', 'default', 'Home project', 'completed', 1, 1)",
    "INSERT INTO board_access_grants (board_id, principal_type, principal_id, role) VALUES ('work-fixture', 'ha_user', 'work-user', 'member')",
  ], "write")
  const home = await readSharedGoalsForArea(db, "home-user", "default", revision)
  expect(home).toEqual([{ id: "work-goal", title: "Work goal", area_id: "default", project_count: 1, completed_project_count: 1 }])
  await db.execute("UPDATE projects SET title = 'Private changes', status = 'completed' WHERE id = 'work-project'")
  expect(await readSharedGoalsForArea(db, "home-user", "default", revision)).toEqual(home)
  expect(await readSharedGoalsForArea(db, "work-user", "default", revision)).toMatchObject([
    { id: "work-goal", project_count: 2, completed_project_count: 2 },
  ])
  expect(await readSharedGoalsForArea(db, "home-user", "default", crypto.randomUUID())).toEqual([])
  await db.execute("DELETE FROM board_access_grants WHERE principal_id = 'work-user'")
  expect(await readSharedGoalsForArea(db, "work-user", "default", revision)).toEqual(home)
  await db.execute("UPDATE areas SET owner_board_id = 'work-fixture' WHERE id = 'default'")
  expect(await readSharedGoalsForArea(db, "home-user", "default", revision)).toEqual([])
})
