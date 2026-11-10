import { DatabaseSync } from "node:sqlite"
import { fileURLToPath } from "node:url"
import { expect, test } from "@playwright/test"
import { shouldSkipBrowserSpecs } from "./_helpers"

test.describe("Settings and strategic rule persistence", () => {
  test.skip(shouldSkipBrowserSpecs(), "Set E2E_BASE_URL for isolated API tests")
  test.describe.configure({ mode: "serial" })

  // Each browser emulates a separate ingress client so asset/bootstrap requests
  // from this suite cannot exhaust another case's normal request budget.
  let clientSequence = 0
  test.beforeEach(async ({ context }) => {
    await context.setExtraHTTPHeaders({ "x-forwarded-for": `198.18.${process.pid % 255}.${++clientSequence}` })
  })

  const rule = (name: string) => ({ name, ruleType: "strategic-lens", taskTypes: ["task"], lensIds: [] })

  test("invalid replacements preserve all prior rules and scoped saves preserve custom rules", async ({ request }) => {
    const seeded = await request.put("/api/rules", { data: { rules: [rule("Task Default"), { ...rule("Heating safety"), tags: ["safety"] }] } })
    expect(seeded.ok()).toBeTruthy()
    const before = (await seeded.json()).data
    const invalid = await request.put("/api/rules", { data: { rules: [rule("Replacement"), { name: "", taskTypes: ["task"] }] } })
    expect(invalid.status()).toBe(400)
    expect((await (await request.get("/api/rules")).json()).data).toEqual(before.sort((a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name)))

    const result = await request.put("/api/rules", { data: { rules: [{ ...rule("Task Default"), lensIds: ["kcs"] }], replaceIds: [before.find((r: { name: string }) => r.name === "Task Default").id] } })
    expect(result.ok()).toBeTruthy()
    const after = (await (await request.get("/api/rules")).json()).data
    expect(after).toHaveLength(2)
    expect(after.find((r: { name: string }) => r.name === "Heating safety").tags).toEqual(["safety"])
    expect(after.find((r: { name: string }) => r.name === "Task Default").lensIds).toEqual(["kcs"])
  })

  test("an insert failure rolls back deletion of existing rules", async ({ request }) => {
    const dbUrl = process.env.MEITHEAL_TEST_DB_URL
    test.skip(!dbUrl, "Set MEITHEAL_TEST_DB_URL to the isolated dev server SQLite file")
    if (!dbUrl?.startsWith("file:/") || !dbUrl.includes("truthfulness")) throw new Error("Use an explicit isolated truthfulness test database")
    const before = (await (await request.get("/api/rules")).json()).data
    const db = new DatabaseSync(fileURLToPath(dbUrl))
    try {
      db.exec("CREATE TRIGGER truthfulness_reject_rule BEFORE INSERT ON rules WHEN NEW.name = 'Reject this rule' BEGIN SELECT RAISE(ABORT, 'injected insert failure'); END")
      const response = await request.put("/api/rules", { data: { rules: [rule("Reject this rule")] } })
      expect(response.status()).toBe(500)
      expect((await (await request.get("/api/rules")).json()).data).toEqual(before)
    } finally {
      db.exec("DROP TRIGGER IF EXISTS truthfulness_reject_rule")
      db.close()
    }
  })

  test("secret settings are acknowledged without exposing saved values", async ({ request }) => {
    const response = await request.put("/api/settings", { data: { key: "truthfulness_test_secret", value: "synthetic-fixture-only" } })
    expect(response.ok()).toBeTruthy()
    expect((await response.json()).value).toBeNull()
    const single = await (await request.get("/api/settings?key=truthfulness_test_secret")).json()
    expect(single).toMatchObject({ value: null, configured: true })
    const all = await (await request.get("/api/settings")).json()
    expect(all.truthfulness_test_secret).toBeNull()
    expect(all.truthfulness_test_secret_configured).toBe(true)
  })

  for (const failure of [403, 500, "network"] as const) {
    test(`shared save recovers from ${failure} without a success toast`, async ({ page }) => {
      await page.goto("/settings#automation-ai-settings")
      await page.route("**/api/settings", async (route) => {
        if (route.request().method() !== "PUT") return route.continue()
        if (failure === "network") return route.abort("failed")
        return route.fulfill({ status: failure, json: { error: "Synthetic rejected save" } })
      })
      await page.locator("#save-ai").click()
      await expect(page.getByText("Could not save changes. Your edits are still here; try again.").first()).toBeVisible()
      await expect(page.locator("#save-ai")).toBeEnabled()
      await expect(page.getByText("AI settings saved", { exact: true })).toHaveCount(0)
    })
  }

  test("rule changes during an in-flight save are saved in order", async ({ page }) => {
    const writes: Array<{ rules: Array<{ taskTypes: string[]; lensIds: string[] }>; replaceIds: string[] }> = []
    await page.route("**/api/rules", async (route) => {
      if (route.request().method() === "GET") {
        return route.fulfill({ json: { ok: true, data: [{ id: "old-default", ...rule("Task Default"), tags: [], aiScope: {} }] } })
      }
      writes.push(route.request().postDataJSON())
      const sequence = writes.length
      await new Promise((resolve) => setTimeout(resolve, 750))
      return route.fulfill({ json: { ok: true, data: writes[sequence - 1]!.rules.map((r, i) => ({ ...r, id: `saved-${sequence}-${i}` })) } })
    })
    await page.goto("/settings#rules-lenses-settings")
    await page.locator('.rules-fw-check[data-task-type="task"][data-framework="kcs"]').locator("..").click()
    await expect.poll(() => writes.length).toBe(1)
    await page.locator('.rules-fw-check[data-task-type="task"][data-framework="rice"]').locator("..").click()
    await expect.poll(() => writes.length).toBe(2)
    expect(writes[0]!.replaceIds).toEqual(["old-default"])
    expect(writes[1]!.replaceIds).toEqual(["saved-1-0", "saved-1-1", "saved-1-2", "saved-1-3"])
    expect(writes[1]!.rules.find((r) => r.taskTypes[0] === "task")?.lensIds).toEqual(expect.arrayContaining(["kcs", "rice"]))
  })

  for (const replacement of ["preset", "defaults", "import"] as const) {
    test(`${replacement} waits for delayed autosave and subsequent edits use replacement IDs`, async ({ page, request }) => {
      await request.put("/api/rules", { data: { rules: [rule("Task Default")] } })
      let releaseSave!: () => void
      const heldSave = new Promise<void>((resolve) => { releaseSave = resolve })
      const mutations: Array<{ path: string; body: { replaceIds?: string[] } }> = []
      await page.route("**/api/rules{,/defaults}", async (route) => {
        if (route.request().method() === "GET") return route.continue()
        mutations.push({ path: new URL(route.request().url()).pathname, body: route.request().postDataJSON() ?? {} })
        if (mutations.length === 1) await heldSave
        return route.continue()
      })
      await page.goto("/settings#rules-lenses-settings")
      const taskKcs = page.locator('.rules-fw-check[data-task-type="task"][data-framework="kcs"]')
      await taskKcs.locator("..").click()
      await expect.poll(() => mutations.length).toBe(1)
      if (replacement === "preset") {
        await page.locator('.rules-preset-btn[data-preset="balanced"]').click()
      } else if (replacement === "defaults") {
        await page.locator("#rules-restore-defaults").click()
      } else {
        await page.locator("#rules-import-input").setInputFiles({ name: "rules.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify({ rules: [{ ...rule("Task Default"), lensIds: ["rice"] }] })) })
      }
      await page.locator("#confirm-ok").click()
      await expect(taskKcs).toBeDisabled()
      expect(mutations).toHaveLength(1)
      releaseSave()
      await expect.poll(() => mutations.length).toBe(2)
      await expect(taskKcs).toBeEnabled()
      await expect(taskKcs).not.toBeChecked()
      const replaced = (await (await request.get("/api/rules")).json()).data as Array<{ id: string; name: string }>
      await taskKcs.locator("..").click()
      await expect.poll(() => mutations.length).toBe(3)
      await expect.poll(async () => (await (await request.get("/api/rules")).json()).data.find((r: { name: string }) => r.name === "Task Default")?.lensIds).toContain("kcs")
      expect(mutations[2]!.body.replaceIds?.sort()).toEqual(replaced.map((r) => r.id).sort())
      const saved = (await (await request.get("/api/rules")).json()).data as Array<{ name: string }>
      expect(saved).toHaveLength(4)
      expect(saved.filter((r) => r.name === "Task Default")).toHaveLength(1)
    })
  }

  test("partial framework import failure refreshes rule IDs before the next checkbox save", async ({ page, request }) => {
    await request.put("/api/rules", { data: { rules: [rule("Task Default")] } })
    await page.route("**/api/frameworks/rice", async (route) => {
      if (route.request().method() !== "PUT") return route.continue()
      return route.fulfill({ status: 500, json: { ok: false, message: "Synthetic framework failure" } })
    })
    await page.goto("/settings#rules-lenses-settings")
    const taskKcs = page.locator('.rules-fw-check[data-task-type="task"][data-framework="kcs"]')
    await expect(taskKcs).toBeEnabled()
    await page.locator("#rules-import-input").setInputFiles({ name: "rules.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify({
      rules: [{ ...rule("Task Default"), lensIds: ["rice"] }, { ...rule("Keep custom"), tags: ["custom"] }],
      frameworks: [{ id: "rice", fields: { reach: { weight: 2 } } }],
    })) })
    await page.locator("#confirm-ok").click()
    await expect(page.getByText("Rules were imported, but a framework update failed. Review the configuration before retrying.")).toBeVisible()
    await expect(page.getByText("Rules imported successfully", { exact: true })).toHaveCount(0)
    await expect(taskKcs).toBeEnabled()
    await taskKcs.locator("..").click()
    await expect.poll(async () => (await (await request.get("/api/rules")).json()).data.find((r: { name: string }) => r.name === "Task Default")?.lensIds).toEqual(expect.arrayContaining(["rice", "kcs"]))
    const saved = (await (await request.get("/api/rules")).json()).data as Array<{ name: string; tags: string[] }>
    expect(saved).toHaveLength(5)
    expect(saved.filter((r) => r.name === "Task Default")).toHaveLength(1)
    expect(saved.find((r) => r.name === "Keep custom")?.tags).toEqual(["custom"])
  })

  test("supported protocol preferences persist independently and report enabled count", async ({ page, request }) => {
    for (const key of ["agent-protocols-a2a-enabled", "agent-protocols-webmcp-enabled"]) {
      await request.put("/api/settings", { data: { key, value: true } })
    }
    await request.put("/api/settings", { data: { key: "agent-protocols-mcp-enabled", value: false } })
    const writes: Array<{ key: string; value: unknown }> = []
    await page.route("**/api/settings", async (route) => {
      if (route.request().method() === "PUT") writes.push(route.request().postDataJSON())
      return route.continue()
    })
    await page.goto("/settings#automation-ai-settings")
    await expect(page.locator("#agent-protocols-status")).toHaveText("2 protocols enabled")
    for (const id of ["agent-a2a-enabled", "agent-webmcp-enabled"]) {
      await expect(page.locator(`#${id}`)).toBeEnabled()
      await expect(page.locator(`#${id}`)).toBeChecked()
    }
    await page.locator("#agent-mcp-enabled").check()
    await page.locator("#save-agent-protocols").click()
    await expect(page.locator("#agent-protocols-status")).toHaveText("3 protocols enabled")
    expect(writes).toEqual([{ key: "agent-protocols-a2a-enabled", value: true }, { key: "agent-protocols-mcp-enabled", value: true }, { key: "agent-protocols-webmcp-enabled", value: true }])
  })

  test("repeated page-load setup emits one feedback toast per acknowledged raw save", async ({ page }) => {
    await page.goto("/settings#general-settings")
    await page.evaluate(() => {
      document.dispatchEvent(new Event("astro:page-load"))
      document.dispatchEvent(new Event("astro:page-load"))
    })
    await page.locator("#save-backlog-mode").click()
    await expect(page.getByText("Backlog mode saved — reload Kanban to apply", { exact: true })).toHaveCount(1)
  })

})
