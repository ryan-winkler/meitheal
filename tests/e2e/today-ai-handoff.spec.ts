import { expect, test, type Page } from "@playwright/test"
import { deferred, shouldSkipBrowserSpecs } from "./_helpers"

test.skip(shouldSkipBrowserSpecs(), "Requires a disposable App server")
test.use({ serviceWorkers: "block" })

let taskId: string
const snapshot = (url: URL) => url.pathname.endsWith("/api/settings") &&
  url.searchParams.get("key") === "ai-provider" && url.searchParams.get("handoff") === "1"
const settings = (value: string | null, canUseAssist: boolean, url?: string) => ({ key: "ai-provider", value, canUseAssist, url })
const row = (page: Page) => page.locator(`#section-today .tli[data-id="${taskId}"]`)
const askToday = (page: Page) => row(page).getByRole("button", { name: "Ask AI" })

test.beforeEach(async ({ request }) => {
  const response = await request.post("/api/tasks", { data: {
    title: "Today provider privacy fixture", description: "Keep this task with the selected provider",
    due_date: new Date().toISOString().slice(0, 10),
  } })
  expect(response.status()).toBe(201)
  taskId = (await response.json()).id
})

test.afterEach(async ({ request }) => {
  expect((await request.delete(`/api/tasks/${taskId}`, { data: {} })).status()).toBe(204)
})

test("saved HA-only choice overrides stale browser preferences and observes Assist authority", async ({ page, context }) => {
  let canUseAssist = true
  let reads = 0
  await page.route(snapshot, route => {
    reads++
    return route.fulfill({ json: settings("ha_llm", canUseAssist) })
  })
  await page.addInitScript(() => {
    localStorage.setItem("meitheal-ai-provider", "chatgpt")
    localStorage.setItem("meitheal-ai-custom-url", "https://legacy.example/")
  })
  await page.goto("/today")
  await expect.poll(() => page.evaluate(() => [
    localStorage.getItem("meitheal-ai-provider"), localStorage.getItem("meitheal-ai-custom-url"),
  ])).toEqual([null, null])
  await page.evaluate(() => {
    localStorage.setItem("meitheal-ai-provider", "chatgpt")
    window.openAskHaModal = prompt => { document.documentElement.dataset.haAssistPrompt = prompt }
  })
  await row(page).hover()
  await askToday(page).click()
  await expect(page.locator("html")).toHaveAttribute("data-ha-assist-prompt", /Today provider privacy fixture/)

  canUseAssist = false
  await page.evaluate(() => { delete document.documentElement.dataset.haAssistPrompt })
  await askToday(page).click()
  await expect(page.getByText("This household uses Home Assistant Assist only. Ask an administrator to run Assist.")).toBeVisible()
  expect(await page.locator("html").getAttribute("data-ha-assist-prompt")).toBeNull()
  await expect(page.getByRole("link", { name: "Open provider" })).toHaveCount(0)
  expect(context.pages()).toHaveLength(1)
  expect(reads).toBe(2)
})

test("unavailable or malformed snapshots stop Today handoff instead of choosing an external default", async ({ page }) => {
  let status = 503
  await page.route(snapshot, route => route.fulfill({ status, json: { key: "ai-provider", canUseAssist: true } }))
  await page.goto("/today")
  await row(page).hover()
  await askToday(page).click()
  const error = page.getByText("Could not read a valid AI provider. Check Settings → Automation & AI and retry.", { exact: true })
  await expect(error).toHaveCount(1)
  status = 200
  await askToday(page).click()
  await expect(error).toHaveCount(2)
  await expect(page.getByRole("link", { name: "Open provider" })).toHaveCount(0)
})

test("Today validates and preserves custom destinations and distinguishes a URL review denial", async ({ page }) => {
  let configured = "javascript:void(0)"
  let approved = true
  await page.route(snapshot, route => approved
    ? route.fulfill({ json: settings("custom", false, configured) })
    : route.fulfill({ status: 403, json: { title: "URL review required" } }))
  await page.goto("/today")
  await row(page).hover()
  await askToday(page).click()
  await expect(page.getByText("The saved AI URL is invalid. Open Settings → Automation & AI to correct it.", { exact: true })).toBeVisible()
  approved = false
  await askToday(page).click()
  await expect(page.getByText("Ask an administrator to review and share the custom AI URL in Settings → Automation & AI.", { exact: true })).toBeVisible()
  await expect(page.getByRole("link", { name: "Open provider" })).toHaveCount(0)

  approved = true
  configured = "https://assistant.example/chat?q=keep-this-custom-query"
  await askToday(page).click()
  const handoff = page.getByRole("link", { name: "Open provider", exact: true })
  await expect(handoff).toHaveAttribute("href", configured)
  await expect(handoff).toHaveAttribute("target", "_blank")
  await expect(handoff).toHaveAttribute("rel", "noopener noreferrer")
  await expect(page.getByText("Open the saved provider at assistant.example?")).toBeVisible()
})

test("a delayed default snapshot offers a keyboard handoff with task disclosure and no opener or referrer", async ({ page, context }) => {
  await page.route(snapshot, async route => {
    // Outlast Chromium's transient activation before offering a fresh native link.
    await new Promise(resolve => setTimeout(resolve, 6000))
    await route.fulfill({ json: settings(null, true) })
  })
  await context.route("https://chatgpt.com/**", route => route.fulfill({ contentType: "text/html", body: "<title>Provider fixture</title>" }))
  await page.goto("/today")
  const ask = askToday(page)
  await ask.focus()
  expect(await row(page).evaluate(element => element.matches(":hover"))).toBe(false)
  await expect(ask.locator("..")).toHaveCSS("opacity", "1")
  await page.keyboard.press("Enter")
  await expect(page.getByText("Open chatgpt.com and send the task title, description, status and priority?")).toBeVisible({ timeout: 15000 })
  const cancel = page.getByRole("button", { name: "Cancel", exact: true })
  await expect(cancel).toBeFocused()
  await page.keyboard.press("Tab")
  const handoff = page.getByRole("link", { name: "Open provider", exact: true })
  await expect(handoff).toBeFocused()
  const opened = context.waitForEvent("page")
  await page.keyboard.press("Enter")
  const provider = await opened
  await provider.waitForLoadState()
  expect(new URL(provider.url()).searchParams.get("q")).toContain("Today provider privacy fixture")
  expect(await provider.evaluate(() => ({ opener: window.opener, referrer: document.referrer }))).toEqual({ opener: null, referrer: "" })
  await provider.close()
})

test("a delayed handoff takes priority over open shortcut help and returns focus in order", async ({ page, context }) => {
  const requested = deferred<void>()
  const release = deferred<void>()
  await context.route("https://chatgpt.com/**", route => route.abort())
  await page.route(snapshot, async route => {
    requested.resolve()
    await release.promise
    await route.fulfill({ json: settings(null, true) })
  })

  try {
    await page.goto("/today")
    const ask = askToday(page)
    await ask.press("Enter")
    await requested.promise
    const help = page.getByRole("dialog", { name: "Keyboard shortcuts" })
    const close = help.getByRole("button", { name: "Close shortcuts" })
    await ask.press("Shift+Slash")
    await expect(close).toBeFocused()

    const confirmation = page.getByRole("alertdialog", { name: "Open provider" })
    const cancel = confirmation.getByRole("button", { name: "Cancel" })
    const text = help.getByRole("heading", { name: "On the Tasks page" })
    const bounds = await text.boundingBox()
    expect(bounds).not.toBeNull()
    await page.mouse.move(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2)
    await page.mouse.down()
    try {
      await expect(close).toBeFocused()
      release.resolve()
      await expect(cancel).toBeFocused()
      await expect(help).toBeHidden()
      const message = await confirmation.locator("#confirm-message").boundingBox()
      expect(message).not.toBeNull()
      await page.mouse.move(message!.x + message!.width / 2, message!.y + message!.height / 2)
    } finally {
      await page.mouse.up()
    }
    await expect(cancel).toBeFocused()
    await page.keyboard.press("Tab")
    await expect(confirmation.getByRole("link", { name: "Open provider" })).toBeFocused()
    await page.keyboard.press("Escape")
    await expect(confirmation).toBeHidden()
    await expect(close).toBeFocused()

    await page.keyboard.press("Escape")
    await expect(help).toBeHidden()
    await expect(ask).toBeFocused()
    expect(context.pages()).toEqual([page])
  } finally {
    release.resolve()
  }
})

test("a newer Today handoff aborts the older request and releases both buttons", async ({ page, request }) => {
  const response = await request.post("/api/tasks", { data: {
    title: "Second AI handoff fixture", due_date: new Date().toISOString().slice(0, 10),
  } })
  expect(response.status()).toBe(201)
  const secondId = (await response.json()).id
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  let received!: () => void
  const requested = new Promise<void>(resolve => { received = resolve })
  let count = 0
  await page.route(snapshot, async route => {
    if (++count === 1) {
      received()
      await held
      await route.fulfill({ json: settings("custom", false, "https://first.example/") }).catch(() => {})
    } else {
      await route.fulfill({ json: settings("custom", false, "https://second.example/") })
    }
  })
  try {
    await page.goto("/today")
    await row(page).hover()
    await askToday(page).click()
    await requested
    const secondRow = page.locator(`#section-today .tli[data-id="${secondId}"]`)
    await secondRow.hover()
    const second = secondRow.getByRole("button", { name: "Ask AI" })
    await second.click()
    release()
    const handoff = page.getByRole("link", { name: "Open provider", exact: true })
    await expect(handoff).toHaveAttribute("href", "https://second.example/")
    await expect(askToday(page)).not.toHaveAttribute("aria-busy", "true")
    await page.keyboard.press("Escape")
    await expect(handoff).toHaveCount(0)
    await expect(second).not.toHaveAttribute("aria-busy", "true")
  } finally {
    release()
    expect((await request.delete(`/api/tasks/${secondId}`, { data: {} })).status()).toBe(204)
  }
})

test("task detail separates opening a provider from copying and keeps clipboard denial visible", async ({ page, context }) => {
  await page.route(snapshot, route => route.fulfill({ json: settings("custom", false, "https://assistant.example/chat") }))
  await context.route("https://assistant.example/**", route => route.fulfill({ contentType: "text/html", body: "<title>Provider fixture</title>" }))
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", { value: { writeText: async (text: string) => {
      document.documentElement.dataset.clipboardAttempt = text
      throw new DOMException("Clipboard blocked in fixture", "NotAllowedError")
    } } })
  })
  await page.goto("/today")
  await row(page).click()
  const ask = page.locator("#td-ask-ai")
  await expect(page.locator("#task-detail-overlay")).toHaveAttribute("data-open-task-id", taskId)
  await expect(page.locator("#td-loaded-content")).toBeVisible()
  await expect(ask).toBeVisible()
  await ask.press("Enter")
  const dialog = page.getByRole("alertdialog", { name: "Use an external provider" })
  const handoff = dialog.getByRole("link", { name: "Open provider" })
  await expect(handoff).toBeVisible()
  expect(await page.locator("html").getAttribute("data-clipboard-attempt")).toBeNull()
  await page.keyboard.press("Escape")
  await expect(handoff).toHaveCount(0)
  expect(await page.locator("html").getAttribute("data-clipboard-attempt")).toBeNull()
  await expect(ask).toBeEnabled()
  await expect(ask).toBeFocused()
  await ask.click()
  const opened = context.waitForEvent("page")
  await handoff.click()
  await (await opened).close()
  expect(await page.locator("html").getAttribute("data-clipboard-attempt")).toBeNull()

  await ask.click()
  await dialog.getByRole("button", { name: "Copy prompt", exact: true }).click()
  await expect(page.locator("html")).toHaveAttribute("data-clipboard-attempt", /Today provider privacy fixture/)
  await expect(dialog.getByRole("status")).toHaveText("Could not copy the prompt. Clipboard access was denied or unavailable.")
  await expect(handoff).toBeVisible()
})

test("task detail uses Assist for administrators even if the saved external fallback URL is invalid", async ({ page }) => {
  await page.route(snapshot, route => route.fulfill({ json: { ...settings("custom", true), urlProblem: "invalid" } }))
  await page.route("**/api/ha/assist", route => route.fulfill({ json: { speech: "Synthetic Assist reply" } }))
  await page.goto("/today")
  await row(page).click()
  await page.locator("#td-ask-ai").click()
  await expect(page.locator("#td-ai-response")).toContainText("Synthetic Assist reply")
  await expect(page.getByRole("alertdialog", { name: "Use an external provider" })).toHaveCount(0)
})

test("task detail checks member sharing again after loading prompt context", async ({ page }) => {
  let approved = true
  await page.route(snapshot, route => approved
    ? route.fulfill({ json: settings("custom", false, "https://assistant.example/chat") })
    : route.fulfill({ status: 403, json: { title: "URL review required" } }))
  await page.goto("/today")
  await row(page).click()
  const ask = page.locator("#td-ask-ai")
  await expect(ask).toBeVisible()
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  let received!: () => void
  const requested = new Promise<void>(resolve => { received = resolve })
  await page.route(url => url.pathname === "/api/pillars", async route => {
    received()
    await held
    await route.fulfill({ json: { pillars: [] } })
  })
  try {
    await ask.click()
    await requested
    approved = false
    release()
    await expect(page.getByText("Ask an administrator to review and share the custom AI URL in Settings → Automation & AI.", { exact: true })).toBeVisible()
    await expect(page.getByRole("alertdialog", { name: "Use an external provider" })).toHaveCount(0)
  } finally {
    release()
  }
})

test("closing task detail aborts a pending handoff before it can copy or show a response", async ({ page }) => {
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  let received!: () => void
  const requested = new Promise<void>(resolve => { received = resolve })
  await page.route(snapshot, async route => {
    received()
    await held
    await route.fulfill({ json: settings("custom", false, "https://assistant.example/chat") }).catch(() => {})
  })
  await page.goto("/today")
  await row(page).click()
  const ask = page.locator("#td-ask-ai")
  await ask.click()
  await requested
  await expect(ask).toBeDisabled()
  await page.locator("#td-close").click()
  release()
  await expect(page.locator("#task-detail-overlay")).not.toHaveClass(/active/)
  await expect(page.getByRole("alertdialog", { name: "Use an external provider" })).toHaveCount(0)
  await expect(page.locator("#td-ai-response")).toHaveCount(0)
})
