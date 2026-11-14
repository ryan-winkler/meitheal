import { expect } from "@playwright/test"
import { test } from "../scripts/settings-persistence-fixture"

const initialRule = { name: "Task Default", ruleType: "strategic-lens", taskTypes: ["task"], lensIds: [] }
const custom = { id: "imported-household", name: "Household", archetype: "taxonomy", source: "user",
  fields: [{ key: "kind", label: "Kind", type: "select", uiType: "select", weight: 1, helpText: "Choose kind" }], badgeThresholds: [] }

for (const replacement of ["preset", "defaults", "import"] as const) {
  test(`${replacement} waits for pending autosave and the next edit replaces the current default IDs`, async ({ page, request }) => {
    await request.put("/api/rules", { data: { rules: [initialRule] } })
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    const writes: Array<{ path: string; ids?: string[] }> = []
    await page.route("**/api/**", async route => {
      const path = new URL(route.request().url()).pathname.replace(/^\/api\/hassio_ingress\/[^/]+/, "")
      if (route.request().method() === "GET" || !["/api/rules", "/api/rules/defaults", "/api/import/settings"].includes(path)) return route.continue()
      writes.push({ path, ids: route.request().postDataJSON()?.replaceIds })
      if (writes.length === 1) await held
      await route.continue()
    })
    await page.goto("/settings#rules-lenses-settings")
    const checkbox = page.locator('.rules-fw-check[data-task-type="task"][data-framework="kcs"]')
    await checkbox.locator("..").click()
    await expect.poll(() => writes.length).toBe(1)
    if (replacement === "preset") await page.locator('[data-preset="balanced"]').click()
    else if (replacement === "defaults") await page.locator("#rules-restore-defaults").click()
    else await page.locator("#rules-import-input").setInputFiles({ name: "rules.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify({ rules: [{ ...initialRule, lensIds: ["rice"] }] })) })
    await page.locator("#confirm-ok").click()
    await expect(checkbox).toBeDisabled()
    expect(writes).toHaveLength(1)
    release()
    await expect.poll(() => writes.length).toBe(2)
    await expect(checkbox).toBeEnabled()
    await expect(checkbox).not.toBeChecked()
    const current = (await (await request.get("/api/rules")).json()).data
    await checkbox.locator("..").click()
    await expect.poll(() => writes.length).toBe(3)
    expect(writes[2]!.ids?.sort()).toEqual(current.map((item: { id: string }) => item.id).sort())
    await expect.poll(async () => (await (await request.get("/api/rules")).json()).data.filter((item: { name: string }) => item.name === "Task Default")).toHaveLength(1)
  })
}

test("a rejected combined rules import preserves the current IDs and can retry the same file", async ({ page, request }) => {
  await request.put("/api/rules", { data: { rules: [initialRule] } })
  const before = await (await request.get("/api/rules")).json()
  await page.route("**/api/import/settings", route => route.fulfill({ status: 503, json: { success: false } }))
  await page.goto("/settings#rules-lenses-settings")
  const input = page.locator("#rules-import-input")
  const backup = { name: "rules.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify({
    rules: [{ ...initialRule, lensIds: ["rice"] }, { ...initialRule, name: "Heating safety", tags: ["safety"] }], customFrameworks: [custom],
  })) }
  await input.setInputFiles(backup)
  await page.locator("#confirm-ok").click()
  await expect(page.locator("#toast-container .toast.error")).not.toHaveCount(0)
  await expect(input).not.toHaveValue("")
  expect(await (await request.get("/api/rules")).json()).toEqual(before)
  expect((await request.get(`/api/frameworks/${custom.id}`)).status()).toBe(404)
  await page.unroute("**/api/import/settings")
  await input.setInputFiles(backup)
  await page.locator("#confirm-ok").click()
  await expect(input).toHaveValue("")
  expect((await (await request.get(`/api/frameworks/${custom.id}`)).json()).data).toMatchObject(custom)
  await page.locator('.rules-fw-check[data-task-type="task"][data-framework="kcs"]').locator("..").click()
  await expect.poll(async () => (await (await request.get("/api/rules")).json()).data.find((item: { name: string }) => item.name === "Task Default")?.lensIds).toEqual(expect.arrayContaining(["rice", "kcs"]))
  const rules = (await (await request.get("/api/rules")).json()).data
  expect(rules.filter((item: { name: string }) => item.name === "Task Default")).toHaveLength(1)
  expect(rules.find((item: { name: string }) => item.name === "Heating safety").tags).toEqual(["safety"])
})

test("invalid custom definitions are rejected before any configuration mutation", async ({ page, request }) => {
  await request.put("/api/rules", { data: { rules: [initialRule] } })
  const before = await (await request.get("/api/rules")).json()
  const writes: string[] = []
  await page.route("**/api/**", route => {
    if (route.request().method() !== "GET") writes.push(route.request().url())
    return route.continue()
  })
  await page.goto("/settings#rules-lenses-settings")
  await page.locator("#rules-import-input").setInputFiles({ name: "invalid.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify({ rules: [], customFrameworks: [{ id: "bad", fields: [] }] })) })
  await page.locator("#confirm-ok").click()
  await expect(page.locator("#toast-container .toast.error")).not.toHaveCount(0)
  expect(writes).toHaveLength(1)
  expect(new URL(writes[0]!).pathname).toMatch(/\/api\/import\/settings$/)
  expect(await (await request.get("/api/rules")).json()).toEqual(before)
  await expect(page.locator("#rules-import-input")).not.toHaveValue("")
})

test("a committed rule save with a lost response reconciles its new IDs before retry", async ({ page, request }) => {
  await request.put("/api/rules", { data: { rules: [initialRule, { ...initialRule, name: "Heating safety", tags: ["safety"] }] } })
  await page.goto("/settings#rules-lenses-settings")
  let loseResponse = true
  await page.route("**/api/rules", async route => {
    if (route.request().method() !== "PUT" || !loseResponse) return route.continue()
    loseResponse = false
    expect((await route.fetch()).status()).toBe(200)
    await route.abort("failed")
  })
  const checkbox = page.locator('.rules-fw-check[data-task-type="task"][data-framework="kcs"]')
  await checkbox.locator("..").click()
  await expect(page.locator("#toast-container .toast.error")).not.toHaveCount(0)
  await expect(checkbox).toBeChecked()
  await checkbox.dispatchEvent("change")
  await expect(page.locator("#toast-container .toast.success")).not.toHaveCount(0)
  const rules = (await (await request.get("/api/rules")).json()).data
  expect(rules).toHaveLength(5)
  expect(rules.filter((item: { name: string }) => item.name === "Task Default")).toHaveLength(1)
  expect(rules.find((item: { name: string }) => item.name === "Task Default").lensIds).toContain("kcs")
  expect(rules.find((item: { name: string }) => item.name === "Heating safety").tags).toEqual(["safety"])
})

for (const failure of [403, 500, "network", "application"] as const) {
  test(`rejected native Settings import (${failure}) retains Settings and never reloads or reports success`, async ({ page }) => {
    await page.goto("/settings#backups-reset-settings")
    let requests = 0
    await page.route("**/api/import/settings", route => {
      ++requests
      return failure === "network" ? route.abort("failed") : route.fulfill({ status: typeof failure === "number" ? failure : 200, json: { success: false, error: "Synthetic rejected import" } })
    })
    let navigations = 0
    page.on("framenavigated", frame => { if (frame === page.mainFrame()) ++navigations })
    await page.locator("#import-settings-input").setInputFiles({ name: "settings.json", mimeType: "application/json", buffer: Buffer.from('{"theme":"light"}') })
    await expect(page.locator("#toast-container .toast.error")).not.toHaveCount(0)
    await page.waitForTimeout(1600)
    expect(navigations).toBe(0)
    expect(requests).toBe(1)
    await expect(page.locator("#import-settings-input")).not.toHaveValue("")
    await expect(page.locator("#toast-container .toast.success")).toHaveCount(0)
  })
}

for (const failure of ["http", "application", "network"] as const) {
  test(`framework wizard preserves its form and retry button after ${failure} failure`, async ({ page }) => {
    await page.goto("/settings#rules-lenses-settings")
    await page.locator("#fw-create-btn").click()
    await page.locator("#fw-name").fill("Household scoring")
    await page.locator('input[name="fw-archetype"][value="taxonomy"]').locator("..").click()
    await page.locator("#fw-next-btn").click()
    await page.locator("#fw-add-field").click()
    await page.locator("#fw-next-btn").click()
    await page.locator("#fw-next-btn").click()
    await page.route("**/api/frameworks", route => route.request().method() !== "POST" ? route.continue()
      : failure === "network" ? route.abort("failed")
      : route.fulfill({ status: failure === "http" ? 500 : 200, json: { ok: failure === "http", message: "Synthetic wizard failure" } }))
    await page.locator("#fw-save-btn").click()
    await expect(page.locator("#fw-wizard-errors")).toBeVisible()
    await expect(page.locator("#framework-wizard-dialog")).toBeVisible()
    await expect(page.locator("#fw-save-btn")).toBeEnabled()
    await expect(page.locator("#fw-name")).toHaveValue("Household scoring")
    await expect(page.locator("#toast-container .toast.success")).toHaveCount(0)
  })
}
