import { expect } from "@playwright/test"
import { test } from "../scripts/settings-persistence-fixture"

test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires the built App and disposable authenticated fixture")

for (const enabled of [false, true]) {
  test(`Today quick capture ${enabled ? "extracts metadata" : "preserves literal input"} when smart parsing is ${enabled ? "enabled" : "disabled"}`, async ({ page, request }) => {
    await page.clock.setFixedTime(new Date("2030-06-10T12:00:00.000Z"))
    await page.goto("/today")
    const headers = { origin: new URL(page.url()).origin }
    const originalResponse = await request.get("/api/settings?key=feature_nlp_parser", { headers })
    expect(originalResponse.status()).toBe(200)
    const original = await originalResponse.json()
    let originalValue: unknown = original.value ?? true
    if (typeof originalValue === "string") {
      try { originalValue = JSON.parse(originalValue) } catch { /* Preserve legacy text if present. */ }
    }
    let id: string | undefined
    try {
      expect((await request.put("/api/settings", { headers, data: { key: "feature_nlp_parser", value: enabled } })).status()).toBe(200)
      await expect.poll(async () => {
        await page.reload()
        return page.evaluate(() => window.__featureFlags?.nlp_parser)
      }).toBe(enabled)
      const input = page.locator("#quick-add-input")
      const preview = page.locator("#quick-add-feedback")
      const title = `Capture fixture ${crypto.randomUUID()}`
      const literal = `${title} tomorrow p1 #household @ryan`
      const posts: unknown[] = []
      page.on("request", request => {
        if (request.method() === "POST" && new URL(request.url()).pathname.endsWith("/api/tasks")) posts.push(request.postDataJSON())
      })
      await page.evaluate(() => {
        sessionStorage.setItem("nlp-created-events", "0")
        document.addEventListener("meitheal:tasks-changed", event => {
          if ((event as CustomEvent).detail?.action === "today-quick-add") {
            sessionStorage.setItem("nlp-created-events", String(Number(sessionStorage.getItem("nlp-created-events")) + 1))
          }
        }, { signal: AbortSignal.timeout(30_000) })
      })
      await expect(input).toBeVisible()
      await input.fill(literal)
      await expect(preview).toBeVisible()
      if (enabled) {
        await expect(preview).toHaveText("📅 Due: 2030-06-11 · 🔴 Priority: P1 · 🏷️ household · 👤 ryan")
      } else {
        // Soft assertions preserve both preview and submit evidence on the old
        // controller; any mismatch still fails the test.
        await expect.soft(preview).toHaveText("📅 Due: Today (default)")
      }
      expect(posts).toHaveLength(0)
      const submitted = page.waitForResponse(response => response.request().method() === "POST" &&
        new URL(response.url()).pathname.endsWith("/api/tasks"))
      await page.locator("#quick-add-form button[type=submit]").click()
      const response = await submitted
      expect(response.status()).toBe(201)
      const payload = posts[0]
      // Today's existing tasks-changed lifecycle may reload immediately after
      // success. Read persistence independently instead of racing CDP body lookup.
      const inventory = await request.get(`/api/tasks?q=${encodeURIComponent(title)}&limit=10`, { headers })
      expect(inventory.status()).toBe(200)
      const { tasks, total } = await inventory.json()
      expect(total).toBe(1)
      expect(typeof tasks[0].id).toBe("string")
      id = tasks[0].id
      const persisted = await request.get(`/api/tasks/${id}`, { headers })
      expect(persisted.status()).toBe(200)
      const saved = await persisted.json()
      if (enabled) {
        expect(payload).toMatchObject({ title, due_date: "2030-06-11", priority: 1, labels: '["household"]', assigned_to: "ryan" })
        expect(saved).toMatchObject({ title, due_date: "2030-06-11", priority: 1, labels: '["household"]', assigned_to: "ryan" })
      } else {
        expect.soft(payload).toMatchObject({ title: literal, due_date: "2030-06-10" })
        for (const key of ["priority", "labels", "assigned_to"]) expect.soft(payload).not.toHaveProperty(key)
        expect.soft(saved).toMatchObject({ title: literal, due_date: "2030-06-10", priority: 3, labels: "[]", assigned_to: null })
      }
      expect(posts).toHaveLength(1)
      await expect(input).toHaveValue("")
      await expect(preview).toBeHidden()
      await expect.poll(() => page.evaluate(() => Number(sessionStorage.getItem("nlp-created-events")))).toBe(1)
    } finally {
      if (id) expect((await request.delete(`/api/tasks/${id}`, { headers, data: {} })).status()).toBe(204)
      expect((await request.put("/api/settings", { headers, data: { key: "feature_nlp_parser", value: originalValue } })).status()).toBe(200)
    }
  })
}
