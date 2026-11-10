import { expect, test } from "@playwright/test"
import { shouldSkipBrowserSpecs } from "./_helpers"

test.skip(shouldSkipBrowserSpecs(), "Set E2E_BASE_URL to verify browser registration")

test("WebMCP registers supported tools, searches real responses and revokes on disable", async ({ page }) => {
  const settings: Record<string, unknown> = { "agent-protocols-webmcp-enabled": true }
  let searches = 0
  await page.addInitScript(() => {
    const state = window as any
    state.__protocolTools = {}
    state.__protocolRegistrations = 0
    Object.defineProperty(document, "modelContext", { configurable: true, value: {
      async registerTool(tool: any, { signal }: { signal: AbortSignal }) {
        if (signal.aborted) throw new DOMException("Aborted", "AbortError")
        state.__protocolRegistrations++
        state.__protocolTools[tool.name] = tool
        // Like native Chromium, this registry ignores the registration signal.
      },
      unregisterTool(name: string) {
        delete state.__protocolTools[name]
      },
    } })
  })
  await page.route("**/api/settings**", async route => {
    const request = route.request()
    if (request.method() === "PUT") {
      const { key, value } = request.postDataJSON()
      settings[key] = value
      await route.fulfill({ json: { key, value } })
    } else {
      const key = new URL(request.url()).searchParams.get("key")
      await route.fulfill({ json: key ? { key, value: settings[key] ?? null } : settings })
    }
  })
  await page.route("**/api/search?**", async route => {
    searches++
    const params = new URL(route.request().url()).searchParams
    expect(params.get("q")).toBe("heating")
    expect(params.get("scope")).toBe("tasks")
    expect(params.get("task_fields")).toBe("title")
    await route.fulfill({ json: { sections: [{ items: [{ kind: "task", taskId: "heater-1", title: "Service the heating controller" }] }] } })
  })
  await page.goto("/settings#automation-ai-settings")
  await page.waitForFunction(() => Object.keys((window as any).__protocolTools).length === 2)
  await expect(page.locator("#webmcp-runtime-status")).toHaveText("Browser tools are registered.")
  expect(await page.evaluate(() => (window as any).__protocolRegistrations)).toBe(2)
  const result = await page.evaluate(() => (window as any).__protocolTools.meitheal_search_tasks.execute({ query: "heating" }))
  expect(result).toEqual({ tasks: [{ title: "Service the heating controller", url: "/tasks?open=heater-1" }] })
  expect(searches).toBe(1)
  // Keep a reference to show already-issued tool handles also honor the saved switch.
  await page.evaluate(() => (window as any).__retiredProtocolTool = (window as any).__protocolTools.meitheal_search_tasks)
  await page.locator("label:has(#agent-webmcp-enabled)").click()
  await page.locator("#save-agent-protocols").click()
  await expect(page.locator("#webmcp-runtime-status")).toHaveText("Browser tools are disabled.")
  await page.waitForFunction(() => Object.keys((window as any).__protocolTools).length === 0)
  expect(settings["agent-protocols-webmcp-enabled"]).toBe(false)
  const revoked = await page.evaluate(() => (window as any).__retiredProtocolTool.execute({ query: "heating" }))
  expect(revoked).toEqual({ error: "Browser tools are unavailable." })
  expect(searches).toBe(1)
})

test("WebMCP saves retryable preferences without claiming support in an unavailable browser", async ({ page }) => {
  let fail = true
  const settings: Record<string, unknown> = { "agent-protocols-webmcp-enabled": false }
  await page.route("**/api/settings**", async route => {
    const request = route.request()
    if (request.method() === "PUT") {
      if (fail) return route.fulfill({ status: 503, json: { error: "Fixture unavailable" } })
      const { key, value } = request.postDataJSON()
      settings[key] = value
      return route.fulfill({ json: { key, value } })
    }
    const key = new URL(request.url()).searchParams.get("key")
    return route.fulfill({ json: key ? { key, value: settings[key] ?? null } : settings })
  })
  await page.goto("/settings#automation-ai-settings")
  await expect(page.locator("#webmcp-runtime-status")).toHaveText("Browser tools are disabled.")
  await page.locator("label:has(#agent-webmcp-enabled)").click()
  await page.locator("#save-agent-protocols").click()
  await expect(page.locator("#save-agent-protocols")).toBeEnabled()
  await expect(page.locator("#agent-webmcp-enabled")).toBeChecked()
  await expect(page.locator("#toast-container .toast.success")).toHaveCount(0)
  expect(settings["agent-protocols-webmcp-enabled"]).toBe(false)
  fail = false
  await page.locator("#save-agent-protocols").click()
  await expect(page.locator("#webmcp-runtime-status")).toHaveText("This browser does not support WebMCP registration.")
  await expect.poll(() => settings["agent-protocols-webmcp-enabled"]).toBe(true)
})
