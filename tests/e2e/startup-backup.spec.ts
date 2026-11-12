import { execFile, fork } from "node:child_process"
import { once } from "node:events"
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { expect, test } from "@playwright/test"
import { DATABASE_SCHEMA_VERSION, openDatabase } from "../../apps/web/scripts/database-client.mjs"
import { ensureSchema, getPersistenceClient, resetPersistenceForTests } from "../../apps/web/src/domains/tasks/persistence/store"

const execFileAsync = promisify(execFile)
const webRoot = fileURLToPath(new URL("../../apps/web", import.meta.url))
let directory: string
let dbPath: string
const previousDbUrl = process.env.MEITHEAL_DB_URL
const previousBackupHandled = process.env.MEITHEAL_STARTUP_BACKUP_HANDLED
const futureVersion = String(DATABASE_SCHEMA_VERSION + 1)

function migrate(...args: string[]) {
  return execFileAsync(process.execPath, ["scripts/migrate.mjs", ...args], { cwd: webRoot, timeout: 20_000 })
}

function seedSchemaMarker(value: string, inWal = false) {
  const database = new DatabaseSync(dbPath)
  database.exec("CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)")
  database.prepare("INSERT INTO app_settings VALUES ('schema_version', ?, 1)").run(String(DATABASE_SCHEMA_VERSION))
  if (inWal) database.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; PRAGMA wal_checkpoint(TRUNCATE)")
  database.prepare("UPDATE app_settings SET value=? WHERE key='schema_version'").run(value)
  return database
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

test("migration check leaves missing storage and an untracked legacy database alone", async () => {
  const missing = join(directory, "missing", "meitheal.db")
  await expect(execFileAsync(process.execPath, ["scripts/migrate.mjs", "--check"], {
    cwd: webRoot, env: { ...process.env, MEITHEAL_DB_URL: `file:${missing}` }, timeout: 20_000,
  })).rejects.toThrow(/Database does not exist/)
  expect(await readdir(directory)).toEqual([])

  seedSchemaMarker(String(DATABASE_SCHEMA_VERSION - 1)).close()
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
        expect(mainOnly.prepare("SELECT value FROM app_settings").get()?.value).toBe(String(DATABASE_SCHEMA_VERSION))
      } finally { mainOnly.close() }

      await expect(migrate()).rejects.toThrow(message)
      await expect(migrate("--check")).rejects.toThrow(message)
      expect(() => getPersistenceClient()).toThrow(message)
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
      INSERT INTO app_settings VALUES('schema_version','${DATABASE_SCHEMA_VERSION}',1);
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
  const database = getPersistenceClient()
  try {
    expect((await database.execute("SELECT value FROM app_settings")).rows[0]?.value).toBe(String(DATABASE_SCHEMA_VERSION))
    expect((await database.execute("SELECT COUNT(*) AS count FROM spill")).rows[0]?.count).toBe(0)
  } finally { database.close() }
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
