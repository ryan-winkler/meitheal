import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import { currentBoardWriteHeaders } from "../helpers/current-board-http"
import { startCoreFixture } from "../scripts/task-pins-fixture"

test("Today reuses empty sections while keeping rendered tasks scoped to the current Board", async ({ playwright }) => {
  test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires the built App and authenticated ingress")
  const fixture = await mkdtemp(join(tmpdir(), "meitheal-today-cache-"))
  const child = startCoreFixture(fixture, true, undefined, undefined, fixture)
  child.stdout?.resume()
  child.stderr?.resume()
  const api = await playwright.request.newContext()
  try {
    const [info] = await once(child, "message", { signal: AbortSignal.timeout(10_000) })
    const origin = `http://127.0.0.1:${info.port}`
    const app = origin + info.configuredPath
    const owner = { origin, cookie: "feedback-fixture=admin", "sec-fetch-site": "same-origin" }
    const member = { ...owner, cookie: "feedback-fixture=member" }
    const householdHeaders = await currentBoardWriteHeaders(api, "household", owner, app)
    const createdBoard = await api.post(app + "/api/boards", { headers: householdHeaders, data: { name: "Private Today fixture" } })
    expect(createdBoard.status(), await createdBoard.text()).toBe(201)
    const boardId = (await createdBoard.json()).id as string
    const privateToday = app + "/today?board_id=" + encodeURIComponent(boardId)
    const privateHeaders = await currentBoardWriteHeaders(api, boardId, owner, app)
    const section = (html: string, id: string) => {
      const matched = html.match(new RegExp(`<section id="today-${id}"[^>]*>[\\s\\S]*?</section>`))
      expect(matched, `Today section ${id} is present`).not.toBeNull()
      return matched![0]
    }

    const householdToday = await api.get(app + "/today", { headers: member })
    expect(householdToday.status()).toBe(200)
    const emptyHtml = await householdToday.text()
    const emptyPrivate = await api.get(privateToday, { headers: owner })
    expect(emptyPrivate.status()).toBe(200)
    const privateEmptyHtml = await emptyPrivate.text()
    for (const id of ["focus", "triage", "habits"]) expect(section(privateEmptyHtml, id)).toEqual(section(emptyHtml, id))
    for (const icon of ["x", "chevron-down", "repeat"]) {
      expect(privateEmptyHtml).toContain(`href="#mt-icon-${icon}"`)
      expect(privateEmptyHtml).toContain(`id="mt-icon-${icon}"`)
    }

    const title = "Private scheduled task from the cache fixture"
    const createdTask = await api.post(app + "/api/tasks", {
      headers: privateHeaders,
      data: { title, due_date: "2000-01-01", priority: 1 },
    })
    expect(createdTask.status(), await createdTask.text()).toBe(201)
    const taskId = (await createdTask.json()).id as string
    const populated = await api.get(privateToday, { headers: owner })
    expect(populated.status()).toBe(200)
    const populatedHtml = await populated.text()
    expect(section(populatedHtml, "focus")).toContain(title)
    expect(section(populatedHtml, "triage")).toContain(title)
    expect(section(populatedHtml, "habits")).toEqual(section(emptyHtml, "habits"))

    const denied = await api.get(privateToday, { headers: member })
    expect(denied.status()).toBe(404)
    expect(await denied.text()).not.toContain(title)
    const freshHousehold = await api.get(app + "/today", { headers: member })
    const freshHtml = await freshHousehold.text()
    expect(freshHtml).not.toContain(title)
    expect(section(freshHtml, "focus")).toEqual(section(emptyHtml, "focus"))

    const complete = await api.patch(app + "/api/tasks/" + taskId, { headers: privateHeaders, data: { status: "done" } })
    expect(complete.status(), await complete.text()).toBe(200)
    const restored = await api.get(privateToday, { headers: owner })
    expect(section(await restored.text(), "focus")).toEqual(section(emptyHtml, "focus"))
  } finally {
    await api.dispose()
    if (child.exitCode === null && child.signalCode === null) {
      const stopped = once(child, "exit")
      child.kill("SIGTERM")
      await stopped
    }
    await rm(fixture, { recursive: true, force: true })
  }
})
