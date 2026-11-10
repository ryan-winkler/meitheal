import { execFileSync, fork } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, test } from "@playwright/test"

test("task detail preserves separate checklist edits made in two sessions", async ({ browser, request }) => {
  test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires a built App and disposable browser fixture")
  const original = [
    { id: "first-step", text: "Check the lock", done: false },
    { id: "second-step", text: "Close the window", done: false },
  ]
  const task = await request.post("/api/tasks", {
    data: { title: "Concurrent checklist", checklists: JSON.stringify(original) },
  })
  expect(task.status()).toBe(201)
  const { id } = await task.json()
  const taskPath = "/api/tasks/" + encodeURIComponent(id)
  const first = await browser.newPage()
  const second = await browser.newPage()
  try {
    for (const page of [first, second]) {
      const base = process.env.E2E_BASE_URL
      await page.goto(base + "/tasks?open=" + encodeURIComponent(id))
      await expect(page.locator("#td-checklists input[type=checkbox]")).toHaveCount(2)
      await expect(page.locator("#td-checklists input[type=checkbox]").first()).toBeVisible()
    }
    const put = (page: typeof first) => page.waitForResponse(response =>
      new URL(response.url()).pathname === taskPath && response.request().method() === "PUT",
    )
    await Promise.all([put(first), first.locator("#td-checklists input[type=checkbox]").first().check()])
    await Promise.all([put(second), second.locator("#td-checklists input[type=checkbox]").last().check()])
    await expect.poll(async () => {
      const response = await request.get(taskPath)
      return JSON.parse((await response.json()).checklists)
    }).toEqual(original.map(item => ({ ...item, done: true })))
    await expect(second.locator("#td-checklists input[type=checkbox]").last()).toBeFocused()
    for (const [page, text] of [[first, "Open the shutters"], [second, "Switch on the lamp"]] as const) {
      await page.getByRole("button", { name: "Add Item" }).click()
      const newStep = page.locator("#td-checklists textarea").last()
      await expect(newStep).toBeFocused()
      await newStep.fill(text)
      await newStep.press("Enter")
      await expect.poll(async () => {
        const response = await request.get(taskPath)
        const items = JSON.parse((await response.json()).checklists) as Array<{ text: string }>
        return items.filter(item => item.text === text).length
      }).toBe(1)
    }
    const response = await request.get(taskPath)
    const saved = JSON.parse((await response.json()).checklists)
    expect(saved).toEqual([
      ...original.map(item => ({ ...item, done: true })),
      { id: expect.any(String), text: "Open the shutters", done: false },
      { id: expect.any(String), text: "Switch on the lamp", done: false },
    ])
    expect(new Set(saved.map((item: { id: string }) => item.id)).size).toBe(4)
  } finally {
    await first.close()
    await second.close()
  }
})

test("a long checklist item wraps in a narrow detail panel and can be edited", async ({ page, request }) => {
  test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires a built App and disposable browser fixture")
  await page.setViewportSize({ width: 360, height: 760 })
  const longText = "Confirm the booking details " + "REFERENCE".repeat(30)
  const created = await request.post("/api/tasks", {
    data: {
      title: "Narrow checklist",
      checklists: JSON.stringify([{ id: "booking", text: longText, done: false }]),
    },
  })
  expect(created.status()).toBe(201)
  const { id } = await created.json()
  const taskPath = "/api/tasks/" + encodeURIComponent(id)
  await page.goto("/tasks")
  await page.getByRole("link", { name: /^Task: Narrow checklist,/ }).click()
  const item = page.getByRole("textbox", { name: "Checklist item 1", exact: true })
  await expect(item).toBeVisible()
  await expect(item).toHaveValue(longText)
  const assertFits = () => item.evaluate(element => ({
    height: element.clientHeight,
    scrollHeight: element.scrollHeight,
    width: element.clientWidth,
    scrollWidth: element.scrollWidth,
    right: element.getBoundingClientRect().right,
  }))
  const dimensions = await assertFits()
  expect(dimensions.height).toBeGreaterThan(60)
  expect(dimensions.scrollHeight).toBeLessThanOrEqual(dimensions.height + 1)
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.width + 1)
  expect(dimensions.right).toBeLessThanOrEqual(360)
  const edited = longText + " " + "CONFIRMATION".repeat(12)
  await item.fill(edited)
  const resized = await assertFits()
  expect(resized.height).toBeGreaterThan(dimensions.height)
  expect(resized.scrollHeight).toBeLessThanOrEqual(resized.height + 1)
  const [saved] = await Promise.all([
    page.waitForResponse(response =>
      new URL(response.url()).pathname === taskPath && response.request().method() === "PUT",
    ),
    item.press("Enter"),
  ])
  expect(saved.status()).toBe(200)
  await expect(page.getByRole("checkbox", { name: edited, exact: true })).toBeVisible()
  const task = await request.get(taskPath)
  expect(JSON.parse((await task.json()).checklists)).toEqual([{ id: "booking", text: edited, done: false }])
})

test("reopening by ticket key waits for only that task's pending checklist save", async ({ page, request }) => {
  test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires a built App and disposable browser fixture")
  const makeTask = async (title: string) => {
    const response = await request.post("/api/tasks", {
      data: {
        title,
        checklists: JSON.stringify([
          { id: "first", text: "First step", done: false },
          { id: "second", text: "Second step", done: false },
        ]),
      },
    })
    expect(response.status()).toBe(201)
    return await response.json() as { id: string; ticket_key: string }
  }
  const first = await makeTask("First pending checklist")
  const other = await makeTask("Independent checklist")
  const taskPath = "/api/tasks/" + encodeURIComponent(first.id)
  const ticketKey = first.ticket_key.toLowerCase()
  const ticketPath = "/api/tasks/" + encodeURIComponent(ticketKey)
  let releaseWrite!: () => void
  const delayWrite = new Promise<void>(resolve => { releaseWrite = resolve })
  let writeHeld = false
  let ticketReadStarted = false
  page.on("request", sent => {
    if (new URL(sent.url()).pathname === ticketPath && sent.method() === "GET") ticketReadStarted = true
  })
  await page.route("**/api/tasks/*", async route => {
    const path = new URL(route.request().url()).pathname
    if (path === taskPath && route.request().method() === "PUT" && !writeHeld) {
      writeHeld = true
      await delayWrite
    }
    await route.continue()
  })
  const open = (id: string) => page.evaluate(task => { window.openTaskDetail?.(task) }, id)
  const firstStep = page.getByRole("checkbox", { name: "First step", exact: true })
  const secondStep = page.getByRole("checkbox", { name: "Second step", exact: true })
  const close = page.getByRole("button", { name: "Close detail", exact: true })
  const detail = page.locator("#task-detail-overlay")
  try {
    await page.goto("/tasks?open=" + encodeURIComponent(first.id))
    await firstStep.check()
    await expect.poll(() => writeHeld).toBe(true)
    await close.click()
    await expect(detail).toBeHidden()

    await open(other.id)
    await expect(detail).toHaveAttribute("aria-label", "Task detail: Independent checklist")
    await secondStep.check()
    await expect.poll(async () => {
      const response = await request.get("/api/tasks/" + other.id)
      return JSON.parse((await response.json()).checklists)[1].done
    }).toBe(true)
    await close.click()
    await expect(detail).toBeHidden()

    await open(ticketKey)
    await expect(page.locator("#td-skeleton")).toBeVisible()
    await expect(page.locator("#td-loaded-content")).toBeHidden()
    expect(ticketReadStarted).toBe(false)
    releaseWrite()
    await expect(detail).toHaveAttribute("aria-label", "Task detail: First pending checklist")
    await expect(firstStep).toBeChecked()
    expect(ticketReadStarted).toBe(true)
    await secondStep.check()
    await expect.poll(async () => {
      const response = await request.get(taskPath)
      return JSON.parse((await response.json()).checklists).map((item: { done: boolean }) => item.done)
    }).toEqual([true, true])
  } finally {
    releaseWrite()
  }
})

test("a stale checklist guard rejects the entire update and keeps the legacy API working", async ({ request }) => {
  test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires a built App and disposable API fixture")
  const original = '[ {"text":"Check the lock","done":false} ]'
  const created = await request.post("/api/tasks", {
    data: { title: "Guarded checklist", checklists: original },
  })
  expect(created.status()).toBe(201)
  const { id } = await created.json()
  const taskPath = "/api/tasks/" + encodeURIComponent(id)
  const update = await request.put(taskPath, { data: { title: "An unrelated change" } })
  expect(update.status()).toBe(200)
  const candidates = [
    JSON.stringify([{ text: "Check the lock", done: true }]),
    JSON.stringify([{ text: "Check the other lock", done: false }]),
  ]
  const writes = await Promise.all(candidates.map((checklists, index) => request.put(taskPath, {
    data: { title: "Candidate " + index, expected_checklists: original, checklists },
  })))
  expect(writes.map(response => response.status()).sort()).toEqual([200, 409])
  const winner = writes.findIndex(response => response.status() === 200)
  const conflict = writes.find(response => response.status() === 409)!
  expect(conflict.headers()["cache-control"]).toBe("no-store")
  expect(await conflict.json()).toMatchObject({ code: "checklist_conflict", checklists: candidates[winner] })
  const after = await request.get(taskPath)
  expect(await after.json()).toMatchObject({ title: "Candidate " + winner, checklists: candidates[winner] })
  const invalid = await request.put(taskPath, { data: { title: "Invalid", expected_checklists: original } })
  expect(invalid.status()).toBe(400)
  const legacy = await request.put(taskPath, { data: { checklists: original } })
  expect(legacy.status()).toBe(200)
  expect(await legacy.json()).toMatchObject({ title: "Candidate " + winner, checklists: original })
})

test("a conflict on a legacy checklist step preserves the text draft and lets the user reload", async ({ page, request }) => {
  test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires a built App and disposable browser fixture")
  const original = '[ "Check the lock" ]'
  const created = await request.post("/api/tasks", {
    data: { title: "Recover checklist draft", checklists: original },
  })
  expect(created.status()).toBe(201)
  const { id } = await created.json()
  const taskPath = "/api/tasks/" + encodeURIComponent(id)
  await page.goto("/tasks?open=" + encodeURIComponent(id))
  const first = page.getByRole("textbox", { name: "Checklist item 1", exact: true })
  await expect(page.locator("#td-checklist-recover")).toBeHidden()
  await expect(first).toHaveValue("Check the lock")
  const [savedLegacy] = await Promise.all([
    page.waitForResponse(response =>
      new URL(response.url()).pathname === taskPath && response.request().method() === "PUT",
    ),
    page.getByRole("checkbox", { name: "Check the lock", exact: true }).check(),
  ])
  expect(savedLegacy.status()).toBe(200)
  expect(savedLegacy.request().postDataJSON()).toMatchObject({
    expected_checklists: original,
    checklists: JSON.stringify([{ text: "Check the lock", done: true }]),
  })
  const newer = JSON.stringify([{ text: "Other session", done: false }])
  const update = await request.put(taskPath, { data: { checklists: newer } })
  expect(update.status()).toBe(200)
  await first.fill("Keep my draft")
  await first.press("Enter")
  await expect(page.locator("#td-checklist-message")).toContainText("Your draft is still shown")
  await expect(first).toHaveValue("Keep my draft")
  const before = await request.get(taskPath)
  expect(await before.json()).toMatchObject({ checklists: newer })
  await page.getByRole("button", { name: "Load latest checklist" }).click()
  await expect(first).toHaveValue("Other session")
  await expect(page.locator("#td-checklist-draft")).toContainText("Keep my draft")
  await expect(page.locator("#td-checklist-draft summary")).toBeFocused()

  await page.getByRole("button", { name: "Add Item" }).click()
  const added = page.getByRole("textbox", { name: "Checklist item 2", exact: true })
  await expect(added).toBeFocused()
  await added.fill("Review the draft")
  await added.press("Enter")
  const step = page.getByRole("checkbox", { name: "Review the draft" })
  const addedDone = async () => {
    const task = await request.get(taskPath)
    const items = JSON.parse((await task.json()).checklists) as Array<{ text: string; done: boolean }>
    return items.find(item => item.text === "Review the draft")?.done
  }
  await step.focus()
  await step.press("Space")
  await expect(step).toBeChecked()
  await expect(step).toBeFocused()
  await expect.poll(addedDone).toBe(true)
  await step.press("Space")
  await expect(step).not.toBeChecked()
  await expect.poll(addedDone).toBe(false)
  await page.getByRole("button", { name: "Delete checklist item 2" }).press("Enter")
  await expect(page.getByRole("button", { name: "Delete checklist item 1" })).toBeFocused()
  await expect.poll(async () => {
    const task = await request.get(taskPath)
    return (await task.json()).checklists
  }).toBe(newer)
})

test("retry after a lost checklist write response keeps only one new step", async ({ page, request }) => {
  test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires a built App and disposable browser fixture")
  const created = await request.post("/api/tasks", { data: { title: "Checklist write response lost" } })
  expect(created.status()).toBe(201)
  const { id } = await created.json()
  const taskPath = "/api/tasks/" + encodeURIComponent(id)
  await page.goto("/tasks?open=" + encodeURIComponent(id))
  let loseResponse = true
  await page.route("**" + taskPath, async route => {
    if (route.request().method() !== "PUT" || !loseResponse) {
      await route.continue()
      return
    }
    loseResponse = false
    const persisted = await route.fetch()
    expect(persisted.status()).toBe(200)
    await route.abort("failed")
  })
  await page.getByRole("button", { name: "Add Item" }).click()
  const retry = page.getByRole("button", { name: "Retry checklist save" })
  await expect(retry).toBeVisible()
  const getItems = async () => {
    const task = await request.get(taskPath)
    return JSON.parse((await task.json()).checklists)
  }
  const oneStep = await getItems()
  expect(oneStep).toEqual([{ id: expect.any(String), text: "New Item", done: false }])
  const retryResponse = page.waitForResponse(response =>
    new URL(response.url()).pathname === taskPath && response.request().method() === "PUT",
  )
  await retry.click()
  expect((await retryResponse).status()).toBe(409)
  await expect(page.locator("#td-checklist-recover")).toBeHidden()
  await expect(page.getByRole("textbox", { name: "Checklist item 1", exact: true })).toHaveValue("New Item")
  expect(await getItems()).toEqual(oneStep)
})

test("a historical SQL NULL checklist can be edited and distinguished from an empty array", async ({ browser, request }) => {
  test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires a built App and a disposable historical database")
  const work = await mkdtemp(join(tmpdir(), "meitheal-null-checklist-"))
  const web = fileURLToPath(new URL("../../apps/web", import.meta.url))
  const fixture = fileURLToPath(new URL("../scripts/feedback-ingress-fixture.mjs", import.meta.url))
  const env = {
    PATH: process.env.PATH,
    NODE_ENV: "production",
    MEITHEAL_DB_URL: `file:${join(work, "meitheal.db")}`,
    MEITHEAL_INGRESS_FIXTURE_PORT: process.env.MEITHEAL_INGRESS_FIXTURE_PORT,
  }
  const id = "legacy-null-checklist"
  let server: ReturnType<typeof fork> | undefined
  try {
    execFileSync(process.execPath, ["scripts/migrate.mjs"], { cwd: web, env })
    execFileSync(process.execPath, ["--input-type=module", "-e", `
      import { openDatabase } from "./scripts/database-client.mjs"
      const db = openDatabase(process.env.MEITHEAL_DB_URL)
      const id = process.argv[1]
      await db.execute("ALTER TABLE tasks ADD COLUMN checklists TEXT DEFAULT '[]'")
      await db.execute({
        sql: "INSERT INTO tasks (id, title, checklists, idempotency_key, request_id, created_at, updated_at) VALUES (?, ?, NULL, ?, ?, ?, ?)",
        args: [id, "Legacy null checklist", id, id, 1710496800000, 1710496800000],
      })
      db.close()
    `, id], { cwd: web, env })
    server = fork(fixture, { cwd: web, env, stdio: ["ignore", "ignore", "inherit", "ipc"] })
    const [info] = await once(server, "message", { signal: AbortSignal.timeout(10_000) })
    const origin = `http://127.0.0.1:${info.port}`
    const taskPath = `/api/tasks/${id}`
    const url = origin + taskPath
    const read = async () => {
      const response = await request.get(url)
      expect(response.status()).toBe(200)
      return response.json()
    }
    expect(await read()).toMatchObject({ checklists: null })
    const staleEmpty = await request.put(url, {
      headers: { origin },
      data: { checklists: "[]", expected_checklists: "[]", title: "Stale title" },
    })
    expect(staleEmpty.status()).toBe(409)
    expect(await staleEmpty.json()).toMatchObject({ code: "checklist_conflict", checklists: null })
    expect(await read()).toMatchObject({ title: "Legacy null checklist", checklists: null })

    const page = await browser.newPage({ extraHTTPHeaders: {} })
    const ingress = origin + info.configuredPath
    try {
      await page.context().addCookies([{ name: "feedback-fixture", value: "admin", url: origin }])
      await page.goto(ingress + "/tasks?open=" + id)
      const detail = page.getByRole("dialog", { name: "Task detail: Legacy null checklist" })
      await expect(detail).toBeVisible()
      const add = detail.getByRole("button", { name: "Add Item", exact: true })
      await expect(add).toBeVisible()
      const [result] = await Promise.all([
        page.waitForResponse(response => response.url() === ingress + taskPath && response.request().method() === "PUT"),
        add.click(),
      ])
      expect(result.request().postDataJSON()).toMatchObject({ expected_checklists: null })
      expect(result.status()).toBe(200)
      const newChecklist = (await read()).checklists
      expect(JSON.parse(newChecklist)).toEqual([{ id: expect.any(String), text: "New Item", done: false }])
      const staleNull = await request.put(url, {
        headers: { origin },
        data: { checklists: "[]", expected_checklists: null },
      })
      expect(staleNull.status()).toBe(409)
      expect(await staleNull.json()).toMatchObject({ code: "checklist_conflict", checklists: newChecklist })
    } finally {
      await page.close()
    }
  } finally {
    if (server && server.exitCode === null && server.signalCode === null) {
      const exited = once(server, "exit")
      server.kill("SIGTERM")
      await exited
    }
    await rm(work, { recursive: true, force: true })
  }
})
