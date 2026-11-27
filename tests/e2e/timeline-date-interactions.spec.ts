import { expect, test as base, type Locator, type Page } from "@playwright/test"
import { currentBoardWriteHeaders } from "../helpers/current-board-http"
import { deferred } from "./_helpers"

const dayMs = 86_400_000
const addDays = (date: string, days: number) => new Date(Date.parse(date) + days * dayMs).toISOString().slice(0, 10)

const test = base.extend<{ datedTask: { id: string; start: string; end: string; due: string } }>({
  datedTask: async ({ request, baseURL }, use) => {
    const headers = await currentBoardWriteHeaders(request, "household", { origin: new URL(baseURL!).origin })
    const start = new Date().toISOString().slice(0, 10)
    const end = addDays(start, 6)
    const due = addDays(start, 10)
    const created = await request.post("/api/tasks", { headers, data: {
      title: "Timeline date interaction fixture", start_date: start, end_date: end, due_date: due,
    } })
    expect(created.status(), await created.text()).toBe(201)
    const { id } = await created.json() as { id: string }
    try { await use({ id, start, end, due }) }
    finally { await request.delete(`/api/tasks/${id}`, { headers }) }
  },
})

test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires a disposable App server")
test.use({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block", reducedMotion: "reduce" })

async function drag(page: Page, source: Locator, delta: number) {
  await source.scrollIntoViewIfNeeded()
  const box = (await source.boundingBox())!
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  try { await page.mouse.move(x + delta, y, { steps: 5 }) }
  finally { await page.mouse.up() }
}

test("another drag or resize cannot overwrite a pending date edit", async ({ page, request, datedTask }) => {
  const { id, start } = datedTask
  const path = `/api/tasks/${id}`
  const timeline = "/boards/household?view=timeline#timeline"
  await page.clock.install()
  await page.goto(timeline)
  const chart = page.locator("#gantt-chart")
  const bar = chart.locator(`.gantt-bar[data-task-id="${id}"]`)
  const rect = bar.locator("rect").first()
  await expect(rect).toBeVisible()
  const pxPerDay = Number(await chart.getAttribute("data-px-per-day"))
  const x = async () => Number(await rect.getAttribute("x"))
  const original = await x()
  const release = deferred<void>()
  let attempts = 0
  await page.route(`**${path}`, async route => {
    if (route.request().method() === "PUT" && ++attempts === 1) await release.promise
    await route.continue()
  })
  try {
    await drag(page, rect, 2 * pxPerDay)
    await expect.poll(() => attempts).toBe(1)
    await expect(bar).toHaveAttribute("aria-busy", "true")
    const preview = await x()
    expect(preview - original).toBeCloseTo(2 * pxPerDay)

    // Let the first gesture's click suppression expire. The second drag
    // releases inside the busy bar and the browser can dispatch a click.
    await page.clock.fastForward(250)
    await drag(page, rect, pxPerDay)
    await expect(page.locator(".gantt-popup")).toHaveCount(0)
    await drag(page, bar.locator(".gantt-resize-handle--left"), pxPerDay)
    await expect(page.locator(".gantt-popup")).toHaveCount(0)
    await expect(page).toHaveURL(timeline)
    expect(attempts).toBe(1)
    expect(await x()).toBeCloseTo(preview)
    release.resolve()

    await expect(page.getByRole("status").filter({ hasText: "Dates updated" })).toBeVisible()
    await expect(bar).not.toHaveAttribute("aria-busy")
    expect(await x()).toBeCloseTo(preview)
    const stored = await (await request.get(path)).json()
    expect(stored.start_date).toBe(addDays(start, 2))
    await rect.click()
    await expect(page.getByRole("button", { name: /View Details/ })).toBeVisible()
    expect((await page.reload())?.status()).toBe(200)
    await expect(page).toHaveURL(timeline)
    await expect(rect).toBeVisible()
    expect(await x()).toBeCloseTo(preview)
  } finally { release.resolve() }
})

test("resizing only a grouped bar's start preserves its distinct due date", async ({ page, request, datedTask }) => {
  const { id, start, due, end } = datedTask
  const path = `/api/tasks/${id}`
  await page.goto("/boards/household?view=timeline&groupBy=priority#timeline")
  const chart = page.locator("#gantt-chart")
  const handle = chart.locator(`.gantt-bar[data-task-id="${id}"] .gantt-resize-handle--left`)
  const dueCell = chart.locator(`.gantt-sidebar-row[data-task-id="${id}"] .idp-container`).first()
  await expect(dueCell).toBeVisible()
  const originalDueLabel = await dueCell.innerText()
  const pxPerDay = Number(await chart.getAttribute("data-px-per-day"))
  const [response] = await Promise.all([
    page.waitForResponse(response => new URL(response.url()).pathname === path && response.request().method() === "PUT"),
    drag(page, handle, pxPerDay),
  ])
  expect(response.status()).toBe(200)
  expect(response.request().postDataJSON()).toEqual({ start_date: addDays(start, 1), updated_at: expect.any(Number) })
  await expect(page.getByRole("status").filter({ hasText: "Start date updated" })).toBeVisible()
  await expect(dueCell).toHaveText(originalDueLabel)
  expect(await (await request.get(path)).json()).toMatchObject({ start_date: addDays(start, 1), end_date: end, due_date: due })
  await page.reload()
  await expect(dueCell).toHaveText(originalDueLabel)
})

for (const [edge, direction] of [["left", -1], ["right", 1]] as const) {
  test(`Shift+Wheel and one canvas drag continue past the ${edge} date boundary`, async ({ page, datedTask }) => {
    await page.goto("/boards/household?view=timeline#timeline")
    const chart = page.locator("#gantt-chart")
    const wrapper = chart.locator(".gantt-scroll-wrapper")
    await expect(chart.locator(`[data-task-id="${datedTask.id}"]`).first()).toBeVisible()
    const geometry = () => wrapper.evaluate((node, millisPerDay) => {
      const chart = node.closest<HTMLElement>("#gantt-chart")!
      const pxPerDay = Number(chart.dataset.pxPerDay)
      return { width: node.scrollWidth, pxPerDay, visibleDay: Number(chart.dataset.rangeStartMs) / millisPerDay + node.scrollLeft / pxPerDay }
    }, dayMs)
    const moveToBoundary = () => wrapper.evaluate((node, way) => { node.scrollLeft = way < 0 ? 0 : node.scrollWidth }, direction)
    await moveToBoundary()
    const wheelStart = await geometry()
    const box = (await wrapper.boundingBox())!
    const x = box.x + box.width / 2
    const y = box.y + 20
    await page.mouse.move(x, y)
    await page.keyboard.down("Shift")
    try { await page.mouse.wheel(0, direction * 240) }
    finally { await page.keyboard.up("Shift") }
    await expect.poll(async () => (await geometry()).width).toBeGreaterThan(wheelStart.width)
    expect(Math.abs(((await geometry()).visibleDay - wheelStart.visibleDay) * wheelStart.pxPerDay - direction * 240)).toBeLessThan(2)

    await moveToBoundary()
    const dragStart = await geometry()
    await page.mouse.down()
    try {
      await expect(wrapper).toHaveClass(/is-panning/)
      await page.mouse.move(x - direction * 80, y, { steps: 4 })
      await expect.poll(async () => (await geometry()).width).toBeGreaterThan(dragStart.width)
      await expect(wrapper).toHaveClass(/is-panning/)
      await page.mouse.move(x - direction * 180, y, { steps: 4 })
      expect(Math.abs(((await geometry()).visibleDay - dragStart.visibleDay) * dragStart.pxPerDay - direction * 180)).toBeLessThan(2)
    } finally { await page.mouse.up() }
    await expect(wrapper).not.toHaveClass(/is-panning/)
  })
}
