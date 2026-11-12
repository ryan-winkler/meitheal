import { execFileSync, type ExecFileSyncOptions } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath } from "node:url"
import { expect, test as base } from "@playwright/test"
import { ensureSchema, getPersistenceClient, getSchemaVersion, resetPersistenceForTests } from "../../apps/web/src/domains/tasks/persistence/store"
import { inactivityDayMs as day, inactivityRuleActor } from "../../apps/web/src/domains/tasks/persistence/task-inactivity-query"
import { TaskInactivityRepository } from "../../apps/web/src/domains/tasks/persistence/task-inactivity-repository"
import { TaskRepository } from "../../apps/web/src/domains/tasks/persistence/task-repository"
import { sweepInactiveTasks } from "../../apps/web/src/domains/tasks/task-inactivity-scheduler"

type Database = ReturnType<typeof getPersistenceClient>
const actor = { id: inactivityRuleActor, type: "system", requestId: "inactivity-store-spec" } as const
const now = Date.now() + 1000

const test = base.extend<{ db: Database; inactivity: TaskInactivityRepository }>({
  db: async ({}, use) => {
    const previous = process.env.MEITHEAL_DB_URL
    const dir = await mkdtemp(join(tmpdir(), "meitheal-inactivity-"))
    process.env.MEITHEAL_DB_URL = `file:${join(dir, "tasks.db")}`
    resetPersistenceForTests()
    try {
      await ensureSchema()
      await use(getPersistenceClient())
    } finally {
      resetPersistenceForTests()
      if (previous === undefined) delete process.env.MEITHEAL_DB_URL
      else process.env.MEITHEAL_DB_URL = previous
      await rm(dir, { recursive: true, force: true })
    }
  },
  inactivity: async ({ db }, use) => { await use(new TaskInactivityRepository(db)) },
})

function seed(db: Database, id: string, when: string | number, area = "default", status = "pending") {
  return db.execute({
    sql: `INSERT INTO tasks (id, title, request_id, idempotency_key, area_id, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [id, id, id, id, area, status, when, when],
  })
}

function insertArea(db: Database, id: string) {
  return db.execute({
    sql: "INSERT INTO areas (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
    args: [id, id, now, now],
  })
}

function preview(repo: TaskInactivityRepository, areaId: string | null = null, proposed?: number, page = 1) {
  return repo.preview({ areaId, now, filter: "all", page, ...(proposed === undefined ? {} : { proposed }) })
}

async function setPolicy(repo: TaskInactivityRepository, areaId: string | null, days: number) {
  const current = await preview(repo, areaId)
  expect(current.areaExists).toBe(true)
  const saved = await repo.savePolicy({
    areaId, days, expectedRevision: current.policy.revision as string | null,
    expectedDefaultRevision: current.defaultPolicy.revision as string | null,
    areaGeneration: current.areaGeneration, expectedAreaCatalogRevision: current.areaCatalogRevision,
  })
  expect(saved.status).toBe("saved")
  return current
}

test("starts off, applies elapsed day boundaries, and honors explicit scope", async ({ db, inactivity }) => {
  expect(getSchemaVersion()).toBe(18)
  await insertArea(db, "other")
  await seed(db, "ready", new Date(now - 8 * day).toISOString())
  await seed(db, "upcoming", now - day, "default", "todo")
  await seed(db, "later", now - day + 1, "default", "in_progress")
  await seed(db, "other-card", now - 30 * day, "other")
  await seed(db, "protected-status", now - 30 * day, "default", "backlog")
  await seed(db, "unknown-area", now - 30 * day, "orphan")
  await seed(db, "future", now + day)
  await seed(db, "bad-clock", "2026-14-77")
  expect(await inactivity.hasEnabledPolicy()).toBe(false)
  expect(await inactivity.hasEnabledPolicy(null)).toBe(false)
  expect((await preview(inactivity)).tasks).toEqual([])
  expect(await sweepInactiveTasks(db, now)).toBe(0)

  await setPolicy(inactivity, "other", 0)
  const simulation = await preview(inactivity, null, 8, 100_000)
  expect(simulation.page).toBe(1)
  expect(simulation.tasks.map(row => [row.id, row.deadline])).toEqual([["ready", now], ["upcoming", now + 7 * day]])
  expect(await inactivity.hasEnabledPolicy()).toBe(false)

  await setPolicy(inactivity, null, 8)
  expect((await preview(inactivity, "default")).policy.days).toBe(-1)
  expect(await inactivity.hasEnabledPolicy("default")).toBe(true)
  expect(await inactivity.hasEnabledPolicy("other")).toBe(false)
  expect((await inactivity.preview({ areaId: null, now, filter: "ready", page: 1 })).total).toBe(1)
  expect((await inactivity.preview({ areaId: null, now, filter: "upcoming", page: 1 })).total).toBe(1)
  expect([...(await inactivity.boardCues(["upcoming", "other-card"], now)).cues]).toEqual([["upcoming", now + 7 * day]])
})

test("guards stale defaults, inheritance tombstones, and same-timestamp Area recreation", async ({ db, inactivity }) => {
  await insertArea(db, "reused")
  const before = await preview(inactivity, "reused")
  const save = (scope: Awaited<ReturnType<typeof preview>>, days: number) => inactivity.savePolicy({
    areaId: "reused", days, areaGeneration: scope.areaGeneration, expectedAreaCatalogRevision: null,
    expectedRevision: scope.policy.revision as string | null,
    expectedDefaultRevision: scope.defaultPolicy.revision as string | null,
  })
  await setPolicy(inactivity, null, 12)
  expect((await save(before, 1)).status).toBe("stale")
  const inherited = await preview(inactivity, "reused")
  expect((await save(inherited, -1)).status).toBe("saved")
  expect((await save(inherited, 1)).status).toBe("stale")
  const old = await preview(inactivity, "reused")
  expect(old.policy.revision).toMatch(/^[0-9a-f]{32}$/)
  await db.execute("DELETE FROM areas WHERE id = 'reused'")
  expect((await save(old, 1)).status).toBe("missing")
  await insertArea(db, "reused")
  const replacement = await preview(inactivity, "reused")
  expect(replacement.areaGeneration).not.toBe(old.areaGeneration)
  expect(replacement.policy.revision).toBeNull()
  expect((await save({ ...replacement, areaGeneration: old.areaGeneration }, 1)).status).toBe("stale")
  expect((await save(replacement, 1)).status).toBe("saved")
})

test("protects scheduled or routine work and rechecks comment and policy races", async ({ db, inactivity }) => {
  await setPolicy(inactivity, null, 1)
  const old = now - 30 * day
  await seed(db, "new-comment", old)
  await seed(db, "date-added", old)
  await seed(db, "policy-race", old)
  for (const field of ["due_date", "reminder_at", "start_date", "end_date", "time_block_start", "time_block_end",
    "recurrence_rule", "routine_template_id", "spawned_for_date", "source_template_id"]) {
    await seed(db, field, old)
    await db.execute(`UPDATE tasks SET ${field} = 'preserve' WHERE id = '${field}'`)
  }
  await seed(db, "calendar", old)
  await db.execute(`INSERT INTO calendar_confirmations (confirmation_id, task_id, request_id, created_at)
    VALUES ('c1', 'calendar', 'cal', ${old})`)
  await seed(db, "routine-instance", old)
  await db.execute("UPDATE tasks SET task_kind = 'routine_instance' WHERE id = 'routine-instance'")
  await seed(db, "ascii-space", old)
  await db.execute("UPDATE tasks SET reminder_at = char(9,10,13,32) WHERE id = 'ascii-space'")

  const candidates = new Map((await inactivity.candidates(now)).map(candidate => [candidate.id, candidate]))
  expect([...candidates.keys()]).toEqual(["ascii-space", "date-added", "new-comment", "policy-race"])
  const tasks = new TaskRepository(db)
  await db.execute("INSERT INTO comments (task_id, content) VALUES ('new-comment', 'A recent comment')")
  await db.execute("UPDATE comments SET content = 'An edit' WHERE task_id = 'new-comment'")
  await db.execute("DELETE FROM comments WHERE task_id = 'new-comment'")
  await db.execute("UPDATE tasks SET due_date = '2026-12-01' WHERE id = 'date-added'")
  const move = (id: string) => tasks.setDeferral(id, true, { ...candidates.get(id)!, inactivityNow: now }, actor)
  expect(await move("new-comment")).toEqual({ ok: false, errorCode: "ineligible" })
  expect(await move("date-added")).toEqual({ ok: false, errorCode: "ineligible" })
  expect((await move("ascii-space")).ok).toBe(true)
  await setPolicy(inactivity, null, 0)
  expect(await move("policy-race")).toEqual({ ok: false, errorCode: "ineligible" })
  expect((await db.execute("SELECT task_id FROM task_activity_log WHERE actor = 'inactivity-rule'")).rows.map(row => row.task_id))
    .toEqual(["ascii-space"])
})

test("sweeps at most 25, keeps one audit per move, and restarts the clock on Resume", async ({ db, inactivity }) => {
  await setPolicy(inactivity, null, 1)
  for (let i = 0; i < 26; i++) await seed(db, `card-${String(i).padStart(2, "0")}`, now - 3 * day + i, "default", "active")
  expect((await preview(inactivity, null, undefined, 10)).tasks.map(task => task.id)).toEqual(["card-25"])
  expect(await sweepInactiveTasks(db, now)).toBe(25)
  expect(await sweepInactiveTasks(db, now + 1)).toBe(1)
  expect(await sweepInactiveTasks(db, now + 2)).toBe(0)
  const tasks = new TaskRepository(db)
  expect((await tasks.findDeferredPage(1)).tasks.every(task => task.automatic)).toBe(true)
  const deferred = await tasks.findById("card-00")
  expect(deferred?.status).toBe("active")
  expect(deferred?.deferred_at).toBe(now)
  expect(deferred?.updated_at).toBe(now - 3 * day)
  const resumed = await tasks.setDeferral("card-00", false, {
    updatedAt: now - 3 * day, revision: deferred!.deferral_revision,
  }, { id: "member", type: "human", requestId: "resume" })
  expect(resumed.ok).toBe(true)
  const touch = Number((await db.execute("SELECT inactivity_touched_at FROM tasks WHERE id = 'card-00'")).rows[0]?.inactivity_touched_at)
  expect(await sweepInactiveTasks(db, touch + day - 1)).toBe(0)
  expect(await sweepInactiveTasks(db, touch + day)).toBe(1)
  const { rows } = await db.execute("SELECT COUNT(*) AS n FROM task_activity_log WHERE actor = 'inactivity-rule'")
  expect(Number(rows[0]?.n)).toBe(27)
})

for (const behavior of ["IGNORE", "ABORT"] as const) {
  test(`rolls back the move when an audit trigger uses RAISE(${behavior})`, async ({ db, inactivity }) => {
    await setPolicy(inactivity, null, 1)
    await seed(db, "audit-fault", now - 3 * day)
    const failure = behavior === "IGNORE" ? "IGNORE" : "ABORT, 'test audit failure'"
    await db.execute(`CREATE TRIGGER reject_inactivity_audit BEFORE INSERT ON task_activity_log
      WHEN NEW.actor = 'inactivity-rule' BEGIN SELECT RAISE(${failure}); END`)
    await expect(sweepInactiveTasks(db, now)).rejects.toThrow()
    const { rows } = await db.execute("SELECT deferred_at, deferral_revision FROM tasks WHERE id = 'audit-fault'")
    expect(rows[0]).toMatchObject({ deferred_at: null, deferral_revision: null })
    await db.execute("DROP TRIGGER reject_inactivity_audit")
    expect(await sweepInactiveTasks(db, now)).toBe(1)
  })
}

test("rolls back when an AFTER INSERT trigger removes the audit event", async ({ db, inactivity }) => {
  await setPolicy(inactivity, null, 1)
  await seed(db, "removed-audit", now - 3 * day)
  await db.execute(`CREATE TRIGGER remove_inactivity_audit AFTER INSERT ON task_activity_log
    WHEN NEW.actor = 'inactivity-rule' BEGIN DELETE FROM task_activity_log WHERE id = NEW.id; END`)
  await expect(sweepInactiveTasks(db, now)).rejects.toThrow("one matching audit row")
  const { rows } = await db.execute("SELECT deferred_at FROM tasks WHERE id = 'removed-audit'")
  expect(rows[0]?.deferred_at).toBeNull()
})

test("rejects a migration trigger with altered SQL string literals", async ({ db }) => {
  const { installTaskInactivityTriggers } = await import("../../apps/web/drizzle/migrations/0007_task_inactivity.mjs")
  const original = await db.execute("SELECT sql FROM sqlite_schema WHERE name = 'tasks_inactivity_touch'")
  await db.execute("DROP TRIGGER tasks_inactivity_touch")
  await db.execute(String(original.rows[0]?.sql).replace("'complete'", "'COMPLETE'"))
  const transaction = await db.transaction("write")
  try {
    await expect(installTaskInactivityTriggers(transaction)).rejects.toThrow("Unexpected task inactivity trigger")
  } finally {
    transaction.close()
  }
})

test("keeps active tasks with open prerequisites on the board, including dependency races", async ({ db, inactivity }) => {
  await setPolicy(inactivity, null, 1)
  const then = now - 3 * day
  await seed(db, "active-task", then, "default", "in_progress")
  await seed(db, "prerequisite", then, "default", "backlog")
  const candidate = (await inactivity.candidates(now))[0]!
  expect(candidate.id).toBe("active-task")
  await db.execute(`INSERT INTO task_links (source_task_id, target_task_id, link_type, created_at)
    VALUES ('prerequisite', 'active-task', 'blocks', ${then})`)
  expect(await new TaskRepository(db).setDeferral(candidate.id, true, { ...candidate, inactivityNow: now }, actor))
    .toEqual({ ok: false, errorCode: "ineligible" })
  expect((await preview(inactivity)).total).toBe(0)
  expect(await sweepInactiveTasks(db, now)).toBe(0)
  await db.execute("UPDATE tasks SET status = 'complete' WHERE id = 'prerequisite'")
  expect(await sweepInactiveTasks(db, now)).toBe(1)
})

test("rejects a shared policy preview if an Area starts inheriting meanwhile", async ({ db, inactivity }) => {
  await insertArea(db, "protected-area")
  await seed(db, "old-protected-task", now - 30 * day, "protected-area")
  await setPolicy(inactivity, "protected-area", 0)
  const simulated = await preview(inactivity, null, 1)
  expect(simulated.total).toBe(0)
  await setPolicy(inactivity, "protected-area", -1)
  expect(await inactivity.savePolicy({
    areaId: null, days: 1, expectedRevision: simulated.policy.revision,
    expectedDefaultRevision: simulated.defaultPolicy.revision,
    areaGeneration: null, expectedAreaCatalogRevision: simulated.areaCatalogRevision,
  })).toEqual({ status: "stale" })
  expect(await sweepInactiveTasks(db, now)).toBe(0)
})

test("fails closed for a persisted revision with trailing NUL bytes", async ({ db, inactivity }) => {
  await seed(db, "old-malformed-policy", now - 30 * day)
  await setPolicy(inactivity, null, 1)
  await expect(db.execute("UPDATE task_inactivity_policy SET revision = revision || char(0) || 'invalid'"))
    .rejects.toThrow()
  await db.execute("PRAGMA ignore_check_constraints=ON")
  await db.execute("UPDATE task_inactivity_policy SET revision = revision || char(0) || 'invalid'")
  await db.execute("PRAGMA ignore_check_constraints=OFF")
  await expect(preview(inactivity)).rejects.toThrow("Malformed inactivity policy")
  expect(await inactivity.hasEnabledPolicy()).toBe(false)
  expect(await sweepInactiveTasks(db, now)).toBe(0)
  await db.execute("UPDATE task_inactivity_policy SET revision = substr(revision, 1, 31) || char(0)")
  await expect(preview(inactivity)).rejects.toThrow("Malformed inactivity policy")
  expect(await inactivity.hasEnabledPolicy()).toBe(false)
  expect(await sweepInactiveTasks(db, now)).toBe(0)
})

test("keeps preview and visible board cues bounded with 1,000 and 2,000 tasks", async ({ db, inactivity }) => {
  await setPolicy(inactivity, null, 1)
  const when = now - 20 * day
  for (const size of [1000, 2000]) {
    await db.execute({
      sql: `WITH RECURSIVE batch(n) AS (
        VALUES (CAST(? AS INTEGER)) UNION ALL SELECT n + 1 FROM batch WHERE n + 1 < ?
      ) INSERT INTO tasks (id, title, request_id, idempotency_key, area_id, status, created_at, updated_at, last_activity_spike_at)
        SELECT 'bench-' || n, 'Synthetic task ' || n, 'bench-' || n, 'bench-' || n, 'default', 'pending', ?, ?, ? FROM batch`,
      args: [size - 1000, size, when, when, when],
    })
    const ids = Array.from({ length: 100 }, (_, i) => `bench-${i}`)
    const previewMs: number[] = []
    const cuesMs: number[] = []
    for (let sample = 0; sample < 6; sample++) {
      const start = performance.now()
      const result = await inactivity.preview({ areaId: null, now, filter: "stalled", page: 1 })
      const previewEnd = performance.now()
      const { cues, stalled } = await inactivity.boardCues(ids, now)
      const cuesEnd = performance.now()
      expect(result.total).toBe(size)
      expect(result.tasks).toHaveLength(25)
      expect(cues.size).toBe(100)
      expect(stalled.size).toBe(100)
      expect(result.tasks.every(row => row.stall_since === when + 14 * day)).toBe(true)
      const ordered = result.tasks.map(row => row.id)
      expect(ordered).toEqual([...ordered].sort())
      if (sample > 0) {
        previewMs.push(Number((previewEnd - start).toFixed(2)))
        cuesMs.push(Number((cuesEnd - previewEnd).toFixed(2)))
      }
    }
    console.log(JSON.stringify({ taskCount: size, previewRows: 25, cueRows: 100, previewMs, cuesMs }))
  }
})

test("qualifying transitions and verified multi-person comment bursts record a spike atomically", async ({ db, inactivity }) => {
  await setPolicy(inactivity, null, 30)
  await seed(db, "shared", now - 20 * day)
  const marker = async () => (await db.execute("SELECT last_activity_spike_at AS value FROM tasks WHERE id = 'shared'")).rows[0]?.value
  const repo = new TaskRepository(db)
  expect(await marker()).toBeNull()
  await repo.addComment("shared", "First verified comment", "Alice", "verified-one", true)
  await repo.addComment("shared", "Second from the same person", "Alice", "verified-one", true)
  await repo.addComment("shared", "Agent does not count", "Bot", "automation")
  expect(await marker()).toBeNull()
  const received = await repo.addComment("shared", "Third verified comment", "Bob", "verified-two", true)
  expect(received).not.toHaveProperty("inactivity_spike_human")
  expect(await marker()).toEqual(expect.any(Number))

  const oldMarker = now - 15 * day
  await db.execute({ sql: "UPDATE tasks SET last_activity_spike_at = ? WHERE id = 'shared'", args: [oldMarker] })
  await db.execute("UPDATE tasks SET assigned_to = 'resident' WHERE id = 'shared'")
  expect(Number(await marker())).toBeGreaterThan(oldMarker)
  await db.execute({ sql: "UPDATE tasks SET last_activity_spike_at = ? WHERE id = 'shared'", args: [oldMarker] })
  await db.execute("UPDATE tasks SET assigned_to = ' resident ' WHERE id = 'shared'")
  expect(await marker()).toBe(oldMarker)
  await db.execute("UPDATE tasks SET status = 'complete' WHERE id = 'shared'")
  expect(await marker()).toBe(oldMarker)
  await db.execute("UPDATE tasks SET status = 'pending' WHERE id = 'shared'")
  expect(Number(await marker())).toBeGreaterThan(oldMarker)
})

test("stalled is independent of closing soon and protected work can stall without being deferred", async ({ db, inactivity }) => {
  await setPolicy(inactivity, null, 30)
  const boundary = now - 14 * day
  await seed(db, "protected", boundary)
  await seed(db, "overlap", now - 24 * day)
  await seed(db, "later", boundary + 1)
  await seed(db, "never", now - 28 * day)
  await db.execute({
    sql: `UPDATE tasks SET last_activity_spike_at = ? WHERE id IN ('protected', 'overlap', 'later')`,
    args: [boundary],
  })
  await db.execute("UPDATE tasks SET due_date = '2026-12-12' WHERE id = 'protected'")
  const result = await inactivity.preview({ areaId: null, now, filter: "stalled", page: 1 })
  expect(result.tasks.map(row => [row.id, row.stall_since, row.deadline])).toEqual([
    ["overlap", now, now + 6 * day], ["protected", now, null],
  ])
  const { cues, stalled } = await inactivity.boardCues(["protected", "overlap", "later", "never"], now)
  expect(Object.fromEntries(cues)).toEqual({ overlap: now + 6 * day, never: now + 2 * day })
  expect(Object.fromEntries(stalled)).toEqual({ overlap: now, protected: now })
  expect(await sweepInactiveTasks(db, now)).toBe(0)
})

test("an ordinary packaged CLI rerun rejects a CHECK that only appears in a schema comment", async () => {
  const dir = await mkdtemp(join(tmpdir(), "meitheal-stall-cli-"))
  const database = join(dir, "tasks.db")
  const options: ExecFileSyncOptions = {
    cwd: fileURLToPath(new URL("../../apps/web", import.meta.url)),
    env: { ...process.env, MEITHEAL_DB_URL: `file:${database}` },
    stdio: ["ignore", "pipe", "pipe"],
  }
  const migrate = () => execFileSync(process.execPath, ["scripts/migrate.mjs"], options)
  try {
    expect(migrate().toString()).toContain("0008_task_stall.mjs")
    expect(migrate().toString()).toContain("No migrations to apply")
    const local = new DatabaseSync(database)
    try {
      const definition = "last_activity_spike_at INTEGER CHECK(last_activity_spike_at IS NULL OR (typeof(last_activity_spike_at) = 'integer' AND last_activity_spike_at BETWEEN 1 AND 9007199254740991))"
      local.exec("DROP TRIGGER tasks_stall_initial_assignment; DROP TRIGGER tasks_stall_transition; DROP TRIGGER comments_stall_burst")
      local.exec("ALTER TABLE tasks DROP COLUMN last_activity_spike_at")
      local.exec(`ALTER TABLE tasks ADD COLUMN last_activity_spike_at INTEGER /* ${definition} */`)
    } finally {
      local.close()
    }
    expect(migrate).toThrow(/Unexpected stall column: tasks.last_activity_spike_at/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("the comment burst window includes its exact endpoints and excludes adjacent milliseconds", async ({ db, inactivity }) => {
  await setPolicy(inactivity, null, 30)
  const windowMs = 30 * day * 33 / 100
  for (const [id, lowerOffset, upperOffset, matches] of [
    ["inclusive", 0, 0, true],
    ["too-old", -1, 0, false],
    ["future-comment", 0, 1, false],
  ] as const) {
    await seed(db, id, now - 20 * day)
    await db.execute({
      sql: `WITH clock(ms) AS (VALUES (unixepoch('now') * 1000 + CAST(substr(strftime('%f','now'), 4, 3) AS INTEGER))),
        events(seq, owner, delta) AS (VALUES (1, 'alice', ?), (2, 'alice', -1000), (3, 'bob', ?))
        INSERT INTO comments (task_id, content, author, owner_key, created_at, inactivity_spike_human)
        SELECT ?, owner, owner, owner, strftime('%Y-%m-%d %H:%M:%f', (ms + delta) / 1000.0, 'unixepoch'), 1
        FROM events CROSS JOIN clock ORDER BY seq`,
      args: [-windowMs + lowerOffset, upperOffset, id],
    })
    const { rows } = await db.execute({ sql: "SELECT last_activity_spike_at FROM tasks WHERE id = ?", args: [id] })
    expect(typeof rows[0]?.last_activity_spike_at === "number", id).toBe(matches)
  }
})
