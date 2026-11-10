import { execFileSync, fork } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, test } from "@playwright/test"

const web = fileURLToPath(new URL("../../apps/web", import.meta.url))
const fixture = fileURLToPath(new URL("../scripts/feedback-ingress-fixture.mjs", import.meta.url))

test("reactions load on demand through ingress and update only rendered card counts", async ({ browser }) => {
  test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires a built app and the ingress fixture")
  test.slow()
  const work = await mkdtemp(join(tmpdir(), "meitheal-reaction-ui-"))
  const env = {
    PATH: process.env.PATH,
    NODE_ENV: "production",
    SUPERVISOR_TOKEN: "reaction-ui-fixture-only",
    MEITHEAL_DB_URL: `file:${join(work, "meitheal.db")}`,
  }
  const owner = await browser.newContext({ extraHTTPHeaders: {}, serviceWorkers: "block", reducedMotion: "reduce" })
  const member = await browser.newContext({ extraHTTPHeaders: {}, serviceWorkers: "block" })
  let server: ReturnType<typeof fork> | undefined
  let releaseStaleRequest: () => void = () => undefined
  try {
    execFileSync(process.execPath, ["scripts/migrate.mjs"], { cwd: web, env })
    execFileSync(process.execPath, ["--input-type=module", "-e", `
      import { createClient } from "@libsql/client"
      const client = createClient({ url: process.env.MEITHEAL_DB_URL })
      await client.batch(Array.from({ length: 26 }, (_, index) => {
        const id = "reaction-ui-page-" + index
        return {
          sql: "INSERT INTO tasks (id, title, status, idempotency_key, request_id, created_at, updated_at) VALUES (?, ?, 'active', ?, ?, ?, ?)",
          args: [id, "Paging fixture " + index, id, id, 1700000000000 + index, 1700000000000 + index],
        }
      }))
      client.close()
    `], { cwd: web, env })
    const child = fork(fixture, { cwd: web, env, stdio: ["ignore", "ignore", "inherit", "ipc"] })
    server = child
    const [info] = await Promise.race([
      once(child, "message", { signal: AbortSignal.timeout(10_000) }),
      once(child, "exit").then(([code]) => { throw new Error(`Ingress fixture exited with ${code}`) }),
    ])
    const origin = `http://127.0.0.1:${info.port}`
    const entry = origin + info.configuredPath
    const headers = { origin, "sec-fetch-site": "same-origin" }
    await owner.addCookies([{ name: "feedback-fixture", value: "admin", url: origin }])
    await member.addCookies([{ name: "feedback-fixture", value: "member", url: origin }])

    const title = "Reaction interaction fixture"
    const task = await owner.request.post(entry + "/api/tasks", { headers, data: { title, status: "active" } })
    expect(task.status()).toBe(201)
    const { id } = await task.json()
    const taskApi = `${entry}/api/tasks/${id}`
    const postComment = async (content: string) => {
      const comment = await owner.request.post(taskApi + "/comments", { headers, data: { content } })
      expect(comment.status()).toBe(201)
      return (await comment.json()).id as number
    }
    const commentId = await postComment("First reaction target")
    const otherCommentId = await postComment("Second reaction target")
    const cardApi = taskApi + "/reactions"
    const commentApi = `${taskApi}/comments/${commentId}/reactions`
    const staleApi = `${taskApi}/comments/${otherCommentId}/reactions`
    const countsApi = `${entry}/api/tasks/reaction-counts`

    const page = await owner.newPage()
    const detailRequests: string[] = []
    page.on("request", request => {
      if (/\/reactions(?:\/|$)/.test(new URL(request.url()).pathname)) detailRequests.push(request.url())
    })
    const countsResponse = () => page.waitForResponse(response => response.url().startsWith(countsApi + "?"))
    const visibleCardIds = () => page.locator("#kanban-board .kanban-card[data-id]").evaluateAll(cards =>
      [...new Set(cards.map(card => (card as HTMLElement).dataset.id))].sort())
    const requestedIds = (url: string) => new URL(url).searchParams.get("ids")?.split(",").sort()
    const initialCounts = countsResponse()
    await page.goto(entry + "/tasks")
    const firstBatch = await initialCounts
    expect(firstBatch.status()).toBe(200)
    const firstPageIds = await visibleCardIds()
    expect(firstPageIds).toHaveLength(25)
    expect(requestedIds(firstBatch.url())).toEqual(firstPageIds)
    const card = page.locator(`.kanban-card[data-id="${id}"]`)
    const badge = card.locator("[data-kanban-reaction-count]")
    await expect(badge).toBeHidden()
    const openCard = card.getByRole("button", { name: /^Task: Reaction interaction fixture,/ })
    await openCard.press("Enter")
    const detail = page.getByRole("dialog", { name: `Task detail: ${title}` })
    const taskPanel = detail.locator('[data-reaction-panel="task"]')
    const commentPanel = detail.locator(`#td-comment-${commentId} [data-reaction-panel]`)
    await expect(commentPanel.locator("summary")).toHaveText("Comment reactions")
    expect(detailRequests).toEqual([])

    await taskPanel.locator("summary").press("Enter")
    const input = taskPanel.getByRole("textbox", { name: "Emoji or short text" })
    await expect(input).toBeVisible()
    expect(detailRequests).toEqual([cardApi])
    let failPost = true
    await page.route(cardApi, route => {
      if (route.request().method() !== "POST" || !failPost) return route.continue()
      failPost = false
      return route.fulfill({ status: 503 })
    })
    const literalText = "<b>Done</b>"
    await input.fill(literalText)
    await input.press("Enter")
    await expect(taskPanel.getByRole("alert")).toHaveText("Could not add the reaction. Try again.")
    await expect(input).toHaveValue(literalText)
    await expect(input).toBeFocused()
    await input.press("Enter")
    await expect(taskPanel.getByRole("listitem")).toContainText(literalText)
    await expect(taskPanel.getByRole("listitem").locator("b")).toHaveCount(0)
    await expect(taskPanel.getByRole("button", { name: "Remove reaction: <b>Done</b>" })).toBeVisible()
    await expect(input).toHaveValue("")
    await expect(badge).toHaveAccessibleName("Reactions: 1")

    await commentPanel.locator("summary").press("Enter")
    const emoji = commentPanel.getByRole("button", { name: "👍", exact: true })
    await emoji.press("Enter")
    const commentInput = commentPanel.getByRole("textbox", { name: "Emoji or short text" })
    await expect(commentInput).toBeFocused()
    await expect(commentInput).toHaveValue("👍")
    await commentInput.press("Enter")
    await expect(commentPanel.getByRole("listitem")).toContainText("👍")
    await expect(badge).toHaveAccessibleName("Reactions: 1")
    expect(detailRequests.filter(url => url.startsWith(staleApi))).toEqual([])

    const otherPage = await member.newPage()
    await otherPage.setViewportSize({ width: 390, height: 844 })
    await otherPage.goto(`${entry}/tasks?open=${id}`)
    const otherTaskPanel = otherPage.locator('[data-reaction-panel="task"]')
    const otherCommentPanel = otherPage.locator(`#td-comment-${commentId} [data-reaction-panel]`)
    await otherTaskPanel.locator("summary").press("Enter")
    await otherPage.locator("#td-sidebar-toggle").press("Enter")
    await otherCommentPanel.locator("summary").press("Enter")
    await expect(otherTaskPanel.getByRole("listitem")).toContainText(literalText)
    await expect(otherCommentPanel.getByRole("listitem")).toContainText("👍")
    await expect(otherPage.locator("[data-reaction-remove]")).toHaveCount(0)
    await expect(otherTaskPanel.getByRole("listitem").locator("bdi").last()).not.toBeEmpty()

    await taskPanel.getByRole("button", { name: "Remove reaction: <b>Done</b>" }).press("Enter")
    await expect(taskPanel.getByRole("status")).toHaveText("Reaction removed.")
    await expect(taskPanel.locator("summary")).toBeFocused()
    await expect(badge).toBeHidden()

    const staleRequest = page.waitForRequest(staleApi)
    const held = new Promise<void>(resolve => { releaseStaleRequest = resolve })
    await page.route(staleApi, async route => {
      await held
      await route.fulfill({
        json: { reactions: [{ id: 999, content: "Stale fixture", author: "Old panel", can_manage: true }], next_cursor: null, can_react: true },
      }).catch(() => undefined)
    })
    await detail.locator(`#td-comment-${otherCommentId} [data-reaction-panel] summary`).click()
    await staleRequest
    await detail.getByRole("button", { name: "Close detail" }).press("Enter")
    await expect(detail).toBeHidden()
    await expect(openCard).toBeFocused()
    releaseStaleRequest()
    await openCard.press("Enter")
    await expect(detail.locator("#td-title")).toHaveValue(title)
    await expect(detail.getByText("Stale fixture", { exact: true })).toHaveCount(0)
    await detail.getByRole("button", { name: "Close detail" }).press("Enter")

    const nextCounts = countsResponse()
    await page.locator('.kanban-column[data-status="active"]').getByRole("link", { name: "Next" }).click()
    const secondBatch = await nextCounts
    const secondPageIds = await visibleCardIds()
    expect(secondPageIds).toHaveLength(2)
    expect(secondPageIds.every(cardId => !firstPageIds.includes(cardId))).toBe(true)
    expect(requestedIds(secondBatch.url())).toEqual(secondPageIds)
    expect(detailRequests.every(url => url.startsWith(entry + "/api/tasks/"))).toBe(true)
  } finally {
    releaseStaleRequest()
    await owner.close()
    await member.close()
    if (server && server.exitCode === null && server.signalCode === null) {
      const exited = once(server, "exit")
      server.kill()
      await exited
    }
    await rm(work, { recursive: true, force: true })
  }
})
