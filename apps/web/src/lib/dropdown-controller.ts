/**
 * DropdownController — shared dropdown/popover positioning & lifecycle
 *
 * Handles:
 * - Fixed positioning relative to anchor elements
 * - Viewport boundary clamping (right + bottom overflow)
 * - Outside-click dismissal
 * - Escape key dismissal
 * - Body-level rendering (escapes parent overflow clipping)
 *
 * Usage:
 *   import { DropdownController } from "@lib/dropdown-controller"
 *   const ctrl = new DropdownController()
 *   ctrl.show(dropdownEl, anchorEl)
 *   ctrl.hide()
 *
 * @domain shared/ui
 */

export class DropdownController {
  private active: HTMLElement | null = null
  private onOutsideClick: ((e: MouseEvent) => void) | null = null
  private onEscape: ((e: KeyboardEvent) => void) | null = null

  /** Move dropdown to document.body if not already there (escapes sidebar overflow) */
  static ensureBodyLevel(el: HTMLElement): void {
    if (el.parentElement !== document.body) {
      document.body.appendChild(el)
    }
  }

  /** Show a dropdown/popover positioned below the anchor */
  show(dropdown: HTMLElement, anchor: HTMLElement): void {
    this.hideAll()
    DropdownController.ensureBodyLevel(dropdown)
    dropdown.hidden = false
    this.active = dropdown

    // Position below anchor
    const rect = anchor.getBoundingClientRect()
    dropdown.style.position = "fixed"
    dropdown.style.zIndex = "10000"
    dropdown.style.top = `${rect.bottom + 4}px`
    dropdown.style.left = `${rect.left}px`

    // Clamp to viewport after render
    requestAnimationFrame(() => {
      const dr = dropdown.getBoundingClientRect()
      if (dr.right > window.innerWidth - 8) {
        dropdown.style.left = `${window.innerWidth - dr.width - 8}px`
      }
      if (dr.bottom > window.innerHeight - 8) {
        dropdown.style.top = `${rect.top - dr.height - 4}px`
      }
    })

    // Register dismissal listeners
    this.onOutsideClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement
      if (!dropdown.contains(target) && !anchor.contains(target)) {
        this.hide()
      }
    }
    this.onEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") this.hide()
    }
    // Delay listener registration to avoid immediate dismissal
    setTimeout(() => {
      document.addEventListener("click", this.onOutsideClick!)
      document.addEventListener("keydown", this.onEscape!)
    }, 0)
  }

  /** Hide the currently active dropdown */
  hide(): void {
    if (this.active) {
      this.active.hidden = true
      this.active = null
    }
    if (this.onOutsideClick) {
      document.removeEventListener("click", this.onOutsideClick)
      this.onOutsideClick = null
    }
    if (this.onEscape) {
      document.removeEventListener("keydown", this.onEscape)
      this.onEscape = null
    }
  }

  /** Hide all dropdowns matching a selector */
  hideAll(selector = ".stree__dropdown, .stree__popover"): void {
    this.hide()
    document.querySelectorAll<HTMLElement>(selector).forEach((d) => {
      d.hidden = true
    })
  }

  /** Check if a specific dropdown is currently showing */
  isShowing(dropdown: HTMLElement): boolean {
    return this.active === dropdown && !dropdown.hidden
  }
}
