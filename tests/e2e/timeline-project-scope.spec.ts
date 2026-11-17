import type { ChildProcess } from "node:child_process"
import { randomUUID } from "node:crypto"
import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { expect, test, type Browser } from "@playwright/test"
import { launchPinBrowser, startCoreFixture } from "../scripts/task-pins-fixture"

test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires a disposable built app")

test("Timeline shows unavailable projects without revealing their IDs or labels", async () => {
  const work = await mkdtemp(join(tmpdir(), "meitheal-timeline-project-scope-"))
  let child: ChildProcess | undefined
  let browser: Browser | undefined
  try {
    child = startCoreFixture(work)
    child.stdout?.resume()
    child.stderr?.resume()
    const [fixture] = await once(child, "message", { signal: AbortSignal.timeout(10_000) })
    const origin = `https://127.0.0.1:${fixture.port}`
    const app = origin + fixture.configuredPath
    browser = await launchPinBrowser(work)
    const context = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: "block" })
    await context.setExtraHTTPHeaders({})
    await context.addCookies([{ name: "feedback-fixture", value: "member", url: origin }])
    async function create(path: string, data: object): Promise<string> {
      const response = await context.request.post(app + path, { headers: { origin }, data })
      expect(response.status(), await response.text()).toBe(201)
      return (await response.json() as { id: string }).id
    }

    const retiredTitle = "Retired project title"
    const retiredProject = await create("/api/projects", { title: retiredTitle })
    const missingProject = randomUUID()
    const start = Date.now()
    const dates = {
      start_date: new Date(start).toISOString().slice(0, 10),
      due_date: new Date(start + 86_400_000).toISOString().slice(0, 10),
    }
    const prefix = "Timeline catalog scope"
    const retiredTask = await create("/api/tasks", { ...dates, title: `${prefix} retired`, project_id: retiredProject })
    const danglingTask = await create("/api/tasks", { ...dates, title: `${prefix} missing` })
    const db = new DatabaseSync(join(work, "pins.db"))
    try {
      // The public project lifecycle clears associations. Seed legacy references directly.
      expect(db.prepare("UPDATE projects SET retired_at = ? WHERE id = ?").run(start, retiredProject).changes).toBe(1)
      expect(db.prepare("UPDATE tasks SET project_id = ? WHERE id = ?").run(missingProject, danglingTask).changes).toBe(1)
    } finally {
      db.close()
    }

    const page = await context.newPage()
    const query = new URLSearchParams({ view: "timeline", search: prefix, area: "", groupBy: "project" })
    await page.goto(`${app}/tasks?${query}#timeline`)
    const data = (await page.locator("#timeline-data").textContent())!
    const labels = (await page.locator("#timeline-projects").textContent())!
    for (const value of [retiredProject, retiredTitle, missingProject]) {
      expect(data).not.toContain(value)
      expect(labels).not.toContain(value)
    }
    const tasks = JSON.parse(data) as { id: string; project_group: string }[]
    for (const id of [retiredTask, danglingTask]) {
      const task = tasks.find(task => task.id === id)
      expect(task?.project_group).toBe("unavailable-project")
      expect(task).not.toHaveProperty("project_id")
      await expect(page.locator(`.gantt-bar[data-task-id="${id}"]`)).toBeVisible()
    }
    const paneToggle = page.getByRole("button", { name: "Task pane" })
    await expect(paneToggle).toBeEnabled()
    if (await paneToggle.getAttribute("aria-expanded") === "false") await paneToggle.press("Enter")
    await expect(page.getByRole("heading", { name: "Group: Unknown Project", exact: true })).toBeVisible()
  } finally {
    await browser?.close()
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit", { signal: AbortSignal.timeout(3_000) })
      child.kill("SIGTERM")
      await exited
    }
    await rm(work, { recursive: true, force: true })
  }
})
