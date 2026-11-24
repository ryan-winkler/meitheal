import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { expect, test } from "@playwright/test"
import { readScopedNavigation, shouldSkipBrowserSpecs } from "./_helpers"

import { currentBoardWriteHeaders } from "../helpers/current-board-http"
import { startCoreFixture } from "../scripts/task-pins-fixture"

test.describe("Track D — @container Docked Task Inspector, Ingress Reload Persistence & Virtualized GANTT", () => {
  test.skip(shouldSkipBrowserSpecs(), "Set E2E_BASE_URL to run browser specs")

  test("GET /api/tasks/MTH-N resolves human-readable ticket keys (200) and missing MTH-999999 returns 404", async ({
    request,
    baseURL,
  }) => {
    const headers = await currentBoardWriteHeaders(request, "household", { origin: new URL(baseURL!).origin })
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
    const headers = await currentBoardWriteHeaders(request, "household", { origin: new URL(baseURL!).origin })
    const created = await request.post("/api/tasks", {
      headers,
      data: {
        title: "Docked inspector baseline task",
        description: "Initial description",
      },
    })
    expect(created.status()).toBe(201)
    const { id } = await created.json()
    const checklistDraft = "Unsaved checklist item draft"
    let appendStarted = false
    let renameAttempts = 0
    let releaseAppend!: () => void
    let releaseRename!: () => void
    let releaseRetry!: () => void
    const holdAppend = new Promise<void>(resolve => { releaseAppend = resolve })
    const holdRename = new Promise<void>(resolve => { releaseRename = resolve })
    const holdRetry = new Promise<void>(resolve => { releaseRetry = resolve })
    await page.route(`**/api/tasks/${id}`, async route => {
      if (route.request().method() !== "PUT") return route.continue()
      const { checklists } = route.request().postDataJSON()
      if (typeof checklists !== "string") return route.continue()
      const [item] = JSON.parse(checklists) as Array<{ text: string }>
      if (item?.text === "New Item") {
        appendStarted = true
        await holdAppend
      } else if (item?.text === checklistDraft) {
        renameAttempts++
        if (renameAttempts === 1) {
          await holdRename
          return route.fulfill({ status: 503, json: { error: "Checklist write unavailable" } })
        }
        await holdRetry
      }
      await route.continue()
    })

    try {
      await page.setViewportSize({ width: 1600, height: 900 })
      await page.goto(`/tickets/${id}`)
      await page.waitForLoadState("networkidle")

      const overlay = page.locator("#task-detail-overlay")
      const panel = page.locator("#task-detail-panel")
      const titleInput = page.locator("#td-title")
      const descInput = page.locator("#td-description")
      const checklistInput = page.locator('#td-checklists [data-checklist-row="0"] textarea')
      const commentsDisclosure = page.locator("#td-section-comments > summary")

      await expect(overlay).toHaveClass(/active/)
      await expect(page.locator("body")).toHaveClass(/has-docked-inspector/)
      await expect(panel).toHaveAttribute("role", "region")
      await expect(panel).not.toHaveAttribute("aria-modal")
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
      await expect(commentsDisclosure).toBeVisible()

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
      await checklistInput.fill(checklistDraft)
      await expect.poll(() => appendStarted).toBe(true)

      // Resize 1600px -> 1200px (transitions to modal dialog without unmounting or losing drafts)
      await page.setViewportSize({ width: 1200, height: 900 })
      await expect(page.locator("body")).not.toHaveClass(/has-docked-inspector/)
      await expect(panel).toHaveAttribute("role", "dialog")
      await expect(panel).toHaveAttribute("aria-modal", "true")
      await expect(commentsDisclosure).toBeVisible()

      const modalState = await page.evaluate(() => ({
        bodyOverflow: getComputedStyle(document.body).overflow,
        draftToken: (document.getElementById("task-detail-panel") as HTMLElement & { __draftToken?: string }).__draftToken,
      }))
      expect(modalState.bodyOverflow).toBe("hidden")
      expect(modalState.draftToken).toBe("same-dom-node")
      await expect(titleInput).toHaveValue("Unsaved docked draft title")
      await expect(descInput).toHaveValue("Unsaved docked markdown body")
      await expect(checklistInput).toHaveValue(checklistDraft)

      // Resize 1200px -> 1600px (transitions back to docked rail preserving drafts)
      await page.setViewportSize({ width: 1600, height: 900 })
      await expect(page.locator("body")).toHaveClass(/has-docked-inspector/)
      await expect(panel).toHaveAttribute("role", "region")
      await expect(panel).not.toHaveAttribute("aria-modal")
      await expect(titleInput).toHaveValue("Unsaved docked draft title")
      await expect(descInput).toHaveValue("Unsaved docked markdown body")
      await expect(checklistInput).toHaveValue(checklistDraft)

      // Escape closes docked inspector when focus resides inside #task-detail-panel
      await commentsDisclosure.focus()
      await page.keyboard.press("Escape")
      await expect(page.locator("#td-desc-edit-container")).toHaveAttribute("aria-busy", "true")
      releaseAppend()
      await expect(descInput).toBeHidden()
      await expect(overlay).toHaveClass(/active/)
      await expect.poll(() => renameAttempts).toBe(1)
      releaseRename()
      const retry = page.getByRole("button", { name: "Retry checklist save", exact: true })
      await expect(retry).toBeVisible()
      await expect(overlay).toHaveClass(/active/)
      await expect(checklistInput).toHaveValue(checklistDraft)

      // The failed save has finished. Close and Escape must still keep the draft available for Retry.
      await page.getByRole("button", { name: "Close detail", exact: true }).click()
      await expect(retry).toBeFocused()
      await page.keyboard.press("Escape")
      await expect(overlay).toHaveClass(/active/)
      await expect(checklistInput).toHaveValue(checklistDraft)

      await retry.click()
      await expect.poll(() => renameAttempts).toBe(2)
      await commentsDisclosure.focus()
      await page.keyboard.press("Escape")
      await expect(overlay).toHaveClass(/active/)
      releaseRetry()
      await expect(overlay).not.toHaveClass(/active/)
      await expect(page.locator("body")).not.toHaveClass(/has-docked-inspector/)
      const saved = await request.get(`/api/tasks/${id}`)
      expect(saved.status()).toBe(200)
      const savedTask = await saved.json()
      expect(savedTask).toMatchObject({ title: "Unsaved docked draft title", description: "Unsaved docked markdown body" })
      expect(JSON.parse(savedTask.checklists)).toMatchObject([{ text: checklistDraft }])

      await page.goto(`/tickets/${id}`)
      await expect(titleInput).toHaveValue(savedTask.title)
      await page.locator("#td-desc-edit-btn-hover").dispatchEvent("click")
      await descInput.fill("Local draft after another session edits")
      const externalDescription = "Saved from another task session"
      const external = await request.put(`/api/tasks/${id}`, {
        headers, data: { description: externalDescription, updated_at: savedTask.task_version },
      })
      expect(external.status()).toBe(200)
      await page.locator("#td-add-checklist-item").click()
      await expect.poll(async () => JSON.parse((await (await request.get(`/api/tasks/${id}`)).json()).checklists).length).toBe(2)
      await commentsDisclosure.focus()
      await page.keyboard.press("Escape")
      await expect(page.locator("#td-write-conflict")).toBeVisible()
      await expect(descInput).toHaveValue("Local draft after another session edits")
      expect((await (await request.get(`/api/tasks/${id}`)).json()).description).toBe(externalDescription)
    } finally {
      releaseAppend()
      releaseRename()
      releaseRetry()
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
    let server: ReturnType<typeof startCoreFixture> | undefined
    try {
      server = startCoreFixture(work, true, undefined, undefined, work)
      server.stdout?.resume()
      server.stderr?.resume()
      const [info] = await Promise.race([
        once(server, "message", { signal: AbortSignal.timeout(10_000) }),
        once(server, "exit").then(([code]) => {
          throw new Error(`Ingress fixture exited with ${code}`)
        }),
      ])
      const origin = `http://127.0.0.1:${info.port}`
      const prefix: string = info.configuredPath

      await page.context().setExtraHTTPHeaders({})
      await page.context().addCookies([{ name: "feedback-fixture", value: "admin", url: origin }])
      const headers = await currentBoardWriteHeaders(page.request, "household", { origin }, origin + prefix)
      const seedRes = await page.request.post(`${origin}${prefix}/api/tasks`, {
        headers,
        data: { title: "Ingress reload MTH-1 fixture" },
      })
      expect(seedRes.status()).toBe(201)
      const seeded = await seedRes.json()
      expect(seeded.ticket_key).toBe("MTH-1")

      await page.setViewportSize({ width: 1600, height: 900 })
      await page.goto(`${origin}${prefix}/tickets/MTH-1`)
      await page.waitForLoadState("networkidle")
      await expect(page.locator("#task-detail-overlay")).toHaveClass(/active/)

      const storedState = await readScopedNavigation(page)
      expect(storedState).not.toBeNull()
      expect(storedState.path).toBe(`/tickets/${seeded.ticket_key}`)
      expect(storedState.path).not.toContain(prefix)

      // Simulate Home Assistant Ingress iframe recreation landing at the bare Ingress mount path
      await page.goto(`${origin}${prefix}/`)
      await page.waitForLoadState("networkidle")

      expect(new URL(page.url()).pathname).toBe(`${prefix}/tickets/${seeded.ticket_key}`)
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

  test("500-task virtualized GANTT stays <= 450 DOM nodes and <= 6 ms median scroll pass while preserving drag, keyboard, Month dividers, external labels and scrolled PNG export", async ({
    page,
    request,
    baseURL,
  }) => {
    const headers = await currentBoardWriteHeaders(request, "household", { origin: new URL(baseURL!).origin })
    const baseMs = Date.UTC(2026, 10, 10)
    const fmt = (offsetDays: number) => new Date(baseMs + offsetDays * 86_400_000).toISOString().slice(0, 10)

    // Create 2 real backing SQLite tasks so inline bar drag exercises a real versioned PUT /api/tasks/:id
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
      await page.route(url => url.pathname === "/boards/household" && url.searchParams.get("view") === "timeline", async (route) => {
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
            task_version: t0.task_version ?? t0.updated_at,
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
            task_version: t1.task_version ?? t1.updated_at,
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
      await page.goto("/boards/household?view=timeline#timeline")
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

      // 2. Active bar drag updates x in-place and saves current dates without detaching the mounted <g>
      const barZero = page.locator(`.gantt-bar[data-task-id="${t0.id}"]`)
      await barZero.scrollIntoViewIfNeeded()
      const box = await barZero.locator("rect").first().boundingBox()
      expect(box).not.toBeNull()

      const savePromise = page.waitForResponse(
        (res) => res.url().includes(`/api/tasks/${t0.id}`) && res.request().method() === "PUT",
        { timeout: 5_000 },
      )
      await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2)
      await page.mouse.down()
      await page.mouse.move(box!.x + box!.width / 2 + 48, box!.y + box!.height / 2, { steps: 3 })
      await page.mouse.up()
      const saved = await savePromise
      expect(saved.status()).toBe(200)

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

      // 4. Check the median windowing time, node budget, scrolled rows and off-screen dependency arrow.
      const scrollAudit = await page.evaluate(async () => {
        const sw = document.querySelector<HTMLElement>(".gantt-scroll-wrapper")!
        const sidebarViewport = document.querySelector<HTMLElement>(".gantt-sidebar-rows")!
        const durations: number[] = []

        for (const targetRow of [45, 105, 165, 225, 285, 345, 405, 465, 250]) {
          // Let the scroll and resize work from the previous window finish so
          // the sampled callback belongs to this change in scroll position.
          await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
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
        const medianMs = durations[Math.floor(durations.length / 2)]!
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
          durations,
          totalNodes,
          barGroups,
          rowVisibleInSidebar,
          row252Text: row252?.textContent ?? "",
          partnerDepArrowMounted,
        }
      })

      expect(scrollAudit.medianMs, `Measured scroll passes: ${scrollAudit.durations.join(", ")}`).toBeLessThanOrEqual(6)
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
