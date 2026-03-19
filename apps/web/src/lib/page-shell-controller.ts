import { createClientLogger } from "@lib/client-logger"
import { pageLifecycle } from "@lib/page-lifecycle"
import {
  initUnifiedBarNewTaskButton,
  initUnifiedBarSearchLauncher,
  initUnifiedBarTabOverflow,
  initUnifiedBarTitleSwitcher,
  setUnifiedBarSwitcherActiveState,
} from "@lib/unified-bar-controller"

const log = createClientLogger("app", "page-shell")

export interface PageShellNavigationOptions<SectionId extends string> {
  barId: string
  sectionSelector: string
  sectionIds: readonly SectionId[]
  defaultSectionId: SectionId
  shellId?: string
  flashClass?: string
  sectionLinkSelectors?: string[]
  rootMargin?: string
  threshold?: number[]
  enableNewTaskButton?: boolean
  newTaskFallbackMessage?: string
}

export interface PageShellNavigationHandle<SectionId extends string> {
  scrollToAnchor(anchorId: string, behavior?: ScrollBehavior): void
  syncFromHash(): void
  updateActiveState(sectionId: SectionId): void
}

export function initPageShellNavigation<SectionId extends string>({
  barId,
  sectionSelector,
  sectionIds,
  defaultSectionId,
  shellId,
  flashClass,
  sectionLinkSelectors = [],
  rootMargin = "-25% 0px -45% 0px",
  threshold = [0.2, 0.45, 0.7],
  enableNewTaskButton = true,
  newTaskFallbackMessage = "Task modal not ready - try again",
}: PageShellNavigationOptions<SectionId>): PageShellNavigationHandle<SectionId> {
  const bar = document.getElementById(barId)
  if (!bar) {
    log.warn("Unified bar root not found", { barId, shellId: shellId ?? null })
  }

  // Set --unified-bar-height so pages can use it for scroll-margin-top
  if (bar) {
    const barHeight = bar.offsetHeight
    document.documentElement.style.setProperty("--unified-bar-height", `${barHeight}px`)
  }

  const sectionIdSet = new Set(sectionIds)

  function resolveSectionId(anchorId: string): SectionId | null {
    const target = document.getElementById(anchorId)
    if (!target) return null

    const maybeSectionId =
      target.closest<HTMLElement>(sectionSelector)?.id ||
      target.id ||
      null

    if (!maybeSectionId || !sectionIdSet.has(maybeSectionId as SectionId)) {
      return null
    }

    return maybeSectionId as SectionId
  }

  function updateActiveState(sectionId: SectionId): void {
    document
      .querySelectorAll<HTMLElement>("[data-unified-bar-section]")
      .forEach((link) => {
        const active = link.dataset.unifiedBarSection === sectionId
        link.classList.toggle("is-active", active)
        link.setAttribute("aria-current", active ? "location" : "false")
        link.setAttribute("aria-selected", active ? "true" : "false")
        link.setAttribute("tabindex", active ? "0" : "-1")
      })

    setUnifiedBarSwitcherActiveState(barId, sectionId)
  }

  function scrollToAnchor(
    anchorId: string,
    behavior: ScrollBehavior = "smooth",
  ): void {
    const target = document.getElementById(anchorId)
    if (!target) {
      log.warn("Shell anchor target not found", { barId, anchorId })
      return
    }

    target.scrollIntoView({ behavior, block: "start" })
    history.replaceState(null, "", `#${anchorId}`)

    const sectionId = resolveSectionId(anchorId)
    if (sectionId) {
      updateActiveState(sectionId)
    }

    if (flashClass) {
      target.classList.add(flashClass)
      setTimeout(() => target.classList.remove(flashClass), 1000)
    }
  }

  function syncFromHash(): void {
    const hash = window.location.hash.replace("#", "")
    const sectionId = hash ? resolveSectionId(hash) : null
    updateActiveState(sectionId ?? defaultSectionId)
  }

  const selectors = ["[data-unified-bar-section-link]", ...sectionLinkSelectors]
  document.querySelectorAll<HTMLElement>(selectors.join(", ")).forEach((link) => {
    pageLifecycle.on(link, "click", (event) => {
      const href = link.getAttribute("href")
      if (!href?.startsWith("#")) return

      event.preventDefault()
      scrollToAnchor(href.replace("#", ""))
    })
  })

  const sections = document.querySelectorAll<HTMLElement>(sectionSelector)
  if (sections.length === 0) {
    log.warn("No shell sections matched selector", {
      barId,
      sectionSelector,
      shellId: shellId ?? null,
    })
  }

  if (sections.length > 0) {
    const observer = new IntersectionObserver(
      (entries) => {
        const active = entries
          .filter((entry) => entry.isIntersecting)
          .sort((left, right) => right.intersectionRatio - left.intersectionRatio)[0]

        if (!active?.target.id) return

        const sectionId = resolveSectionId(active.target.id)
        if (sectionId) {
          updateActiveState(sectionId)
        }
      },
      { rootMargin, threshold },
    )

    sections.forEach((section) => observer.observe(section))
    pageLifecycle.signal.addEventListener("abort", () => observer.disconnect(), {
      once: true,
    })
  }

  const goTopButton = document.getElementById(`${barId}-go-top`)
  const shell = shellId ? document.getElementById(shellId) : null
  if (goTopButton && shell) {
    shell.style.position = "relative"

    const sentinel = document.createElement("div")
    sentinel.setAttribute("aria-hidden", "true")
    sentinel.style.cssText =
      "position:absolute;top:420px;width:1px;height:1px;pointer-events:none;"
    shell.appendChild(sentinel)

    const observer = new IntersectionObserver(
      (entries) => {
        const isAboveFold = entries[0]?.isIntersecting ?? true
        goTopButton.classList.toggle("is-visible", !isAboveFold)
        goTopButton.toggleAttribute("hidden", isAboveFold)
      },
      { threshold: 0 },
    )

    observer.observe(sentinel)
    pageLifecycle.signal.addEventListener("abort", () => observer.disconnect(), {
      once: true,
    })

    pageLifecycle.on(goTopButton, "click", () => {
      history.replaceState(
        null,
        "",
        `${window.location.pathname}${window.location.search}`,
      )
      window.scrollTo({ top: 0, behavior: "smooth" })
      updateActiveState(defaultSectionId)
    })
  }

  const tabContainer = document.getElementById(`${barId}-tabs`)
  if (tabContainer) {
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

  initUnifiedBarTitleSwitcher({
    barId,
    onSelect: (sectionId) => {
      scrollToAnchor(sectionId)
    },
  })
  initUnifiedBarSearchLauncher(barId)
  if (enableNewTaskButton) {
    initUnifiedBarNewTaskButton({
      barId,
      fallbackMessage: newTaskFallbackMessage,
    })
  }
  initUnifiedBarTabOverflow(barId)

  pageLifecycle.on(window, "hashchange", () => {
    syncFromHash()
  })

  syncFromHash()
  log.info("Initialized page shell navigation", {
    barId,
    shellId: shellId ?? null,
    sectionCount: sections.length,
    defaultSectionId,
  })

  const hash = window.location.hash.replace("#", "")
  if (hash) {
    requestAnimationFrame(() => {
      scrollToAnchor(hash, "auto")
    })
  }

  return {
    scrollToAnchor,
    syncFromHash,
    updateActiveState,
  }
}
