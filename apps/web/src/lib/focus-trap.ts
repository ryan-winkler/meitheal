/**
 * Focus Trap — Keyboard focus containment for modals and overlays
 *
 * @domain accessibility
 * @bounded-context a11y
 *
 * @kcs Creates a focus trap that constrains Tab/Shift+Tab within a container.
 * Used by command palette, new task modal, and keyboard shortcuts modal.
 * Automatically restores focus to the previously focused element on release.
 *
 * Usage:
 *   const trap = createFocusTrap(dialogEl)
 *   trap.activate()
 *   // ... when closing:
 *   trap.deactivate()
 */

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(", ")

export interface FocusTrap {
  activate(): void
  deactivate(): void
}

export function createFocusTrap(container: HTMLElement): FocusTrap {
  let previouslyFocused: HTMLElement | null = null
  let handler: ((e: KeyboardEvent) => void) | null = null

  function getFocusableElements(): HTMLElement[] {
    return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
      .filter(el => el.offsetParent !== null) // visible only
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key !== "Tab") return

    const focusable = getFocusableElements()
    if (focusable.length === 0) return

    const first = focusable[0]!
    const last = focusable[focusable.length - 1]!

    if (e.shiftKey) {
      if (document.activeElement === first) {
        e.preventDefault()
        last.focus()
      }
    } else {
      if (document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
  }

  return {
    activate() {
      previouslyFocused = document.activeElement as HTMLElement | null
      handler = onKeyDown
      container.addEventListener("keydown", handler)

      // Focus first focusable element
      const focusable = getFocusableElements()
      if (focusable.length > 0) {
        // Try autofocus first, then first focusable
        const autoFocusEl = container.querySelector<HTMLElement>("[autofocus]")
        ;(autoFocusEl || focusable[0])?.focus()
      }
    },

    deactivate() {
      if (handler) {
        container.removeEventListener("keydown", handler)
        handler = null
      }
      // Restore previous focus
      if (previouslyFocused && previouslyFocused.isConnected) {
        previouslyFocused.focus()
      }
      previouslyFocused = null
    },
  }
}
