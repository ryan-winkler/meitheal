import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { expect, test } from "@playwright/test"
import {
  allowsOrganizationAudience, organizationAudienceContains, OrganizationAccessRepository,
} from "../../apps/web/src/domains/tasks/persistence/organization-access-repository"
import { ensureSchema, getPersistenceClient, resetPersistenceForTests } from "../helpers/persistence-fixture"

test("access policy snapshots fail closed when restored separately from the grant journal", async () => {
  const work = await mkdtemp(join(tmpdir(), "organization-policy-"))
  const marker = join(work, "meitheal-board-grants.json")
  const url = process.env.MEITHEAL_DB_URL
  process.env.MEITHEAL_DB_URL = `file:${join(work, "policy.db")}`
  try {
    await ensureSchema({ markerPath: marker })
    const db = getPersistenceClient()
    const repository = new OrganizationAccessRepository(db, marker)
    await db.execute(`INSERT INTO tasks (id, title, status, task_kind, source_template_id, due_date,
      area_id, idempotency_key, request_id, created_at, updated_at)
      VALUES ('occurrence-fixture', 'Fixed Routine day', 'complete', 'routine_instance', 'routine-fixture', '2026-11-17',
        'default', 'occurrence-fixture', 'occurrence-fixture', 1, 1)`)
    await expect(db.execute("UPDATE tasks SET due_date = NULL WHERE id = 'occurrence-fixture'"))
      .rejects.toThrow("A Routine occurrence keeps its original date")
    expect((await db.execute("SELECT due_date FROM tasks WHERE id = 'occurrence-fixture'")).rows)
      .toEqual([{ due_date: "2026-11-17" }])

    const feature = { scope: "feature", id: "goals", boardId: "" } as const
    expect(await repository.policies("feature", "")).toEqual({ status: "current", policies: [] })
    const initialMarker = await (await import("node:fs/promises")).readFile(marker)
    const initialRevision = JSON.parse(initialMarker.toString()).epoch
    const orphanRevision = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
    await db.execute({ sql: "UPDATE board_access_epoch SET revision = ? WHERE singleton = 1", args: [orphanRevision] })
    expect(await repository.policies("feature", "")).toEqual({ status: "locked" })
    await db.execute("DELETE FROM board_access_epoch")

    await db.execute({
      sql: `INSERT INTO organization_access_policies (scope, scope_id, board_id, audience, selected_users, revision)
        VALUES ('feature', 'goals', '', 'nobody', '[]', ?)`,
      args: [orphanRevision],
    })
    expect(await repository.policies("feature", "")).toEqual({ status: "locked" })
    await db.execute("DELETE FROM organization_access_policies")

    await writeFile(marker, JSON.stringify({ epoch: orphanRevision }))
    expect(await repository.policies("feature", "")).toEqual({ status: "locked" })
    await rm(marker)
    expect(await repository.policies("feature", "")).toEqual({ status: "locked" })
    await db.execute({ sql: "INSERT INTO board_access_epoch(singleton, revision) VALUES (1, ?)", args: [initialRevision] })
    await writeFile(marker, initialMarker)

    let raced = false
    const racingClient = new Proxy({} as typeof db, {
      get(target, property, receiver) {
        // This adapter deliberately observes the epoch read to place the race.
        if (property === Symbol.for("meitheal.boardGrantClient")) return undefined
        if (property !== "execute") {
          const value = Reflect.get(db, property, db)
          return typeof value === "function" ? value.bind(db) : value
        }
        return async (...args: Parameters<typeof db.execute>) => {
          const snapshot = await db.execute(...args)
          const statement: unknown = args[0]
          if (!raced && typeof statement === "string" && statement.includes("SELECT revision FROM board_access_epoch")) {
            raced = true
            expect(await repository.change(feature, null, { audience: "selected", users: ["alex", "blake", "alex"] }))
              .toMatchObject({ status: "committed", result: "saved" })
          }
          return snapshot
        }
      },
    })
    // Publication after the empty SQLite snapshot must not return inherited access.
    expect(await new OrganizationAccessRepository(racingClient, marker).policies("feature", "")).toEqual({ status: "locked" })
    const visible = await repository.policies("feature", "")
    expect(visible).toMatchObject({ status: "current", policies: [{ scope: feature, audience: "selected", users: ["alex", "blake"] }] })
    expect(await repository.change(feature, null, { audience: "nobody", users: [] }))
      .toEqual({ status: "unchanged", result: "stale" })
    if (visible.status !== "current") throw new Error("Missing policy snapshot")
    const current = visible.policies[0]!
    expect(allowsOrganizationAudience(current, "alex")).toBe(true)
    expect(allowsOrganizationAudience(current, "chris")).toBe(false)
    expect(allowsOrganizationAudience(current, null)).toBe(false)
    await writeFile(marker, JSON.stringify({ epoch: orphanRevision }))
    expect(await repository.policies("feature", "")).toEqual({ status: "locked" })
    expect(await repository.change(feature, current.revision, null)).toEqual({ status: "locked" })
  } finally {
    resetPersistenceForTests()
    if (url === undefined) delete process.env.MEITHEAL_DB_URL
    else process.env.MEITHEAL_DB_URL = url
    await rm(work, { recursive: true, force: true })
  }
})

test("audience containment compares fixed choices before considering current membership", () => {
  const target = { audience: "selected", users: ["alex", "blake", "chris"] } as const
  const initial = { audience: "selected", users: ["alex", "blake"] } as const
  const restricted = { audience: "selected", users: ["blake"] } as const
  const aunt = { audience: "selected", users: ["chris"] } as const
  const asPolicy = <T extends { audience: "selected"; users: readonly string[] }>(value: T) => ({ ...value, users: [...value.users] })
  expect(organizationAudienceContains([asPolicy(initial)], [asPolicy(target)])).toBe(false)
  expect(organizationAudienceContains([asPolicy(initial)], [asPolicy(restricted)])).toBe(true)
  expect(organizationAudienceContains([asPolicy(initial)], [asPolicy(aunt)])).toBe(false)
  expect(organizationAudienceContains([asPolicy(initial), asPolicy(restricted)], [asPolicy(initial)])).toBe(false)
  expect(organizationAudienceContains([], [asPolicy(restricted)])).toBe(true)
})

test("the area registry projection keeps only stable IDs and display names", async () => {
  const { parseHomeAssistantAreas } = await import("../../apps/web/src/domains/ha/ha-area-registry")
  expect(parseHomeAssistantAreas([
    { area_id: "front_hall", name: "Hall", floor_id: "first", aliases: ["Entry"] },
    { area_id: "kitchen", name: "Kitchen", temperature_entity_id: "sensor.temperature" },
  ])).toEqual([{ id: "front_hall", name: "Hall" }, { id: "kitchen", name: "Kitchen" }])
  expect(parseHomeAssistantAreas([])).toEqual([])
  expect(parseHomeAssistantAreas([{ area_id: "kitchen", name: "Kitchen" }, { area_id: "kitchen", name: "Broken duplicate" }])).toBeNull()
  expect(parseHomeAssistantAreas([{ area_id: "hall" }])).toBeNull()
})
