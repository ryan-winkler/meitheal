/**
 * kanban-quick-actions.ts — Popover utility, child task, assign user, set color
 *
 * @domain kanban
 * @kcs Extracted from kanban-controller.ts for decomposition.
 *      Manages the shared popover system and all quick-action card buttons.
 */
import { createClientLogger } from "@lib/client-logger"
import { notifyInactivityTaskChanged } from "@lib/inactivity-client"
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
      notifyInactivityTaskChanged(taskId)
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
