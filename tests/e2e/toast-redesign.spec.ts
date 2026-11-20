import AxeBuilder from "@axe-core/playwright"
import { expect, test, type Locator, type Page } from "@playwright/test"
import { shouldSkipBrowserSpecs } from "./_helpers"

test.skip(shouldSkipBrowserSpecs(), "Set E2E_BASE_URL to run browser specs")
test.use({ serviceWorkers: "block" })

// Toast & banner drag listeners attach on `window` after `pointerdown`, so synthetic
// move/up/cancel steps target `window` with matching `pointerId`.
async function swipeElement(
  page: Page,
  locator: Locator,
  dx: number,
  dy: number,
  options: {
    steps?: number
    cancel?: boolean
    stepDelayMs?: number
    startOffsetX?: number
    targetSelector?: string
    assertMidDrag?: () => Promise<void>
  } = {},
): Promise<void> {
  const target = options.targetSelector ? locator.locator(options.targetSelector) : locator
  const box = await target.boundingBox()
  if (!box) throw new Error("Missing bounding box for swipe target")
  const startX =
    options.startOffsetX ??
    (options.targetSelector ? box.x + box.width * 0.5 : Math.max(28, box.x + Math.min(80, box.width * 0.35)))
  const startY = box.y + box.height * 0.5
  const steps = options.steps ?? 8

  await target.evaluate((el, params) => {
    el.dispatchEvent(new PointerEvent("pointerdown", {
      bubbles: true,
      cancelable: true,
      pointerId: 42,
      button: 0,
      clientX: params.startX,
      clientY: params.startY,
    }))
  }, { startX, startY })

  for (let i = 1; i <= steps; i++) {
    const t = i / steps
    await page.evaluate((params) => {
      window.dispatchEvent(new PointerEvent("pointermove", {
        bubbles: true,
        cancelable: true,
        pointerId: 42,
        clientX: params.clientX,
        clientY: params.clientY,
      }))
    }, { clientX: startX + dx * t, clientY: startY + dy * t })
    if (options.stepDelayMs) await page.waitForTimeout(options.stepDelayMs)
  }

  if (options.assertMidDrag) await options.assertMidDrag()

  await page.evaluate((params) => {
    window.dispatchEvent(new PointerEvent(params.cancel ? "pointercancel" : "pointerup", {
      bubbles: true,
      cancelable: true,
      pointerId: 42,
      clientX: params.endX,
      clientY: params.endY,
    }))
  }, { cancel: Boolean(options.cancel), endX: startX + dx, endY: startY + dy })
}

test.describe("Unified toast, persistent notifications & mobile UX", () => {
  test("mounts one persistent #toast-container across pages and ViewTransitions", async ({ page }) => {
    for (const route of ["/", "/today", "/settings", "/habits"]) {
      await page.goto(route)
      await expect(page.locator("#toast-container")).toHaveCount(1)
    }

    await page.goto("/")
    await page.evaluate(() => {
      document.body.dataset.testClickCount = "0"
      window.__meithealToast?.({
        id: "sw-update-test",
        message: "Update ready",
        type: "info",
        persistent: true,
        action: {
          id: "sw-update-btn",
          label: "Refresh",
          primary: true,
          closeOnClick: false,
          onClick: () => {
            const cur = Number(document.body.dataset.testClickCount ?? "0")
            document.body.dataset.testClickCount = String(cur + 1)
          },
        },
      })
    })
    await expect(page.locator("#sw-update-btn")).toBeVisible()

    // Non-ingress ClientRouter preserves transition:persist="toast-container" unconditionally
    await page.locator('a[href="/today"]').first().click()
    await expect(page).toHaveURL(/\/today/)
    await expect(page.locator("#toast-container")).toHaveCount(1)
    await expect(page.locator("#sw-update-btn")).toBeVisible()
    await page.locator("#sw-update-btn").click()
    expect(await page.evaluate(() => document.body.dataset.testClickCount)).toBe("1")

    // Tabler modals demote an already :popover-open #toast-container and re-promote on close
    await expect(page.locator("#toast-container:popover-open")).toHaveCount(1)
    await page.evaluate(() => {
      const m = document.createElement("div")
      m.id = "test-tabler-modal-layer"
      m.setAttribute("data-meitheal-tabler-modal", "true")
      m.className = "show"
      document.body.append(m)
      document.dispatchEvent(new Event("meitheal:overlay-opened"))
    })
    await expect(page.locator("#toast-container:popover-open")).toHaveCount(0)
    await page.evaluate(() => {
      document.getElementById("test-tabler-modal-layer")?.remove()
      document.dispatchEvent(new Event("meitheal:overlay-closed"))
    })
    await expect(page.locator("#toast-container:popover-open")).toHaveCount(1)

    // Native <dialog>.close() re-promotes a demoted toast container
    await page.evaluate(() => {
      const dlg = document.createElement("dialog")
      dlg.id = "test-native-dialog-layer"
      document.body.append(dlg)
      dlg.showModal()
      window.showToast?.("Behind native dialog", "info")
    })
    await expect(page.locator("#toast-container:popover-open")).toHaveCount(0)
    await page.evaluate(() => {
      const dlg = document.getElementById("test-native-dialog-layer") as HTMLDialogElement | null
      dlg?.close()
    })
    await expect(page.locator("#toast-container:popover-open")).toHaveCount(1)
    await page.evaluate(() => {
      document.getElementById("test-native-dialog-layer")?.remove()
    })
  })

  test("preserves horizontal icon/message geometry without crushing, overflow, or touch scroll blocking", async ({ page }) => {
    for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport)
      await page.goto("/")

      await page.evaluate(() => {
        window.showToast?.("Saved task preference", "success")
        window.showToast?.("x".repeat(200), "warning")
      })

      const shortToast = page.locator("#toast-container .toast.success").first()
      const longToast = page.locator("#toast-container .toast.warning").first()
      await expect(shortToast).toBeVisible()
      await expect(longToast).toBeVisible()

      for (const [label, target, maxMsgHeight] of [
        ["shortToast", shortToast, 60],
        ["longToast", longToast, 400],
      ] as const) {
        const m = await target.evaluate((el) => {
          const icon = el.querySelector(".m-toast__icon")?.getBoundingClientRect()
          const msg = el.querySelector(".m-toast__message")?.getBoundingClientRect()
          const dismiss = el.querySelector(".toast-dismiss")?.getBoundingClientRect()
          const card = el.getBoundingClientRect()
          return {
            cardWidth: card.width,
            iconWidth: icon?.width ?? 0,
            iconRight: (icon?.x ?? 0) + (icon?.width ?? 0),
            msgLeft: msg?.x ?? 0,
            msgWidth: msg?.width ?? 0,
            msgHeight: msg?.height ?? 0,
            msgRight: (msg?.x ?? 0) + (msg?.width ?? 0),
            dismissLeft: dismiss?.x ?? 0,
            touchAction: getComputedStyle(el).touchAction,
            docOverflow: document.documentElement.scrollWidth - window.innerWidth,
          }
        })

        expect(m.iconWidth, label).toBeGreaterThanOrEqual(24)
        expect(m.iconWidth, label).toBeLessThanOrEqual(36)
        expect(m.msgWidth, label).toBeGreaterThanOrEqual(120)
        expect(m.msgHeight, label).toBeLessThan(maxMsgHeight)
        expect(m.iconRight, label).toBeLessThanOrEqual(m.msgLeft + 2)
        expect(m.msgRight, label).toBeLessThanOrEqual(m.dismissLeft + 2)
        expect(m.cardWidth, label).toBeLessThanOrEqual(viewport.width)
        expect(m.docOverflow, label).toBeLessThanOrEqual(0)
        expect(m.touchAction, label).toBe(viewport.width <= 768 ? "none" : "pan-y")
      }
    }
  })

  test("coalesces repeated non-error toasts cleanly while keeping errors distinct", async ({ page }) => {
    await page.goto("/")
    await page.evaluate(() => {
      window.showToast?.("Settings saved", "success")
      window.showToast?.("Settings saved", "success")
      window.showToast?.("Settings saved", "success")
      window.showToast?.("Save failed", "error")
      window.showToast?.("Save failed", "error")
    })

    const successToasts = page.locator("#toast-container .toast.success")
    await expect(successToasts).toHaveCount(1)
    await expect(successToasts.first()).toHaveAttribute("data-repeat-count", "3")
    // children[1] stays plain message text so E2E observers never read count pills
    expect(await successToasts.first().evaluate((el) => el.children[1]?.textContent ?? "")).toBe("Settings saved")
    await expect(page.locator("#sync-announcer")).toHaveText("Settings saved (3 times)")

    const errorToasts = page.locator("#toast-container .toast.error")
    await expect(errorToasts).toHaveCount(2)
  })

  test("protects persistent notifications and uncommitted force-commits during burst flood", async ({ page }) => {
    await page.goto("/")
    await page.evaluate(() => {
      window.__meithealToast?.({
        id: "persistent-sw",
        message: "Update ready",
        type: "info",
        persistent: true,
        action: { id: "sw-update-btn", label: "Refresh", closeOnClick: false, onClick: () => {} },
      })
      window.__meithealToast?.({
        id: "undo-pending",
        message: "Deleted task",
        type: "success",
        action: { label: "Undo", onClick: () => {} },
        onForceCommit: () => {},
      })
      for (let i = 1; i <= 7; i++) {
        window.showToast?.(`Ephemeral toast ${i}`, "info")
      }
    })

    await expect(page.locator("#sw-update-btn")).toBeVisible()
    await expect(page.locator('[data-toast-id="undo-pending"]')).toBeVisible()
    expect(await page.locator("#toast-container .toast").count()).toBeLessThanOrEqual(5)
  })

  test("flushes uncommitted force-commit once on pagehide and skips when Undo completes", async ({ page }) => {
    await page.goto("/")
    const outcome = await page.evaluate(() => {
      let rawCancelledCommits = 0
      let undone = 0
      let cancelledByUndo = false

      const h1 = window.__meithealToast?.({
        message: "Cancelled item",
        action: {
          label: "Undo",
          onClick: () => {
            cancelledByUndo = true
            undone += 1
          },
        },
        onDismiss: () => { if (!cancelledByUndo) rawCancelledCommits += 1 },
        onForceCommit: () => { if (!cancelledByUndo) rawCancelledCommits += 1 },
      })
      h1?.element.querySelector<HTMLButtonElement>(".toast-undo")?.click()

      window.__meithealToast?.({
        id: "throwing-undo-pagehide",
        message: "Throwing commit",
        action: { label: "Undo", onClick: () => {} },
        onForceCommit: () => { throw new Error("boom") },
      })

      let rawPendingForceCommits = 0
      let rawPendingDismissCommits = 0
      window.__meithealToast?.({
        id: "pending-undo-pagehide",
        message: "Pending delete",
        action: { label: "Undo", onClick: () => {} },
        onDismiss: () => { rawPendingDismissCommits += 1 },
        onForceCommit: () => { rawPendingForceCommits += 1 },
      })

      // Dispatch twice — throwing first commit must not skip second pending commit
      window.dispatchEvent(new Event("pagehide"))
      window.dispatchEvent(new Event("pagehide"))

      return {
        undone,
        rawCancelledCommits,
        rawPendingForceCommits,
        rawPendingDismissCommits,
        remainingPendingNode: document.querySelectorAll('[data-toast-id="pending-undo-pagehide"], [data-toast-id="throwing-undo-pagehide"]').length,
      }
    })

    expect(outcome.undone).toBe(1)
    expect(outcome.rawCancelledCommits).toBe(0)
    expect(outcome.rawPendingForceCommits).toBe(1)
    expect(outcome.rawPendingDismissCommits).toBe(0)
    expect(outcome.remainingPendingNode).toBe(0)
  })

  test("pauses timer on hover/focus, keeps #shortcut-modal visible, and handles Escape without closing modal", async ({ page }) => {
    await page.goto("/")
    await page.evaluate(() => {
      window.__meithealToast?.({
        id: "hover-pause-test",
        message: "Hover stays open",
        type: "info",
        duration: 450,
      })
    })
    const card = page.locator('[data-toast-id="hover-pause-test"]')
    await expect(card).toBeVisible()
    await card.hover()
    await page.waitForTimeout(650)
    await expect(card).toBeVisible()

    // Open keyboard shortcut modal while toast popover is active — must remain visible
    await page.keyboard.press("?")
    const shortcutModal = page.locator("#shortcut-modal")
    await expect(shortcutModal).toBeVisible()
    await expect(shortcutModal).toHaveCSS("visibility", "visible")

    // While focused on toast inside open #shortcut-modal, app shortcuts stay blocked and Tab traps back
    await card.locator(".toast-dismiss").focus()
    await page.keyboard.press("n")
    await page.keyboard.press("/")
    await expect(page.locator("#new-task-overlay.active")).toHaveCount(0)
    await expect(page.locator("#search-hub-overlay:not(.hidden)")).toHaveCount(0)
    await page.keyboard.press("Tab")
    expect(
      await page.evaluate(() => Boolean(document.getElementById("shortcut-modal")?.contains(document.activeElement))),
    ).toBe(true)

    // Pressing Escape on focused toast dismisses only the toast, keeping shortcut modal intact
    await card.locator(".toast-dismiss").focus()
    await page.keyboard.press("Escape")
    await expect(card).toHaveCount(0)
    await expect(shortcutModal).toBeVisible()
  })

  test("handles desktop swipe, drag-from-button guard, swipe-exit transition, and pointercancel", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto("/")

    await page.evaluate(() => {
      window.__meithealToast?.({ id: "swipe-wrong-way", message: "Snap back left", duration: 15000 })
    })
    const snapCard = page.locator('[data-toast-id="swipe-wrong-way"]')
    await expect(snapCard).toBeVisible()

    // Wrong-way drag snaps back
    await swipeElement(page, snapCard, -180, 0)
    await expect(snapCard).toBeVisible()
    await expect(snapCard).toHaveCSS("opacity", "1")

    // pointercancel cleans inline visuals cleanly
    await swipeElement(page, snapCard, 120, 0, { cancel: true })
    await expect(snapCard).toBeVisible()
    await expect(snapCard).toHaveCSS("opacity", "1")

    // Drag starting directly on .toast-dismiss and moving > 8px must never initiate swipe
    await swipeElement(page, snapCard, 160, 0, {
      targetSelector: ".toast-dismiss",
      assertMidDrag: async () => {
        expect(await snapCard.getAttribute("data-swiping")).toBeNull()
      },
    })
    expect(await snapCard.getAttribute("data-swiping")).toBeNull()
    await expect(snapCard).toBeVisible()

    // Locking axis at 16px then releasing immediately without post-lock velocity must not false-flick
    await page.evaluate(() => {
      const el = document.querySelector<HTMLElement>('[data-toast-id="swipe-wrong-way"]')!
      const rect = el.getBoundingClientRect()
      const sx = rect.x + rect.width * 0.5
      const sy = rect.y + rect.height * 0.5
      el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerId: 88, button: 0, clientX: sx, clientY: sy }))
      window.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, cancelable: true, pointerId: 88, clientX: sx + 16, clientY: sy }))
      window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, pointerId: 88, clientX: sx + 16, clientY: sy }))
    })
    await expect(snapCard).toBeVisible()
    await expect(snapCard).toHaveCSS("opacity", "1")

    // Object.prototype key names (e.g., "constructor") resolve literally instead of inherited properties
    await page.evaluate(() => { window.showToast?.("constructor", "info", { id: "proto-key", duration: 15000 }) })
    await expect(page.locator('[data-toast-id="proto-key"] .m-toast__message')).toHaveText("constructor")

    // Swipe right beyond threshold clears data-swiping so exit animates & dismisses
    await swipeElement(page, snapCard, 180, 0)
    await expect(snapCard).toHaveCount(0)
  })

  test("handles mobile vertical/horizontal swipe, deterministic flick, #mobile-tab-bar clearance & keyboard dock", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto("/")

    await page.evaluate(() => {
      window.__meithealToast?.({ id: "mobile-pos", message: "Mobile layout check", duration: 15000 })
    })
    const card = page.locator('[data-toast-id="mobile-pos"]')
    await expect(card).toBeVisible()

    const navBar = page.locator("#mobile-tab-bar")
    await expect(navBar).toBeVisible()
    const cardBox = await card.boundingBox()
    const navBox = await navBar.boundingBox()
    expect(cardBox!.y + cardBox!.height).toBeLessThanOrEqual(navBox!.y + 1)

    // Keyboard-open dock flips container to top safe area
    await page.evaluate(() => {
      const c = document.getElementById("toast-container")
      if (c) c.dataset.keyboardOpen = "true"
    })
    const topCardBox = await card.boundingBox()
    expect(topCardBox!.y).toBeLessThan(120)
    await expect(card).toHaveCSS("opacity", "1")
    await page.evaluate(() => {
      const c = document.getElementById("toast-container")
      if (c) delete c.dataset.keyboardOpen
    })

    // Below-threshold mobile drag snaps back
    await swipeElement(page, card, 0, 22, { stepDelayMs: 120 })
    await expect(card).toBeVisible()

    // Mobile swipe down dismisses
    await swipeElement(page, card, 0, 96)
    await expect(card).toHaveCount(0)

    // Deterministic high-velocity short flick within a single browser task (no IPC jitter)
    await page.evaluate(() => {
      window.__meithealToast?.({ id: "mobile-flick", message: "Quick flick", duration: 15000 })
      const el = document.querySelector<HTMLElement>('[data-toast-id="mobile-flick"]')!
      const rect = el.getBoundingClientRect()
      const sx = Math.max(40, rect.x + rect.width * 0.5)
      const sy = rect.y + rect.height * 0.5
      el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerId: 77, button: 0, clientX: sx, clientY: sy }))
      window.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, cancelable: true, pointerId: 77, clientX: sx - 20, clientY: sy }))
      window.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, cancelable: true, pointerId: 77, clientX: sx - 56, clientY: sy }))
      window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, pointerId: 77, clientX: sx - 56, clientY: sy }))
    })
    await expect(page.locator('[data-toast-id="mobile-flick"]')).toHaveCount(0)
  })

  test("PwaInstallBanner uses light surface tokens, preserves modal scroll lock, and swipes up", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.addInitScript(() => {
      localStorage.setItem("meitheal-theme", "light")
      localStorage.removeItem("meitheal-pwa-dismissed")
    })
    await page.goto("/")

    await page.evaluate(() => {
      document.getElementById("task-detail-overlay")?.classList.add("active")
      document.body.style.overflow = "hidden"
      window.dispatchEvent(new CustomEvent("meitheal-pwa-installable"))
    })

    const banner = page.locator("#pwa-install-banner")
    await expect(banner).toHaveClass(/pwa-banner--visible/)

    // Light theme background should resolve to a bright card surface (luminance > 0.7)
    const bgLuminance = await banner.evaluate((el) => {
      const [r = 0, g = 0, b = 0] = getComputedStyle(el).backgroundColor.match(/\d+/g)?.map(Number) ?? []
      return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
    })
    expect(bgLuminance).toBeGreaterThan(0.7)

    await swipeElement(page, banner, 0, -72)
    await expect(banner).not.toHaveClass(/pwa-banner--visible/)
    expect(await page.evaluate(() => document.body.style.overflow)).toBe("hidden")
    expect(await page.evaluate(() => localStorage.getItem("meitheal-pwa-dismissed"))).toBe("permanent")
  })

  for (const cfg of [
    { theme: "dark", locale: "en" },
    { theme: "light", locale: "en" },
    { theme: "dark", locale: "ga" },
    { theme: "light", locale: "ga" },
  ] as const) {
    test(`meets reduced-motion sync removal, info accent, Irish localization, and Axe contrast (${cfg.theme}/${cfg.locale})`, async ({ page, baseURL }) => {
      await page.emulateMedia({ reducedMotion: "reduce" })
      await page.addInitScript((theme) => localStorage.setItem("meitheal-theme", theme), cfg.theme)
      await page.context().addCookies([{ name: "meitheal-locale", value: cfg.locale, url: baseURL ?? process.env.E2E_BASE_URL! }])
      await page.goto("/")
      await expect(page.locator("html")).toHaveAttribute("data-theme", cfg.theme)

      await page.evaluate(() => {
        window.__meithealToast?.({
          id: "axe-success",
          message: "common.task_completed",
          type: "success",
          duration: 15000,
          action: { label: "toast.undo", onClick: () => {} },
        })
        window.__meithealToast?.({ id: "axe-error", message: "common.failed_update", type: "error", duration: 15000 })
        window.__meithealToast?.({ id: "axe-warning", message: "common.task_version_conflict", type: "warning", duration: 15000 })
        window.__meithealToast?.({
          id: "axe-info",
          message: "toast.pwa_update_available",
          description: "v2 ready",
          type: "info",
          duration: 15000,
          action: { label: "toast.pwa_refresh", primary: true, onClick: () => {} },
        })
      })

      if (cfg.locale === "ga") {
        await expect(page.locator('[data-toast-id="axe-success"] .m-toast__message')).toHaveText("Tasc críochnaithe!")
        await expect(page.locator('[data-toast-id="axe-success"] .m-toast__action')).toHaveText("Cuir ar ceal")
      }

      const infoCard = page.locator('[data-toast-id="axe-info"]')
      await expect(infoCard).toBeVisible()
      const borderAndAccent = await infoCard.evaluate((el) => ({
        start: getComputedStyle(el).borderInlineStartColor,
        top: getComputedStyle(el).borderTopColor,
      }))
      expect(borderAndAccent.start).not.toBe("rgba(0, 0, 0, 0)")
      expect(borderAndAccent.start).not.toBe(borderAndAccent.top)

      const axe = await new AxeBuilder({ page }).include("#toast-container").withRules(["color-contrast"]).analyze()
      expect(axe.violations, `Contrast violations in ${cfg.theme}/${cfg.locale}`).toEqual([])

      // Under reduced motion, dismiss click removes synchronously without animation timer
      const removedImmediately = await page.evaluate(() => {
        const card = document.querySelector('[data-toast-id="axe-info"]')!
        card.querySelector<HTMLButtonElement>(".toast-dismiss")!.click()
        return document.querySelector('[data-toast-id="axe-info"]') === null
      })
      expect(removedImmediately).toBe(true)
    })
  }

  test("returns Tab focus from Top-Layer toast back into SearchHub and localizes NewTask/prompt fallbacks in ga", async ({ page, baseURL }) => {
    await page.context().addCookies([{ name: "meitheal-locale", value: "ga", url: baseURL ?? process.env.E2E_BASE_URL! }])
    await page.goto("/")

    // Open SearchHub via slash key and spawn a toast inside Top-Layer #toast-container
    await page.keyboard.press("/")
    const searchPanel = page.locator("#search-hub-overlay:not(.hidden) .search-hub-panel")
    await expect(searchPanel).toBeVisible()
    await page.evaluate(() => {
      window.__meithealToast?.({ id: "search-trap-toast", message: "Sa chúlra", duration: 15000 })
    })
    const dismiss = page.locator('[data-toast-id="search-trap-toast"] .toast-dismiss')
    await dismiss.focus()
    await page.keyboard.press("Tab")
    expect(
      await page.evaluate(() => Boolean(document.querySelector("#search-hub-overlay .search-hub-panel")?.contains(document.activeElement))),
    ).toBe(true)
    await page.keyboard.press("Escape")
    await expect(page.locator("#search-hub-overlay")).toHaveClass(/hidden/)

    // NewTaskModal retains localized data-toast-created in ga locale
    await expect(page.locator("#new-task-form")).toHaveAttribute("data-toast-created", "Tasc cruthaithe!")

    // promptDialog resolves Irish defaults and required validation error
    const promptState = await page.evaluate(() => {
      const promise = window.promptDialog?.({ required: true })
      const ok = document.getElementById("prompt-ok")
      const cancel = document.getElementById("prompt-cancel")
      const title = document.getElementById("prompt-title")?.textContent ?? ""
      ok?.click()
      const err = document.getElementById("prompt-error")?.textContent ?? ""
      const cancelText = cancel?.textContent ?? ""
      const okText = ok?.textContent ?? ""
      cancel?.click()
      return promise?.then(() => ({ title, okText, cancelText, err }))
    })
    expect(promptState).toEqual({
      title: "Ionchur",
      okText: "Ceart go leor",
      cancelText: "Cealaigh",
      err: "Tá an réimse seo riachtanach",
    })
  })

  test("preserves literal $ sequences in toast formatting and focus across chained confirm -> prompt dialogs", async ({ page }) => {
    await page.goto("/today")

    const msgWithDollar = "Saved $& and $1"
    await page.evaluate((msg) => {
      window.__meithealToast?.({ message: msg, duration: 15000 })
      window.__meithealToast?.({ message: msg, duration: 15000 })
    }, msgWithDollar)

    await expect(page.locator('#toast-container .toast[data-repeat-count="2"] .m-toast__message')).toHaveText(msgWithDollar)
    await expect(page.locator("#sync-announcer")).toHaveText(`${msgWithDollar} (2 times)`)

    // Create a task via NewTaskModal whose title and ticket key include literal $ replacement sequences
    await page.route("**/api/tasks", async (route) => {
      if (route.request().method() !== "POST") return route.continue()
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({ id: "t-dollar", ticket_key: "T-$1", task_kind: "quick_capture" }),
      })
    })
    await page.getByRole("button", { name: "New Task", exact: true }).click()
    await page.locator("#new-task-title-input").fill("Plan $& $1 budget")
    await page.evaluate(() => {
      document.addEventListener("meitheal:tasks-changed", (e) => e.stopImmediatePropagation(), { capture: true, once: true })
    })
    await page.locator("#submit-new-task-btn").click()

    const createdToast = page.locator("#toast-container .toast:has(.m-toast__ticket-btn)")
    await expect(createdToast.locator(".m-toast__message")).toHaveText("Created: Plan $& $1 budget")
    await expect(createdToast.locator(".m-toast__ticket-btn")).toHaveText("T-$1")
    await expect(createdToast.locator(".m-toast__ticket-btn")).toHaveAttribute("aria-label", "Open task T-$1")
    await page.unroute("**/api/tasks")
    await expect(page.locator("#new-task-overlay")).not.toHaveClass(/active/)

    // Chained confirmDialog -> promptDialog must close synchronously so confirm does not clobber prompt or focus return
    await page.evaluate(() => {
      const btn = document.createElement("button")
      btn.id = "chained-dialog-trigger"
      btn.type = "button"
      btn.textContent = "Chain"
      document.body.appendChild(btn)
      btn.focus()
      void window.confirmDialog?.({ title: "Step 1", message: "Continue?" }).then((accepted) => {
        if (!accepted) return
        void window.promptDialog?.({ title: "Step 2", defaultValue: "ready" })
      })
    })

    await expect(page.locator("#meitheal-confirm-overlay")).toBeVisible()
    await page.locator("#confirm-ok").click()

    await expect(page.locator("#meitheal-confirm-overlay")).toHaveCount(0)
    await expect(page.locator("#meitheal-prompt-overlay")).toBeVisible()
    await expect(page.locator("#prompt-input")).toBeFocused()

    await page.locator("#prompt-cancel").click()
    await expect(page.locator("#meitheal-prompt-overlay")).toHaveCount(0)
    await expect(page.locator("#chained-dialog-trigger")).toBeFocused()

    await page.evaluate(() => document.getElementById("chained-dialog-trigger")?.remove())
  })

  test("offsets toasts above open bulk bar while preserving higher Pomodoro panel clearance", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto("/")

    const clearances = await page.evaluate(() => {
      window.showToast?.("Bulk clearance test", "info")
      const container = document.getElementById("toast-container")!
      const bar = document.createElement("div")
      bar.className = "bulk-bar"
      bar.dataset.bulkOpen = "true"
      document.body.appendChild(bar)
      const withBulkBar = getComputedStyle(container).getPropertyValue("--toast-fab-clearance").trim()

      const panel = document.getElementById("pomodoro-panel")
      let withBulkAndPomodoro = ""
      if (panel) {
        panel.classList.remove("pomodoro-hidden")
        withBulkAndPomodoro = getComputedStyle(container).getPropertyValue("--toast-fab-clearance").trim()
        panel.classList.add("pomodoro-hidden")
      }
      bar.remove()
      return { withBulkBar, withBulkAndPomodoro, hasPanel: Boolean(panel) }
    })

    expect(clearances.withBulkBar).toBe("84px")
    if (clearances.hasPanel) {
      expect(clearances.withBulkAndPomodoro).toBe("308px")
    }
  })
})
