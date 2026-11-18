/**
 * habits-shell-nav.ts — Habits page section navigation, scroll tracking, keyboard
 *
 * @domain tasks
 * @kcs Extracted from habits-controller.ts for decomposition.
 *      Manages section links, IntersectionObserver tracking, go-to-top FAB,
 *      tab keyboard nav, unified bar integration, and hash sync.
 */

import { HABITS_SECTIONS, type HabitsSectionId } from "@lib/habits-registry"
import { initPageShellSectionTracking } from "@lib/page-shell-controller"
import { pageLifecycle } from "@lib/page-lifecycle"
import {
  initUnifiedBarSearchLauncher,
  initUnifiedBarTabOverflow,
  initUnifiedBarTitleSwitcher,
  setUnifiedBarSwitcherActiveState,
} from "@lib/unified-bar-controller"

const HABITS_BAR_ID = "habits-bar"
const HABITS_SECTION_IDS = new Set(HABITS_SECTIONS.map((section) => section.id))

function resolveHabitsSectionId(anchorId: string): HabitsSectionId | null {
  const target = document.getElementById(anchorId)
  if (!target) return null

  const maybeSectionId =
    target.closest<HTMLElement>("[data-habits-section]")?.id ||
    target.id ||
    null

  if (!maybeSectionId || !HABITS_SECTION_IDS.has(maybeSectionId as HabitsSectionId)) {
    return null
  }

  return maybeSectionId as HabitsSectionId
}

function updateActiveSectionState(sectionId: HabitsSectionId): void {
  document
    .querySelectorAll<HTMLElement>("[data-unified-bar-section]")
    .forEach((link) => {
      const active = link.dataset.unifiedBarSection === sectionId
      link.classList.toggle("is-active", active)
      link.setAttribute("aria-current", active ? "location" : "false")
    })

  setUnifiedBarSwitcherActiveState(HABITS_BAR_ID, sectionId)
}

function initTabsKeyboard(): void {
  const tabContainer = document.getElementById(`${HABITS_BAR_ID}-tabs`)
  if (!tabContainer) return

  pageLifecycle.on(tabContainer, "keydown", (event) => {
    const keyboardEvent = event as KeyboardEvent
    if (keyboardEvent.key !== "ArrowLeft" && keyboardEvent.key !== "ArrowRight") {
      return
    }

    const visibleTabs = Array.from(
      tabContainer.querySelectorAll<HTMLElement>(
        "[data-unified-bar-tab]:not([data-overflow-hidden])",
      ),
    )
    const currentIndex = visibleTabs.findIndex((tab) => tab === document.activeElement)
    if (currentIndex === -1) return

    keyboardEvent.preventDefault()
    const direction = keyboardEvent.key === "ArrowRight" ? 1 : -1
    const nextIndex = (currentIndex + direction + visibleTabs.length) % visibleTabs.length
    const nextTab = visibleTabs[nextIndex]
    if (!nextTab) return

    nextTab.focus()
    nextTab.click()
  })
}

/**
 * Initialise the habits shell navigation, scroll tracking, and keyboard.
 */
export function initHabitsShellNav(): void {
  const trackLinkedSection = initPageShellSectionTracking(
    document.querySelectorAll<HTMLElement>("[data-habits-section]"),
    resolveHabitsSectionId,
    updateActiveSectionState,
  )

  function scrollToHabitsAnchor(anchorId: string): void {
    const target = document.getElementById(anchorId)
    if (!target) return

    const sectionId = resolveHabitsSectionId(anchorId)
    trackLinkedSection(sectionId)
    target.scrollIntoView({ block: "start" })
    history.replaceState(history.state, "", `#${anchorId}`)

    if (sectionId) {
      updateActiveSectionState(sectionId)
    }
  }

  function syncHabitsSectionFromHash(): void {
    const hash = window.location.hash.replace("#", "")
    const sectionId = hash ? resolveHabitsSectionId(hash) : null
    trackLinkedSection(sectionId ?? "habits-overview", sectionId !== null)
    updateActiveSectionState(sectionId ?? "habits-overview")
  }

  function initSectionLinks(): void {
    document
      .querySelectorAll<HTMLElement>("[data-unified-bar-section-link]")
      .forEach((link) => {
        pageLifecycle.on(link, "click", (event) => {
          event.preventDefault()
          const targetId = link.getAttribute("href")?.replace("#", "")
          if (!targetId) return

          scrollToHabitsAnchor(targetId)
        })
      })
  }

  function initGoToTop(): void {
    const button = document.getElementById("habits-go-top")
    if (!button) return

    const updateVisibility = () => {
      const visible = window.scrollY > 420
      if (button.hidden === !visible) return
      button.classList.toggle("is-visible", visible)
      button.hidden = !visible
    }

    updateVisibility()
    pageLifecycle.on(window, "scroll", updateVisibility, { passive: true })
    pageLifecycle.on(button, "click", () => {
      history.replaceState(history.state, "", `${window.location.pathname}${window.location.search}`)
      trackLinkedSection("habits-overview")
      window.scrollTo({ top: 0 })
      updateActiveSectionState("habits-overview")
    })
  }

  initSectionLinks()
  initGoToTop()
  initTabsKeyboard()
  initUnifiedBarTitleSwitcher({
    barId: HABITS_BAR_ID,
    onSelect: (sectionId) => {
      scrollToHabitsAnchor(sectionId)
    },
  })
  initUnifiedBarSearchLauncher(HABITS_BAR_ID)
  initUnifiedBarTabOverflow(HABITS_BAR_ID)

  pageLifecycle.on(window, "hashchange", () => {
    syncHabitsSectionFromHash()
  })

  syncHabitsSectionFromHash()

  const hash = window.location.hash.replace("#", "")
  if (!hash) return

  const signal = pageLifecycle.signal
  const initialUrl = window.location.href
  requestAnimationFrame(() => {
    if (!signal.aborted && window.location.href === initialUrl) scrollToHabitsAnchor(hash)
  })
}
