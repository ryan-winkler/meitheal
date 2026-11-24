import { createClientLogger } from "@lib/client-logger"
import { pageLifecycle } from "@lib/page-lifecycle"
import {
  initUnifiedBarNewTaskButton,
  initUnifiedBarSearchLauncher,
  initUnifiedBarTabOverflow,
  initUnifiedBarTabsKeyboard,
  initUnifiedBarTitleSwitcher,
  syncUnifiedBarSectionState,
} from "@lib/unified-bar-controller"

const log = createClientLogger("app", "page-shell")

export interface PageShellNavigationOptions<SectionId extends string> {
  barId: string
  sectionSelector: string
  sectionIds: readonly SectionId[]
  defaultSectionId: SectionId
  shellId?: string
  flashClass?: string
  preserveOverviewOnLoad?: boolean
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
  preserveOverviewOnLoad = false,
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
  const sections = document.querySelectorAll<HTMLElement>(sectionSelector)
  const trackLinkedSection = initPageShellSectionTracking(
    sections, resolveSectionId, updateActiveState, rootMargin, threshold,
  )

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
    syncUnifiedBarSectionState(barId, sectionId, { manageTabindex: true })
  }

  function scrollToAnchor(
    anchorId: string,
    behavior: ScrollBehavior = "smooth",
    updateLocation = true,
  ): void {
    const target = document.getElementById(anchorId)
    if (!target) {
      log.warn("Shell anchor target not found", { barId, anchorId })
      return
    }

    const sectionId = resolveSectionId(anchorId)
    trackLinkedSection(sectionId)
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    target.scrollIntoView({ behavior: reduceMotion ? "auto" : behavior, block: "start" })
    if (updateLocation) history.replaceState(history.state, "", `#${anchorId}`)

    if (sectionId) {
      updateActiveState(sectionId)
    }

    if (flashClass && !reduceMotion) {
      target.classList.add(flashClass)
      setTimeout(() => target.classList.remove(flashClass), 1000)
    }
  }

  function syncFromHash(): void {
    const hash = window.location.hash.replace("#", "")
    const sectionId = hash ? resolveSectionId(hash) : null
    updateActiveState(sectionId ?? defaultSectionId)
    trackLinkedSection(sectionId ?? (preserveOverviewOnLoad ? defaultSectionId : null), sectionId !== null)
  }

  const selectors = ["[data-unified-bar-section-link]", ...sectionLinkSelectors]
  document.querySelectorAll<HTMLElement>(selectors.join(", ")).forEach((link) => {
    pageLifecycle.on(link, "click", (event) => {
      const href = link.getAttribute("href")
      const targetId = link instanceof HTMLAnchorElement
        ? (link.pathname === location.pathname ? link.hash.slice(1) : "")
        : (href?.startsWith("#") ? href.slice(1) : "")
      if (!targetId) return

      event.preventDefault()
      scrollToAnchor(targetId)
    })
  })

  if (sections.length === 0) {
    log.warn("No shell sections matched selector", {
      barId,
      sectionSelector,
      shellId: shellId ?? null,
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
        history.state,
        "",
        `${window.location.pathname}${window.location.search}`,
      )
      trackLinkedSection(defaultSectionId)
      const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches
      window.scrollTo({ top: 0, behavior: reduceMotion ? "auto" : "smooth" })
      updateActiveState(defaultSectionId)
    })
  }

  initUnifiedBarTabsKeyboard(barId)

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
  if (hash && document.getElementById(hash) && bar?.dataset.initialHashSynced !== hash) {
    if (bar) {
      bar.dataset.initialHashSynced = hash
      pageLifecycle.signal.addEventListener("abort", () => { delete bar.dataset.initialHashSynced }, { once: true })
    }
    const signal = pageLifecycle.signal
    const initialUrl = window.location.href
    const initialScrollY = window.scrollY
    requestAnimationFrame(() => {
      const active = document.activeElement
      if (signal.aborted || (bar && !bar.isConnected) || window.location.href !== initialUrl) return
      if (window.scrollY !== initialScrollY || (active && active !== document.body && active !== document.documentElement)) return
      scrollToAnchor(hash, "auto", false)
    })
  }

  return {
    scrollToAnchor,
    syncFromHash,
    updateActiveState,
  }
}

export function initPageShellSectionTracking<SectionId extends string>(
  sections: NodeListOf<HTMLElement>,
  resolveSectionId: (anchorId: string) => SectionId | null,
  updateActiveState: (sectionId: SectionId) => void,
  rootMargin = "-25% 0px -45% 0px",
  threshold = [0, 0.2, 0.45, 0.7],
): (sectionId: SectionId | null, awaitVisibility?: boolean) => void {
  let linkedSection: {
    element: HTMLElement
    wasVisible: boolean
    leftTop: boolean
  } | null = null

  function resumeSectionTracking(preferTop = false): void {
    linkedSection = null
    if (preferTop && sections[0]) {
      const topId = resolveSectionId(sections[0].id)
      if (topId) {
        updateActiveState(topId)
        return
      }
    }
    const atTop = window.scrollY <= 8
    let mostVisibleSectionId: SectionId | null = null
    let greatestVisibleHeight = 0

    for (const section of sections) {
      const { top, bottom } = section.getBoundingClientRect()
      const visibleHeight = Math.min(window.innerHeight, bottom) - Math.max(0, top)
      const sectionId = resolveSectionId(section.id)
      if (!sectionId || visibleHeight <= 0) continue
      if (atTop && bottom > 0 && top < window.innerHeight) {
        updateActiveState(sectionId)
        return
      }
      if (visibleHeight > greatestVisibleHeight) {
        greatestVisibleHeight = visibleHeight
        mostVisibleSectionId = sectionId
      }
    }

    if (mostVisibleSectionId) updateActiveState(mostVisibleSectionId)
  }

  function syncLinkedSectionVisibility(fromScroll = false): void {
    if (!linkedSection) return
    if (window.scrollY > 2) linkedSection.leftTop = true
    const { top, bottom } = linkedSection.element.getBoundingClientRect()
    if (fromScroll && linkedSection.wasVisible && linkedSection.leftTop && window.scrollY <= 2 && sections[0] && linkedSection.element !== sections[0]) {
      resumeSectionTracking(true)
      return
    }
    if (bottom > 0 && top < window.innerHeight) {
      linkedSection.wasVisible = true
    } else if (linkedSection.wasVisible) {
      resumeSectionTracking()
    }
    if (!linkedSection && window.scrollY <= 8) resumeSectionTracking()
  }

  function trackLinkedSection(sectionId: SectionId | null, awaitVisibility = true): void {
    const element = sectionId ? document.getElementById(sectionId) : null
    linkedSection = element ? { element, wasVisible: false, leftTop: window.scrollY > 2 } : null
    syncLinkedSectionVisibility()
    if (!awaitVisibility && !linkedSection?.wasVisible) {
      linkedSection = null
      if (window.scrollY > 8) resumeSectionTracking()
    }
  }

  if (sections.length > 0) {
    pageLifecycle.on(window, "scroll", () => syncLinkedSectionVisibility(true), { passive: true })
    pageLifecycle.on(document, "scrollend", () => {
      if ((linkedSection && !linkedSection.wasVisible) || (!linkedSection && window.scrollY <= 8)) resumeSectionTracking()
    })
    const observer = new IntersectionObserver(
      (entries) => {
        // Keep the linked section current during the jump and until it leaves view.
        if (linkedSection) return
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

  return trackLinkedSection
}
