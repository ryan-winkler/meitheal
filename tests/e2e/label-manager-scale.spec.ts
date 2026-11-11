import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import AxeBuilder from "@axe-core/playwright"
import { expect, test, type Browser, type Page, type Route } from "@playwright/test"
import { launchPinBrowser, startCoreFixture } from "../scripts/task-pins-fixture"

test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires built app and simulated Core roster")

const name = (id: number) => id === 26 ? 'Café roof & "family" repairs' : `Household label ${String(id).padStart(4, "0")}`
const row = (page: Page, id: number) => page.locator(`.label-settings-row[data-id="${id}"]`)

async function fixture(count: number, run: (f: { page: Page, origin: string, prefix: string }) => Promise<void>) {
  const work = await mkdtemp(join(tmpdir(), "meitheal-label-scale-"))
  const child = startCoreFixture(work)
  const logs: string[] = []
  child.stdout?.on("data", value => logs.push(String(value)))
  child.stderr?.on("data", value => logs.push(String(value)))
  let browser: Browser | undefined
  try {
    const [info] = await once(child, "message", { signal: AbortSignal.timeout(10_000) })
    const updated = once(child, "message", { signal: AbortSignal.timeout(3000) })
    child.send({ type: "fixture-core", user: "admin", isOwner: false, groupIds: ["system-admin"] })
    await updated
    browser = await launchPinBrowser(work)
    const origin = `https://127.0.0.1:${info.port}`
    const context = await browser.newContext({ ignoreHTTPSErrors: true, extraHTTPHeaders: {},
      viewport: { width: 1100, height: 900 }, reducedMotion: "reduce", serviceWorkers: "block" })
    await context.addCookies([{ name: "feedback-fixture", value: "admin", url: origin }])
    const page = await context.newPage()
    const errors: string[] = []
    page.on("pageerror", error => errors.push(String(error)))
    await page.goto(origin + info.configuredPath + "/settings#workflow-settings")
    await expect(page.locator("[data-label-editor]")).toHaveAttribute("data-labels-ready", "true")
    const db = new DatabaseSync(join(work, "pins.db"))
    try {
      const insert = db.prepare("INSERT INTO vikunja_labels (id,title,hex_color) VALUES (?,?,?)")
      db.exec("BEGIN")
      for (let id = 1; id <= count; id++) insert.run(id, name(id), id === 1 ? "#FFFFFF" : id % 2 ? "#ffffff" : "#000000")
      db.exec("COMMIT")
    } finally { db.close() }
    await page.reload()
    await expect(page.locator("[data-label-editor]")).toHaveAttribute("data-labels-ready", "true")
    await run({ page, origin, prefix: info.configuredPath })
    expect(errors).toEqual([])
  } catch (error) {
    console.error(logs.slice(-8).join(""))
    throw error
  } finally {
    await browser?.close()
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit", { signal: AbortSignal.timeout(5000) })
      child.kill("SIGTERM")
      await exited
    }
    await rm(work, { recursive: true, force: true })
  }
}

async function heldResponse(page: Page, path: string, method: string, failure = false) {
  let release!: () => void
  let complete!: () => void
  let captured = false
  let writes = 0
  const hold = new Promise<void>(resolve => { release = resolve })
  const finished = new Promise<void>(resolve => { complete = resolve })
  const handler = async (route: Route) => {
    if (route.request().method() !== method) return route.continue()
    writes++
    if (writes > 1) return route.continue()
    const response = failure ? undefined : await route.fetch({ headers: {
      ...await route.request().allHeaders(), origin: new URL(page.url()).origin, referer: page.url(),
      "sec-fetch-mode": "same-origin", "sec-fetch-site": "same-origin",
    } })
    captured = true
    await hold
    if (failure) await route.fulfill({ status: 409, contentType: "application/json", body: '{"ok":false,"errorCode":"conflict"}' })
    else {
      if (!response) throw new Error("Expected a fetched label response")
      await route.fulfill({ response })
    }
    complete()
  }
  await page.route(path, handler)
  return {
    started: () => expect.poll(() => captured).toBe(true), release, finished,
    writes: () => writes,
    close: async () => {
      release()
      await page.unroute(path, handler)
    },
  }
}

for (const count of [0, 1, 26, 1000]) {
  test(`shared definitions show truthful counts with at most 25 editable rows (${count} labels)`, async () => {
    test.slow()
    await fixture(count, async ({ page }) => {
      const search = page.locator("[data-label-search]")
      const range = page.locator("[data-label-range]")
      const next = page.locator("[data-label-next]")
      const previous = page.locator("[data-label-previous]")
      const formatted = new Intl.NumberFormat("en").format(count)
      await expect(search).toBeEnabled()
      await expect(range).toHaveText(`Showing ${count ? 1 : 0}–${Math.min(25, count)}. Matching: ${formatted}. Total: ${formatted}.`)
      await expect(page.locator(".label-settings-row")).toHaveCount(Math.min(25, count))
      await expect(page.locator("[data-label-pages]")).toBeVisible({ visible: count > 25 })
      if (!count) {
        await expect(page.locator("[data-label-empty]")).toHaveText("No labels yet. Create one above.")
        return
      }
      await expect(row(page, 1).locator("[data-badge-id]")).toHaveText(name(1))
      if (count > 25) {
        await expect(previous).toBeDisabled()
        const pages = Math.ceil(count / 25)
        for (let current = 2; current <= pages; current++) {
          await next.focus()
          await next.press("Enter")
          await expect(page.locator("[data-label-page]")).toHaveText(`Page ${current} of ${pages}`)
          expect(await page.locator(".label-settings-row").count()).toBeLessThanOrEqual(25)
        }
        await expect(next).toBeDisabled()
        await expect(previous).toBeFocused()
        await expect(row(page, count).locator("[data-badge-id]")).toHaveText(name(count))
        await search.fill(" CAFÉ roof ".normalize("NFD"))
        await expect(search).toBeFocused()
        await expect(page.locator(".label-settings-row")).toHaveCount(1)
        await expect(row(page, 26)).toBeVisible()
        await expect(range).toHaveText(`Showing 1–1. Matching: 1. Total: ${formatted}.`)
      }
      await search.fill("No household definition matches this")
      await expect(page.locator(".label-settings-row")).toHaveCount(0)
      await expect(page.locator("[data-label-empty]")).toHaveText("No labels match your search.")
      await expect(range).toHaveText(`Showing 0–0. Matching: 0. Total: ${formatted}.`)
      await search.fill("")
      await expect(row(page, 1)).toBeVisible()
      await expect(row(page, 1).locator(".label-row-status")).toHaveText("")
      await expect(page.locator(".label-settings-row")).toHaveCount(Math.min(25, count))
    })
  })
}

for (const failure of [false, true]) {
  test(`an off-page Save ${failure ? "failure" : "acknowledgement"} retains record state and never moves focus`, async () => {
    test.slow()
    await fixture(26, async ({ page, prefix }) => {
      const title = row(page, 1).locator("input[type=text]")
      await title.fill("  Edited household roof  ")
      await row(page, 1).locator("input[type=color]").fill("#123456")
      const held = await heldResponse(page, "**" + prefix + "/api/labels/1", "PUT", failure)
      try {
        await row(page, 1).locator("button[type=submit]").click()
        await held.started()
        await page.locator("[data-label-next]").click()
        await expect(row(page, 1)).toHaveCount(0)
        await page.locator("[data-label-previous]").click()
        await expect(row(page, 1).locator("input[type=text]")).toHaveJSProperty("readOnly", true)
        await expect(row(page, 1).locator("input[type=color]")).toBeDisabled()
        await page.locator("[data-label-next]").click()
        await page.locator("#new-label-title").fill("Independent create draft")
        held.release()
        await expect(page.locator("[data-label-editor-status]")).toContainText(failure ? "Could not save" : "Saved “Edited household roof”.")
        await expect(page.locator("#new-label-title")).toBeFocused()
        await expect(page.locator("#new-label-title")).toHaveValue("Independent create draft")
        await page.locator("[data-label-previous]").click()
        await expect(title).toHaveValue(failure ? "  Edited household roof  " : "Edited household roof")
        await expect(row(page, 1).locator("input[type=color]")).toHaveValue("#123456")
        await expect(row(page, 1).locator("[data-badge-id]")).toHaveText(failure ? name(1) : "Edited household roof")
        await expect(row(page, 1).locator(".label-row-status")).toContainText(failure ? "shares the old or new name" : "Saved.")
        await expect(title).toBeEditable()
        expect(held.writes()).toBe(1)
      } finally { await held.close() }
      // Dirty values and row errors survive both search eviction and pagination.
      await title.fill("Another unsaved edit")
      await page.locator("[data-label-search]").fill("CAFÉ")
      await expect(row(page, 1)).toHaveCount(0)
      await page.locator("[data-label-search]").fill("")
      await expect(title).toHaveValue("Another unsaved edit")
      await expect(row(page, 1).locator("input[type=color]")).toHaveValue("#123456")
    })
  })
}

test("pending creates respect current search and duplicate responses preserve an existing unsaved definition", async () => {
  test.slow()
  await fixture(26, async ({ page, prefix }) => {
    const title = row(page, 1).locator("input[type=text]")
    await title.fill("Keep this unsaved name")
    await row(page, 1).locator("input[type=color]").fill("#abcdef")
    for (const duplicate of [true, false]) {
      await page.locator("#new-label-title").fill(duplicate ? name(1) : "New household planning")
      const held = await heldResponse(page, "**" + prefix + "/api/labels", "POST")
      try {
        await page.locator("#create-label-form button[type=submit]").click()
        await held.started()
        await page.locator("[data-label-next]").click()
        await page.locator("[data-label-search]").fill("CAFÉ")
        await expect(page.locator("#new-label-title")).toHaveJSProperty("readOnly", true)
        held.release()
        await expect(page.locator("[data-label-editor-status]")).toHaveText(duplicate ? "This label already exists." : "Label created.")
        await expect(page.locator("[data-label-search]")).toBeFocused()
        await expect(row(page, 26)).toBeVisible()
        await expect(page.locator(".label-settings-row")).toHaveCount(1)
        await expect(page.locator("[data-label-range]")).toHaveText(`Showing 1–1. Matching: 1. Total: ${duplicate ? 26 : 27}.`)
        expect(held.writes()).toBe(1)
      } finally { await held.close() }
      await page.locator("[data-label-search]").fill("")
      await expect(title).toHaveValue("Keep this unsaved name")
      await expect(row(page, 1).locator("input[type=color]")).toHaveValue("#abcdef")
      await expect(row(page, 1).locator("[data-badge-id]")).toHaveText(name(1))
    }
    await page.locator("[data-label-next]").click()
    await expect(page.locator("[data-badge-id]").filter({ hasText: "New household planning" })).toBeVisible()
  })
})

test("batch cleanup repairs only removed editor focus and retains surviving editor nodes and drafts", async () => {
  test.slow()
  await fixture(28, async ({ page, prefix }) => {
    const survivor = row(page, 3).locator("input[type=text]")
    await survivor.fill("Keep a dirty household draft")
    const node = await survivor.elementHandle()
    const cleanup = page.locator("[data-label-cleanup]")
    await cleanup.locator("[data-cleanup-review]").click()
    await cleanup.getByRole("checkbox", { name: name(1), exact: true }).check()
    await cleanup.getByRole("checkbox", { name: name(2), exact: true }).check()
    const held = await heldResponse(page, "**" + prefix + "/api/labels/cleanup", "POST")
    try {
      await cleanup.locator("[data-cleanup-remove]").click()
      await page.getByRole("alertdialog").getByRole("button", { name: "Remove selected labels", exact: true }).click()
      await held.started()
      await expect(page.getByRole("alertdialog")).toHaveCount(0)
      await row(page, 1).locator("input[type=text]").focus()
      held.release()
      await expect(row(page, 1)).toHaveCount(0)
      await expect(row(page, 2)).toHaveCount(0)
      await expect(survivor).toBeFocused()
      await expect(survivor).toHaveValue("Keep a dirty household draft")
      expect(await survivor.evaluate((input, old) => input === old, node)).toBe(true)
      await expect(page.locator("[data-label-range]")).toHaveText("Showing 1–25. Matching: 26. Total: 26.")
      await expect(page.locator(".label-settings-row")).toHaveCount(25)
    } finally { await held.close() }
  })
})

test("off-page cleanup clamps the final page without stealing foreign focus; literal-name deletion remains usable", async () => {
  test.slow()
  await fixture(26, async ({ page, prefix }) => {
    const cleanup = page.locator("[data-label-cleanup]")
    await cleanup.locator("[data-cleanup-review]").click()
    await cleanup.getByRole("checkbox", { name: name(1), exact: true }).check()
    await page.locator("[data-label-next]").click()
    await expect(row(page, 26)).toBeVisible()
    const held = await heldResponse(page, "**" + prefix + "/api/labels/cleanup", "POST")
    try {
      await cleanup.locator("[data-cleanup-remove]").click()
      await page.getByRole("alertdialog").getByRole("button", { name: "Remove selected labels", exact: true }).click()
      await held.started()
      await expect(page.getByRole("alertdialog")).toHaveCount(0)
      await page.locator("#new-label-title").fill("Keep my focus")
      held.release()
      await expect(page.locator("[data-label-range]")).toHaveText("Showing 1–25. Matching: 25. Total: 25.")
      await expect(page.locator("[data-label-pages]")).toBeHidden()
      await expect(page.locator("#new-label-title")).toBeFocused()
      await expect(row(page, 26)).toBeVisible()
      await expect(row(page, 1)).toHaveCount(0)
    } finally { await held.close() }
    await row(page, 26).locator("[data-delete-label]").click()
    await expect(page.locator("#confirm-message")).toContainText(`Delete “${name(26)}”?`)
    await expect(page.locator("#confirm-message")).not.toContainText("&amp;")
    await page.getByRole("alertdialog").getByRole("button", { name: "Delete", exact: true }).click()
    await expect(row(page, 26)).toHaveCount(0)
    await expect(page.locator("[data-label-range]")).toHaveText("Showing 1–24. Matching: 24. Total: 24.")
    await expect(row(page, 25).locator("input[type=text]")).toBeFocused()
  })
})

test("a failed initial load reports unknown totals and retry enables the complete searchable result", async () => {
  test.slow()
  await fixture(26, async ({ page, prefix }) => {
    const failure = async (route: Route) => route.request().method() === "GET"
      ? route.fulfill({ status: 503, contentType: "application/json", body: '{"ok":false,"errorCode":"unavailable"}' }) : route.continue()
    await page.route("**" + prefix + "/api/labels", failure)
    await page.reload()
    await expect(page.locator("[data-label-range]")).toHaveText("Could not load labels. Try again.")
    await expect(page.locator("[data-label-search]")).toBeDisabled()
    await expect(page.locator("#new-label-title")).toBeEditable()
    await expect(page.locator("[data-label-editor-retry]")).toBeVisible()
    await page.unroute("**" + prefix + "/api/labels", failure)
    await page.locator("[data-label-editor-retry]").click()
    await expect(page.locator("[data-label-search]")).toBeEnabled()
    await expect(page.locator("[data-label-range]")).toHaveText("Showing 1–25. Matching: 26. Total: 26.")
    await page.locator("[data-label-search]").fill("CAFÉ")
    await expect(row(page, 26)).toBeVisible()
  })
})

test("search and pages remain labelled, keyboard reachable and readable with narrow, enlarged, dark and Irish settings", async () => {
  test.slow()
  await fixture(26, async ({ page, origin }) => {
    const search = page.getByRole("searchbox", { name: "Search labels", exact: true })
    await expect(search).toBeVisible()
    await search.focus()
    await search.press("Tab")
    await expect(page.locator("[data-label-next]")).toBeFocused()
    await page.locator("[data-label-next]").press("Enter")
    await expect(page.locator("[data-label-previous]")).toBeFocused()
    await page.locator("[data-label-previous]").press("Enter")
    await expect(page.locator("[data-label-next]")).toBeFocused()
    const violations = await new AxeBuilder({ page }).include("[data-label-editor]").analyze()
    expect(violations.violations).toEqual([])
    for (const [width, scale, direction, theme] of [[320, 1, "ltr", "light"], [736, 2, "rtl", "dark"]] as const) {
      await page.setViewportSize({ width, height: 900 })
      await page.evaluate(({ scale, direction, theme }) => {
        document.documentElement.style.fontSize = `${16 * scale}px`
        document.documentElement.dir = direction
        document.documentElement.setAttribute("data-theme", theme)
      }, { scale, direction, theme })
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true)
      for (const selector of ["[data-label-previous]", "[data-label-next]"]) {
        expect(await page.locator(selector).evaluate(button => button.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44)
      }
    }
    await page.context().addCookies([{ name: "meitheal-locale", value: "ga", url: origin }])
    await page.reload()
    await expect(page.locator("html")).toHaveAttribute("lang", "ga")
    await expect(page.getByRole("searchbox", { name: "Cuardaigh lipéid", exact: true })).toBeVisible()
    await expect(page.locator("[data-label-range]")).toHaveText("Ag taispeáint 1–25. Meaitseálacha: 26. Iomlán: 26.")
    await expect(page.locator("[data-label-page]")).toHaveText("Leathanach 1 as 2")
    await expect(page.locator("[data-label-next]")).toHaveText("Ar aghaidh")
    await page.locator("[data-label-search]").fill("not found")
    await expect(page.locator("[data-label-empty]")).toHaveText("Níl aon lipéad ag teacht le do chuardach.")
  })
})

test("a held Delete settles after paging and searching without restoring a removed definition or moving focus", async () => {
  test.slow()
  await fixture(28, async ({ page, prefix }) => {
    await page.locator("[data-label-next]").click()
    const held = await heldResponse(page, "**" + prefix + "/api/labels/26", "DELETE")
    try {
      await row(page, 26).locator("[data-delete-label]").click()
      await page.getByRole("alertdialog").getByRole("button", { name: "Delete", exact: true }).click()
      await held.started()
      await expect(page.getByRole("alertdialog")).toHaveCount(0)
      await page.locator("[data-label-previous]").click()
      await page.locator("[data-label-search]").fill("household")
      held.release()
      await expect(page.locator("[data-label-range]")).toHaveText("Showing 1–25. Matching: 27. Total: 27.")
      await expect(page.locator("[data-label-search]")).toBeFocused()
      await page.locator("[data-label-search]").fill("")
      await page.locator("[data-label-next]").click()
      await expect(page.locator(".label-settings-row")).toHaveCount(2)
      await expect(row(page, 26)).toHaveCount(0)
      await expect(row(page, 27)).toBeVisible()
      expect(held.writes()).toBe(1)
    } finally { await held.close() }
  })
})

test("cleanup tombstones an off-page pending Save before its late acknowledgement arrives", async () => {
  test.slow()
  await fixture(26, async ({ page, prefix }) => {
    const held = await heldResponse(page, "**" + prefix + "/api/labels/1", "PUT")
    try {
      await row(page, 1).locator("input[type=text]").fill("Committed while reply is held")
      await row(page, 1).locator("button[type=submit]").click()
      await held.started()
      await page.locator("[data-label-next]").click()
      const cleanup = page.locator("[data-label-cleanup]")
      await cleanup.locator("[data-cleanup-review]").click()
      await cleanup.getByRole("checkbox", { name: "Committed while reply is held", exact: true }).check()
      await cleanup.locator("[data-cleanup-remove]").click()
      await page.getByRole("alertdialog").getByRole("button", { name: "Remove selected labels", exact: true }).click()
      await expect(cleanup.locator("[data-cleanup-status]")).toHaveText("Label removed.")
      await page.locator("#new-label-title").fill("Independent work")
      held.release()
      await held.finished
      await expect(page.locator("[data-label-range]")).toHaveText("Showing 1–25. Matching: 25. Total: 25.")
      await expect(row(page, 1)).toHaveCount(0)
      await expect(page.locator("#new-label-title")).toBeFocused()
      // Search proves the late record did not return to the full model, even unmounted.
      await page.locator("[data-label-search]").fill("Committed while reply is held")
      await expect(page.locator(".label-settings-row")).toHaveCount(0)
      await expect(page.locator("[data-label-range]")).toHaveText("Showing 0–0. Matching: 0. Total: 25.")
      expect(held.writes()).toBe(1)
    } finally { await held.close() }
  })
})


test("a held failed initial list preserves an eventless draft in a newly created editor", async () => {
  test.slow()
  await fixture(0, async ({ page, prefix }) => {
    let release!: () => void
    let captured = false
    const held = new Promise<void>(resolve => { release = resolve })
    const handler = async (route: Route) => {
      if (route.request().method() !== "GET") return route.continue()
      captured = true
      await held
      await route.fulfill({ status: 503, contentType: "application/json", body: '{"ok":false,"errorCode":"unavailable"}' })
    }
    await page.route("**" + prefix + "/api/labels", handler)
    try {
      await page.reload()
      await expect.poll(() => captured).toBe(true)
      await page.locator("#new-label-title").fill("Household recovery label")
      await page.locator("#create-label-form button[type=submit]").click()
      await expect(page.locator("[data-label-editor-status]")).toHaveText("Label created.")
      const title = page.locator(".label-title-edit")
      await expect(title).toHaveValue("Household recovery label")
      // Some browser/autofill paths change a value without input/change events.
      await title.evaluate(input => { (input as HTMLInputElement).value = "Autofilled household draft" })
      await title.focus()
      release()
      await expect(page.locator("[data-label-range]")).toHaveText("Could not load labels. Try again.")
      await expect(title).toHaveValue("Autofilled household draft")
      await expect(title).toBeFocused()
      await expect(page.locator(".label-row-status")).toHaveText("Unsaved changes.")
    } finally {
      release()
      await page.unroute("**" + prefix + "/api/labels", handler)
    }
  })
})
