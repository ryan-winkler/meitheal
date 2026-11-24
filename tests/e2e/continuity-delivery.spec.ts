import { currentBoardScope, fixturePrincipal } from "../helpers/current-board-scope"
import { resolveIntegrationScope } from "../../apps/web/src/domains/tasks/board-automation"
import { readWorkDestinations } from "../../apps/web/src/domains/tasks/integration-destinations"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import { continuityRequestAllowed } from "../../apps/web/src/lib/continuity-request-policy"
import { BoardAccessService } from "../../apps/web/src/domains/tasks/board-access-service"
import { ensureSchema, getPersistenceClient, resetPersistenceForTests } from "../helpers/persistence-fixture"
import { TemplateRepository } from "../../apps/web/src/domains/tasks/persistence/template-repository"
import { checkOverdueTaskEvents } from "../../apps/web/src/domains/tasks/overdue-task-events"

test("continuity lock allows only content-free diagnostic paths, including resolved aliases", () => {
  for (const path of ["/api/tasks", "/api/tasks/today-counts", "/api/export", "/api/search", "/api/sse", "/api/mcp", "/api/a2a", "/tasks", "/boards", "/settings", "/api/health/private", "/api/%73se"]) {
    expect(continuityRequestAllowed(path, path)).toBe(false)
    expect(continuityRequestAllowed("/api/health", path)).toBe(false)
  }
  expect(continuityRequestAllowed("/api/health", "/api/health")).toBe(true)
  expect(continuityRequestAllowed("/_astro/main.js", "/_astro/main.js")).toBe(true)
})

test("Board reads, raw template writes and overdue observation stay closed when the current marker is lost", async () => {
  const work = await mkdtemp(join(tmpdir(), "delivery-continuity-"))
  const original = process.env.MEITHEAL_DB_URL
  const marker = join(work, "grants.json")
  process.env.MEITHEAL_DB_URL = "file:" + join(work, "meitheal.db")
  try {
    await ensureSchema({ markerPath: marker })
    const db = getPersistenceClient()
    const owner = fixturePrincipal()
    const resolve = () => new BoardAccessService(db).resolve(owner, "household", { resource: "task", action: "read" })
    const current = await resolve()
    expect(current.ok).toBe(true)
    const templates = new TemplateRepository(db, await currentBoardScope(db, "household", owner))
    const destinations = await readWorkDestinations(db)
    const overdue = destinations?.bindings.find(binding => binding.purpose === "builtin.overdue.observe" && binding.destination.boardId === "household")
    if (!overdue) throw new Error("Missing seeded overdue binding")
    const context = await resolveIntegrationScope(db, overdue.id, overdue.generation, { resource: "task", action: "read" })
    if (!context.ok) throw new Error(context.errorCode)
    expect(await templates.create({ id: "allowed", name: "Allowed", templateJson: "{}", icon: "", position: 0 })).toBe(true)
    await rm(marker)
    expect(await resolve()).toEqual({ ok: false, errorCode: "continuity_locked" })
    await expect(templates.findAll()).rejects.toMatchObject({ errorCode: "stale" })
    await expect(templates.create({ id: "denied", name: "Denied", templateJson: "{}", icon: "", position: 0 })).rejects.toMatchObject({ errorCode: "stale" })
    const events: unknown[] = []
    expect(await checkOverdueTaskEvents(db, async (...event) => { events.push(event) }, Date.now(), context.value)).toEqual({ observed: 0, dispatchFailed: 0, baselineCreated: false })
    expect(events).toEqual([])
    expect((await db.execute("SELECT id FROM task_templates ORDER BY id")).rows).toEqual([{ id: "allowed" }])
    expect((await db.execute("SELECT key FROM app_settings WHERE key LIKE 'system.overdue-events.checked-at%'")).rows).toEqual([])
  } finally {
    resetPersistenceForTests()
    if (original === undefined) delete process.env.MEITHEAL_DB_URL
    else process.env.MEITHEAL_DB_URL = original
    await rm(work, { force: true, recursive: true })
  }
})
