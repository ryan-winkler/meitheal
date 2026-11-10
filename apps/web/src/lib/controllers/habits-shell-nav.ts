/**
 * habits-shell-nav.ts — Habits page section navigation, scroll tracking, keyboard
 *
 * @domain tasks
 * @kcs Extracted from habits-controller.ts for decomposition.
 *      Manages section links, IntersectionObserver tracking, go-to-top FAB,
 *      tab keyboard nav, unified bar integration, and hash sync.
 */

import { HABITS_SECTIONS, type HabitsSectionId } from "@lib/habits-registry"
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
      link.setAttribute("aria-selected", active ? "true" : "false")
      link.setAttribute("tabindex", active ? "0" : "-1")
    })

  setUnifiedBarSwitcherActiveState(HABITS_BAR_ID, sectionId)
}

function scrollToHabitsAnchor(
  anchorId: string,
  behavior: ScrollBehavior = "smooth",
): void {
  const target = document.getElementById(anchorId)
  if (!target) return

  target.scrollIntoView({ behavior, block: "start" })
  history.replaceState(null, "", `#${anchorId}`)

  const sectionId = resolveHabitsSectionId(anchorId)
  if (sectionId) {
    updateActiveSectionState(sectionId)
  }

  target.classList.add("habits-shell__section--flash")
  setTimeout(() => target.classList.remove("habits-shell__section--flash"), 1000)
}

function syncHabitsSectionFromHash(): void {
  const hash = window.location.hash.replace("#", "")
  const sectionId = hash ? resolveHabitsSectionId(hash) : null
  updateActiveSectionState(sectionId ?? "habits-overview")
}

function initSectionLinks(): void {
  document
    .querySelectorAll<HTMLElement>("[data-unified-bar-section-link], [data-habits-section-link]")
    .forEach((link) => {
      pageLifecycle.on(link, "click", (event) => {
        event.preventDefault()
        const targetId = link.getAttribute("href")?.replace("#", "")
        if (!targetId) return

        scrollToHabitsAnchor(targetId)
      })
    })
}

function initIntersectionTracking(): void {
  const sections = document.querySelectorAll<HTMLElement>("[data-habits-section]")
  if (!sections.length) return

  const observer = new IntersectionObserver(
    (entries) => {
      const active = entries
        .filter((entry) => entry.isIntersecting)
        .sort((left, right) => right.intersectionRatio - left.intersectionRatio)[0]

      if (!active?.target.id) return

      const sectionId = resolveHabitsSectionId(active.target.id)
      if (sectionId) {
        updateActiveSectionState(sectionId)
      }
    },
    {
      rootMargin: "-25% 0px -45% 0px",
      threshold: [0.2, 0.45, 0.7],
    },
  )

  sections.forEach((section) => observer.observe(section))
  pageLifecycle.signal.addEventListener("abort", () => observer.disconnect(), {
    once: true,
  })
}

function initGoToTop(): void {
  const button = document.getElementById("habits-go-top")
  const shell = document.getElementById("habits-shell")
  if (!button || !shell) return

  shell.style.position = "relative"

  const sentinel = document.createElement("div")
  sentinel.setAttribute("aria-hidden", "true")
  sentinel.style.cssText =
    "position:absolute;top:420px;width:1px;height:1px;pointer-events:none;"
  shell.appendChild(sentinel)

  const observer = new IntersectionObserver(
    (entries) => {
      const isAboveFold = entries[0]?.isIntersecting ?? true
      button.classList.toggle("is-visible", !isAboveFold)
      button.toggleAttribute("hidden", isAboveFold)
    },
    { threshold: 0 },
  )

  observer.observe(sentinel)
  pageLifecycle.signal.addEventListener("abort", () => observer.disconnect(), {
    once: true,
  })

  pageLifecycle.on(button, "click", () => {
    history.replaceState(null, "", `${window.location.pathname}${window.location.search}`)
    window.scrollTo({ top: 0, behavior: "smooth" })
    updateActiveSectionState("habits-overview")
  })
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
  initSectionLinks()
  initIntersectionTracking()
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

  requestAnimationFrame(() => {
    scrollToHabitsAnchor(hash, "auto")
  })
}
