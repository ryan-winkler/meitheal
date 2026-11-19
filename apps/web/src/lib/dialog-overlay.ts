/**
 * Shared modal overlay stacking, Top-Layer promotion, and focus-restoration contracts.
 *
 * `openManagedDialog()` attaches `.m-dialog-overlay` (styled in `_feedback.css`) and promotes
 * confirmation/prompt overlays unconditionally via `popover="manual"`. Non-popover modal
 * controllers such as `openTablerModal()` call `notifyOverlayChange("opened" | "closed")` so
 * `@lib/toast` keeps `#toast-container` below active blocking layers.
 */

import { containTabFocus } from "./focus-trap"

export const UNPROMOTED_BLOCKING_OVERLAY_SELECTOR =
  "dialog[open], [data-meitheal-tabler-modal].show, #meitheal-confirm-overlay:not([popover]), #meitheal-prompt-overlay:not([popover])"

export const PRIORITY_OVERLAY_SELECTOR =
  'dialog[open], [data-meitheal-tabler-modal].show, #meitheal-confirm-overlay, #meitheal-prompt-overlay, #search-hub-overlay:not(.hidden), .habit-modal-overlay:not(.hidden), #ask-ha-overlay.active, #ask-ha-overlay:not(.modal-overlay):not(.hidden), [role="dialog"][aria-modal="true"].active:not(#shortcut-modal)'

const SELF_TRAPPED_OVERLAY_SELECTOR =
  "dialog[open], [data-meitheal-tabler-modal].show, #meitheal-confirm-overlay, #meitheal-prompt-overlay, #shortcut-modal:not(.hidden)"

export function findModalTrapTarget(): HTMLElement | null {
  if (
    document.querySelector(SELF_TRAPPED_OVERLAY_SELECTOR) ||
    (typeof HTMLElement.prototype.showPopover === "function" &&
      document.querySelector("[popover]:popover-open:not(#toast-container)"))
  ) {
    return null
  }
  return (
    document.querySelector<HTMLElement>("#search-hub-overlay:not(.hidden) .search-hub-panel") ??
    document.querySelector<HTMLElement>("#search-hub-overlay:not(.hidden)") ??
    document.querySelector<HTMLElement>(".habit-modal-overlay:not(.hidden) [role=dialog]") ??
    document.querySelector<HTMLElement>("#ask-ha-overlay.active [role=dialog], #ask-ha-overlay:not(.modal-overlay):not(.hidden)") ??
    document.querySelector<HTMLElement>('[role="dialog"][aria-modal="true"].active:not(#shortcut-modal):not(#task-detail-overlay)') ??
    (document.body.classList.contains("has-docked-inspector")
      ? null
      : document.querySelector<HTMLElement>("#task-detail-overlay.active"))
  )
}

export function dialogText(key: string, fallback: string): string {
  const resolved = typeof window !== "undefined" ? window.mI18n?.get(key) : undefined
  return resolved && resolved !== key ? resolved : fallback
}

const activeDismisses = new Map<string, () => void>()

export function notifyOverlayChange(phase: "opened" | "closed"): void {
  if (typeof document === "undefined") return
  document.dispatchEvent(new Event(phase === "opened" ? "meitheal:overlay-opened" : "meitheal:overlay-closed"))
}

export function canRestoreFocusTarget(target: HTMLElement | null): target is HTMLElement {
  if (!target || !target.isConnected || target.closest("[hidden], [inert], .hidden")) return false
  const modal =
    document.querySelector(PRIORITY_OVERLAY_SELECTOR) ??
    document.querySelector("#shortcut-modal:not(.hidden)")
  if (modal) return modal.contains(target)
  const detail = document.getElementById("task-detail-overlay")
  if (detail?.classList.contains("active") && !document.body.classList.contains("has-docked-inspector")) {
    return detail.contains(target)
  }
  return true
}

function mountOverlay(overlay: HTMLElement): void {
  document.body.append(overlay)
  if (typeof overlay.showPopover === "function") {
    // Promote blocking dialogs unconditionally into the top layer above non-modal popovers.
    overlay.setAttribute("popover", "manual")
    try {
      overlay.showPopover()
    } catch {
      overlay.removeAttribute("popover")
    }
  }
  notifyOverlayChange("opened")
}

export interface ManagedDialogOptions<T> {
  id: string
  role: "alertdialog" | "dialog"
  labelledBy: string
  describedBy?: string | undefined
  dialog: HTMLElement
  cancelValue: T
  signal?: AbortSignal | undefined
  resolve: (value: T) => void
  onBeforeClose?: ((result: T) => void) | undefined
  onEnter?: ((event: KeyboardEvent) => void) | undefined
}

export function openManagedDialog<T>(opts: ManagedDialogOptions<T>): {
  overlay: HTMLDivElement
  signal: AbortSignal
  isSettled: () => boolean
  close: (result: T, immediate?: boolean, restoreFocus?: boolean) => void
} {
  activeDismisses.get(opts.id)?.()

  const overlay = document.createElement("div")
  overlay.id = opts.id
  overlay.className = "m-dialog-overlay"
  overlay.setAttribute("role", opts.role)
  overlay.setAttribute("aria-modal", "true")
  overlay.setAttribute("aria-labelledby", opts.labelledBy)
  if (opts.describedBy) overlay.setAttribute("aria-describedby", opts.describedBy)
  overlay.appendChild(opts.dialog)

  const previouslyFocused = document.activeElement as HTMLElement | null
  mountOverlay(overlay)

  let settled = false
  let removeTimer: number | undefined
  const listeners = new AbortController()
  const close = (result: T, immediate = true, restoreFocus = true) => {
    const remove = () => {
      window.clearTimeout(removeTimer)
      listeners.abort()
      overlay.remove()
      if (activeDismisses.get(opts.id) === dismiss) activeDismisses.delete(opts.id)
      notifyOverlayChange("closed")
      if (restoreFocus && !opts.signal?.aborted && canRestoreFocusTarget(previouslyFocused)) previouslyFocused.focus()
    }
    if (settled) {
      if (immediate) remove()
      return
    }
    settled = true
    overlay.style.opacity = "0"
    overlay.style.pointerEvents = "none"
    opts.onBeforeClose?.(result)
    if (immediate) remove()
    else removeTimer = window.setTimeout(remove, 100)
    opts.resolve(result)
  }
  const abort = () => close(opts.cancelValue, true)
  const dismiss = () => close(opts.cancelValue, true, false)
  activeDismisses.set(opts.id, dismiss)

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close(opts.cancelValue)
  }, { signal: listeners.signal })
  // Let dialog controls handle native clicks/typing while keeping app shortcuts outside.
  overlay.addEventListener("keydown", (e) => e.stopPropagation(), { signal: listeners.signal })

  document.addEventListener("keydown", (e) => {
    if (settled) {
      if (e.key === "Escape") {
        e.preventDefault()
        e.stopPropagation()
      }
      return
    }
    if (e.key === "Escape") {
      if (document.activeElement?.closest("#toast-container")) return
      e.preventDefault()
      e.stopPropagation()
      close(opts.cancelValue)
    } else if (e.key === "Tab") {
      containTabFocus(opts.dialog, e)
    } else if (e.key === "Enter" && opts.onEnter) {
      opts.onEnter(e)
    }
  }, { capture: true, signal: listeners.signal })
  document.addEventListener("astro:before-swap", dismiss, { once: true, signal: listeners.signal })
  opts.signal?.addEventListener("abort", abort, { once: true, signal: listeners.signal })

  return { overlay, signal: listeners.signal, isSettled: () => settled, close }
}
