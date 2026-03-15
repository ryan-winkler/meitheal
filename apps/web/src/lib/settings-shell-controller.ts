import { pageLifecycle } from "@lib/page-lifecycle"
import {
  SETTINGS_SECTIONS,
  searchSettingsRegistry,
  type SettingsSectionId,
} from "@lib/settings-registry"
import { showToast } from "@lib/toast"

function scrollToAnchor(anchorId: string, behavior: ScrollBehavior = "smooth"): void {
  const target = document.getElementById(anchorId)
  if (!target) return

  target.scrollIntoView({ behavior, block: "start" })
  history.replaceState(null, "", `#${anchorId}`)
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

    const detail = summary.querySelector(".settings-summary-card__detail")
    const navStatus = document.querySelector<HTMLElement>(
      `[data-settings-nav-status="${mapping.sectionId}"]`,
    )
    const text = mapping.detail(document.getElementById(mapping.sourceId))

    if (detail) detail.textContent = text
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

  if (input) input.value = ""
  if (results) results.hidden = true
  revealAllSections()
}

function initSearch(): void {
  const input = document.getElementById(
    "settings-search-input",
  ) as HTMLInputElement | null
  const results = document.getElementById("settings-search-results")
  if (!input || !results) return

  pageLifecycle.on(input, "input", () => {
    const matches = searchSettingsRegistry(input.value)
    const visibleSections = new Set(matches.map((match) => match.sectionId))

    results.innerHTML = ""

    if (!input.value.trim()) {
      results.hidden = true
      revealAllSections()
      return
    }

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
      results.innerHTML =
        '<div class="settings-search-results__empty">No matching settings yet</div>'
      return
    }

    matches.forEach((match) => {
      const button = document.createElement("button")
      button.type = "button"
      button.className = "settings-search-results__item"
      button.innerHTML = `
        <strong>${match.label}</strong>
        <span>${match.description}</span>
      `

      pageLifecycle.on(button, "click", () => {
        clearSearchState()
        scrollToAnchor(match.anchorId)
        updateActiveSectionState(match.sectionId)
      })

      results.appendChild(button)
    })

    results.hidden = false
  })

  pageLifecycle.on(input, "keydown", (event) => {
    const keyboardEvent = event as KeyboardEvent
    if (keyboardEvent.key !== "Enter") return

    const firstMatch = searchSettingsRegistry(input.value)[0]
    if (!firstMatch) return

    keyboardEvent.preventDefault()
    clearSearchState()
    scrollToAnchor(firstMatch.anchorId)
    updateActiveSectionState(firstMatch.sectionId)
  })
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
        const sectionId = resolveSectionId(targetId)
        if (sectionId) {
          updateActiveSectionState(sectionId)
        }
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
  if (!hash) return

  const sectionId = resolveSectionId(hash)
  if (sectionId) {
    updateActiveSectionState(sectionId)
  }
}

export function initSettingsShell(): void {
  const shell = document.getElementById("settings-shell")
  if (!shell) return

  initSearch()
  initSectionLinks()
  initIntersectionTracking()
  initCompanionLinks()
  syncSummaryStatuses()
  pageLifecycle.on(window, "hashchange", () => {
    syncActiveSectionFromHash()
  })

  const hash = window.location.hash.replace("#", "")
  const hashTargetId = hash ? document.getElementById(hash)?.id || null : null
  const activeSectionId = hash ? resolveSectionId(hash) : null

  if (activeSectionId) {
    updateActiveSectionState(activeSectionId)
  } else if (document.getElementById("workflow-settings")) {
    updateActiveSectionState("workflow-settings")
  } else {
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
