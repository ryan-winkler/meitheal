import { currentBoardScope, fixturePrincipal } from "../helpers/current-board-scope"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import { NamedBoardRepository } from "../../apps/web/src/domains/tasks/persistence/named-board-repository"
import { NamedBoardTaskRepository } from "../../apps/web/src/domains/tasks/persistence/named-board-task-repository"
import { ensureSchema, getPersistenceClient, resetPersistenceForTests } from "../helpers/persistence-fixture"
import { defaultOrganizationLabel, organizationLabelResolver } from "../../apps/web/src/lib/organization-labels"
import { OrganizationAccessRepository } from "../../apps/web/src/domains/tasks/persistence/organization-access-repository"

test("Area defaults retain personal aliases and the existing English and Irish vocabulary", () => {
  expect(defaultOrganizationLabel("group", "en")).toBe("Area")
  expect(defaultOrganizationLabel("group", "en", true)).toBe("Areas")
  expect(defaultOrganizationLabel("group", "ga")).toBe("Réimse")
  expect(defaultOrganizationLabel("group", "ga", true)).toBe("Réimsí")
  const label = organizationLabelResolver({ forms: { group: ["Space", "Spaces"] }, visible: ["group"], revision: "1" }, "en")
  expect(label("group")).toBe("Space")
  expect(label("group", true)).toBe("Spaces")
})

test("named sidebar Project pages stay inside their Board and Area, include selected rows and honor availability", async () => {
  const folder = await mkdtemp(join(tmpdir(), "meitheal-sidebar-projects-"))
  const previous = process.env.MEITHEAL_DB_URL
  process.env.MEITHEAL_DB_URL = "file:" + join(folder, "tasks.db")
  resetPersistenceForTests()
  try {
    const marker = join(folder, "grants.json")
    await ensureSchema({ markerPath: marker })
    const db = getPersistenceClient()
    const boards = new NamedBoardRepository(db, marker)
    const actor = fixturePrincipal()
    const created = await boards.create(actor, "Workshop")
    if (created.status !== "committed") throw new Error("Expected a new Board")
    const boardId = created.result.id
    const scope = await currentBoardScope(db, boardId, actor)
    const catalog = new NamedBoardTaskRepository(db, scope, marker)
    await db.batch([
      { sql: "INSERT INTO areas (id, name, owner_board_id, created_at, updated_at) VALUES ('bench', 'Workbench', ?, 1, 1)", args: [boardId] },
      { sql: "INSERT INTO areas (id, name, owner_board_id, created_at, updated_at) VALUES ('other', 'Other Area', ?, 1, 1)", args: [boardId] },
      ...Array.from({ length: 35 }, (_, index) => ({
        sql: "INSERT INTO projects (id, title, area_id, owner_board_id, position, created_at, updated_at) VALUES (?, ?, 'bench', ?, ?, 1, 1)",
        args: ["project-" + index, "Project " + index, boardId, index],
      })),
      { sql: "INSERT INTO projects (id, title, area_id, owner_board_id, created_at, updated_at) VALUES ('outside', 'Outside', 'other', ?, 1, 1)", args: [boardId] },
    ], "write")
    const first = await catalog.projects(actor, boardId, "bench", null, "project-34")
    expect(first?.items).toHaveLength(30)
    expect(first?.selected).toEqual({ id: "project-34", name: "Project 34" })
    const second = await catalog.projects(actor, boardId, "bench", first!.next_cursor)
    expect(second?.items).toHaveLength(5)
    expect(second?.next_cursor).toBeNull()
    expect(new Set([...first!.items, ...second!.items].map(project => project.id)).size).toBe(35)
    expect((await catalog.projects(actor, boardId, "bench", null, "outside"))?.selected).toBeNull()
    expect(await catalog.projects(actor, boardId, "bench", "outside")).toBeNull()
    expect(await catalog.projects(fixturePrincipal("stranger", false), boardId, "bench", null)).toBeNull()
    expect(await catalog.projects(actor, boardId, "default", null)).toEqual({ items: [], next_cursor: null, selected: null })
    await db.execute("UPDATE areas SET retired_at = 1 WHERE id = 'bench'")
    expect(await catalog.projects(actor, boardId, "bench", null)).toEqual({ items: [], next_cursor: null, selected: null })
    const policy = new OrganizationAccessRepository(db, marker)
    expect(await policy.change({ scope: "feature", id: "projects", boardId: "" }, null, { audience: "nobody", users: [] }))
      .toMatchObject({ status: "committed", result: "saved" })
    const current = new NamedBoardTaskRepository(db, await currentBoardScope(db, boardId, actor), marker)
    await expect(current.projects(actor, boardId, "other", null)).rejects.toMatchObject({ errorCode: "denied" })
  } finally {
    resetPersistenceForTests()
    if (previous === undefined) delete process.env.MEITHEAL_DB_URL
    else process.env.MEITHEAL_DB_URL = previous
    await rm(folder, { recursive: true, force: true })
  }
})
