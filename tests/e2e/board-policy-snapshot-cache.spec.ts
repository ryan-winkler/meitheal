import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { expect, test } from "@playwright/test"
import { ensureSchema, getPersistenceClient, resetPersistenceForTests } from "../helpers/persistence-fixture"
import { openDatabase } from "../../apps/web/scripts/database-client.mjs"
import { BoardAccessService } from "../../apps/web/src/domains/tasks/board-access-service"
import { registerVerifiedPrincipal, validateBoardScope } from "../../apps/web/src/domains/tasks/board-scope"

const routines = { resource: "routine", action: "read" } as const

test("reused Board policy reads follow writes from other connections, own writes and new principals", async () => {
  const directory = await mkdtemp(join(tmpdir(), "meitheal-policy-cache-"))
  const path = join(directory, "policy.db")
  const original = process.env.MEITHEAL_DB_URL
  process.env.MEITHEAL_DB_URL = `file:${path}`
  resetPersistenceForTests()
  let other: ReturnType<typeof openDatabase> | undefined
  try {
    await ensureSchema()
    other = openDatabase(pathToFileURL(path).href)
    const db = getPersistenceClient()
    const member = registerVerifiedPrincipal({ kind: "ha_user", id: "member" }, { administrator: false, expiresAt: Date.now() + 60_000 })
    const access = await new BoardAccessService(db).resolve(member, "household", { resource: "task", action: "read" })
    if (!access.ok) throw new Error(access.errorCode)
    const scope = access.scope
    expect(await validateBoardScope(scope, db, routines)).toMatchObject({ ok: true })
    expect(await validateBoardScope(scope, db, routines)).toMatchObject({ ok: true })

    // Another connection narrows the feature without touching the epoch.
    await other.execute({
      sql: "INSERT INTO organization_access_policies(scope,scope_id,board_id,audience,selected_users,revision) VALUES ('feature','routines','','selected',?,1)",
      args: [JSON.stringify(["someone-else"])]
    })
    expect(await validateBoardScope(scope, db, routines)).toMatchObject({ ok: false })

    // The App's own connection widens it again.
    await db.execute({
      sql: "UPDATE organization_access_policies SET selected_users = ? WHERE scope = 'feature' AND scope_id = 'routines'",
      args: [JSON.stringify(["member"])]
    })
    expect(await validateBoardScope(scope, db, routines)).toMatchObject({ ok: true })

    // A different principal never receives another principal's decision.
    const outsider = registerVerifiedPrincipal({ kind: "ha_user", id: "outsider" }, { administrator: false, expiresAt: Date.now() + 60_000 })
    const outsiderAccess = await new BoardAccessService(db).resolve(outsider, "household", { resource: "task", action: "read" })
    if (!outsiderAccess.ok) throw new Error(outsiderAccess.errorCode)
    expect(await validateBoardScope(outsiderAccess.scope, db, routines)).toMatchObject({ ok: false })

    // Pooled read and write transactions reuse unchanged snapshots and observe committed or rolled-back changes.
    const readOne = await db.transaction("read")
    try { expect(await validateBoardScope(scope, readOne, routines)).toMatchObject({ ok: true }) } finally { readOne.close() }
    const writerOne = await db.transaction("write")
    try {
      expect(await validateBoardScope(scope, writerOne, routines)).toMatchObject({ ok: true })
      await writerOne.execute({
        sql: "UPDATE organization_access_policies SET selected_users = ? WHERE scope = 'feature' AND scope_id = 'routines'",
        args: [JSON.stringify(["nobody"])],
      })
      expect(await validateBoardScope(scope, writerOne, routines)).toMatchObject({ ok: false })
      await writerOne.rollback()
    } finally { writerOne.close() }
    const writerTwo = await db.transaction("write")
    try {
      expect(await validateBoardScope(scope, writerTwo, routines)).toMatchObject({ ok: true })
      await writerTwo.rollback()
    } finally { writerTwo.close() }
    await other.execute({
      sql: "UPDATE organization_access_policies SET selected_users = ? WHERE scope = 'feature' AND scope_id = 'routines'",
      args: [JSON.stringify(["other-user"])],
    })
    const readTwo = await db.transaction("read")
    try { expect(await validateBoardScope(scope, readTwo, routines)).toMatchObject({ ok: false }) } finally { readTwo.close() }

    // A read snapshot pinned before an external policy grant never adopts the later live token.
    const pinnedRead = await db.transaction("read")
    try {
      await pinnedRead.execute("SELECT COUNT(*) FROM tasks")
      await other.execute({
        sql: "UPDATE organization_access_policies SET selected_users = ? WHERE scope = 'feature' AND scope_id = 'routines'",
        args: [JSON.stringify(["member"])],
      })
      expect(await validateBoardScope(scope, pinnedRead, routines)).toMatchObject({ ok: false })
      expect(await validateBoardScope(scope, db, routines)).toMatchObject({ ok: true })
      expect(await validateBoardScope(scope, pinnedRead, routines)).toMatchObject({ ok: false })
    } finally { pinnedRead.close() }
  } finally {
    other?.close()
    resetPersistenceForTests()
    if (original === undefined) delete process.env.MEITHEAL_DB_URL
    else process.env.MEITHEAL_DB_URL = original
    await rm(directory, { recursive: true, force: true })
  }
})
