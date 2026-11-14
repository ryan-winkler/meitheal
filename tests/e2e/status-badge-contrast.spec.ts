import AxeBuilder from "@axe-core/playwright"
import { expect, test, type Page } from "@playwright/test"
import { STATUS } from "../../apps/web/src/lib/status-config"
import { shouldSkipBrowserSpecs } from "./_helpers"

async function checkContrast(page: Page, selectors: string[], state: string) {
  const audit = new AxeBuilder({ page }).withRules(["color-contrast"])
  for (const selector of selectors) audit.include(selector)
  const { violations, passes } = await audit.analyze()
  const failures = violations.flatMap(({ nodes }) => nodes.map(({ target, failureSummary }) => ({ target, failureSummary })))
  expect.soft(failures, state).toEqual([])
  expect.soft(passes.find(({ id }) => id === "color-contrast")?.nodes ?? [], state).toHaveLength(selectors.length)
}

for (const theme of ["light", "dark"] as const) {
  test(`task status badges stay readable in ${theme} theme on task routes and on hover`, async ({ page, request, baseURL }) => {
    test.skip(shouldSkipBrowserSpecs(), "Requires a disposable Meitheal fixture")
    const headers = { origin: new URL(baseURL!).origin }
    const project = await request.post("/api/projects", { headers, data: { title: "Status badge contrast project" } })
    expect(project.status(), await project.text()).toBe(201)
    const { id: projectId } = await project.json()
    const tasks: Array<{ id: string; label: string; open: boolean }> = []

    try {
      const dueDate = new Date().toISOString().slice(0, 10)
      for (const [status, label] of [[STATUS.BACKLOG, "Backlog"], [STATUS.PENDING, "Todo"], [STATUS.ACTIVE, "In Progress"], [STATUS.COMPLETE, "Done"]] as const) {
        const task = await request.post("/api/tasks", {
          headers,
          data: { title: `Status badge contrast: ${label}`, status, due_date: dueDate, urgency: 5, importance: 5, project_id: projectId },
        })
        expect(task.status(), await task.text()).toBe(201)
        tasks.push({ id: (await task.json()).id, label, open: status !== STATUS.COMPLETE })
      }

      await page.emulateMedia({ reducedMotion: "reduce" })
      await page.addInitScript(value => localStorage.setItem("meitheal-theme", value), theme)
      for (const [path, row, includeDone] of [
        ["/today", "#today-work .tli", false],
        ["/eisenhower", "#eisenhower-matrix .tli", false],
        ["/upcoming", "#upcoming-next .task-item", false],
        [`/projects/${projectId}#tasks`, ".project-task-item", true],
      ] as const) {
        await page.mouse.move(0, 0)
        await page.goto(path)
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme)
        await page.evaluate(() => document.fonts.ready)

        const badges = tasks.filter(task => includeDone || task.open).map(({ id, label }) => ({
          selector: `${row}[data-id="${id}"] .status-badge`,
          label,
        }))
        for (const { selector, label } of badges) {
          await expect(page.locator(selector)).toBeVisible()
          await expect(page.locator(selector)).toHaveText(label)
        }
        if (includeDone) {
          const doneRow = page.locator(row).filter({ has: page.locator(".status-badge", { hasText: "Done" }) })
          await expect(doneRow.locator(".task-title-text")).toHaveCSS("text-decoration-line", "line-through")
        }
        await checkContrast(page, badges.map(({ selector }) => selector), `${path} normal`)

        for (const { selector, label } of badges) {
          const badge = page.locator(selector)
          const initialFill = await badge.evaluate(element => getComputedStyle(element).backgroundColor)
          await badge.hover()
          await expect.poll(() => badge.evaluate((element, fill) => element.matches(":hover") &&
            getComputedStyle(element).backgroundColor !== fill, initialFill)).toBe(true)
          await checkContrast(page, [selector], `${path} ${label} hover`)
        }
      }
    } finally {
      for (const { id } of tasks) await request.delete(`/api/tasks/${id}`, { headers })
      await request.delete(`/api/projects/${projectId}`, { headers })
    }
  })
}

for (const theme of ["light", "dark"] as const) {
  test(`completed goals and unlocked achievement dates stay readable in ${theme} theme`, async ({ page, request, baseURL }) => {
    test.skip(shouldSkipBrowserSpecs(), "Requires a disposable Meitheal fixture")
    const headers = { origin: new URL(baseURL!).origin }
    const goal = await request.post("/api/goals", { headers, data: { title: `Completed goal contrast ${theme}` } })
    expect(goal.status(), await goal.text()).toBe(201)
    const { id: goalId } = await goal.json()
    const task = await request.post("/api/tasks", { headers, data: { title: `Achievement contrast ${theme}` } })
    expect(task.status(), await task.text()).toBe(201)
    const { id: taskId } = await task.json()
    try {
      expect((await request.put(`/api/goals/${goalId}`, { headers, data: { status: "completed" } })).ok()).toBe(true)
      expect((await request.put(`/api/tasks/${taskId}`, { headers, data: { status: STATUS.COMPLETE } })).ok()).toBe(true)
      await page.addInitScript(value => localStorage.setItem("meitheal-theme", value), theme)

      await page.goto("/goals")
      const badge = `.goal-card[data-goal-id="${goalId}"] .goal-status-badge`
      await expect(page.locator(badge)).toBeVisible()
      await checkContrast(page, [badge], `/goals ${theme}`)

      await page.goto("/gamification")
      await expect(page.locator(".gam-achievement-card__date").first()).toBeVisible()
      await checkContrast(page, [".gam-achievement-card__date"], `/gamification ${theme}`)
    } finally {
      await request.delete(`/api/goals/${goalId}`, { headers })
      await request.delete(`/api/tasks/${taskId}`, { headers })
    }
  })
}
