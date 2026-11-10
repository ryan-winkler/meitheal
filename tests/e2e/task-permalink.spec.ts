import { execFileSync, fork } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, test } from "@playwright/test"

test("copies a stable task link and returns from a deleted task to the task view", async ({ page, request, baseURL }) => {
  test.skip(!process.env.E2E_BASE_URL, "Requires a disposable local Meitheal server")
  const origin = new URL(baseURL!).origin
  const headers = { origin, "content-type": "application/json" }
  const title = "Task permalink round trip"
  const created = await request.post("/api/tasks", { headers, data: { title, status: "active" } })
  expect(created.status(), await created.text()).toBe(201)
  const { id, ticket_key } = await created.json()
  const taskPage = "/tasks?area_id=default#kanban"
  const canonical = `${origin}/tasks?open=${id}`

  await page.context().grantPermissions(["clipboard-read", "clipboard-write"])
  await page.goto(taskPage)
  const card = page.getByRole("button", { name: /^Task: Task permalink round trip,/ })
    .and(page.locator(`[data-id="${id}"]`))
  await card.click()
  const detail = page.getByRole("dialog", { name: `Task detail: ${title}` })
  await detail.getByRole("button", { name: "Copy task link" }).click()
  await expect(page.getByText("Task link copied", { exact: true })).toBeVisible()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(canonical)
  await page.goBack()
  await expect(detail).toBeHidden()
  await expect(page).toHaveURL(origin + taskPage)

  await page.goto(`/tasks#task-${ticket_key}`)
  await expect(page.locator("#td-title")).toHaveValue(title)
  await page.reload()
  await expect(page.locator("#td-title")).toHaveValue(title)

  const deleted = await request.delete(`/api/tasks/${id}`, { headers })
  expect(deleted.ok(), await deleted.text()).toBeTruthy()
  await page.goto(canonical)
  await expect(page.getByRole("alert").filter({ hasText: "This task is unavailable." })).toBeVisible()
  await expect(page.getByRole("button", { name: "Copy task link" })).toBeHidden()
  await expect(page.getByRole("button", { name: "Close detail" })).toBeFocused()
  await page.keyboard.press("Escape")
  await expect(page.getByRole("dialog", { name: "Task detail" })).toBeHidden()
  await expect(page).toHaveURL(/\/tasks#kanban$/)
  const views = page.getByRole("navigation", { name: "Task views" })
  await expect(views.getByRole("link", { name: "Kanban" })).toBeFocused()
})

test("Table keyboard controls retain their actions beside the task detail shortcut", async ({ page, request, baseURL }) => {
  test.skip(!process.env.E2E_BASE_URL, "Requires a disposable local Meitheal server")
  const origin = new URL(baseURL!).origin
  const title = "Table keyboard task"
  const created = await request.post("/api/tasks", { headers: { origin }, data: { title, status: "active" } })
  expect(created.status(), await created.text()).toBe(201)
  const { id } = await created.json()

  await page.goto("/tasks?view=table#table")
  await expect.poll(() => page.evaluate(() => typeof window.openTaskDetail)).toBe("function")
  const row = page.locator(`tr[data-id="${id}"]`)
  const checkbox = row.getByRole("checkbox", { name: `Select task: ${title}` })
  await checkbox.press("Space")
  await expect(checkbox).toBeChecked()
  await expect(checkbox).toBeFocused()
  await expect(page).not.toHaveURL(/[?&]open=/)
  await checkbox.press("Space")
  await expect(checkbox).not.toBeChecked()

  const editor = row.getByRole("textbox")
  await editor.fill("A")
  await editor.press("End")
  await editor.press("Space")
  await editor.press("B")
  await expect(editor).toHaveText("A B")
  await expect(editor).toBeFocused()
  await editor.press("Escape")
  await expect(editor).toHaveText(title)

  await row.getByRole("button", { name: new RegExp(title) }).press("Enter")
  await expect(page.getByRole("dialog", { name: `Task detail: ${title}` })).toBeVisible()
})

test("a task link preserves simulated ingress and opens in another authorized context", async ({ browser }) => {
  test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires a built app and the ingress fixture")
  const work = await mkdtemp(join(tmpdir(), "meitheal-task-permalink-"))
  const env = { PATH: process.env.PATH, NODE_ENV: "production", MEITHEAL_DB_URL: `file:${join(work, "meitheal.db")}` }
  const web = fileURLToPath(new URL("../../apps/web", import.meta.url))
  const fixture = fileURLToPath(new URL("../scripts/feedback-ingress-fixture.mjs", import.meta.url))
  let server: ReturnType<typeof fork> | undefined
  const source = await browser.newContext({ extraHTTPHeaders: {} })
  const recipient = await browser.newContext({ extraHTTPHeaders: {} })
  try {
    execFileSync(process.execPath, ["scripts/migrate.mjs"], { cwd: web, env })
    const child = fork(fixture, { cwd: web, env, stdio: ["ignore", "ignore", "inherit", "ipc"] })
    server = child
    const [info] = await Promise.race([
      once(child, "message", { signal: AbortSignal.timeout(10_000) }),
      once(child, "exit").then(([code]) => { throw new Error(`Ingress fixture exited with ${code}`) }),
    ])
    const origin = `http://127.0.0.1:${info.port}`
    const entry = origin + info.configuredPath
    await source.addCookies([{ name: "feedback-fixture", value: "admin", url: origin }])
    await recipient.addCookies([{ name: "feedback-fixture", value: "member", url: origin }])
    const title = "Ingress task permalink round trip"
    const created = await source.request.post(entry + "/api/tasks", {
      headers: { origin }, data: { title, status: "active" },
    })
    expect(created.status(), await created.text()).toBe(201)
    const { id } = await created.json()
    const sourcePage = await source.newPage()
    await sourcePage.addInitScript(() => {
      Object.defineProperty(navigator, "clipboard", { value: undefined })
    })
    await sourcePage.goto(entry + "/tasks#kanban")
    await expect.poll(() => sourcePage.evaluate(() => typeof window.openTaskDetail)).toBe("function")
    const card = sourcePage.getByRole("button", { name: /^Task: Ingress task permalink round trip,/ })
    await card.press("Enter")
    const detail = sourcePage.getByRole("dialog", { name: `Task detail: ${title}` })
    await expect(detail.locator("#td-title")).toHaveValue(title)
    const copy = detail.getByRole("button", { name: "Copy task link" })
    await copy.press("Enter")
    const manual = sourcePage.getByLabel("Copy this task link manually")
    await expect(manual).toBeFocused()
    const copiedLink = await manual.inputValue()
    expect(copiedLink).toBe(`${entry}/tasks?open=${id}`)

    const recipientPage = await recipient.newPage()
    const taskRead = recipientPage.waitForResponse(response =>
      response.url() === `${entry}/api/tasks/${id}` && response.request().method() === "GET")
    await recipientPage.goto(copiedLink)
    await expect(recipientPage.locator("#td-title")).toHaveValue(title)
    expect((await taskRead).status()).toBe(200)
    await recipientPage.reload()
    await expect(recipientPage.locator("#td-title")).toHaveValue(title)
  } finally {
    await source.close()
    await recipient.close()
    if (server && server.exitCode === null && server.signalCode === null) {
      const exited = once(server, "exit")
      server.kill()
      await exited
    }
    await rm(work, { recursive: true, force: true })
  }
})
