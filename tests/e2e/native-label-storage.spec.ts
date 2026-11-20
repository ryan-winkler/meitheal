import { integrationRoute } from "../helpers/ordinary-integration-fixture"
import { currentBoardScope } from "../helpers/current-board-scope"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import { openDatabaseForStartup, withStartupWriteTransaction } from "../../apps/web/scripts/database-client.mjs"
import { applyStartupTaskSchema } from "../../apps/web/scripts/task-schema-startup.mjs"
import { finalizeStartupBoardGrant, initializeBoardGrantContinuity } from "../../apps/web/scripts/board-grant-journal.mjs"
import { createLabel } from "../../apps/web/src/domains/labels"
import { ensureSchema, getPersistenceClient, resetPersistenceForTests } from "../helpers/persistence-fixture"
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
  const client = await openDatabaseForStartup(`file:${join(directory, "labels.db")}`, { markerPath: join(directory, "labels.db.board-grants.json") })
  try {
    await client.execute(
      "CREATE TABLE vikunja_labels (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL UNIQUE, hex_color TEXT NOT NULL DEFAULT '3f51b5')",
    )
    await client.execute({
      sql: "INSERT INTO vikunja_labels (id, title, hex_color) VALUES (?, ?, ?)",
      args: [17, "Home", "abcdef"],
    })
    // Seed earlier label records during a genuinely fresh, exclusively created
    // installation. An unknown existing file must not gain fixture authority.
    let initial: string | null = null
    await withStartupWriteTransaction(client, async tx => {
      await applyStartupTaskSchema(tx)
      initial = await initializeBoardGrantContinuity(client, tx)
    })
    await finalizeStartupBoardGrant(client, initial)
  } finally {
    client.close()
  }
  await ensureSchema()

  const listed = await integrationRoute(GET, "/api/labels?board_id=household", undefined, "GET")
  expect(await listed.json()).toEqual([{ id: 17, title: "Home", hex_color: "abcdef" }])

  const created = await integrationRoute(POST, "/api/labels?board_id=household", { title: "home", hex_color: "#000000" })
  expect(created.status).toBe(201)
  expect(await created.json()).toEqual({ id: 17, title: "Home", hex_color: "abcdef" })
})

test("concurrent case variants resolve to one label", async () => {
  await ensureSchema()
  const scope = await currentBoardScope(getPersistenceClient())
  const [first, second] = await Promise.all([createLabel(scope, "Kitchen", "#abcdef"), createLabel(scope, "kitchen", "#abcdef")])
  expect(first).toEqual(second)
  const listed = await integrationRoute(GET, "/api/labels?board_id=household", undefined, "GET")
  expect(await listed.json()).toHaveLength(1)
})

test("HTML stripping and API validation retain an idempotent trimmed label title", async () => {
  await ensureSchema()
  const send = (title: string) => integrationRoute(POST, "/api/labels?board_id=household", { title })
  const created = await send(" home <b>")
  expect(created.status).toBe(201)
  const label = await created.json()
  expect(label.title).toBe("home")
  const scope = await currentBoardScope(getPersistenceClient())
  expect(await createLabel(scope, label.title)).toMatchObject({ id: label.id, title: "home" })
  expect((await send("<b> </b>")).status).toBe(400)
})

test("the source release serves native labels and has no legacy route", async ({ request }) => {
  test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires the disposable production fixture")
  const board = await request.get("/api/boards")
  expect(board.ok()).toBe(true)
  const session = board.headers()["x-meitheal-board-session"]
  if (!session) throw new Error("Fixture operator did not receive a Board session")
  const headers = { "x-meitheal-board-id": "household", "x-meitheal-board-session": session }
  const response = await request.post("/api/labels", {
    headers, data: { title: "First release", hex_color: "#abcdef" },
  })
  expect(response.status()).toBe(201)
  expect(await response.json()).toMatchObject({ title: "First release", hex_color: "abcdef" })
  const labels = await request.get("/api/labels", { headers })
  expect(await labels.json()).toContainEqual(expect.objectContaining({ title: "First release" }))
  expect((await request.get("/api/v1/projects")).status()).toBe(404)
})
