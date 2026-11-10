import { execFileSync, fork } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, test } from "@playwright/test"
import { deferred } from "./_helpers"

test("copies a stable task link and returns from a deleted task to the task view", async ({ page, request, baseURL }) => {
  test.skip(!process.env.E2E_BASE_URL, "Requires a disposable local Meitheal server")
  const origin = new URL(baseURL!).origin
  const headers = { origin, "content-type": "application/json" }
  const title = "Task permalink round trip"
  const created = await request.post("/api/tasks", { headers, data: { title, status: "active" } })
  expect(created.status(), await created.text()).toBe(201)
  const { id, ticket_key } = await created.json()
  const taskPage = "/tasks?area_id=default#kanban"
  const canonical = `${origin}/tickets/${id}`

  await page.context().grantPermissions(["clipboard-read", "clipboard-write"])
  await page.goto(taskPage)
  const card = page.getByRole("link", { name: /^Task: Task permalink round trip,/ })
    .and(page.locator(`[data-id="${id}"]`))
  await expect(card).toHaveAttribute("href", `/tickets/${id}`)
  await card.click()
  const detail = page.getByRole("dialog", { name: `Task detail: ${title}` })
  await detail.getByRole("button", { name: "Copy task link" }).click()
  await expect(page.getByText("Task link copied", { exact: true })).toBeVisible()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(canonical)
  await page.goBack()
  await expect(detail).toBeHidden()
  await expect(page).toHaveURL(origin + taskPage)
  await page.goForward()
  await expect(detail).toBeVisible()
  await expect(page).toHaveURL(canonical)
  await page.goto(`/tasks?open=${ticket_key}#kanban`)
  await expect(page.locator("#td-title")).toHaveValue(title)
  await expect(page).toHaveURL(canonical)

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

  await row.getByRole("link", { name: new RegExp(title) }).press("Enter")
  await expect(page.getByRole("dialog", { name: `Task detail: ${title}` })).toBeVisible()
})

test("task detail contains Tab while loading and after a nested confirmation", async ({ page, request, baseURL }) => {
  test.skip(!process.env.E2E_BASE_URL, "Requires a disposable local Meitheal server")
  const origin = new URL(baseURL!).origin
  const title = "Task detail keyboard boundaries"
  const created = await request.post("/api/tasks", { headers: { origin }, data: { title, status: "active" } })
  expect(created.status(), await created.text()).toBe(201)
  const { id } = await created.json()
  const detailResponse = deferred<void>()
  await page.route(`${origin}/api/tasks/${id}`, async route => {
    await detailResponse.promise
    await route.continue()
  })
  await page.emulateMedia({ reducedMotion: "reduce" })

  try {
    await page.goto("/tasks?area_id=default#kanban")
    await expect.poll(() => page.evaluate(() => typeof window.openTaskDetail)).toBe("function")
    const card = page.locator(`.kanban-card[data-id="${id}"]`).getByRole("link", { name: new RegExp(`^Task: ${title},`) })
    await card.press("Enter")
    const detail = page.locator("#task-detail-overlay")
    const close = detail.getByRole("button", { name: "Close detail" })
    await expect(close).toBeFocused()
    await page.keyboard.press("Shift+Tab")
    await expect(close).toBeFocused()
    await page.keyboard.press("Tab")
    await expect(close).toBeFocused()

    detailResponse.resolve()
    const first = detail.getByRole("button", { name: "Favorite" })
    const last = detail.getByText("Activity Log", { exact: true })
    await expect(first).toBeVisible()
    await first.focus()
    await page.keyboard.press("Shift+Tab")
    await expect(last).toBeFocused()
    await page.keyboard.press("Tab")
    await expect(first).toBeFocused()

    const remove = detail.getByRole("button", { name: "Delete Task" })
    await remove.press("Enter")
    const confirm = page.getByRole("alertdialog", { name: "Delete Task" })
    await expect(confirm.getByRole("button", { name: "Cancel" })).toBeFocused()
    await page.keyboard.press("Shift+Tab")
    await expect(confirm.getByRole("button", { name: "Delete Task" })).toBeFocused()
    await page.keyboard.press("Escape")
    await expect(remove).toBeFocused()
    await expect(detail).toBeVisible()
    await page.keyboard.press("Escape")
    await expect(detail).toBeHidden()
    await expect(card).toBeFocused()
  } finally {
    detailResponse.resolve()
    await request.delete(`/api/tasks/${id}`, { headers: { origin } })
  }
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
    const card = sourcePage.getByRole("link", { name: /^Task: Ingress task permalink round trip,/ })
    await card.press("Enter")
    const detail = sourcePage.getByRole("dialog", { name: `Task detail: ${title}` })
    await expect(detail.locator("#td-title")).toHaveValue(title)
    const copy = detail.getByRole("button", { name: "Copy task link" })
    await copy.press("Enter")
    const manual = sourcePage.getByLabel("Copy this task link manually")
    await expect(manual).toBeFocused()
    const copiedLink = await manual.inputValue()
    expect(copiedLink).toBe(`${entry}/tickets/${id}`)

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
test("a comment link focuses the edited comment through ingress and recovers after deletion", async ({ browser, request }) => {
  test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires a built app and a disposable ingress fixture")
  const work = await mkdtemp(join(tmpdir(), "meitheal-comment-permalink-"))
  const env = {
    PATH: process.env.PATH,
    NODE_ENV: "production",
    SUPERVISOR_TOKEN: "comment-link-fixture-only",
    MEITHEAL_ACTIVE_MEMBER_FIXTURE: "1",
    MEITHEAL_DB_URL: `file:${join(work, "meitheal.db")}`,
  }
  const web = fileURLToPath(new URL("../../apps/web", import.meta.url))
  const fixture = fileURLToPath(new URL("../scripts/feedback-ingress-fixture.mjs", import.meta.url))
  const source = await browser.newContext({ extraHTTPHeaders: {} })
  const recipient = await browser.newContext({ extraHTTPHeaders: {} })
  let server: ReturnType<typeof fork> | undefined
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
    const headers = { origin, "sec-fetch-site": "same-origin" }
    await source.addCookies([{ name: "feedback-fixture", value: "admin", url: origin }])
    await recipient.addCookies([{ name: "feedback-fixture", value: "member", url: origin }])
    const createTask = async (title: string) => {
      const result = await source.request.post(entry + "/api/tasks", { headers, data: { title, status: "active" } })
      expect(result.status()).toBe(201)
      return (await result.json()).id as string
    }
    const post = async (taskId: string, content: string) => {
      const result = await source.request.post(`${entry}/api/tasks/${taskId}/comments`, { headers, data: { content } })
      expect(result.status()).toBe(201)
      return (await result.json()).id as number
    }
    const id = await createTask("Comment link task")
    const other = await createTask("Unrelated comment task")
    await post(id, "First visible comment")
    const comment = await post(id, "The linked comment")
    const otherComment = await post(other, "Comment belonging to a different task")
    const taskUrl = `${entry}/tickets/${id}`
    const commentApiPath = `/api/tasks/${id}/comments/${comment}`

    const sourcePage = await source.newPage()
    await sourcePage.goto(taskUrl)
    const list = sourcePage.locator("#td-comments")
    await expect(list).toContainText("The linked comment")
    const authorRow = sourcePage.locator(`#td-comment-${comment}`)
    const link = authorRow.getByRole("link", { name: /^Comment link,/ })
    const edit = authorRow.getByRole("button", { name: "Edit comment" })
    const remove = authorRow.getByRole("button", { name: "Delete comment" })
    const editor = authorRow.getByRole("textbox", { name: "Edit comment" })
    const href = `${taskUrl}?comment=${comment}`
    await expect(link).toHaveAttribute("href", href)

    const denied = await request.get(origin + commentApiPath)
    expect(denied.status()).toBe(401)
    const forbiddenEdit = await recipient.request.patch(entry + commentApiPath, { headers, data: { content: "Wrong author" } })
    expect(forbiddenEdit.status()).toBe(404)

    await edit.press("Enter")
    await expect(editor).toBeFocused()
    await expect(editor).toHaveValue("The linked comment")
    await editor.fill("Cancelled change")
    await authorRow.getByRole("button", { name: "Cancel", exact: true }).press("Enter")
    await expect(edit).toBeFocused()
    await expect(authorRow).toContainText("The linked comment")
    await edit.press("Enter")
    await editor.fill("Edited linked comment")
    const save = authorRow.getByRole("button", { name: "Save comment" })
    const mutationUrl = entry + commentApiPath
    await sourcePage.route(mutationUrl, route => route.fulfill({ status: 503 }))
    await save.press("Enter")
    await expect(authorRow.getByRole("alert")).toContainText("Could not save your comment")
    await expect(editor).toHaveValue("Edited linked comment")
    await expect(editor).toBeFocused()
    await sourcePage.unroute(mutationUrl)

    await sourcePage.locator("#td-comment-input").fill("Posted while editing")
    await sourcePage.getByRole("button", { name: "Post Comment" }).press("Enter")
    await expect(list.getByText("Posted while editing", { exact: true })).toBeVisible()
    await expect(editor).toHaveValue("Edited linked comment")
    await save.press("Enter")
    await expect(authorRow).toContainText("Edited linked comment")
    await expect(edit).toBeFocused()
    await expect(link).toHaveAttribute("href", href)

    const editStarted = deferred<void>()
    const releaseEdit = deferred<void>()
    const editReleased = deferred<void>()
    await sourcePage.route(mutationUrl, async route => {
      editStarted.resolve()
      await releaseEdit.promise
      try {
        await route.fulfill({ json: { content: "Late edit must not render" } })
      } catch {
        // Closing the panel can abort the intercepted request before fulfillment.
      } finally {
        editReleased.resolve()
      }
    })
    try {
      await edit.press("Enter")
      await editor.fill("Editing before closing")
      await save.press("Enter")
      await editStarted.promise
      await sourcePage.getByRole("button", { name: "Close detail" }).press("Enter")
      await expect(sourcePage.locator("#task-detail-overlay")).not.toHaveClass(/active/)
      await expect(sourcePage).toHaveURL(entry + "/tasks#kanban")
      await sourcePage.goto(taskUrl)
      await expect(authorRow).toContainText("Edited linked comment")
    } finally {
      releaseEdit.resolve()
    }
    await editReleased.promise
    await sourcePage.unroute(mutationUrl)
    await expect(authorRow).not.toContainText("Late edit must not render")
    await expect(editor).toBeHidden()

    const page = await recipient.newPage()
    await page.goto(href)
    const target = page.locator(`#td-comment-${comment}`)
    await expect(target).toContainText("Edited linked comment")
    await expect(target).toBeFocused()
    await expect(target.getByRole("button", { name: "Edit comment" })).toHaveCount(0)
    await expect(target.getByRole("button", { name: "Delete comment" })).toHaveCount(0)
    await page.reload()
    await expect(target).toBeFocused()

    const missing = page.locator("#td-comment-link-status")
    await page.goto(`${taskUrl}?comment=${otherComment}`)
    await expect(missing).toContainText("This comment is unavailable")
    await expect(missing).toBeFocused()
    await expect(page.locator("#td-comments")).not.toContainText("Comment belonging to a different task")
    const confirmation = sourcePage.getByRole("alertdialog", { name: "Delete comment" })
    await remove.press("Enter")
    const cancel = confirmation.getByRole("button", { name: "Cancel", exact: true })
    const confirmDelete = confirmation.getByRole("button", { name: "Delete comment" })
    await expect(cancel).toBeFocused()
    await sourcePage.keyboard.press("a")
    await expect(cancel).toBeFocused()
    await sourcePage.keyboard.press("Shift+Tab")
    await expect(confirmDelete).toBeFocused()
    await sourcePage.keyboard.press("Tab")
    await expect(cancel).toBeFocused()
    await cancel.press("Enter")
    await expect(remove).toBeFocused()
    await expect(authorRow).toContainText("Edited linked comment")
    await remove.press("Enter")
    await sourcePage.keyboard.press("Escape")
    await expect(confirmation).toBeHidden()
    await expect(remove).toBeFocused()
    await sourcePage.keyboard.press("a")
    await expect(sourcePage.locator("#td-assigned-to")).toBeFocused()
    await sourcePage.route(mutationUrl, route => route.fulfill({ status: 503 }))
    await remove.press("Enter")
    await confirmDelete.press("Enter")
    await expect(authorRow.getByRole("alert")).toContainText("Could not delete the comment")
    await expect(remove).toBeFocused()
    await sourcePage.unroute(mutationUrl)
    const sibling = list.getByRole("article").filter({ hasText: "Posted while editing" })
    await remove.press("Enter")
    await confirmDelete.press("Space")
    await expect(authorRow).toHaveCount(0)
    await expect(sibling).toBeFocused()
    await page.goto(href)
    await expect(missing).toBeFocused()
    await expect(page.locator("#td-comments")).toContainText("First visible comment")
    await expect(target).toHaveCount(0)

    const started = deferred<void>()
    const release = deferred<void>()
    const search = "Comment link task"
    await page.route(url => url.searchParams.has("boardRefresh") && url.searchParams.get("search") === search, async route => {
      started.resolve()
      await release.promise
      await route.continue()
    })
    await page.evaluate(search => document.dispatchEvent(new CustomEvent("meitheal:filter-change", {
      detail: { view: "kanban", search },
    })), search)
    try {
      await started.promise
      await page.getByRole("button", { name: "Close detail" }).press("Enter")
      await expect.poll(() => new URL(page.url()).searchParams.has("comment")).toBe(false)
    } finally {
      release.resolve()
    }
    await expect.poll(() => new URL(page.url()).searchParams.get("search")).toBe(search)
    expect(new URL(page.url()).searchParams.has("comment")).toBe(false)
    await page.goBack()
    await expect(missing).toBeFocused()
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

test("ticket scoring keeps other lenses and retries a failed save", async ({ page, request, baseURL }) => {
  test.skip(!process.env.E2E_BASE_URL, "Requires a disposable local Meitheal server")
  const origin = new URL(baseURL!).origin
  const headers = { origin, "content-type": "application/json" }
  const created = await request.post("/api/tasks", {
    headers, data: { title: "Ticket scoring retry", framework_payload: JSON.stringify({ ice: { impact: 7, confidence: 8, ease: 9 } }) },
  })
  expect(created.status()).toBe(201)
  const { id } = await created.json()
  await page.goto(`/tasks?open=${id}#kanban`)
  await expect(page).toHaveURL(`${origin}/tickets/${id}`)
  const chooser = page.getByLabel("Scoring framework", { exact: true })
  await expect(chooser).toBeEnabled()
  await chooser.selectOption("rice")
  for (const [field, value] of Object.entries({ Reach: "10", Impact: "2", Confidence: "80", Effort: "0.5" })) {
    await page.getByRole("spinbutton", { name: field, exact: true }).fill(value)
  }
  await expect(page.locator("#se-live-result")).toHaveText("Score: 3200")
  let failNext = true
  await page.route(`**/api/tasks/${id}`, async route => {
    if (route.request().method() === "PUT" && failNext) {
      failNext = false
      await route.fulfill({ status: 503, body: "Unavailable" })
    } else await route.continue()
  })
  await page.getByRole("button", { name: "Save score", exact: true }).click()
  await expect(page.locator("#se-status")).toContainText("Your estimates are still here")
  await expect(page.getByRole("spinbutton", { name: "Effort", exact: true })).toHaveValue("0.5")
  await page.getByRole("button", { name: "Save score", exact: true }).click()
  await expect(page.locator("#se-status")).toHaveText("Evaluation saved.")
  const stored = await request.get(`/api/tasks/${id}`)
  const payload = JSON.parse((await stored.json()).framework_payload)
  expect(payload.ice).toEqual({ impact: 7, confidence: 8, ease: 9 })
  expect(payload.rice.score).toBe(3200)
  await page.reload()
  await expect(page.getByRole("spinbutton", { name: "Effort", exact: true })).toHaveValue("0.5")
  await chooser.selectOption("ice")
  await expect(page.getByRole("spinbutton", { name: "Ease", exact: true })).toHaveValue("9")
})
