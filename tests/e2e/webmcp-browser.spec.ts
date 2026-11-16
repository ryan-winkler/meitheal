import { expect } from "@playwright/test"
import { test } from "../scripts/settings-persistence-fixture"
import { expectTools, installWebMcpDouble, saveProtocols, saveWebMcp, searchTool, toolNames, webMcpKey } from "../scripts/webmcp-browser-helpers"

test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires the built App and disposable authenticated fixture")

test("WebMCP is off by default and searches real task titles with eight bounded ingress-safe results", async ({ page, request }) => {
  await installWebMcpDouble(page)
  await page.goto("/settings#automation-ai-settings")
  await expect(page.locator("#webmcp-runtime-status")).toHaveText("Browser tools are disabled.")
  await expectTools(page, [])
  expect(await page.evaluate(() => (window as any).__webmcpRegistrations)).toBe(0)
  expect((await (await request.get(`/api/settings?key=${webMcpKey}`)).json()).value).toBeNull()
  const title = `WebMcpSearch${crypto.randomUUID().replaceAll("-", "")}`
  const ids: string[] = []
  for (let i = 0; i < 9; i++) {
    const response = await request.post("/api/tasks", { data: { title: `${title} ${i}` } })
    expect(response.status()).toBe(201)
    ids.push((await response.json()).id)
  }
  expect((await request.post("/api/tasks", { data: { title: "Description-only match", description: title } })).status()).toBe(201)
  const searches: { url: string; source: string | undefined }[] = []
  page.on("request", r => {
    if (new URL(r.url()).pathname.endsWith("/api/search")) {
      searches.push({ url: r.url(), source: r.headers()["x-automation-source"] })
    }
  })
  await saveProtocols(page, true)
  await expectTools(page)
  await expect(page.locator("#webmcp-runtime-status")).toHaveText("Browser tools are registered.")
  const result = await searchTool(page, title)
  expect(result.tasks).toHaveLength(8)
  const prefix = await page.evaluate(() => window.__ingress_path || "")
  for (const item of result.tasks) {
    expect(item.title).toMatch(new RegExp(`^${title} [0-8]$`))
    expect(ids).toContain(new URL(item.url, page.url()).searchParams.get("open"))
    expect(item.url).toMatch(new RegExp(`^${prefix}/tasks\\?open=`))
    expect(Object.keys(item).sort()).toEqual(["title", "url"])
  }
  const url = new URL(searches[0]!.url)
  expect(searches[0]!.source).toBe("webmcp")
  expect(url.pathname).toBe(`${prefix}/api/search`)
  expect(Object.fromEntries(url.searchParams)).toEqual({ q: title, scope: "tasks", task_fields: "title", limit: "8" })
  expect(searches).toHaveLength(1)
  expect(await searchTool(page, " ")).toHaveProperty("error")
  expect(await searchTool(page, "x".repeat(161))).toHaveProperty("error")
  expect(await searchTool(page, 123)).toHaveProperty("error")
  expect(searches).toHaveLength(1)
  expect(await page.evaluate(() => Object.values((window as any).__webmcpTools).map((t: any) => t.annotations)))
    .toEqual([{ readOnlyHint: true, untrustedContentHint: true }, { readOnlyHint: true }])
})

test("WebMCP rechecks persistence without notifications and revokes old search/navigation handles", async ({ page, request }) => {
  await saveWebMcp(request, true)
  await installWebMcpDouble(page)
  await page.goto("/settings#automation-ai-settings")
  await expectTools(page)
  await page.evaluate(() => (window as any).__heldWebMcp = { ...(window as any).__webmcpTools })
  let searches = 0
  page.on("request", r => { if (new URL(r.url()).pathname.endsWith("/api/search")) searches++ })
  await saveWebMcp(request, false) // No browser storage notification.
  const previous = page.url()
  const result = await page.evaluate(async () => {
    const tools = (window as any).__heldWebMcp
    return [await tools.meitheal_search_tasks.execute({ query: "heating" }), await tools.meitheal_open_tasks.execute({ view: "table" })]
  })
  expect(result).toEqual([{ error: "Browser tools are unavailable." }, { error: "Browser tools are unavailable." }])
  await expectTools(page, [])
  expect(searches).toBe(0)
  expect(page.url()).toBe(previous)
})

test("WebMCP saved disable propagates across tabs and reenable avoids duplicate registrations", async ({ page, request }) => {
  await saveWebMcp(request, true)
  await installWebMcpDouble(page)
  const second = await page.context().newPage()
  await installWebMcpDouble(second)
  await page.goto("/settings#automation-ai-settings")
  await second.goto(page.url())
  await expectTools(page)
  await expectTools(second)
  await second.evaluate(() => (window as any).__heldWebMcp = (window as any).__webmcpTools.meitheal_search_tasks)
  await saveProtocols(page, false)
  await expectTools(page, [])
  await expectTools(second, [])
  await expect(second.locator("#webmcp-runtime-status")).toHaveText("Browser tools are disabled.")
  expect(await second.evaluate(() => (window as any).__heldWebMcp.execute({ query: "heating" }))).toEqual({ error: "Browser tools are unavailable." })
  await saveProtocols(page, true)
  await expectTools(page)
  await expectTools(second)
  expect(await second.evaluate(() => (window as any).__webmcpRegistrations)).toBe(4)
})

test("WebMCP handles page abort, failed registration and retry without leaving half a registry", async ({ page, request }) => {
  await saveWebMcp(request, true)
  await installWebMcpDouble(page, 2)
  await page.goto("/settings#automation-ai-settings")
  await expect(page.locator("#webmcp-runtime-status")).toHaveAttribute("data-state", "failed")
  await expectTools(page, [])
  await page.evaluate(() => (window as any).__webmcpFailAt = 0)
  await saveProtocols(page, true)
  await expectTools(page)
  await page.evaluate(() => document.dispatchEvent(new Event("astro:before-swap")))
  await expectTools(page, [])
  expect(await page.evaluate(() => (window as any).__webmcpRetired.every((t: any) => typeof t.execute === "function"))).toBe(true)
  const results = await page.evaluate(async () => Promise.all((window as any).__webmcpRetired.map((t: any) => t.execute(t.name.includes("search") ? { query: "heating" } : { view: "table" }))))
  expect(results.every((r: any) => r.error === "Browser tools are unavailable.")).toBe(true)
  await page.evaluate(() => document.dispatchEvent(new Event("astro:page-load")))
  await expectTools(page)
})

test("WebMCP save failure is retryable, unsupported status is truthful, and human Review remains linked", async ({ page, request }) => {
  await page.goto("/settings#automation-ai-settings")
  expect(await page.evaluate(() => typeof (document as any).modelContext?.registerTool)).toBe("undefined")
  let fail = true
  await page.route("**/api/settings", route => route.request().method() === "PUT" && route.request().postDataJSON().key === webMcpKey && fail
    ? route.fulfill({ status: 503, json: { error: "Save fixture unavailable" } }) : route.continue())
  await saveProtocols(page, true)
  await expect(page.locator("#agent-webmcp-enabled")).toBeChecked()
  await expect(page.locator("#toast-container .toast.error")).toContainText("Some changes were saved")
  await expect(page.locator("#toast-container .toast.success")).toHaveCount(0)
  expect((await (await request.get(`/api/settings?key=${webMcpKey}`)).json()).value).toBeNull()
  await expect(page.locator("#webmcp-runtime-status")).toHaveText("Browser tools are disabled.")
  fail = false
  await saveProtocols(page, true)
  await expect(page.locator("#webmcp-runtime-status")).toHaveText("This browser does not support WebMCP registration.")
  expect((await (await request.get(`/api/settings?key=${webMcpKey}`)).json()).value).toBe(true)
  await expect(page.locator("#bot-allow-proposals")).toHaveAttribute("href", /\/review$/)
})

test("WebMCP reconciles a persisted switch when a later protocol save fails", async ({ page, request }) => {
  await installWebMcpDouble(page)
  await page.goto("/settings#automation-ai-settings")
  await expectTools(page, [])
  await page.route("**/api/settings", route => route.request().method() === "PUT" && route.request().postDataJSON().key === "agent-protocols-mcp-enabled"
    ? route.fulfill({ status: 503, json: {} }) : route.continue())
  await saveProtocols(page, true)
  await expect(page.locator("#toast-container .toast.error")).toContainText("Some changes were saved")
  expect((await (await request.get(`/api/settings?key=${webMcpKey}`)).json()).value).toBe(true)
  await expectTools(page)
  await saveProtocols(page, false)
  expect((await (await request.get(`/api/settings?key=${webMcpKey}`)).json()).value).toBe(false)
  await expectTools(page, [])
})

test("WebMCP returns search errors and fails closed when its saved preference cannot be read", async ({ page, request }) => {
  await saveWebMcp(request, true)
  await installWebMcpDouble(page)
  await page.goto("/settings#automation-ai-settings")
  await expectTools(page)
  let response: unknown = { sections: [{}] }
  let status = 200
  await page.route("**/api/search?**", route => route.fulfill({ status, json: response }))
  expect(await searchTool(page, "heating")).toEqual({ error: "Meitheal task search did not complete." })
  status = 503
  expect(await searchTool(page, "heating")).toEqual({ error: "Meitheal task search is unavailable." })
  status = 200
  response = { sections: [{ items: Array.from({ length: 12 }, (_, i) => ({ kind: "task", taskId: `id/${i}`, title: `<img onerror=alert(1)> ${i}` })) }] }
  const bounded = await searchTool(page, "heating")
  expect(bounded.tasks).toHaveLength(8)
  expect(bounded.tasks[0].title).toBe("<img onerror=alert(1)> 0")
  expect(bounded.tasks[0].url).toMatch(/\?open=id%2F0$/)
  let searches = 0
  page.on("request", r => { if (new URL(r.url()).pathname.endsWith("/api/search")) searches++ })
  await page.route(`**/api/settings?key=${webMcpKey}`, route => route.fulfill({ status: 503, json: {} }))
  expect(await searchTool(page, "heating")).toEqual({ error: "Browser tools are unavailable." })
  await expectTools(page, [])
  await expect(page.locator("#webmcp-runtime-status")).toHaveAttribute("data-state", "failed")
  expect(searches).toBe(0)
})

test("WebMCP denies nonadmin preference access without granting browser tools", async ({ page, request }) => {
  await saveWebMcp(request, true)
  await installWebMcpDouble(page)
  await page.goto("/today")
  test.skip(!await page.evaluate(() => Boolean(window.__ingress_path)), "Administrator/member authority is covered by the guarded ingress fixture")
  await page.context().clearCookies()
  await page.context().addCookies([{ name: "feedback-fixture", value: "member", url: page.url() }])
  const denied = page.waitForResponse(r => new URL(r.url()).pathname.endsWith("/api/settings") && new URL(r.url()).searchParams.get("key") === webMcpKey)
  await page.reload()
  expect((await denied).status()).toBe(403)
  await expect.poll(() => page.evaluate(() => (window as any).__meithealWebMcpRuntime?.status)).toBe("disabled")
  await expectTools(page, [])
})


test("WebMCP opens only canonical Tasks views and cancels an execution before issuing search", async ({ page, request }) => {
  await saveWebMcp(request, true)
  await installWebMcpDouble(page)
  await page.goto("/settings#automation-ai-settings")
  await expectTools(page)
  const current = page.url()
  expect(await page.evaluate(() => (window as any).__webmcpTools.meitheal_open_tasks.execute({ view: "https://example.com" }))).toHaveProperty("error")
  expect(page.url()).toBe(current)
  let searches = 0
  page.on("request", r => { if (new URL(r.url()).pathname.endsWith("/api/search")) searches++ })
  expect(await page.evaluate(() => {
    const c = new AbortController()
    c.abort()
    return (window as any).__webmcpTools.meitheal_search_tasks.execute({ query: "heating" }, { signal: c.signal })
  })).toEqual({ error: "Browser tools are unavailable." })
  expect(searches).toBe(0)
  const prefix = await page.evaluate(() => window.__ingress_path || "")
  await page.evaluate(() => { void (window as any).__webmcpTools.meitheal_open_tasks.execute({ view: "table" }) })
  await expect(page).toHaveURL(new URL(`${prefix}/tasks?view=table#table`, current).href)
  await expect(page.locator('[data-task-view="table"]')).toBeVisible()
})

test("cancelling a tool during its preference read leaves the saved browser capability registered", async ({ page, request }) => {
  await saveWebMcp(request, true)
  await installWebMcpDouble(page)
  await page.goto("/settings#automation-ai-settings")
  await expectTools(page)
  let started = false
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const pattern = `**/api/settings?key=${webMcpKey}`
  await page.route(pattern, async route => {
    started = true
    await held
    await route.fulfill({ json: { key: webMcpKey, value: true } }).catch(() => {})
  })
  try {
    await page.evaluate(() => {
      const state = window as any
      state.__callController = new AbortController()
      state.__pendingCall = state.__webmcpTools.meitheal_search_tasks.execute({ query: "cancelled call" }, { signal: state.__callController.signal })
    })
    await expect.poll(() => started).toBe(true)
    await page.evaluate(() => (window as any).__callController.abort())
    expect(await page.evaluate(() => (window as any).__pendingCall)).toEqual({ error: "Browser tools are unavailable." })
    await expectTools(page)
    await expect(page.locator("#webmcp-runtime-status")).toHaveAttribute("data-state", "registered")
  } finally {
    release()
    await page.unroute(pattern)
  }
  expect(await searchTool(page, "next call after cancellation")).toEqual({ tasks: [] })
})

test("a stale Settings bootstrap cannot restore tools after a saved disable", async ({ page, request }) => {
  await saveWebMcp(request, true)
  await installWebMcpDouble(page)
  let snapshotCaptured = false
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  await page.route("**/api/settings", async route => {
    if (route.request().method() !== "GET") return route.continue()
    const response = await route.fetch()
    const snapshot = await response.json()
    expect(snapshot[webMcpKey]).toBe(true)
    snapshotCaptured = true
    await held
    await route.fulfill({ json: snapshot })
  })
  try {
    await page.goto("/settings#automation-ai-settings")
    await expectTools(page)
    await expect.poll(() => snapshotCaptured).toBe(true)
    const second = await page.context().newPage()
    await installWebMcpDouble(second)
    await second.goto(page.url())
    await expectTools(second)
    await saveProtocols(second, false)
    await expectTools(page, [])
    release()
    await expect(page.locator("#settings-panels")).not.toHaveAttribute("inert", "")
    await expect(page.locator("#agent-webmcp-enabled")).toBeChecked() // The deliberately held UI snapshot is stale.
    await expectTools(page, [])
    await expect(page.locator("#webmcp-runtime-status")).toHaveAttribute("data-state", "disabled")
  } finally { release() }
})
