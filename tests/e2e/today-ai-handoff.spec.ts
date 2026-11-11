import { expect, test } from "@playwright/test"
import { shouldSkipBrowserSpecs } from "./_helpers"

test.skip(shouldSkipBrowserSpecs(), "Requires a disposable App server")
test.use({ serviceWorkers: "block" })

let taskId: string

test.beforeEach(async ({ request, page }) => {
  const response = await request.post("/api/tasks", { data: { title: "Today provider privacy fixture", description: "Keep this task with the selected provider", due_date: new Date().toISOString().slice(0, 10) } })
  expect(response.status()).toBe(201)
  taskId = (await response.json()).id
  await page.addInitScript(() => {
    window.open = (url, target, features) => {
      document.documentElement.dataset.aiHandoff = JSON.stringify([String(url), target, features])
      return null
    }
  })
})

test.afterEach(async ({ request }) => {
  expect((await request.delete(`/api/tasks/${taskId}`, { data: {} })).status()).toBe(204)
})

test("saved HA-only choice overrides absent and stale browser preferences without external disclosure", async ({ page }) => {
  let reads = 0
  await page.route("**/api/settings?key=ai-provider", route => {
    reads++
    return route.fulfill({ json: { value: "ha_llm" } })
  })
  await page.goto("/today")
  const row = page.locator(`#section-today .tli[data-id="${taskId}"]`)
  for (const local of [null, "chatgpt"]) {
    await page.evaluate(value => {
      if (value === null) localStorage.removeItem("meitheal-ai-provider")
      else localStorage.setItem("meitheal-ai-provider", value)
      delete document.documentElement.dataset.haAssistPrompt
      window.openAskHaModal = prompt => { document.documentElement.dataset.haAssistPrompt = prompt }
    }, local)
    await row.hover()
    await row.getByRole("button", { name: "Ask AI" }).click()
    await expect(page.locator("html")).toHaveAttribute("data-ha-assist-prompt", /Today provider privacy fixture/)
    expect(await page.locator("html").getAttribute("data-ai-handoff")).toBeNull()
  }
  expect(reads).toBe(2)
})

test("failed provider reads stop Today handoff instead of selecting an external default", async ({ page }) => {
  await page.route("**/api/settings?key=ai-provider", route => route.fulfill({ status: 503, json: { value: "chatgpt" } }))
  await page.goto("/today")
  const row = page.locator(`#section-today .tli[data-id="${taskId}"]`)
  await row.hover()
  await row.getByRole("button", { name: "Ask AI" }).click()
  await expect(page.getByText("Could not read a valid AI provider. Check Settings → Automation & AI and retry.", { exact: true })).toBeVisible()
  expect(await page.locator("html").getAttribute("data-ai-handoff")).toBeNull()
})

test("Today validates the saved custom URL and preserves valid custom destinations", async ({ page }) => {
  let configured = "javascript:void(0)"
  await page.route("**/api/settings?key=ai-provider", route => route.fulfill({ json: { value: "custom" } }))
  await page.route("**/api/settings?key=ai-custom-url", route => route.fulfill({ json: { value: configured } }))
  await page.goto("/today")
  const row = page.locator(`#section-today .tli[data-id="${taskId}"]`)
  await row.hover()
  const ask = row.getByRole("button", { name: "Ask AI" })
  await ask.click()
  await expect(page.getByText("The saved AI URL is invalid. Open Settings → Automation & AI to correct it.", { exact: true })).toBeVisible()
  expect(await page.locator("html").getAttribute("data-ai-handoff")).toBeNull()
  configured = "https://assistant.example/chat"
  await ask.click()
  const handoff = page.getByRole("link", { name: "Open provider", exact: true })
  await expect(handoff).toHaveAttribute("href", configured)
  await expect(handoff).toHaveAttribute("target", "_blank")
  await expect(handoff).toHaveAttribute("rel", "noopener noreferrer")
})


test("a delayed provider read offers a fresh native handoff with no opener or referrer", async ({ page, context }) => {
  await page.route("**/api/settings?key=ai-provider", async route => {
    await new Promise(resolve => setTimeout(resolve, 6000))
    await route.fulfill({ json: { value: "custom" } })
  })
  await page.route("**/api/settings?key=ai-custom-url", route => route.fulfill({ json: { value: "https://assistant.example/chat" } }))
  await context.route("https://assistant.example/**", route => route.fulfill({ contentType: "text/html", body: "<title>Local provider fixture</title>" }))
  await page.goto("/today")
  const row = page.locator(`#section-today .tli[data-id="${taskId}"]`)
  await row.hover()
  await row.getByRole("button", { name: "Ask AI" }).click()
  const handoff = page.getByRole("link", { name: "Open provider", exact: true })
  await expect(handoff).toBeVisible({ timeout: 10000 })
  const opened = context.waitForEvent("page")
  await handoff.click()
  const provider = await opened
  await provider.waitForLoadState()
  expect(provider.url()).toBe("https://assistant.example/chat")
  expect(await provider.evaluate(() => ({ opener: window.opener, referrer: document.referrer }))).toEqual({ opener: null, referrer: "" })
  await provider.close()
})
