// layout-shortcuts-controller.ts — Extracted from Layout.astro
// Handles: keyboard shortcuts modal open/close with focus trap

import { createFocusTrap } from "@lib/focus-trap"

const shortcutOverlay = document.getElementById("shortcut-modal")
const shortcutTrap = shortcutOverlay ? createFocusTrap(shortcutOverlay) : null

function openShortcutModal() {
  shortcutOverlay?.classList.remove("hidden")
  shortcutTrap?.activate()
}

function closeShortcutModal() {
  shortcutTrap?.deactivate()
  shortcutOverlay?.classList.add("hidden")
}

shortcutOverlay?.addEventListener("click", (e) => {
  if (e.target === shortcutOverlay) closeShortcutModal()
})

document.getElementById("shortcut-modal-close")?.addEventListener("click", () => {
  closeShortcutModal()
})

// Expose for external callers (e.g. layout-controller keyboard shortcuts)
export { openShortcutModal, closeShortcutModal }
