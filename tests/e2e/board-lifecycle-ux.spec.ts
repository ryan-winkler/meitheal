import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { expect, test as base, type BrowserContext, type Page } from "@playwright/test"
import { launchPinBrowser, startCoreFixture } from "../scripts/task-pins-fixture"

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
      const createContext = async (user: "member" | "admin") => {
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
    await deleted.getByRole("button", { name: "Restore Board " + name, exact: true }).click()
    expect((await restored).status()).toBe(200)
    await expect(page.locator("[data-board-directory]").getByRole("link", { name, exact: true })).toBeVisible()
    await expect(page.getByRole("button", { name: "Restore Board " + name, exact: true })).toHaveCount(0)
    expect((await (await member.request.get(app + "/api/boards/" + ids[index])).json()).board.state).toBe("active")
  }
})

test("Household creation keeps default, personalized and Irish Area labels consistent", async ({ boards }, testInfo) => {
  const { page, member, app, origin, work } = boards
  // Model a catalog with no active Areas, retaining its seeded relationships.
  // The public API intentionally protects the default Area from deletion.
  const db = new DatabaseSync(join(work, "pins.db"))
  try { db.prepare("UPDATE areas SET retired_at = 1 WHERE id = 'default'").run() } finally { db.close() }
  const catalog = await member.request.get(app + "/api/areas")
  expect(catalog.status()).toBe(200)
  expect((await catalog.json()).areas).toEqual([])
  const form = page.locator("[data-household-group-create]")
  await page.goto(app + "/boards/household?view=groups")
  await expect(page.locator(".board-empty")).toHaveText("Choose “New Area” to organize related work.")
  await form.locator("..").locator("summary").click()
  await expect(form.getByRole("button", { name: "Create Area", exact: true })).toBeVisible()
  const endpoint = app + "/api/organization-labels"
  const labels = await (await member.request.get(endpoint)).json()
  const renamed = await member.request.put(endpoint, { headers: { origin }, data: { ...labels, forms: { ...labels.forms, group: ["Room", "Rooms"] } } })
  expect(renamed.status(), await renamed.text()).toBe(204)
  await page.reload()
  await expect(form.locator("..").locator("summary")).toHaveText("New Room")
  await form.locator("..").locator("summary").click()
  await expect(form.getByRole("button", { name: "Create Room", exact: true })).toBeVisible()
  await expect(page.locator(".board-empty")).toHaveText("Choose “New Room” to organize related work.")
  await member.addCookies([{ name: "meitheal-locale", value: "ga", url: origin }])
  await page.reload()
  await expect(page.locator(".board-empty")).toHaveText("Choose “Réimse nua” to organize related work.")
  await member.addCookies([{ name: "meitheal-locale", value: "en", url: origin }])
  await page.reload()
  await form.locator("..").locator("summary").click()
  await page.screenshot({ path: testInfo.outputPath("personalized-area-submit.png"), fullPage: true })
  await form.getByRole("textbox", { name: "Name", exact: true }).fill("Reading room")
  await form.getByRole("button", { name: "Create Room", exact: true }).click()
  await expect(page).toHaveURL(url => Boolean(url.searchParams.get("area")))
  const id = new URL(page.url()).searchParams.get("area")
  expect((await (await member.request.get(app + "/api/areas/" + id)).json()).name).toBe("Reading room")

  await member.addCookies([{ name: "meitheal-locale", value: "ga", url: origin }])
  await page.goto(app + "/boards/household?view=groups")
  await expect(form.locator("..").locator("summary")).toHaveText("Réimse nua")
  await form.locator("..").locator("summary").click()
  await expect(form.getByRole("button", { name: "Réimse nua", exact: true })).toBeVisible()
})

test("Unavailable Areas omit the create instruction and preserve Unfiled Projects", async ({ boards }, testInfo) => {
  const { page, member, admin, app, origin } = boards
  const project = await member.request.post(app + "/api/projects", { headers: { origin }, data: { title: "Loose lighting Project" } })
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
    await recovery.focus()
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

test("a markerless pre-grant restore cannot inherit feature access or bootstrap grants", async ({ boards }) => {
  const { member, admin, app, origin, work } = boards
  const directory = await member.request.get(app + "/api/boards")
  const database = new DatabaseSync(join(work, "pins.db"))
  try { database.exec("DELETE FROM board_access_epoch") } finally { database.close() }
  await rm(join(work, "meitheal-board-grants.json"))
  expect((await admin.request.get(app + "/api/organization-features")).status()).toBe(503)
  // Areas normally inherit Everyone when no explicit policy exists.
  expect((await member.request.get(app + "/api/areas")).status()).toBe(404)
  expect((await member.request.post(app + "/api/boards", {
    headers: { origin, "x-meitheal-board-session": directory.headers()["x-meitheal-board-session"]! },
    data: { name: "Cannot reopen restored permissions" },
  })).status()).toBe(404)
})
