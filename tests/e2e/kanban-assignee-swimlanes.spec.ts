import { randomUUID } from "node:crypto"

import { expect, test } from "@playwright/test"

test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires the disposable Meitheal fixture")
test.use({ serviceWorkers: "block" })

test("Household Kanban keeps distinct assignees through roster recovery and quick unassignment", async ({
  page, request, baseURL,
}) => {
  const origin = new URL(baseURL!).origin
  const headers = { origin, "content-type": "application/json" }
  const prefix = `Assignee grouping ${randomUUID().slice(0, 8)}`
  const haUser = { id: "ha_0123456789abcdef0123456789abcdef", name: "Alex Home" }
  const otherHaUser = { id: "ha_fedcba9876543210fedcba9876543210", name: "Jordan Home" }
  const localUser = { id: "custom_grouping_fixture", name: haUser.name }
  const taskIds: string[] = []
  let verified = false

  await page.route("**/api/users", route => route.fulfill({ json: {
    users: verified ? [haUser, otherHaUser, localUser] : [localUser],
    ha_connected: true,
    ha_roster_verified: verified,
  } }))

  async function createTask(label: string, assigned: string | null) {
    const response = await request.post("/api/tasks", {
      headers,
      data: { title: `${prefix} ${label}`, status: "pending", assigned_to: assigned },
    })
    expect(response.status(), await response.text()).toBe(201)
    const { id } = await response.json() as { id: string }
    taskIds.push(id)
    return id
  }

  try {
    const haTask = await createTask("Home Assistant", haUser.id)
    const otherHaTask = await createTask("Second household member", otherHaUser.id)
    const localTask = await createTask("Local assignee", localUser.id)
    const unassignedTask = await createTask("Unassigned task", null)
    const reservedTask = await createTask("Stored legacy assignee", "__unassigned__")
    const cardCount = taskIds.length
    await page.goto(`/tasks?search=${encodeURIComponent(prefix)}#kanban`)
    await expect(page.locator("#kanban-shell")).toHaveAttribute("data-kanban-booted", "true")

    const lane = page.locator('.kanban-column[data-status="pending"]')
    const cards = lane.locator(".kanban-card")
    const groups = lane.locator(".dynamic-group:not([hidden])")
    const cardSelector = (id: string) => `.kanban-card[data-id="${id}"]`
    const group = (id: string) => groups.filter({ has: page.locator(cardSelector(id)) })
    const heading = (id: string) => group(id).locator("button.swimlane-header")
    const label = (id: string) => group(id).locator(".swimlane-label")
    await expect(cards).toHaveCount(cardCount)
    const laneTotal = await lane.getAttribute("data-total")
    expect(laneTotal).toBeTruthy()
    await expect(lane.locator(".kanban-count")).toHaveText(String(cardCount))

    const picker = page.locator("#kanban-group-by-dropdown")
    await picker.locator("summary").click()
    await picker.getByRole("button", { name: "By Assignee", exact: true }).click()
    await expect(page).toHaveURL(url => url.searchParams.get("groupBy") === "assigned")
    await expect(groups).toHaveCount(cardCount)
    for (const id of taskIds) {
      await expect(group(id)).toHaveCount(1)
      await expect(group(id).locator(".swimlane-count")).toHaveText("1")
    }
    for (const [taskId, assigneeId] of [[haTask, haUser.id], [otherHaTask, otherHaUser.id]] as const) {
      await expect(label(taskId)).toContainText("Home Assistant assignee not verified")
      await expect(group(taskId)).not.toContainText(assigneeId)
      await expect(heading(taskId)).not.toHaveAccessibleName(new RegExp(assigneeId))
      const titles = await group(taskId).locator("[title]").evaluateAll(elements =>
        elements.map(element => element.getAttribute("title")).join(" "),
      )
      expect(titles).not.toContain(assigneeId)
    }
    expect(new Set(await Promise.all([label(haTask).textContent(), label(otherHaTask).textContent()])))
      .toEqual(new Set(["Home Assistant assignee not verified (1)", "Home Assistant assignee not verified (2)"]))
    await expect(label(localTask)).toHaveText(localUser.name)
    await expect(label(unassignedTask)).toHaveText("Unassigned")
    await expect(label(reservedTask)).toHaveText("Assignee unavailable")
    const haGroupKey = await group(haTask).getAttribute("data-swimlane-type")
    expect(haGroupKey).toBeTruthy()
    expect(await group(otherHaTask).getAttribute("data-swimlane-type")).not.toBe(haGroupKey)

    const haCards = group(haTask).locator(".swimlane-cards")
    await expect(haCards).toHaveAttribute("id", /\S/)
    await expect(heading(haTask)).toHaveAttribute("aria-controls", (await haCards.getAttribute("id"))!)
    await heading(haTask).press("Enter")
    await expect(heading(haTask)).toHaveAttribute("aria-expanded", "false")
    await expect(haCards).toBeHidden()
    await expect(heading(otherHaTask)).toHaveAttribute("aria-expanded", "true")

    verified = true
    const preRefreshHeader = await heading(haTask).elementHandle()
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })))
    await expect.poll(() => preRefreshHeader!.evaluate(element => element.isConnected)).toBe(false)
    await expect(label(haTask)).toContainText(haUser.name)
    await expect(label(otherHaTask)).toHaveText(otherHaUser.name)
    await expect(label(localTask)).toContainText(localUser.name)
    expect(new Set(await Promise.all([label(haTask).textContent(), label(localTask).textContent()])))
      .toEqual(new Set([`${haUser.name} (1)`, `${haUser.name} (2)`]))
    await expect(heading(haTask)).toHaveAccessibleName(/Alex Home \([12]\)/)
    await expect(heading(localTask)).toHaveAccessibleName(/Alex Home \([12]\)/)
    await expect(groups).toHaveCount(cardCount)
    await expect(group(haTask)).toHaveAttribute("data-swimlane-type", haGroupKey!)
    await expect(heading(haTask)).toHaveAttribute("aria-expanded", "false")
    await expect(haCards).toBeHidden()
    await expect(heading(localTask)).toHaveAttribute("aria-expanded", "true")
    await expect(heading(haTask)).toBeFocused()
    await heading(haTask).press("Space")
    await expect(haCards).toBeVisible()

    await heading(unassignedTask).press("Enter")
    await expect(heading(unassignedTask)).toHaveAttribute("aria-expanded", "false")
    await lane.locator(cardSelector(haTask)).locator(".card-assign-btn").press("Enter")
    const assignDialog = page.getByRole("dialog", { name: "Assign User" })
    const write = page.waitForResponse(response => response.request().method() === "PUT" &&
      new URL(response.url()).pathname === `/api/tasks/${haTask}`)
    await assignDialog.getByRole("menuitem", { name: "Unassigned", exact: true }).press("Enter")
    const result = await write
    expect(result.ok()).toBe(true)
    expect(result.request().postDataJSON()).toEqual({ assigned_to: null })

    await expect(assignDialog).toBeHidden()
    await expect(groups).toHaveCount(cardCount - 1)
    const moved = group(unassignedTask).locator(cardSelector(haTask))
    await expect(moved).toHaveCount(1)
    await expect(moved).toBeHidden()
    await expect(heading(unassignedTask)).toBeFocused()
    await heading(unassignedTask).press("Space")
    await expect(moved).toBeVisible()
    await expect(group(unassignedTask).locator(".swimlane-count")).toHaveText("2")
    await expect(group(otherHaTask).locator(".swimlane-count")).toHaveText("1")
    await expect(group(localTask).locator(".swimlane-count")).toHaveText("1")
    await expect(group(reservedTask).locator(".swimlane-count")).toHaveText("1")
    await expect(cards).toHaveCount(cardCount)
    await expect(lane.locator(".kanban-count")).toHaveText(String(cardCount))
    await expect(lane).toHaveAttribute("data-total", laneTotal!)

    verified = false
    await page.context().addCookies([{ name: "meitheal-locale", value: "ga", url: origin }])
    await page.reload()
    await expect(page).toHaveURL(url => url.searchParams.get("groupBy") === "assigned")
    await expect(label(otherHaTask)).toHaveText("Níor fíoraíodh sannaí Home Assistant")
    await expect(label(reservedTask)).toHaveText("Níl an sannaí ar fáil")
    await expect(label(unassignedTask)).toHaveText("Gan Sannta")
    await expect(group(unassignedTask).locator(cardSelector(haTask))).toBeVisible()

    const removedHeader = await heading(localTask).elementHandle()
    await heading(localTask).focus()
    expect((await request.put(`/api/tasks/${localTask}`, { headers, data: { assigned_to: null } })).ok()).toBe(true)
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })))
    await expect.poll(() => removedHeader!.evaluate(element => element.isConnected)).toBe(false)
    await expect(lane.locator(".kanban-column-header")).toBeFocused()
    await expect(group(unassignedTask).locator(cardSelector(localTask))).toBeVisible()
  } finally {
    for (const taskId of taskIds) {
      const deleted = await request.delete(`/api/tasks/${taskId}`, { headers })
      expect.soft(deleted.ok(), `Delete fixture task: ${await deleted.text()}`).toBe(true)
    }
  }
})

test("a refreshed assignee board resolves names while its old directory response is still pending", async ({
  page, request, baseURL,
}) => {
  const origin = new URL(baseURL!).origin
  const headers = { origin, "content-type": "application/json" }
  const prefix = `Assignee refresh ${randomUUID().slice(0, 8)}`
  const users = [
    { id: "ha_0123456789abcdef0123456789abcdef", name: "Alex Home" },
    { id: "ha_fedcba9876543210fedcba9876543210", name: "Jordan Home" },
  ]
  const taskIds: string[] = []
  let reads = 0
  let releaseOld: () => void = () => {}
  let finishOld: () => void = () => {}
  const held = new Promise<void>(resolve => { releaseOld = resolve })
  const oldFinished = new Promise<void>(resolve => { finishOld = resolve })

  await page.route("**/api/users", async route => {
    if (++reads === 1) {
      await held
      try {
        await route.fulfill({ json: { users: [], ha_connected: true, ha_roster_verified: false } })
      } catch { /* A replaced board can abort this request. */ }
      finally { finishOld() }
      return
    }
    await route.fulfill({ json: { users, ha_connected: true, ha_roster_verified: true } })
  })

  try {
    for (const user of users) {
      const response = await request.post("/api/tasks", {
        headers,
        data: { title: `${prefix} ${user.name}`, status: "pending", assigned_to: user.id },
      })
      expect(response.status(), await response.text()).toBe(201)
      taskIds.push((await response.json() as { id: string }).id)
    }
    await page.goto(`/tasks?search=${encodeURIComponent(prefix)}&groupBy=assigned#kanban`, {
      waitUntil: "domcontentloaded",
    })
    const groups = page.locator('.kanban-column[data-status="pending"] .dynamic-group')
    const group = (id: string) => groups.filter({ has: page.locator(`.kanban-card[data-id="${id}"]`) })
    const label = (id: string) => group(id).locator(".swimlane-label")
    const heading = (id: string) => group(id).locator("button.swimlane-header")
    await expect(groups).toHaveCount(2)
    await expect.poll(() => reads).toBe(1)
    for (const id of taskIds) {
      await expect(heading(id)).toHaveAccessibleName(/Loading assignee… \([12]\)/)
    }
    expect(new Set(await Promise.all(taskIds.map(id => label(id).textContent())))).toEqual(
      new Set(["Loading assignee… (1)", "Loading assignee… (2)"]),
    )

    const oldHeader = await heading(taskIds[0]!).elementHandle()
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })))
    await expect.poll(() => oldHeader!.evaluate(element => element.isConnected)).toBe(false)
    await expect.poll(() => reads).toBe(2)
    for (const [index, user] of users.entries()) {
      await expect(label(taskIds[index]!)).toHaveText(user.name)
    }
    releaseOld()
    await oldFinished
    for (const [index, user] of users.entries()) {
      await expect(label(taskIds[index]!)).toHaveText(user.name)
    }
  } finally {
    releaseOld()
    for (const taskId of taskIds) {
      const deleted = await request.delete(`/api/tasks/${taskId}`, { headers })
      expect.soft(deleted.ok(), `Delete fixture task: ${await deleted.text()}`).toBe(true)
    }
  }
})

test("unreadable or missing assignment keys keep all cards grouped", async ({ page, request }) => {
  const prefix = `Assignment metadata ${randomUUID()}`
  const ids: string[] = []
  const failures: string[] = []
  page.on("pageerror", error => failures.push(error.message))
  await page.route("**/api/users", route => route.fulfill({ json: { users: [], ha_connected: false } }))
  try {
    for (let index = 0; index < 3; index++) {
      const response = await request.post("/api/tasks", {
        data: { title: `${prefix} ${index}`, assigned_to: `custom_metadata_${index}` },
      })
      expect(response.status()).toBe(201)
      ids.push((await response.json()).id)
    }
    await page.route("**/tasks?**", async route => {
      const response = await route.fetch()
      let index = 0
      const body = (await response.text()).replace(/data-assignee-key="[^"]*"/g, () =>
        ["data-assignee-key=\"broken\"", "data-assignee-key=\"null\"", ""][index++] ?? "")
      await route.fulfill({ response, body })
    }, { times: 1 })
    await page.goto(`/tasks?view=kanban&area=&search=${encodeURIComponent(prefix)}&groupBy=assigned#kanban`)
    const lane = page.locator('.kanban-column[data-status="pending"]')
    await expect(lane.locator(".dynamic-group")).toHaveCount(3)
    for (const id of ids) await expect(lane.locator(`.dynamic-group .kanban-card[data-id="${id}"]`)).toBeVisible()
    expect(failures).toEqual([])
  } finally {
    for (const id of ids) await request.delete(`/api/tasks/${id}`)
  }
})
