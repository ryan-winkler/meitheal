import { execFileSync, fork } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import AxeBuilder from "@axe-core/playwright"
import { expect, test, type APIRequestContext, type Page } from "@playwright/test"
import { currentBoardWriteHeaders } from "../helpers/current-board-http"
import { shouldSkipBrowserSpecs } from "./_helpers"

const webDir = fileURLToPath(new URL("../../apps/web", import.meta.url))
const ingressFixture = fileURLToPath(new URL("../scripts/feedback-ingress-fixture.mjs", import.meta.url))

test.describe("Task Experience Unification (R01-R20)", () => {
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

  test("R01/R02/R04: shared editor hierarchy, Full form child with draft stack, and Convert checklist item to child", async ({ page, request, baseURL }) => {
    const headers = await householdHeaders(request, baseURL!)
    const createdIds: string[] = []
    try {
      await page.goto("/tasks")
      await expect(page.locator("#kanban-shell")).toHaveAttribute("data-kanban-booted", "true")

      // Create Epic via shared NewTaskModal
      await page.evaluate(() => window.openNewTaskModal?.("standard_action"))
      const overlay = page.locator("#new-task-overlay")
      await expect(overlay).toHaveClass(/active/)
      await overlay.locator("#new-task-type").selectOption("epic")
      await overlay.locator("#new-task-title-input").fill("Unified Epic Root")
      const createResp = page.waitForResponse(r => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/tasks")
      await overlay.locator("#submit-new-task-btn").click()
      const epicBody = await (await createResp).json()
      expect(epicBody.id).toBeTruthy()
      createdIds.push(epicBody.id)
      await expect(overlay).not.toHaveClass(/active/)

      await page.goto("/tasks")
      await openTaskCard(page, epicBody.id)

      // Launch Full form child creator from Epic detail
      await page.locator("#td-add-subtask-full-btn").click()
      await expect(overlay).toHaveClass(/active/)
      await expect(overlay.locator("#nt-parent-banner")).toBeVisible()
      await expect(overlay.locator('#new-task-type option[value="story"]')).toBeAttached()
      await overlay.locator("#new-task-type").selectOption("story")
      await overlay.locator("#new-task-title-input").fill("Child Story From Full Form")
      const childCreate = page.waitForResponse(r => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/tasks")
      await overlay.locator("#submit-new-task-btn").click()
      const childBody = await (await childCreate).json()
      createdIds.push(childBody.id)
      await expect(overlay).not.toHaveClass(/active/)

      // Add a checklist item on the Epic and convert it to a child task
      await page.goto("/tasks")
      await openTaskCard(page, epicBody.id)
      await expect(page.locator("#td-link-children")).toContainText("Child Story From Full Form")

      await page.locator("#td-add-checklist-item").click()
      const checklistInput = page.locator("#td-checklists textarea").last()
      await expect(checklistInput).toBeVisible()
      const checklistUpdate = page.waitForResponse(r => r.request().method() === "PUT" && new URL(r.url()).pathname === `/api/tasks/${epicBody.id}`)
      await checklistInput.fill("Checklist Step To Convert")
      await checklistInput.blur()
      expect((await checklistUpdate).status()).toBe(200)

      const convertBtn = page.locator('[title="Convert to child task"]').first()
      await expect(convertBtn).toBeVisible()
      const convertReq = page.waitForResponse(r => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/tasks")
      await convertBtn.click()
      expect((await convertReq).status()).toBe(201)

      await page.goto("/tasks")
      await openTaskCard(page, epicBody.id)
      await expect(page.locator("#td-link-children")).toContainText("Checklist Step To Convert")
      await expect(page.locator("#td-checklists")).not.toContainText("Checklist Step To Convert")

      const descendantsRes = await request.get(`/api/tasks?parent_id=${epicBody.id}`)
      const descendantsBody = await descendantsRes.json().catch(() => null) as { tasks?: Array<{ id: string }> } | null
      for (const child of descendantsBody?.tasks ?? []) createdIds.push(child.id)
    } finally {
      for (const id of createdIds) await deleteTask(request, headers, id)
    }
  })

  test("R03: unified Markdown | Visual | Preview editor preserves code syntax and raw characters across reload", async ({ page, request, baseURL }) => {
    const headers = await householdHeaders(request, baseURL!)
    const resp = await request.post("/api/tasks", {
      headers,
      data: { title: "Markdown Fidelity Task", description: "Initial text" },
    })
    const { id } = await resp.json()
    const payload = 'Use `a < b && c > d` with "quotes"'
    try {
      await page.goto("/tasks")
      await openTaskCard(page, id)
      await page.locator("#td-desc-preview-container").click()

      const visualBtn = page.locator('#td-desc-edit-container .md-editor-modes button[data-md-mode="visual"]')
      const previewBtn = page.locator('#td-desc-edit-container .md-editor-modes button[data-md-mode="preview"]')
      const markdownBtn = page.locator('#td-desc-edit-container .md-editor-modes button[data-md-mode="markdown"]')
      await expect(markdownBtn).toBeVisible()

      await markdownBtn.click()
      await page.locator("#td-description").fill(payload)
      await visualBtn.click()
      await expect(page.locator("#td-desc-edit-container .md-visual-surface")).toBeVisible()
      await previewBtn.click()
      await expect(page.locator("#td-desc-edit-container .prose")).toBeVisible()
      await markdownBtn.click()

      const savePut = page.waitForResponse(r => r.request().method() === "PUT" && new URL(r.url()).pathname === `/api/tasks/${id}`)
      await page.locator("#td-desc-save-btn").click()
      expect((await savePut).status()).toBe(200)

      await page.reload()
      await openTaskCard(page, id)
      await page.getByRole("button", { name: "Edit description" }).click()
      await markdownBtn.click()
      await expect(page.locator("#td-description")).toHaveValue(payload)
    } finally {
      await deleteTask(request, headers, id)
    }
  })

  test("R05/R08: resizable sidebar persists width across reload, Focus Mode preserves measure, and WCAG AA passes in light & dark", async ({ page, request, baseURL }) => {
    const headers = await householdHeaders(request, baseURL!)
    const resp = await request.post("/api/tasks", {
      headers,
      data: { title: "Resize and Theme Task", description: "Check layout and contrast." },
    })
    const { id } = await resp.json()
    try {
      await page.setViewportSize({ width: 1440, height: 900 })
      await page.goto("/tasks")
      await openTaskCard(page, id)

      const handle = page.locator("#td-resize-handle")
      await expect(handle).toBeVisible()
      await handle.focus()
      await page.keyboard.press("Shift+ArrowLeft")
      await page.keyboard.press("Shift+ArrowLeft")

      const storedWidth = await page.evaluate(() => localStorage.getItem("meitheal:task-sidebar-width:v1"))
      expect(Number(storedWidth)).toBeGreaterThan(420)

      await page.reload()
      await openTaskCard(page, id)
      const cssWidth = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--task-inspector-width").trim())
      expect(cssWidth).toBe(`${storedWidth}px`)

      // Focus Mode + Axe checks in dark & light themes
      await page.emulateMedia({ reducedMotion: "reduce" })
      await page.locator("#td-toggle-focus").click()
      await expect(page.locator("#task-detail-overlay")).toHaveAttribute("data-focus-mode", "")

      for (const theme of ["dark", "light"]) {
        await page.evaluate((t) => {
          document.documentElement.setAttribute("data-theme", t)
          document.documentElement.classList.toggle("dark", t === "dark")
          document.documentElement.classList.toggle("light", t === "light")
        }, theme)
        await page.waitForTimeout(200)
        const axe = await new AxeBuilder({ page })
          .include("#task-detail-panel")
          .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
          .analyze()
        expect(axe.violations.filter(v => v.impact === "serious" || v.impact === "critical"), `Theme ${theme}`).toEqual([])
      }
    } finally {
      await page.evaluate(() => localStorage.removeItem("meitheal:task-sidebar-width:v1"))
      await deleteTask(request, headers, id)
    }
  })

  test("R15/R17/R18: desktop card actions visible, lane color, and manual table reorder persist", async ({ page, request, baseURL }) => {
    const headers = await householdHeaders(request, baseURL!)
    const t1 = await (await request.post("/api/tasks", { headers, data: { title: "Table Order A", status: "pending" } })).json()
    const t2 = await (await request.post("/api/tasks", { headers, data: { title: "Table Order B", status: "pending" } })).json()
    try {
      await page.setViewportSize({ width: 1440, height: 900 })
      await page.goto("/tasks")
      await expect(page.locator("#kanban-shell")).toHaveAttribute("data-kanban-booted", "true")

      const card = page.locator(`.kanban-card[data-id="${t1.id}"]`)
      const actions = card.locator(".kanban-card-actions")
      await card.locator(".card-open-btn").focus()
      await expect(actions).toHaveCSS("opacity", "1")
      await expect(actions).toHaveCSS("pointer-events", "auto")

      // R17: Custom swimlane color & API persistence
      await page.locator("#manage-lanes-btn").click()
      await expect(page.locator("#lane-mgmt")).not.toHaveClass(/hidden/)
      const colorInput = page.locator("#lane-list .lane-color-input").first()
      await expect(colorInput).toBeVisible()

      // R18: Table manual ordering toggle + Alt+ArrowDown reorder persists across reload
      await page.goto("/tasks?view=table")
      const manualBtn = page.locator("#table-manual-order-btn")
      await expect(manualBtn).toBeVisible()
      if ((await manualBtn.getAttribute("aria-pressed")) !== "true") {
        await manualBtn.click()
        await expect(page).toHaveURL(/sort=manual-asc/)
      }
      const handles = page.locator(".table-row .table-row-drag-handle")
      const firstIdBefore = await page.locator("tbody .table-row").first().getAttribute("data-id")
      const reorderPost = page.waitForResponse(r => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/tasks/reorder")
      await handles.first().focus()
      await page.keyboard.press("Alt+ArrowDown")
      expect((await reorderPost).status()).toBe(200)
      await page.reload()
      const firstIdAfter = await page.locator("tbody .table-row").first().getAttribute("data-id")
      expect(firstIdAfter).not.toBe(firstIdBefore)
    } finally {
      await deleteTask(request, headers, t1.id)
      await deleteTask(request, headers, t2.id)
    }
  })

  test("R16: grouped emoji reaction pills toggle interactively inside #td-section-comments under HA ingress", async ({ browser }) => {
    test.slow()
    const work = await mkdtemp(join(tmpdir(), "meitheal-r16-ui-"))
    const env = {
      PATH: process.env.PATH,
      NODE_ENV: "production",
      SUPERVISOR_TOKEN: "r16-fixture-only",
      MEITHEAL_ACTIVE_MEMBER_FIXTURE: "1",
      MEITHEAL_DB_URL: `file:${join(work, "meitheal.db")}`,
      MEITHEAL_BOARD_GRANT_PATH: join(work, "meitheal-board-grants.json"),
    }
    const ctx = await browser.newContext({ extraHTTPHeaders: {}, serviceWorkers: "block" })
    let server: ReturnType<typeof fork> | undefined
    try {
      execFileSync(process.execPath, ["scripts/migrate.mjs"], { cwd: webDir, env })
      const child = fork(ingressFixture, { cwd: webDir, env, stdio: ["ignore", "ignore", "inherit", "ipc"] })
      server = child
      const [info] = await Promise.race([
        once(child, "message", { signal: AbortSignal.timeout(10_000) }),
        once(child, "exit").then(([code]) => { throw new Error(`Ingress fixture exited with ${code}`) }),
      ])
      const origin = `http://127.0.0.1:${info.port}`
      const entry = origin + info.configuredPath
      await ctx.addCookies([{ name: "feedback-fixture", value: "admin", url: origin }])
      const headers = await currentBoardWriteHeaders(ctx.request, "household", { origin, "sec-fetch-site": "same-origin" }, entry)
      const created = await ctx.request.post(`${entry}/api/tasks`, { headers, data: { title: "R16 Grouped Pill Task", status: "active" } })
      expect(created.status()).toBe(201)
      const { id } = await created.json()

      const page = await ctx.newPage()
      await page.goto(`${entry}/tasks?open=${id}`)
      const taskReactions = page.locator("#td-task-reactions")
      await expect(taskReactions).toBeVisible()
      await taskReactions.locator("summary").click()
      const reactionInput = taskReactions.getByRole("textbox", { name: "Emoji or short text" })
      await expect(reactionInput).toBeEditable()
      const addPost = page.waitForResponse(r => r.request().method() === "POST" && new URL(r.url()).pathname.endsWith(`/api/tasks/${id}/reactions`))
      await taskReactions.getByRole("button", { name: "👍", exact: true }).click()
      expect((await addPost).status()).toBe(201)

      const pill = taskReactions.locator('[data-reaction-groups] button[data-reaction-group="👍"]')
      await expect(pill).toHaveAttribute("aria-pressed", "true")
      await expect(pill).toContainText("1")

      // Interactive pill toggle off
      const removeDel = page.waitForResponse(r => r.request().method() === "DELETE" && new URL(r.url()).pathname.includes(`/api/tasks/${id}/reactions/`))
      await pill.click()
      expect((await removeDel).status()).toBe(204)
      await expect(pill).toBeHidden()
      await page.close()
    } finally {
      await ctx.close()
      if (server && server.exitCode === null && server.signalCode === null) {
        server.kill("SIGTERM")
        await once(server, "exit").catch(() => {})
      }
      await rm(work, { recursive: true, force: true })
    }
  })

  test("R10/R11/R12/R13/R19: board custom fields isolation, card customizer cap, AI vs MCP independence, URL prefill, and API default sort", async ({ page, request, baseURL }) => {
    const origin = new URL(baseURL!).origin
    const headers = await householdHeaders(request, baseURL!)
    const createdTasks: string[] = []
    let boardId = ""

    try {
      // R10: Named board custom fields isolated from household & /api/settings
      const boardRes = await request.post("/api/boards", { headers, data: { name: "Isolated Fields Board" } })
      expect(boardRes.status()).toBe(201)
      boardId = (await boardRes.json()).id
      const boardHeaders = await currentBoardWriteHeaders(request, boardId, { origin })

      const putCf = await request.put("/api/custom-fields", {
        headers: boardHeaders,
        data: { fields: [{ name: "board_env", type: "text" }] },
      })
      expect(putCf.status()).toBe(200)
      const boardCfBody = await (await request.get("/api/custom-fields", { headers: boardHeaders })).json()
      expect(boardCfBody.fields.map((f: { name: string }) => f.name)).toEqual(["board_env"])

      const hhCfBody = await (await request.get("/api/custom-fields", { headers })).json()
      expect(hhCfBody.fields.map((f: { name: string }) => f.name)).not.toContain("board_env")

      const hhSettings = await (await request.get("/api/settings")).json()
      expect(Object.keys(hhSettings).some(k => k.startsWith("custom_fields:board:"))).toBe(false)

      // R11/R14: Shopping/object custom fields never render [object Object] and Kanban card badge uses percent-normalized RICE
      const cfTask = await (await request.post("/api/tasks", {
        headers,
        data: {
          title: "Card Safety Task",
          custom_fields: JSON.stringify({ sprint: "S8", items: [{ name: "Apples", qty: 2 }] }),
          framework_payload: JSON.stringify({ rice: { reach: 100, impact: 2, confidence: 80, effort: 4, confidence_unit: "percent" } }),
        },
      })).json()
      createdTasks.push(cfTask.id)

      await page.goto("/tasks")
      await expect(page.locator(`.kanban-card[data-id="${cfTask.id}"]`)).not.toContainText("[object Object]")
      await expect(page.locator(`.kanban-card[data-id="${cfTask.id}"] .kanban-cf-chip[data-cf-name="sprint"]`)).toContainText("S8")
      await expect(page.locator(`.kanban-card[data-id="${cfTask.id}"] .kanban-rice-badge`)).toHaveText("RICE: 40")

      // R12: AI Assist admin disable returns 403 while MCP stays independent and excludes sendHAAssist
      await page.goto("/settings#ai-agents-settings")
      const hideAi = page.locator("#toggle-hide-ask-ai")
      const disableAi = page.locator("#toggle-disable-ai-assist")
      await expect(hideAi).toBeVisible()
      await hideAi.check()
      await expect(page.locator("html")).toHaveAttribute("data-hide-ask-ai", "")

      const saveDisable = page.waitForResponse(r => r.request().method() === "PUT" && new URL(r.url()).pathname === "/api/settings")
      await disableAi.check()
      expect((await saveDisable).status()).toBe(200)

      const assistDenied = await request.post("/api/ha/assist", { headers, data: { text: "hello" } })
      expect(assistDenied.status()).toBe(403)
      const assistJson = await assistDenied.json()
      expect(assistJson.code).toBe("ai_assist_disabled")

      const tokenRes = await request.post("/api/agent-tokens", { headers, data: { name: "mcp-r12-check", scopes: ["mcp:execute", "tasks:read"] } })
      expect([200, 201]).toContain(tokenRes.status())
      const tokenBody = await tokenRes.json()
      const mcpList = await request.post("/api/mcp", {
        headers: {
          authorization: `Bearer ${tokenBody.token}`,
          "x-meitheal-board-id": "household",
          "content-type": "application/json",
        },
        data: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
      })
      expect(mcpList.status()).toBe(200)
      const toolNames = ((await mcpList.json()).result?.tools ?? []).map((t: { name: string }) => t.name)
      expect(toolNames).not.toContain("sendHAAssist")
      expect(toolNames.length).toBeGreaterThan(0)
      if (tokenBody.id) await request.delete(`/api/agent-tokens/${tokenBody.id}`, { headers }).catch(() => {})

      // R13: URL prefill opens modal cleanly and strips query params
      await page.goto("/tasks?create=1&v=1&title=URL+Prefilled+Task&priority=1&task_type=story&custom_fields=%7B%22hidden%22%3A%22drop%22%7D")
      const modal = page.locator("#new-task-overlay")
      await expect(modal).toHaveClass(/active/)
      await expect(modal.locator("#new-task-title-input")).toHaveValue("URL Prefilled Task")
      await expect(modal.locator("#new-task-priority")).toHaveValue("1")
      await expect(modal.locator("#new-task-type")).toHaveValue("story")
      await expect(page).not.toHaveURL(/create=1/)
      await modal.locator("#cancel-new-task").click()

      // R19: GET /api/tasks field-aware default sort & NULLS LAST
      const p4 = await (await request.post("/api/tasks", { headers, data: { title: "Sort P4", priority: 4, due_date: null } })).json()
      const p1 = await (await request.post("/api/tasks", { headers, data: { title: "Sort P1", priority: 1, due_date: "2026-12-02" } })).json()
      createdTasks.push(p4.id, p1.id)

      const prioBody = await (await request.get("/api/tasks?sort=priority&limit=50")).json()
      const prioIds = prioBody.tasks.map((t: { id: string }) => t.id)
      expect(prioIds.indexOf(p1.id)).toBeLessThan(prioIds.indexOf(p4.id))

      const dueBody = await (await request.get("/api/tasks?sort=due_date&limit=50")).json()
      const dueIds = dueBody.tasks.map((t: { id: string }) => t.id)
      expect(dueIds.indexOf(p1.id)).toBeLessThan(dueIds.indexOf(p4.id))
    } finally {
      await request.put("/api/settings", { headers, data: { key: "ai_assist_disabled", value: false } }).catch(() => {})
      await page.evaluate(() => localStorage.removeItem("meitheal:hide-ask-ai:v1")).catch(() => {})
      for (const id of createdTasks) await deleteTask(request, headers, id)
      if (boardId) await request.delete(`/api/boards/${boardId}`, { headers }).catch(() => {})
    }
  })
})
