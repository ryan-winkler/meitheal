import { execFileSync, fork, type ChildProcess } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { expect, test } from "@playwright/test"
import { shouldSkipBrowserSpecs } from "./_helpers"

const webDir = fileURLToPath(new URL("../../apps/web", import.meta.url))
const ingressFixturePath = fileURLToPath(new URL("../scripts/feedback-ingress-fixture.mjs", import.meta.url))

test.describe("Track D — @container Docked Task Inspector, Ingress Reload Persistence & Virtualized GANTT", () => {
  test.skip(shouldSkipBrowserSpecs(), "Set E2E_BASE_URL to run browser specs")

  test("GET /api/tasks/MTH-N resolves human-readable ticket keys (200) and missing MTH-999999 returns 404", async ({
    request,
    baseURL,
  }) => {
    const headers = { origin: new URL(baseURL!).origin }
    const created = await request.post("/api/tasks", {
      headers,
      data: { title: "Ticket key GET lookup fixture" },
    })
    expect(created.status()).toBe(201)
    const { id, ticket_key: ticketKey } = await created.json()
    expect(ticketKey).toMatch(/^MTH-\d+$/)

    try {
      const hit = await request.get(`/api/tasks/${ticketKey}`)
      expect(hit.status()).toBe(200)
      const body = await hit.json()
      expect(body.id).toBe(id)

      const miss = await request.get("/api/tasks/MTH-999999")
      expect(miss.status()).toBe(404)
    } finally {
      await request.delete(`/api/tasks/${id}`, { headers })
    }
  })

  test("docked inspector (>= 1440px) vs modal (< 1440px) preserves unsaved drafts across resize and coordinates shortcuts", async ({
    page,
    request,
    baseURL,
  }) => {
    const headers = { origin: new URL(baseURL!).origin }
    const created = await request.post("/api/tasks", {
      headers,
      data: {
        title: "Docked inspector baseline task",
        description: "Initial description",
      },
    })
    expect(created.status()).toBe(201)
    const { id } = await created.json()

    try {
      await page.setViewportSize({ width: 1600, height: 900 })
      await page.goto(`/tickets/${id}`)
      await page.waitForLoadState("networkidle")

      const overlay = page.locator("#task-detail-overlay")
      const panel = page.locator("#task-detail-panel")
      const titleInput = page.locator("#td-title")
      const descInput = page.locator("#td-description")
      const checklistInput = page.locator('#td-checklists [data-checklist-row="0"] textarea')
      const sidebarToggle = page.locator("#td-sidebar-toggle")

      await expect(overlay).toHaveClass(/active/)
      await expect(page.locator("body")).toHaveClass(/has-docked-inspector/)
      await expect(panel).toHaveAttribute("role", "region")
      await expect(panel).toHaveAttribute("aria-modal", "false")
      await expect(titleInput).toHaveValue("Docked inspector baseline task")

      // Body scroll stays unlocked when docked, and @container stacks single-column at 420px width
      const dockedMetrics = await page.evaluate(() => {
        const panelEl = document.getElementById("task-detail-panel")!
        const mainEl = document.querySelector<HTMLElement>(".main-content")!
        return {
          bodyOverflow: getComputedStyle(document.body).overflow,
          panelWidth: Math.round(panelEl.getBoundingClientRect().width),
          mainMarginRight: getComputedStyle(mainEl).marginRight,
          aiPlaceholderCount: panelEl.querySelectorAll(".animate-pulse").length,
        }
      })
      expect(dockedMetrics.bodyOverflow).not.toBe("hidden")
      expect(dockedMetrics.panelWidth).toBeLessThanOrEqual(420)
      expect(dockedMetrics.mainMarginRight).toBe("420px")
      expect(dockedMetrics.aiPlaceholderCount).toBe(0)
      await expect(sidebarToggle).toBeVisible()

      // SearchHub "/" opens when focus is outside editable panel inputs while docked
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
      await page.keyboard.press("/")
      await expect(page.locator("#search-hub-overlay")).toBeVisible()
      await page.keyboard.press("Escape")
      await expect(page.locator("#search-hub-overlay")).toBeHidden()
      // Docked inspector remained open after closing SearchHub with Escape
      await expect(overlay).toHaveClass(/active/)

      // Enter unsaved edits across title, description, and checklist draft input
      await page.evaluate(() => {
        ;(document.getElementById("task-detail-panel") as HTMLElement & { __draftToken?: string }).__draftToken = "same-dom-node"
      })
      await titleInput.fill("Unsaved docked draft title")
      await page.locator("#td-desc-edit-btn-hover").dispatchEvent("click")
      await expect(descInput).toBeVisible()
      await descInput.fill("Unsaved docked markdown body")
      await page.locator("#td-add-checklist-item").click()
      await expect(checklistInput).toBeVisible()
      await checklistInput.fill("Unsaved checklist item draft")

      // Resize 1600px -> 1200px (transitions to modal dialog without unmounting or losing drafts)
      await page.setViewportSize({ width: 1200, height: 900 })
      await expect(page.locator("body")).not.toHaveClass(/has-docked-inspector/)
      await expect(panel).toHaveAttribute("role", "dialog")
      await expect(panel).toHaveAttribute("aria-modal", "true")
      await expect(sidebarToggle).toBeHidden()

      const modalState = await page.evaluate(() => ({
        bodyOverflow: getComputedStyle(document.body).overflow,
        draftToken: (document.getElementById("task-detail-panel") as HTMLElement & { __draftToken?: string }).__draftToken,
      }))
      expect(modalState.bodyOverflow).toBe("hidden")
      expect(modalState.draftToken).toBe("same-dom-node")
      await expect(titleInput).toHaveValue("Unsaved docked draft title")
      await expect(descInput).toHaveValue("Unsaved docked markdown body")
      await expect(checklistInput).toHaveValue("Unsaved checklist item draft")

      // Resize 1200px -> 1600px (transitions back to docked rail preserving drafts)
      await page.setViewportSize({ width: 1600, height: 900 })
      await expect(page.locator("body")).toHaveClass(/has-docked-inspector/)
      await expect(panel).toHaveAttribute("role", "region")
      await expect(panel).toHaveAttribute("aria-modal", "false")
      await expect(titleInput).toHaveValue("Unsaved docked draft title")
      await expect(descInput).toHaveValue("Unsaved docked markdown body")
      await expect(checklistInput).toHaveValue("Unsaved checklist item draft")

      // Escape closes docked inspector when focus resides inside #task-detail-panel
      await sidebarToggle.focus()
      await page.keyboard.press("Escape")
      await expect(overlay).not.toHaveClass(/active/)
      await expect(page.locator("body")).not.toHaveClass(/has-docked-inspector/)
    } finally {
      await request.delete(`/api/tasks/${id}`, { headers })
    }
  })

  test("#ask-ha-overlay suppresses global single-key shortcuts (?, /, n, k)", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 })
    await page.goto("/today")
    await page.waitForLoadState("networkidle")

    await page.evaluate(() => {
      document.getElementById("ask-ha-overlay")?.classList.add("active")
      ;(document.getElementById("close-ask-ha-modal") as HTMLElement | null)?.focus()
    })
    await expect(page.locator("#ask-ha-overlay")).toHaveClass(/active/)

    await page.keyboard.press("Shift+Slash")
    await expect(page.locator("#shortcut-modal")).toBeHidden()

    await page.keyboard.press("/")
    await expect(page.locator("#search-hub-overlay")).toBeHidden()

    await page.keyboard.press("n")
    await expect(page.locator("#new-task-overlay")).not.toHaveClass(/active/)

    await page.keyboard.press("k")
    await expect(page).toHaveURL(/\/today$/)
  })

  test("Home Assistant Ingress reload restores /tickets/MTH-1 without double-prefixing", async ({ page }) => {
    const work = await mkdtemp(path.join(tmpdir(), "meitheal-track-d-ingress-"))
    let server: ChildProcess | undefined
    try {
      const env = {
        PATH: process.env.PATH,
        NODE_ENV: "production",
        MEITHEAL_DB_URL: `file:${path.join(work, "meitheal.db")}`,
      }
      execFileSync(process.execPath, ["scripts/migrate.mjs"], { cwd: webDir, env })
      server = fork(ingressFixturePath, { cwd: webDir, env, stdio: ["ignore", "ignore", "inherit", "ipc"] })
      const [info] = await Promise.race([
        once(server, "message", { signal: AbortSignal.timeout(10_000) }),
        once(server, "exit").then(([code]) => {
          throw new Error(`Ingress fixture exited with ${code}`)
        }),
      ])
      const origin = `http://127.0.0.1:${info.port}`
      const prefix: string = info.configuredPath

      await page.context().setExtraHTTPHeaders({})
      const seedRes = await page.request.post(`${origin}${prefix}/api/tasks`, {
        headers: { origin },
        data: { title: "Ingress reload MTH-1 fixture" },
      })
      expect(seedRes.status()).toBe(201)
      const seeded = await seedRes.json()
      expect(seeded.ticket_key).toBe("MTH-1")

      await page.setViewportSize({ width: 1600, height: 900 })
      await page.goto(`${origin}${prefix}/tickets/MTH-1`)
      await page.waitForLoadState("networkidle")
      await expect(page.locator("#task-detail-overlay")).toHaveClass(/active/)

      const storedState = await page.evaluate(() => {
        const raw = sessionStorage.getItem("meitheal-navigation-state")
        return raw ? JSON.parse(raw) : null
      })
      expect(storedState).not.toBeNull()
      expect(storedState.path).toBe(`/tickets/${seeded.id}`)
      expect(storedState.path).not.toContain(prefix)

      // Simulate Home Assistant Ingress iframe recreation landing at the bare Ingress mount path
      await page.goto(`${origin}${prefix}/`)
      await page.waitForLoadState("networkidle")

      expect(new URL(page.url()).pathname).toBe(`${prefix}/tickets/${seeded.id}`)
      expect(page.url()).not.toContain(`${prefix}${prefix}`)
      await expect(page.locator("#td-title")).toHaveValue("Ingress reload MTH-1 fixture")
    } finally {
      if (server && server.exitCode === null && server.signalCode === null) {
        const exited = once(server, "exit")
        server.kill()
        await exited
      }
      await rm(work, { recursive: true, force: true })
    }
  })

  test("500-task virtualized GANTT stays <= 450 DOM nodes & <= 2 ms scroll pass while preserving drag, keyboard, Month dividers, external labels & scrolled PNG export", async ({
    page,
    request,
    baseURL,
  }) => {
    const headers = { origin: new URL(baseURL!).origin }
    const baseMs = Date.UTC(2026, 10, 10)
    const fmt = (offsetDays: number) => new Date(baseMs + offsetDays * 86_400_000).toISOString().slice(0, 10)

    // Create 2 real backing SQLite tasks so inline bar drag exercises real PATCH /api/tasks/:id
    const realIds: string[] = []
    try {
      const t0Res = await request.post("/api/tasks", {
        headers,
        data: {
          title: "Draggable Anchor Task Zero",
          start_date: fmt(0),
          due_date: fmt(6),
          priority: 2,
          status: "active",
        },
      })
      expect(t0Res.status()).toBe(201)
      const t0 = await t0Res.json()
      realIds.push(t0.id)

      const t1Res = await request.post("/api/tasks", {
        headers,
        data: {
          title: "Short Label External Check",
          start_date: fmt(1),
          due_date: fmt(2),
          priority: 3,
          status: "pending",
        },
      })
      expect(t1Res.status()).toBe(201)
      const t1 = await t1Res.json()
      realIds.push(t1.id)

      // Inject 500 dated tasks into SSR #timeline-data (2 real SQLite tasks + 498 synthetic tasks across a 14-month span)
      await page.route("**/tasks?view=timeline*", async (route) => {
        const response = await route.fetch()
        const html = await response.text()
        const syntheticTasks: Array<Record<string, unknown>> = [
          {
            id: t0.id,
            title: "Draggable Anchor Task Zero",
            status: "active",
            priority: 2,
            start_date: fmt(0),
            due_date: fmt(6),
            end_date: fmt(6),
            color: null,
            task_type: "task",
            task_kind: "standard_action",
            ticket_number: t0.ticket_number ?? 1,
            progress: 40,
            blocked_by: null,
            parent_id: null,
            project_id: null,
            area_id: null,
            pillar_id: null,
            effort_minutes: 60,
            is_overdue: false,
            deferred_at: null,
          },
          {
            id: t1.id,
            title: "Short Label External Check",
            status: "pending",
            priority: 3,
            start_date: fmt(1),
            due_date: fmt(2),
            end_date: fmt(2),
            color: null,
            task_type: "task",
            task_kind: "standard_action",
            ticket_number: t1.ticket_number ?? 2,
            progress: 0,
            blocked_by: JSON.stringify([t0.id]),
            parent_id: null,
            project_id: null,
            area_id: null,
            pillar_id: null,
            effort_minutes: null,
            is_overdue: false,
            deferred_at: null,
          },
        ]
        for (let i = 2; i < 500; i++) {
          const offset = (i % 360) - 30
          syntheticTasks.push({
            id: `virt-task-${i}`,
            title: `Virtualized RowItem ${i}`,
            status: i % 5 === 0 ? "active" : "pending",
            priority: ((i % 4) + 1) as number,
            start_date: fmt(offset),
            due_date: fmt(offset + 4),
            end_date: fmt(offset + 4),
            color: null,
            task_type: "task",
            task_kind: "standard_action",
            ticket_number: 1000 + i,
            progress: (i * 10) % 100,
            blocked_by: i === 250 ? JSON.stringify([t0.id]) : null,
            parent_id: null,
            project_id: null,
            area_id: null,
            pillar_id: null,
            effort_minutes: null,
            is_overdue: false,
            deferred_at: null,
          })
        }
        const jsonPayload = JSON.stringify(syntheticTasks).replace(/</g, "\\u003c")
        const patchedHtml = html.replace(
          /<script type="application\/json" id="timeline-data">[\s\S]*?<\/script>/,
          `<script type="application\/json" id="timeline-data">${jsonPayload}</script>`,
        )
        await route.fulfill({ response, body: patchedHtml })
      })

      await page.setViewportSize({ width: 1440, height: 900 })
      await page.goto("/tasks?view=timeline#timeline")
      await page.waitForLoadState("networkidle")
      await expect(page.locator("#gantt-chart svg.gantt-native")).toBeVisible()

      // 1. Initial 500-task DOM budget check + < 96px external right-hand bar label check + dependency connector check
      const initialAudit = await page.evaluate((shortTaskId) => {
        const totalNodes = document.querySelectorAll(
          "#tasks-view-timeline .gantt-sidebar *, #tasks-view-timeline svg.gantt-native *",
        ).length
        const barGroups = document.querySelectorAll("#tasks-view-timeline .gantt-bar").length
        const patternExists = Boolean(document.querySelector("svg.gantt-native defs pattern#gantt-col-grid"))
        const depArrows = document.querySelectorAll("svg.gantt-native .gantt-dep-arrow").length

        const shortBar = document.querySelector<SVGGElement>(`.gantt-bar[data-task-id="${shortTaskId}"]`)
        const rect = shortBar?.querySelector("rect")
        const text = shortBar?.querySelector("text")
        const barX = Number(rect?.getAttribute("x") ?? 0)
        const barW = Number(rect?.getAttribute("width") ?? 0)
        const textX = Number(text?.getAttribute("x") ?? 0)

        return {
          totalNodes,
          barGroups,
          patternExists,
          depArrows,
          barW,
          expectedTextX: barX + barW + 8,
          textX,
          placement: text?.getAttribute("data-label-placement"),
          textFill: text?.getAttribute("fill"),
        }
      }, t1.id)

      expect(initialAudit.totalNodes).toBeLessThanOrEqual(450)
      expect(initialAudit.barGroups).toBeLessThanOrEqual(60)
      expect(initialAudit.patternExists).toBe(true)
      expect(initialAudit.depArrows).toBeGreaterThanOrEqual(1)
      expect(initialAudit.barW).toBeLessThan(96)
      expect(initialAudit.placement).toBe("outside")
      expect(initialAudit.textX).toBe(initialAudit.expectedTextX)
      expect(initialAudit.textFill).toBe("var(--text-secondary)")

      // 2. Active bar drag updates x in-place and PATCHes /api/tasks/:id without detaching the mounted <g>
      const barZero = page.locator(`.gantt-bar[data-task-id="${t0.id}"]`)
      await barZero.scrollIntoViewIfNeeded()
      const box = await barZero.boundingBox()
      expect(box).not.toBeNull()

      const patchPromise = page.waitForResponse(
        (res) => res.url().includes(`/api/tasks/${t0.id}`) && res.request().method() === "PATCH",
      )
      await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2)
      await page.mouse.down()
      await page.mouse.move(box!.x + box!.width / 2 + 48, box!.y + box!.height / 2, { steps: 3 })
      await page.mouse.up()
      const patchRes = await patchPromise
      expect(patchRes.status()).toBe(200)

      // 3. ArrowDown navigation past row 50 (55 steps -> row index 54 / aria-rowindex 55)
      await page.evaluate(() => {
        const sw = document.querySelector<HTMLElement>(".gantt-scroll-wrapper")
        if (sw) sw.scrollTop = 0
        ;(document.activeElement as HTMLElement | null)?.blur()
      })
      for (let step = 0; step < 55; step++) {
        await page.keyboard.press("ArrowDown")
      }

      const navState = await page.evaluate(() => {
        const active = document.activeElement as Element | null
        const focusedSidebar = document.querySelector<HTMLElement>(".gantt-sidebar-row--focused")
        return {
          activeRowIndex: Number(active?.getAttribute("data-row-index") ?? -1),
          activeAriaRowIndex: Number(active?.getAttribute("aria-rowindex") ?? -1),
          focusedSidebarRowIndex: Number(focusedSidebar?.dataset.rowIndex ?? -1),
        }
      })
      expect(navState.activeRowIndex).toBe(54)
      expect(navState.activeAriaRowIndex).toBe(55)
      expect(navState.focusedSidebarRowIndex).toBe(54)

      // 4. Vertical scroll pass to row 250: <= 2 ms windowing pass, <= 450 DOM nodes, <= 60 bars, visible scrolled sidebar rows, & off-screen dependency partner arrow
      const scrollAudit = await page.evaluate(async () => {
        const sw = document.querySelector<HTMLElement>(".gantt-scroll-wrapper")!
        const sidebarViewport = document.querySelector<HTMLElement>(".gantt-sidebar-rows")!
        const durations: number[] = []

        for (const targetRow of [140, 200, 250]) {
          const duration = await new Promise<number>((resolve) => {
            const origRaf = window.requestAnimationFrame
            window.requestAnimationFrame = (cb: FrameRequestCallback) =>
              origRaf((ts) => {
                window.requestAnimationFrame = origRaf
                const tStart = performance.now()
                cb(ts)
                resolve(performance.now() - tStart)
              })
            sw.scrollTop = targetRow * 44
            sw.dispatchEvent(new Event("scroll"))
          })
          durations.push(duration)
        }

        durations.sort((a, b) => a - b)
        const medianMs = durations[1]!
        const totalNodes = document.querySelectorAll(
          "#tasks-view-timeline .gantt-sidebar *, #tasks-view-timeline svg.gantt-native *",
        ).length
        const barGroups = document.querySelectorAll("#tasks-view-timeline .gantt-bar").length

        const vpRect = sidebarViewport.getBoundingClientRect()
        const row252 = document.querySelector<HTMLElement>('.gantt-sidebar-row[data-row-index="252"]')
        const rowRect = row252?.getBoundingClientRect()
        const rowVisibleInSidebar = Boolean(
          rowRect && rowRect.bottom > vpRect.top && rowRect.top < vpRect.bottom && rowRect.height > 0,
        )
        const partnerDepArrowMounted = Boolean(
          document.querySelector('svg.gantt-native .gantt-dep-arrow[data-to-id="virt-task-250"]'),
        )

        return {
          medianMs,
          totalNodes,
          barGroups,
          rowVisibleInSidebar,
          row252Text: row252?.textContent ?? "",
          partnerDepArrowMounted,
        }
      })

      expect(scrollAudit.medianMs).toBeLessThanOrEqual(2)
      expect(scrollAudit.totalNodes).toBeLessThanOrEqual(450)
      expect(scrollAudit.barGroups).toBeLessThanOrEqual(60)
      expect(scrollAudit.rowVisibleInSidebar).toBe(true)
      expect(scrollAudit.row252Text).toContain("Virtualized RowItem 252")
      expect(scrollAudit.partnerDepArrowMounted).toBe(true)

      // 5. Scrolled exportTimelinePNG draws scrolled sidebar labels onto canvas via data-row-index
      await page.evaluate(() => {
        ;(window as unknown as { __exportedTexts?: Array<{ text: string; y: number }> }).__exportedTexts = []
        const origFillText = CanvasRenderingContext2D.prototype.fillText
        CanvasRenderingContext2D.prototype.fillText = function (text: string, x: number, y: number, maxWidth?: number) {
          ;(window as unknown as { __exportedTexts: Array<{ text: string; y: number }> }).__exportedTexts.push({
            text: String(text),
            y,
          })
          return maxWidth !== undefined ? origFillText.call(this, text, x, y, maxWidth) : origFillText.call(this, text, x, y)
        }
        const origClick = HTMLAnchorElement.prototype.click
        HTMLAnchorElement.prototype.click = function () {
          if (this.download) {
            ;(window as unknown as { __exportedDownload?: string }).__exportedDownload = this.download
            return
          }
          return origClick.call(this)
        }
      })

      await page.locator("#timeline-export-btn").click()
      await expect
        .poll(() => page.evaluate(() => (window as unknown as { __exportedDownload?: string }).__exportedDownload ?? ""))
        .toContain("meitheal-timeline-")

      const exportedLabels = await page.evaluate(
        () => (window as unknown as { __exportedTexts: Array<{ text: string; y: number }> }).__exportedTexts,
      )
      expect(exportedLabels.some((item) => item.text.includes("Virtualized RowItem 252") && item.y > 48)).toBe(true)

      // 6. Month zoom renders exact 1st-of-month <line.gantt-month-divider> dividers (<= 25) and keeps <= 450 DOM nodes
      const zoomDropdown = page.locator("#timeline-zoom-dropdown")
      await zoomDropdown.locator("summary").click()
      await zoomDropdown.getByRole("button", { name: "Month", exact: true }).click()

      const monthAudit = await page.evaluate(() => {
        const dividers = Array.from(document.querySelectorAll<SVGLineElement>("svg.gantt-native line.gantt-month-divider"))
        const monthStarts = dividers.map((d) => d.getAttribute("data-month-start") ?? "")
        const totalNodes = document.querySelectorAll(
          "#tasks-view-timeline .gantt-sidebar *, #tasks-view-timeline svg.gantt-native *",
        ).length
        return { dividerCount: dividers.length, monthStarts, totalNodes }
      })

      expect(monthAudit.dividerCount).toBeGreaterThanOrEqual(1)
      expect(monthAudit.dividerCount).toBeLessThanOrEqual(25)
      expect(monthAudit.monthStarts.every((m) => /^\d{4}-\d{2}-01$/.test(m))).toBe(true)
      expect(monthAudit.totalNodes).toBeLessThanOrEqual(450)
    } finally {
      for (const id of realIds) {
        await request.delete(`/api/tasks/${id}`, { headers })
      }
    }
  })
})
