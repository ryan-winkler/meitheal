import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import { continuityRequestAllowed } from "../../apps/web/src/lib/continuity-request-policy"
import { householdBoardIsActive, readHouseholdBoardState } from "../../apps/web/src/domains/tasks/persistence/named-board-repository"
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

test("Household state, raw template writes and overdue observation stay closed when current marker is lost", async () => {
  const work = await mkdtemp(join(tmpdir(), "delivery-continuity-"))
  const original = process.env.MEITHEAL_DB_URL
  const marker = join(work, "grants.json")
  process.env.MEITHEAL_DB_URL = "file:" + join(work, "meitheal.db")
  try {
    await ensureSchema({ markerPath: marker })
    const db = getPersistenceClient()
    expect(await readHouseholdBoardState(db)).toBe("active")
    const templates = new TemplateRepository(db)
    expect(await templates.create({ id: "allowed", name: "Allowed", templateJson: "{}", icon: "", position: 0 })).toBe(true)
    await rm(marker)
    expect(await readHouseholdBoardState(db)).toBe("locked")
    expect(await householdBoardIsActive(db)).toBe(false)
    await expect(templates.findAll()).rejects.toThrow(/continuity/i)
    await expect(templates.create({ id: "denied", name: "Denied", templateJson: "{}", icon: "", position: 0 })).rejects.toThrow(/continuity/i)
    const events: unknown[] = []
    expect(await checkOverdueTaskEvents(db, async (...event) => { events.push(event) })).toEqual({ observed: 0, dispatchFailed: 0, baselineCreated: false })
    expect(events).toEqual([])
    expect((await db.execute("SELECT id FROM task_templates ORDER BY id")).rows).toEqual([{ id: "allowed" }])
    expect((await db.execute("SELECT key FROM app_settings WHERE key = 'system.overdue-events.checked-at'")).rows).toEqual([])
  } finally {
    resetPersistenceForTests()
    if (original === undefined) delete process.env.MEITHEAL_DB_URL
    else process.env.MEITHEAL_DB_URL = original
    await rm(work, { force: true, recursive: true })
  }
})
