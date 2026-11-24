import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import { ensureSchema, getPersistenceClient, resetPersistenceForTests } from "../helpers/persistence-fixture"
import { runWithIngressTransport } from "../../apps/web/scripts/ingress-transport.mjs"
import { verifiedBoardRequestPrincipal } from "../../apps/web/src/lib/board-request-context"
import { boardSessionProof } from "../../apps/web/src/lib/named-board-request"
import { BoardAccessService, BoardRepository, HierarchyRepository, validateBoardScope } from "../../apps/web/src/domains/tasks"
import { DELETE as deleteArea } from "../../apps/web/src/pages/api/areas/[id]"
import { DELETE as deleteProject } from "../../apps/web/src/pages/api/projects/[id]"
import { DELETE as deleteGoal } from "../../apps/web/src/pages/api/goals/[id]"

for (const encoding of ["legacy", "scoped"] as const) {
  test(`a journaled planning retirement acknowledges its own commit without reopening stale reads: ${encoding}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "ordinary-planning-ack-"))
    const oldUrl = process.env.MEITHEAL_DB_URL, oldSupervisor = process.env.SUPERVISOR_TOKEN
    process.env.MEITHEAL_DB_URL = `file:${join(directory, "work.db")}`
    delete process.env.SUPERVISOR_TOKEN
    try {
      await ensureSchema()
      await runWithIngressTransport({ peer: "127.0.0.1", fromSupervisor: false, identityHeadersSafe: true, configuredPath: undefined }, async () => {
        const principal = await verifiedBoardRequestPrincipal({ request: new Request("http://localhost/boards"), locals: {} as App.Locals })
        if (!principal) throw new Error("Actual local operator required")
        const db = getPersistenceClient()
        const created = await new BoardRepository(db).create(principal, "Studio")
        if (created.status !== "committed") throw new Error("Board creation failed")
        const board = encoding === "legacy" ? "household" : created.result.id
        for (const [resource, route] of [["area", deleteArea], ["project", deleteProject], ["goal", deleteGoal]] as const) {
          const resolved = await new BoardAccessService(db).resolve(principal, board, { resource, action: "delete" })
          if (!resolved.ok) throw new Error(resolved.errorCode)
          const hierarchy = new HierarchyRepository(db, resolved.scope)
          const id = crypto.randomUUID()
          if (resource === "area") await hierarchy.createArea({ id, name: "Private area" })
          else if (resource === "project") expect(await hierarchy.createProject({ id, title: "Private project" })).toBe(true)
          else expect(await hierarchy.createGoal({ id, title: "Private goal" })).toBe(true)
          const url = new URL(`http://localhost/api/${resource}s/${id}`)
          const response = await route({ url, params: { id }, locals: {}, request: new Request(url, {
            method: "DELETE", headers: { "X-Meitheal-Board-Id": board, "X-Meitheal-Board-Session": boardSessionProof(principal.id) },
          }) } as unknown as Parameters<typeof deleteArea>[0])
          expect(response.status, await response.clone().text()).toBe(200)
          expect(await response.json()).toEqual({ ok: true })
          expect(response.headers.get("cache-control")).toContain("no-store")
          expect((await validateBoardScope(resolved.scope, db, { resource, action: "read" })).ok).toBe(false)
          await expect(hierarchy.findAllAreas()).rejects.toMatchObject({ errorCode: "stale" })
          const current = await new BoardAccessService(db).resolve(principal, board, { resource, action: "read" })
          if (!current.ok) throw new Error(current.errorCode)
          const reader = new HierarchyRepository(db, current.scope)
          expect(resource === "area" ? await reader.findAreaById(id) : resource === "project" ? await reader.findProjectById(id) : await reader.findGoalById(id)).toBeNull()
        }
      })
    } finally {
      resetPersistenceForTests()
      if (oldUrl === undefined) delete process.env.MEITHEAL_DB_URL; else process.env.MEITHEAL_DB_URL = oldUrl
      if (oldSupervisor === undefined) delete process.env.SUPERVISOR_TOKEN; else process.env.SUPERVISOR_TOKEN = oldSupervisor
      await rm(directory, { recursive: true, force: true })
    }
  })
}
