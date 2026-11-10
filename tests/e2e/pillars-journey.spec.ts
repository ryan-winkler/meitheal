import { execFileSync, fork } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, test, type APIRequestContext } from "@playwright/test"

test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires a built App and disposable ingress fixture")

const web = fileURLToPath(new URL("../../apps/web", import.meta.url))
const fixture = fileURLToPath(new URL("../scripts/feedback-ingress-fixture.mjs", import.meta.url))
const admin = { cookie: "feedback-fixture=admin" }

let work: string
let child: ReturnType<typeof fork>
let request: APIRequestContext
let origin: string
let ingress: string

test.beforeAll(async ({ playwright }) => {
  work = await mkdtemp(join(tmpdir(), "meitheal-pillars-journey-"))
  const env = { PATH: process.env.PATH, NODE_ENV: "production", MEITHEAL_DB_URL: `file:${join(work, "meitheal.db")}` }
  execFileSync(process.execPath, ["scripts/migrate.mjs"], { cwd: web, env })
  child = fork(fixture, { cwd: web, env, stdio: ["ignore", "ignore", "inherit", "ipc"] })
  const [info] = await Promise.race([
    once(child, "message", { signal: AbortSignal.timeout(10_000) }),
    once(child, "exit").then(([code]) => { throw new Error(`Pillar fixture exited with ${code}`) }),
  ])
  origin = `http://127.0.0.1:${info.port}`
  ingress = origin + info.configuredPath
  request = await playwright.request.newContext({ extraHTTPHeaders: admin })
})

test.afterAll(async () => {
  await request?.dispose()
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, "exit")
    child.kill()
    await exited
  }
  if (work) await rm(work, { recursive: true, force: true })
})

async function createPillar(name: string) {
  const response = await request.post(ingress + "/api/pillars", { data: { name } })
  expect(response.status()).toBe(201)
  return (await response.json()).pillar.id as string
}

test("Principle updates and removal stay within the selected Pillar", async () => {
  const id = await createPillar("Principle owner")
  const other = await createPillar("Different owner")
  const path = (pillar: string) => ingress + `/api/pillars/${pillar}/principles`
  const created = await request.post(path(id), { data: { statement: "Keep the original boundary" } })
  expect(created.status()).toBe(201)
  const { principle } = await created.json()

  for (const action of ["update", "delete"]) {
    const foreign = await request.post(path(other), {
      data: { action, principleId: principle.id, isNonNegotiable: true },
    })
    expect(foreign.status()).toBe(404)
  }
  const read = async () => {
    const response = await request.get(path(id))
    expect(response.status()).toBe(200)
    return (await response.json()).principles
  }
  expect(await read()).toEqual([principle])

  const updated = await request.post(path(id), {
    data: { action: "update", principleId: principle.id, isNonNegotiable: true },
  })
  expect(updated.status()).toBe(200)
  expect(await read()).toMatchObject([{ id: principle.id, isNonNegotiable: true }])

  const removed = await request.post(path(id), { data: { action: "delete", principleId: principle.id } })
  expect(removed.status()).toBe(200)
  expect(await read()).toEqual([])
})

test("principles persist, update both views, and retain the rejected draft", async ({ browser }) => {
  const id = await createPillar("Household rhythm")
  const context = await browser.newContext({ viewport: { width: 320, height: 760 }, serviceWorkers: "block", extraHTTPHeaders: {} })
  try {
    await context.addCookies([{ name: "feedback-fixture", value: "admin", url: origin }])
    const page = await context.newPage()
    await page.goto(ingress + "/progress#pillars", { waitUntil: "domcontentloaded" })
    const card = page.locator(`[data-pillar-id="${id}"]`)
    const add = card.getByRole("button", { name: "Add principle to Household rhythm" })
    const dialog = page.locator("#pillar-detail-overlay")
    const status = dialog.getByRole("status")
    const input = dialog.getByRole("textbox", { name: "Principle" })
    const save = dialog.getByRole("button", { name: "Save principle" })

    await expect(add).toBeEnabled()
    await add.focus()
    await page.keyboard.press("Enter")
    await expect(input).toBeFocused()
    await input.fill("Make a plan before the week starts")
    await input.press("Enter")
    await expect(status).toHaveText("Principle saved.")
    await expect(dialog.getByText("Make a plan before the week starts")).toBeVisible()
    await expect(card.locator("[data-principles-count]")).toHaveText("1")
    await expect(input).toBeHidden()

    await dialog.getByRole("button", { name: "Add principle", exact: true }).click()
    const boundary = "Gaeilge-" + "Fada".repeat(48)
    await input.fill(boundary)
    const checkbox = dialog.getByRole("checkbox", { name: "Non-Negotiable" })
    await checkbox.check()
    const path = "**/api/pillars/*/principles"
    await page.route(path, route => route.fulfill({ status: 503, json: { error: "fixture rejects one write" } }), { times: 1 })
    await save.click()
    await expect(status).toHaveText("Could not save the principle. Try again.")
    await expect(input).toHaveValue(boundary)
    await expect(checkbox).toBeChecked()
    await expect(card.locator("[data-principles-count]")).toHaveText("1")
    await save.click()
    await expect(status).toHaveText("Non-negotiable principle saved.")
    const row = dialog.locator("li[data-principle-id]").filter({ hasText: boundary })
    const toggle = row.getByRole("button", { name: "Non-Negotiable" })
    await expect(toggle).toHaveAttribute("aria-pressed", "true")
    await toggle.click()
    await expect(toggle).toHaveAttribute("aria-pressed", "false")
    await toggle.click()
    await expect(toggle).toHaveAttribute("aria-pressed", "true")

    await page.keyboard.press("Escape")
    await expect(add).toBeFocused()
    await expect(card.locator("[data-principles-count]")).toHaveText("2")
    await card.getByRole("button", { name: "Principles 2" }).click()
    await expect(card.getByText(boundary, { exact: true })).toBeVisible()
    await card.getByRole("button", { name: "View Household rhythm details" }).click()
    await expect(row).toHaveCount(1)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320)
    await page.reload({ waitUntil: "domcontentloaded" })
    await expect(card.locator("[data-principles-count]")).toHaveText("2")
    await card.getByRole("button", { name: "View Household rhythm details" }).click()
    await expect(toggle).toHaveAttribute("aria-pressed", "true")
  } finally {
    await context.close()
  }
})

test("both Edit actions update the intended Pillar and return focus on cancel", async ({ browser }) => {
  const first = await createPillar("Pillar to edit")
  const second = await createPillar("Pillar to keep")
  const context = await browser.newContext({ viewport: { width: 320, height: 760 }, serviceWorkers: "block", extraHTTPHeaders: {} })
  try {
    await context.addCookies([{ name: "feedback-fixture", value: "admin", url: origin }])
    const page = await context.newPage()
    await page.goto(ingress + "/progress#pillars", { waitUntil: "domcontentloaded" })
    const firstCard = page.locator(`[data-pillar-id="${first}"]`)
    const secondCard = page.locator(`[data-pillar-id="${second}"]`)
    const edit = firstCard.getByRole("button", { name: "Edit Pillar to edit" })
    const form = page.locator("#pillar-form-overlay")
    await edit.click()
    await expect(form.locator("#pillar-name")).toHaveValue("Pillar to edit")
    await page.keyboard.press("Escape")
    await expect(edit).toBeFocused()

    await firstCard.getByRole("button", { name: "View Pillar to edit details" }).click()
    await page.locator("#pillar-detail-edit-btn").click()
    await expect(form.locator("#pillar-name")).toHaveValue("Pillar to edit")
    await form.locator("#pillar-name").fill("Edited same pillar")
    await page.route(`**/api/pillars/${first}`, route => route.fulfill({
      status: 503,
      json: { error: "Pillar save temporarily unavailable" },
    }), { times: 1 })
    await form.locator("#submit-pillar-btn").click()
    await expect(page.locator("#toast-container").getByText("Pillar save temporarily unavailable")).toBeVisible()
    await expect(form.locator("#pillar-name")).toHaveValue("Edited same pillar")
    await expect(firstCard.getByRole("button", { name: "Edit Pillar to edit" })).toHaveCount(1)

    const saved = page.waitForResponse(response => response.request().method() === "PATCH" && response.url().endsWith("/api/pillars/" + first))
    await form.locator("#submit-pillar-btn").click()
    expect((await saved).ok()).toBe(true)
    await expect(firstCard.getByRole("button", { name: "Edit Edited same pillar" })).toBeVisible()
    await expect(secondCard.getByRole("button", { name: "Edit Pillar to keep" })).toBeVisible()
    await expect(page.locator("#toast-container").getByText('"Edited same pillar" updated', { exact: true })).toBeVisible()
  } finally {
    await context.close()
  }
})

test("Current signal aligns at 320 px and desktop and its links stay in ingress", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 320, height: 780 }, reducedMotion: "reduce", serviceWorkers: "block", extraHTTPHeaders: {} })
  try {
    await context.addCookies([{ name: "feedback-fixture", value: "admin", url: origin }])
    const page = await context.newPage()
    const signal = page.locator(".dashboard-hero__status")
    await page.goto(ingress + "/#dashboard-overview", { waitUntil: "domcontentloaded" })
    await expect(signal.getByText("Everything is steady")).toBeVisible()
    await expect(signal.getByRole("link")).toHaveCount(0)
    const active = await request.post(ingress + "/api/tasks", { data: { title: "Active QA task", status: "active" } })
    expect(active.status()).toBe(201)
    await page.reload({ waitUntil: "domcontentloaded" })
    await expect(signal.getByRole("link")).toHaveAttribute("href", /\/tasks\?status=active$/)
    const overdue = await request.post(ingress + "/api/tasks", { data: { title: "Overdue QA task", due_date: "2020-01-01" } })
    expect(overdue.status()).toBe(201)
    await page.reload({ waitUntil: "domcontentloaded" })
    const link = signal.getByRole("link")
    await expect(link).toHaveAttribute("href", /\/tasks\?status=overdue$/)
    for (const width of [320, 1440]) {
      await page.setViewportSize({ width, height: 780 })
      const layout = await signal.evaluate(node => ({
        heading: node.parentElement!.querySelector(".dashboard-hero__title")!.getBoundingClientRect().left,
        label: node.querySelector(".dashboard-hero__status-label")!.getBoundingClientRect().left,
        link: node.querySelector("a")!.getBoundingClientRect().left,
        alignment: getComputedStyle(node).alignItems,
        width: document.documentElement.scrollWidth,
      }))
      expect(Math.abs(layout.label - layout.heading)).toBeLessThan(1)
      if (width === 320) expect(Math.abs(layout.link - layout.label)).toBeLessThan(1)
      else expect(layout.alignment).toBe("baseline")
      expect(layout.width).toBe(width)
      await page.locator(".dashboard-hero__chip").last().focus()
      await page.keyboard.press("Tab")
      await expect(link).toBeFocused()
      await expect(link).toHaveCSS("outline-style", "solid")
    }
    await link.press("Enter")
    await expect(page).toHaveURL(ingress + "/tasks?status=overdue#kanban")
  } finally {
    await context.close()
  }
})

test("both legacy Pillar routes retain the ingress prefix", async () => {
  for (const path of ["/pillars", "/pillars/legacy-slug"]) {
    const response = await request.get(ingress + path, { maxRedirects: 0 })
    expect(response.status()).toBe(302)
    expect(response.headers().location).toBe(new URL(ingress).pathname + "/progress#pillars")
  }
})
