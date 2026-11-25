import { currentBoardScope, fixturePrincipal } from "../helpers/current-board-scope"
import { NamedBoardRepository } from "../../apps/web/src/domains/tasks/persistence/named-board-repository"
import { prepareTaskCreation } from "../../apps/web/src/domains/tasks/task-creation-service"
import { changeGoalShare } from "../../apps/web/src/domains/tasks/persistence/shared-goal-repository"
import type { BoardScope } from "../../apps/web/src/domains/tasks/board-scope"
import {
  openDatabaseForStartup,
  withStartupWriteTransaction
} from "../../apps/web/scripts/database-client.mjs"
import { applyStartupTaskSchema } from "../../apps/web/scripts/task-schema-startup.mjs"
import {
  initializeBoardGrantContinuity,
  finalizeStartupBoardGrant
} from "../../apps/web/scripts/board-grant-journal.mjs"
import { ORDINARY_BOARD_MIGRATION } from "../../apps/web/drizzle/migrations/0016_ordinary_boards.mjs"
import { CUSTOM_BOARD_KEYS_MIGRATION } from "../../apps/web/drizzle/migrations/0017_custom_board_keys.mjs"
import { enrollCurrentOwnedLegacyFixture } from "../helpers/current-legacy-fixture"
import { BOARD_LIFECYCLE_MIGRATION } from "../../apps/web/drizzle/migrations/0015_board_lifecycle.mjs"
import { execFile, fork } from "../helpers/isolated-process"
import { createHash } from "node:crypto"
import { once } from "node:events"
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  utimes,
  writeFile
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { setTimeout } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { expect, test } from "@playwright/test"
import { PERSONAL_PILLAR_MIGRATION } from "../../apps/web/drizzle/migrations/0010_personal_pillars.mjs"
import { BOARD_ACCESS_MIGRATION } from "../../apps/web/drizzle/migrations/0011_board_access.mjs"
import { ORGANIZATION_LABEL_MIGRATION } from "../../apps/web/drizzle/migrations/0012_organization_labels.mjs"
import { ORGANIZATION_ACCESS_MIGRATION } from "../../apps/web/drizzle/migrations/0013_organization_access.mjs"
import { ORGANIZATION_FEATURE_MIGRATION } from "../../apps/web/drizzle/migrations/0014_organization_features.mjs"
import {
  TASK_BOARD_MIGRATION,
  TASK_BOARD_SCHEMA_VERSION
} from "../../apps/web/drizzle/migrations/task-board-upgrade.mjs"
import { DATABASE_SCHEMA_VERSION, openDatabase } from "../../apps/web/scripts/database-client.mjs"
import {
  cancelSession,
  ensurePomodoroSchema,
  getSessionHistory,
  getTimerState,
  getTodayStats,
  resetPomodoroForTests,
  skipToBreak,
  startFocus
} from "../../apps/web/src/domains/pomodoro/index"
import {
  currentBoardGrantRevision,
  readBoardGrantRevision
} from "../../apps/web/src/domains/tasks/persistence/board-grant-fence"
import { HierarchyRepository } from "../../apps/web/src/domains/tasks/persistence/hierarchy-repository"
import {
  createPillar,
  getPillarById,
  getPillars
} from "../../apps/web/src/domains/pillars/pillar-service"
import { readSharedGoals } from "../../apps/web/src/domains/tasks/persistence/shared-goal-repository"
import { searchMeithealCatalog } from "../../apps/web/src/domains/search/search-service"
import { TaskInactivityRepository } from "../../apps/web/src/domains/tasks/persistence/task-inactivity-repository"
import { TaskRepository } from "../../apps/web/src/domains/tasks/persistence/task-repository"
import {
  ensureSchema,
  getPersistenceClient,
  resetPersistenceForTests
} from "../helpers/persistence-fixture"
import {
  prepareTaskBoardPredecessor,
  predecessorMigrationNames
} from "../scripts/task-board-predecessor"

const execFileAsync = promisify(execFile)
const webRoot = fileURLToPath(new URL("../../apps/web", import.meta.url))
let custodyDirectories: string[] = []
let directory: string
let dbPath: string
const previousDbUrl = process.env.MEITHEAL_DB_URL
const previousBackupHandled = process.env.MEITHEAL_STARTUP_BACKUP_HANDLED
const predecessorVersion = String(TASK_BOARD_SCHEMA_VERSION - 1)
const futureVersion = String(DATABASE_SCHEMA_VERSION + 1)

function migrate(...args: string[]) {
  return execFileAsync(process.execPath, ["scripts/migrate.mjs", ...args], {
    cwd: webRoot,
    timeout: 20_000
  })
}

function seedSchemaMarker(value: string, inWal = false) {
  const database = new DatabaseSync(dbPath)
  database.exec(
    "CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)"
  )
  database
    .prepare("INSERT INTO app_settings VALUES ('schema_version', ?, 1)")
    .run(predecessorVersion)
  if (inWal)
    database.exec(
      "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; PRAGMA wal_checkpoint(TRUNCATE)"
    )
  database.prepare("UPDATE app_settings SET value=? WHERE key='schema_version'").run(value)
  return database
}

const fixtureToken = `mth_${"b".repeat(64)}`
const assignedOnlyFixtureToken = `mth_${"c".repeat(64)}`

async function seedBoardPredecessor({ token = false, assignedOnly = false, unsupported = false, ledger = true } = {}) {
  const client = await openDatabaseForStartup(`file:${dbPath}`, {
    markerPath: dbPath + ".board-grants.json"
  })
  try {
    await prepareTaskBoardPredecessor(client)
    await client.batch(
      [
        "INSERT INTO app_settings VALUES ('schema_version', '18', 1)",
        "INSERT INTO tasks (id, title, request_id, idempotency_key, created_at, updated_at) VALUES ('original', 'Retained startup task', 'original', 'original', 1, 1)",
        ...(ledger ? [] : ["DROP TABLE __meitheal_migrations"]),
        ...(unsupported ? ["CREATE INDEX fixture_unsupported_lane ON kanban_lanes(label)"] : [])
      ],
      "write"
    )
    if (token) {
      await client.batch(
        [
          `CREATE TABLE agent_tokens (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, token_prefix TEXT NOT NULL,
          scopes TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, expires_at TEXT, last_used_at TEXT,
          revoked INTEGER NOT NULL DEFAULT 0
        )`,
          {
            sql: "INSERT INTO agent_tokens (id, name, token_hash, token_prefix, scopes, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            args: [
              "fixture-agent",
              "Fixture agent",
              createHash("sha256").update(fixtureToken).digest("hex"),
              "mth_bbbb",
              '["tasks:read"]',
              "2026-01-01T00:00:00.000Z"
            ]
          }
        ],
        "write"
      )
    }
    if (assignedOnly) {
      await client.execute({
        sql: `INSERT INTO agent_tokens (id, name, token_hash, token_prefix, scopes, created_at)
          VALUES ('fixture-assigned', 'Imported assigned-only token', ?, 'mth_cccc', '["tasks:write:assigned"]', '2026-01-01T00:00:00.000Z')`,
        args: [createHash("sha256").update(assignedOnlyFixtureToken).digest("hex")],
      })
    }
    if (!unsupported) {
      let revision: string | null = null
      await withStartupWriteTransaction(client, async (tx) => {
        await applyStartupTaskSchema(tx)
        revision = await initializeBoardGrantContinuity(client, tx)
      })
      if (!revision) throw new Error("Independent current25 fixture authority required")
      await finalizeStartupBoardGrant(client, revision)
    }
  } finally {
    client.close()
  }
}

async function admitOwnedColdFixture() {
  resetPersistenceForTests()
  const proof = await enrollCurrentOwnedLegacyFixture({
    database: dbPath,
    markerPath: dbPath + ".board-grants.json",
    provenance: "created-in-this-test-and-never-restored"
  })
  custodyDirectories.push(proof.custodyDirectory)
}

test.beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "meitheal-startup-backup-"))
  dbPath = join(directory, "meitheal.db")
  custodyDirectories = []
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
  await Promise.all(custodyDirectories.map((path) => rm(path, { recursive: true, force: true })))
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
      expect(snapshot.prepare("SELECT value FROM legacy_probe").get()?.value).toBe(
        "committed in WAL"
      )
      expect(
        snapshot.prepare("SELECT name FROM sqlite_schema WHERE name = 'tasks'").get()
      ).toBeUndefined()
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
    await execFileAsync(process.execPath, ["scripts/migrate.mjs"], {
      cwd: webRoot,
      timeout: 20_000
    })
    const backupDir = join(directory, "backups")
    const names = await readdir(backupDir)
    expect(names).toHaveLength(1)
    const snapshot = new DatabaseSync(join(backupDir, names[0]!), { readOnly: true })
    try {
      expect(snapshot.prepare("SELECT value FROM legacy_probe").get()?.value).toBe(
        "committed in WAL"
      )
      expect(
        snapshot
          .prepare("SELECT name FROM sqlite_schema WHERE name = '__meitheal_migrations'")
          .get()
      ).toBeUndefined()
    } finally {
      snapshot.close()
    }
    writer.close()
    await admitOwnedColdFixture()
    await execFileAsync(process.execPath, ["scripts/migrate.mjs", "--check"], {
      cwd: webRoot,
      timeout: 20_000
    })
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
  for (const [db, probe] of [
    [dbPath, "first"],
    [secondPath, "second"]
  ] as const) {
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
      expect(
        backup.prepare("SELECT value FROM app_settings WHERE key = 'schema_version'").get()?.value
      ).toBe(predecessorVersion)
      identities.add(backup.prepare("SELECT id FROM identity_probe").get()?.id)
    } finally {
      backup.close()
    }
  }
  expect(identities).toEqual(new Set(["first", "second"]))
})

test("migration check leaves missing storage and an untracked legacy database alone", async () => {
  const missing = join(directory, "missing", "meitheal.db")
  await expect(
    execFileAsync(process.execPath, ["scripts/migrate.mjs", "--check"], {
      cwd: webRoot,
      env: { ...process.env, MEITHEAL_DB_URL: `file:${missing}` },
      timeout: 20_000
    })
  ).rejects.toThrow(/Database does not exist/)
  expect(await readdir(directory)).toEqual([])

  seedSchemaMarker(predecessorVersion).close()
  const before = await readFile(dbPath)
  await expect(migrate("--check")).rejects.toThrow(/Pending migrations:/)
  expect(await readFile(dbPath)).toEqual(before)
  expect(await readdir(directory)).toEqual(["meitheal.db"])
  await migrate()
  await expect(migrate("--check")).rejects.toThrow(/Pending migrations:.*0016/)
  await admitOwnedColdFixture()
  const migrated = await readFile(dbPath)
  await expect(migrate("--check")).resolves.toMatchObject({
    stdout: expect.stringContaining("Migration check passed")
  })
  expect(await readFile(dbPath)).toEqual(migrated)

  const writer = new DatabaseSync(dbPath)
  writer.exec("PRAGMA journal_mode=WAL")
  writer.close()
  const closedWalDatabase = await readFile(dbPath)
  const backups = await readdir(join(directory, "backups"))
  await expect(migrate("--check")).resolves.toMatchObject({
    stdout: expect.stringContaining("Migration check passed")
  })
  expect(await readFile(dbPath)).toEqual(closedWalDatabase)
  expect(await readdir(join(directory, "backups"))).toEqual(backups)
})

for (const { marker, message } of [
  { marker: futureVersion, message: /requires a newer App/ },
  { marker: "invalid-marker", message: /invalid schema version marker/ }
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
        expect(mainOnly.prepare("SELECT value FROM app_settings").get()?.value).toBe(
          predecessorVersion
        )
      } finally {
        mainOnly.close()
      }

      await expect(migrate()).rejects.toThrow(message)
      await expect(migrate("--check")).rejects.toThrow(message)
      expect(() => getPersistenceClient()).toThrow(/startup has not completed/)
      await expect(ensureSchema()).rejects.toThrow(message)
      expect(await readFile(dbPath)).toEqual(mainBefore)
      expect(await readFile(`${dbPath}-wal`)).toEqual(walBefore)
      expect(await readdir(backupDir)).toEqual(["meitheal-prior.db"])
      expect(await readFile(saved, "utf8")).toBe("existing backup fixture")
      expect(
        writer.prepare("SELECT name FROM sqlite_schema WHERE name='__meitheal_migrations'").get()
      ).toBeUndefined()
    } finally {
      writer.close()
    }
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
  const crashed = await execFileAsync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `
    import { DatabaseSync } from "node:sqlite"
    const db = new DatabaseSync(process.argv[1])
    db.exec(\`CREATE TABLE app_settings(key TEXT PRIMARY KEY,value TEXT,updated_at INTEGER);
      INSERT INTO app_settings VALUES('schema_version','${predecessorVersion}',1);
      CREATE TABLE spill(value TEXT);
      PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;
      PRAGMA cache_size=1; PRAGMA cache_spill=ON;
      BEGIN IMMEDIATE; UPDATE app_settings SET value='${futureVersion}';
      WITH RECURSIVE rows(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM rows WHERE n<100)
      INSERT INTO spill SELECT printf('%04000d',n) FROM rows;\`)
    process.kill(process.pid, "SIGKILL")
  `,
      dbPath
    ],
    { timeout: 10_000 }
  ).then(
    () => null,
    (error) => error
  )
  expect(crashed).toMatchObject({ signal: "SIGKILL" })
  expect((await stat(`${dbPath}-journal`)).size).toBeGreaterThan(512)
  await expect(migrate("--check")).rejects.toThrow(/readonly|read-only/i)
  expect((await stat(`${dbPath}-journal`)).size).toBeGreaterThan(512)
  await ensureSchema()
  const database = getPersistenceClient()
  try {
    expect(
      (await database.execute("SELECT value FROM app_settings WHERE key='schema_version'")).rows[0]
        ?.value
    ).toBe("25")
    expect(await currentBoardGrantRevision(database, dbPath + ".board-grants.json")).toBeNull()
    expect((await database.execute("SELECT COUNT(*) AS count FROM spill")).rows[0]?.count).toBe(0)
  } finally {
    database.close()
  }
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
      expect(
        held.prepare("SELECT value FROM app_settings WHERE key = 'schema_version'").get()?.value
      ).toBe("25")
      expect(() => getPersistenceClient()).toThrow(/startup has not completed/)
    } finally {
      held.exec("ROLLBACK")
      held.close()
    }
    await Promise.all([cli, runtime])
    const client = getPersistenceClient()
    expect(
      (await client.execute("SELECT value FROM app_settings WHERE key = 'schema_version'")).rows
    ).toEqual([{ value: String(DATABASE_SCHEMA_VERSION) }])
    const ledger = await client.execute(
      "SELECT name, applied_at FROM __meitheal_migrations ORDER BY name"
    )
    expect(ledger.rows).toHaveLength(predecessorMigrationNames.length + 9)
    expect(ledger.rows.slice(-9).map((row) => row.name)).toEqual([
      TASK_BOARD_MIGRATION,
      PERSONAL_PILLAR_MIGRATION,
      BOARD_ACCESS_MIGRATION,
      ORGANIZATION_LABEL_MIGRATION,
      ORGANIZATION_ACCESS_MIGRATION,
      ORGANIZATION_FEATURE_MIGRATION,
      BOARD_LIFECYCLE_MIGRATION,
      ORDINARY_BOARD_MIGRATION,
      CUSTOM_BOARD_KEYS_MIGRATION
    ])
    expect(ledger.rows.slice(0, -9).every((row) => row.applied_at === 1)).toBe(true)
    expect((await client.execute("SELECT title FROM tasks")).rows).toEqual([
      { title: "Retained startup task" }
    ])
    await expect(migrate("--check")).resolves.toMatchObject({
      stdout: expect.stringContaining("Migration check passed")
    })
  })
}

test("startup verifies a committed Board grant after a competing rollback-journal writer releases", async () => {
  await seedBoardPredecessor()
  await migrate()
  const markerPath = dbPath + ".board-grants.json"
  const client = await openDatabaseForStartup(`file:${dbPath}`, { markerPath })
  const writer = new DatabaseSync(dbPath)
  let sawBusyRevision = false
  const execute = client.execute.bind(client)
  client.execute = async statement => {
    try {
      return await execute(statement)
    } catch (error) {
      if (String(statement).includes("SELECT revision FROM board_access_epoch") &&
        error instanceof Error && "code" in error && error.code === "SQLITE_BUSY") sawBusyRevision = true
      throw error
    }
  }

  const revision = await readBoardGrantRevision(markerPath)
  expect(revision).not.toBeNull()
  try {
    writer.exec("BEGIN EXCLUSIVE")
    const finalization = finalizeStartupBoardGrant(client, revision).then(() => undefined, (error: unknown) => error)
    try {
      await expect.poll(() => sawBusyRevision, { timeout: 1_000 }).toBe(true)
    } finally {
      writer.exec("ROLLBACK")
    }
    await expect(finalization).resolves.toBeUndefined()
    await writeFile(markerPath, JSON.stringify({ epoch: "00000000-0000-0000-0000-000000000000" }))
    await expect(finalizeStartupBoardGrant(client, revision))
      .rejects.toThrow(/continuity publication is pending/)
  } finally {
    writer.close()
    client.close()
  }
})

test("current startup preserves a deliberately empty or custom Board lane catalog", async () => {
  await migrate()
  const db = new DatabaseSync(dbPath)
  try {
    db.exec("DELETE FROM kanban_lanes")
    await migrate()
    expect(db.prepare("SELECT key FROM kanban_lanes").all()).toEqual([])
    db.exec(
      "INSERT INTO kanban_lanes(id,key,label,position,board_id,created_at,updated_at) VALUES('custom-pending','pending','Keep my lane label',20,'household',1,1)"
    )
    await ensureSchema()
    expect(db.prepare("SELECT key,label,position FROM kanban_lanes").all()).toEqual([
      { key: "pending", label: "Keep my lane label", position: 20 }
    ])
    expect(
      db
        .prepare(
          "SELECT count(*) AS count FROM __meitheal_migrations WHERE name='0009_task_boards.mjs'"
        )
        .get()?.count
    ).toBe(1)
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
    expect(
      held.prepare("SELECT value FROM app_settings WHERE key = 'schema_version'").get()?.value
    ).toBe("25")
    expect(
      held.prepare("SELECT name FROM sqlite_schema WHERE name = 'task_boards'").get()?.name
    ).toBe("task_boards")
  } finally {
    held.exec("ROLLBACK")
    held.close()
  }
  await ensureSchema()
  await expect(migrate("--check")).resolves.toMatchObject({
    stdout: expect.stringContaining("Migration check passed")
  })
})

async function withBuiltApp(run: (origin: string) => Promise<void>, supervisorToken?: string) {
  const fixture = fileURLToPath(new URL("../scripts/feedback-ingress-fixture.mjs", import.meta.url))
  const child = fork(fixture, {
    cwd: webRoot,
    env: {
      PATH: process.env.PATH,
      NODE_ENV: "production",
      MEITHEAL_DB_URL: `file:${dbPath}`,
      SUPERVISOR_TOKEN: supervisorToken
    },
    stdio: ["ignore", "ignore", "inherit", "ipc"]
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
  await withBuiltApp(async (origin) => {
    const untrusted = await fetch(`${origin}/api/tasks`, { signal: AbortSignal.timeout(5_000) })
    expect(untrusted.status).toBe(401)
    await untrusted.body?.cancel()
    const malformed = await fetch(`${origin}/api/tasks`, {
      headers: { authorization: "Bearer mth_invalid" },
      signal: AbortSignal.timeout(5_000)
    })
    expect(malformed.status).toBe(401)
    await malformed.body?.cancel()
    const request = await fetch(`${origin}/api/tasks`, {
      headers: { authorization: `Bearer mth_${"a".repeat(64)}` },
      signal: AbortSignal.timeout(5_000)
    })
    expect(request.status).toBe(503)
    expect(request.headers.get("cache-control")).toBe("private, no-store")
    await request.body?.cancel()
    const health = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(5_000) })
    expect(health.status).toBe(503)
    expect(health.headers.get("x-request-id")).toBeTruthy()
    expect(health.headers.get("x-content-type-options")).toBe("nosniff")
    expect(await health.json()).toMatchObject({
      db_status: "error",
      error: expect.stringMatching(/requires a newer App/)
    })
    expect(await readFile(dbPath)).toEqual(before)
    expect(await readdir(directory)).toEqual(["meitheal.db"])
  }, "synthetic-schema-fixture")
})

test("a first authenticated request adopts a runtime-first predecessor and waits for the full upgrade", async () => {
  test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires the built Astro runtime")
  await seedBoardPredecessor({ token: true, assignedOnly: true, ledger: false })
  const prior = new DatabaseSync(dbPath, { readOnly: true })
  try {
    expect(prior.prepare("SELECT name FROM pragma_table_info('agent_tokens') WHERE name = 'assignee_id'").get()).toBeUndefined()
  } finally {
    prior.close()
  }
  await withBuiltApp(async (origin) => {
    const tasks = await fetch(`${origin}/api/tasks`, {
      headers: { authorization: `Bearer ${fixtureToken}`, "x-meitheal-board-id": "household" },
      signal: AbortSignal.timeout(8_000)
    })
    expect(tasks.status, await tasks.clone().text()).toBe(200)
    expect(await tasks.json()).toMatchObject({ tasks: [{ id: "original", title: "Retained startup task" }] })
    for (const token of [fixtureToken, assignedOnlyFixtureToken]) {
      const denied = await fetch(`${origin}/api/tasks/original`, {
        method: "PUT",
        headers: { authorization: `Bearer ${token}`, "x-meitheal-board-id": "household", "content-type": "application/json" },
        body: JSON.stringify({ title: "Denied fixture mutation" }),
        signal: AbortSignal.timeout(5_000)
      })
      expect(denied.status).toBe(403)
      await denied.body?.cancel()
    }
    const current = new DatabaseSync(dbPath, { readOnly: true })
    try {
      const access = current.prepare(`SELECT board_id, principal_id, authority_limits FROM board_access_grants
        WHERE principal_type='agent' ORDER BY principal_id`).all()
      expect(access.map(grant => [grant.board_id, grant.principal_id])).toEqual([
        ["household", "fixture-agent"], ["household", "fixture-assigned"]
      ])
      expect(JSON.parse(String(access[0]?.authority_limits))).toEqual({ operations: [
        { resource: "board", action: "read" }, { resource: "task", action: "read" }, { resource: "task", action: "search" }
      ] })
      expect(JSON.parse(String(access[1]?.authority_limits))).toMatchObject({ assignedTo: null })
      expect(current.prepare("SELECT title, assigned_to FROM tasks WHERE id='original'").get()).toEqual({
        title: "Retained startup task", assigned_to: null
      })
    } finally {
      current.close()
    }
    const health = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(5_000) })
    expect(health.status).toBe(200)
    expect(await health.json()).toMatchObject({ schema_version: DATABASE_SCHEMA_VERSION })
    await expect(migrate("--check")).resolves.toMatchObject({
      stdout: expect.stringContaining("Migration check passed")
    })
  }, "synthetic-schema-fixture")
})

for (const token of [false, true]) {
  test(`an unsupported v18 lane shape leaves ${token ? "agent last-use time" : "the absent agent token table"} intact`, async () => {
    test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires the built Astro runtime")
    await seedBoardPredecessor({ token, unsupported: true })
    const before = await readFile(dbPath)
    await withBuiltApp(async (origin) => {
      const tasks = await fetch(`${origin}/api/tasks`, {
        headers: { authorization: `Bearer ${fixtureToken}` },
        signal: AbortSignal.timeout(8_000)
      })
      expect(tasks.status).toBe(503)
      await tasks.body?.cancel()
      expect(await readFile(dbPath)).toEqual(before)
      const probe = new DatabaseSync(dbPath, { readOnly: true })
      try {
        if (token)
          expect(
            probe.prepare("SELECT last_used_at FROM agent_tokens").get()?.last_used_at
          ).toBeNull()
        else
          expect(
            probe.prepare("SELECT name FROM sqlite_schema WHERE name = 'agent_tokens'").get()
          ).toBeUndefined()
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
  await expect(
    execFileAsync(process.execPath, ["scripts/serve.mjs"], {
      cwd: webRoot,
      env: { ...process.env, HOST: "127.0.0.1", PORT: "0" },
      timeout: 10_000
    })
  ).rejects.toMatchObject({ code: 1, stderr: expect.stringMatching(/kanban_lanes/) })
  expect(await readFile(dbPath)).toEqual(before)
})

test("the built standalone runtime rejects a different origin before opening storage", async () => {
  test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires the built Astro runtime")
  await withBuiltApp(async (origin) => {
    const create = (source: string) =>
      fetch(`${origin}/api/tasks`, {
        method: "POST",
        headers: { origin: source, "content-type": "application/json" },
        body: JSON.stringify({ title: "Startup schema fixture" }),
        signal: AbortSignal.timeout(5_000)
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

test("ordinary Board reads, planning, own history and shared Goal progress exclude private Work", async () => {
  await ensureSchema()
  const db = getPersistenceClient()
  const homeOwner = fixturePrincipal("home-user"),
    workOwner = fixturePrincipal("work-user")
  const boards = new NamedBoardRepository(db)
  const created = await boards.create(workOwner, "Work fixture")
  if (created.status !== "committed") throw new Error("Private Board fixture")
  const workId = created.result.id
  const homeScope = () => currentBoardScope(db, "household", homeOwner)
  const workScope = () => currentBoardScope(db, workId, workOwner)
  const make = async (scope: BoardScope, id: string, title: string, status = "pending") => {
    const repository = new TaskRepository(db, scope)
    const prepared = await prepareTaskCreation(
      repository,
      { title, status },
      { id, useDefaultAssignee: false }
    )
    if (!prepared.ok) throw new Error(prepared.error)
    const result = await repository.createWorkCommand(prepared.task)
    if (!result.ok) throw new Error(result.errorCode)
  }
  await make(await homeScope(), "household-task", "Home fixture")
  await make(await workScope(), "private-task", "Private fixture", "complete")
  const repo = new TaskRepository(db, await homeScope())
  try {
    await ensurePomodoroSchema()
    const own = await homeScope()
    const standalone = await startFocus(own)
    await expect(startFocus(own, "private-task")).rejects.toThrow(/unavailable/i)
    expect((await getTimerState(own)).sessionId).toBe(standalone.sessionId)
    await db.execute(
      "INSERT INTO pomodoro_sessions(id,task_id,started_at,completed_at,duration_minutes) VALUES('foreign-session','private-task',datetime('now'),datetime('now'),15)"
    )
    expect(await getSessionHistory(own)).toEqual([])
    expect(await getTodayStats(own)).toEqual({ sessionsCompleted: 0, totalFocusMinutes: 0 })
    await startFocus(own, "household-task")
    await skipToBreak(own)
    expect((await db.execute("SELECT task_id FROM time_entries")).rows).toEqual([
      { task_id: "household-task" }
    ])
    await cancelSession(own)
  } finally {
    resetPomodoroForTests()
  }
  expect((await repo.findAll({ limit: 1 })).total).toBe(1)
  expect(await repo.resolveTaskId("private-task")).toBeNull()
  expect(await repo.findById("private-task")).toBeNull()
  expect((await repo.exportAll()).map((task) => task.id)).toEqual(["household-task"])
  expect((await repo.getStatusCounts()).total).toBe(1)
  expect(await repo.countCompletedBefore(Date.now() + 1)).toBe(0)
  expect(await repo.deleteTask("private-task")).toBe(false)
  expect((await db.execute("SELECT id FROM tasks WHERE id='private-task'")).rows).toHaveLength(1)

  const workHierarchy = new HierarchyRepository(db, await workScope())
  await workHierarchy.createArea({ id: "work-area", name: "Work area" })
  expect(
    await workHierarchy.createGoal({
      id: "work-goal",
      title: "Work goal",
      description: "Private Work detail",
      area_id: "work-area"
    })
  ).toBe(true)
  expect(
    await workHierarchy.createProject({
      id: "work-project",
      title: "Work project",
      area_id: "work-area",
      goal_id: "work-goal",
      status: "completed"
    })
  ).toBe(true)
  const privatePillar = await createPillar(await workScope(), { name: "Work pillar" })
  const hierarchy = new HierarchyRepository(db, await homeScope())
  expect(await hierarchy.findAreaById("work-area")).toBeNull()
  expect(await hierarchy.findProjectById("work-project")).toBeNull()
  expect(await hierarchy.findAllGoals({ area_id: "work-area" })).toEqual([])
  expect(await hierarchy.findAllGoals({ project_id: "work-project" })).toEqual([])
  expect(await repo.getAreas()).not.toHaveProperty("work-area")
  expect(
    (
      await searchMeithealCatalog(
        {
          query: "Work area",
          scope: "views",
          limit: 10,
          includeCompleted: false,
          includeArchived: false,
          sort: "relevance",
          taskFields: []
        },
        await homeScope()
      )
    ).sections.flatMap((section) => section.items)
  ).not.toContainEqual(expect.objectContaining({ id: "work-area" }))
  expect(
    await new TaskInactivityRepository(db, await homeScope()).preview({
      areaId: "work-area",
      page: 1,
      filter: "all",
      now: 1
    })
  ).toMatchObject({
    areaExists: false,
    areaGeneration: null,
    areas: expect.not.arrayContaining([expect.objectContaining({ id: "work-area" })])
  })
  expect(
    await hierarchy.createProject({
      id: "rejected-project",
      title: "Rejected",
      area_id: "work-area"
    })
  ).toBe(false)
  expect(
    await hierarchy.createGoal({ id: "rejected-goal", title: "Rejected", area_id: "work-area" })
  ).toBe(false)
  expect(await hierarchy.deleteProject("work-project")).toBe(false)
  expect(await getPillarById(await homeScope(), privatePillar.id)).toBeNull()
  expect((await getPillars(await homeScope())).map((pillar) => pillar.id)).not.toContain(
    privatePillar.id
  )

  expect(
    await changeGoalShare(
      db,
      await workScope(),
      "work-goal",
      { kind: "area", boardId: "household", areaId: "default" },
      true
    )
  ).toMatchObject({ result: "saved" })
  const sharedHome = new HierarchyRepository(db, await homeScope())
  expect(
    await sharedHome.createProject({
      id: "home-project",
      title: "Home project",
      area_id: "default",
      goal_id: "work-goal",
      status: "completed"
    })
  ).toBe(true)
  const home = await readSharedGoals(db, await homeScope(), { areaId: "default" })
  expect(home).toEqual([
    {
      id: "work-goal",
      title: "Work goal",
      area_id: "default",
      project_count: 1,
      completed_project_count: 1
    }
  ])
  expect(await readSharedGoals(db, await homeScope(), {})).toEqual(
    home.map((goal) => ({ ...goal, area_id: null }))
  )
  expect(await readSharedGoals(db, await homeScope(), { projectId: "home-project" })).toEqual(
    home.map((goal) => ({ ...goal, area_id: null }))
  )
  expect(
    await readSharedGoals(db, await homeScope(), { areaId: "work-area", projectId: "home-project" })
  ).toEqual([])
  expect(await readSharedGoals(db, await homeScope(), { projectId: "work-project" })).toEqual([])
  expect(
    await new HierarchyRepository(db, await workScope()).createGoal({
      id: "work-unshared",
      title: "Unshared Work Goal",
      description: "For Work only",
      area_id: "work-area"
    })
  ).toBe(true)
  expect(await readSharedGoals(db, await homeScope(), { goalId: "work-unshared" })).toEqual([])
  expect(await readSharedGoals(db, await workScope(), { goalId: "work-unshared" })).toMatchObject([
    { id: "work-unshared", named: { description: "For Work only" }, project_count: 0 }
  ])
  expect(
    await readSharedGoals(db, await currentBoardScope(db, "household", workOwner), {
      areaId: "default"
    })
  ).toMatchObject([{ id: "work-goal", project_count: 2, completed_project_count: 2 }])
  expect(
    await sharedHome.updateProject("home-project", { area_id: "work-area", title: "Rejected" })
  ).toBe(false)
  expect(await sharedHome.findProjectById("home-project")).toMatchObject({ title: "Home project" })
  expect(await readSharedGoals(db, await homeScope(), { areaId: "default" })).toEqual(home)
  const oldScope = await homeScope()
  expect(
    await changeGoalShare(
      db,
      await workScope(),
      "work-goal",
      { kind: "area", boardId: "household", areaId: "default" },
      false
    )
  ).toMatchObject({ result: "saved" })
  expect(await readSharedGoals(db, oldScope, { areaId: "default" })).toEqual([])
  expect(await readSharedGoals(db, await homeScope(), { areaId: "default" })).toEqual([])
  expect(
    (await db.execute("SELECT title,goal_id FROM projects WHERE id='home-project'")).rows[0]
  ).toMatchObject({ title: "Home project", goal_id: "work-goal" })
})

test("independently current schema25 preserves foreign historical planning references during ordinary conversion and retirement", async () => {
  const markerPath = dbPath + ".board-grants.json"
  const predecessor = await openDatabaseForStartup(`file:${dbPath}`, { markerPath })
  let revision: string | null = null
  try {
    await withStartupWriteTransaction(predecessor, async (tx) => {
      await applyStartupTaskSchema(tx)
      await tx.batch([
        "INSERT INTO task_boards(id,name,visibility,ticket_prefix,created_at,updated_at) VALUES('legacy-work','Work fixture','restricted','WORKABCD',1,1)",
        "INSERT INTO board_permissions(board_id) VALUES('legacy-work')",
        "INSERT INTO board_access_grants(board_id,principal_type,principal_id,role) VALUES('legacy-work','ha_user','work-owner','owner')",
        "INSERT INTO areas(id,name,created_at,updated_at) VALUES('legacy-area','Legacy Home',1,1)",
        "INSERT INTO goals(id,title,area_id,created_at,updated_at) VALUES('legacy-goal','Legacy Goal','legacy-area',1,1)",
        "INSERT INTO projects(id,title,area_id,goal_id,created_at,updated_at) VALUES('legacy-project','Legacy Project','legacy-area','legacy-goal',1,1)",
        "INSERT INTO projects(id,title,area_id,goal_id,owner_board_id,created_at,updated_at) VALUES('foreign-project','Historical Work','legacy-area','legacy-goal','legacy-work',1,1)",
        "INSERT INTO kanban_lanes(id,key,label,board_id,created_at,updated_at) VALUES('work-pending','pending','Pending','legacy-work',1,1)",
        "INSERT INTO tasks(id,title,task_board_id,board_column_id,ticket_ref,area_id,idempotency_key,request_id,created_at,updated_at) VALUES('private-task','Historical private work','legacy-work','work-pending','WORKABCD-1','__meitheal_no_area__','private','private',1,1)",
        "INSERT INTO board_task_planning(task_id,area_id,project_id,goal_id) VALUES('private-task','legacy-area','legacy-project','legacy-goal')"
      ])
      revision = await initializeBoardGrantContinuity(predecessor, tx)
    })
    if (!revision) throw new Error("Current25 journal fixture required")
    await finalizeStartupBoardGrant(predecessor, revision)
  } finally {
    predecessor.close()
  }
  await ensureSchema()
  const db = getPersistenceClient()
  const current = await currentBoardGrantRevision(db, markerPath)
  expect(current).not.toBe(revision)
  const homeScope = () => currentBoardScope(db, "household", fixturePrincipal("home-owner"))
  const workScope = await currentBoardScope(db, "legacy-work", fixturePrincipal("work-owner"))
  expect(
    await new HierarchyRepository(db, workScope).createProject({
      id: "new-invalid",
      title: "Rejected current placement",
      area_id: "legacy-area"
    })
  ).toBe(false)
  expect(await new TaskRepository(db, await homeScope()).findById("private-task")).toBeNull()
  expect(await new HierarchyRepository(db, await homeScope()).deleteProject("legacy-project")).toBe(
    true
  )
  expect(await new HierarchyRepository(db, await homeScope()).deleteGoal("legacy-goal")).toBe(true)
  expect(await new HierarchyRepository(db, await homeScope()).deleteArea("legacy-area")).toBe(true)
  expect(
    (await db.execute("SELECT area_id,goal_id FROM projects WHERE id='foreign-project'")).rows[0]
  ).toEqual({ area_id: "legacy-area", goal_id: "legacy-goal" })
  expect(
    (
      await db.execute(
        "SELECT task_id,area_id,project_id,goal_id FROM board_task_planning WHERE task_id='private-task'"
      )
    ).rows[0]
  ).toEqual({
    task_id: "private-task",
    area_id: "legacy-area",
    project_id: "legacy-project",
    goal_id: "legacy-goal"
  })
  expect(
    (await db.execute("SELECT updated_at FROM tasks WHERE id='private-task'")).rows[0]?.updated_at
  ).toBe(1)
  expect(
    await new HierarchyRepository(db, await homeScope()).findAreaById("legacy-area")
  ).toBeNull()
  expect(
    await new HierarchyRepository(db, await homeScope()).findGoalById("legacy-goal")
  ).toBeNull()
})
