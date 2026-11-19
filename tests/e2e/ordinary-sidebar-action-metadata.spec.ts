import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import { ensureSchema, getPersistenceClient, resetPersistenceForTests } from "../helpers/persistence-fixture"
import { currentBoardScope, fixturePrincipal } from "../helpers/current-board-scope"
import { startCoreRosterFixture } from "../helpers/core-roster-fixture"
import { NamedBoardRepository } from "../../apps/web/src/domains/tasks/persistence/named-board-repository"
import { changeBoardGrants } from "../../apps/web/src/domains/tasks/persistence/board-grant-fence"
import { HierarchyRepository } from "../../apps/web/src/domains/tasks/persistence/hierarchy-repository"
import { scopeBoardAccess } from "../../apps/web/src/domains/tasks/board-scope"
import { runWithIngressTransport } from "../../apps/web/scripts/ingress-transport.mjs"
import { withOrganizationAvailability } from "../../apps/web/src/lib/organization-request-context"
import type { OrganizationFeature } from "../../apps/web/src/lib/organization-availability"
import { GET as hierarchyPage } from "../../apps/web/src/pages/api/boards/[id]/index"

let folder: string, stop: () => Promise<void>
const originalUrl = process.env.MEITHEAL_DB_URL
const transport = { peer: "172.30.32.2", fromSupervisor: true, identityHeadersSafe: true, configuredPath: "/api/hassio_ingress/fixture" }
test.beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), "sidebar-actions-"))
  process.env.MEITHEAL_DB_URL = "file:" + join(folder, "work.db")
  resetPersistenceForTests()
  await ensureSchema()
  stop = await startCoreRosterFixture(["owner", "viewer"])
})
test.afterEach(async () => {
  await stop()
  resetPersistenceForTests()
  if (originalUrl === undefined) delete process.env.MEITHEAL_DB_URL
  else process.env.MEITHEAL_DB_URL = originalUrl
  await rm(folder, { recursive: true, force: true })
})
async function read(boardId: string, user: string, features: OrganizationFeature[] = ["organizer", "groups", "projects"]) {
  const url = new URL(`http://localhost/api/boards/${boardId}?view=groups`)
  const context = { url, request: new Request(url), params: { id: boardId }, locals: { behindIngress: true, hassUserId: user, hassIsAdmin: user === "owner" } } as unknown as Parameters<typeof hierarchyPage>[0]
  return runWithIngressTransport(transport, () => withOrganizationAvailability({ locked: false, needsVerification: false,
    includes: feature => features.includes(feature), revision: () => null,
  }, () => hierarchyPage(context)))
}
for (const encoding of ["legacy", "scoped"] as const) {
  test(`Hierarchy actions reflect current actor permissions without a special example Board: ${encoding}`, async () => {
    const db = getPersistenceClient(), owner = fixturePrincipal(), boards = new NamedBoardRepository(db)
    const made = await boards.create(owner, "Editable example")
    if (made.status !== "committed") throw new Error("Board setup failed")
    const boardId = encoding === "legacy" ? "household" : made.result.id
    expect(await boards.updateMember(owner, boardId, "owner", { role: "owner", denyCompletion: false, denyDeletion: false }, ["owner", "viewer"])).toMatchObject({ result: "saved" })
    const access = scopeBoardAccess(await currentBoardScope(db, boardId, owner))
    expect((await boards.updateSharing(owner, boardId, { visibility: "shared", sharedRole: "viewer", sharedAdminManagement: false }, access.revision, ["owner", "viewer"])).status).toBe("committed")
    const hierarchy = new HierarchyRepository(db, await currentBoardScope(db, boardId, owner))
    await hierarchy.createArea({ id: crypto.randomUUID(), name: "User-defined area" })
    const writable = await read(boardId, "owner")
    expect(writable.status).toBe(200)
    const writableBody = await writable.json()
    expect(writableBody.actions).toEqual(["area/create", "area/delete", "area/edit", "project/create", "project/delete", "project/edit", "task/create", "task/delete", "task/edit"])
    const viewer = await read(boardId, "viewer")
    expect(viewer.status).toBe(200)
    expect((await viewer.json()).actions).toEqual([])
    const clamped = await read(boardId, "owner", ["organizer", "groups"])
    expect(clamped.status).toBe(200)
    expect((await clamped.json()).actions).toEqual(["area/create", "area/delete", "area/edit", "task/create", "task/delete", "task/edit"])
    expect(clamped.headers.get("x-meitheal-board-view")).not.toBe(writable.headers.get("x-meitheal-board-view"))
    expect(viewer.headers.get("cache-control")).toBe("private, no-store")
  })
}

for (const encoding of ["legacy", "scoped"] as const) {
  test(`Removing the shared administrator fallback retains an active owner: ${encoding}`, async () => {
    const db = getPersistenceClient(), owner = fixturePrincipal(), boards = new NamedBoardRepository(db)
    const made = await boards.create(owner, "Any name")
    if (made.status !== "committed") throw new Error("Board setup failed")
    const boardId = encoding === "legacy" ? "household" : made.result.id
    let access = scopeBoardAccess(await currentBoardScope(db, boardId, owner))
    expect(await boards.updateSharing(owner, boardId, { visibility: "shared", sharedRole: "member", sharedAdminManagement: true }, access.revision, ["owner", "viewer"])).toMatchObject({ result: "saved" })
    // Model a current migrated/imported Board with only the deliberately enabled
    // administrator fallback, using the genuine current journal in a fresh fixture.
    await changeBoardGrants(db, owner, async writer => {
      await writer.execute({ sql: "DELETE FROM board_access_grants WHERE board_id=? AND role='owner'", args: [boardId] })
      return { next: true }
    })
    access = scopeBoardAccess(await currentBoardScope(db, boardId, owner))
    expect(await boards.updateSharing(owner, boardId, { visibility: "shared", sharedRole: "viewer", sharedAdminManagement: false }, access.revision, ["owner", "viewer"])).toMatchObject({ result: "last-owner" })
    expect(scopeBoardAccess(await currentBoardScope(db, boardId, owner)).policy?.sharedAdminManagement).toBe(true)
    expect(await boards.updateMember(owner, boardId, "owner", { role: "owner", denyCompletion: false, denyDeletion: false }, ["owner", "viewer"])).toMatchObject({ result: "saved" })
    access = scopeBoardAccess(await currentBoardScope(db, boardId, owner))
    expect(await boards.updateSharing(owner, boardId, { visibility: "shared", sharedRole: "viewer", sharedAdminManagement: false }, access.revision, ["owner", "viewer"])).toMatchObject({ result: "saved" })
    expect(scopeBoardAccess(await currentBoardScope(db, boardId, owner)).role).toBe("owner")
  })
}
