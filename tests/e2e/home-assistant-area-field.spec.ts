import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { expect, test } from "@playwright/test"
import { launchPinBrowser, startCoreFixture } from "../scripts/task-pins-fixture"

test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires a disposable built app")

test("Home Assistant Area is optional, versioned and available only to the selected people", async () => {
  const work = await mkdtemp(join(tmpdir(), "home-assistant-area-"))
  const child = startCoreFixture(work, false, undefined, undefined, work)
  child.stdout?.resume()
  child.stderr?.resume()
  let browser
  try {
    const [fixture] = await once(child, "message", { signal: AbortSignal.timeout(10_000) })
    const origin = `https://127.0.0.1:${fixture.port}`
    const app = origin + fixture.configuredPath
    const headers = { origin }
    browser = await launchPinBrowser(work)
    const admin = await browser.newContext({ ignoreHTTPSErrors: true, extraHTTPHeaders: {} })
    const member = await browser.newContext({ ignoreHTTPSErrors: true, extraHTTPHeaders: {} })
    const other = await browser.newContext({ ignoreHTTPSErrors: true, extraHTTPHeaders: {} })
    await admin.addCookies([{ name: "feedback-fixture", value: "admin", url: origin }])
    await member.addCookies([{ name: "feedback-fixture", value: "member", url: origin }])
    await other.addCookies([{ name: "feedback-fixture", value: "member-two", url: origin }])
    const availability = app + "/api/organization-features"
    const registry = app + "/api/ha/areas"
    expect((await member.request.get(registry)).status()).toBe(404)
    expect((await member.request.get(availability)).status()).toBe(403)

    const adminPage = await admin.newPage()
    await adminPage.goto(app + "/settings#tasks-boards-settings")
    const audience = adminPage.locator("#ha-area-feature-form")
    await audience.getByLabel("Available to").selectOption("selected")
    await audience.getByLabel("Fixture member", { exact: true }).check()
    await audience.getByRole("button", { name: "Save availability" }).click()
    await expect(audience.locator("[data-ha-area-policy-status]")).toHaveText("Availability saved.")

    const choices = await member.request.get(registry)
    expect(choices.status(), await choices.text()).toBe(200)
    expect(choices.headers()["cache-control"]).toBe("private, no-store")
    expect((await choices.json()).areas).toEqual([
      { id: "fixture_kitchen", name: "Fixture Kitchen" }, { id: "fixture_yard", name: "Fixture Yard" },
    ])
    expect((await other.request.get(registry)).status()).toBe(404)
    expect((await admin.request.get(registry)).status()).toBe(404)

    const created = await member.request.post(app + "/api/tasks", {
      headers, data: { title: "Location test", home_assistant_area_id: "fixture_kitchen", custom_fields: JSON.stringify({ Area: "Imported value" }) },
    })
    expect(created.status(), await created.text()).toBe(201)
    const item = await created.json()
    expect(item.home_assistant_area_id).toBeUndefined()
    const filtered = await member.request.get(app + "/api/tasks?home_assistant_area_id=fixture_kitchen")
    expect(filtered.status()).toBe(200)
    expect(await filtered.json()).toMatchObject({ tasks: [expect.objectContaining({ id: item.id })], total: 1 })
    expect((await other.request.get(app + "/api/tasks?home_assistant_area_id=fixture_kitchen")).status()).toBe(404)
    const endpoint = app + "/api/tasks/" + item.id + "/home-assistant-area"
    const stored = await (await member.request.get(endpoint)).json()
    expect(stored.id).toBe("fixture_kitchen")
    expect((await other.request.get(endpoint)).status()).toBe(404)
    expect((await other.request.put(endpoint, { headers, data: { version: stored.version, locationRevision: stored.locationRevision, home_assistant_area_id: null } })).status()).toBe(404)
    expect((await member.request.put(endpoint, {
      headers, data: { version: stored.version - 1, locationRevision: stored.locationRevision, home_assistant_area_id: "fixture_yard" },
    })).status()).toBe(409)

    const page = await member.newPage()
    await page.goto(app + "/tasks?open=" + item.id)
    const location = page.locator('#task-detail-overlay [data-ha-area-field="edit"]').filter({ visible: true })
    await expect(location.getByLabel("Home Assistant Area")).toHaveValue("fixture_kitchen")
    await location.getByLabel("Home Assistant Area").selectOption("fixture_yard")
    await location.getByRole("button", { name: "Save location" }).click()
    await expect(location.getByRole("status")).toHaveText("Location saved.")
    const current = await (await member.request.get(endpoint)).json()
    expect(current.id).toBe("fixture_yard")
    expect(current.version).toEqual(stored.version)
    expect(current.locationRevision).toBeGreaterThan(stored.locationRevision)
    expect((await member.request.put(endpoint, {
      headers, data: { version: current.version, locationRevision: stored.locationRevision, home_assistant_area_id: "fixture_kitchen" },
    })).status()).toBe(409)

    const boardDirectory = await member.request.get(app + "/api/boards")
    const namedHeaders = { ...headers, "x-meitheal-board-session": boardDirectory.headers()["x-meitheal-board-session"]! }
    const board = await member.request.post(app + "/api/boards", { headers: namedHeaders, data: { name: "Location Board" } })
    expect(board.status(), await board.text()).toBe(201)
    const { id: boardId } = await board.json()
    const namedBase = app + "/api/boards/" + boardId
    const namedTask = await member.request.post(namedBase + "/tickets", {
      headers: namedHeaders, data: { title: "Yard fixture", home_assistant_area_id: "fixture_yard" },
    })
    expect(namedTask.status(), await namedTask.text()).toBe(201)
    const { id: namedId } = await namedTask.json()
    const namedField = namedBase + "/tickets/" + namedId + "/home-assistant-area"
    const namedSaved = await member.request.get(namedField)
    expect(namedSaved.status()).toBe(200)
    expect(await namedSaved.json()).toMatchObject({ id: "fixture_yard" })
    expect((await other.request.get(namedField)).status()).toBe(404)
    const yardBoard = await (await member.request.get(namedBase + "?view=tasks&home_assistant_area_id=fixture_yard")).json()
    expect(yardBoard.tasks.map((row: { id: string }) => row.id)).toEqual([namedId])
    const kitchenBoard = await (await member.request.get(namedBase + "?view=tasks&home_assistant_area_id=fixture_kitchen")).json()
    expect(kitchenBoard.tasks).toEqual([])

    const changed = once(child, "message", { signal: AbortSignal.timeout(5_000) })
    child.send({ type: "fixture-area-registry", registry: null })
    await changed
    expect((await member.request.get(registry)).status()).toBe(503)
    expect((await member.request.put(endpoint, {
      headers, data: { version: current.version, locationRevision: current.locationRevision, home_assistant_area_id: "fixture_kitchen" },
    })).status()).toBe(503)
    await page.reload()
    await expect(location.getByLabel("Home Assistant Area").locator("option:checked")).toHaveText("Saved location unavailable")
    await location.getByLabel("Home Assistant Area").selectOption("")
    await location.getByRole("button", { name: "Save location" }).click()
    await expect(location.getByRole("status")).toHaveText("Location saved.")
    expect((await (await member.request.get(endpoint)).json()).id).toBeNull()
    const task = await (await member.request.get(app + "/api/tasks/" + item.id)).json()
    expect(JSON.stringify(task.custom_fields)).toContain("Imported value")
  } finally {
    await browser?.close()
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit", { signal: AbortSignal.timeout(3_000) })
      child.kill("SIGKILL")
      await exited
    }
    await rm(work, { recursive: true, force: true })
  }
})
