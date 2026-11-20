import { createHash } from "node:crypto"
import { chmod, copyFile, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { spawnSync } from "node:child_process"
import { expect, test } from "@playwright/test"
import { openDatabaseForStartup, withStartupWriteTransaction } from "../../apps/web/scripts/database-client.mjs"
import { applyStartupTaskSchema } from "../../apps/web/scripts/task-schema-startup.mjs"
import {
  currentBoardGrantRevision, databaseRevision, finalizeStartupBoardGrant, initializeBoardGrantContinuity,
  getBoardGrantPath,
} from "../../apps/web/scripts/board-grant-journal.mjs"
import { enrollLegacyContinuity } from "../../apps/web/scripts/enroll-legacy-continuity.mjs"
import { guardClientContinuity } from "../../apps/web/src/domains/tasks/persistence/continuity-client"

const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex")

async function start(database: string, markerPath: string) {
  const client = await openDatabaseForStartup("file:" + database, { markerPath })
  let initial: string | null = null
  await withStartupWriteTransaction(client, async tx => {
    await applyStartupTaskSchema(tx)
    initial = await initializeBoardGrantContinuity(client, tx)
  })
  await finalizeStartupBoardGrant(client, initial)
  return client
}

test("exclusive fresh creation enrolls once; existing empty, residue and symlinks cannot enroll", async () => {
  const work = await mkdtemp(join(tmpdir(), "continuity-create-"))
  const database = join(work, "fresh.db")
  const marker = join(work, "grants.json")
  try {
    let db = await start(database, marker)
    const revision = await currentBoardGrantRevision(db)
    expect(revision).toMatch(/^[a-f0-9-]{36}$/)
    const transparent = new Proxy(db, {})
    const guarded = guardClientContinuity(transparent)
    expect(getBoardGrantPath(guarded)).toBe(marker)
    expect(await currentBoardGrantRevision(guarded)).toBe(revision)
    expect(await databaseRevision(guarded)).toBe(revision)
    db.close()
    db = await start(database, marker)
    expect(await currentBoardGrantRevision(db)).toBe(revision)
    db.close()

    const empty = join(work, "empty.db")
    await writeFile(empty, "")
    db = await start(empty, join(work, "empty-grants.json"))
    expect(await databaseRevision(db)).toBeNull()
    expect(await currentBoardGrantRevision(db)).toBeNull()
    db.close()

    await writeFile(join(work, "residue.db-wal"), "orphan")
    await expect(openDatabaseForStartup("file:" + join(work, "residue.db"), { markerPath: marker }))
      .rejects.toThrow("residue")
    await symlink(database, join(work, "link.db"))
    await expect(openDatabaseForStartup("file:" + join(work, "link.db"), { markerPath: marker }))
      .rejects.toThrow("symlink")
    await symlink(work, join(work, "link-directory"))
    await expect(openDatabaseForStartup("file:" + join(work, "link-directory", "new.db"), { markerPath: marker }))
      .rejects.toThrow("symlink")
  } finally { await rm(work, { recursive: true, force: true }) }
})

test("concurrent exclusive creators grant at most one startup capability", async () => {
  const work = await mkdtemp(join(tmpdir(), "continuity-race-"))
  try {
    const database = join(work, "race.db")
    const markerPath = join(work, "grants.json")
    const results = await Promise.allSettled([
      openDatabaseForStartup("file:" + database, { markerPath }),
      openDatabaseForStartup("file:" + database, { markerPath }),
    ])
    const clients = results.flatMap(result => result.status === "fulfilled" ? [result.value] : [])
    expect(clients.length).toBeGreaterThanOrEqual(1)
    let initializations = 0
    try {
      for (const db of clients) {
        let revision: string | null = null
        await withStartupWriteTransaction(db, async tx => {
          await applyStartupTaskSchema(tx)
          revision = await initializeBoardGrantContinuity(db, tx)
          if (revision) initializations++
          expect(await initializeBoardGrantContinuity(db, tx)).toBeNull()
        })
        await finalizeStartupBoardGrant(db, revision)
      }
      expect(initializations).toBe(1)
      expect(await currentBoardGrantRevision(clients[0]!)).toMatch(/^[a-f0-9-]{36}$/)
    } finally { clients.forEach(db => db.close()) }
  } finally { await rm(work, { recursive: true, force: true }) }
})

test("interrupted initial commit stays locked; exact committed journal can publish", async () => {
  const work = await mkdtemp(join(tmpdir(), "continuity-interrupt-"))
  const database = join(work, "interrupted.db")
  const markerPath = join(work, "grants.json")
  try {
    let db = await openDatabaseForStartup("file:" + database, { markerPath })
    await expect(withStartupWriteTransaction(db, async tx => {
      await applyStartupTaskSchema(tx)
      await initializeBoardGrantContinuity(db, tx)
      throw new Error("synthetic interruption before commit")
    })).rejects.toThrow("synthetic interruption")
    db.close()
    db = await start(database, markerPath)
    expect(await currentBoardGrantRevision(db)).toBeNull()
    db.close()

    const committed = join(work, "committed.db")
    const committedDirectory = join(work, "committed")
    await mkdir(committedDirectory)
    const committedMarker = join(committedDirectory, "grants.json")
    db = await openDatabaseForStartup("file:" + committed, { markerPath: committedMarker })
    let revision: string | null = null
    await withStartupWriteTransaction(db, async tx => {
      await applyStartupTaskSchema(tx)
      revision = await initializeBoardGrantContinuity(db, tx)
    })
    db.close()
    db = await openDatabaseForStartup("file:" + committed, { markerPath: committedMarker })
    expect(await currentBoardGrantRevision(db)).toBe(revision)
    expect(JSON.parse(await readFile(committedMarker, "utf8"))).toEqual({ epoch: revision })
    db.close()
  } finally { await rm(work, { recursive: true, force: true }) }
})

test("packaged migrator enrolls before separate server startup and retains the epoch", async () => {
  const work = await mkdtemp(join(tmpdir(), "continuity-migrator-"))
  try {
    const database = join(work, "packaged.db")
    const marker = join(work, "grants.json")
    const result = spawnSync(process.execPath, ["scripts/migrate.mjs"], {
      cwd: resolve(import.meta.dirname, "../../apps/web"),
      env: { ...process.env, MEITHEAL_DB_URL: "file:" + database, MEITHEAL_BOARD_GRANT_PATH: marker },
      encoding: "utf8",
    })
    expect(result.status, result.stderr).toBe(0)
    const published = JSON.parse(await readFile(marker, "utf8")).epoch
    const db = await start(database, marker)
    expect(await currentBoardGrantRevision(db)).toBe(published)
    db.close()
  } finally { await rm(work, { recursive: true, force: true }) }
})

test("memory initialization is explicit and uses its isolated marker context", async () => {
  const work = await mkdtemp(join(tmpdir(), "continuity-memory-"))
  try {
    const markerPath = join(work, "grants.json")
    const unknown = await openDatabaseForStartup(":memory:", { markerPath })
    await withStartupWriteTransaction(unknown, async tx => {
      await applyStartupTaskSchema(tx)
      expect(await initializeBoardGrantContinuity(unknown, tx)).toBeNull()
    })
    expect(await currentBoardGrantRevision(unknown)).toBeNull()
    unknown.close()
    const trusted = await openDatabaseForStartup(":memory:", { markerPath, trustedInitialization: { kind: "isolated-memory" } })
    let revision: string | null = null
    await withStartupWriteTransaction(trusted, async tx => {
      await applyStartupTaskSchema(tx)
      revision = await initializeBoardGrantContinuity(trusted, tx)
    })
    await finalizeStartupBoardGrant(trusted, revision)
    expect(await currentBoardGrantRevision(trusted)).toBe(revision)
    trusted.close()
  } finally { await rm(work, { recursive: true, force: true }) }
})

for (const retainedWal of [false, true]) test(`offline legacy admission consumes current proof once (${retainedWal ? "retained WAL/SHM" : "single cold file"}); historical data stays locked`, async () => {
  const work = await mkdtemp(join(tmpdir(), "continuity-operator-"))
  const data = join(work, "data")
  const custody = join(work, "custody")
  await mkdir(data)
  await mkdir(custody, { mode: 0o700 })
  try {
    const database = join(data, "legacy.db")
    const markerPath = join(data, "grants.json")
    await writeFile(database, "")
    const legacy = await start(database, markerPath)
    expect(await currentBoardGrantRevision(legacy)).toBeNull()
    legacy.close()
    if (retainedWal) {
      const result = spawnSync(process.execPath, ["--input-type=module", "--eval", `
        import { DatabaseSync } from "node:sqlite"
        const db = new DatabaseSync(${JSON.stringify(database)})
        db.exec("PRAGMA journal_mode=WAL; INSERT INTO app_settings(key,value,updated_at) VALUES ('continuity_probe','synthetic',1)")
        process.exit(0)
      `], { encoding: "utf8" })
      expect(result.status, result.stderr).toBe(0)
    }
    const historical = join(data, "historical.db")
    await copyFile(database, historical)
    const archivePath = join(custody, "checkpoint.archive")
    await copyFile(database, archivePath)
    await chmod(archivePath, 0o600)
    if (retainedWal) {
      await copyFile(database + "-wal", join(custody, "checkpoint.wal"))
      await copyFile(database + "-shm", join(custody, "checkpoint.shm"))
    }
    const identity = { installationId: "synthetic-installation", appSlug: "meitheal_canary", image: "ghcr.io/example/meitheal@sha256:" + "a".repeat(64), source: "b".repeat(40) }
    const manifestPath = join(custody, "manifest.json")
    const manifest = { kind: "meitheal-current-legacy-checkpoint-v1", checkpointId: "current-checkpoint", ...identity,
      archiveSha256: hash(await readFile(archivePath)), databaseFamily: { database: hash(await readFile(database)),
        wal: retainedWal ? hash(await readFile(database + "-wal")) : null,
        shm: retainedWal ? hash(await readFile(database + "-shm")) : null, journal: null } }
    const manifestBytes = JSON.stringify(manifest)
    await writeFile(manifestPath, manifestBytes, { mode: 0o600 })
    const options = { database, markerPath, custodyDirectory: custody, manifestPath, archivePath, ...identity }
    await expect(enrollLegacyContinuity(options)).rejects.toThrow("ENOENT")
    const deniedHistorical = await start(historical, join(data, "historical-grants.json"))
    expect(await currentBoardGrantRevision(deniedHistorical)).toBeNull()
    deniedHistorical.close()
    const current = { kind: "meitheal-current-continuity-attestation-v1", checkpointId: manifest.checkpointId, manifestSha256: hash(manifestBytes), ...identity,
      state: "current", coreOwnerVerified: true, appStopped: true, noNewerGrantOrLifecycleChange: true, verificationId: "external-current-observation" }
    const currentPath = join(custody, "current.json")
    await writeFile(currentPath, JSON.stringify({ ...current, state: "historical" }), { mode: 0o600 })
    await expect(enrollLegacyContinuity(options)).rejects.toThrow("current cold-checkpoint")
    await writeFile(currentPath, JSON.stringify(current), { mode: 0o600 })
    const admitted = await enrollLegacyContinuity(options)
    expect(admitted.status).toBe("enrolled")
    const db = await start(database, markerPath)
    expect(await currentBoardGrantRevision(db)).toBe(admitted.revision)
    db.close()
    await rm(markerPath)
    await rm(join(data, "meitheal-board-grants-pending"), { recursive: true, force: true })
    await copyFile(archivePath, database)
    if (retainedWal) {
      await copyFile(join(custody, "checkpoint.wal"), database + "-wal")
      await copyFile(join(custody, "checkpoint.shm"), database + "-shm")
    }
    await expect(enrollLegacyContinuity(options)).rejects.toThrow("EEXIST")
    expect((await readFile(join(custody, "consumed", "current-checkpoint.json"), "utf8"))).toContain("consumed-before-enrollment")
    await copyFile(archivePath, historical)
    const replay = await start(historical, join(data, "historical-grants.json"))
    expect(await currentBoardGrantRevision(replay)).toBeNull()
    replay.close()
  } finally { await rm(work, { recursive: true, force: true }) }
})
