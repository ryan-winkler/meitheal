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
  "button",
  "input",
  "select",
  "textarea",
  "details > summary:first-of-type",
  "[tabindex]",
  "[contenteditable]",
].join(", ")

function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(element => {
    if (element.matches(":disabled") || element.closest("[inert]")) return false
    const editable = element.isContentEditable && !element.hasAttribute("tabindex")
      && !element.parentElement?.isContentEditable
    if (element.tabIndex < 0 && !editable) return false
    return element.checkVisibility?.({ visibilityProperty: true })
      ?? (element.getClientRects().length > 0 && getComputedStyle(element).visibility === "visible")
  })
}

export function containTabFocus(container: HTMLElement, event: KeyboardEvent): void {
  if (event.key !== "Tab" || event.defaultPrevented) return

  const focusable = getFocusableElements(container)
  const first = focusable[0]
  const last = focusable.at(-1)
  if (!first || !last) return

  const active = document.activeElement
  const boundary = event.shiftKey ? first : last
  if (active === boundary || !container.contains(active)) {
    event.preventDefault()
    ;(event.shiftKey ? last : first).focus()
  }
}

export interface FocusTrap {
  activate(): void
  deactivate(restoreFocus?: boolean): void
}

export function createFocusTrap(container: HTMLElement): FocusTrap {
  let previouslyFocused: HTMLElement | null = null
  const onKeyDown = (event: KeyboardEvent) => containTabFocus(container, event)

  return {
    activate() {
      previouslyFocused = document.activeElement as HTMLElement | null
      container.addEventListener("keydown", onKeyDown)

      // Focus first focusable element
      const focusable = getFocusableElements(container)
      if (focusable.length > 0) {
        // Try autofocus first, then first focusable
        const autoFocusEl = container.querySelector<HTMLElement>("[autofocus]")
        ;(autoFocusEl || focusable[0])?.focus()
      }
    },

    deactivate(restoreFocus = true) {
      container.removeEventListener("keydown", onKeyDown)
      // Restore previous focus
      if (restoreFocus && previouslyFocused?.isConnected) {
        previouslyFocused.focus()
      }
      previouslyFocused = null
    },
  }
}
