import { expect, test, type APIRequestContext } from "@playwright/test"
import { shouldSkipBrowserSpecs } from "./_helpers"

test.skip(shouldSkipBrowserSpecs(), "Set E2E_BASE_URL for disposable local API/browser acceptance")

const admin = { "x-hass-is-admin": "true", "x-hass-user-id": "approval-regression" }
const member = { "x-hass-is-admin": "false", "x-hass-user-id": "approval-member" }
test.use({ extraHTTPHeaders: { "x-forwarded-for": "198.51.100.216" } })

async function token(request: APIRequestContext, scopes: string[]) {
  const response = await request.post("/api/agent-tokens", { headers: admin, data: { name: "Local approval regression", scopes } })
  expect(response.status(), await response.text()).toBe(201)
  const value = await response.json()
  return { id: value.id as string, headers: { authorization: "Bearer " + value.token } }
}
const taskUrl = (id: string) => `/api/tasks/${id}`
const handoff = (request: APIRequestContext, id: string, headers: Record<string, string>, data: object) =>
  request.post(taskUrl(id) + "/handoff", { headers, data })
const decision = (request: APIRequestContext, id: string, headers: Record<string, string>, hash: string, action = "accept") =>
  request.post(taskUrl(id) + "/accept-proposal", { headers: { origin: process.env.E2E_BASE_URL ?? "http://127.0.0.1:3000", ...headers }, data: { action, proposal_hash: hash } })

test("scoped proposals require the owning lease and a same-site administrator decision", async ({ request, page }) => {
  test.skip(shouldSkipBrowserSpecs(), "Requires a disposable local Astro dev server")
  const created = await request.post("/api/tasks", { data: { title: "Original approval title", description: "Original description" } })
  expect(created.status()).toBe(201)
  const { id } = await created.json()
  const first = await token(request, ["tasks:propose", "mcp:execute"])
  const second = await token(request, ["tasks:propose"])
  const direct = await token(request, ["tasks:write"])
  try {
    expect((await handoff(request, id, admin, { action: "claim" })).status()).toBe(401)
    expect((await handoff(request, id, direct.headers, { action: "claim" })).status()).toBe(403)
    expect((await request.put(taskUrl(id), { headers: first.headers, data: { title: "Bypass" } })).status()).toBe(403)
    const mixedIdentity = { ...admin, ...first.headers, origin: process.env.E2E_BASE_URL! }
    expect((await request.post("/api/agent-tokens", { headers: mixedIdentity, data: { name: "Escalation must fail", scopes: ["tasks:write", "settings:write"] } })).status()).toBe(403)
    expect((await request.get("/api/agent-tokens", { headers: mixedIdentity })).status()).toBe(403)
    expect((await request.patch("/api/agent-tokens", { headers: mixedIdentity, data: { id: first.id, scopes: ["tasks:write", "settings:write"] } })).status()).toBe(403)
    expect((await request.delete("/api/agent-tokens", { headers: mixedIdentity, data: { id: first.id, hard: true } })).status()).toBe(403)
    const claims = await Promise.all([first, second].map(owner => handoff(request, id, owner.headers, { action: "claim" })))
    expect(claims.map(value => value.status()).sort()).toEqual([200, 409])
    const winner = claims.findIndex(value => value.ok())
    const { lease } = await claims[winner]!.json()
    const owner = [first, second][winner]!.headers
    const other = [first, second][1 - winner]!.headers
    const updates = { title: "Nua-" + "Fada".repeat(80), description: "New description" }
    expect((await handoff(request, id, other, { action: "propose", lease, summary: "Impersonation", updates })).status()).toBe(409)
    expect((await handoff(request, id, owner, { action: "propose", lease, summary: "Invalid", updates: { status: "complete" } })).status()).toBe(400)
    const proposed = await handoff(request, id, owner, { action: "propose", lease, summary: "Clarify title and description", updates })
    expect(proposed.status(), await proposed.text()).toBe(200)
    const { hash } = await proposed.json()
    expect((await (await request.get(taskUrl(id))).json()).title).toBe("Original approval title")
    expect((await request.get("/review", { headers: member })).status()).toBe(403)
    expect((await decision(request, id, member, hash)).status()).toBe(403)
    expect((await decision(request, id, { ...admin, ...owner }, hash)).status()).toBe(403)
    expect((await decision(request, id, { ...admin, origin: "https://foreign.invalid" }, hash)).status()).toBe(403)
    expect((await decision(request, id, { ...admin, origin: "https://foreign.invalid", referer: process.env.E2E_BASE_URL! }, hash)).status()).toBe(403)
    expect((await request.post(taskUrl(id) + "/accept-proposal", { headers: admin, data: { action: "accept", proposal_hash: hash } })).status()).toBe(403)
    expect((await decision(request, id, admin, "0".repeat(64))).status()).toBe(409)
    await page.setExtraHTTPHeaders({ ...admin, "x-forwarded-for": "198.51.100.217" })
    await page.setViewportSize({ width: 320, height: 760 })
    await page.goto("/settings#bot-allow-proposals")
    await page.getByRole("link", { name: "Open review queue" }).click()
    await expect(page.locator("#main-content").getByRole("heading", { name: "Agent approvals" })).toBeVisible()
    await expect(page.locator("#review-queue")).toHaveAttribute("data-review-ready", "true")
    const summary = page.locator(`[data-review-task-id="${id}"] summary`)
    await summary.focus()
    await page.keyboard.press("Enter")
    await expect(page.locator(`[data-review-task-id="${id}"]`).getByText(updates.title, { exact: true })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320)
    await page.locator(`[data-review-task-id="${id}"]`).getByRole("button", { name: "Approve changes" }).focus()
    await page.keyboard.press("Enter")
    await expect(page.locator("#review-feedback")).toHaveText("Approved. The task was updated.")
    await expect(page.locator("#review-feedback")).toBeFocused()
    expect(await (await request.get(taskUrl(id))).json()).toMatchObject(updates)
    expect((await decision(request, id, admin, hash)).status()).toBe(409)
  } finally {
    expect((await request.delete(taskUrl(id), { headers: { ...admin, origin: process.env.E2E_BASE_URL! } })).status()).toBe(204)
    for (const value of [first, second, direct]) await request.delete("/api/agent-tokens", { headers: admin, data: { id: value.id, hard: true } })
  }
})

test("release invalidates a lease and rejection preserves a concurrent human edit", async ({ request }) => {
  test.skip(shouldSkipBrowserSpecs(), "Requires a disposable local Astro dev server")
  const { id } = await (await request.post("/api/tasks", { data: { title: "Original title" } })).json()
  const owner = await token(request, ["tasks:propose"])
  try {
    const { lease: released } = await (await handoff(request, id, owner.headers, { action: "claim" })).json()
    expect((await handoff(request, id, owner.headers, { action: "release", lease: released })).status()).toBe(200)
    const { lease } = await (await handoff(request, id, owner.headers, { action: "claim" })).json()
    expect(lease).not.toBe(released)
    const input = { action: "propose", lease, summary: "Update title", updates: { title: "Proposed title" } }
    expect((await handoff(request, id, owner.headers, { ...input, lease: released })).status()).toBe(409)
    const proposal = await handoff(request, id, owner.headers, input)
    expect(proposal.status(), await proposal.text()).toBe(200)
    const { hash } = await proposal.json()
    expect((await request.put(taskUrl(id), { headers: admin, data: { title: "Human edit" } })).status()).toBe(200)
    expect((await decision(request, id, admin, hash)).status()).toBe(409)
    expect((await decision(request, id, admin, hash, "reject")).status()).toBe(200)
    expect((await (await request.get(taskUrl(id))).json()).title).toBe("Human edit")
    expect((await handoff(request, id, owner.headers, { action: "claim" })).status()).toBe(200)
  } finally {
    expect((await request.delete(taskUrl(id), { headers: { ...admin, origin: process.env.E2E_BASE_URL! } })).status()).toBe(204)
    await request.delete("/api/agent-tokens", { headers: admin, data: { id: owner.id, hard: true } })
  }
})
