import { readFile } from "node:fs/promises"
import { expect, test } from "@playwright/test"
import { shouldSkipBrowserSpecs } from "./_helpers"

test.describe("Framework settings persistence", () => {
  test.skip(shouldSkipBrowserSpecs(), "Set E2E_BASE_URL for isolated framework tests")
  test.describe.configure({ mode: "serial" })
  test.use({ serviceWorkers: "block", extraHTTPHeaders: { "x-hass-is-admin": "true", "x-forwarded-for": `198.19.${process.pid % 255}.200` } })
  let clientSequence = 0
  test.beforeEach(async ({ context }) => {
    await context.setExtraHTTPHeaders({ "x-hass-is-admin": "true", "x-forwarded-for": `198.19.${process.pid % 255}.${++clientSequence}` })
  })

  test("invalid built-in overrides reject without changing saved configuration; valid patches preserve other fields", async ({ request }) => {
    await request.delete("/api/frameworks/rice", { data: {} })
    const first = { fields: { reach: { weight: 2, label: "Household reach", helpText: "People affected" } }, formula: "reach + impact", badgeThresholds: [{ min: 0, label: "Household", color: "bg-primary" }] }
    expect((await request.put("/api/frameworks/rice", { data: first })).ok()).toBeTruthy()
    expect((await request.put("/api/frameworks/rice", { data: { fields: { impact: { weight: 1.8 } } } })).ok()).toBeTruthy()
    const before = await (await request.get("/api/frameworks/rice")).json()
    expect(before.data.fields.find((f: { key: string }) => f.key === "reach")).toMatchObject(first.fields.reach)
    expect(before.data.fields.find((f: { key: string }) => f.key === "impact").weight).toBe(1.8)
    expect(before.data.formula).toBe(first.formula)
    for (const data of [
      { fields: [{ key: "reach", weight: 3 }] }, { fields: null }, { fields: { reach: null } },
      { fields: { reach: { weight: "2" } } }, { fields: { reach: { weight: -1 } } },
      { fields: { missing: { weight: 2 } } }, { fields: { reach: { label: "" } } },
      { fields: { reach: { type: "text" } } }, { formula: {} }, { badgeThresholds: [{ min: "bad", label: "Bad", color: "red" }] },
    ]) {
      expect((await request.put("/api/frameworks/rice", { data })).status()).toBe(400)
      expect(await (await request.get("/api/frameworks/rice")).json()).toEqual(before)
    }
    await request.delete("/api/frameworks/rice", { data: {} })
  })

  test("invalid settings-import framework overrides preserve settings, rules and existing overrides", async ({ request }) => {
    expect((await request.put("/api/frameworks/rice", { data: { fields: { reach: { weight: 1.9 } } } })).ok()).toBeTruthy()
    const beforeFramework = await (await request.get("/api/frameworks/rice")).json()
    const beforeSettings = await (await request.get("/api/settings")).json()
    const beforeRules = await (await request.get("/api/rules")).json()
    for (const frameworkOverrides of [
      [{ frameworkId: "rice", overrides: { fields: [{ key: "reach", weight: 3 }] } }],
      [{ frameworkId: "rice", overrides: { fields: { missing: { weight: 2 } } } }],
      [{ frameworkId: "rice", overrides: { fields: { reach: { weight: "bad" } } } }],
      { rice: {} },
    ]) {
      const response = await request.post("/api/import/settings", { data: { _version: 2, settings: { theme: "framework-test-must-not-save" }, rules: [], frameworkOverrides } })
      expect(response.status()).toBe(400)
      expect(await (await request.get("/api/frameworks/rice")).json()).toEqual(beforeFramework)
      expect(await (await request.get("/api/settings")).json()).toEqual(beforeSettings)
      expect(await (await request.get("/api/rules")).json()).toEqual(beforeRules)
    }
    await request.delete("/api/frameworks/rice", { data: {} })
  })

  test("an actual downloaded export restores weights, labels, formula, badges and custom frameworks after reset", async ({ page, request }) => {
    const customId = "truthfulness-round-trip"
    await request.delete(`/api/frameworks/${customId}`, { data: {} })
    const custom = { id: customId, name: "Household test", archetype: "taxonomy", source: "user", fields: [{ key: "category", label: "Category", type: "select", uiType: "select", weight: 1, helpText: "Choose a category" }], badgeThresholds: [] }
    expect((await request.post("/api/frameworks", { data: custom })).status()).toBe(201)
    try {
      const override = { fields: { reach: { weight: 2.3, label: "Household reach", helpText: "People affected" }, impact: { weight: 1.6 } }, formula: "reach + impact", badgeThresholds: [{ min: 0, label: "Household", color: "bg-primary" }] }
      expect((await request.put("/api/frameworks/rice", { data: override })).ok()).toBeTruthy()
      const before = (await (await request.get("/api/frameworks/rice")).json()).data
      await page.goto("/settings#rules-lenses-settings")
      const downloadEvent = page.waitForEvent("download")
      await page.locator("#rules-export-btn").click()
      const download = await downloadEvent
      const exported = await readFile((await download.path())!, "utf8")
      expect(JSON.parse(exported).frameworks.find((f: { id: string }) => f.id === "rice").fields.find((f: { key: string }) => f.key === "reach").weight).toBe(2.3)
      await page.locator("#framework-config-disclosure > summary").click()
      await page.locator('.rules-fw-reset[data-framework="rice"]').click()
      await page.locator("#confirm-ok").click()
      await expect.poll(async () => (await (await request.get("/api/frameworks/rice")).json()).hasOverrides).toBe(false)
      // Custom updates still accept the full fields array; importing should restore it.
      expect((await request.put(`/api/frameworks/${customId}`, { data: { name: "Changed", fields: [{ ...custom.fields[0], weight: 2 }] } })).ok()).toBeTruthy()
      await page.locator("#rules-import-input").setInputFiles({ name: "downloaded-rules.json", mimeType: "application/json", buffer: Buffer.from(exported) })
      await page.locator("#confirm-ok").click()
      await expect(page.locator("#rules-import-input")).toHaveValue("")
      const restored = (await (await request.get("/api/frameworks/rice")).json()).data
      expect(restored).toEqual(before)
      expect((await (await request.get(`/api/frameworks/${customId}`)).json()).data).toMatchObject(custom)
      // The same downloaded export must also recreate a missing custom framework.
      await request.delete(`/api/frameworks/${customId}`, { data: {} })
      await page.locator("#rules-import-input").setInputFiles({ name: "downloaded-rules.json", mimeType: "application/json", buffer: Buffer.from(exported) })
      await page.locator("#confirm-ok").click()
      await expect(page.locator("#rules-import-input")).toHaveValue("")
      expect((await (await request.get(`/api/frameworks/${customId}`)).json()).data).toMatchObject(custom)
      await expect(page.locator("#toast-container .toast.error")).toHaveCount(0)
    } finally {
      await request.delete(`/api/frameworks/${customId}`, { data: {} })
      await request.delete("/api/frameworks/rice", { data: {} })
    }
  })

  test("resetting one framework preserves a pending rule checkbox edit", async ({ page, request }) => {
    await request.put("/api/rules", { data: { rules: [] } })
    await page.goto("/settings#rules-lenses-settings")
    await page.locator("#framework-config-disclosure > summary").click()
    await expect(page.locator('.rules-fw-weight[data-framework="rice"][data-field="reach"]')).toBeVisible()
    await page.locator('.rules-fw-check[data-task-type="task"][data-framework="kcs"]').locator("..").click()
    await page.locator('.rules-fw-reset[data-framework="rice"]').click()
    await page.locator("#confirm-ok").click()
    await expect.poll(async () => (await (await request.get("/api/rules")).json()).data.find((r: { name: string }) => r.name === "Task Default")?.lensIds).toContain("kcs")
  })

  for (const replacement of ["defaults", "import", "framework reset"] as const) {
    test(`a held slider write finishes before ${replacement} and cannot restore stale overrides`, async ({ page, request }) => {
      await request.delete("/api/frameworks/rice", { data: {} })
      let releaseWrite!: () => void
      const heldWrite = new Promise<void>((resolve) => { releaseWrite = resolve })
      const writes: string[] = []
      await page.route("**/api/**", async (route) => {
        const path = new URL(route.request().url()).pathname
        if (route.request().method() === "GET" || !["/api/frameworks/rice", "/api/rules/defaults", "/api/rules"].includes(path)) return route.continue()
        writes.push(`${route.request().method()} ${path}`)
        if (writes.length === 1) await heldWrite
        return route.continue()
      })
      await page.goto("/settings#rules-lenses-settings")
      await page.locator("#framework-config-disclosure > summary").click()
      const slider = page.locator('.rules-fw-weight[data-framework="rice"][data-field="reach"]')
      await expect(slider).toHaveValue("1")
      await slider.press("End")
      await expect.poll(() => writes.length).toBe(1)
      if (replacement === "defaults") await page.locator("#rules-restore-defaults").click()
      else if (replacement === "framework reset") await page.locator('.rules-fw-reset[data-framework="rice"]').click()
      else await page.locator("#rules-import-input").setInputFiles({ name: "rules.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify({ rules: [], frameworks: [{ id: "rice", fields: { reach: { weight: 2.1 } } }] })) })
      await page.locator("#confirm-ok").click()
      await expect(slider).toBeDisabled()
      expect(writes).toEqual(["PUT /api/frameworks/rice"])
      releaseWrite()
      await expect.poll(() => writes.length).toBe(replacement === "import" ? 3 : 2)
      await expect(slider).toBeEnabled()
      await expect(slider).toHaveValue(replacement === "import" ? "2.1" : "1")
      const saved = await (await request.get("/api/frameworks/rice")).json()
      expect(saved.data.fields.find((f: { key: string }) => f.key === "reach").weight).toBe(replacement === "import" ? 2.1 : 1)
      expect(saved.hasOverrides).toBe(replacement === "import")
      await request.delete("/api/frameworks/rice", { data: {} })
    })
  }
  for (const action of ["navigate", "export"] as const) {
    test(`immediate ${action} flushes the visible rule edit before leaving or downloading`, async ({ page, request }) => {
      await request.put("/api/rules", { data: { rules: [
        { name: "Task Default", ruleType: "strategic-lens", taskTypes: ["task"], lensIds: ["rice"] },
        { name: "Heating safety", ruleType: "strategic-lens", taskTypes: ["task"], lensIds: ["ddd"], tags: ["safety"] },
      ] } })
      await page.goto("/settings#rules-lenses-settings")
      await expect(page.locator('.rules-fw-check[data-task-type="task"][data-framework="rice"]')).toBeChecked()
      const downloaded = action === "export" ? page.waitForEvent("download") : null
      await page.evaluate((action) => {
        const checkbox = document.querySelector<HTMLInputElement>('.rules-fw-check[data-task-type="task"][data-framework="kcs"]')!
        checkbox.checked = true
        checkbox.dispatchEvent(new Event("change", { bubbles: true }))
        if (action === "export") document.getElementById("rules-export-btn")!.click()
        else {
          const link = document.createElement("a")
          link.href = "/today"
          document.body.append(link)
          link.click()
        }
      }, action)
      if (downloaded) {
        const data = JSON.parse(await readFile((await (await downloaded).path())!, "utf8"))
        expect(data.rules.find((rule: { name: string }) => rule.name === "Task Default").lensIds).toEqual(expect.arrayContaining(["rice", "kcs"]))
      } else await expect(page).toHaveURL(/\/today$/)
      await expect.poll(async () => (await (await request.get("/api/rules")).json()).data.find((rule: { name: string }) => rule.name === "Task Default")?.lensIds).toEqual(expect.arrayContaining(["rice", "kcs"]))
      expect((await (await request.get("/api/rules")).json()).data.find((rule: { name: string }) => rule.name === "Heating safety").lensIds).toEqual(["ddd"])
    })
  }

  test("a rejected pending rule flush prevents export and preserves visible edits", async ({ page, request }) => {
    await request.put("/api/rules", { data: { rules: [] } })
    await page.goto("/settings#rules-lenses-settings")
    await expect(page.locator("#rules-export-btn")).toBeVisible()
    await page.route("**/api/rules", route => route.request().method() === "PUT"
      ? route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ ok: false, message: "Unavailable" }) })
      : route.continue())
    let downloads = 0
    page.on("download", () => { ++downloads })
    await page.evaluate(() => {
      const checkbox = document.querySelector<HTMLInputElement>('.rules-fw-check[data-task-type="task"][data-framework="kcs"]')!
      checkbox.checked = true
      checkbox.dispatchEvent(new Event("change", { bubbles: true }))
      document.getElementById("rules-export-btn")!.click()
    })
    await expect(page.locator("#toast-container .toast.error")).not.toHaveCount(0)
    expect(downloads).toBe(0)
    await expect(page.locator('.rules-fw-check[data-task-type="task"][data-framework="kcs"]')).toBeChecked()
    expect((await (await request.get("/api/rules")).json()).data).toEqual([])
  })

  test("framework read failure replaces loading and stale controls with recovery guidance", async ({ page }) => {
    await page.route("**/api/frameworks", route => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ ok: false }) }))
    await page.goto("/settings#rules-lenses-settings")
    await page.locator("#framework-config-disclosure > summary").click()
    await expect(page.locator('.rules-fw-config-fields[data-framework="rice"]')).toContainText("Reload this page to retry")
    await expect(page.locator(".rules-fw-weight")).toHaveCount(0)
  })

  test("navigation drains the latest edit queued behind an in-flight autosave", async ({ page, request }) => {
    await request.put("/api/rules", { data: { rules: [] } })
    await page.goto("/settings#rules-lenses-settings")
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    let writes = 0
    await page.route("**/api/rules", async route => {
      if (route.request().method() === "PUT" && ++writes === 1) await held
      await route.continue()
    })
    await page.locator('.rules-fw-check[data-task-type="task"][data-framework="kcs"]').locator("..").click()
    await expect.poll(() => writes).toBe(1)
    await page.evaluate(() => {
      const checkbox = document.querySelector<HTMLInputElement>('.rules-fw-check[data-task-type="task"][data-framework="rice"]')!
      checkbox.checked = true
      checkbox.dispatchEvent(new Event("change", { bubbles: true }))
      const link = document.createElement("a")
      link.href = "/today"
      document.body.append(link)
      link.click()
    })
    release()
    await expect(page).toHaveURL(/\/today$/)
    expect(writes).toBe(2)
    expect((await (await request.get("/api/rules")).json()).data.find((rule: { name: string }) => rule.name === "Task Default").lensIds).toEqual(expect.arrayContaining(["kcs", "rice"]))
  })

  test("rejected pending autosave retains Settings during navigation and permits retry", async ({ page, request }) => {
    await request.put("/api/rules", { data: { rules: [] } })
    await page.goto("/settings#rules-lenses-settings")
    await expect(page.locator("#rules-export-btn")).toBeVisible()
    await page.route("**/api/rules", route => route.request().method() === "PUT"
      ? route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ ok: false }) })
      : route.continue())
    await page.evaluate(() => {
      const checkbox = document.querySelector<HTMLInputElement>('.rules-fw-check[data-task-type="task"][data-framework="kcs"]')!
      checkbox.checked = true
      checkbox.dispatchEvent(new Event("change", { bubbles: true }))
      const link = document.createElement("a")
      link.href = "/today"
      document.body.append(link)
      link.click()
    })
    await expect(page.locator("#toast-container .toast.error")).not.toHaveCount(0)
    await expect(page).toHaveURL(/\/settings#rules-lenses-settings$/)
    await expect(page.locator('.rules-fw-check[data-task-type="task"][data-framework="kcs"]')).toBeChecked()
    await page.unroute("**/api/rules")
    // A visible change retries persistence; navigation then drains it normally.
    await page.evaluate(() => {
      document.querySelector('.rules-fw-check[data-task-type="task"][data-framework="kcs"]')!.dispatchEvent(new Event("change", { bubbles: true }))
      document.querySelector<HTMLAnchorElement>('a[href="/today"]')!.click()
    })
    await expect(page).toHaveURL(/\/today$/)
    expect((await (await request.get("/api/rules")).json()).data.find((rule: { name: string }) => rule.name === "Task Default").lensIds).toContain("kcs")
  })

  for (const status of [403, 503]) {
    test(`custom framework import refuses a failed lookup (${status}) rather than creating`, async ({ page, request }) => {
      const id = `import-lookup-refusal-${status}`
      await request.delete(`/api/frameworks/${id}`, { data: {} })
      await page.goto("/settings#rules-lenses-settings")
      let creates = 0
      let lookups = 0
      await page.route(`**/api/frameworks/${id}`, route => {
        ++lookups
        return route.fulfill({ status, contentType: "application/json", body: JSON.stringify({ ok: false, errorCode: "FRAMEWORK_NOT_FOUND" }) })
      })
      await page.route("**/api/frameworks", route => {
        if (route.request().method() === "POST") ++creates
        return route.continue()
      })
      await page.locator("#rules-import-input").setInputFiles({ name: "lookup-refusal.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify({ rules: [], customFrameworks: [{ id, name: "Fixture", archetype: "taxonomy", fields: [] }] })) })
      await page.locator("#confirm-ok").click()
      await expect(page.locator("#rules-import-input")).toHaveValue("")
      await expect(page.locator("#toast-container .toast.error")).not.toHaveCount(0)
      expect(lookups).toBe(1)
      expect(creates).toBe(0)
      expect((await request.get(`/api/frameworks/${id}`)).status()).toBe(404)
    })
  }

})
