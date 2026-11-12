import { expect } from "@playwright/test"
import { test } from "../scripts/settings-persistence-fixture"

test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires the built App and disposable authenticated fixture")

test("Settings counts actual discovery documents and describes only the read-only A2A search", async ({ page, request }) => {
  const cardResponse = await request.get("/api/a2a/agent-card")
  expect(cardResponse.status()).toBe(200)
  const card = await cardResponse.json()
  expect(card.skills.map((skill: { id: string }) => skill.id)).toEqual(["task-search", "assigned-tasks"])
  expect(card.supportedInterfaces).toHaveLength(1)
  const manifestResponse = await request.get("/.well-known/mcp.json")
  expect(manifestResponse.status()).toBe(200)
  const manifest = await manifestResponse.json()
  expect(manifest.protocol).toBe("mcp")
  expect(manifest.authentication).toEqual({ type: "bearer", requiredScope: "mcp:execute" })
  expect(manifest).not.toHaveProperty("tools")
  const methods: string[] = []
  page.on("request", r => { if (/\/(?:api\/a2a|api\/mcp|\.well-known\/mcp\.json)/.test(new URL(r.url()).pathname)) methods.push(r.method()) })
  await page.setViewportSize({ width: 320, height: 740 })
  await page.goto("/settings#automation-ai-settings")
  await expect(page.locator("#agent-protocols-status")).toHaveText("2 of 2 discovery documents available")
  await expect(page.locator("#agent-a2a-runtime-status")).toContainText("search active task titles")
  await expect(page.locator("#agent-mcp-runtime-status")).toContainText("token scopes")
  await expect(page.locator('[data-protocol-link="a2a"]')).toBeVisible()
  await expect(page.locator('[data-protocol-link="mcp"]')).toBeVisible()
  const prefix = await page.evaluate(() => window.__ingress_path || "")
  await expect(page.locator('[data-protocol-link="a2a"]')).toHaveAttribute("href", `${prefix}/api/a2a/agent-card`)
  await expect(page.locator('[data-protocol-link="mcp"]')).toHaveAttribute("href", `${prefix}/.well-known/mcp.json`)
  expect(methods).toEqual(["GET", "GET"])
  const badge = await page.locator("#agent-protocols-status").boundingBox()
  expect(badge!.x).toBeGreaterThanOrEqual(0)
  expect(badge!.x + badge!.width).toBeLessThanOrEqual(320)
})

test("saved disable and browser-only opt-in cannot inflate the discovery document count", async ({ page, request }) => {
  await page.goto("/settings#automation-ai-settings")
  await expect(page.locator("#agent-protocols-status")).toHaveText("2 of 2 discovery documents available")
  await page.locator("#agent-a2a-enabled").uncheck()
  await page.locator("#agent-mcp-enabled").uncheck()
  await page.locator("#agent-webmcp-enabled").check()
  await page.locator("#save-agent-protocols").click()
  await expect(page.locator("#agent-protocols-status")).toHaveText("0 of 2 discovery documents available")
  for (const name of ["a2a", "mcp"]) {
    await expect(page.locator(`#agent-${name}-runtime-status`)).toHaveAttribute("data-state", "disabled")
    await expect(page.locator(`[data-protocol-link="${name}"]`)).toBeHidden()
  }
  expect((await request.get("/api/a2a/agent-card")).status()).toBe(404)
  expect((await request.get("/.well-known/mcp.json")).status()).toBe(404)
  await expect(page.locator("#webmcp-runtime-status")).toHaveText("This browser does not support WebMCP registration.")
})

for (const fault of ["503", "malformed"]) {
  test(`discovery ${fault} is unavailable and a read-only retry recovers without preference writes`, async ({ page }) => {
    let fail = true
    let writes = 0
    page.on("request", r => { if (new URL(r.url()).pathname.endsWith("/api/settings") && r.method() === "PUT") writes++ })
    await page.route("**/.well-known/mcp.json", route => fail
      ? route.fulfill({ status: fault === "503" ? 503 : 200, json: { name: "Unexpected", protocol: "other" } })
      : route.continue())
    await page.goto("/settings#automation-ai-settings")
    await expect(page.locator("#agent-protocols-status")).toHaveText("1 of 2 discovery documents available")
    await expect(page.locator("#agent-mcp-runtime-status")).toHaveAttribute("data-state", "unavailable")
    await expect(page.locator('[data-protocol-link="mcp"]')).toBeHidden()
    fail = false
    await page.locator("#refresh-agent-discovery").click()
    await expect(page.locator("#agent-protocols-status")).toHaveText("2 of 2 discovery documents available")
    await expect(page.locator('[data-protocol-link="mcp"]')).toBeVisible()
    await expect(page.locator("#refresh-agent-discovery")).toBeEnabled()
    expect(writes).toBe(0)
  })
}

test("a partial protocol save refreshes actual availability without trusting the unsaved draft", async ({ page, request }) => {
  await page.goto("/settings#automation-ai-settings")
  await expect(page.locator("#agent-protocols-status")).toHaveText("2 of 2 discovery documents available")
  await page.route("**/api/settings", route => route.request().method() === "PUT" && route.request().postDataJSON().key === "agent-protocols-mcp-enabled"
    ? route.fulfill({ status: 503, json: {} }) : route.continue())
  await page.locator("#agent-a2a-enabled").uncheck()
  await page.locator("#agent-mcp-enabled").uncheck()
  await page.locator("#save-agent-protocols").click()
  await expect(page.locator("#save-agent-protocols")).toBeEnabled()
  await expect(page.locator("#toast-container .toast.error")).toContainText("Some changes were saved")
  await expect(page.locator("#toast-container .toast.success")).toHaveCount(0)
  await expect(page.locator("#agent-protocols-status")).toHaveText("1 of 2 discovery documents available")
  await expect(page.locator("#agent-mcp-enabled")).not.toBeChecked()
  await expect(page.locator('[data-protocol-link="mcp"]')).toBeVisible()
  await expect(page.locator('[data-protocol-link="a2a"]')).toBeHidden()
  expect((await request.get("/.well-known/mcp.json")).status()).toBe(200)
  expect((await request.get("/api/a2a/agent-card")).status()).toBe(404)
})

test("a held old discovery response cannot overwrite the result after saved disable", async ({ page }) => {
  let first = true
  let captured = false
  let oldResponseFinished = false
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  await page.route("**/.well-known/mcp.json", async route => {
    if (!first) return route.continue()
    first = false
    const response = await route.fetch()
    expect(response.status()).toBe(200)
    const snapshot = await response.json()
    captured = true
    await held
    await route.fulfill({ json: snapshot }).catch(() => {})
    oldResponseFinished = true
  })
  try {
    await page.goto("/settings#automation-ai-settings")
    await expect.poll(() => captured).toBe(true)
    await page.locator("#agent-a2a-enabled").uncheck()
    await page.locator("#agent-mcp-enabled").uncheck()
    await page.locator("#save-agent-protocols").click()
    await expect(page.locator("#agent-protocols-status")).toHaveText("0 of 2 discovery documents available")
    release()
    await expect.poll(() => oldResponseFinished).toBe(true)
    await expect(page.locator("#agent-mcp-runtime-status")).toHaveAttribute("data-state", "disabled")
    await expect(page.locator('[data-protocol-link="mcp"]')).toBeHidden()
    await expect(page.locator("#agent-protocols-status")).toHaveText("0 of 2 discovery documents available")
  } finally { release() }
})

test("member discovery status comes from endpoints rather than hidden administrator preferences", async ({ page, request }) => {
  expect((await request.put("/api/settings", { data: { key: "agent-protocols-mcp-enabled", value: false } })).status()).toBe(200)
  await page.goto("/settings#automation-ai-settings")
  test.skip(!await page.evaluate(() => Boolean(window.__ingress_path)), "Member authority uses the guarded ingress fixture")
  await page.context().clearCookies()
  await page.context().addCookies([{ name: "feedback-fixture", value: "member", url: page.url() }])
  await page.reload()
  await expect(page.locator("#agent-protocols-status")).toHaveText("1 of 2 discovery documents available")
  await expect(page.locator("#agent-mcp-runtime-status")).toHaveAttribute("data-state", "disabled")
  await expect(page.locator("#agent-a2a-runtime-status")).toHaveAttribute("data-state", "available")
})
