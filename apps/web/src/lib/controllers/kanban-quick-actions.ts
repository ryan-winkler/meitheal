/**
 * kanban-quick-actions.ts — Popover utility, child task, assign user, set color
 *
 * @domain kanban
 * @kcs Extracted from kanban-controller.ts for decomposition.
 *      Manages the shared popover system and all quick-action card buttons.
 */
import { createClientLogger } from "@lib/client-logger"
import { sanitizeCssColor } from "@lib/safe-html"
import { showToast } from "@lib/toast"
import type { KanbanRefreshFocus } from "./kanban-page-controller"

const log = createClientLogger("kanban:quick-actions")

/** Quick-action popover API returned by initQuickActions */
export interface QuickActionApi {
  close: () => void
  toast: (msg: string, type?: "success" | "error" | "warning") => void
  open: (btn: HTMLElement, content: HTMLElement, title: string) => HTMLElement
}

/**
 * Initialise the shared quick-action popover system and all card action buttons.
 *
 * @param buildTaskApiUrl – shared URL builder from kanban-controller
 * @param __signal – AbortSignal for listener cleanup
 * @returns QuickActionApi for use by other kanban modules
 */
export function initQuickActions(
  buildTaskApiUrl: (taskId: string | number | null, suffix?: string) => string,
  __signal: AbortSignal,
  refreshBoard: (focus?: KanbanRefreshFocus) => Promise<void>,
): QuickActionApi {
  // =============================================
  // Shared Popover Utility (P4-1)
  // =============================================
  let activePopover: HTMLElement | null = null
  let activeTrigger: HTMLElement | null = null
  let _scrollCleanup: (() => void) | null = null

  function close(restoreFocus = false) {
    if (!activePopover) return
    const el = activePopover
    const trigger = activeTrigger
    activePopover = null
    activeTrigger = null
    el.inert = true
    el.setAttribute("aria-hidden", "true")
    el.classList.add("popover-exiting")
    setTimeout(() => el.remove(), 150)
    if (_scrollCleanup) { _scrollCleanup(); _scrollCleanup = null }
    if (restoreFocus) trigger?.focus({ preventScroll: true })
  }

  __signal.addEventListener("abort", () => {
    activePopover?.remove()
    _scrollCleanup?.()
  }, { once: true })

  function toast(msg: string, type: "success" | "error" | "warning" = "success") {
    showToast(msg, type)
  }

  async function saveColor(button: HTMLButtonElement, taskId: string, color: string | null) {
    if (__signal.aborted || button.disabled) return
    close()
    button.closest(".kanban-card")?.querySelector<HTMLElement>(".card-more-btn")?.focus({ preventScroll: true })
    button.disabled = true
    try {
      const response = await fetch(buildTaskApiUrl(taskId), {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ color }),
      })
      if (!response.ok) throw new Error("Color write rejected")
      await refreshBoard({ taskId })
      toast(color ? "Color updated" : "Color cleared", "success")
    } catch {
      if (!__signal.aborted) toast(color ? "Failed to set color" : "Failed to clear color", "error")
    } finally {
      button.disabled = false
    }
  }

  function open(btn: HTMLElement, content: HTMLElement, title: string) {
    close()
    const popover = document.createElement("div")
    popover.className = "quick-action-popover"
    popover.setAttribute("role", "dialog")
    popover.setAttribute("aria-label", title)

    const header = document.createElement("div")
    header.className = "popover-title"
    header.id = "qa-popover-title-" + Date.now()
    header.textContent = title
    popover.setAttribute("aria-labelledby", header.id)
    popover.appendChild(header)
    popover.appendChild(content)

    // Position near button
    const rect = btn.getBoundingClientRect()
    popover.style.position = "fixed"
    popover.style.top = `${rect.bottom + 4}px`

    // P6-1: Use CSS logical properties for popover positioning
    const INLINE_START_PROP = "insetInlineStart" in popover.style ? "insetInlineStart" : "left"
    popover.style[INLINE_START_PROP] = `${rect.left}px`
    popover.style.zIndex = "9999"
    document.body.appendChild(popover)
    activePopover = popover

    activeTrigger = btn
    const position = () => {
      if (activePopover !== popover) return
      const rect = btn.getBoundingClientRect()
      const box = popover.getBoundingClientRect()
      popover.style[INLINE_START_PROP] = `${Math.max(8, Math.min(rect.left, window.innerWidth - box.width - 8))}px`
      popover.style.top = `${Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - box.height - 8))}px`
    }
    requestAnimationFrame(position)
    window.addEventListener("scroll", position, { capture: true, passive: true, signal: __signal })
    _scrollCleanup = () => window.removeEventListener("scroll", position, true)

    // Focus first interactive element (P1-1)
    requestAnimationFrame(() => {
      const first = popover.querySelector("button, [tabindex]")
      if (activePopover === popover && first instanceof HTMLElement) first.focus({ preventScroll: true })
    })

    return popover
  }

  // P0-3: Single consolidated document listener for all popovers
  document.addEventListener("click", (e) => {
    if (activePopover && !activePopover.contains(e.target as Node) &&
        !(e.target as HTMLElement)?.closest(".card-assign-btn, .card-color-btn")) {
      close()
    }
  }, { signal: __signal })

  document.addEventListener("keydown", (e) => {
    if (!activePopover) return
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(true); return }
    // Arrow key navigation within popover items (P1-1)
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault()
      const items = [...activePopover.querySelectorAll("button.popover-item, button.color-swatch")]
      if (!items.length) return
      const idx = items.indexOf(document.activeElement as Element)
      const next = e.key === "ArrowDown"
        ? items[(idx + 1) % items.length]
        : items[(idx - 1 + items.length) % items.length]
      ;(next as HTMLElement)?.focus({ preventScroll: true })
    }
  }, { signal: __signal })

  // P2-4: Cleanup listeners on Astro navigation
  document.addEventListener("astro:before-swap", () => close(), { once: true, signal: __signal })

  const _qa = { close, toast, open }

  // =============================================
  // Quick Action: Add Child Task (P1-3, P1-6, P3-6)
  // =============================================
  document.querySelectorAll<HTMLButtonElement>(".card-child-btn").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation()
      const parentId = btn.dataset.id
      const parentTitle = btn.dataset.title || "Task"
      const parentPriority = btn.dataset.priority || "3"
      if (!parentId) return

      const card = btn.closest(".kanban-card") as HTMLElement | null
      const areaId = card?.dataset.area || ""

      btn.disabled = true
      btn.classList.add("btn-loading")
      try {
        const res = await fetch("/api/tasks", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            title: `${parentTitle.slice(0, 80)} — Subtask`,
            parent_id: parentId,
            status: "pending",
            priority: Number(parentPriority),
            area_id: areaId || undefined,
            task_type: "task",
          }),
        })
        if (res.ok) {
          _qa.toast("Child task created", "success")
          // P1-6: Refresh to show new card
          const scrollLeft = document.querySelector(".kanban-scroll-area")?.scrollLeft || 0
          sessionStorage.setItem("meitheal-kanban-scroll", String(scrollLeft))
          document.dispatchEvent(new CustomEvent("meitheal:tasks-changed", { detail: { action: "kanban-child-created" } }))
        } else {
          _qa.toast("Failed to create child task", "error")
        }
      } catch (err) {
        log.warn("Add child failed", err)
        _qa.toast("Failed to create child task", "error")
      } finally {
        btn.disabled = false
        btn.classList.remove("btn-loading")
      }
    }, { signal: __signal })
  })

  // Restore scroll position after child task reload (P1-6)
  const savedScroll = sessionStorage.getItem("meitheal-kanban-scroll")
  if (savedScroll) {
    sessionStorage.removeItem("meitheal-kanban-scroll")
    requestAnimationFrame(() => {
      const scrollArea = document.querySelector(".kanban-scroll-area")
      if (scrollArea) scrollArea.scrollLeft = Number(savedScroll)
    })
  }

  // =============================================
  // Quick Action: Assign User (P1-5, P2-7, P3-4)
  // =============================================
  document.querySelectorAll<HTMLButtonElement>(".card-assign-btn").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation()

      const taskId = btn.dataset.id
      const currentAssigned = btn.dataset.assigned || ""
      if (!taskId) return

      // P1-5: Show popover immediately with loading skeleton
      const content = document.createElement("div")
      const skel1 = document.createElement("div")
      skel1.className = "popover-item skeleton"
      skel1.style.cssText = "height:28px;border-radius:var(--radius-sm);background:var(--bg-hover);animation:pulse 1.5s infinite"
      const skel2 = document.createElement("div")
      skel2.className = "popover-item skeleton"
      skel2.style.cssText = "height:28px;border-radius:var(--radius-sm);background:var(--bg-hover);animation:pulse 1.5s infinite;animation-delay:0.3s"
      content.append(skel1, skel2)
      const popover = _qa.open(btn, content, "Assign User")

      // Fetch users
      let users: any[] = []
      try {
        const res = await fetch("/api/users")
        if (res.ok) {
          const data = await res.json()
          users = data.users || []
        }
      } catch { /* fallback to empty */ }

      // Replace skeleton with real content
      if (activePopover !== popover) return
      content.replaceChildren()

      // Unassign option
      const unassignItem = document.createElement("button")
      unassignItem.className = "popover-item" + (!currentAssigned ? " active" : "")
      unassignItem.setAttribute("role", "menuitem")
      unassignItem.textContent = "∅ Unassigned"
      unassignItem.addEventListener("click", async () => {
        // P3-4: Optimistic update
        btn.dataset.assigned = ""
        const card = btn.closest(".kanban-card")
        if (card) (card as HTMLElement).dataset.assigned = ""
        _qa.close()
        try {
          const res = await fetch(buildTaskApiUrl(taskId), {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ assigned_to: null }),
          })
          if (res.ok) {
            _qa.toast("Unassigned", "success")
            await refreshBoard()
          } else { btn.dataset.assigned = currentAssigned; _qa.toast("Failed to unassign", "error") }
        } catch { btn.dataset.assigned = currentAssigned; _qa.toast("Failed to unassign", "error") }
      })
      content.appendChild(unassignItem)

      // User list with colored dots (P2-7)
      users.forEach((user: any) => {
        const userId = user.id || user.name
        const item = document.createElement("button")
        item.className = "popover-item" + (currentAssigned === userId ? " active" : "")
        item.setAttribute("role", "menuitem")
        // P2-7: Colored dot for user recognition
        if (user.color) {
          const dot = document.createElement("span")
          dot.style.cssText = `display:inline-block;width:8px;height:8px;border-radius:50%;background:${sanitizeCssColor(user.color)};margin-right:6px;vertical-align:middle`
          item.appendChild(dot)
        } else {
          item.appendChild(document.createTextNode("👤 "))
        }
        item.appendChild(document.createTextNode(user.name || user.id))
        item.addEventListener("click", async () => {
          // P3-4: Optimistic update
          btn.dataset.assigned = userId
          const card = btn.closest(".kanban-card")
          if (card) (card as HTMLElement).dataset.assigned = userId
          _qa.close()
          try {
            const res = await fetch(buildTaskApiUrl(taskId), {
              method: "PUT",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ assigned_to: userId }),
            })
            if (res.ok) {
              _qa.toast(`Assigned to ${(user.name || userId).replace(/^(ha_|custom_)/, "")}`, "success")
              await refreshBoard()
            } else { btn.dataset.assigned = currentAssigned; _qa.toast("Failed to assign", "error") }
          } catch { btn.dataset.assigned = currentAssigned; _qa.toast("Failed to assign", "error") }
        })
        content.appendChild(item)
      })

      if (!users.length) {
        const empty = document.createElement("div")
        empty.className = "popover-item"
        empty.style.color = "var(--text-muted)"
        empty.style.fontStyle = "italic"
        empty.textContent = "No users configured"
        content.appendChild(empty)
      }
    }, { signal: __signal })
  })

  // =============================================
  // Quick Action: Set Color (P1-2, P3-4)
  // =============================================
  ;(() => {
    const COLOR_SWATCHES = [
      { color: "#ef4444", label: "Red" },
      { color: "#f97316", label: "Orange" },
      { color: "#eab308", label: "Yellow" },
      { color: "#22c55e", label: "Green" },
      { color: "#3b82f6", label: "Blue" },
      { color: "#8b5cf6", label: "Purple" },
      { color: "#ec4899", label: "Pink" },
      { color: "#6b7280", label: "Gray" },
    ]

    document.querySelectorAll<HTMLButtonElement>(".card-color-btn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation()

        const taskId = btn.dataset.id
        if (!taskId) return

        const currentColor = btn.dataset.color || ""

        const content = document.createElement("div")

        const grid = document.createElement("div")
        grid.className = "color-swatch-grid"
        grid.setAttribute("role", "radiogroup")
        grid.setAttribute("aria-label", "Color options")

        COLOR_SWATCHES.forEach(({ color, label }) => {
          const swatch = document.createElement("button")
          swatch.className = "color-swatch"
          // P1-2: Active color indicator
          if (currentColor && currentColor.toLowerCase() === color.toLowerCase()) {
            swatch.classList.add("swatch-active")
          }
          swatch.style.background = color
          swatch.title = label
          swatch.setAttribute("role", "radio")
          swatch.setAttribute("aria-checked", currentColor === color ? "true" : "false")
          swatch.setAttribute("aria-label", `Set color: ${label}`)
          swatch.addEventListener("click", () => {
            void saveColor(btn, taskId, color)
          }, { signal: __signal })
          grid.appendChild(swatch)
        })

        content.appendChild(grid)

        // Clear color button
        const clearBtn = document.createElement("button")
        clearBtn.className = "popover-item clear-color-btn"
        clearBtn.textContent = "✕ Clear color"
        clearBtn.addEventListener("click", () => {
          void saveColor(btn, taskId, null)
        }, { signal: __signal })
        content.appendChild(clearBtn)

        _qa.open(btn, content, "Card Color")
      }, { signal: __signal })
    })
  })()

  return _qa
}
