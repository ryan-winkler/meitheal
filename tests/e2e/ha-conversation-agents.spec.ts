import { expect, test, type Page } from "@playwright/test"
import { fetchHaAgents } from "../../apps/web/src/lib/ha-agent-picker"
import { readConversationAgents } from "../../apps/web/src/domains/ha/conversation-agents"
import { shouldSkipBrowserSpecs } from "./_helpers"

// HA conversation/agent/list covers entity agents and legacy config-entry IDs.
const registeredAgents = [
  { id: "conversation.home_assistant", name: "Home Assistant", supported_languages: ["en"] },
  { id: "conversation.household", name: "Household assistant", supported_languages: "*" as const },
  { id: "01LEGACYCONFIGENTRY", name: "Custom integration", supported_languages: ["en", "ga"] },
]

test("HA discovery accepts every registered agent type and deduplicates exact IDs", () => {
  expect(readConversationAgents({ agents: [...registeredAgents, registeredAgents[1]] })).toEqual(registeredAgents)
  expect(readConversationAgents({ agents: [] })).toEqual([])
  expect(readConversationAgents({ agents: [{ id: "legacy-entry", name: "Legacy agent" }] })).toEqual([{ id: "legacy-entry", name: "Legacy agent" }])
  expect(() => readConversationAgents({})).toThrow("conversation agent list")
  expect(() => readConversationAgents({ agents: [{ id: "conversation.bad" }] })).toThrow("Invalid Home Assistant")
})

test("agent discovery gives stable errors for non-JSON and null response bodies", async () => {
  const originalFetch = globalThis.fetch
  try {
    for (const [status, body, expected] of [
      [502, "<html>Bad Gateway</html>", "Home Assistant agent discovery failed"],
      [403, "null", "Assist requires an active Home Assistant administrator"],
      [200, "null", "Home Assistant returned an invalid agent list"],
    ] as const) {
      globalThis.fetch = async () => new Response(body, { status })
      await expect(fetchHaAgents(new AbortController().signal)).rejects.toThrow(expected)
    }
  } finally {
    globalThis.fetch = originalFetch
  }
})

async function mockPreference(page: Page, selected: string) {
  await page.route("**/api/settings?key=ha-assist-agent", route => route.fulfill({ json: { key: "ha-assist-agent", value: selected } }))
  await page.route("**/api/settings", async route => {
    if (route.request().method() !== "GET") return route.continue()
    const response = await route.fetch()
    return route.fulfill({ response, json: { ...await response.json(), "ha-assist-agent": selected } })
  })
}

async function openAsk(page: Page) {
  await page.evaluate(() => (window as unknown as { openAskHaModal: () => void }).openAskHaModal())
  await expect(page.locator("#ask-ha-overlay")).toHaveClass(/active/)
  await expect(page.locator("#ask-ha-agent-select")).toBeEnabled()
}

test.describe("Dynamic Home Assistant agent pickers", () => {
  test.skip(shouldSkipBrowserSpecs(), "Set E2E_BASE_URL to run browser specs")
  test.use({ serviceWorkers: "block" })

  test("refresh retains keyboard focus and ignores repeat activation while discovery is busy", async ({ page }) => {
    let release: (() => void) | undefined
    let held = false
    let reads = 0
    await mockPreference(page, "conversation.household")
    await page.route("**/api/ha/agents", async route => {
      reads += 1
      if (held) await new Promise<void>(resolve => { release = resolve })
      await route.fulfill({ json: { agents: registeredAgents } })
    })
    for (const [url, refreshId] of [
      ["/settings#automation-ai-settings", "#refresh-ha-agents"],
      ["/tasks", "#refresh-ask-ha-agents"],
    ] as const) {
      await page.goto(url)
      if (url === "/tasks") {
        await expect.poll(() => page.evaluate(() => typeof window.openAskHaModal)).toBe("function")
        await openAsk(page)
      } else {
        // Initial agent discovery may settle while the Settings panels are still inert.
        await expect(page.locator("#settings-panels")).not.toHaveAttribute("inert", "")
      }
      const refresh = page.locator(refreshId)
      await expect(refresh).toHaveAttribute("aria-busy", "false")
      await refresh.focus()
      await expect(refresh).toBeFocused()
      held = true
      const previousReads = reads
      try {
        await page.keyboard.press("Enter")
        await expect(refresh).toHaveAttribute("aria-busy", "true")
        await expect.poll(() => reads).toBe(previousReads + 1)
        await expect(refresh).toBeFocused()
        await page.keyboard.press("Enter")
        expect(reads).toBe(previousReads + 1)
      } finally {
        held = false
        release?.()
        release = undefined
      }
      await expect(refresh).toHaveAttribute("aria-busy", "false")
      await expect(refresh).toBeFocused()
    }
  })

  test("Gaelic settings localize agent refresh and discovery feedback", async ({ page, context, baseURL }) => {
    await context.addCookies([{ name: "meitheal-locale", value: "ga", url: baseURL! }])
    await page.addInitScript(() => localStorage.setItem("meitheal-locale", "ga"))
    await mockPreference(page, "conversation.household")
    await page.route("**/api/ha/agents", route => route.fulfill({ json: { agents: registeredAgents } }))
    await page.goto("/settings#automation-ai-settings")
    await expect(page.locator("#refresh-ha-agents")).toHaveText("Athnuaigh gníomhairí")
    await expect(page.locator("#ha-agent-discovery-status")).toHaveText("3 gníomhaire Home Assistant ar fáil.")
    await page.locator("#ha-agent-select-settings").selectOption("conversation.home_assistant")
    await expect(page.locator("#ha-agent-discovery-status")).toContainText("Sábháil chun an gníomhaire comhrá")
  })

  test("Settings refreshes on opening, preserves saved IDs, and shows failures", async ({ page }) => {
    let agents = [...registeredAgents]
    let failure = false
    let reads = 0
    await mockPreference(page, "01LEGACYCONFIGENTRY")
    await page.route("**/api/ha/agents", route => {
      reads += 1
      return route.fulfill(failure
        ? { status: 503, json: { agents: [], error: "Home Assistant WebSocket disconnected" } }
        : { json: { agents: [...agents, agents[0]] } })
    })
    await page.goto("/settings#automation-ai-settings")
    const picker = page.locator("#ha-agent-select-settings")
    const status = page.locator("#ha-agent-discovery-status")
    await expect(status).toContainText("3 Home Assistant agents available")
    await expect(picker).toHaveValue("01LEGACYCONFIGENTRY")
    await expect(picker.locator("option")).toHaveCount(4)
    agents.push({ id: "conversation.new_custom", name: "New custom agent", supported_languages: "*" })
    await page.locator("#refresh-ha-agents").click()
    await expect(picker.locator("option")).toHaveCount(5)
    await expect(picker).toHaveValue("01LEGACYCONFIGENTRY")
    const previousReads = reads
    await page.getByRole("navigation", { name: "Sections" }).getByRole("link", { name: "Workflow", exact: true }).click()
    await page.getByRole("navigation", { name: "Sections" }).getByRole("link", { name: "Automation & AI", exact: true }).click()
    await expect.poll(() => reads).toBeGreaterThan(previousReads)
    await expect(page.locator("#refresh-ha-agents")).toHaveAttribute("aria-busy", "false")
    failure = true
    await page.locator("#refresh-ha-agents").click()
    await expect(status).toContainText("WebSocket disconnected")
    await expect(picker).toHaveValue("01LEGACYCONFIGENTRY")
    failure = false
    agents = agents.filter(agent => agent.id !== "01LEGACYCONFIGENTRY")
    await page.locator("#refresh-ha-agents").click()
    await expect(status).toContainText("selected agent is unavailable")
    await expect(picker).toHaveValue("01LEGACYCONFIGENTRY")
    await expect(picker.locator("option:checked")).toContainText("unavailable")
  })

  test("Ask Assist discovers new agents, keeps multi-turn on reopen, and resets on selection changes", async ({ page }) => {
    let agents = [...registeredAgents]
    let failure = false
    const requests: Array<Record<string, string>> = []
    await mockPreference(page, "conversation.household")
    await page.route("**/api/ha/agents", route => route.fulfill(failure
      ? { status: 502, json: { agents: [], error: "Home Assistant did not return its conversation agents" } }
      : { json: { agents } }))
    await page.route("**/api/ha/assist", route => {
      requests.push(route.request().postDataJSON())
      return route.fulfill({ json: { speech: "Ready", response_type: "query_answer", conversation_id: `turn-${requests.length}` } })
    })
    await page.goto("/tasks")
    await expect.poll(() => page.evaluate(() => typeof (window as unknown as { openAskHaModal?: unknown }).openAskHaModal)).toBe("function")
    await openAsk(page)
    const picker = page.locator("#ask-ha-agent-select")
    const input = page.locator("#ask-ha-input")
    const send = page.locator("#submit-ask-ha-btn")
    await expect(picker).toHaveValue("conversation.household")
    await input.fill("First question")
    await send.click()
    await expect(page.locator("#ask-ha-chat")).toContainText("Ready")
    expect(requests[0]).toEqual({ text: "First question", agent_id: "conversation.household" })
    await page.locator("#close-ask-ha-modal").click()
    await expect(page.locator("#ask-ha-overlay")).not.toHaveClass(/active/)
    agents.push({ id: "conversation.just_added", name: "Just added", supported_languages: "*" })
    await openAsk(page)
    await expect(picker.locator("option")).toHaveCount(5)
    await expect(page.locator("#ask-ha-chat")).toContainText("First question")
    await input.fill("Follow up")
    await send.click()
    await expect.poll(() => requests.length).toBe(2)
    expect(requests[1]).toEqual({ text: "Follow up", agent_id: "conversation.household", conversation_id: "turn-1" })
    await expect(picker).toBeEnabled()
    await picker.selectOption("conversation.just_added")
    await expect(page.locator("#ask-ha-chat")).not.toContainText("First question")
    await input.fill("Different agent")
    await send.click()
    await expect.poll(() => requests.length).toBe(3)
    expect(requests[2]).toEqual({ text: "Different agent", agent_id: "conversation.just_added" })
    await expect(picker).toBeEnabled()
    failure = true
    await page.locator("#refresh-ask-ha-agents").click()
    await expect(page.locator("#ask-ha-agent-status")).toContainText("Refresh to retry")
    await expect(picker).toHaveValue("conversation.just_added")
    failure = false
    agents = [...registeredAgents]
    await page.locator("#refresh-ask-ha-agents").click()
    await expect(page.locator("#ask-ha-agent-status")).toContainText("selected agent is unavailable")
    await expect(picker).toHaveValue("conversation.just_added")
    await input.fill("Must not fall back")
    await expect(send).toBeDisabled()
    expect(requests).toHaveLength(3)
  })
})
