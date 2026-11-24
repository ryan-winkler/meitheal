import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test, type APIRequestContext } from "@playwright/test"
import { SHOPPING_CATEGORIES } from "../../packages/domain-tasks/src/index"
import { currentBoardWriteHeaders } from "../helpers/current-board-http"
import { startCoreFixture } from "../scripts/task-pins-fixture"
import { shouldSkipBrowserSpecs } from "./_helpers"

function localDateTimeInDublin(offsetHours: number): string {
  const today = formatDublin(new Date()).slice(0, 10)
  const value = formatDublin(new Date(Date.now() + offsetHours * 3_600_000))
  // Near midnight keep the event on today's date so it still surfaces on Today; the
  // later offset stays after the earlier one.
  return value.slice(0, 10) === today ? value : `${today}T23:${offsetHours >= 3 ? "59" : "58"}`
}

function formatDublin(target: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Dublin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(target)
  const pick = (type: string) => parts.find((p) => p.type === type)?.value ?? "00"
  return `${pick("year")}-${pick("month")}-${pick("day")}T${pick("hour")}:${pick("minute")}`
}

test.describe("Routines, Events, and Shopping UX", () => {
  test.skip(shouldSkipBrowserSpecs(), "Set E2E_BASE_URL to run browser specs")

  test("routines use Tabler SVG sprites, create cleanly, and check in with period idempotency", async ({
    page,
    request,
  }) => {
    await page.goto("/habits")
    await page.waitForLoadState("networkidle")

    await page.locator("#habits-bar-new-habit").click()
    await expect(page.locator("#habit-modal-overlay")).toBeVisible()

    // Routine icon picker renders Tabler SVG sprites, not raw emoji
    const iconButtons = page.locator("#habit-icon-picker [data-habit-icon-option]")
    const iconCount = await iconButtons.count()
    expect(iconCount).toBeGreaterThan(0)
    for (let i = 0; i < iconCount; i++) {
      const btn = iconButtons.nth(i)
      await expect(btn.locator("svg use")).toHaveCount(1)
      expect((await btn.innerText()).trim()).toBe("")
    }

    const routineName = `Morning tidy ${Date.now()}`
    await page.locator("#habit-name").fill(routineName)
    await iconButtons.first().click()
    await page.locator("#habit-cadence").selectOption("daily")
    await page.locator("#habit-priority").selectOption("2")
    await page.locator("#habit-description").fill("Reset counters and sink")

    const createdResPromise = page.waitForResponse(
      (res) => new URL(res.url()).pathname === "/api/habits" && res.request().method() === "POST",
    )
    await page.locator('#habit-form button[type="submit"]').click()
    const createdRes = await createdResPromise
    expect(createdRes.status()).toBe(201)
    await expect(page.locator("#habit-modal-overlay")).toHaveClass(/hidden/)

    await page.reload()
    await page.waitForLoadState("networkidle")

    const card = page.locator("#habits-list .habit-card", { hasText: routineName })
    await expect(card).toBeVisible()
    await expect(card.locator(".habit-card__icon svg use")).toHaveCount(1)
    await expect(card).toContainText(routineName)

    const completePromise = page.waitForResponse(
      (res) => new URL(res.url()).pathname === "/api/habits" && res.request().method() === "POST",
    )
    await card.locator('[data-action="complete"]').click()
    const completeRes = await completePromise
    expect(completeRes.status()).toBe(200)
    await expect(card).toHaveClass(/completed/)
    await expect(card.locator('[data-action="complete"]')).toHaveAttribute("aria-pressed", "true")

    const habitsRes = await request.get("/api/habits")
    expect(habitsRes.status()).toBe(200)
    const { habits } = await habitsRes.json()
    const saved = habits.find((h: { name: string }) => h.name === routineName)
    expect(saved).toMatchObject({ name: routineName, todayCompleted: true })
    expect(saved.todayTaskId).toBeTruthy()
  })

  test("calendar_event validates start/end dates inline and surfaces across Today, Upcoming, and Search without due_date", async ({
    page,
    request,
    baseURL,
  }) => {
    const origin = new URL(baseURL!).origin
    const headers = await currentBoardWriteHeaders(request, "household", { origin })
    await page.goto("/today")
    await page.waitForLoadState("networkidle")

    const title = `Dentist checkup ${Date.now()}`
    await page.locator("#today-bar-new-task").click()
    await expect(page.locator("#new-task-overlay")).toHaveClass(/active/)

    await page.locator('#nt-kind-tabs [data-kind="calendar_event"]').click()
    await expect(page.locator("#new-task-kind")).toHaveValue("calendar_event")
    await page.locator("#new-task-title-input").fill(title)

    const later = localDateTimeInDublin(3)
    const earlier = localDateTimeInDublin(1)
    // Inverted range shows inline role/error feedback and blocks submit
    await page.locator("#nt-event-start").fill(later)
    await page.locator("#nt-event-end").fill(earlier)
    await page.locator("#submit-new-task-btn").click()
    await expect(page.locator("#nt-date-error")).toBeVisible()

    // Valid range submits and omits due_date cleanly
    await page.locator("#nt-event-start").fill(earlier)
    await page.locator("#nt-event-end").fill(later)
    const createResPromise = page.waitForResponse(
      (res) => new URL(res.url()).pathname === "/api/tasks" && res.request().method() === "POST",
    )
    await page.locator("#submit-new-task-btn").click()
    const createRes = await createResPromise
    expect(createRes.status()).toBe(201)
    const created = await createRes.json()
    expect(created.task_kind).toBe("calendar_event")
    expect(created.start_date).toBeTruthy()
    expect(created.end_date).toBeTruthy()

    try {
      // Visible on Today and Upcoming
      await page.goto("/today")
      await page.waitForLoadState("networkidle")
      await expect(page.locator(`[data-id="${created.id}"]`).first()).toBeVisible()

      await page.goto("/upcoming")
      await page.waitForLoadState("networkidle")
      await expect(page.locator(`#upcoming-next .task-item[data-id="${created.id}"]`)).toBeVisible()

      // Search API filters by task_kind=calendar_event
      const searchRes = await request.get(`/api/search?q=${encodeURIComponent(title)}&task_kind=calendar_event`)
      expect(searchRes.status()).toBe(200)
      const searchPayload = await searchRes.json()
      const taskSection = searchPayload.sections.find((s: { id: string }) => s.id === "tasks")
      expect(taskSection?.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: created.id,
            meta: expect.objectContaining({ task_kind: "calendar_event" }),
          }),
        ]),
      )
    } finally {
      await request.delete(`/api/tasks/${created.id}`, { headers, data: {} })
    }
  })

  test("shopping_item preserves 8 categories, syncs checklists and custom_fields, and never renders [object Object]", async ({
    page,
    request,
    baseURL,
  }) => {
    const origin = new URL(baseURL!).origin
    const headers = await currentBoardWriteHeaders(request, "household", { origin })
    const todayDate = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Dublin",
      dateStyle: "short",
    }).format(new Date())

    const shoppingItems = SHOPPING_CATEGORIES.map((category, idx) => ({
      name: `Item-${category}`,
      qty: String(idx + 1),
      category,
      checked: false,
    }))
    const createdRes = await request.post("/api/tasks", {
      headers,
      data: {
        title: `Household shop ${Date.now()}`,
        task_kind: "shopping_item",
        due_date: todayDate,
        checklists: shoppingItems.map((item) => ({ text: item.name, done: item.checked })),
        custom_fields: {
          items: shoppingItems,
          grocy_product_id: 987,
          external_vendor: "grocy",
          grocy_sync: { listId: 42 },
        },
      },
    })
    expect(createdRes.status()).toBe(201)
    const created = await createdRes.json()

    try {
      await page.goto("/today")
      await page.waitForLoadState("networkidle")
      await page.locator(`.tli[data-id="${created.id}"]`).click()

      await expect(page.locator("#td-loaded-content")).toBeVisible()
      await expect(page.locator("#td-title")).toBeEditable()
      await expect(page.locator("#task-detail-overlay")).not.toContainText("[object Object]")

      const rows = page.locator("#td-checklists [data-checklist-row]")
      await expect(rows).toHaveCount(SHOPPING_CATEGORIES.length)

      const firstCatSelect = rows.first().locator("select.td-shop-cat")
      await expect(firstCatSelect).toHaveValue("produce")
      for (const category of SHOPPING_CATEGORIES) {
        await expect(firstCatSelect.locator(`option[value="${category}"]`)).toHaveCount(1)
      }

      // Updating an aisle category persists normalized custom_fields.items without clobbering Grocy keys
      const putPromise = page.waitForResponse(
        (res) =>
          new URL(res.url()).pathname === `/api/tasks/${created.id}` &&
          res.request().method() === "PUT" &&
          String(res.request().postData() ?? "").includes("custom_fields"),
      )
      await firstCatSelect.selectOption("pantry")
      const putRes = await putPromise
      expect(putRes.status()).toBe(200)

      const refreshed = await request.get(`/api/tasks/${created.id}`)
      expect(refreshed.status()).toBe(200)
      const detail = await refreshed.json()
      const cf = JSON.parse(String(detail.custom_fields)) as {
        grocy_product_id?: number | string
        external_vendor?: string
        grocy_sync?: { listId: number }
        items?: Array<{ name: string; category?: string }>
      }
      expect(String(cf.grocy_product_id)).toBe("987")
      expect(cf.external_vendor).toBe("grocy")
      expect(cf.grocy_sync).toEqual({ listId: 42 })
      expect(cf.items?.[0]).toMatchObject({ name: "Item-produce", category: "pantry" })
    } finally {
      await request.delete(`/api/tasks/${created.id}`, { headers, data: {} })
    }
  })
})

test("App MCP exposes routines, events, and 8-category shopping contracts without $ref", async ({ playwright }) => {
  test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires the built App and authenticated Core fixture")
  const work = await mkdtemp(join(tmpdir(), "meitheal-res-mcp-"))
  const child = startCoreFixture(work, true)
  child.stdout?.resume()
  child.stderr?.resume()
  let bootstrap: APIRequestContext | undefined
  let agent: APIRequestContext | undefined
  try {
    const [info] = await once(child, "message", { signal: AbortSignal.timeout(10_000) })
    const origin = `http://127.0.0.1:${info.port}`
    const path = (value: string) => info.configuredPath + value
    bootstrap = await playwright.request.newContext({ baseURL: origin, extraHTTPHeaders: {} })
    const owner = await currentBoardWriteHeaders(
      bootstrap,
      "household",
      { origin, cookie: "feedback-fixture=admin" },
      info.configuredPath,
    )
    const enrollment = await bootstrap.post(path("/api/agent-tokens"), {
      headers: owner,
      data: { name: "RES parity fixture", scopes: ["mcp:execute", "tasks:read", "tasks:write", "search:read"] },
    })
    expect(enrollment.status()).toBe(201)
    const { token } = await enrollment.json()
    await bootstrap.dispose()
    bootstrap = undefined

    agent = await playwright.request.newContext({
      baseURL: origin,
      extraHTTPHeaders: {
        authorization: `Bearer ${token}`,
        "x-meitheal-board-id": "household",
        "content-type": "application/json",
      },
    })
    const rpc = async (method: string, params?: Record<string, unknown>) => {
      const response = await agent!.post("/api/mcp", { data: { jsonrpc: "2.0", id: 1, method, params } })
      expect(response.status()).toBe(200)
      const body = await response.json()
      expect(body.error).toBeUndefined()
      return body.result
    }

    const tools = (await rpc("tools/list")).tools as Array<{ name: string; inputSchema: Record<string, unknown> }>
    expect(JSON.stringify(tools)).not.toContain('"$ref"')

    const createSchema = tools.find((t) => t.name === "createTask")?.inputSchema as Record<string, any>
    expect(createSchema.properties.task_kind.enum).toContain("calendar_event")
    expect(createSchema.properties.custom_fields.oneOf[0].properties.items.items.properties.category.enum).toEqual([
      ...SHOPPING_CATEGORIES,
    ])
    const searchSchema = tools.find((t) => t.name === "searchTasks")?.inputSchema as Record<string, any>
    expect(searchSchema.properties.task_kind.enum).toContain("shopping_item")

    const eventCall = await rpc("tools/call", {
      name: "createTask",
      arguments: {
        title: "MCP Sprint Review Event",
        task_kind: "calendar_event",
        start_date: "2026-07-01T10:00:00Z",
        end_date: "2026-07-01T11:00:00Z",
      },
    })
    expect(eventCall.isError).toBe(false)
    const eventCreated = JSON.parse(eventCall.content[0].text)
    expect(eventCreated.task.task_kind).toBe("calendar_event")

    const shopCall = await rpc("tools/call", {
      name: "createTask",
      arguments: {
        title: "MCP Groceries",
        task_kind: "shopping_item",
        custom_fields: { items: [{ name: "Yogurt", qty: "2", category: "dairy" }], grocy_id: 55 },
      },
    })
    expect(shopCall.isError).toBe(false)

    const filteredSearch = await rpc("tools/call", {
      name: "searchTasks",
      arguments: { q: "MCP", task_kind: "calendar_event" },
    })
    expect(filteredSearch.isError).toBe(false)
    const found = JSON.parse(filteredSearch.content[0].text)
    expect(found.count).toBe(1)
    expect(found.tasks[0].task_kind).toBe("calendar_event")

    const habitCreate = await rpc("tools/call", {
      name: "createHabit",
      arguments: { action: "create", name: "MCP Evening Sweep", cadence: "daily", priority: 2 },
    })
    expect(habitCreate.isError).toBe(false)
    const habit = JSON.parse(habitCreate.content[0].text)
    expect(habit.id).toBeTruthy()

    const habitList = await rpc("tools/call", { name: "listHabits", arguments: {} })
    expect(habitList.isError).toBe(false)
    expect(JSON.parse(habitList.content[0].text).habits).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: habit.id, name: "MCP Evening Sweep" })]),
    )

    const habitDone = await rpc("tools/call", {
      name: "createHabit",
      arguments: { action: "complete", templateId: habit.id },
    })
    expect(habitDone.isError).toBe(false)
    expect(JSON.parse(habitDone.content[0].text).completed).toBe(true)
  } finally {
    await agent?.dispose()
    await bootstrap?.dispose()
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit", { signal: AbortSignal.timeout(3_000) })
      child.kill("SIGKILL")
      await exited
    }
    await rm(work, { recursive: true, force: true })
  }
})

function dublinDateOffset(days: number): string {
  const target = new Date(Date.now() + days * 86_400_000)
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Dublin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(target)
  const y = parts.find((p) => p.type === "year")!.value
  const m = parts.find((p) => p.type === "month")!.value
  const d = parts.find((p) => p.type === "day")!.value
  return `${y}-${m}-${d}`
}

test("routines enforce icon/template whitelist and ongoing multi-day events surface without overdue", async ({
  page,
  request,
}) => {
  test.skip(shouldSkipBrowserSpecs(), "Browser UI verification requires MEITHEAL_TEST_BROWSER=1")
  const headers = await currentBoardWriteHeaders(request, "household", {})

  const badIconRes = await request.post("/api/habits", {
    headers,
    data: { action: "create", name: "Invalid Icon Routine", icon: "<bad-icon>" },
  })
  expect(badIconRes.status()).toBe(400)

  const createHabitRes = await request.post("/api/habits", {
    headers,
    data: { action: "create", name: "Audit Whitelist Routine", icon: "🧹", cadence: "daily" },
  })
  expect(createHabitRes.ok()).toBe(true)

  const listAfterCreate = await (await request.get("/api/habits", { headers })).json()
  const createdRoutine = (listAfterCreate.habits ?? []).find(
    (h: { name?: string }) => h.name === "Audit Whitelist Routine",
  )
  expect(createdRoutine?.icon).toBe("wash")

  const updateRes = await request.post("/api/habits", {
    headers,
    data: {
      action: "update",
      templateId: createdRoutine.id,
      templateJson: { description: "Updated safe", task_kind: "calendar_event" },
    },
  })
  expect(updateRes.status()).toBe(200)

  const listAfterUpdate = await (await request.get("/api/habits", { headers })).json()
  const updatedRoutine = (listAfterUpdate.habits ?? []).find(
    (h: { id?: string }) => h.id === createdRoutine.id,
  )
  const parsedTpl = JSON.parse(String(updatedRoutine?.template_json ?? "{}"))
  expect(parsedTpl.description).toBe("Updated safe")
  expect(parsedTpl.task_kind).toBeUndefined()

  await request.post("/api/habits", {
    headers,
    data: { action: "delete", templateId: createdRoutine.id },
  })

  const eventRes = await request.post("/api/tasks", {
    headers,
    data: {
      title: "Ongoing Multi-Day Retreat",
      task_kind: "calendar_event",
      start_date: dublinDateOffset(-1),
      end_date: dublinDateOffset(2),
    },
  })
  expect(eventRes.status()).toBe(201)
  const createdEvent = await eventRes.json()

  try {
    await page.goto("/today")
    await expect(page.locator("#today-due-list").getByText("Ongoing Multi-Day Retreat")).toBeVisible()
    await expect(page.locator("#today-carried-list").getByText("Ongoing Multi-Day Retreat")).toHaveCount(0)

    await page.goto("/upcoming")
    await expect(page.getByText("Ongoing Multi-Day Retreat").first()).toBeVisible()
  } finally {
    await request.delete(`/api/tasks/${createdEvent.id}`, { headers })
  }
})
