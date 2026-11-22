import { currentBoardScope, fixturePrincipal } from "../helpers/current-board-scope"
import { scopeCommentOwnerKey } from "../../apps/web/src/domains/tasks/board-scope"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import { TaskPinRepository } from "../../apps/web/src/domains/tasks/persistence/task-pin-repository"
import { TaskReactionRepository } from "../../apps/web/src/domains/tasks/persistence/task-reaction-repository"
import { CommentMentionRepository } from "../../apps/web/src/domains/tasks/persistence/comment-mention-repository"
import { TaskInactivityRepository } from "../../apps/web/src/domains/tasks/persistence/task-inactivity-repository"
import { changeBoardGrants } from "../../apps/web/src/domains/tasks/persistence/board-grant-fence"
import { guardClientContinuity } from "../../apps/web/src/domains/tasks/persistence/continuity-client"
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

type Client = ReturnType<typeof getPersistenceClient>

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
  area_id: null,
  custom_fields: "{}",
  start_date: null,
  end_date: null,
  progress: 0,
  color: null,
  task_type: "task",
  assigned_to: null
})

test("current marker loss closes direct task reads, count, export and writes; epochless never grants authority", async () => {
  const work = await mkdtemp(join(tmpdir(), "continuity-repository-"))
  const previous = process.env.MEITHEAL_DB_URL
  const marker = join(work, "grants.json")
  process.env.MEITHEAL_DB_URL = "file:" + join(work, "tasks.db")
  resetPersistenceForTests()
  try {
    await ensureSchema({ markerPath: marker })
    const db = getPersistenceClient()
    const scope = await currentBoardScope(db)
    const tasks = new TaskRepository(db, scope)
    await tasks.createTask(task("retained"))
    expect((await tasks.findAll({})).total).toBe(1)
    const valid = await readFile(marker)
    await rm(marker)
    await expect(tasks.findAll({})).rejects.toMatchObject({
      name: "BoardOperationError",
      errorCode: "stale"
    })
    await expect(new TaskPinRepository(db, scope).hasAny("owner")).rejects.toMatchObject({
      name: "BoardOperationError",
      errorCode: "stale"
    })
    await expect(
      new TaskPinRepository(db, scope).set("owner", "retained", true)
    ).rejects.toMatchObject({ name: "ContinuityLockedError", status: 503 })
    await expect(
      new TaskReactionRepository(db, scope).countCards(["retained"])
    ).rejects.toMatchObject({ name: "BoardOperationError", errorCode: "stale" })
    await expect(
      new TaskReactionRepository(db, scope).add(
        { taskId: "retained", commentId: null },
        "+",
        "Owner",
        scopeCommentOwnerKey(scope)!
      )
    ).rejects.toMatchObject({ name: "BoardOperationError", errorCode: "stale" })
    await expect(
      new CommentMentionRepository(db, scope).create(
        "retained",
        "Denied",
        "Owner",
        scopeCommentOwnerKey(scope)!,
        [],
        { key: "c".repeat(32), issuedAt: Date.now(), rawContent: "Denied", cutoff: 0 }
      )
    ).rejects.toMatchObject({ name: "BoardOperationError", errorCode: "stale" })
    await expect(
      new TaskInactivityRepository(db, scope).preview({
        areaId: null,
        page: 1,
        filter: "all",
        now: Date.now()
      })
    ).rejects.toMatchObject({ name: "BoardOperationError", errorCode: "stale" })
    await expect(tasks.exportAll()).rejects.toMatchObject({
      name: "BoardOperationError",
      errorCode: "stale"
    })
    await expect(tasks.createTask(task("denied"))).rejects.toMatchObject({
      name: "BoardOperationError",
      errorCode: "stale"
    })
    // Count readers with historical graceful-error behavior must reveal no count.
    await expect(tasks.getOpenTaskCount()).rejects.toMatchObject({
      name: "BoardOperationError",
      errorCode: "stale"
    })
    expect((await db.execute("SELECT id FROM tasks")).rows).toEqual([{ id: "retained" }])
    expect(await new OrganizationAccessRepository(db).policies("feature", "")).toEqual({
      status: "locked"
    })
    await writeFile(marker, valid)
    expect((await tasks.exportAll()).map((row) => row.id)).toEqual(["retained"])
    await db.execute("DELETE FROM board_access_epoch")
    await rm(marker)
    expect(await new OrganizationAccessRepository(db).policies("feature", "")).toEqual({
      status: "locked"
    })
    expect(
      await new OrganizationAccessRepository(db).change(
        { scope: "feature", id: "goals", boardId: "" },
        null,
        { audience: "nobody", users: [] },
        fixturePrincipal()
      )
    ).toEqual({ status: "locked" })
    expect(
      await new NamedBoardRepository(db).changeLifecycle(
        fixturePrincipal(),
        "household",
        "retired",
        1,
        true
      )
    ).toEqual({ status: "locked" })
    await expect(tasks.createTask(task("epochless-denied"))).rejects.toMatchObject({
      name: "BoardOperationError",
      errorCode: "stale"
    })
    expect((await db.execute("SELECT state FROM task_boards WHERE id = 'household'")).rows).toEqual(
      [{ state: "active" }]
    )
  } finally {
    resetPersistenceForTests()
    if (previous === undefined) delete process.env.MEITHEAL_DB_URL
    else process.env.MEITHEAL_DB_URL = previous
    await rm(work, { recursive: true, force: true })
  }
})

test("a worker writer loses admission before commit when the current marker disappears", async () => {
  const work = await mkdtemp(join(tmpdir(), "continuity-worker-"))
  const previous = process.env.MEITHEAL_DB_URL
  const marker = join(work, "grants.json")
  process.env.MEITHEAL_DB_URL = "file:" + join(work, "tasks.db")
  resetPersistenceForTests()
  try {
    await ensureSchema({ markerPath: marker })
    const db = getPersistenceClient()
    const scope = await currentBoardScope(db)
    const worker = guardClientContinuity(db)
    const tx = await worker.transaction("write")
    try {
      await tx.execute(
        "INSERT INTO settings(key, value) VALUES ('guarded-worker', 'must roll back')"
      )
      await rm(marker)
      await expect(tx.commit()).rejects.toThrow("continuity")
    } finally {
      tx.close()
    }
    expect(
      (await db.execute("SELECT value FROM settings WHERE key = 'guarded-worker'")).rows
    ).toEqual([])
  } finally {
    resetPersistenceForTests()
    if (previous === undefined) delete process.env.MEITHEAL_DB_URL
    else process.env.MEITHEAL_DB_URL = previous
    await rm(work, { recursive: true, force: true })
  }
})

for (const readMode of ["read", "deferred"] as const) {
  test(`an open ${readMode} snapshot cannot publish old pins while a committed retirement awaits marker publication`, async () => {
    const work = await mkdtemp(join(tmpdir(), "continuity-read-snapshot-"))
    const previous = process.env.MEITHEAL_DB_URL
    const marker = join(work, "grants.json")
    process.env.MEITHEAL_DB_URL = "file:" + join(work, "tasks.db")
    resetPersistenceForTests()
    let releaseRead!: () => void
    let counted!: () => void
    const readHeld = new Promise<void>((resolve) => {
      counted = resolve
    })
    const readRelease = new Promise<void>((resolve) => {
      releaseRead = resolve
    })
    let releasePublication!: () => void
    let committed!: () => void
    const publicationHeld = new Promise<void>((resolve) => {
      committed = resolve
    })
    const publicationRelease = new Promise<void>((resolve) => {
      releasePublication = resolve
    })
    let change: Promise<unknown> | undefined
    let read: Promise<unknown> | undefined
    try {
      await ensureSchema({ markerPath: marker })
      const db = getPersistenceClient()
      const scope = await currentBoardScope(db)
      await new TaskRepository(db, scope).createTask(task("private-pinned-title"))
      await new TaskPinRepository(db, scope).set("owner", "private-pinned-title", true)
      const markerBefore = await readFile(marker, "utf8")
      const reader = new Proxy(db, {
        get(target, property) {
          if (property === "transaction")
            return async (mode: "read" | "write" | "deferred") => {
              const tx = await target.transaction(mode)
              return new Proxy(tx, {
                get(transaction, key) {
                  if (key === "execute")
                    return async (...args: unknown[]) => {
                      const result = await Reflect.apply(transaction.execute, transaction, args)
                      const input = args[0] as string | { sql: string }
                      if (
                        (typeof input === "string" ? input : input.sql).includes(
                          "COUNT(*) AS total FROM task_pins"
                        )
                      ) {
                        counted()
                        await readRelease
                      }
                      return result
                    }
                  const value = Reflect.get(transaction, key)
                  return typeof value === "function" ? value.bind(transaction) : value
                }
              })
            }
          const value = Reflect.get(target, property)
          return typeof value === "function" ? value.bind(target) : value
        }
      }) as Client
      read =
        readMode === "read"
          ? new TaskPinRepository(reader, scope).list("owner", 1)
          : (async () => {
              const tx = await guardClientContinuity(reader).transaction("deferred")
              try {
                return await tx.execute("SELECT COUNT(*) AS total FROM task_pins")
              } finally {
                tx.close()
              }
            })()
      // Attach rejection handling immediately while the adversarial writer is gated.
      const outcome = read.then(
        (value) => ({ value }),
        (error) => ({ error })
      )
      await readHeld
      let writers = 0
      const writer = new Proxy(db, {
        get(target, property) {
          if (property === "transaction")
            return async (mode: "read" | "write" | "deferred") => {
              if (++writers === 2) {
                committed()
                await publicationRelease
              }
              return target.transaction(mode)
            }
          const value = Reflect.get(target, property)
          return typeof value === "function" ? value.bind(target) : value
        }
      }) as Client
      change = changeBoardGrants(
        writer,
        fixturePrincipal(),
        async (tx) => {
          await tx.execute("UPDATE task_boards SET state = 'retired' WHERE id = 'household'")
          return { next: true }
        },
        marker
      )
      await publicationHeld
      expect(await readFile(marker, "utf8")).toBe(markerBefore)
      expect(
        (await db.execute("SELECT state FROM task_boards WHERE id = 'household'")).rows[0]?.state
      ).toBe("retired")
      releaseRead()
      const result = await outcome
      expect("error" in result, "the old pin snapshot must be withheld").toBe(true)
      if ("error" in result) expect(String(result.error)).toContain("continuity")
    } finally {
      releaseRead?.()
      releasePublication?.()
      await Promise.allSettled([read, change])
      resetPersistenceForTests()
      if (previous === undefined) delete process.env.MEITHEAL_DB_URL
      else process.env.MEITHEAL_DB_URL = previous
      await rm(work, { recursive: true, force: true })
    }
  })
}

test("an explicitly read-only governed batch cannot write through its continuity wrapper", async () => {
  const work = await mkdtemp(join(tmpdir(), "continuity-batch-mode-"))
  const previous = process.env.MEITHEAL_DB_URL
  process.env.MEITHEAL_DB_URL = "file:" + join(work, "tasks.db")
  resetPersistenceForTests()
  try {
    await ensureSchema({ markerPath: join(work, "grants.json") })
    const db = getPersistenceClient()
    const scope = await currentBoardScope(db)
    const reader = guardClientContinuity(db)
    expect(
      (await reader.batch(["SELECT COUNT(*) AS total FROM tasks"], "read"))[0]?.rows[0]?.total
    ).toBe(0)
    await expect(
      reader.batch(
        ["INSERT INTO settings(key, value) VALUES ('read-only-batch', 'must not persist')"],
        "read"
      )
    ).rejects.toThrow(/readonly|read.only/i)
    expect(
      (await db.execute("SELECT value FROM settings WHERE key = 'read-only-batch'")).rows
    ).toEqual([])
  } finally {
    resetPersistenceForTests()
    if (previous === undefined) delete process.env.MEITHEAL_DB_URL
    else process.env.MEITHEAL_DB_URL = previous
    await rm(work, { recursive: true, force: true })
  }
})
