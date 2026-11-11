import { request as httpRequest } from "node:http"
import { expect, test } from "@playwright/test"

test.skip(!process.env.E2E_BASE_URL, "Requires a disposable App server")
test.use({ serviceWorkers: "block" })

test("To-do selection hydrates JSON arrays and legacy single entity IDs", async ({ page }) => {
  let saved: unknown = '["todo.shopping","todo.household"]'
  let syncEnabled: unknown
  await page.route("**/api/settings", async route => {
    if (route.request().method() !== "GET") return route.continue()
    const response = await route.fetch()
    return route.fulfill({ response, json: { ...await response.json(), todo_entities: saved, todo_sync_enabled: syncEnabled } })
  })
  await page.route("**/api/todo", route => route.fulfill({ json: { ok: true, entities: [
    { entity_id: "todo.shopping", friendly_name: "Shopping", state: "2", sync: null },
    { entity_id: "todo.household", friendly_name: "Household", state: "1", sync: null },
  ] } }))
  await page.goto("/settings#integrations-settings")
  await expect(page.locator('.todo-entity-toggle:checked')).toHaveCount(2)
  saved = "todo.household"
  await page.reload()
  await expect(page.locator('.todo-entity-toggle:checked')).toHaveCount(1)
  await expect(page.locator('.todo-entity-toggle[value="todo.household"]')).toBeChecked()
  for (const value of ["null", null, "[]"]) {
    saved = value
    await page.reload()
    await expect(page.locator('.todo-entity-toggle:checked')).toHaveCount(value === "[]" ? 0 : 1)
    if (value !== "[]") await expect(page.locator('.todo-entity-toggle[value="todo.shopping"]')).toBeChecked()
  }
  for (const value of [false, "false"]) {
    saved = "null"
    syncEnabled = value
    await page.reload()
    await expect(page.locator("#todo-enabled")).not.toBeChecked()
    await expect(page.locator('.todo-entity-toggle[value="todo.shopping"]')).toBeChecked()
  }
})

test("Task AI handoff explains an invalid saved URL without opening a provider", async ({ page, request, context, baseURL }) => {
  const created = await request.post("/api/tasks", { data: { title: "Invalid AI URL fixture" } })
  expect(created.status()).toBe(201)
  const { id } = await created.json()
  let opens = 0
  page.on("popup", () => opens++)
  await page.route("**/api/ha/assist", route => route.fulfill({ status: 503, json: { error: "Unavailable" } }))
  let provider: unknown = "custom"
  let providerFailure = false
  await page.addInitScript(() => {
    const state = window as unknown as { handoffUrls: string[] }
    state.handoffUrls = []
    window.open = url => { state.handoffUrls.push(String(url)); return null }
  })
  const handoffs = () => page.evaluate(() => (window as unknown as { handoffUrls: string[] }).handoffUrls)
  await page.route("**/api/settings?key=ai-provider", route => route.fulfill(providerFailure ? { status: 503, json: { error: "Fixture unavailable" } } : { json: { value: provider } }))
  let configured: unknown = "javascript:alert(1)"
  await page.route("**/api/settings?key=ai-custom-url", route => route.fulfill({ json: { value: configured } }))
  try {
    await page.goto(`/tickets/${id}`)
    await expect(page.locator("#td-title")).toHaveValue("Invalid AI URL fixture")
    for (const value of ["javascript:alert(1)", "", null, undefined]) {
      configured = value
      await page.locator("#td-ask-ai").click()
      await expect(page.getByText("The saved AI URL is invalid. Open Settings → Automation & AI to correct it.", { exact: true })).toBeVisible()
      expect(opens).toBe(0)
      expect(await handoffs()).toEqual([])
      await page.locator(".toast-dismiss").last().click()
      await expect(page.locator(".toast")).toHaveCount(0)
    }
    configured = ""
    await context.addCookies([{ name: "meitheal-locale", value: "ga", url: baseURL! }])
    await page.goto(`/tickets/${id}`)
    await page.locator("#td-ask-ai").click()
    await expect(page.getByText("Tá an URL IS sábháilte neamhbhailí. Oscail Socruithe → Automation & AI chun é a cheartú.", { exact: true })).toBeVisible()
    expect(opens).toBe(0)
    expect(await handoffs()).toEqual([])
    await page.locator(".toast-dismiss").last().click()
    await expect(page.locator(".toast")).toHaveCount(0)
    providerFailure = true
    await page.locator("#td-ask-ai").click()
    await expect(page.getByText("Níorbh fhéidir soláthraí bailí IS a léamh. Seiceáil Socruithe → Automation & AI agus bain triail eile as.", { exact: true })).toBeVisible()
    expect(await handoffs()).toEqual([])
    await page.locator(".toast-dismiss").last().click()
    await expect(page.locator(".toast")).toHaveCount(0)
    providerFailure = false
    provider = "ha_llm"
    await page.locator("#td-ask-ai").click()
    await expect(page.getByText("Níl Assist Home Assistant ar fáil. Athcheangail é agus bain triail eile as.", { exact: true })).toBeVisible()
    expect(await handoffs()).toEqual([])
    await page.locator(".toast-dismiss").last().click()
    await expect(page.locator(".toast")).toHaveCount(0)
    provider = null
    await page.locator("#td-ask-ai").click()
    await expect(page.getByRole("link", { name: "Oscail an soláthraí" })).toHaveAttribute("href", "https://chatgpt.com/")
    await page.locator("#confirm-cancel").click()
    await expect(page.locator("#meitheal-confirm-overlay")).toHaveCount(0)
    provider = "custom"
    configured = "http://127.0.0.1:4999/"
    await page.locator("#td-ask-ai").click()
    await expect(page.getByRole("link", { name: "Oscail an soláthraí" })).toHaveAttribute("href", "http://127.0.0.1:4999/")
    await expect(page.getByRole("link", { name: "Oscail an soláthraí" })).toHaveAttribute("rel", "noopener noreferrer")
    expect(await handoffs()).toEqual([])
  } finally {
    expect((await request.delete(`/api/tasks/${id}`, { data: {} })).status()).toBe(204)
  }
})


test("Saturday week starts apply immediately after a regional Settings save", async ({ page, request }) => {
  const previous = (await (await request.get("/api/settings?key=week_start")).json()).value ?? "monday"
  try {
    expect((await request.put("/api/settings", { data: { key: "week_start", value: "saturday" } })).status()).toBe(200)
    await page.goto("/tasks?view=calendar#calendar")
    await expect(page.locator("#tasks-view-calendar .cal-header").first()).toHaveText("Sat")
  } finally {
    expect((await request.put("/api/settings", { data: { key: "week_start", value: previous } })).status()).toBe(200)
  }
})


test("standalone handoff settings reject untrusted peers and forged household identity", async ({ request, baseURL }) => {
  for (const key of ["ai-provider", "ai-custom-url"]) {
    expect((await request.get(`/api/settings?key=${key}`)).status()).toBe(200)
    for (const identity of [{}, { "x-ingress-path": "/forged", "x-remote-user-id": "fake-household", "x-remote-user-groups": "system-admin" }]) {
      const status = await new Promise<number>((resolve, reject) => {
        // A second loopback address exercises an actual peer outside the local-admin allowlist.
        const probe = httpRequest(new URL(`/api/settings?key=${key}`, baseURL!), {
          localAddress: "127.0.0.2", headers: { host: "untrusted.example", ...identity },
        }, response => {
          response.resume()
          response.on("end", () => resolve(response.statusCode ?? 0))
        })
        probe.on("error", reject)
        probe.setTimeout(3000, () => probe.destroy(new Error("Standalone probe timed out")))
        probe.end()
      })
      expect(status).toBe(403)
    }
  }
})
