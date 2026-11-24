import { expect, test, type APIRequestContext, type Page } from "@playwright/test"
import { currentBoardWriteHeaders } from "../helpers/current-board-http"
import { shouldSkipBrowserSpecs } from "./_helpers"

test.describe("Task Modal WYSIWYG, Properties, and Persistence", () => {
  test.skip(shouldSkipBrowserSpecs(), "Requires MEITHEAL_TEST_BROWSER=1 disposable fixture")
  test.use({ serviceWorkers: "block" })

  async function householdHeaders(request: APIRequestContext, baseURL: string) {
    return currentBoardWriteHeaders(request, "household", { origin: new URL(baseURL).origin })
  }

  async function deleteTask(request: APIRequestContext, headers: Record<string, string>, id: string) {
    await request.delete(`/api/tasks/${id}`, { headers }).catch(() => {})
  }

  async function openTaskCard(page: Page, id: string) {
    const overlay = page.locator("#task-detail-overlay")
    const alreadyOpen = await overlay.evaluate((el, targetId) => el.classList.contains("active") && el.getAttribute("data-open-task-id") === targetId, id).catch(() => false)
    if (!alreadyOpen) {
      const card = page.locator(`.kanban-card[data-id="${id}"]`)
      await expect(card).toBeVisible()
      await card.locator(".card-open-btn").click()
    }
    await expect(overlay).toHaveClass(/active/)
    await expect(overlay).toHaveAttribute("data-open-task-id", id)
    await expect(page.locator("#td-status")).toBeEnabled()
  }

  test("WYSIWYG Tabler toolbar, Markdown lists & Enter continuation, .prose list markers, and HugeRTE Visual direct save in NewTaskModal & TaskDetailModal", async ({ page, request, baseURL }) => {
    const headers = await householdHeaders(request, baseURL!)
    const origin = new URL(baseURL!).origin
    const externalUrls: string[] = []
    page.on("request", req => {
      const url = req.url()
      if ((url.startsWith("http://") || url.startsWith("https://")) && !url.startsWith(origin)) {
        externalUrls.push(url)
      }
    })

    const createdIds: string[] = []
    try {
      await page.goto("/tasks")
      await expect(page.locator("#kanban-shell")).toHaveAttribute("data-kanban-booted", "true")

      await page.evaluate(() => window.openNewTaskModal?.("standard_action"))
      const overlay = page.locator("#new-task-overlay")
      await expect(overlay).toHaveClass(/active/)

      const frame = overlay.locator("#new-task-form .md-editor-frame")
      const toolbar = frame.locator(".md-editor-toolbar")
      const modes = frame.locator(".md-editor-modes")
      await expect(frame).toBeVisible()
      await expect(toolbar.locator('.md-tool-btn[data-md-action="ul"] svg use')).toBeAttached()
      await expect(toolbar.locator('.md-tool-btn[data-md-action="ol"] svg use')).toBeAttached()
      await expect(modes).toHaveAttribute("role", "tablist")

      // Segmented mode switcher sits to the right of formatting toolbar
      const [toolbarBox, modesBox] = await Promise.all([toolbar.boundingBox(), modes.boundingBox()])
      expect(toolbarBox).toBeTruthy()
      expect(modesBox).toBeTruthy()
      expect(modesBox!.x).toBeGreaterThan(toolbarBox!.x)

      // Bullet list button toggle + Enter continuation + empty marker exit
      const desc = overlay.locator("#new-task-desc-input")
      await desc.fill("First item")
      await toolbar.locator('.md-tool-btn[data-md-action="ul"]').click()
      await expect(desc).toHaveValue("- First item")
      await desc.press("End")
      await desc.press("Enter")
      await page.keyboard.type("Second item")
      await desc.press("Enter")
      await desc.press("Enter")
      await expect(desc).toHaveValue("- First item\n- Second item\n")

      // Numbered list button toggle + Enter increments to 2.
      await page.keyboard.type("Number one")
      await toolbar.locator('.md-tool-btn[data-md-action="ol"]').click()
      await desc.press("End")
      await desc.press("Enter")
      await page.keyboard.type("Number two")
      await expect(desc).toHaveValue("- First item\n- Second item\n1. Number one\n2. Number two")

      // Preview renders real disc/decimal markers via .prose
      await modes.locator('button[data-md-mode="preview"]').click()
      const preview = frame.locator(".md-preview-surface.prose")
      await expect(preview.locator("ul li")).toHaveCount(2)
      await expect(preview.locator("ol li")).toHaveCount(2)
      const listStyles = await preview.evaluate(el => {
        const ul = el.querySelector("ul")
        const ol = el.querySelector("ol")
        return {
          ul: ul ? getComputedStyle(ul).listStyleType : "",
          ol: ol ? getComputedStyle(ol).listStyleType : "",
        }
      })
      expect(listStyles).toEqual({ ul: "disc", ol: "decimal" })

      // Fill title before entering cross-document Visual iframe, then submit directly without leaving Visual mode
      await overlay.locator("#new-task-title-input").fill("WYSIWYG Visual Save Task")

      // Switch to Visual mode (self-hosted HugeRTE), type directly in iframe, and submit without switching back
      const hugeRteReq = page.waitForResponse(r => r.url().includes("/vendor/hugerte/hugerte.min.js") && r.status() === 200)
      await modes.locator('button[data-md-mode="visual"]').click()
      expect((await hugeRteReq).status()).toBe(200)
      const hugeRteBody = frame.frameLocator("iframe.tox-edit-area__iframe").locator("body")
      await expect(hugeRteBody).toBeVisible({ timeout: 10_000 })
      await hugeRteBody.click()
      await page.keyboard.press("End")
      await page.keyboard.type(" Visual addition")

      const createReq = page.waitForResponse(r => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/tasks")
      await overlay.locator("#submit-new-task-btn").click()
      const createRes = await createReq
      expect(createRes.status()).toBe(201)
      const created = await createRes.json()
      createdIds.push(created.id)
      expect(created.description).toContain("First item")
      expect(created.description).toContain("Number two")
      expect(created.description).toContain("Visual addition")
      await expect(overlay).not.toHaveClass(/active/)

      // Edit via HugeRTE Visual in TaskDetailModal and save directly
      await openTaskCard(page, created.id)
      await page.locator("#td-desc-preview-container").click()
      const tdFrame = page.locator("#td-desc-edit-container .md-editor-frame")
      await tdFrame.locator('.md-editor-modes button[data-md-mode="visual"]').click()
      const tdVisualBody = tdFrame.frameLocator("iframe.tox-edit-area__iframe").locator("body")
      await expect(tdVisualBody).toBeVisible({ timeout: 10_000 })
      await tdVisualBody.click()
      await page.keyboard.press("End")
      await page.keyboard.type(" Detail edit")

      const savePut = page.waitForResponse(r => r.request().method() === "PUT" && new URL(r.url()).pathname === `/api/tasks/${created.id}`)
      await page.locator("#td-desc-save-btn").click()
      const saveRes = await savePut
      expect(saveRes.status()).toBe(200)
      const updated = await saveRes.json()
      expect(updated.description).toContain("Detail edit")

      await page.reload()
      await openTaskCard(page, created.id)
      await expect(page.locator("#td-description")).toHaveValue(/Detail edit/)
      expect(externalUrls).toEqual([])
    } finally {
      for (const id of createdIds) await deleteTask(request, headers, id)
    }
  })

  test("NewTaskModal Properties, Customize fields, Priority icon containment, empty due_date & stale 409 recovery + TaskDetailModal Pillar/Principle", async ({ page, request, baseURL }) => {
    const headers = await householdHeaders(request, baseURL!)
    const origin = new URL(baseURL!).origin
    const createdIds: string[] = []
    let pillarId = ""
    let areaId = ""

    try {
      const areaRes = await request.post("/api/areas", { headers, data: { name: "Property Test Group" } })
      if (areaRes.ok()) {
        const areaJson = await areaRes.json()
        areaId = areaJson.area?.id ?? areaJson.id ?? ""
      }
      const pillarRes = await request.post("/api/pillars", { headers, data: { name: "Home Care Pillar", audience: "board" } })
      expect(pillarRes.status()).toBe(201)
      pillarId = (await pillarRes.json()).pillar.id
      const principleRes = await request.post(`/api/pillars/${pillarId}/principles`, {
        headers,
        data: { action: "create", statement: "Fix root causes" },
      })
      expect(principleRes.status()).toBe(201)
      const principleId = (await principleRes.json()).principle.id

      await page.goto("/tasks")
      await expect(page.locator("#kanban-shell")).toHaveAttribute("data-kanban-booted", "true")

      await page.evaluate(() => window.openNewTaskModal?.("standard_action"))
      const overlay = page.locator("#new-task-overlay")
      await expect(overlay).toHaveClass(/active/)

      // Wait for catalog load
      await expect(overlay.locator(`#new-task-pillar option[value="${pillarId}"]`)).toBeAttached()

      // Priority icon sits inside select wrap without colliding with adjacent column
      const [wrapBox, iconBox, workTypeBox] = await Promise.all([
        overlay.locator("#nt-priority-field .nt-priority-select-wrap").boundingBox(),
        overlay.locator("#nt-priority-icon").boundingBox(),
        overlay.locator("#nt-task-type-field").boundingBox(),
      ])
      expect(wrapBox && iconBox && workTypeBox).toBeTruthy()
      expect(iconBox!.x).toBeGreaterThanOrEqual(wrapBox!.x - 1)
      expect(iconBox!.x + iconBox!.width).toBeLessThanOrEqual(wrapBox!.x + wrapBox!.width + 1)
      expect(iconBox!.x).toBeGreaterThanOrEqual(workTypeBox!.x + workTypeBox!.width)

      // Customize fields layout toggle hides/restores field
      await overlay.locator("#nt-toggle-layout").click()
      const layoutPanel = overlay.locator("#nt-layout-panel")
      await expect(layoutPanel).toBeVisible()
      await layoutPanel.locator('[data-layout-item="properties"] details summary').first().click()
      const urgVisBtn = layoutPanel.locator('[data-layout-item="urgency"] [data-layout-toggle-vis]')
      await urgVisBtn.click()
      await expect(overlay.locator("#nt-urgency-field")).toBeHidden()
      await urgVisBtn.click()
      await expect(overlay.locator("#nt-urgency-field")).toBeVisible()

      // Set Properties + Scheduling (empty due_date) + Metadata
      await overlay.locator("#new-task-title-input").fill("Full Properties Capture Task")
      await overlay.locator("#new-task-type").selectOption("story")
      await overlay.locator("#new-task-priority").selectOption("2")
      await overlay.locator("#new-task-urgency").selectOption("4")
      await overlay.locator("#new-task-importance").selectOption("5")
      if (areaId) await overlay.locator("#new-task-area").selectOption(areaId)
      await overlay.locator("#new-task-pillar").selectOption(pillarId)
      await expect(overlay.locator(`#new-task-principle option[value="${principleId}"]`)).toBeAttached()
      await overlay.locator("#new-task-principle").selectOption(principleId)
      await overlay.locator("#nt-options summary").click()
      await overlay.locator("#new-task-progress").fill("40")

      let postBodySent: Record<string, unknown> | null = null
      const createReq = page.waitForRequest(req => req.method() === "POST" && new URL(req.url()).pathname === "/api/tasks")
      const createRes = page.waitForResponse(res => res.request().method() === "POST" && new URL(res.url()).pathname === "/api/tasks")
      await overlay.locator("#submit-new-task-btn").click()
      postBodySent = (await createReq).postDataJSON()
      const createdJson = await (await createRes).json()
      expect(createdJson.id).toBeTruthy()
      createdIds.push(createdJson.id)
      expect(Object.hasOwn(postBodySent ?? {}, "due_date")).toBe(false)
      expect(createdJson.task_type).toBe("story")
      expect(createdJson.priority).toBe(2)
      expect(createdJson.urgency).toBe(4)
      expect(createdJson.importance).toBe(5)
      expect(createdJson.progress).toBe(40)
      await expect(overlay).not.toHaveClass(/active/)

      // Verify TaskDetailModal loads Pillar & Principle and persists single-PUT change cleanly
      await openTaskCard(page, createdJson.id)
      await expect(page.locator("#td-pillar")).toHaveValue(pillarId)
      await expect(page.locator("#td-principle")).toHaveValue(principleId)

      const pillarPut = page.waitForResponse(r => r.request().method() === "PUT" && new URL(r.url()).pathname === `/api/tasks/${createdJson.id}`)
      await page.locator("#td-pillar").selectOption("")
      expect((await pillarPut).status()).toBe(200)
      await expect(page.locator("#td-principle")).toHaveValue("")

      const repillarPut = page.waitForResponse(r => r.request().method() === "PUT" && new URL(r.url()).pathname === `/api/tasks/${createdJson.id}`)
      await page.locator("#td-pillar").selectOption(pillarId)
      expect((await repillarPut).status()).toBe(200)
      await expect(page.locator(`#td-principle option[value="${principleId}"]`)).toBeAttached()
      const reprinPut = page.waitForResponse(r => r.request().method() === "PUT" && new URL(r.url()).pathname === `/api/tasks/${createdJson.id}`)
      await page.locator("#td-principle").selectOption(principleId)
      expect((await reprinPut).status()).toBe(200)

      await page.reload()
      await openTaskCard(page, createdJson.id)
      await expect(page.locator("#td-pillar")).toHaveValue(pillarId)
      await expect(page.locator("#td-principle")).toHaveValue(principleId)

      // Stale 409 session refresh recovers on NewTaskModal without showing #nt-create-uncertain
      let rejectedOnce = false
      let refreshedToken = ""
      await page.route(`${origin}/api/boards/*`, async route => {
        const res = await route.fetch()
        refreshedToken = res.headers()["x-meitheal-board-session"] ?? refreshedToken
        await route.fulfill({ response: res })
      })
      await page.route(`${origin}/api/tasks`, async route => {
        if (route.request().method() === "POST" && !rejectedOnce) {
          rejectedOnce = true
          await route.fulfill({
            status: 409,
            contentType: "application/json",
            body: JSON.stringify({ error: "Stale board session" }),
          })
          return
        }
        await route.continue()
      })
      await page.evaluate(() => {
        const meta = document.querySelector<HTMLMetaElement>('meta[name="meitheal-work-session"]')
        if (meta) meta.content = "stale-session-for-test"
        window.openNewTaskModal?.("standard_action")
      })
      await expect(overlay).toHaveClass(/active/)
      await overlay.locator("#new-task-title-input").fill("Recovered 409 Task")
      const retryCreate = page.waitForResponse(r => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/tasks" && r.status() === 201)
      await overlay.locator("#submit-new-task-btn").click()
      const recoveredTask = await (await retryCreate).json()
      createdIds.push(recoveredTask.id)
      await expect(overlay).not.toHaveClass(/active/)
      expect(rejectedOnce).toBe(true)
      expect(refreshedToken).toBeTruthy()
      await page.unroute(`${origin}/api/tasks`)
      await page.unroute(`${origin}/api/boards/*`)
    } finally {
      await page.evaluate(() => localStorage.removeItem("meitheal:task-detail-layout:v1")).catch(() => {})
      for (const id of createdIds) await deleteTask(request, headers, id)
      if (pillarId) await request.delete(`/api/pillars/${pillarId}`, { headers }).catch(() => {})
      if (areaId) await request.delete(`/api/areas/${areaId}`, { headers }).catch(() => {})
    }
  })
})
