import { randomUUID } from "node:crypto"
import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { expect, test } from "@playwright/test"
import { currentBoardWriteHeaders } from "../helpers/current-board-http"

import { launchPinBrowser, startCoreFixture } from "../scripts/task-pins-fixture"

test("Kanban groups Household descendants by named Epic and skips outside-Board ancestry", async () => {
  test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires the disposable packaged fixture")
  const directory = await mkdtemp(join(tmpdir(), "meitheal-kanban-epic-"))
  const fixture = startCoreFixture(directory)
  fixture.stdout?.resume()
  fixture.stderr?.resume()
  let browser

  try {
    const [{ port, configuredPath }] = await once(fixture, "message", { signal: AbortSignal.timeout(10_000) })
    const origin = `https://127.0.0.1:${port}`
    const app = origin + configuredPath
    browser = await launchPinBrowser(directory)
    const context = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: "block" })
    // Use the ingress fixture's origin rather than the default HTTP test fixture.
    await context.setExtraHTTPHeaders({})
    await context.addCookies([{ name: "feedback-fixture", value: "member", url: origin }])
    const page = await context.newPage()
    page.setDefaultTimeout(5_000)
    expect((await page.goto(app + "/fixture"))?.ok()).toBe(true)

    const headers = await currentBoardWriteHeaders(context.request, "household", { origin }, app)
    async function seed(title: string, fields: object = {}) {
      const response = await context.request.post(app + "/api/tasks", {
        headers, data: { title, status: "pending", ...fields },
      })
      expect(response.status(), await response.text()).toBe(201)
      return await response.json() as { id: string; ticket_key: string }
    }

    const epicTitle = "Renovate & repair"
    const privateTitle = "Private planning title"
    const outer = await seed(epicTitle, { task_type: "epic", status: "complete" })
    const inner = await seed(epicTitle, { task_type: "epic", parent_id: outer.id, status: "active" })
    const story = await seed("Preparation story", { task_type: "story", parent_id: inner.id })
    const direct = await seed("Displayed card direct", { parent_id: outer.id })
    const nested = await seed("Displayed card nested", { parent_id: story.id })
    const orphan = await seed("Displayed card with no Epic")
    const blocked = await seed("Displayed card with a private parent")

    // Reproduce an older cross-Board link in the disposable database.
    const privateEpic = randomUUID()
    const privateBoard = randomUUID()
    const privateLane = randomUUID()
    const db = new DatabaseSync(join(directory, "pins.db"))
    try {
      db.prepare(`INSERT INTO task_boards (id, name, visibility, ticket_prefix, ticket_high_water, created_at, updated_at)
        VALUES (?, 'Restricted fixture', 'restricted', 'EPICPRIV', 1, 1, 1)`).run(privateBoard)
      db.prepare(`INSERT INTO kanban_lanes (id, key, label, board_id, created_at, updated_at)
        VALUES (?, 'pending', 'Private lane', ?, 1, 1)`).run(privateLane, privateBoard)
      db.prepare(`INSERT INTO tasks (id, title, task_type, area_id,
        task_board_id, board_column_id, ticket_ref, idempotency_key, request_id, status, created_at, updated_at)
        VALUES (?, ?, 'epic', '__meitheal_no_area__', ?, ?, 'EPICPRIV-1', ?, ?, 'pending', 1, 1)`)
        .run(privateEpic, privateTitle, privateBoard, privateLane, privateEpic, privateEpic)
      db.prepare("UPDATE tasks SET parent_id = ? WHERE id = ?").run(privateEpic, blocked.id)
    } finally {
      db.close()
    }

    await page.goto(app + "/tasks?search=Displayed+card#kanban")
    await expect(page.locator("#kanban-shell")).toHaveAttribute("data-kanban-booted", "true")
    await expect(page.locator("#kanban-board")).toHaveAttribute("data-available", "true")
    await page.locator("#kanban-group-by-dropdown > summary").click()
    await page.getByRole("button", { name: "By Epic", exact: true }).click()
    await expect(page).toHaveURL(url => url.searchParams.get("groupBy") === "epic")

    const board = page.locator("#kanban-board")
    const group = (name: string) => board.locator(`.swimlane-group[data-swimlane-type="${name}"]`)
    for (const [epic, card] of [[outer, direct], [inner, nested]] as const) {
      const heading = group(`epic:${epic.id}`)
      await expect(heading.locator(".swimlane-label")).toHaveText(`${epicTitle} (${epic.ticket_key})`)
      await expect(heading.locator(`.kanban-card[data-id="${card.id}"]`)).toBeVisible()
    }
    const noEpic = group("epic:none")
    await expect(noEpic.locator(".swimlane-label")).toHaveText("No Epic")
    await expect(noEpic.locator(`.kanban-card[data-id="${orphan.id}"]`)).toBeVisible()
    await expect(noEpic.locator(`.kanban-card[data-id="${blocked.id}"]`)).toBeVisible()
    await expect(board.locator(".kanban-card")).toHaveCount(4)

    const raw = await context.request.get(page.url())
    expect(raw.ok()).toBe(true)
    const html = await raw.text()
    for (const privateValue of [privateEpic, privateBoard, privateTitle, "EPICPRIV-1"]) {
      expect(html).not.toContain(privateValue)
    }
    await page.reload()
    await expect(page.locator("#kanban-group-by-label")).toHaveText("By Epic")
    await expect(group(`epic:${inner.id}`).locator(`.kanban-card[data-id="${nested.id}"]`)).toBeVisible()

    const card = board.locator(`.kanban-card[data-id="${nested.id}"] .card-open-btn`)
    const noEpicHeader = noEpic.locator("button.swimlane-header")
    await noEpicHeader.press("Enter")
    await expect(noEpicHeader).toHaveAttribute("aria-expanded", "false")
    await card.click()
    const drawer = page.locator("#task-detail-overlay")
    await expect(drawer.locator("#td-title")).toHaveValue("Displayed card nested")
    await drawer.getByTitle("Remove parent").click()
    const unlink = page.getByRole("alertdialog", { name: "Unlink" })
    const unlinkResponse = page.waitForResponse(response =>
      new URL(response.url()).pathname.endsWith(`/api/tasks/${nested.id}`) && response.request().method() === "PUT",
    )
    await unlink.getByRole("button", { name: "Confirm" }).click()
    expect((await unlinkResponse).ok()).toBe(true)
    await expect(drawer.locator("#td-link-parent-display")).toHaveText("None")
    await drawer.getByRole("button", { name: "Close detail" }).click()
    await expect(noEpic.locator(`.kanban-card[data-id="${nested.id}"]`)).toHaveCount(1)
    await expect(card).toBeHidden()
    await expect(noEpicHeader).toBeFocused()
    await noEpicHeader.press("Space")
    await expect(card).toBeVisible()

    await page.getByRole("navigation", { name: "Task views" }).getByRole("link", { name: "Table" }).click()
    await expect(page.locator("#tasks-view-table")).toBeVisible()
    await expect(page).toHaveURL(url => url.searchParams.get("groupBy") === "epic")
    await page.getByRole("navigation", { name: "Task views" }).getByRole("link", { name: "Kanban" }).click()
    await expect(page).toHaveURL(url => url.searchParams.get("groupBy") === "epic")
    await expect(noEpic.locator(`.kanban-card[data-id="${nested.id}"]`)).toBeVisible()
  } finally {
    await browser?.close()
    if (fixture.exitCode === null && fixture.signalCode === null) {
      const exited = once(fixture, "exit", { signal: AbortSignal.timeout(3_000) })
      fixture.kill("SIGKILL")
      await exited
    }
    await rm(directory, { recursive: true, force: true })
  }
})
