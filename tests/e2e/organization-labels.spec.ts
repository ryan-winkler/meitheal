import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { expect, test, type APIRequestContext } from "@playwright/test"
import { launchPinBrowser, startCoreFixture } from "../scripts/task-pins-fixture"

test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires a disposable built app")

test("People can change personal display labels without changing routes, accounts or languages", async () => {
  const work = await mkdtemp(join(tmpdir(), "organization-labels-"))
  const child = startCoreFixture(work)
  child.stdout?.resume()
  child.stderr?.resume()
  let browser
  try {
    const [fixture] = await once(child, "message", { signal: AbortSignal.timeout(10_000) })
    const origin = `https://127.0.0.1:${fixture.port}`
    const app = origin + fixture.configuredPath
    const endpoint = app + "/api/organization-labels"
    const settings = app + "/settings#organization-labels-settings"
    browser = await launchPinBrowser(work)
    const context = await browser.newContext({ ignoreHTTPSErrors: true, extraHTTPHeaders: {}, viewport: { width: 1200, height: 860 } })
    const other = await browser.newContext({ ignoreHTTPSErrors: true, extraHTTPHeaders: {} })
    const admin = await browser.newContext({ ignoreHTTPSErrors: true, extraHTTPHeaders: {} })
    await context.addCookies([{ name: "feedback-fixture", value: "member", url: origin }])
    await other.addCookies([{ name: "feedback-fixture", value: "member-two", url: origin }])
    await admin.addCookies([{ name: "feedback-fixture", value: "admin", url: origin }])

    const read = async (actor: APIRequestContext) => {
      const response = await actor.get(endpoint)
      expect(response.status(), await response.text()).toBe(200)
      expect(response.headers()["cache-control"]).toBe("private, no-store")
      return response.json()
    }
    const save = (actor: APIRequestContext, data: Record<string, unknown>) =>
      actor.put(endpoint, { headers: { origin }, data })
    const initial = await read(context.request)
    const adminSettings = await admin.request.get(settings)
    const token = /name="token" value="([^"]+)"/.exec(await adminSettings.text())?.[1]
    expect(token).toBeTruthy()

    const page = await context.newPage()
    page.setDefaultTimeout(6_000)
    await page.goto(settings)
    const board = page.locator('[data-label-term="board"]')
    const singular = board.getByRole("textbox", { name: "Singular" })
    const plural = board.getByRole("textbox", { name: "Plural" })
    await singular.fill("Workshop")
    await plural.fill("Workspaces")
    await expect(page.locator("[data-preview-action]")).toHaveText("New Workshop")
    await page.route(endpoint, route => route.fulfill({ status: 503 }))
    await page.getByRole("button", { name: "Save labels" }).click()
    await expect(page.locator("[data-label-status]")).toContainText("Your edits are still here")
    await expect(plural).toHaveValue("Workspaces")
    await expect(page.locator('#sidebar a[data-page="boards"]')).toHaveText(/Boards/)
    await page.unroute(endpoint)
    await page.getByRole("button", { name: "Save labels" }).click()
    await expect(page.locator('#sidebar a[data-page="boards"]')).toHaveText(/Workspaces/)

    const current = await read(context.request)
    expect(current.forms.board).toEqual(["Workshop", "Workspaces"])
    expect((await read(other.request)).forms).toEqual({})
    expect((await save(other.request, current)).status()).toBe(412)
    expect((await save(context.request, initial)).status()).toBe(409)
    expect((await save(context.request, { ...current, forms: { board: ["x".repeat(41), ""] } })).status()).toBe(400)

    const deniedDownload = await admin.request.post(app + "/api/export/database.sqlite", {
      headers: { origin }, form: { token: token! },
    })
    expect(deniedDownload.status()).toBe(403)
    expect(await deniedDownload.text()).toContain("personal labels")

    await page.locator('#sidebar a[data-page="boards"]').click()
    await expect(page).toHaveURL(app + "/boards")
    await expect(page.locator(".board-add__trigger").getByText("New Workshop", { exact: true })).toBeVisible()
    await page.waitForFunction(() => typeof window.openSearchHub === "function")
    await page.locator("#global-search").click()
    const search = page.locator("#search-hub-input")
    await expect(search).toBeVisible()
    await search.fill("Boards")
    await expect(page.getByRole("option", { name: /Workspaces/ }).first()).toBeVisible()
    await search.fill("Workshop")
    await expect(page.getByRole("option", { name: /Workspaces/ }).first()).toBeVisible()

    await context.addCookies([{ name: "meitheal-locale", value: "ga", url: origin }])
    expect((await read(context.request)).forms).toEqual({})
    expect((await save(context.request, current)).status()).toBe(412)
    const ga = await read(context.request)
    expect((await save(context.request, { ...ga, forms: { board: ["  Spás  ", "Spásanna"] } })).status()).toBe(204)
    expect((await read(context.request)).forms.board).toEqual(["Spás", "Spásanna"])

    await context.addCookies([{ name: "meitheal-locale", value: "en", url: origin }])
    expect((await read(context.request)).forms.board).toEqual(["Workshop", "Workspaces"])
    const withBoard = await read(context.request)
    expect((await save(context.request, { ...withBoard, forms: { ...withBoard.forms, routine: ["Practice", "Practices"] } })).status()).toBe(204)
    expect((await admin.request.put(app + "/api/features", {
      headers: { origin }, data: { feature: "habits", enabled: false },
    })).ok()).toBe(true)
    await expect.poll(async () => (await read(context.request)).terms).not.toContain("routine")
    const hidden = await read(context.request)
    expect(hidden.forms.routine).toBeUndefined()
    expect(hidden.forms.board).toEqual(["Workshop", "Workspaces"])
    expect((await save(context.request, { ...hidden, forms: { ...hidden.forms, task: ["Action", "Actions"] } })).status()).toBe(204)
    expect((await admin.request.put(app + "/api/features", {
      headers: { origin }, data: { feature: "habits", enabled: true },
    })).ok()).toBe(true)
    await expect.poll(async () => (await read(context.request)).forms.routine).toEqual(["Practice", "Practices"])

    await page.setViewportSize({ width: 320, height: 700 })
    await page.goto(settings)
    await expect(singular).toHaveValue("Workshop")
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(321)
    await board.getByRole("button", { name: "Use default" }).click()
    await Promise.all([
      page.waitForEvent("framenavigated", { predicate: frame => frame === page.mainFrame() && frame.url() === settings }),
      page.getByRole("button", { name: "Save labels" }).click(),
    ])
    await expect.poll(async () => (await read(context.request)).forms).toEqual({ task: ["Action", "Actions"], routine: ["Practice", "Practices"] })

    await expect(singular).toHaveValue("")
    const project = page.locator('[data-label-term="project"]').getByRole("textbox", { name: "Singular" })
    await project.fill("Initiative")
    const previous = await read(context.request)
    expect((await save(context.request, { ...previous, forms: { ...previous.forms, goal: ["Outcome", "Outcomes"] } })).status()).toBe(204)
    await page.getByRole("button", { name: "Save labels" }).click()
    await expect(page.locator("[data-label-status]")).toContainText("Review the saved values")
    await expect(project).toHaveValue("Initiative")
    await expect(page.locator('[data-label-term="goal"]').getByRole("textbox", { name: "Singular" })).toHaveValue("Outcome")
    await Promise.all([
      page.waitForEvent("framenavigated", { predicate: frame => frame === page.mainFrame() && frame.url() === settings }),
      page.getByRole("button", { name: "Save labels" }).click(),
    ])
    await expect.poll(async () => (await read(context.request)).forms).toEqual({
      task: ["Action", "Actions"], routine: ["Practice", "Practices"], goal: ["Outcome", "Outcomes"], project: ["Initiative", ""],
    })

    const editorResponse = await read(context.request)
    expect((await save(context.request, { ...editorResponse, forms: { ...editorResponse.forms, board: ["Command center", "Command centers"] } })).status()).toBe(204)
    await page.goto(app + "/boards")
    await expect(page.getByRole("heading", { name: "Command centers", exact: true })).toBeVisible()
    await context.addCookies([{ name: "feedback-fixture", value: "member-two", url: origin }])
    await page.evaluate(() => window.dispatchEvent(new Event("focus")))
    await expect(page.getByRole("heading", { name: "Boards", exact: true })).toBeVisible()
    await context.addCookies([{ name: "feedback-fixture", value: "member", url: origin }])
    for (const locale of ["en", "ga"]) {
      await context.addCookies([{ name: "meitheal-locale", value: locale, url: origin }])
      const data = await read(context.request)
      expect((await save(context.request, { ...data, forms: {} })).status()).toBe(204)
      expect((await read(context.request)).forms).toEqual({})
    }
    const clearedDownload = await admin.request.post(app + "/api/export/database.sqlite", { headers: { origin }, form: { token: token! } })
    expect(clearedDownload.status()).toBe(403)
    expect(await clearedDownload.text()).toContain("personal labels")

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
