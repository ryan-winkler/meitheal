import { pageLifecycle } from "@lib/page-lifecycle"
import { escapeHtml } from "@lib/safe-html"
import {
  SETTINGS_SECTIONS,
  getSettingsSection,
  searchSettingsRegistry,
  type SettingsSectionId,
} from "@lib/settings-registry"
import { showToast } from "@lib/toast"

function setShellDetailView(isDetailView: boolean): void {
  const shell = document.getElementById("settings-shell")
  if (!shell) return

  shell.classList.toggle("is-detail-view", isDetailView)
}

function scrollToAnchor(anchorId: string, behavior: ScrollBehavior = "smooth"): void {
  const target = document.getElementById(anchorId)
  if (!target) return

  const sectionId = resolveSectionId(anchorId)
  setShellDetailView(Boolean(sectionId))

  target.scrollIntoView({ behavior, block: "start" })
  history.replaceState(null, "", `#${anchorId}`)

  if (sectionId) {
    updateActiveSectionState(sectionId)
  }

  /* Brief highlight flash to orient user after deep-link navigation */
  target.classList.add("settings-landing-flash")
  setTimeout(() => target.classList.remove("settings-landing-flash"), 1200)
}

function resolveSectionId(anchorId: string): SettingsSectionId | null {
  const target = document.getElementById(anchorId)
  if (!target) return null

  const maybeSectionId =
    target.closest<HTMLElement>("[data-settings-shell-section]")?.id ||
    target.id ||
    null

  if (!SETTINGS_SECTIONS.some((section) => section.id === maybeSectionId)) {
    return null
  }

  return maybeSectionId as SettingsSectionId
}

function updateActiveSectionState(sectionId: SettingsSectionId): void {
  document
    .querySelectorAll<HTMLElement>("[data-settings-nav], [data-settings-summary]")
    .forEach((link) => {
      const active =
        link.dataset.settingsNav === sectionId ||
        link.dataset.settingsSummary === sectionId

      link.classList.toggle("is-active", active)
      link.setAttribute("aria-current", active ? "location" : "false")
      /* ARIA tab state sync */
      link.setAttribute("aria-selected", active ? "true" : "false")
      link.setAttribute("tabindex", active ? "0" : "-1")
    })
}

function syncSummaryStatuses(): void {
  const mappings = [
    {
      sectionId: "personal-settings",
      sourceId: "theme-select",
      detail: (source: HTMLElement | null) =>
        (source as HTMLSelectElement | null)?.value ?? "Default",
    },
    {
      sectionId: "workflow-settings",
      sourceId: "labels-list",
      detail: (source: HTMLElement | null) => {
        const count = source?.querySelectorAll(".label-settings-row").length ?? 0
        return count > 0 ? `${count} labels` : "Ready to customize"
      },
    },
    {
      sectionId: "integrations-settings",
      sourceId: "ha-connection-badge",
      detail: (source: HTMLElement | null) =>
        source?.textContent?.trim() || "Checking",
    },
    {
      sectionId: "automation-ai-settings",
      sourceId: "agent-protocols-status",
      detail: (source: HTMLElement | null) =>
        source?.textContent?.trim() || "Available",
    },
    {
      sectionId: "app-pwa-settings",
      sourceId: "pwa-compact-badge",
      detail: (source: HTMLElement | null) =>
        source?.textContent?.trim() || "Checking",
    },
    {
      sectionId: "danger-zone-settings",
      sourceId: "reset-settings",
      detail: () => "Protected actions",
    },
  ] as const

  mappings.forEach((mapping) => {
    const summary = document.querySelector<HTMLElement>(
      `[data-settings-summary="${mapping.sectionId}"]`,
    )
    if (!summary) return

    const statusChip = summary.querySelector(".settings-tab__status")
    const navStatus = document.querySelector<HTMLElement>(
      `[data-settings-nav-status="${mapping.sectionId}"]`,
    )
    const text = mapping.detail(document.getElementById(mapping.sourceId))

    if (statusChip) statusChip.textContent = text
    if (navStatus) navStatus.textContent = text
  })
}

function revealAllSections(): void {
  document
    .querySelectorAll<HTMLElement>("[data-settings-shell-section]")
    .forEach((section) => {
      section.classList.remove("settings-shell__section--muted")
    })
}

function clearSearchState(): void {
  const input = document.getElementById(
    "settings-search-input",
  ) as HTMLInputElement | null
  const results = document.getElementById("settings-search-results")
  const clearButton = document.getElementById(
    "settings-search-clear",
  ) as HTMLButtonElement | null

  if (input) input.value = ""
  if (results) results.hidden = true
  if (results) results.innerHTML = ""
  if (clearButton) clearButton.hidden = true
  revealAllSections()
}

function initSearch(): void {
  const input = document.getElementById(
    "settings-search-input",
  ) as HTMLInputElement | null
  const results = document.getElementById("settings-search-results")
  const clearButton = document.getElementById(
    "settings-search-clear",
  ) as HTMLButtonElement | null
  if (!input || !results) return

  let matches = searchSettingsRegistry("")
  let activeResultIndex = -1

  const setActiveResult = (index: number): void => {
    activeResultIndex = index
    results
      .querySelectorAll<HTMLElement>(".settings-search-results__item")
      .forEach((item, itemIndex) => {
        const active = itemIndex === index
        item.classList.toggle("is-active", active)
        item.setAttribute("aria-selected", active ? "true" : "false")
      })
  }

  const selectMatch = (matchIndex: number): void => {
    const match = matches[matchIndex]
    if (!match) return

    clearSearchState()
    scrollToAnchor(match.anchorId)
  }

  const renderMatches = (): void => {
    const term = input.value.trim()
    matches = searchSettingsRegistry(term)
    activeResultIndex = -1
    results.innerHTML = ""

    if (clearButton) {
      clearButton.hidden = term.length === 0
    }

    if (!term) {
      results.hidden = true
      revealAllSections()
      return
    }

    const visibleSections = new Set(matches.map((match) => match.sectionId))
    SETTINGS_SECTIONS.forEach((section) => {
      const element = document.getElementById(section.id)
      if (!element) return
      element.classList.toggle(
        "settings-shell__section--muted",
        !visibleSections.has(section.id),
      )
    })

    if (matches.length === 0) {
      results.hidden = false
      results.innerHTML = `<div class="settings-search-results__empty">No matching settings for "${escapeHtml(term)}" yet. Press Esc or Clear to reset.</div>`
      return
    }

    matches.forEach((match, index) => {
      const button = document.createElement("button")
      button.type = "button"
      button.className = "settings-search-results__item"
      button.setAttribute("role", "option")
      button.setAttribute("aria-selected", "false")
      button.innerHTML = `
        <span class="settings-search-results__meta">
          <span class="settings-search-results__type">${match.type === "field" ? "Setting" : "Section"}</span>
          <span class="settings-search-results__section">${getSettingsSection(match.sectionId)?.label ?? match.sectionId}</span>
        </span>
        <strong>${match.label}</strong>
        <span class="settings-search-results__description">${match.description}</span>
      `

      pageLifecycle.on(button, "click", () => {
        selectMatch(index)
      })
      pageLifecycle.on(button, "mouseenter", () => {
        setActiveResult(index)
      })

      results.appendChild(button)
    })

    results.hidden = false
  }

  pageLifecycle.on(input, "input", () => {
    renderMatches()
  })

  pageLifecycle.on(input, "keydown", (event) => {
    const keyboardEvent = event as KeyboardEvent
    if (keyboardEvent.key === "ArrowDown") {
      keyboardEvent.preventDefault()
      if (!matches.length) return
      setActiveResult((activeResultIndex + 1 + matches.length) % matches.length)
      return
    }

    if (keyboardEvent.key === "ArrowUp") {
      keyboardEvent.preventDefault()
      if (!matches.length) return
      setActiveResult((activeResultIndex - 1 + matches.length) % matches.length)
      return
    }

    if (keyboardEvent.key === "Escape") {
      keyboardEvent.preventDefault()
      clearSearchState()
      return
    }

    if (keyboardEvent.key !== "Enter") return

    const matchIndex = activeResultIndex >= 0 ? activeResultIndex : 0
    const firstMatch = matches[matchIndex]
    if (!firstMatch) return

    keyboardEvent.preventDefault()
    selectMatch(matchIndex)
  })

  if (clearButton) {
    pageLifecycle.on(clearButton, "click", () => {
      clearSearchState()
    })
  }
}

function initSectionLinks(): void {
  document
    .querySelectorAll<HTMLElement>("[data-settings-section-link]")
    .forEach((link) => {
      pageLifecycle.on(link, "click", (event) => {
        event.preventDefault()
        const targetId = link.getAttribute("href")?.replace("#", "")
        if (!targetId) return

        clearSearchState()
        scrollToAnchor(targetId)
      })
    })
}

function initIntersectionTracking(): void {
  const sections = document.querySelectorAll<HTMLElement>(
    "[data-settings-shell-section]",
  )
  if (!sections.length) return

  const observer = new IntersectionObserver(
    (entries) => {
      const active = entries
        .filter((entry) => entry.isIntersecting)
        .sort((left, right) => right.intersectionRatio - left.intersectionRatio)[0]

      if (!active?.target.id) return

      const sectionId = resolveSectionId(active.target.id)
      if (sectionId) {
        updateActiveSectionState(sectionId)
      }
    },
    {
      rootMargin: "-25% 0px -50% 0px",
      threshold: [0.2, 0.4, 0.6],
    },
  )

  sections.forEach((section) => observer.observe(section))
  pageLifecycle.signal.addEventListener("abort", () => observer.disconnect(), {
    once: true,
  })
}

function buildCompanionNavigateHref(sectionId: SettingsSectionId): string {
  const ingressPath = window.__ingress_path || ""
  const path = `${ingressPath}/settings#${sectionId}`
  return `homeassistant://navigate${path}`
}

function buildCompanionXCallbackHref(sectionId: SettingsSectionId): string {
  const ingressPath = window.__ingress_path || ""
  const path = `${ingressPath}/settings#${sectionId}`
  return `homeassistant://x-callback-url/navigate?path=${encodeURIComponent(
    path,
  )}`
}

function initCompanionLinks(): void {
  document
    .querySelectorAll<HTMLAnchorElement>("[data-companion-link]")
    .forEach((link) => {
      const sectionId = (link.dataset.companionLink ||
        "app-pwa-settings") as SettingsSectionId
      link.href = buildCompanionNavigateHref(sectionId)
    })

  document
    .querySelectorAll<HTMLElement>("[data-companion-xcallback]")
    .forEach((container) => {
      const sectionId = (container.dataset.companionXcallback ||
        "app-pwa-settings") as SettingsSectionId
      const xCallbackHref = buildCompanionXCallbackHref(sectionId)
      const preview = container.querySelector<HTMLElement>(
        "[data-companion-xcallback-preview]",
      )
      const copyButton = container.querySelector<HTMLButtonElement>(
        "[data-companion-xcallback-button]",
      )

      if (preview) preview.textContent = xCallbackHref

      if (!copyButton) return
      pageLifecycle.on(copyButton, "click", async () => {
        try {
          await navigator.clipboard.writeText(xCallbackHref)
          showToast("Companion x-callback URL copied", "success")
        } catch {
          showToast("Could not copy the companion URL", "error")
        }
      })
    })
}

function syncActiveSectionFromHash(): void {
  const hash = window.location.hash.replace("#", "")

  if (!hash) {
    setShellDetailView(false)
    clearSearchState()
    return
  }

  const sectionId = resolveSectionId(hash)
  if (sectionId) {
    clearSearchState()
    setShellDetailView(true)
    updateActiveSectionState(sectionId)
  }
}

/** Sticky tab bar fallback — CSS position:sticky breaks in HA ingress
 * iframes because the parent HA shell controls scrolling, not the addon
 * body. This uses IntersectionObserver on the hero section to detect
 * when tabs should stick. When the hero scrolls out, the tab surface
 * switches to position:fixed and a spacer prevents layout jump.
 *
 * The fixed bar must respect the sidebar width on desktop viewports
 * to avoid covering the sidebar and logo. On mobile or when the sidebar
 * is collapsed, it spans the full width. */
function initStickyTabBar(): void {
  const hero = document.querySelector<HTMLElement>(".settings-shell__hero")
  const surface = document.getElementById("quick-jumps-surface") as HTMLElement | null
  if (!hero || !surface) return

  /* Create spacer to prevent layout jump when surface becomes fixed */
  const spacer = document.createElement("div")
  spacer.style.cssText = "display:none;width:100%;"
  spacer.setAttribute("aria-hidden", "true")
  surface.parentNode?.insertBefore(spacer, surface.nextSibling)

  /** Calculate the sidebar offset for the fixed tab bar.
   *  Returns 0 on mobile (<768px) or when sidebar is collapsed. */
  function getSidebarOffset(): number {
    if (window.innerWidth < 768) return 0
    if (document.body.classList.contains("sidebar-collapsed")) return 0
    const sidebar = document.querySelector<HTMLElement>(".sidebar")
    return sidebar ? sidebar.offsetWidth : 240
  }

  /** Apply or update the fixed position of the tab surface.
   *  Sits below the TopNavigation (search bar) and to the right of the sidebar. */
  function applyFixedPosition(): void {
    const sidebarOffset = getSidebarOffset()
    /* Measure the topbar so the tab bar sits below it, not on top of it.
       TopNavigation is sticky top-0 z-30 inside .main-content. */
    const topbar = document.querySelector<HTMLElement>(".topbar")
    const topOffset = topbar ? topbar.getBoundingClientRect().bottom : 0
    const rect = surface!.getBoundingClientRect()
    spacer.style.display = "block"
    spacer.style.height = `${rect.height}px`
    surface!.style.position = "fixed"
    surface!.style.top = `${topOffset}px`
    surface!.style.left = `${sidebarOffset}px`
    surface!.style.right = "0"
    surface!.style.width = ""
    surface!.classList.add("is-fixed")
  }

  function clearFixedPosition(): void {
    spacer.style.display = "none"
    surface!.style.position = ""
    surface!.style.top = ""
    surface!.style.left = ""
    surface!.style.right = ""
    surface!.style.width = ""
    surface!.classList.remove("is-fixed")
  }

  let isFixed = false

  const observer = new IntersectionObserver(
    (entries) => {
      const heroVisible = entries[0]?.isIntersecting ?? true
      if (!heroVisible && !isFixed) {
        isFixed = true
        applyFixedPosition()
      } else if (heroVisible && isFixed) {
        isFixed = false
        clearFixedPosition()
      }
    },
    { threshold: 0 },
  )

  /* Re-calculate offset on resize (sidebar may collapse at breakpoints) */
  function onResize(): void {
    if (isFixed) applyFixedPosition()
  }
  window.addEventListener("resize", onResize)

  /* Watch for sidebar collapse toggle via class changes on body */
  const bodyObserver = new MutationObserver(() => {
    if (isFixed) applyFixedPosition()
  })
  bodyObserver.observe(document.body, {
    attributes: true,
    attributeFilter: ["class"],
  })

  observer.observe(hero)
  pageLifecycle.signal.addEventListener("abort", () => {
    observer.disconnect()
    bodyObserver.disconnect()
    window.removeEventListener("resize", onResize)
    spacer.remove()
  }, { once: true })
}

/** Dynamic overflow tabs — Zendesk / Chrome DevTools pattern.
 *  Measures available space in the tab container, fits as many tabs
 *  as possible, and moves the rest into a "⋯ More" dropdown.
 *  Recalculates on resize + sidebar toggle.  Active tab is always
 *  kept visible by swapping it with the last visible tab. */
function initOverflowTabs(): void {
  const container = document.querySelector<HTMLElement>(".settings-shell__summary")
  if (!container) return

  const allTabs = Array.from(container.querySelectorAll<HTMLElement>(".settings-tab"))
  if (allTabs.length <= 1) return

  /* Create "More" button */
  const moreBtn = document.createElement("button")
  moreBtn.className = "settings-overflow-btn"
  moreBtn.setAttribute("aria-expanded", "false")
  moreBtn.setAttribute("aria-haspopup", "true")
  moreBtn.setAttribute("aria-label", "More settings sections")
  moreBtn.innerHTML = `<span aria-hidden="true">⋯</span><span>More</span>`

  /* Create dropdown container */
  const dropdown = document.createElement("div")
  dropdown.className = "settings-overflow-dropdown"
  dropdown.setAttribute("role", "menu")
  dropdown.setAttribute("aria-label", "Hidden settings sections")
  moreBtn.appendChild(dropdown)

  /* Insert More button as last child of the flex container */
  container.appendChild(moreBtn)

  let isDropdownOpen = false

  function toggleDropdown(open?: boolean): void {
    isDropdownOpen = open ?? !isDropdownOpen
    dropdown.classList.toggle("is-open", isDropdownOpen)
    moreBtn.setAttribute("aria-expanded", isDropdownOpen ? "true" : "false")
  }

  function closeDropdown(): void {
    toggleDropdown(false)
  }

  /** Measure how many tabs fit in the available space.
   *  Returns the index of the first tab that overflows. */
  function calculateOverflow(): number {
    /* Temporarily show all tabs to measure their natural widths */
    allTabs.forEach((tab) => {
      tab.style.display = ""
      tab.style.order = ""
    })
    moreBtn.classList.remove("is-visible")
    dropdown.innerHTML = ""

    const containerWidth = container!.clientWidth
    const gap = 6 /* matches CSS gap: 6px */
    const moreBtnWidth = 90 /* approximate width of "⋯ More" button */

    /* Identify active tab index */
    const activeIndex = allTabs.findIndex((t) => t.classList.contains("is-active"))

    let consumed = 0
    let firstOverflow = allTabs.length /* default: everything fits */

    for (let i = 0; i < allTabs.length; i++) {
      const tabWidth = allTabs[i].offsetWidth + (i > 0 ? gap : 0)
      const remaining = containerWidth - consumed

      /* If this tab fits without needing a More button, include it */
      if (consumed + tabWidth <= containerWidth) {
        consumed += tabWidth
        continue
      }

      /* This tab doesn't fit — but we need space for the More button too.
         Back up and recalculate: does PREVIOUS total + moreBtnWidth fit? */
      firstOverflow = i
      /* Check if previous tabs + More button fit */
      if (consumed + moreBtnWidth + gap > containerWidth && i > 1) {
        firstOverflow = i - 1
      }
      break
    }

    /* If the active tab would be hidden, swap it with the last visible tab */
    if (activeIndex >= firstOverflow && firstOverflow > 0) {
      const swapIndex = firstOverflow - 1
      /* Use CSS order to visually swap without moving DOM nodes for event stability */
      allTabs[activeIndex].style.order = String(swapIndex)
      allTabs[swapIndex].style.order = String(activeIndex)
    }

    return firstOverflow
  }

  /** Apply overflow — hide overflowing tabs and populate dropdown */
  function applyOverflow(): void {
    closeDropdown()
    const firstOverflow = calculateOverflow()

    if (firstOverflow >= allTabs.length) {
      /* Everything fits — hide More button */
      moreBtn.classList.remove("is-visible")
      allTabs.forEach((tab) => { tab.style.display = "" })
      return
    }

    /* Show More button */
    moreBtn.classList.add("is-visible")

    /* Determine which tabs are effectively hidden */
    const activeIndex = allTabs.findIndex((t) => t.classList.contains("is-active"))
    const wasSwapped = activeIndex >= firstOverflow && firstOverflow > 0

    for (let i = 0; i < allTabs.length; i++) {
      const isHidden =
        wasSwapped
          ? i === firstOverflow - 1 || (i >= firstOverflow && i !== activeIndex)
          : i >= firstOverflow

      if (isHidden) {
        allTabs[i].style.display = "none"

        /* Create dropdown mirror item */
        const item = document.createElement("button")
        item.className = "settings-overflow-item"
        item.setAttribute("role", "menuitem")
        item.setAttribute("tabindex", "-1")

        if (allTabs[i].classList.contains("is-active")) {
          item.classList.add("is-active")
        }

        /* Copy icon + label from original tab */
        const icon = allTabs[i].querySelector(".settings-tab__icon")
        const label = allTabs[i].querySelector(".settings-tab__label")
        if (icon) item.appendChild(icon.cloneNode(true))
        if (label) item.appendChild(label.cloneNode(true))

        /* Clicking dropdown item delegates to original tab */
        const originalTab = allTabs[i]
        item.addEventListener("click", () => {
          closeDropdown()
          originalTab.click()
          /* Recalculate after click so newly-active tab becomes visible */
          requestAnimationFrame(() => applyOverflow())
        })

        dropdown.appendChild(item)
      } else {
        allTabs[i].style.display = ""
      }
    }

    /* Update More button count badge */
    const hiddenCount = allTabs.filter((_, i) => {
      const isHidden =
        wasSwapped
          ? i === firstOverflow - 1 || (i >= firstOverflow && i !== activeIndex)
          : i >= firstOverflow
      return isHidden
    }).length
    const existing = moreBtn.querySelector("span:last-of-type")
    if (existing) existing.textContent = `More (${hiddenCount})`
  }

  /* Toggle dropdown on click */
  pageLifecycle.on(moreBtn, "click", (e) => {
    e.stopPropagation()
    toggleDropdown()
    if (isDropdownOpen) {
      const firstItem = dropdown.querySelector<HTMLElement>(".settings-overflow-item")
      firstItem?.focus()
    }
  })

  /* Keyboard navigation in dropdown */
  pageLifecycle.on(dropdown, "keydown", (event) => {
    const e = event as KeyboardEvent
    const items = Array.from(dropdown.querySelectorAll<HTMLElement>(".settings-overflow-item"))
    const currentIndex = items.findIndex((item) => item === document.activeElement)

    if (e.key === "Escape") {
      e.preventDefault()
      closeDropdown()
      moreBtn.focus()
      return
    }

    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault()
      const direction = e.key === "ArrowDown" ? 1 : -1
      const nextIndex = (currentIndex + direction + items.length) % items.length
      items[nextIndex]?.focus()
      return
    }
  })

  /* Close dropdown on click outside */
  pageLifecycle.on(document, "click", (e) => {
    if (isDropdownOpen && !moreBtn.contains(e.target as Node)) {
      closeDropdown()
    }
  })

  /* Close dropdown on scroll (prevents dropdown drifting from fixed tab bar) */
  pageLifecycle.on(window, "scroll", () => {
    if (isDropdownOpen) closeDropdown()
  }, { passive: true } as AddEventListenerOptions)

  /* Recalculate on resize (debounced via rAF) */
  let rafId = 0
  function debouncedApply(): void {
    cancelAnimationFrame(rafId)
    rafId = requestAnimationFrame(() => applyOverflow())
  }

  /* ResizeObserver for the tab container — more precise than window resize */
  if (typeof ResizeObserver !== "undefined") {
    const ro = new ResizeObserver(() => debouncedApply())
    ro.observe(container)
    pageLifecycle.signal.addEventListener("abort", () => ro.disconnect(), { once: true })
  }
  /* Also listen to window resize + sidebar toggle for fallback */
  window.addEventListener("resize", debouncedApply)
  const bodyObs = new MutationObserver(() => debouncedApply())
  bodyObs.observe(document.body, { attributes: true, attributeFilter: ["class"] })

  pageLifecycle.signal.addEventListener("abort", () => {
    window.removeEventListener("resize", debouncedApply)
    bodyObs.disconnect()
    cancelAnimationFrame(rafId)
    moreBtn.remove()
  }, { once: true })

  /* Initial calculation */
  requestAnimationFrame(() => applyOverflow())
}

function initGoToTop(): void {
  const btn = document.getElementById("settings-go-top")
  if (!btn) return

  /* Use IntersectionObserver on a sentinel element instead of scroll listener.
   * The sentinel is positioned 400px from the top — when it scrolls out of
   * view, the FAB becomes visible. Zero scroll-event overhead. */
  const sentinel = document.createElement("div")
  sentinel.setAttribute("aria-hidden", "true")
  sentinel.style.cssText = "position:absolute;top:400px;width:1px;height:1px;pointer-events:none;"
  const shell = document.getElementById("settings-shell")
  if (shell) {
    shell.style.position = "relative"
    shell.appendChild(sentinel)
  }

  const observer = new IntersectionObserver(
    (entries) => {
      const isAboveFold = entries[0]?.isIntersecting ?? true
      btn.classList.toggle("is-visible", !isAboveFold)
      btn.hidden = isAboveFold
    },
    { threshold: 0 },
  )
  observer.observe(sentinel)
  pageLifecycle.signal.addEventListener("abort", () => observer.disconnect(), { once: true })

  pageLifecycle.on(btn, "click", () => {
    history.replaceState(null, "", `${window.location.pathname}${window.location.search}`)
    window.scrollTo({ top: 0, behavior: "smooth" })
    syncActiveSectionFromHash()
  })

  pageLifecycle.on(document, "keydown", (event) => {
    const e = event as KeyboardEvent
    if (e.key !== "Home" || e.target !== document.body) return
    e.preventDefault()
    history.replaceState(null, "", `${window.location.pathname}${window.location.search}`)
    window.scrollTo({ top: 0, behavior: "smooth" })
    syncActiveSectionFromHash()
  })
}

export function initSettingsShell(): void {
  const shell = document.getElementById("settings-shell")
  if (!shell) return

  initSearch()
  initSectionLinks()
  initIntersectionTracking()
  initCompanionLinks()
  initStickyTabBar()
  initOverflowTabs()
  initGoToTop()
  syncSummaryStatuses()
  pageLifecycle.on(window, "hashchange", () => {
    syncActiveSectionFromHash()
  })

  const hash = window.location.hash.replace("#", "")
  const hashTargetId = hash ? document.getElementById(hash)?.id || null : null
  const activeSectionId = hash ? resolveSectionId(hash) : null

  if (hash) {
    setShellDetailView(true)
    if (activeSectionId) {
      updateActiveSectionState(activeSectionId)
    }
  } else {
    setShellDetailView(false)
    updateActiveSectionState("personal-settings")
  }

  if (hashTargetId) {
    requestAnimationFrame(() => {
      scrollToAnchor(hashTargetId, "auto")
      if (activeSectionId) {
        updateActiveSectionState(activeSectionId)
      }

      setTimeout(() => {
        scrollToAnchor(hashTargetId, "auto")
        if (activeSectionId) {
          updateActiveSectionState(activeSectionId)
        }
      }, 200)
    })
  }

  /* ARIA tablist: scroll active tab into view and add arrow key navigation */
  const tabContainer = document.querySelector(".settings-shell__summary")
  if (tabContainer) {
    tabContainer.setAttribute("role", "tablist")
    tabContainer.setAttribute("aria-label", "Settings sections")

    const tabs = tabContainer.querySelectorAll<HTMLElement>(".settings-tab")
    tabs.forEach((tab) => {
      tab.setAttribute("role", "tab")
      const isActive = tab.classList.contains("is-active")
      tab.setAttribute("aria-selected", isActive ? "true" : "false")
      tab.setAttribute("tabindex", isActive ? "0" : "-1")
    })

    /* Scroll active tab into view on init (for narrow viewports) */
    const activeTab = tabContainer.querySelector<HTMLElement>(".settings-tab.is-active")
    if (activeTab) {
      requestAnimationFrame(() => {
        activeTab.scrollIntoView({ inline: "center", behavior: "auto", block: "nearest" })
      })
    }

    /* Arrow key navigation per ARIA tablist pattern */
    pageLifecycle.on(tabContainer, "keydown", (event) => {
      const e = event as KeyboardEvent
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return

      const currentTabs = Array.from(
        tabContainer.querySelectorAll<HTMLElement>(".settings-tab"),
      )
      const currentIndex = currentTabs.findIndex((t) => t === document.activeElement)
      if (currentIndex === -1) return

      e.preventDefault()
      const direction = e.key === "ArrowRight" ? 1 : -1
      const nextIndex = (currentIndex + direction + currentTabs.length) % currentTabs.length
      const nextTab = currentTabs[nextIndex]
      if (nextTab) {
        nextTab.focus()
        nextTab.click()
      }
    })
  }

  const sourceIds = [
    "theme-select",
    "labels-list",
    "ha-connection-badge",
    "agent-protocols-status",
    "pwa-compact-badge",
  ]

  sourceIds.forEach((sourceId) => {
    const node = document.getElementById(sourceId)
    if (!node) return

    const observer = new MutationObserver(() => {
      syncSummaryStatuses()
    })

    observer.observe(node, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
    })

    pageLifecycle.signal.addEventListener("abort", () => observer.disconnect(), {
      once: true,
    })
  })
}
