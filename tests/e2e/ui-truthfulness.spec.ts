import { expect, test } from "@playwright/test"
import { shouldSkipBrowserSpecs } from "./_helpers"

test.describe("UI truthfulness and resilience", () => {
  test.skip(shouldSkipBrowserSpecs(), "Set E2E_BASE_URL to run browser specs")

  test("task controls update the visible form and failed creation retains edits", async ({ page }) => {
    await page.goto("/dev/ui-truthfulness?data=worst&save=fail")
    await page.waitForFunction(() => typeof window.openNewTaskModal === "function")
    await page.evaluate(() => window.openNewTaskModal?.())
    await page.locator('[data-kind="checklist"]').click()
    await expect(page.locator("#new-task-kind")).toHaveValue("checklist")
    await expect(page.locator("#nt-contextual-checklist")).toBeVisible()
    await page.locator("#new-task-title-input").fill("Prepare the heating service checklist")
    await page.locator("#nt-checklist-builder-input").fill("Photograph the controller wiring before disconnecting it")
    await page.locator("#nt-checklist-builder-input").press("Enter")
    await expect(page.locator("#nt-checklist-items-container")).toContainText("Photograph the controller")
    await page.locator("#nt-priority-dropdown .filter-pill").click()
    await page.locator('#nt-priority-dropdown [data-value="2"]').click()
    await expect(page.locator("#new-task-priority")).toHaveValue("2")
    await page.locator("#submit-new-task-btn").click()
    await expect(page.locator("#submit-new-task-btn")).toBeEnabled()
    await expect(page.locator("#new-task-title-input")).toHaveValue("Prepare the heating service checklist")
    await expect(page.locator("#new-task-overlay")).toHaveClass(/active/)
    await expect(page.getByText("Fixture: service unavailable. Retry when connected.")).toBeVisible()
    await expect(page.locator('[aria-label="Attach file"]')).toHaveCount(0)
    await expect(page.locator("#nt-is-routine, #nt-ai-handoff")).toHaveCount(0)
    await page.locator("#cancel-new-task").click()
    await expect(page.locator("#new-task-overlay")).not.toHaveClass(/active/)
    await page.evaluate(() => window.openNewTaskModal?.())
    await expect(page.locator("#new-task-title-input")).toHaveValue("")
    await expect(page.locator("#nt-checklist-items-container")).toBeEmpty()
  })

  test("zero assignees leaves goals accessible", async ({ page }) => {
    await page.route("**/api/users", route => route.fulfill({ json: { users: [], default_assignee: null } }))
    await page.goto("/today")
    await page.waitForFunction(() => typeof window.openNewTaskModal === "function")
    await page.evaluate(() => window.openNewTaskModal?.())
    await expect(page.locator("#new-task-assigned-to")).toBeDisabled()
    await expect(page.locator("#new-task-goal")).toBeVisible()
    await expect(page.locator("#new-task-title-input")).toHaveAttribute("maxlength", "500")
  })

  test("rejected settings writes never announce success and can be retried", async ({ page }) => {
    await page.goto("/dev/ui-truthfulness?data=worst&save=fail#workflow-settings")
    await page.locator("#save-backlog-mode").click()
    await expect(page.getByText("Could not save changes. Check your connection and permissions, then retry.").first()).toBeVisible()
    await expect(page.getByText("Backlog mode saved — reload Kanban to apply", { exact: true })).toHaveCount(0)
    await page.locator("#save-backlog-mode").click()
    await expect(page.locator("#save-backlog-mode")).toBeEnabled()
  })

  test("Assist rejects failed saves and approval limits are explicit", async ({ page }) => {
    await page.goto("/dev/ui-truthfulness?data=worst&save=fail#automation-ai-settings")
    await expect(page.getByText(/Claims last five minutes/)).toBeVisible()
    await expect(page.locator("input#bot-auto-accept, input#bot-lock-timeout")).toHaveCount(0)
    await page.locator("#save-ha-agent").click()
    await expect(page.locator("#save-ha-agent")).toBeEnabled()
    await expect(page.getByText(/Failed to save agent setting/).first()).toBeVisible()
  })

  test("shared settings save helper reports failure and restores the button", async ({ page }) => {
    await page.goto("/dev/ui-truthfulness?data=worst&save=fail#automation-ai-settings")
    await page.locator("#save-ai").click()
    await expect(page.locator("#save-ai")).toBeEnabled()
    await expect(page.locator("#toast-container .toast.error").first()).toBeVisible()
    await expect(page.locator("#toast-container .toast.success")).toHaveCount(0)
  })

  test("Assist uses the canonical preference and preserves an explicit empty selection", async ({ page }) => {
    let canonical: string | null = ""
    let sentAgent: string | undefined
    await page.route("**/api/**", async route => {
      const url = new URL(route.request().url())
      if (url.pathname === "/api/settings") {
        const key = url.searchParams.get("key")
        await route.fulfill({ json: key ? { value: key === "ha-assist-agent" ? canonical : key === "ha-agent-id" ? "legacy-agent" : null } : {} })
      } else if (url.pathname === "/api/tasks/ui-agent-test") {
        await route.fulfill({ json: { id: "ui-agent-test", title: "Heating service", status: "pending" } })
      } else if (url.pathname === "/api/ha/assist") {
        sentAgent = route.request().postDataJSON().agent_id
        await route.fulfill({ json: { speech: "Ready" } })
      } else await route.fulfill({ json: { users: [], habits: [], pillars: [] } })
    })
    await page.goto("/today")
    async function ask() {
      await page.evaluate(async () => {
        const source = "/src/domains/ai/ai-context-service.ts"
        const service = await import(/* @vite-ignore */ source)
        await service.askAIForTask("ui-agent-test")
      })
    }
    await ask()
    expect(sentAgent).toBeUndefined()
    canonical = "selected-agent"
    await ask()
    expect(sentAgent).toBe("selected-agent")
    canonical = null
    await ask()
    expect(sentAgent).toBe("legacy-agent")
  })

  test("320px long realistic data keeps modal actions inside the dialog", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 812 })
    await page.goto("/dev/ui-truthfulness?data=worst")
    await page.waitForFunction(() => typeof window.openNewTaskModal === "function")
    await page.evaluate(() => window.openNewTaskModal?.())
    await page.locator('[data-kind="shopping_item"]').click()
    const bounds = await page.locator("#new-task-overlay .modal-content").boundingBox()
    expect(bounds).not.toBeNull()
    for (const selector of ["#close-new-task-modal", "#submit-new-task-btn", "#cancel-new-task"]) {
      const box = await page.locator(selector).boundingBox()
      expect(box).not.toBeNull()
      expect(box!.x).toBeGreaterThanOrEqual(bounds!.x)
      expect(box!.x + box!.width).toBeLessThanOrEqual(bounds!.x + bounds!.width + 1)
    }
    const status = await page.locator("#nt-status-pills").evaluate(el => ({ width: el.clientWidth, scroll: el.scrollWidth }))
    expect(status.scroll).toBeLessThanOrEqual(status.width + 1)
    await page.evaluate(() => document.documentElement.style.fontSize = "200%")
    await page.locator("#cancel-new-task").click()
    await expect(page.locator("#new-task-overlay")).not.toHaveClass(/active/)
  })
})
