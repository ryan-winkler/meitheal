import { containTabFocus, createFocusTrap } from "@lib/focus-trap"
import { singleKeyShortcutsEnabled } from "@lib/single-key-shortcuts"

export function hasPriorityOverlay(): boolean {
  return Boolean(
    document.querySelector("dialog[open], #meitheal-confirm-overlay, #meitheal-prompt-overlay") ||
    (typeof HTMLElement.prototype.showPopover === "function" && document.querySelector("[popover]:popover-open")),
  )
}

export function initShortcutModal(signal: AbortSignal) {
  const overlay = document.getElementById("shortcut-modal")
  if (!overlay) return
  const content = overlay.querySelector<HTMLElement>(".shortcut-modal-content")
  const closeButton = document.getElementById("shortcut-modal-close")
  const focusTrap = createFocusTrap(overlay)
  const isOpen = () => !overlay.classList.contains("hidden")
  const isActive = () => isOpen() && !hasPriorityOverlay()

  const open = () => {
    if (isOpen() || hasPriorityOverlay()) return false
    overlay.classList.remove("hidden")
    focusTrap.activate()
    return true
  }

  const close = () => {
    overlay.classList.add("hidden")
    focusTrap.deactivate()
  }

  overlay.addEventListener("mousedown", event => {
    // A confirmation arriving before click needs Close as its focus return target.
    const target = event.target
    if (event.button !== 0 || !(target instanceof Node) || closeButton?.contains(target)) return
    if (content && target === content) {
      const { left, top } = content.getBoundingClientRect()
      const x = event.clientX - left - content.clientLeft
      const y = event.clientY - top - content.clientTop
      if (x < 0 || x >= content.clientWidth || y < 0 || y >= content.clientHeight) return
    }
    event.preventDefault()
  }, { signal })
  overlay.addEventListener("click", event => {
    // Keep help interactions from dismissing the underlying popup.
    event.stopPropagation()
    if (event.target === overlay) close()
    else if (isOpen() && !overlay.contains(document.activeElement)) closeButton?.focus({ preventScroll: true })
  }, { signal })
  closeButton?.addEventListener("click", close, { signal })

  const handleKeyDown = (event: KeyboardEvent) => {
    // Keep app shortcuts outside the dialog while allowing native button activation.
    event.stopPropagation()
    if (event.key === "Escape" || (event.key === "?" && !event.repeat &&
        !event.ctrlKey && !event.metaKey && !event.altKey && singleKeyShortcutsEnabled())) {
      event.preventDefault()
      close()
    }
  }
  overlay.addEventListener("keydown", event => {
    if (isActive()) handleKeyDown(event)
  }, { signal })
  document.addEventListener("keydown", event => {
    if (!isActive() || (event.target instanceof Node && overlay.contains(event.target))) return
    handleKeyDown(event)
    containTabFocus(overlay, event)
    event.preventDefault()
  }, { capture: true, signal })
  signal.addEventListener("abort", () => focusTrap.deactivate(false), { once: true })

  return open
}
