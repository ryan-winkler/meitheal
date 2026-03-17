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
