import { pageLifecycle } from "@lib/page-lifecycle"
import { showToast } from "@lib/toast"

interface UnifiedBarTitleSwitcherOptions {
  barId: string
  onSelect: (sectionId: string) => void
}

interface UnifiedBarButtonOptions {
  barId: string
  fallbackMessage?: string
}

export function setUnifiedBarSwitcherActiveState(
  barId: string,
  activeSectionId?: string,
): void {
  const dropdown = document.getElementById(`${barId}-switcher-dropdown`)
  if (!dropdown) return

  dropdown.querySelectorAll<HTMLElement>(".unified-bar__switcher-item").forEach((item) => {
    item.classList.toggle("is-active", item.dataset.sectionId === activeSectionId)
  })
}

export function initUnifiedBarTitleSwitcher({
  barId,
  onSelect,
}: UnifiedBarTitleSwitcherOptions): void {
  const btn = document.getElementById(`${barId}-switcher-btn`) as HTMLElement | null
  const dropdown = document.getElementById(`${barId}-switcher-dropdown`) as HTMLElement | null
  if (!btn || !dropdown) return

  let isOpen = false
  let openedAtX = 0
  let openedAtY = 0

  function toggleDropdown(open?: boolean): void {
    isOpen = open ?? !isOpen
    if (isOpen) {
      openedAtX = window.scrollX
      openedAtY = window.scrollY
    }
    dropdown!.classList.toggle("is-open", isOpen)
    btn!.setAttribute("aria-expanded", isOpen ? "true" : "false")
  }

  function closeDropdown(): void {
    toggleDropdown(false)
  }

  pageLifecycle.on(btn, "click", (event) => {
    event.stopPropagation()
    toggleDropdown()
    if (!isOpen) return

    const activeItem =
      dropdown.querySelector<HTMLElement>(".unified-bar__switcher-item.is-active") ??
      dropdown.querySelector<HTMLElement>(".unified-bar__switcher-item")
    activeItem?.focus()
  })

  dropdown.querySelectorAll<HTMLElement>(".unified-bar__switcher-item").forEach((item) => {
    pageLifecycle.on(item, "click", (event) => {
      event.stopPropagation()
      const sectionId = item.dataset.sectionId
      if (!sectionId) return

      closeDropdown()
      onSelect(sectionId)
    })
  })

  pageLifecycle.on(dropdown, "keydown", (event) => {
    const keyboardEvent = event as KeyboardEvent
    const items = Array.from(dropdown.querySelectorAll<HTMLElement>(".unified-bar__switcher-item"))
    const currentIndex = items.findIndex((item) => item === document.activeElement)

    if (keyboardEvent.key === "Escape") {
      keyboardEvent.preventDefault()
      closeDropdown()
      btn.focus()
      return
    }

    if (keyboardEvent.key !== "ArrowDown" && keyboardEvent.key !== "ArrowUp") {
      return
    }

    keyboardEvent.preventDefault()
    const direction = keyboardEvent.key === "ArrowDown" ? 1 : -1
    const nextIndex = (currentIndex + direction + items.length) % items.length
    items[nextIndex]?.focus()
  })

  pageLifecycle.on(document, "click", (event) => {
    if (!isOpen) return
    const target = event.target as Node
    if (btn.contains(target) || dropdown.contains(target)) return
    closeDropdown()
  })

  pageLifecycle.on(
    window,
    "scroll",
    () => {
      // A scroll event queued before opening can arrive at the same position.
      if (isOpen && (window.scrollX !== openedAtX || window.scrollY !== openedAtY)) {
        closeDropdown()
      }
    },
    { passive: true } as AddEventListenerOptions,
  )
}

export function initUnifiedBarSearchLauncher(barId: string): void {
  const bar = document.getElementById(barId)
  const launcher = document.getElementById(`${barId}-search-launcher`) as HTMLButtonElement | null
  if (!bar || !launcher) return

  const scope = launcher.dataset.searchScope || bar.dataset.searchScope || ""

  pageLifecycle.on(launcher, "click", () => {
    window.openSearchHub?.(scope ? { scope } : undefined)
  })
}

export function initUnifiedBarNewTaskButton({
  barId,
  fallbackMessage = "Task modal not ready - try again",
}: UnifiedBarButtonOptions): void {
  const button = document.getElementById(`${barId}-new-task`) as HTMLButtonElement | null
  if (!button) return

  pageLifecycle.on(button, "click", () => {
    if (typeof window.openNewTaskModal === "function") {
      window.openNewTaskModal()
      return
    }

    requestAnimationFrame(() => {
      if (typeof window.openNewTaskModal === "function") {
        window.openNewTaskModal()
        return
      }

      showToast(fallbackMessage, "error")
    })
  })
}

export function initUnifiedBarTabOverflow(barId: string): void {
  const tabsContainer = document.getElementById(`${barId}-tabs`) as HTMLElement | null
  if (!tabsContainer) return

  const tabs = Array.from(
    tabsContainer.querySelectorAll<HTMLElement>("[data-unified-bar-tab]"),
  )
  if (tabs.length === 0) return

  function recalcOverflow(): void {
    tabs.forEach((tab) => {
      tab.removeAttribute("data-overflow-hidden")
      tab.removeAttribute("tabindex")
    })

    const containerWidth = tabsContainer!.clientWidth
    let usedWidth = 0
    let overflow = false

    tabs.forEach((tab) => {
      if (overflow) {
        tab.setAttribute("data-overflow-hidden", "")
        tab.setAttribute("tabindex", "-1")
        return
      }

      usedWidth += tab.offsetWidth + 4
      if (usedWidth <= containerWidth) return

      overflow = true
      tab.setAttribute("data-overflow-hidden", "")
      tab.setAttribute("tabindex", "-1")
    })
  }

  const observer = new ResizeObserver(() => {
    recalcOverflow()
  })
  observer.observe(tabsContainer)

  requestAnimationFrame(recalcOverflow)

  pageLifecycle.signal.addEventListener("abort", () => observer.disconnect(), { once: true })
}
