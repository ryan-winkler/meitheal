import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import { createLabel } from "../../apps/web/src/domains/labels"
import { ensureSchema, getPersistenceClient, resetPersistenceForTests } from "../../apps/web/src/domains/tasks/persistence/store"
import { GET, POST } from "../../apps/web/src/pages/api/labels"

let directory: string
const previousDbUrl = process.env.MEITHEAL_DB_URL

test.beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "meitheal-native-labels-"))
  resetPersistenceForTests()
  process.env.MEITHEAL_DB_URL = `file:${join(directory, "labels.db")}`
})

test.afterEach(async () => {
  resetPersistenceForTests()
  if (previousDbUrl === undefined) delete process.env.MEITHEAL_DB_URL
  else process.env.MEITHEAL_DB_URL = previousDbUrl
  await rm(directory, { recursive: true, force: true })
})

test("the native API reads earlier labels and keeps their IDs and colours", async () => {
  const client = getPersistenceClient()
  await client.execute(
    "CREATE TABLE vikunja_labels (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL UNIQUE, hex_color TEXT NOT NULL)",
  )
  await client.execute({
    sql: "INSERT INTO vikunja_labels (id, title, hex_color) VALUES (?, ?, ?)",
    args: [17, "Home", "abcdef"],
  })

  const listed = await GET({} as Parameters<typeof GET>[0])
  expect(await listed.json()).toEqual([{ id: 17, title: "Home", hex_color: "abcdef" }])

  const request = new Request("http://localhost/api/labels", {
    method: "POST",
    body: JSON.stringify({ title: "home", hex_color: "#000000" }),
  })
  const created = await POST({ request } as Parameters<typeof POST>[0])
  expect(created.status).toBe(201)
  expect(await created.json()).toEqual({ id: 17, title: "Home", hex_color: "abcdef" })
})

test("concurrent case variants resolve to one label", async () => {
  await ensureSchema()
  const [first, second] = await Promise.all([createLabel("Kitchen", "#abcdef"), createLabel("kitchen", "#abcdef")])
  expect(first).toEqual(second)
  const listed = await GET({} as Parameters<typeof GET>[0])
  expect(await listed.json()).toHaveLength(1)
})

test("the source release serves native labels and has no legacy route", async ({ request }) => {
  test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires the disposable production fixture")
  const response = await request.post("/api/labels", {
    data: { title: "First release", hex_color: "#abcdef" },
  })
  expect(response.status()).toBe(201)
  expect(await response.json()).toMatchObject({ title: "First release", hex_color: "abcdef" })
  const labels = await request.get("/api/labels")
  expect(await labels.json()).toContainEqual(expect.objectContaining({ title: "First release" }))
  expect((await request.get("/api/v1/projects")).status()).toBe(404)
})
