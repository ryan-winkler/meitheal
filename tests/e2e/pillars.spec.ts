import { mkdtemp, rm } from "node:fs/promises"
import { currentBoardScope } from "../helpers/current-board-scope"
/**
 * Pillars Domain E2E Tests
 *
 * Tests the Pillars domain services (Pillar CRUD, Principle CRUD,
 * Association management) and the RICE Pillar boost scorer.
 *
 * @domain pillars + domain-strategy
 * @see docs/decisions/ADR-017-pillars-domain.md
 */
import { test, expect } from "@playwright/test"
import { tmpdir } from "node:os"
import { join } from "node:path"

let testDirectory: string | undefined
let previousDatabase: string | undefined
test.beforeEach(() => { previousDatabase = process.env.MEITHEAL_DB_URL })
test.afterEach(async () => {
  const { resetPersistenceForTests } = await import("../helpers/persistence-fixture")
  resetPersistenceForTests()
  if (testDirectory) await rm(testDirectory, { recursive: true, force: true })
  testDirectory = undefined
  if (previousDatabase === undefined) delete process.env.MEITHEAL_DB_URL; else process.env.MEITHEAL_DB_URL = previousDatabase
})
async function createTestDb() {
  testDirectory = await mkdtemp(join(tmpdir(), "meitheal-pillars-"))
  const dbUrl = `file:${join(testDirectory, "pillars.db")}`
  process.env.MEITHEAL_DB_URL = dbUrl
  return dbUrl
}

let owner: Awaited<ReturnType<typeof currentBoardScope>>
async function setupDb() {
  const { resetPersistenceForTests, ensureSchema } = await import("../helpers/persistence-fixture")
  resetPersistenceForTests()
  await ensureSchema()
  const { getPersistenceClient } = await import("../helpers/persistence-fixture")
  owner = await currentBoardScope(getPersistenceClient())
  // Also ensure Pillars domain schemas are created
  const { ensurePillarSchema, resetPillarSchemaForTests } = await import("../../apps/web/src/domains/pillars/pillar-service")
  resetPillarSchemaForTests()
  await ensurePillarSchema()
  const { resetPrincipleSchemaForTests } = await import("../../apps/web/src/domains/pillars/principle-service")
  resetPrincipleSchemaForTests()
  const { resetAssociationSchemaForTests } = await import("../../apps/web/src/domains/pillars/pillar-association-service")
  resetAssociationSchemaForTests()
}

// ── Pillar CRUD ──────────────────────────────────────────────────

test("can create and retrieve a pillar", async () => {
  await createTestDb()
  await setupDb()
  const { createPillar, getPillarById } = await import("../../apps/web/src/domains/pillars/pillar-service")

  const pillar = await createPillar(owner, {
    name: "Physical Longevity",
    manifesto: "I am someone who prioritises health above all",
    icon: "💪",
    colorHex: "#22C55E",
    weight: 8,
  })

  expect(pillar).toBeDefined()
  expect(pillar.id).toBeTruthy()
  expect(pillar.name).toBe("Physical Longevity")
  expect(pillar.weight).toBe(8)

  const found = await getPillarById(owner, pillar.id)
  expect(found).not.toBeNull()
  expect(found!.manifesto).toBe("I am someone who prioritises health above all")
})

test("getPillars returns only active pillars by default", async () => {
  await createTestDb()
  await setupDb()
  const { createPillar, getPillars, deletePillar } = await import("../../apps/web/src/domains/pillars/pillar-service")

  await createPillar(owner, { name: "Active One", weight: 5 })
  const toDelete = await createPillar(owner, { name: "Deleted One", weight: 3 })
  await deletePillar(owner, toDelete.id)

  const active = await getPillars(owner, { includeInactive: false })
  expect(active.length).toBe(1)
  expect(active[0]!.name).toBe("Active One")

  const all = await getPillars(owner, { includeInactive: true })
  expect(all.length).toBe(2)
})

test("weight is clamped to 1-10", async () => {
  await createTestDb()
  await setupDb()
  const { createPillar } = await import("../../apps/web/src/domains/pillars/pillar-service")

  const p1 = await createPillar(owner, { name: "Low", weight: 0 })
  expect(p1.weight).toBeGreaterThanOrEqual(1)

  const p2 = await createPillar(owner, { name: "High", weight: 15 })
  expect(p2.weight).toBeLessThanOrEqual(10)
})

test("can update a pillar", async () => {
  await createTestDb()
  await setupDb()
  const { createPillar, updatePillar, getPillarById } = await import("../../apps/web/src/domains/pillars/pillar-service")

  const p = await createPillar(owner, { name: "Original", weight: 5 })
  await updatePillar(owner, p.id, { name: "Updated", manifesto: "New manifesto", weight: 9 })

  const updated = await getPillarById(owner, p.id)
  expect(updated!.name).toBe("Updated")
  expect(updated!.manifesto).toBe("New manifesto")
  expect(updated!.weight).toBe(9)
})

test("countActivePillars returns correct count", async () => {
  await createTestDb()
  await setupDb()
  const { createPillar, countActivePillars, deletePillar } = await import("../../apps/web/src/domains/pillars/pillar-service")

  expect(await countActivePillars(owner)).toBe(0)
  await createPillar(owner, { name: "P1", weight: 5 })
  await createPillar(owner, { name: "P2", weight: 5 })
  const p3 = await createPillar(owner, { name: "P3", weight: 5 })
  expect(await countActivePillars(owner)).toBe(3)

  await deletePillar(owner, p3.id)
  expect(await countActivePillars(owner)).toBe(2)
})

// ── Principle CRUD ───────────────────────────────────────────────

test("can create and retrieve principles for a pillar", async () => {
  await createTestDb()
  await setupDb()
  const { createPillar } = await import("../../apps/web/src/domains/pillars/pillar-service")
  const { createPrinciple, getPrinciplesForPillar } = await import("../../apps/web/src/domains/pillars/principle-service")

  const pillar = await createPillar(owner, { name: "Family", weight: 7 })
  await createPrinciple(owner, { pillarId: pillar.id, statement: "Sunday dinner is sacred", isNonNegotiable: true })
  await createPrinciple(owner, { pillarId: pillar.id, statement: "Call mam weekly", isNonNegotiable: false })

  const principles = await getPrinciplesForPillar(owner, pillar.id)
  expect(principles.length).toBe(2)

  const sacred = principles.find(p => p.statement === "Sunday dinner is sacred")
  expect(sacred).toBeDefined()
  expect(sacred!.isNonNegotiable).toBe(true)
})

test("getNonNegotiablePrinciples returns only non-negotiables", async () => {
  await createTestDb()
  await setupDb()
  const { createPillar } = await import("../../apps/web/src/domains/pillars/pillar-service")
  const { createPrinciple, getNonNegotiablePrinciples } = await import("../../apps/web/src/domains/pillars/principle-service")

  const pillar = await createPillar(owner, { name: "Health", weight: 9 })
  await createPrinciple(owner, { pillarId: pillar.id, statement: "Never skip sleep", isNonNegotiable: true })
  await createPrinciple(owner, { pillarId: pillar.id, statement: "Stretch daily", isNonNegotiable: false })
  await createPrinciple(owner, { pillarId: pillar.id, statement: "8 hours minimum", isNonNegotiable: true })

  const nn = await getNonNegotiablePrinciples(owner)
  expect(nn.length).toBe(2)
  expect(nn.every(p => p.isNonNegotiable)).toBe(true)
})

test("can update a principle", async () => {
  await createTestDb()
  await setupDb()
  const { createPillar } = await import("../../apps/web/src/domains/pillars/pillar-service")
  const { createPrinciple, updatePrinciple, getPrinciplesForPillar } = await import("../../apps/web/src/domains/pillars/principle-service")

  const pillar = await createPillar(owner, { name: "Work", weight: 6 })
  const principle = await createPrinciple(owner, { pillarId: pillar.id, statement: "Old statement", isNonNegotiable: false })

  await updatePrinciple(owner, principle.id, { statement: "New statement", isNonNegotiable: true })

  const principles = await getPrinciplesForPillar(owner, pillar.id)
  const updated = principles.find(p => p.id === principle.id)
  expect(updated!.statement).toBe("New statement")
  expect(updated!.isNonNegotiable).toBe(true)
})

test("can delete a principle", async () => {
  await createTestDb()
  await setupDb()
  const { createPillar } = await import("../../apps/web/src/domains/pillars/pillar-service")
  const { createPrinciple, deletePrinciple, getPrinciplesForPillar } = await import("../../apps/web/src/domains/pillars/principle-service")

  const pillar = await createPillar(owner, { name: "Finance", weight: 7 })
  const principle = await createPrinciple(owner, { pillarId: pillar.id, statement: "Save 20%", isNonNegotiable: true })

  expect((await getPrinciplesForPillar(owner, pillar.id)).length).toBe(1)
  await deletePrinciple(owner, principle.id)
  expect((await getPrinciplesForPillar(owner, pillar.id)).length).toBe(0)
})

// ── Associations ─────────────────────────────────────────────────

test("can link and unlink entities to a pillar", async () => {
  await createTestDb()
  await setupDb()
  const { createPillar } = await import("../../apps/web/src/domains/pillars/pillar-service")
  const { linkEntity, unlinkEntity, getAssociationsForPillar } = await import("../../apps/web/src/domains/pillars/pillar-association-service")

  const pillar = await createPillar(owner, { name: "Growth", weight: 8 })
  const { getPersistenceClient } = await import("../helpers/persistence-fixture")
  await getPersistenceClient().execute(`INSERT INTO goals (id, title, created_at, updated_at)
    VALUES ('goal-123', 'First Goal', 1, 1), ('goal-456', 'Second Goal', 1, 1)`)
  expect(await linkEntity(owner, pillar.id, "goal", "missing-goal")).toBeNull()

  await linkEntity(owner, pillar.id, "goal", "goal-123")
  await linkEntity(owner, pillar.id, "goal", "goal-456")

  const associations = await getAssociationsForPillar(owner, pillar.id)
  expect(associations.length).toBe(2)
  expect(associations[0]!.entityType).toBe("goal")

  await unlinkEntity(owner, pillar.id, "goal", "goal-123")
  const afterUnlink = await getAssociationsForPillar(owner, pillar.id)
  expect(afterUnlink.length).toBe(1)
  expect(afterUnlink[0]!.entityId).toBe("goal-456")
})

test("linkEntity is idempotent", async () => {
  await createTestDb()
  await setupDb()
  const { createPillar } = await import("../../apps/web/src/domains/pillars/pillar-service")
  const { linkEntity, getAssociationsForPillar } = await import("../../apps/web/src/domains/pillars/pillar-association-service")

  const pillar = await createPillar(owner, { name: "Focus", weight: 6 })

  const { getPersistenceClient } = await import("../helpers/persistence-fixture")
  await getPersistenceClient().execute(`INSERT INTO task_templates (id, name, template_json, is_routine, created_at, updated_at)
    VALUES ('routine-1', 'Routine', '{}', 1, 1, 1)`)
  const first = await linkEntity(owner, pillar.id, "routine", "routine-1")
  const duplicate = await linkEntity(owner, pillar.id, "routine", "routine-1")
  expect(duplicate).toEqual(first)

  const associations = await getAssociationsForPillar(owner, pillar.id)
  expect(associations.length).toBe(1)
})

// ── RICE Pillar Boost ────────────────────────────────────────────

test("calculatePillarBoost returns 1.0 for unaligned tasks", async () => {
  const { calculatePillarBoost } = await import("../../packages/domain-strategy/src/rice")
  expect(calculatePillarBoost(undefined)).toBe(1.0)
  expect(calculatePillarBoost(0)).toBe(1.0)
})

test("calculatePillarBoost scales linearly from 1.0 to 1.5", async () => {
  const { calculatePillarBoost } = await import("../../packages/domain-strategy/src/rice")
  expect(calculatePillarBoost(1)).toBeCloseTo(1.0, 2)
  expect(calculatePillarBoost(5)).toBeCloseTo(1.222, 1) // ~1.22
  expect(calculatePillarBoost(10)).toBeCloseTo(1.5, 2)
})

test("calculateBoostedRiceScore multiplies RICE by Pillar boost", async () => {
  const { calculateBoostedRiceScore, calculateRiceScore } = await import("../../packages/domain-strategy/src/rice")

  const input = { reach: 100, impact: 3, confidence: 80, effort: 5 }
  const base = calculateRiceScore(input)
  const boosted = calculateBoostedRiceScore(input, 10)

  expect(boosted).toBeCloseTo(base * 1.5, 2)
  expect(boosted).toBeGreaterThan(base)
})

test("RICE boost has no effect when pillarWeight is undefined", async () => {
  const { calculateBoostedRiceScore, calculateRiceScore } = await import("../../packages/domain-strategy/src/rice")

  const input = { reach: 50, impact: 2, confidence: 90, effort: 3 }
  const base = calculateRiceScore(input)
  const boosted = calculateBoostedRiceScore(input, undefined)

  expect(boosted).toBe(base)
})
