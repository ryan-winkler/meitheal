import { once } from "node:events"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { expect, test as base, type BrowserContext, type Page } from "@playwright/test"
import { launchPinBrowser, startCoreFixture } from "../scripts/task-pins-fixture"
import { DATABASE_SCHEMA_VERSION } from "../../apps/web/scripts/database-client.mjs"

const test = base.extend<{ boards: { page: Page; member: BrowserContext; admin: BrowserContext; app: string; origin: string; work: string } }>({
  boards: async ({}, use) => {
    const work = await mkdtemp(join(tmpdir(), "board-lifecycle-ux-"))
    const child = startCoreFixture(work, false, undefined, undefined, work)
    child.stdout?.resume()
    child.stderr?.resume()
    let browser
    try {
      const [fixture] = await once(child, "message", { signal: AbortSignal.timeout(10_000) })
      const origin = `https://127.0.0.1:${fixture.port}`
      browser = await launchPinBrowser(work)
      const createContext = async (user: string) => {
        const context = await browser!.newContext({ ignoreHTTPSErrors: true, extraHTTPHeaders: {}, serviceWorkers: "block" })
        context.setDefaultTimeout(6_000)
        await context.addCookies([{ name: "feedback-fixture", value: user, url: origin }])
        return context
      }
      const [member, admin] = await Promise.all([createContext("member"), createContext("admin")])
      await use({ page: await member.newPage(), member, admin, app: origin + fixture.configuredPath, origin, work })
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

test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires a disposable built app")

// Regression: Delete used generic confirmation; Restore actions omitted their targets.
// Found by /qa on 2026-11-18; report: local final-qa/lifecycle evidence.
test("Delete Board defaults to Cancel and restores two distinctly named Boards", async ({ boards }, testInfo) => {
  const { page, member, app, origin } = boards
  const directory = await member.request.get(app + "/api/boards")
  const headers = { origin, "x-meitheal-board-session": directory.headers()["x-meitheal-board-session"]! }
  const ids: string[] = []
  for (const name of ["Workshop", "Garden"]) {
    const created = await member.request.post(app + "/api/boards", { headers, data: { name } })
    expect(created.status(), await created.text()).toBe(201)
    ids.push((await created.json()).id)
  }
  await page.goto(app + `/boards/${ids[0]}?view=groups`)
  await page.locator("#settings > summary").click()
  const trigger = page.getByRole("button", { name: "Delete Board", exact: true })
  const patches: string[] = []
  page.on("request", request => {
    if (request.method() === "PATCH" && request.url() === app + "/api/boards/" + ids[0]) patches.push(request.postData() ?? "")
  })
  await trigger.click()
  const dialog = page.getByRole("alertdialog", { name: "Delete Board", exact: true })
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText("Delete Workshop?")
  await expect(dialog.getByRole("button", { name: "Delete Board", exact: true })).toHaveCSS("background-color", "rgb(220, 38, 38)")
  const cancel = dialog.getByRole("button", { name: "Cancel", exact: true })
  await expect(cancel).toBeFocused()
  await page.screenshot({ path: testInfo.outputPath("delete-board-dialog.png"), fullPage: true })
  await cancel.press("Enter")
  await expect(dialog).toHaveCount(0)
  await expect(trigger).toBeFocused()
  expect(patches).toEqual([])
  expect((await (await member.request.get(app + "/api/boards/" + ids[0])).json()).board.state).toBe("active")

  for (const id of ids) {
    const view = await (await member.request.get(app + "/api/boards/" + id)).json()
    const removed = await member.request.patch(app + "/api/boards/" + id, { headers, data: { action: "retire", revision: view.board.revision } })
    expect(removed.status(), await removed.text()).toBe(200)
  }
  await page.goto(app + "/boards")
  const deleted = page.getByRole("region", { name: "Deleted Boards", exact: true })
  await expect(deleted.getByRole("button")).toHaveCount(2)
  for (const name of ["Workshop", "Garden"]) await expect(deleted.getByRole("button", { name: "Restore Board " + name, exact: true })).toBeVisible()
  const heading = deleted.getByRole("heading", { name: "Deleted Boards", exact: true })
  await expect(heading).toHaveCSS("margin", "0px")
  const rootFont = await page.locator("html").evaluate(el => getComputedStyle(el).fontSize)
  await expect(heading).toHaveCSS("font-size", rootFont)
  await page.screenshot({ path: testInfo.outputPath("distinct-restore-actions.png"), fullPage: true })
  for (const [index, name] of ["Workshop", "Garden"].entries()) {
    const restored = page.waitForResponse(response => response.url() === app + "/api/boards/" + ids[index] && response.request().method() === "PATCH")
    const navigated = page.waitForEvent("domcontentloaded")
    await deleted.getByRole("button", { name: "Restore Board " + name, exact: true }).click()
    expect((await restored).status()).toBe(200)
    await navigated
    await expect(page.locator("[data-board-directory]")).toHaveAttribute("data-bound", "true")
    const card = page.locator("[data-board-directory] a.board-card-identity")
      .filter({ has: page.locator(".board-name").getByText(name, { exact: true }) })
    await expect(card).toBeVisible()
    await expect(page.getByRole("button", { name: "Restore Board " + name, exact: true })).toHaveCount(0)
    expect((await (await member.request.get(app + "/api/boards/" + ids[index])).json()).board.state).toBe("active")
  }
})

test("an empty Board keeps default, personalized and Irish Area labels consistent", async ({ boards }, testInfo) => {
  const { page, member, app, origin } = boards
  const directory = await member.request.get(app + "/api/boards")
  const headers = { origin, "x-meitheal-board-session": directory.headers()["x-meitheal-board-session"]! }
  const createdBoard = await member.request.post(app + "/api/boards", { headers, data: { name: "Area vocabulary" } })
  expect(createdBoard.status(), await createdBoard.text()).toBe(201)
  const boardId = (await createdBoard.json()).id
  const catalog = await member.request.get(app + "/api/areas?board_id=" + boardId)
  expect(catalog.status()).toBe(200)
  expect((await catalog.json()).areas).toEqual([])
  const form = page.locator('form[data-board-form="planning"]')
    .filter({ has: page.locator('input[name="action"][value="area"]') })
    .filter({ hasNot: page.locator('input[name="id"]') })
  const workspace = app + `/boards/${boardId}?view=groups`
  await page.goto(workspace)
  await expect(page.locator(".board-empty")).toHaveText("Choose “New Area” to organize related work.")
  await form.locator("xpath=ancestor::details[1]").locator(":scope > summary").click()
  await expect(form.getByRole("button", { name: "Create Area", exact: true })).toBeVisible()
  const endpoint = app + "/api/organization-labels"
  const labels = await (await member.request.get(endpoint)).json()
  const renamed = await member.request.put(endpoint, { headers: { origin }, data: { ...labels, forms: { ...labels.forms, group: ["Room", "Rooms"] } } })
  expect(renamed.status(), await renamed.text()).toBe(204)
  await page.reload()
  await expect(form.locator("xpath=ancestor::details[1]").locator(":scope > summary")).toHaveText("New Room")
  await form.locator("xpath=ancestor::details[1]").locator(":scope > summary").click()
  await expect(form.getByRole("button", { name: "Create Room", exact: true })).toBeVisible()
  await expect(page.locator(".board-empty")).toHaveText("Choose “New Room” to organize related work.")
  await member.addCookies([{ name: "meitheal-locale", value: "ga", url: origin }])
  await page.reload()
  await expect(page.locator(".board-empty")).toHaveText("Choose “Réimse nua” to organize related work.")
  await member.addCookies([{ name: "meitheal-locale", value: "en", url: origin }])
  await page.reload()
  await form.locator("xpath=ancestor::details[1]").locator(":scope > summary").click()
  await page.screenshot({ path: testInfo.outputPath("personalized-area-submit.png"), fullPage: true })
  await form.getByRole("textbox", { name: "Name", exact: true }).fill("Reading room")
  const reloaded = page.waitForEvent("load")
  const created = page.waitForResponse(response => response.url() === app + `/api/boards/${boardId}/planning` && response.request().method() === "POST")
  await form.getByRole("button", { name: "Create Room", exact: true }).click()
  expect((await created).status()).toBe(200)
  await reloaded
  const areas = await member.request.get(app + "/api/areas?board_id=" + boardId)
  expect(areas.status()).toBe(200)
  const area = (await areas.json()).areas.find((item: { name: string }) => item.name === "Reading room")
  expect(area).toBeDefined()
  const link = page.getByRole("link", { name: /Reading room/ }).filter({ hasText: "Reading room" }).first()
  await expect(link).toHaveAttribute("href", `${new URL(app).pathname}/boards/${boardId}?area=${area.id}`)
  await link.click()
  await expect(page).toHaveURL(url => url.searchParams.get("area") === area.id && url.pathname.endsWith(`/boards/${boardId}`))
  expect((await (await member.request.get(app + `/api/areas/${area.id}?board_id=${boardId}`)).json()).name).toBe("Reading room")

  await member.addCookies([{ name: "meitheal-locale", value: "ga", url: origin }])
  await page.goto(workspace)
  await expect(form.locator("xpath=ancestor::details[1]").locator(":scope > summary")).toHaveText("Réimse nua")
  await form.locator("xpath=ancestor::details[1]").locator(":scope > summary").click()
  await expect(form.getByRole("button", { name: "Réimse nua", exact: true })).toBeVisible()
})

test("Unavailable Areas omit the create instruction and preserve Unfiled Projects", async ({ boards }, testInfo) => {
  const { page, member, admin, app, origin } = boards
  const directory = await member.request.get(app + "/api/boards")
  const project = await member.request.post(app + "/api/projects", {
    headers: { origin, "x-meitheal-board-id": "household", "x-meitheal-board-session": directory.headers()["x-meitheal-board-session"]! },
    data: { title: "Loose lighting Project" },
  })
  expect(project.status(), await project.text()).toBe(201)
  const { id } = await project.json()
  const endpoint = app + "/api/organization-features"
  const current = await admin.request.get(endpoint)
  const settings = await current.json()
  const disabled = await admin.request.put(endpoint, {
    headers: { origin, "x-meitheal-area-admin": current.headers()["x-meitheal-area-admin"]! },
    data: { feature: "groups", audience: "selected", users: ["fixture-member-two"], revision: settings.features.groups.revision },
  })
  expect(disabled.status(), await disabled.text()).toBe(204)
  expect((await page.goto(app + "/boards/household?view=groups"))?.status()).toBe(200)
  await expect(page.locator("[data-household-group-create]")).toHaveCount(0)
  await expect(page.locator(".board-empty")).toHaveCount(0)
  const unfiled = page.getByRole("region", { name: "Unfiled Projects", exact: true })
  const link = unfiled.getByRole("link", { name: "Loose lighting Project", exact: true })
  await expect(link).toBeVisible()
  await expect(link).toHaveAttribute("href", `${new URL(app).pathname}/boards/household?project=${id}`)
  await page.screenshot({ path: testInfo.outputPath("areas-disabled-unfiled-project.png"), fullPage: true })
  await link.click()
  await expect(page.locator("#kanban-shell")).toHaveAttribute("data-kanban-booted", "true")
})

// Regression: A hidden Board left its private confirmation outside the detached root.
// Found by /qa on 2026-11-18; report: local final-qa/lifecycle/privacy-r40 evidence.
for (const mode of ["offline", "revoked"] as const) {
  test(`Private Board confirmation closes when ${mode} and cannot resume a write`, async ({ boards }, testInfo) => {
    const { member: owner, app, origin } = boards
    const directory = await owner.request.get(app + "/api/boards")
    const headers = { origin, "x-meitheal-board-session": directory.headers()["x-meitheal-board-session"]! }
    const name = `Private Workshop R40 ${mode}`
    const created = await owner.request.post(app + "/api/boards", { headers, data: { name } })
    expect(created.status(), await created.text()).toBe(201)
    const { id } = await created.json()
    const api = app + "/api/boards/" + id
    const target = mode === "offline" ? owner : await owner.browser()!.newContext({ ignoreHTTPSErrors: true, extraHTTPHeaders: {}, serviceWorkers: "block" })
    if (mode === "revoked") {
      await target.addCookies([{ name: "feedback-fixture", value: "member-two", url: origin }])
      const granted = await owner.request.patch(api, { headers, data: { action: "member", memberId: "fixture-member-two", role: "owner" } })
      expect(granted.status(), await granted.text()).toBe(200)
    }
    const page = await target.newPage()
    page.setDefaultTimeout(6_000)
    await page.goto(app + `/boards/${id}?view=groups`)
    const root = page.locator("[data-board-directory]")
    const cdp = await target.newCDPSession(page)
    const hiddenListenerCount = async () => {
      const result = await cdp.send("Runtime.evaluate", {
        expression: "getEventListeners(document.querySelector('[data-board-directory]'))['meitheal:board-hidden']?.length ?? 0",
        includeCommandLineAPI: true, returnByValue: true,
      })
      return result.result.value as number
    }
    const initialListeners = await hiddenListenerCount()
    await page.locator("#settings > summary").click()
    const trigger = page.locator("#settings").getByRole("button", { name: "Delete Board", exact: true })
    await trigger.click()
    const dialog = page.getByRole("alertdialog", { name: "Delete Board", exact: true })
    await expect(dialog).toContainText(name)
    const staleConfirmation = await dialog.getByRole("button", { name: "Delete Board", exact: true }).elementHandle()
    const disconnectedTrigger = await trigger.elementHandle()
    await disconnectedTrigger!.evaluate(button => {
      const focus = button.focus.bind(button)
      button.focus = options => {
        button.dataset.focusAttempts = String(Number(button.dataset.focusAttempts ?? "0") + 1)
        focus(options)
      }
    })
    const patches: string[] = []
    page.on("request", request => {
      if (request.method() === "PATCH" && request.url() === api) patches.push(request.postData() ?? "")
    })
    if (mode === "offline") await target.setOffline(true)
    else {
      const revoked = await owner.request.patch(api, { headers, data: { action: "member", memberId: "fixture-member-two", role: null } })
      expect(revoked.status(), await revoked.text()).toBe(200)
      const denied = page.waitForResponse(response => response.request().method() === "HEAD" && new URL(response.url()).pathname === new URL(api).pathname)
      await page.evaluate(() => window.dispatchEvent(new Event("focus")))
      expect((await denied).status()).toBe(404)
    }
    await expect(root).toHaveCount(0)
    await page.screenshot({ path: testInfo.outputPath(`${mode}-hidden-confirmation.png`), fullPage: true })
    await expect(dialog).toHaveCount(0)
    await expect(page.locator("body")).not.toContainText(name)
    expect(await disconnectedTrigger!.evaluate(button => button.isConnected)).toBe(false)
    const recovery = page.getByRole("button", { name: mode === "offline" ? "Retry verification" : "Refresh Board", exact: true })
    await expect(recovery).toBeFocused()
    // A queued click on the removed native button must have no remaining listener.
    await staleConfirmation!.evaluate(button => (button as HTMLButtonElement).click())
    await expect(recovery).toBeFocused()
    expect(await disconnectedTrigger!.evaluate(button => button.dataset.focusAttempts ?? "0")).toBe("0")
    expect(patches).toEqual([])

    if (mode === "offline") {
      const verified = page.waitForResponse(response => response.request().method() === "HEAD" && new URL(response.url()).pathname === new URL(api).pathname)
      await target.setOffline(false)
      expect((await verified).status()).toBe(200)
    } else {
      const restored = await owner.request.patch(api, { headers, data: { action: "member", memberId: "fixture-member-two", role: "owner" } })
      expect(restored.status(), await restored.text()).toBe(200)
      expect((await page.reload())?.status()).toBe(200)
    }
    await expect(root).toBeVisible()
    expect(await hiddenListenerCount()).toBe(initialListeners)
    const settings = page.locator("#settings")
    if (!await settings.evaluate(details => (details as HTMLDetailsElement).open)) await settings.locator(":scope > summary").click()
    for (const key of ["Enter", "Escape"]) {
      await trigger.click()
      await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeFocused()
      expect(await hiddenListenerCount()).toBe(initialListeners + 1)
      await page.keyboard.press(key)
      await expect(dialog).toHaveCount(0)
      await expect(trigger).toBeFocused()
      expect(await hiddenListenerCount()).toBe(initialListeners)
    }
    expect(patches).toEqual([])
    expect((await (await owner.request.get(api)).json()).board.state).toBe("active")
    await cdp.detach()
    if (target !== owner) await target.close()
  })
}

test("a markerless existing schema26 fixture cannot inherit access or bootstrap Board and planning mutations", async ({ boards }) => {
  const { page, member, admin, app, origin, work } = boards
  const selected = "household"
  const directory = await admin.request.get(app + "/api/boards")
  expect(directory.status()).toBe(200)
  const headers = {
    origin,
    "x-meitheal-board-id": selected,
    "x-meitheal-board-session": directory.headers()["x-meitheal-board-session"]!,
  }
  const features = await admin.request.get(app + "/api/organization-features")
  expect(features.status(), await features.text()).toBe(200)
  const featureState = await features.json()
  const featureHeaders = { ...headers, "x-meitheal-area-admin": features.headers()["x-meitheal-area-admin"]! }
  const created = await admin.request.post(app + "/api/areas", { headers, data: { name: "Retained planning after custody loss" } })
  expect(created.status(), await created.text()).toBe(201)
  const area = await created.json()
  expect(typeof area.id).toBe("string")
  const currentBoard = await admin.request.get(app + "/api/boards/" + selected, { headers })
  expect(currentBoard.status()).toBe(200)
  const revision = (await currentBoard.json()).board.revision
  await page.goto(app + "/boards/household?view=groups")
  const root = page.locator("[data-board-directory]")
  await expect(root).toHaveAttribute("data-bound", "true")
  await expect(root).toContainText("Retained planning after custody loss")

  const snapshot = () => {
    const database = new DatabaseSync(join(work, "pins.db"), { readOnly: true })
    try {
      return {
        version: database.prepare("SELECT value FROM app_settings WHERE key='schema_version'").get(),
        boards: database.prepare("SELECT * FROM task_boards ORDER BY id").all(),
        areas: database.prepare("SELECT * FROM areas ORDER BY id").all(),
        projects: database.prepare("SELECT * FROM projects ORDER BY id").all(),
        policies: database.prepare("SELECT * FROM organization_access_policies ORDER BY scope, board_id, scope_id").all(),
        epoch: database.prepare("SELECT * FROM board_access_epoch").all(),
      }
    } finally { database.close() }
  }
  expect(snapshot().version).toEqual({ value: String(DATABASE_SCHEMA_VERSION) })
  expect(snapshot().boards.map(board => board.id)).toEqual([selected])
  const database = new DatabaseSync(join(work, "pins.db"))
  try { database.exec("DELETE FROM board_access_epoch") } finally { database.close() }
  const marker = join(work, "meitheal-board-grants.json")
  await rm(marker)
  const lost = snapshot()
  expect(lost.epoch).toEqual([])

  // This is the actual current ingress/Core fixture. No request interception or replacement marker.
  const checked = page.waitForResponse(response => response.request().method() === "HEAD"
    && new URL(response.url()).pathname.endsWith("/api/boards/household"))
  await page.evaluate(() => window.dispatchEvent(new Event("focus")))
  expect((await checked).status()).toBe(503)
  await expect(root).not.toBeVisible()
  for (const response of [
    await admin.request.get(app + "/api/organization-features"),
    await member.request.get(app + "/api/areas?board_id=household"),
    await admin.request.post(app + "/api/boards", { headers, data: { name: "Must not reopen restored access" } }),
    await admin.request.patch(app + "/api/boards/household", { headers, data: { action: "retire", revision } }),
    await admin.request.post(app + "/api/boards/household/planning", { headers, data: { action: "retire", entity: "area", id: area.id } }),
    await admin.request.delete(app + "/api/areas/" + area.id, { headers: { ...headers, "content-type": "application/json" }, data: {} }),
    await admin.request.put(app + "/api/organization-features", { headers: featureHeaders,
      data: { feature: "goals", audience: "nobody", users: [], revision: featureState.features.goals.revision } }),
  ]) {
    expect(response.status(), response.url() + ": " + await response.text()).toBe(503)
    expect(response.headers()["cache-control"]).toContain("no-store")
    expect(await response.text()).not.toContain("Retained planning after custody loss")
  }
  const reloaded = await page.reload()
  expect(reloaded?.status()).toBe(503)
  await expect(page.getByText("Retained planning after custody loss", { exact: true })).toHaveCount(0)
  expect(snapshot()).toEqual(lost)
  await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" })
})


test("unknown work selectors fail at page entrypoints without nested Astro responses", async ({ boards }) => {
  const { member, app } = boards
  for (const path of ["/tasks?board=unavailable-board", "/boards/unavailable-board", "/progress?board_id=unavailable-board", "/planning?board_id=unavailable-board", "/triage?board_id=unavailable-board"]) {
    const response = await member.request.get(app + path, { maxRedirects: 0 })
    expect(response.status(), path + ": " + await response.text()).toBe(404)
    expect(response.headers()["cache-control"]).toBe("private, no-store")
    expect(response.headers().location).toBeUndefined()
    expect(await response.text()).not.toContain("AstroResponseSentError")
  }
})

test("Board planning redirects and nested Area/Project management keep their admitted scope", async ({ boards }) => {
  const { member, page, app, origin } = boards
  const directory = await member.request.get(app + "/api/boards")
  const proof = directory.headers()["x-meitheal-board-session"]!
  const created = await member.request.post(app + "/api/boards", { headers: { origin, "x-meitheal-board-session": proof }, data: { name: "Nested scope Board" } })
  expect(created.status(), await created.text()).toBe(201)
  const boardId = (await created.json()).id
  const headers = { origin, "x-meitheal-board-session": proof, "x-meitheal-board-id": boardId }
  for (const section of ["goals", "pillars", "routines"]) {
    const response = await member.request.get(app + `/boards/${boardId}?view=groups&section=${section}`, { maxRedirects: 0 })
    expect(response.status(), await response.text()).toBe(302)
    const destination = new URL(response.headers().location!, app)
    expect(destination.pathname).toBe(new URL(app).pathname + (section === "routines" ? "/habits" : "/progress"))
    expect(destination.searchParams.get("board_id")).toBe(boardId)
    expect(destination.hash).toBe(section === "routines" ? "" : "#" + section)
  }
  const area = await member.request.post(app + "/api/areas", { headers, data: { name: "Nested Area" } })
  expect(area.status(), await area.text()).toBe(201)
  const areaId = (await area.json()).id
  const project = await member.request.post(app + "/api/projects", { headers, data: { title: "Nested Project", area_id: areaId } })
  expect(project.status(), await project.text()).toBe(201)
  const projectId = (await project.json()).id
  for (const [selector, id, title] of [["area", areaId, "Nested Area"], ["project", projectId, "Nested Project"]]) {
    const response = await page.goto(app + `/boards/${boardId}?view=groups&${selector}=${id}`)
    expect(response?.status()).toBe(200)
    await expect(page.getByRole("heading", { name: title, exact: true }).first()).toBeVisible()
    await expect(page.locator("body")).not.toContainText("AstroResponseSentError")
  }
})

test("a deleted ordinary Board ticket uses the shared unavailable inspector and Close/Escape recovery", async ({ boards }) => {
  const { member, page, app, origin } = boards
  const directory = await member.request.get(app + "/api/boards")
  const proof = directory.headers()["x-meitheal-board-session"]!
  const board = await member.request.post(app + "/api/boards", { headers: { origin, "x-meitheal-board-session": proof }, data: { name: "Private deleted permalink Board" } })
  expect(board.status(), await board.text()).toBe(201)
  const boardId = (await board.json()).id
  const headers = { origin, "x-meitheal-board-session": proof, "x-meitheal-board-id": boardId }
  const response = await member.request.post(app + "/api/tasks", { headers, data: { title: "Deleted private permalink title", area_id: null } })
  expect(response.status(), await response.text()).toBe(201)
  const task = await response.json()
  const removed = await member.request.delete(app + "/api/tasks/" + task.id, { headers, data: { version: task.task_version } })
  expect(removed.status(), await removed.text()).toBe(204)
  const unavailable = await page.goto(app + `/tickets/${task.id}?board_id=${boardId}`)
  expect(unavailable?.status()).toBe(404)
  await expect(page.getByRole("alert").filter({ hasText: "This task is unavailable." })).toBeVisible()
  await expect(page.getByRole("button", { name: "Copy task link" })).toBeHidden()
  await expect(page.getByRole("button", { name: "Close detail" })).toBeFocused()
  await expect(page.locator("body")).not.toContainText("Deleted private permalink title")
  await expect(page.locator(".kanban-card")).toHaveCount(0)
  await page.keyboard.press("Escape")
  await expect(page).toHaveURL(app + "/tasks#kanban")
  await expect(page.getByRole("navigation", { name: "Task views" }).getByRole("link", { name: "Kanban" })).toBeFocused()
})
