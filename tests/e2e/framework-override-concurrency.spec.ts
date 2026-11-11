import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import { getOverrides, persistOverridePatch } from "../../apps/web/src/domains/strategy/framework-repository"
import { ensureSchema, getPersistenceClient, resetPersistenceForTests } from "../../apps/web/src/domains/tasks/persistence/store"

type Client = ReturnType<typeof getPersistenceClient>

const fields = ["reach", "effort"]
let directory: string
const previousDb = process.env.MEITHEAL_DB_URL

test.beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "meitheal-framework-cas-"))
  process.env.MEITHEAL_DB_URL = `file:${join(directory, "test.db")}`
  resetPersistenceForTests()
  await ensureSchema()
})
test.afterEach(async () => {
  getPersistenceClient().close()
  resetPersistenceForTests()
  if (previousDb === undefined) delete process.env.MEITHEAL_DB_URL
  else process.env.MEITHEAL_DB_URL = previousDb
  await rm(directory, { recursive: true, force: true })
})

/** Both writers receive the same original row before either can issue its write. */
function concurrentReaders(client: Client): Pick<Client, "execute"> {
  let reads = 0
  let release!: () => void
  const ready = new Promise<void>(resolve => { release = resolve })
  return {
    execute: (async (statement: unknown) => {
      const result = await client.execute(statement as Parameters<Client["execute"]>[0])
      const sql = typeof statement === "string" ? statement :
        statement && typeof statement === "object" && "sql" in statement ? String(statement.sql) : ""
      if (sql.startsWith("SELECT * FROM framework_configs") && ++reads <= 2) {
        if (reads === 2) release()
        await ready
      }
      return result
    }) as Client["execute"],
  }
}

for (const existing of [false, true]) {
  test(`concurrent weight and help-text patches preserve both edits with ${existing ? "an existing" : "no prior"} override`, async () => {
    const client = getPersistenceClient()
    if (existing) await persistOverridePatch(client, "rice", {
      formula: "reach / effort", fields: { reach: { label: "Household reach", weight: 1 }, effort: { weight: 2 } },
    }, fields)
    const gated = concurrentReaders(client)
    await Promise.all([
      persistOverridePatch(gated, "rice", { fields: { reach: { weight: 7 } } }, fields),
      persistOverridePatch(gated, "rice", { fields: { reach: { helpText: "Include household members" } } }, fields),
    ])
    const stored = (await getOverrides("rice"))!.overrides
    expect(stored.fields?.reach).toMatchObject({ weight: 7, helpText: "Include household members" })
    if (existing) {
      expect(stored.formula).toBe("reach / effort")
      expect(stored.fields?.reach?.label).toBe("Household reach")
      expect(stored.fields?.effort?.weight).toBe(2)
    }
  })
}

test("a rejected update preserves the complete prior override and later partial merges still work", async () => {
  const client = getPersistenceClient()
  await persistOverridePatch(client, "rice", { formula: "reach", fields: { reach: { weight: 2, label: "Keep label" } } }, fields)
  const before = await getOverrides("rice")
  await client.execute("CREATE TRIGGER reject_framework_update BEFORE UPDATE ON framework_configs BEGIN SELECT RAISE(ABORT, 'fixture failure'); END")
  await expect(persistOverridePatch(client, "rice", { fields: { reach: { helpText: "Rejected" } } }, fields)).rejects.toThrow()
  expect(await getOverrides("rice")).toEqual(before)
  await client.execute("DROP TRIGGER reject_framework_update")
  await persistOverridePatch(client, "rice", { fields: { reach: { helpText: "Saved" } } }, fields)
  expect((await getOverrides("rice"))!.overrides).toEqual({ formula: "reach", fields: { reach: { weight: 2, label: "Keep label", helpText: "Saved" } } })
})

test("injected writer transactions retain ownership of commit and rollback", async () => {
  const client = getPersistenceClient()
  await persistOverridePatch(client, "rice", { fields: { reach: { weight: 2 } } }, fields)
  const before = await getOverrides("rice")
  const transaction = await client.transaction("write")
  try {
    await persistOverridePatch(transaction, "rice", { fields: { reach: { helpText: "Uncommitted" } } }, fields)
    expect((await getOverrides("rice", transaction))!.overrides.fields?.reach?.helpText).toBe("Uncommitted")
    await transaction.rollback()
  } finally { transaction.close() }
  expect(await getOverrides("rice")).toEqual(before)
})
