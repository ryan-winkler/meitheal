import { expect, test } from "@playwright/test"
import { shouldSkipBrowserSpecs } from "./_helpers"

test.skip(shouldSkipBrowserSpecs(), "Requires a disposable local Astro server")
test.use({ serviceWorkers: "block" })

for (const action of ["review", "complete-q4", "triage"] as const) {
  test(`repeated page loads keep one ${action} task mutation`, async ({ page, request, baseURL }) => {
    const created = await request.post("/api/tasks", { data: {
      title: `Eisenhower lifecycle ${action}`,
      urgency: action === "triage" ? 0 : 1, importance: action === "triage" ? 0 : 1,
    } })
    expect(created.status(), await created.text()).toBe(201)
    const task = await created.json()
    const taskPath = `/api/tasks/${task.id}`
    const statusWrites: string[] = []
    let reviewWrites = 0
    let triageWrites = 0
    try {
      await page.route(`**${taskPath}`, async route => {
        if (route.request().method() === "PUT") {
          const payload = route.request().postDataJSON()
          if (payload.status) statusWrites.push(payload.status)
          if (payload.framework_payload) reviewWrites++
          if (payload.urgency === 4 && payload.importance === 5) triageWrites++
        }
        await route.continue()
      })
      await page.goto("/eisenhower")
      await expect(page.locator("[data-quadrant-tabs-ready]")).toBeAttached()
      const card = page.locator(`[data-drop-zone="not-now"] .tli[data-id="${task.id}"]`)
      await expect(card).toBeVisible()
      await page.evaluate(() => {
        document.dispatchEvent(new Event("astro:page-load"))
        document.dispatchEvent(new Event("astro:page-load"))
      })
      if (action === "review") {
        await page.locator('[data-action="start-review"]').click()
        await expect(page.locator("#review-overlay")).toBeVisible()
        await page.locator('[data-action="review-archive"]').click()
        await expect(page.locator("#review-overlay")).toBeHidden()
        await expect.poll(() => reviewWrites).toBe(1)
      } else if (action === "triage") {
        await page.locator('[data-action="start-triage"]').click()
        await expect(page.locator("#triage-overlay")).toBeVisible()
        await expect(page.locator("#triage-task-name")).toHaveText(task.title)
        await page.locator("#triage-urgency").fill("4")
        await page.locator("#triage-importance").fill("5")
        await page.locator('[data-action="triage-save"]').click()
        await expect(page.locator("#triage-overlay")).toBeHidden()
        const saved = await (await request.get(taskPath)).json()
        expect(saved).toMatchObject({ urgency: 4, importance: 5 })
        expect(triageWrites).toBe(1)
        expect(statusWrites).toEqual([])
        return
      } else {
        await page.locator('[data-action="complete-q4"]').click()
        await expect(card).toHaveCount(0)
      }
      await expect.poll(async () => (await (await request.get(taskPath)).json()).status).toBe("complete")
      expect(statusWrites).toEqual(["complete"])
    } finally {
      const removed = await request.delete(taskPath, { headers: { origin: new URL(baseURL!).origin }, data: {} })
      expect(removed.status()).toBe(204)
    }
  })
}

test("aborted page ownership retires actions and review listeners before the next setup", async ({ page, request, baseURL }) => {
  const created = await request.post("/api/tasks", { data: {
    title: "Eisenhower lifecycle navigation", urgency: 1, importance: 1,
  } })
  expect(created.status(), await created.text()).toBe(201)
  const task = await created.json()
  const taskPath = `/api/tasks/${task.id}`
  const statusWrites: string[] = []
  try {
    await page.route(`**${taskPath}`, async route => {
      if (route.request().method() === "PUT" && route.request().postDataJSON().status) {
        statusWrites.push(route.request().postDataJSON().status)
      }
      await route.continue()
    })
    await page.goto("/eisenhower")
    await expect(page.locator("[data-quadrant-tabs-ready]")).toBeAttached()
    await page.locator('[data-action="start-review"]').click()
    await expect(page.locator("#review-overlay")).toBeVisible()
    await page.evaluate(() => document.dispatchEvent(new Event("astro:before-swap")))
    await page.keyboard.press("Escape")
    await expect(page.locator("#review-overlay")).toBeVisible()
    await page.locator('[data-action="close-review"]').click()
    await expect(page.locator("#review-overlay")).toBeVisible()
    expect(statusWrites).toEqual([])
    await page.evaluate(() => {
      document.dispatchEvent(new Event("astro:page-load"))
      document.dispatchEvent(new Event("astro:page-load"))
    })
    await page.keyboard.press("Escape")
    await expect(page.locator("#review-overlay")).toBeHidden()
    await page.locator('[data-action="complete-q4"]').click()
    await expect(page.locator(`.tli[data-id="${task.id}"]`)).toHaveCount(0)
    expect(statusWrites).toEqual(["complete"])
  } finally {
    const removed = await request.delete(taskPath, { headers: { origin: new URL(baseURL!).origin }, data: {} })
    expect(removed.status()).toBe(204)
  }
})

for (const [action, otherAction, status] of [
  ["complete-q4", "defer-q4", "complete"],
  ["defer-q4", "complete-q4", "backlog"],
] as const) {
  test(`Q4 ${status} keeps unconfirmed tasks visible and retries only those tasks`, async ({ page, request, baseURL }) => {
    const headers = { origin: new URL(baseURL!).origin }
    const ids: string[] = []
    const writes: Array<{ id: string; status: string }> = []
    let reject = true
    let release: (() => void) | undefined
    try {
      for (const result of ["accepted", "rejected"]) {
        const response = await request.post("/api/tasks", { headers, data: {
          title: `Q4 ${status} ${result}`, urgency: 1, importance: 1,
        } })
        expect(response.status(), await response.text()).toBe(201)
        ids.push((await response.json()).id)
      }
      const [accepted, rejected] = ids
      await page.route("**/api/tasks/*", async route => {
        const id = new URL(route.request().url()).pathname.split("/").pop() ?? ""
        if (!ids.includes(id) || route.request().method() !== "PUT") return route.continue()
        writes.push({ id, status: route.request().postDataJSON().status })
        if (writes.length === 1) await new Promise<void>(resolve => { release = resolve })
        if (reject && id === rejected) return route.fulfill({ status: 503, json: { error: "Write rejected" } })
        return route.continue()
      })
      await page.goto("/eisenhower")
      await expect(page.locator("[data-quadrant-tabs-ready]")).toBeAttached()
      const quadrant = page.locator('[data-quadrant="not-now"]')
      const button = quadrant.locator(`[data-action="${action}"]`)
      const other = quadrant.locator(`[data-action="${otherAction}"]`)
      const acceptedRow = quadrant.locator(`.tli[data-id="${accepted}"]`)
      const rejectedRow = quadrant.locator(`.tli[data-id="${rejected}"]`)
      const tabCount = page.locator('[aria-controls="eisenhower-quadrant-not-now"] .mobile-tab__count')
      const expectChanged = async (row: typeof acceptedRow) => {
        if (status === "complete") {
          await expect(row).toHaveCount(0)
        } else {
          await expect(row).toHaveAttribute("data-status", "backlog")
          await expect(row.locator(".status-badge")).toHaveAttribute("data-badge-status", "backlog")
          await expect(row.locator(".status-badge")).toHaveText("Backlog")
        }
      }
      await expect(acceptedRow).toBeVisible()
      await expect(rejectedRow).toBeVisible()
      await button.focus()
      await page.keyboard.press("Enter")
      await expect.poll(() => Boolean(release)).toBe(true)
      await expect(button).toBeFocused()
      await expect(other).toBeDisabled()
      await page.keyboard.press("Enter")
      await other.evaluate((element: HTMLButtonElement) => element.click())
      release?.()

      await expectChanged(acceptedRow)
      await expect(rejectedRow).toHaveAttribute("data-status", "pending")
      const mixedCount = status === "complete" ? "1" : "2"
      await expect(quadrant.locator(".quadrant__count")).toHaveText(mixedCount)
      await expect(tabCount).toHaveText(mixedCount)
      await expect(page.getByText("Saved changes for 1 of 2 tasks. Check the remaining tasks before retrying.")).toBeVisible()
      await expect(button).toBeFocused()
      expect(await (await request.get(`/api/tasks/${accepted}`)).json()).toMatchObject({ status })
      expect(await (await request.get(`/api/tasks/${rejected}`)).json()).toMatchObject({ status: "pending" })
      expect(writes.map(write => write.id).sort()).toEqual([...ids].sort())
      expect(writes.every(write => write.status === status)).toBe(true)

      reject = false
      await page.keyboard.press("Enter")
      await expectChanged(rejectedRow)
      await expect(tabCount).toHaveText(status === "complete" ? "0" : "2")
      expect(writes.slice(2)).toEqual([{ id: rejected, status }])
      expect(await (await request.get(`/api/tasks/${rejected}`)).json()).toMatchObject({ status })

      await page.reload()
      await expectChanged(acceptedRow)
      await expectChanged(rejectedRow)
      if (status === "complete") await expect(quadrant.locator(".quadrant__empty")).toBeVisible()
    } finally {
      release?.()
      for (const id of ids) {
        const removed = await request.delete(`/api/tasks/${id}`, { headers, data: {} })
        expect(removed.status()).toBe(204)
      }
    }
  })
}

for (const [action, quadrantName, urgency, importance, field, value] of [
  ["commit-q1", "do-first", 5, 5, "due_date", "2026-11-11"],
  ["schedule-q2", "schedule", 1, 5, "due_date", "2026-11-15"],
  ["assign-q3", "delegate", 5, 1, "assigned_to", "Eisenhower fixture assignee"],
] as const) {
  test(`${action} distinguishes a failed batch from a mixed result`, async ({ page, request, baseURL }) => {
    const headers = { origin: new URL(baseURL!).origin }
    const ids: string[] = []
    let rejectAll = true
    try {
      for (const result of ["accepted", "rejected"]) {
        const response = await request.post("/api/tasks", { headers, data: {
          title: `${action} ${result}`, urgency, importance,
        } })
        expect(response.status(), await response.text()).toBe(201)
        ids.push((await response.json()).id)
      }
      const [accepted, rejected] = ids
      await page.route("**/api/tasks/*", route => {
        const id = new URL(route.request().url()).pathname.split("/").pop() ?? ""
        if (route.request().method() === "PUT" && (id === rejected || (id === accepted && rejectAll))) {
          return route.fulfill({ status: 503, json: { error: "Write rejected" } })
        }
        return route.continue()
      })
      await page.clock.setFixedTime(new Date("2026-11-11T12:00:00Z"))
      await page.goto("/eisenhower")
      await expect(page.locator("[data-quadrant-tabs-ready]")).toBeAttached()
      const quadrant = page.locator(`[data-quadrant="${quadrantName}"]`)
      const button = quadrant.locator(`[data-action="${action}"]`)
      const runAction = async () => {
        await button.click()
        if (action === "assign-q3") {
          await page.locator("#prompt-input").fill(`  ${value}  `)
          await page.locator("#prompt-ok").click()
        }
      }
      await runAction()
      await expect(page.getByText("Couldn’t confirm the changes. Check the selected tasks before retrying.")).toBeVisible()
      expect(await (await request.get(`/api/tasks/${accepted}`)).json()).toMatchObject({ [field]: null })
      rejectAll = false
      await runAction()
      await expect(page.getByText("Saved changes for 1 of 2 tasks. Check the remaining tasks before retrying.")).toBeVisible()
      await expect(quadrant.locator(`.tli[data-id="${accepted}"]`)).toBeVisible()
      await expect(quadrant.locator(`.tli[data-id="${rejected}"]`)).toBeVisible()
      expect(await (await request.get(`/api/tasks/${accepted}`)).json()).toMatchObject({ [field]: value })
      expect(await (await request.get(`/api/tasks/${rejected}`)).json()).toMatchObject({ [field]: null })
    } finally {
      for (const id of ids) {
        const removed = await request.delete(`/api/tasks/${id}`, { headers, data: {} })
        expect(removed.status()).toBe(204)
      }
    }
  })
}
