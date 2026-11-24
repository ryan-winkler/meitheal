import { randomUUID } from "node:crypto"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import {
  openDatabaseForStartup,
  withStartupWriteTransaction
} from "../../apps/web/scripts/database-client.mjs"
import {
  finalizeStartupBoardGrant,
  initializeBoardGrantContinuity,
  readBoardGrantRevision
} from "../../apps/web/scripts/board-grant-journal.mjs"
import {
  applyStartupBoardSchema,
  applyStartupTaskSchema,
  validateStartupTaskSchema
} from "../../apps/web/scripts/task-schema-startup.mjs"
import { BoardAccessService } from "../../apps/web/src/domains/tasks/board-access-service"
import {
  registerVerifiedPrincipal,
  validateBoardScope,
  type VerifiedPrincipal
} from "../../apps/web/src/domains/tasks/board-scope"
import { NamedBoardRepository } from "../../apps/web/src/domains/tasks/persistence/named-board-repository"
import { changeBoardGrants } from "../../apps/web/src/domains/tasks/persistence/board-grant-fence"
import {
  readOrdinaryBoardMigrationState,
  legacyTimerTables,
  legacyGrocyConfirmationsTable
} from "../../apps/web/drizzle/migrations/0016_ordinary_boards.mjs"
import { resolveIntakeSubmissionScope } from "../../apps/web/src/domains/tasks/intake-scope"
import { CUSTOM_BOARD_KEYS_MIGRATION } from "../../apps/web/drizzle/migrations/0017_custom_board_keys.mjs"
import { TASK_EXPERIENCE_MIGRATION } from "../../apps/web/drizzle/migrations/0018_task_experience.mjs"

let directory: string
let db: Awaited<ReturnType<typeof openDatabaseForStartup>>
let marker: string
function human(id: string, administrator = false) {
  return registerVerifiedPrincipal(
    { kind: "ha_user", id },
    { expiresAt: Date.now() + 60_000, administrator }
  )
}

test.beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "meitheal-ordinary-authority-"))
  marker = join(directory, "grants.json")
  db = await openDatabaseForStartup(`file:${join(directory, "test.db")}`, { markerPath: marker })
})
test.afterEach(async () => {
  db.close()
  await rm(directory, { recursive: true, force: true })
})

async function initialize() {
  const result = await withStartupWriteTransaction(db, (tx) => applyStartupBoardSchema(db, tx))
  await finalizeStartupBoardGrant(db, result.revision)
  return result
}

test("fresh admitted schema26 validates and restarts without another conversion", async () => {
  expect(await initialize()).toMatchObject({ state: "ready", pending: [] })
  expect(await readOrdinaryBoardMigrationState(db)).toBe(true)
  await validateStartupTaskSchema(db)
  const before = await db.execute("SELECT revision FROM board_access_epoch")
  db.close()
  db = await openDatabaseForStartup(`file:${join(directory, "test.db")}`, { markerPath: marker })
  expect(await initialize()).toMatchObject({ state: "ready", applied: [], pending: [] })
  expect((await db.execute("SELECT revision FROM board_access_epoch")).rows).toEqual(before.rows)
})

test("example rename, directory, sidebar and lifecycle use the same Board policies", async () => {
  await initialize()
  const owner = human("parent", true)
  const boards = new NamedBoardRepository(db, marker)
  const created = await boards.create(owner, "Work")
  if (created.status !== "committed") throw new Error("Board fixture creation failed")
  const work = created.result.id
  expect(await boards.findDirectory(owner)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: "household", hidden: false }),
      expect.objectContaining({ id: work, name: "Work" })
    ])
  )
  expect(await boards.rename(owner, "household", "Church", 1)).toMatchObject({
    status: "committed",
    result: "saved"
  })
  expect(await boards.setSidebarHidden(owner, "household", true)).toBe(true)
  expect(await boards.findDirectory(owner)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: "household", name: "Church", hidden: true })
    ])
  )
  for (const id of ["household", work]) {
    const access = await boards.findAccess(owner, id)
    expect(access).not.toBeNull()
    expect(await boards.changeLifecycle(owner, id, "retired", access!.revision)).toMatchObject({
      status: "committed",
      result: "saved"
    })
    // An old or independently changed deletion ceiling cannot strand durable work.
    await changeBoardGrants(
      db,
      human("parent", true),
      async (tx) => {
        await tx.execute({
          sql: "UPDATE board_permissions SET deny_deletion=1 WHERE board_id=?",
          args: [id]
        })
        return { next: true }
      },
      marker
    )
    expect(await boards.findDeleted(owner)).toEqual(
      expect.arrayContaining([expect.objectContaining({ id })])
    )
    expect(await boards.changeLifecycle(owner, id, "active", access!.revision + 1)).toMatchObject({
      status: "committed",
      result: "saved"
    })
    expect(
      await new BoardAccessService(db).resolve(owner, id, { resource: "task", action: "delete" })
    ).toMatchObject({ ok: false, errorCode: "denied" })
  }
  const reader = human("other")
  expect(await boards.findAccess(reader, "household")).toMatchObject({
    name: "Church",
    role: "member"
  })
  expect(await boards.findAccess(reader, work)).toBeNull()
})

test("copied principals/scopes fail and stale writer authority cannot be reused", async () => {
  await initialize()
  const access = new BoardAccessService(db)
  expect(
    await access.resolve({ kind: "ha_user", id: "parent" }, "household", {
      resource: "task",
      action: "read"
    })
  ).toEqual({ ok: false, errorCode: "unavailable" })
  const owner = human("parent", true)
  const resolved = await access.resolve(owner, "household", { resource: "task", action: "edit" })
  if (!resolved.ok) throw new Error("Expected admitted scope")
  await expect(
    validateBoardScope({ ...resolved.scope }, db, { resource: "task", action: "edit" })
  ).rejects.toThrow("verified BoardScope")
  await changeBoardGrants(
    db,
    human("parent", true),
    async (tx) => {
      await tx.execute(
        "UPDATE board_permissions SET deny_completion = 1 WHERE board_id = 'household'"
      )
      return { next: true }
    },
    marker
  )
  expect(
    await validateBoardScope(resolved.scope, db, { resource: "task", action: "edit" })
  ).toEqual({ ok: false, errorCode: "stale" })
})

test("legacy propose-only tokens retain proposals without generic editing or private access", async () => {
  const result = await withStartupWriteTransaction(db, async (tx) => {
    await applyStartupTaskSchema(tx)
    await tx.execute(
      `CREATE TABLE agent_tokens(id TEXT PRIMARY KEY, scopes TEXT NOT NULL, assignee_id TEXT, expires_at TEXT, revoked INTEGER NOT NULL DEFAULT 0)`
    )
    await tx.execute({
      sql: "INSERT INTO agent_tokens(id,scopes) VALUES (?,?)",
      args: ["proposer", JSON.stringify(["tasks:propose"])]
    })
    return applyStartupBoardSchema(db, tx)
  })
  await finalizeStartupBoardGrant(db, result.revision)
  const token = registerVerifiedPrincipal(
    { kind: "agent", id: "proposer", tokenId: "proposer" },
    { expiresAt: Date.now() + 60_000, administrator: false }
  )
  const access = new BoardAccessService(db)
  expect(
    await access.resolve(token, "household", { resource: "task", action: "propose" })
  ).toMatchObject({ ok: true })
  expect(await access.resolve(token, "household", { resource: "task", action: "edit" })).toEqual({
    ok: false,
    errorCode: "denied"
  })
  expect(
    await access.resolve(token, "household", { resource: "task", action: "complete" })
  ).toEqual({ ok: false, errorCode: "denied" })
  const boards = new NamedBoardRepository(db, marker)
  const created = await boards.create(human("parent", true), "Private Work")
  if (created.status !== "committed") throw new Error("Private fixture creation failed")
  expect(
    await access.resolve(token, created.result.id, { resource: "task", action: "propose" })
  ).toEqual({ ok: false, errorCode: "unavailable" })
})

test("epochless reopened schema25 without a conflicting marker auto-enrolls and finishes upgrade", async () => {
  await withStartupWriteTransaction(db, (tx) => applyStartupTaskSchema(tx))
  db.close()
  db = await openDatabaseForStartup(`file:${join(directory, "test.db")}`, { markerPath: marker })
  const result = await initialize()
  expect(result.state).toBe("ready")
  expect(result.revision).toBeTruthy()
  expect(result.applied).toEqual(["0016_ordinary_boards.mjs", CUSTOM_BOARD_KEYS_MIGRATION, TASK_EXPERIENCE_MIGRATION])
  expect(await readBoardGrantRevision(marker)).toBe(result.revision)
  expect(
    (await db.execute("SELECT value FROM app_settings WHERE key = 'schema_version'")).rows[0]?.value
  ).toBe("28")
  await validateStartupTaskSchema(db)
})

test("pre-0016 reopened schema25 with an epoch row and absent marker recovers continuity", async () => {
  const priorEpoch = "93c9b2e7-cd3b-4b29-b517-d1bdf8c52886"
  await withStartupWriteTransaction(db, async (tx) => {
    await applyStartupTaskSchema(tx)
    await tx.execute({
      sql: "INSERT INTO board_access_epoch(singleton, revision) VALUES (1, ?)",
      args: [priorEpoch]
    })
  })
  db.close()
  db = await openDatabaseForStartup(`file:${join(directory, "test.db")}`, { markerPath: marker })
  const result = await initialize()
  expect(result.state).toBe("ready")
  expect(result.revision).toBeTruthy()
  expect(result.revision).not.toBe(priorEpoch)
  expect(await readBoardGrantRevision(marker)).toBe(result.revision)
  expect(
    (await db.execute("SELECT value FROM app_settings WHERE key = 'schema_version'")).rows[0]?.value
  ).toBe("28")
  await validateStartupTaskSchema(db)
})

test("epochless reopened schema25 with a conflicting marker remains controlled pending26 without policy conversion", async () => {
  await withStartupWriteTransaction(db, (tx) => applyStartupTaskSchema(tx))
  db.close()
  await writeFile(marker, JSON.stringify({ epoch: randomUUID() }), { mode: 0o600 })
  db = await openDatabaseForStartup(`file:${join(directory, "test.db")}`, { markerPath: marker })
  const result = await initialize()
  expect(result).toMatchObject({
    state: "continuity_locked",
    pending: ["0016_ordinary_boards.mjs"],
    revision: null
  })
  expect(
    (await db.execute("SELECT value FROM app_settings WHERE key = 'schema_version'")).rows[0]?.value
  ).toBe("25")
  expect(
    (await db.execute("PRAGMA table_info(task_boards)")).rows.some(
      (row) => row.name === "storage_encoding"
    )
  ).toBe(false)
  await expect(validateStartupTaskSchema(db)).rejects.toThrow("Pending migrations")
})

test("an independently current schema25 upgrade converts policy and journals the next epoch atomically", async () => {
  let oldRevision: string | null = null
  await withStartupWriteTransaction(db, async (tx) => {
    await applyStartupTaskSchema(tx)
    oldRevision = await initializeBoardGrantContinuity(db, tx)
  })
  await finalizeStartupBoardGrant(db, oldRevision)
  db.close()
  db = await openDatabaseForStartup(`file:${join(directory, "test.db")}`, { markerPath: marker })
  const result = await initialize()
  expect(result.state).toBe("ready")
  expect(result.revision).not.toBe(oldRevision)
  expect(result.applied).toEqual(["0016_ordinary_boards.mjs", CUSTOM_BOARD_KEYS_MIGRATION, TASK_EXPERIENCE_MIGRATION])
  await validateStartupTaskSchema(db)
})

test("resource Nobody policies remain writer-time ceilings and capabilities reflect them", async () => {
  await initialize()
  await changeBoardGrants(
    db,
    human("parent", true),
    async (tx) => {
      await tx.execute({
        sql: `INSERT INTO organization_access_policies(scope,scope_id,board_id,audience,selected_users,revision)
      VALUES ('feature','routines','','nobody','[]',?)`,
        args: ["feature-policy"]
      })
      return { next: true }
    },
    marker
  )
  const access = new BoardAccessService(db)
  const actor = human("parent", true)
  const tasks = await access.resolve(actor, "household", { resource: "task", action: "read" })
  expect(tasks.ok).toBe(true)
  if (!tasks.ok) throw new Error("Task scope missing")
  expect(
    tasks.scope.capabilities.operations.some((operation) => operation.resource === "routine")
  ).toBe(false)
  expect(
    await access.resolve(actor, "household", { resource: "routine", action: "create" })
  ).toEqual({ ok: false, errorCode: "denied" })
})

test("send-only intake grants create alone and revoke without creating membership", async () => {
  await initialize()
  const owner = human("parent", true)
  const boards = new NamedBoardRepository(db, marker)
  await boards.updateMember(
    owner,
    "household",
    "parent",
    { role: "owner", denyCompletion: false, denyDeletion: false },
    ["parent"]
  )
  expect(
    await boards.updateSharing(
      owner,
      "household",
      { visibility: "restricted", sharedRole: "member", sharedAdminManagement: false },
      1,
      ["parent"]
    )
  ).toMatchObject({ result: "saved" })
  const sender = human("sender")
  await changeBoardGrants(
    db,
    human("parent", true),
    async (tx) => {
      const {
        rows: [lane]
      } = await tx.execute(
        "SELECT id FROM kanban_lanes WHERE board_id='household' AND key='pending'"
      )
      await tx.execute({
        sql: "INSERT INTO board_intakes(id,board_id,lane_id,label) VALUES ('intake','household',?,'Send work')",
        args: [String(lane!.id)]
      })
      await tx.execute(
        "INSERT INTO board_intake_senders(intake_id,sender_kind,sender_id) VALUES ('intake','ha_user','sender')"
      )
      return { next: true }
    },
    marker
  )
  expect(
    await resolveIntakeSubmissionScope(db, { kind: "ha_user", id: "sender" }, "intake")
  ).toEqual({ ok: false, errorCode: "unavailable" })
  const result = await resolveIntakeSubmissionScope(db, sender, "intake")
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error("Intake fixture failed")
  expect(result.scope.capabilities.operations).toEqual([{ resource: "task", action: "create" }])
  expect(
    await new BoardAccessService(db).resolve(sender, "household", {
      resource: "task",
      action: "read"
    })
  ).toEqual({ ok: false, errorCode: "unavailable" })
  for (const action of ["read", "edit", "complete", "delete"] as const)
    expect(await validateBoardScope(result.scope, db, { resource: "task", action })).toEqual({
      ok: false,
      errorCode: "denied"
    })
  expect(
    (await db.execute("SELECT 1 FROM board_access_grants WHERE principal_id='sender'")).rows
  ).toEqual([])
  await changeBoardGrants(
    db,
    human("parent", true),
    async (tx) => {
      await tx.execute("UPDATE board_intakes SET enabled=0 WHERE id='intake'")
      return { next: true }
    },
    marker
  )
  expect(
    await validateBoardScope(result.scope, db, { resource: "task", action: "create" })
  ).toEqual({ ok: false, errorCode: "stale" })
  expect(await resolveIntakeSubmissionScope(db, sender, "intake")).toEqual({
    ok: false,
    errorCode: "unavailable"
  })
})

test("admitted conversion preserves optional records, filter bytes and deleted label high-water", async () => {
  const result = await withStartupWriteTransaction(db, async (tx) => {
    await applyStartupTaskSchema(tx)
    await tx.execute(
      "CREATE TABLE vikunja_labels(id INTEGER PRIMARY KEY AUTOINCREMENT,title TEXT NOT NULL UNIQUE,hex_color TEXT NOT NULL DEFAULT '3f51b5')"
    )
    await tx.execute("CREATE INDEX vikunja_labels_title_idx ON vikunja_labels(title)")
    await tx.execute(
      "INSERT INTO vikunja_labels(id,title,hex_color) VALUES (1,'Existing','abcdef'),(99,'Deleted','ffffff')"
    )
    await tx.execute("DELETE FROM vikunja_labels WHERE id=99")
    await tx.execute(
      "CREATE TABLE saved_filters(id TEXT PRIMARY KEY,name TEXT NOT NULL,query_json TEXT NOT NULL DEFAULT '{}',icon TEXT NOT NULL DEFAULT '🔍',position INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"
    )
    await tx.execute("CREATE INDEX saved_filters_position_idx ON saved_filters(position)")
    await tx.execute(
      "INSERT INTO saved_filters VALUES ('saved','Private work','{\"labels\":[\"Original\"]}','🔍',7,100,101)"
    )
    await tx.execute(
      "INSERT INTO tasks(id,title,idempotency_key,request_id,created_at,updated_at,status) VALUES ('old-task','Original','original-key','original-request',100,101,'pending')"
    )
    for (const definition of Object.values(legacyTimerTables)) await tx.execute(definition)
    await tx.execute(
      "INSERT INTO pomodoro_sessions(id,task_id,started_at) VALUES ('old-session','old-task','2026-01-01T00:00:00Z'),('unowned-session',NULL,'2026-01-01T00:00:00Z')"
    )
    await tx.execute(
      "INSERT INTO time_entries(id,task_id,started_at) VALUES ('old-entry','old-task','2026-01-01T00:00:00Z')"
    )
    await tx.execute(legacyGrocyConfirmationsTable)
    await tx.execute(
      "INSERT INTO grocy_sync_confirmations(confirmation_id,task_id,grocy_entity_type,grocy_entity_id,created_at,updated_at) VALUES ('old-provider','old-task','chore','5',100,101)"
    )
    return applyStartupBoardSchema(db, tx)
  })
  await finalizeStartupBoardGrant(db, result.revision)
  await validateStartupTaskSchema(db)
  expect((await db.execute("SELECT id,title,hex_color,board_id FROM vikunja_labels")).rows).toEqual(
    [{ id: 1, title: "Existing", hex_color: "abcdef", board_id: "household" }]
  )
  expect(
    (await db.execute("SELECT seq FROM sqlite_sequence WHERE name='vikunja_labels'")).rows[0]?.seq
  ).toBe(99)
  expect(
    (
      await db.execute(
        "SELECT id,query_json,position,created_at,updated_at,board_id FROM saved_filters"
      )
    ).rows[0]
  ).toEqual({
    id: "saved",
    query_json: '{"labels":["Original"]}',
    position: 7,
    created_at: 100,
    updated_at: 101,
    board_id: "household"
  })
  expect(
    (
      await db.execute(
        "SELECT id,board_id,principal_kind,principal_id FROM pomodoro_sessions ORDER BY id"
      )
    ).rows
  ).toEqual([
    { id: "old-session", board_id: "household", principal_kind: null, principal_id: null },
    { id: "unowned-session", board_id: null, principal_kind: null, principal_id: null }
  ])
  expect(
    (await db.execute("SELECT id,board_id,principal_kind,principal_id FROM time_entries")).rows
  ).toEqual([{ id: "old-entry", board_id: "household", principal_kind: null, principal_id: null }])
  expect(
    (
      await db.execute(
        "SELECT confirmation_id,task_id,grocy_entity_id,binding_id FROM grocy_sync_confirmations"
      )
    ).rows
  ).toEqual([
    { confirmation_id: "old-provider", task_id: "old-task", grocy_entity_id: "5", binding_id: null }
  ])
})

test("only an untouched predecessor three-lane catalogue gains the missing canonical Backlog", async () => {
  const plain = randomUUID(),
    custom = randomUUID(),
    stamp = 100
  const result = await withStartupWriteTransaction(db, async (tx) => {
    await applyStartupTaskSchema(tx)
    for (const id of [plain, custom]) {
      await tx.execute({
        sql: "INSERT INTO task_boards(id,name,visibility,ticket_prefix,created_at,updated_at) VALUES (?,?, 'restricted',?, ?,?)",
        args: [id, id, id === plain ? "ABCDEFGH" : "IJKLMNOP", stamp, stamp]
      })
      await tx.execute({ sql: "INSERT INTO board_permissions(board_id) VALUES (?)", args: [id] })
      for (const [position, key, label] of [
        [0, "pending", "To Do"],
        [1, "active", "In Progress"],
        [2, "complete", "Done"]
      ] as const) {
        await tx.execute({
          sql: "INSERT INTO kanban_lanes(id,key,label,position,includes,built_in,created_at,updated_at,board_id) VALUES (?,?,?,?,?,1,?,?,?)",
          args: [
            randomUUID(),
            key,
            id === custom && key === "pending" ? "My Queue" : label,
            position,
            JSON.stringify([key]),
            stamp,
            stamp,
            id
          ]
        })
      }
    }
    return applyStartupBoardSchema(db, tx)
  })
  await finalizeStartupBoardGrant(db, result.revision)
  expect(
    (
      await db.execute({
        sql: "SELECT key FROM kanban_lanes WHERE board_id=? ORDER BY position",
        args: [plain]
      })
    ).rows.map((row) => row.key)
  ).toEqual(["backlog", "pending", "active", "complete"])
  expect(
    (
      await db.execute({
        sql: "SELECT key FROM kanban_lanes WHERE board_id=? ORDER BY position",
        args: [custom]
      })
    ).rows.map((row) => row.key)
  ).toEqual(["pending", "active", "complete"])
})

test("only current Board managers receive exact persisted sharing and denial policy", async () => {
  await initialize()
  const owner = human("owner", true)
  const boards = new NamedBoardRepository(db, marker)
  const created = await boards.create(owner, "Policy fixture")
  if (created.status !== "committed") throw new Error("Board fixture")
  expect(
    await boards.updateSharing(
      owner,
      created.result.id,
      { visibility: "shared", sharedRole: "viewer", sharedAdminManagement: false },
      1,
      [owner.id]
    )
  ).toMatchObject({ result: "saved" })
  expect((await boards.findAccess(owner, created.result.id))?.policy).toMatchObject({
    visibility: "shared",
    sharedRole: "viewer",
    sharedAdminManagement: false,
    denyCompletion: false,
    denyDeletion: false,
    denyAgentDeletion: false
  })
  const viewer = await boards.findAccess(human("viewer"), created.result.id)
  expect(viewer?.role).toBe("viewer")
  expect(viewer?.policy).toBeUndefined()
})

test("admitted conversion rejects a malformed legacy label title index", async () => {
  await expect(
    withStartupWriteTransaction(db, async (tx) => {
      await applyStartupTaskSchema(tx)
      await tx.execute(
        "CREATE TABLE vikunja_labels(id INTEGER PRIMARY KEY AUTOINCREMENT,title TEXT NOT NULL UNIQUE,hex_color TEXT NOT NULL DEFAULT '3f51b5')"
      )
      await tx.execute("CREATE INDEX vikunja_labels_title_idx ON vikunja_labels(hex_color)")
      return applyStartupBoardSchema(db, tx)
    })
  ).rejects.toThrow("Unexpected label title index")
})
