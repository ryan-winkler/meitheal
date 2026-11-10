import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { expect, test } from "@playwright/test"
import { validateFrameworkOverrides } from "@meitheal/domain-strategy"
import { parseRuleInput } from "../../apps/web/src/domains/strategy/rule-input"
import { findAllRules, replaceRules } from "../../apps/web/src/domains/strategy/rule-repository"
import { ensureSchema, getPersistenceClient, resetPersistenceForTests } from "../../apps/web/src/domains/tasks/persistence/store"
import { POST as importSettings } from "../../apps/web/src/pages/api/import/settings"
import { startCoreFixture } from "../scripts/task-pins-fixture"

const rule = (name: string) => parseRuleInput({ name, taskTypes: ["task"], lensIds: ["rice"] })
const imported = (payload: unknown) => importSettings({
  request: new Request("http://localhost/api/import/settings", { method: "POST", body: JSON.stringify(payload) }),
  locals: { hassIsAdmin: true },
} as Parameters<typeof importSettings>[0])

test("rules and framework overrides reject invalid typed values", () => {
  for (const value of [null, [], { name: " " }, { name: "Invalid", taskTypes: ["unknown"] },
    { name: "Invalid", enabled: "false" }, { name: "Invalid", aiScope: { canAutoClose: "true" } }]) {
    expect(() => parseRuleInput(value)).toThrow()
  }
  for (const value of [[], { fields: [] }, { fields: { missing: { weight: 1 } } },
    { fields: { reach: { weight: -1 } } }, { formula: "" }, { badgeThresholds: [{ min: Infinity }] }]) {
    expect(validateFrameworkOverrides(value, ["reach"])).not.toBeNull()
  }
  expect(validateFrameworkOverrides({ fields: { reach: { weight: 2, label: "Reach" } } }, ["reach"])).toBeNull()
})

test.describe("configuration transactions", () => {
  let directory: string
  const previousDb = process.env.MEITHEAL_DB_URL
  test.beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "meitheal-configuration-"))
    process.env.MEITHEAL_DB_URL = `file:${join(directory, "test.db")}`
    resetPersistenceForTests()
    await ensureSchema()
    await getPersistenceClient().execute("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)")
  })
  test.afterEach(async () => {
    getPersistenceClient().close()
    resetPersistenceForTests()
    if (previousDb === undefined) delete process.env.MEITHEAL_DB_URL
    else process.env.MEITHEAL_DB_URL = previousDb
    await rm(directory, { recursive: true, force: true })
  })

  test("scoped replacement preserves custom rules and failed inserts roll back deletions and resets", async () => {
    const initial = await replaceRules([rule("Default"), rule("Heating safety")])
    const custom = initial.find(item => item.name === "Heating safety")!
    await replaceRules([rule("New default")], [initial.find(item => item.name === "Default")!.id])
    expect((await findAllRules()).find(item => item.id === custom.id)).toEqual(custom)
    const before = await findAllRules()
    const client = getPersistenceClient()
    await client.execute("INSERT INTO framework_configs VALUES ('existing', 'rice', '{}', 'before', 'before')")
    await client.execute("CREATE TRIGGER reject_rule BEFORE INSERT ON rules WHEN NEW.name = 'Reject' BEGIN SELECT RAISE(ABORT, 'fixture failure'); END")
    await expect(replaceRules([rule("Reject")], undefined, true)).rejects.toThrow()
    expect(await findAllRules()).toEqual(before)
    expect((await client.execute("SELECT id FROM framework_configs")).rows).toHaveLength(1)
  })

  test("invalid rules preserve settings and the complete existing rule list", async () => {
    const client = getPersistenceClient()
    await client.execute("INSERT INTO settings VALUES ('theme', '\"dark\"', 1)")
    const before = await replaceRules([rule("Keep me")])
    const invalid = await imported({ _version: 2, settings: { theme: "light" }, rules: [{ name: "Invalid", enabled: "false" }] })
    expect(invalid.status).toBe(400)
    expect((await client.execute("SELECT value FROM settings WHERE key = 'theme'")).rows[0]?.value).toBe('"dark"')
    expect(await findAllRules()).toEqual(before)
  })

  test("string preferences retain JSON encoding while credential imports and agent administration stay denied", async () => {
    expect((await imported({ theme: "light", locale: "ga", ha_token: "synthetic-only" })).status).toBe(200)
    const rows = (await getPersistenceClient().execute("SELECT key, value FROM settings ORDER BY key")).rows
    expect(rows).toEqual([{ key: "locale", value: '"ga"' }, { key: "theme", value: '"light"' }])
    const response = await importSettings({ request: new Request("http://localhost/api/import/settings", { method: "POST", body: "{}" }),
      locals: { hassIsAdmin: true, agentToken: { scopes: ["settings:write"] } },
    } as unknown as Parameters<typeof importSettings>[0])
    expect(response.status).toBe(403)
  })

  test("actual import bytes are bounded without relying on Content-Length", async () => {
    expect((await imported({ theme: "é".repeat(102400) })).status).toBe(413)
    expect((await getPersistenceClient().execute("SELECT key FROM settings")).rows).toHaveLength(0)
  })
})

test("packaged framework validation and complete imports preserve prior configuration on failure", async ({ playwright }) => {
  const work = await mkdtemp(join(tmpdir(), "meitheal-configuration-api-"))
  const child = startCoreFixture(work, true)
  child.stdout?.resume()
  child.stderr?.resume()
  let api
  try {
    const [info] = await once(child, "message", { signal: AbortSignal.timeout(10000) })
    const origin = `http://127.0.0.1:${info.port}`
    api = await playwright.request.newContext({ baseURL: origin, extraHTTPHeaders: { cookie: "feedback-fixture=admin", origin } })
    const path = (value: string) => info.configuredPath + value
    for (const [method, endpoint] of [["put", "/api/rules"], ["post", "/api/rules"], ["post", "/api/rules/defaults"], ["put", "/api/rules/existing"], ["delete", "/api/rules/existing"], ["post", "/api/frameworks"], ["put", "/api/frameworks/rice"], ["delete", "/api/frameworks/rice"]] as const) {
      expect((await api[method](path(endpoint), { headers: { cookie: "feedback-fixture=member" }, data: {} })).status()).toBe(403)
    }
    const seeded = await api.put(path("/api/rules"), { data: { rules: [{ name: "Default" }, { name: "Heating safety" }] } })
    expect(seeded.status()).toBe(200)
    const existing = (await seeded.json()).data
    expect((await api.put(path("/api/rules"), { data: { rules: [{ name: "New default" }], replaceIds: [existing.find((item: { name: string }) => item.name === "Default").id] } })).status()).toBe(200)
    expect((await (await api.get(path("/api/rules"))).json()).data.map((item: { name: string }) => item.name)).toEqual(["Heating safety", "New default"])
    expect((await api.put(path("/api/frameworks/rice"), { data: { formula: "reach", fields: { reach: { weight: 2, label: "Household reach" } } } })).status()).toBe(200)
    expect((await api.put(path("/api/frameworks/rice"), { data: { fields: { reach: { weight: 3 } } } })).status()).toBe(200)
    const before = (await (await api.get(path("/api/frameworks/rice"))).json()).data
    expect(before.formula).toBe("reach")
    expect(before.fields.find((field: { key: string }) => field.key === "reach")).toMatchObject({ weight: 3, label: "Household reach" })
    expect((await api.put(path("/api/frameworks/rice"), { data: { fields: [] } })).status()).toBe(400)
    const invalid = await api.post(path("/api/import/settings"), { data: { _version: 2, settings: { theme: "light" }, rules: [], frameworkOverrides: [{ frameworkId: "rice", overrides: { fields: { missing: { weight: 4 } } } }] } })
    expect(invalid.status()).toBe(400)
    expect((await (await api.get(path("/api/frameworks/rice"))).json()).data).toEqual(before)
    const valid = await api.post(path("/api/import/settings"), { data: { _version: 2, settings: { theme: "dark" }, rules: [{ name: "Keep household rule" }], frameworkOverrides: [{ frameworkId: "rice", overrides: { formula: "reach", fields: { reach: { weight: 3, label: "Household reach" } } } }] } })
    expect(valid.status()).toBe(200)
    expect((await (await api.get(path("/api/frameworks/rice"))).json()).data).toEqual(before)
    const db = new DatabaseSync(join(work, "pins.db"))
    try {
      db.exec("CREATE TRIGGER reject_framework BEFORE INSERT ON framework_configs BEGIN SELECT RAISE(ABORT, 'fixture failure'); END")
      const failed = await api.post(path("/api/import/settings"), { data: { _version: 2, settings: { theme: "light" }, rules: [{ name: "Replacement" }], frameworkOverrides: [{ frameworkId: "rice", overrides: { formula: "impact" } }] } })
      expect(failed.status()).toBe(500)
      expect(db.prepare("SELECT value FROM settings WHERE key = 'theme'").get()).toEqual({ value: '"dark"' })
      expect(db.prepare("SELECT name FROM rules").all()).toEqual([{ name: "Keep household rule" }])
      expect((await (await api.get(path("/api/frameworks/rice"))).json()).data).toEqual(before)
    } finally { db.close() }
  } finally {
    await api?.dispose()
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit")
      child.kill()
      await exited
    }
    await rm(work, { recursive: true, force: true })
  }
})
