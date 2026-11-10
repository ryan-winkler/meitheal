import { expect, test } from "@playwright/test"
import { shouldSkipBrowserSpecs } from "./_helpers"

test.skip(shouldSkipBrowserSpecs(), "Set E2E_BASE_URL to run native browser tools")

test("native WebMCP searches real tasks, unregisters when disabled and reenables without duplicates", async ({ playwright, request, baseURL }) => {
  const headers = {
    "x-hass-is-admin": "true",
    "x-hass-user-id": "native-webmcp-tests",
    "x-forwarded-for": `198.51.100.${Math.floor(Math.random() * 200) + 1}`,
  }
  const key = "agent-protocols-webmcp-enabled"
  const preference = await request.get(`/api/settings?key=${key}`, { headers })
  expect(preference.ok()).toBe(true)
  const previous = (await preference.json()).value
  const browser = await playwright.chromium.launch({
    headless: true,
    args: ["--enable-blink-features=WebMCP,WebMCPTesting", "--enable-features=WebMCPTesting"],
  })
  const page = await browser.newPage({ extraHTTPHeaders: headers })
  let taskId: string | undefined
  try {
    await page.goto(`${baseURL}/settings#automation-ai-settings`)
    const supported = await page.evaluate(() => {
      const nav = navigator as any
      return typeof nav.modelContext?.registerTool === "function"
        && typeof nav.modelContext?.unregisterTool === "function"
        && typeof nav.modelContextTesting?.listTools === "function"
        && typeof nav.modelContextTesting?.executeTool === "function"
    })
    test.skip(!supported, "This Chromium build does not expose the native WebMCP testing API")
    const names = () => page.evaluate(() => (navigator as any).modelContextTesting.listTools().map((tool: any) => tool.name).sort())
    const expected = ["meitheal_open_tasks", "meitheal_search_tasks"]
    const title = `NativeWebMcpHeating${crypto.randomUUID().replaceAll("-", "")}`
    const created = await request.post("/api/tasks", { headers, data: { title } })
    expect(created.status()).toBe(201)
    taskId = (await created.json()).id
    await request.put("/api/settings", { headers, data: { key, value: true } })
    await page.reload()
    await expect.poll(names).toEqual(expected)
    await expect(page.locator("#webmcp-runtime-status")).toHaveText("Browser tools are registered.")

    const search = async () => {
      const raw = await page.evaluate(async query => {
        return (navigator as any).modelContextTesting.executeTool("meitheal_search_tasks", JSON.stringify({ query }))
      }, title)
      return typeof raw === "string" ? JSON.parse(raw) : raw
    }
    expect(await search()).toEqual({ tasks: [{ title, url: `/tasks?open=${taskId}` }] })

    // Reevaluate the actual development module to exercise HMR replacement using
    // Chromium's registry. A duplicate registration must not survive the swap.
    const module = await request.get("/src/lib/webmcp-controller.ts", { headers })
    if (module.ok() && module.headers()["content-type"]?.includes("javascript")) {
      await page.evaluate(async () => {
        const path = "/src/lib/webmcp-controller.ts?native-registry-reload=1"
        await import(/* @vite-ignore */ path)
      })
      await expect.poll(names).toEqual(expected)
      await expect(page.locator("#webmcp-runtime-status")).toHaveText("Browser tools are registered.")
      expect(await search()).toEqual({ tasks: [{ title, url: `/tasks?open=${taskId}` }] })
    }

    await page.locator("label:has(#agent-webmcp-enabled)").click()
    await page.locator("#save-agent-protocols").click()
    await expect(page.locator("#webmcp-runtime-status")).toHaveText("Browser tools are disabled.")
    await expect.poll(names).toEqual([])
    await expect.poll(async () => (await (await request.get(`/api/settings?key=${key}`, { headers })).json()).value).toBe(false)

    await page.locator("label:has(#agent-webmcp-enabled)").click()
    await page.locator("#save-agent-protocols").click()
    await expect.poll(names).toEqual(expected)
    await expect(page.locator("#webmcp-runtime-status")).toHaveText("Browser tools are registered.")
    expect(await search()).toEqual({ tasks: [{ title, url: `/tasks?open=${taskId}` }] })
    test.info().annotations.push({ type: "native-browser", description: `Chromium ${browser.version()}, temporary WebMCP/WebMCPTesting flags` })
  } finally {
    if (taskId) await request.delete(`/api/tasks/${taskId}`, { headers })
    await request.put("/api/settings", { headers, data: { key, value: previous ?? false } })
    await browser.close()
  }
})
