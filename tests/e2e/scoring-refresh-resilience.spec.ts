import { randomUUID } from "node:crypto"
import { expect, test, type APIRequestContext, type Page } from "@playwright/test"
import { currentBoardWriteHeaders } from "../helpers/current-board-http"
import { shouldSkipBrowserSpecs } from "./_helpers"

test.skip(shouldSkipBrowserSpecs(), "Requires a disposable built app")
test.use({ serviceWorkers: "block" })
const origin = process.env.E2E_BASE_URL ?? "http://127.0.0.1:4611"

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(complete => { resolve = complete })
  return { promise, resolve }
}

async function createTask(request: APIRequestContext, headers: Record<string, string>, urgency = 0, importance = 0) {
  const response = await request.post("/api/tasks", {
    headers, data: { title: `Score refresh fixture ${randomUUID()}`, status: "pending", urgency, importance },
  })
  expect(response.status()).toBe(201)
  const { id, title } = await response.json() as { id: string; title: string }
  return { id, title, path: `/api/tasks/${id}` }
}

async function scoreFromMatrix(page: Page, title: string) {
  await page.getByRole("button", { name: "Scoring Triage", exact: true }).click()
  await expect(page.locator("#st-task-title")).toHaveText(title)
  await page.locator("#st-num-urgency").fill("4")
  await page.locator("#st-num-importance").fill("5")
  await page.locator("#st-save-btn").click()
}

test("a delayed Eisenhower import cannot open triage on Planning", async ({ page }) => {
  await page.goto("/eisenhower")
  const chunk = deferred<string>()
  const release = deferred<void>()
  await page.route(/\/_astro\/scoring-triage-controller[^/]*\.js$/, async route => {
    chunk.resolve(route.request().url())
    await release.promise
    await route.continue().catch(() => {})
  })
  try {
    await page.getByRole("button", { name: "Scoring Triage", exact: true }).click()
    const moduleUrl = await chunk.promise
    await page.getByRole("link", { name: "Planning", exact: true }).first().click()
    await expect(page.locator("#planning-section-eisenhower")).toBeVisible()
    release.resolve()
    await page.evaluate(async url => { await import(url) }, moduleUrl)
    await expect(page.locator("#scoring-triage-modal")).toBeHidden()
    await page.getByRole("button", { name: "Triage Matrix", exact: true }).click()
    await expect(page.locator("#scoring-triage-modal")).toBeVisible()
  } finally { release.resolve() }
})

test("Weekly Review waits for the current matrix across temporary Board concealment", async ({ page, request }) => {
  const headers = await currentBoardWriteHeaders(request, "household", { origin })
  const scored = await createTask(request, headers)
  const scheduled = await createTask(request, headers, 1, 5)
  const heldRead = deferred<void>()
  const readStarted = deferred<number>()
  const heldAuthority = deferred<void>()
  const reachedAuthority = deferred<number>()
  let verify = false
  let reads = 0
  try {
    await page.goto("/eisenhower?board_id=household&area=#eisenhower-matrix")
    await page.route(url => url.pathname === "/eisenhower", async route => {
      if (route.request().headers()["x-meitheal-refresh"] !== "1" || ++reads > 1) return route.continue()
      const response = await route.fetch()
      readStarted.resolve(response.status())
      await heldRead.promise
      await route.fulfill({ response }).catch(() => {})
    })
    await page.route(url => url.pathname === "/api/boards/household" && url.searchParams.get("view") === "authority", async route => {
      if (!verify || route.request().method() !== "HEAD") return route.continue()
      const response = await route.fetch()
      reachedAuthority.resolve(response.status())
      await heldAuthority.promise
      await route.fulfill({ response }).catch(() => {})
    })
    await scoreFromMatrix(page, scored.title)
    expect(await readStarted.promise).toBe(200)
    await expect(page.locator("#scoring-triage-modal")).toBeHidden()
    await page.locator('#eisenhower-bar [data-action="start-review"]').click()
    await expect(page.locator("#review-overlay")).toBeHidden()
    verify = true
    await page.evaluate(() => {
      window.dispatchEvent(new Event("offline"))
      window.dispatchEvent(new Event("online"))
    })
    expect(await reachedAuthority.promise).toBe(200)
    await expect(page.locator("#eisenhower-shell")).toHaveCount(0)
    heldRead.resolve()
    expect(reads).toBe(1)
    heldAuthority.resolve()
    await expect(page.locator(`[data-drop-zone="do-first"] .tli[data-id="${scored.id}"]`)).toBeAttached()
    await expect(page.locator("#review-overlay")).toBeVisible()
    await expect(page.locator("#review-overlay")).toContainText(scheduled.title)
    await expect(page.locator("#review-overlay")).not.toContainText(scored.title)
    expect(reads).toBe(2)
  } finally {
    heldRead.resolve()
    heldAuthority.resolve()
    for (const task of [scored, scheduled]) await request.delete(task.path, { headers, data: {} })
  }
})

test("a bounded save response body releases a deferred close and reconciles the score", async ({ page, request }) => {
  const headers = await currentBoardWriteHeaders(request, "household", { origin })
  const task = await createTask(request, headers)
  try {
    await page.goto("/eisenhower")
    await page.evaluate(path => {
      const fetchFromServer = window.fetch
      window.fetch = async (input, options) => {
        const response = await fetchFromServer(input, options)
        const url = new URL(input instanceof Request ? input.url : input, location.href)
        if (url.pathname !== path || options?.method !== "PUT" || response.status !== 200) return response
        const signal = options.signal
        if (!signal) throw new Error("Expected a save lifetime")
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("{"))
            signal.addEventListener("abort", () => controller.error(signal.reason), { once: true })
          },
        })
        document.body.dataset.scoringBodyPending = "true"
        return new Response(body, { status: 200, headers: { "content-type": "application/json" } })
      }
    }, task.path)
    await scoreFromMatrix(page, task.title)
    await expect(page.locator("body")).toHaveAttribute("data-scoring-body-pending", "true")
    await page.keyboard.press("Escape")
    await expect(page.locator("#scoring-triage-modal")).toBeVisible()
    await expect(page.locator("#scoring-triage-modal")).toBeHidden({ timeout: 10_000 })
    await expect(page.getByText("Save unconfirmed. Check the task’s score before trying again.", { exact: true })).toBeVisible()
    await expect(page.locator(`[data-drop-zone="do-first"] .tli[data-id="${task.id}"]`)).toBeAttached()
    await expect(page).toHaveURL(origin + "/eisenhower")
  } finally { await request.delete(task.path, { headers, data: {} }) }
})
