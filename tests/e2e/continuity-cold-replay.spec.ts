import { currentBoardScope, fixturePrincipal } from "../helpers/current-board-scope"
import { startCoreRosterFixture } from "../helpers/core-roster-fixture"
import { runWithIngressTransport } from "../../apps/web/scripts/ingress-transport.mjs"
import { createHash } from "node:crypto"
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import { openDatabaseForStartup, withStartupWriteTransaction } from "../../apps/web/scripts/database-client.mjs"
import { applyStartupTaskSchema } from "../../apps/web/scripts/task-schema-startup.mjs"
import { enrollLegacyContinuity } from "../../apps/web/scripts/enroll-legacy-continuity.mjs"
import { NamedBoardRepository } from "../../apps/web/src/domains/tasks/persistence/named-board-repository"
import { OrganizationAccessRepository } from "../../apps/web/src/domains/tasks/persistence/organization-access-repository"
import {
  TaskRepository,
  type TaskCreationData
} from "../../apps/web/src/domains/tasks/persistence/task-repository"
import {
  ensureSchema,
  getPersistenceClient,
  resetPersistenceForTests
} from "../helpers/persistence-fixture"
import { GET as getTasks } from "../../apps/web/src/pages/api/tasks/index"

const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex")
const task = (id: string): TaskCreationData => ({
  id,
  title: id,
  description: "",
  status: "pending",
  priority: 3,
  due_date: null,
  labels: "[]",
  framework_payload: "{}",
  parent_id: null,
  area_id: "default",
  custom_fields: "{}",
  start_date: null,
  end_date: null,
  progress: 0,
  color: null,
  task_type: "task",
  assigned_to: null
})

test("real current policy and Household lifecycle remain closed after actual cold pre-grant replay", async () => {
  const work = await mkdtemp(join(tmpdir(), "continuity-cold-replay-"))
  const previous = process.env.MEITHEAL_DB_URL
  const data = join(work, "data")
  const custodyDirectory = join(work, "custody")
  await mkdir(data)
  await mkdir(custodyDirectory, { mode: 0o700 })
  const database = join(data, "legacy.db")
  const markerPath = join(data, "grants.json")
  const historical = join(work, "pre-first-grant.db")
  process.env.MEITHEAL_DB_URL = "file:" + database
  resetPersistenceForTests()
  try {
    // An existing pre-grant installation has no startup creation provenance.
    await writeFile(database, "")
    await ensureSchema({ markerPath })
    let db = getPersistenceClient()
    expect((await db.execute("SELECT revision FROM board_access_epoch")).rows).toEqual([])
    await db.execute(`INSERT INTO tasks(id, title, status, ticket_number, idempotency_key, request_id, created_at, updated_at)
      VALUES ('retained', 'Retained Household task', 'pending', 1, 'retained', 'retained', 1, 1)`)
    await db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    resetPersistenceForTests()
    await copyFile(database, historical)
    const archivePath = join(custodyDirectory, "cold.archive")
    await copyFile(database, archivePath)
    await chmod(archivePath, 0o600)
    const identity = {
      installationId: "synthetic-cold-replay",
      appSlug: "meitheal_canary",
      image: "ghcr.io/example/meitheal@sha256:" + "a".repeat(64),
      source: "b".repeat(40)
    }
    const manifestPath = join(custodyDirectory, "manifest.json")
    const manifest = {
      kind: "meitheal-current-legacy-checkpoint-v1",
      checkpointId: "verified-current-pre-grant",
      ...identity,
      archiveSha256: hash(await readFile(archivePath)),
      databaseFamily: {
        database: hash(await readFile(database)),
        wal: null,
        shm: null,
        journal: null
      }
    }
    const manifestBytes = JSON.stringify(manifest)
    await writeFile(manifestPath, manifestBytes, { mode: 0o600 })
    await writeFile(
      join(custodyDirectory, "current.json"),
      JSON.stringify({
        kind: "meitheal-current-continuity-attestation-v1",
        checkpointId: manifest.checkpointId,
        manifestSha256: hash(manifestBytes),
        ...identity,
        state: "current",
        coreOwnerVerified: true,
        appStopped: true,
        noNewerGrantOrLifecycleChange: true,
        verificationId: "independently-current-synthetic-observation"
      }),
      { mode: 0o600 }
    )
    expect(
      await enrollLegacyContinuity({
        database,
        markerPath,
        custodyDirectory,
        manifestPath,
        archivePath,
        ...identity
      })
    ).toMatchObject({ status: "enrolled" })
    await ensureSchema({ markerPath })
    db = getPersistenceClient()
    const policies = new OrganizationAccessRepository(db)
    expect(
      await policies.change(
        { scope: "feature", id: "goals", boardId: "" },
        null,
        { audience: "nobody", users: [] },
        fixturePrincipal()
      )
    ).toMatchObject({ status: "committed", result: "saved" })
    const owner = fixturePrincipal()
    const scope = await currentBoardScope(db, "household", owner)
    expect(
      await new NamedBoardRepository(db).changeLifecycle(owner, "household", "retired", 1, true)
    ).toMatchObject({ status: "committed", result: "saved" })
    await expect(new TaskRepository(db, scope).exportAll()).rejects.toMatchObject({
      errorCode: "stale"
    })
    const currentMarker = await readFile(markerPath)
    await db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    resetPersistenceForTests()

    // Replay the same real cold pre-enrollment bytes while retaining the
    // independently newer current marker on disk: must stay locked.
    for (const suffix of ["", "-wal", "-shm"]) await rm(database + suffix, { force: true })
    await copyFile(historical, database)
    await rm(markerPath, { force: true })
    await writeFile(markerPath, currentMarker)
    await ensureSchema({ markerPath })
    db = getPersistenceClient()
    expect(await new OrganizationAccessRepository(db).policies("feature", "")).toEqual({
      status: "locked"
    })
    const tasks = new TaskRepository(db, scope)
    await expect(tasks.findAll({})).rejects.toMatchObject({ errorCode: "stale" })
    await expect(tasks.exportAll()).rejects.toMatchObject({ errorCode: "stale" })
    await expect(tasks.getOpenTaskCount()).rejects.toMatchObject({ errorCode: "stale" })
    await expect(tasks.createTask(task("forbidden-write"))).rejects.toMatchObject({
      errorCode: "stale"
    })
    await expect(
      tasks.createTask({ ...task("dangling-project"), project_id: "missing" })
    ).rejects.toMatchObject({ errorCode: "stale" })
    const stopCore = await startCoreRosterFixture(["owner"])
    try {
      const url = new URL("http://localhost/api/tasks?board_id=household")
      const transport = {
        peer: "172.30.32.2",
        fromSupervisor: true,
        identityHeadersSafe: true,
        configuredPath: "/api/hassio_ingress/test"
      }
      const response = await runWithIngressTransport(transport, () =>
        getTasks({
          request: new Request(url),
          url,
          params: {},
          locals: { behindIngress: true, hassUserId: "owner" }
        } as Parameters<typeof getTasks>[0])
      )
      expect(response.status).toBe(503)
      expect(await response.json()).toMatchObject({
        status: 503,
        detail: "Current work access is unavailable."
      })
    } finally {
      await stopCore()
    }
    expect((await db.execute("SELECT id FROM tasks")).rows).toEqual([{ id: "retained" }])
    expect(
      (await db.execute("SELECT state FROM task_boards WHERE id = 'household'")).rows
    ).toEqual([{ state: "active" }])
    resetPersistenceForTests()

    // Genuine pre-0016 upgrade with no marker or pending entry on disk
    // auto-enrolls once, after which removing the marker locks access again.
    const genuinePre0016 = join(work, "genuine-pre0016.db")
    await writeFile(genuinePre0016, "")
    const raw = await openDatabaseForStartup("file:" + genuinePre0016, { markerPath })
    try {
      await withStartupWriteTransaction(raw, async tx => {
        await applyStartupTaskSchema(tx)
        await tx.execute(`INSERT INTO tasks(id, title, status, ticket_number, idempotency_key, request_id, created_at, updated_at)
          VALUES ('retained', 'Retained Household task', 'pending', 1, 'retained', 'retained', 1, 1)`)
      })
      await raw.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    } finally {
      raw.close()
    }
    for (const suffix of ["", "-wal", "-shm"]) await rm(database + suffix, { force: true })
    await copyFile(genuinePre0016, database)
    await rm(markerPath, { force: true })
    await ensureSchema({ markerPath })
    db = getPersistenceClient()
    expect(await new OrganizationAccessRepository(db).policies("feature", "")).toMatchObject({
      status: "current"
    })
    expect((await db.execute("SELECT id FROM tasks")).rows).toEqual([{ id: "retained" }])
    await db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    resetPersistenceForTests()
    await rm(markerPath, { force: true })
    await ensureSchema({ markerPath })
    db = getPersistenceClient()
    expect(await new OrganizationAccessRepository(db).policies("feature", "")).toEqual({
      status: "locked"
    })
    resetPersistenceForTests()
    // The independently consumed proof cannot be replayed against identical old data.
    await rm(markerPath, { force: true })
    await expect(
      enrollLegacyContinuity({
        database,
        markerPath,
        custodyDirectory,
        manifestPath,
        archivePath,
        ...identity
      })
    ).rejects.toThrow()
  } finally {
    resetPersistenceForTests()
    if (previous === undefined) delete process.env.MEITHEAL_DB_URL
    else process.env.MEITHEAL_DB_URL = previous
    await rm(work, { recursive: true, force: true })
  }
})
