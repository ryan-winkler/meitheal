import { expect, type APIRequestContext, type Page } from "@playwright/test"

export const webMcpKey = "agent-protocols-webmcp-enabled"
export const toolNames = ["meitheal_open_tasks", "meitheal_search_tasks"]

/** A contract double, not evidence of native browser support. */
export async function installWebMcpDouble(page: Page, failRegistration = 0) {
  await page.addInitScript(failAt => {
    const state = window as any
    state.__webmcpTools = {}
    state.__webmcpRetired = []
    state.__webmcpRegistrations = 0
    state.__webmcpFailAt = failAt
    Object.defineProperty(document, "modelContext", { configurable: true, value: {
      async registerTool(tool: any, { signal }: { signal: AbortSignal }) {
        if (signal.aborted) throw new DOMException("Aborted", "AbortError")
        state.__webmcpRegistrations++
        if (state.__webmcpFailAt > 0 && state.__webmcpRegistrations >= state.__webmcpFailAt) throw new Error("Registration fixture failed")
        if (state.__webmcpTools[tool.name]) throw new Error("Duplicate registration")
        state.__webmcpTools[tool.name] = tool
        signal.addEventListener("abort", () => {
          state.__webmcpRetired.push(tool)
          if (state.__webmcpTools[tool.name] === tool) delete state.__webmcpTools[tool.name]
        }, { once: true })
      },
    } })
  }, failRegistration)
}

export async function saveWebMcp(request: APIRequestContext, enabled: boolean) {
  expect((await request.put("/api/settings", { data: { key: webMcpKey, value: enabled } })).status()).toBe(200)
}

export async function expectTools(page: Page, expected = toolNames) {
  await expect.poll(() => page.evaluate(() => Object.keys((window as any).__webmcpTools).sort())).toEqual(expected)
}

export async function searchTool(page: Page, query: unknown) {
  return page.evaluate(query => (window as any).__webmcpTools.meitheal_search_tasks.execute({ query }), query)
}

export async function saveProtocols(page: Page, enabled: boolean) {
  await page.locator("#agent-webmcp-enabled").setChecked(enabled)
  await page.locator("#save-agent-protocols").click()
  await expect(page.locator("#save-agent-protocols")).toBeEnabled()
}
