import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test as base, type APIRequestContext } from "@playwright/test"
import { launchPinBrowser, startCoreFixture } from "../scripts/task-pins-fixture"

type OrdinaryBoard = { id: string; name: string; revision: number }
const test = base.extend<{ workspace: { request: APIRequestContext; app: string; headers: Record<string, string>; exampleId: string; workId: string } }>({
  workspace: async ({}, use) => {
    const work = await mkdtemp(join(tmpdir(), "ordinary-board-contract-"))
    const child = startCoreFixture(work, false, undefined, undefined, work)
    child.stdout?.resume()
    child.stderr?.resume()
    let browser
    try {
      const [fixture] = await once(child, "message", { signal: AbortSignal.timeout(10_000) })
      const origin = `https://127.0.0.1:${fixture.port}`
      const app = origin + fixture.configuredPath
      browser = await launchPinBrowser(work)
      const context = await browser.newContext({ ignoreHTTPSErrors: true, extraHTTPHeaders: {}, serviceWorkers: "block" })
      await context.addCookies([{ name: "feedback-fixture", value: "admin", url: origin }])
      const directory = await context.request.get(app + "/api/boards")
      expect(directory.status()).toBe(200)
      const headers = { origin, "x-meitheal-board-session": directory.headers()["x-meitheal-board-session"]! }
      const created = await context.request.post(app + "/api/boards", { headers, data: { name: "Work" } })
      expect(created.status(), await created.text()).toBe(201)
      await use({ request: context.request, app, headers, exampleId: "household", workId: (await created.json()).id })
    } finally {
      await browser?.close()
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit", { signal: AbortSignal.timeout(3_000) })
        child.kill("SIGKILL")
        await exited
      }
      await rm(work, { recursive: true, force: true })
    }
  },
})

test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires the built App and verified Core-owner ingress fixture")

test("the example and a new Board are returned as peers by one authorized directory", async ({ workspace }) => {
  const { request, app, exampleId, workId } = workspace
  const response = await request.get(app + "/api/boards")
  expect(response.status()).toBe(200)
  const body = await response.json()
  const ids = body.boards.map((board: OrdinaryBoard) => board.id)
  expect(ids).toEqual(expect.arrayContaining([exampleId, workId]))
  expect(new Set(ids).size).toBe(ids.length)
})

test("the same metadata command renames the example and a new Board without changing identity", async ({ workspace }) => {
  const { request, app, headers, exampleId, workId } = workspace
  for (const [id, name] of [[exampleId, "Church"], [workId, "Studio"]]) {
    const before = await request.get(app + "/api/boards/" + id)
    expect(before.status(), await before.text()).toBe(200)
    const record = (await before.json()).board as OrdinaryBoard
    const renamed = await request.patch(app + "/api/boards/" + id, { headers, data: { action: "rename", name, revision: record.revision } })
    expect(renamed.status(), await renamed.text()).toBe(200)
    const after = await request.get(app + "/api/boards/" + id)
    expect(after.status()).toBe(200)
    expect((await after.json()).board).toMatchObject({ id, name })
  }
})

test("the same personal sidebar preference works for the example and a new Board", async ({ workspace }) => {
  const { request, app, headers, exampleId, workId } = workspace
  for (const id of [exampleId, workId]) {
    for (const hidden of [true, false]) {
      const saved = await request.patch(app + "/api/boards/" + id, { headers, data: { action: "sidebar", hidden } })
      expect(saved.status(), await saved.text()).toBe(200)
      const directory = await request.get(app + "/api/boards")
      expect(directory.status()).toBe(200)
      expect((await directory.json()).boards.find((board: OrdinaryBoard) => board.id === id)).toMatchObject({ id, hidden })
    }
  }
})
