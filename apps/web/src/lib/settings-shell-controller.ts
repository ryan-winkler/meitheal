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

function updateActiveNav(sectionId: string): void {
  document.querySelectorAll<HTMLElement>("[data-settings-nav]").forEach((link) => {
    const active = link.dataset.settingsNav === sectionId
    link.classList.toggle("is-active", active)
    link.setAttribute("aria-current", active ? "location" : "false")
  })
}

function syncSummaryStatuses(): void {
  const mappings = [
    {
      sectionId: "personal-settings",
      summaryId: "settings-summary-personal",
      sourceId: "theme-select",
      detail: (source: HTMLElement | null) => (source as HTMLSelectElement | null)?.value ?? "Default",
    },
    {
      sectionId: "workflow-settings",
      summaryId: "settings-summary-workflow",
      sourceId: "labels-list",
      detail: (source: HTMLElement | null) => {
        const count = source?.querySelectorAll(".label-settings-row").length ?? 0
        return count > 0 ? `${count} labels` : "Ready to customize"
      },
    },
    {
      sectionId: "integrations-settings",
      summaryId: "settings-summary-integrations",
      sourceId: "ha-connection-badge",
      detail: (source: HTMLElement | null) => source?.textContent?.trim() || "Checking",
    },
    {
      sectionId: "automation-ai-settings",
      summaryId: "settings-summary-ai",
      sourceId: "agent-protocols-status",
      detail: (source: HTMLElement | null) => source?.textContent?.trim() || "Available",
    },
    {
      sectionId: "app-pwa-settings",
      summaryId: "settings-summary-pwa",
      sourceId: "pwa-compact-badge",
      detail: (source: HTMLElement | null) => source?.textContent?.trim() || "Checking",
    },
    {
      sectionId: "danger-zone-settings",
      summaryId: "settings-summary-danger",
      sourceId: "reset-settings",
      detail: () => "Protected actions",
    },
  ] as const

  mappings.forEach((mapping) => {
    const summary = document.getElementById(mapping.summaryId)
    if (!summary) return

    const detail = summary.querySelector(".settings-summary-card__detail")
    const navStatus = document.getElementById(`nav-status-${mapping.sectionId}`)
    const text = mapping.detail(document.getElementById(mapping.sourceId))

    if (detail) detail.textContent = text
    if (navStatus) navStatus.textContent = text
  })
}

function initSearch(): void {
  const input = document.getElementById("settings-search-input") as HTMLInputElement | null
  const results = document.getElementById("settings-search-results")
  if (!input || !results) return

  pageLifecycle.on(input, "input", () => {
    const matches = searchSettingsRegistry(input.value)
    const visibleSections = new Set(matches.map((match) => match.sectionId))

    results.innerHTML = ""

    if (!input.value.trim()) {
      results.hidden = true
      document.querySelectorAll<HTMLElement>("[data-settings-shell-section]").forEach((section) => {
        section.classList.remove("settings-shell__section--muted")
      })
      return
    }

    SETTINGS_SECTIONS.forEach((section) => {
      const element = document.getElementById(section.id)
      if (!element) return
      element.classList.toggle("settings-shell__section--muted", !visibleSections.has(section.id))
    })

    if (matches.length === 0) {
      results.hidden = false
      results.innerHTML = '<div class="settings-search-results__empty">No matching settings yet</div>'
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
        input.value = ""
        results.hidden = true
        document.querySelectorAll<HTMLElement>("[data-settings-shell-section]").forEach((section) => {
          section.classList.remove("settings-shell__section--muted")
        })
        scrollToAnchor(match.anchorId)
        updateActiveNav(match.sectionId)
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
    scrollToAnchor(firstMatch.anchorId)
    updateActiveNav(firstMatch.sectionId)
    results.hidden = true
  })
}

function initSectionLinks(): void {
  document.querySelectorAll<HTMLElement>("[data-settings-section-link]").forEach((link) => {
    pageLifecycle.on(link, "click", (event) => {
      event.preventDefault()
      const targetId = link.getAttribute("href")?.replace("#", "")
      if (!targetId) return
      scrollToAnchor(targetId)
      updateActiveNav(targetId)
    })
  })
}

function initIntersectionTracking(): void {
  const sections = document.querySelectorAll<HTMLElement>("[data-settings-shell-section]")
  if (!sections.length) return

  const observer = new IntersectionObserver(
    (entries) => {
      const active = entries
        .filter((entry) => entry.isIntersecting)
        .sort((left, right) => right.intersectionRatio - left.intersectionRatio)[0]

      if (!active?.target.id) return
      updateActiveNav(active.target.id)
    },
    {
      rootMargin: "-25% 0px -50% 0px",
      threshold: [0.2, 0.4, 0.6],
    },
  )

  sections.forEach((section) => observer.observe(section))
  pageLifecycle.signal.addEventListener("abort", () => observer.disconnect(), { once: true })
}

function buildCompanionNavigateHref(sectionId: SettingsSectionId): string {
  const ingressPath = window.__ingress_path || ""
  const path = `${ingressPath}/settings#${sectionId}`
  return `homeassistant://navigate${path}`
}

function buildCompanionXCallbackHref(sectionId: SettingsSectionId): string {
  const ingressPath = window.__ingress_path || ""
  const path = `${ingressPath}/settings#${sectionId}`
  return `homeassistant://x-callback-url/navigate?path=${encodeURIComponent(path)}`
}

function initCompanionLinks(): void {
  document.querySelectorAll<HTMLAnchorElement>("[data-companion-link]").forEach((link) => {
    const sectionId = (link.dataset.companionLink || "app-pwa-settings") as SettingsSectionId
    link.href = buildCompanionNavigateHref(sectionId)
  })

  document.querySelectorAll<HTMLElement>("[data-companion-xcallback]").forEach((container) => {
    const sectionId = (container.dataset.companionXcallback || "app-pwa-settings") as SettingsSectionId
    const xCallbackHref = buildCompanionXCallbackHref(sectionId)
    const preview = container.querySelector<HTMLElement>("[data-companion-xcallback-preview]")
    const copyButton = container.querySelector<HTMLButtonElement>("[data-companion-xcallback-button]")

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

export function initSettingsShell(): void {
  const shell = document.getElementById("settings-shell")
  if (!shell) return

  initSearch()
  initSectionLinks()
  initIntersectionTracking()
  initCompanionLinks()
  syncSummaryStatuses()

  const hash = window.location.hash.replace("#", "")
  let activeSectionId: SettingsSectionId | null = null
  let hashTargetId: string | null = null

  if (hash) {
    const target = document.getElementById(hash)
    hashTargetId = target?.id || null
    const maybeSectionId =
      target?.closest<HTMLElement>("[data-settings-shell-section]")?.id ||
      target?.id ||
      null

    if (SETTINGS_SECTIONS.some((section) => section.id === maybeSectionId)) {
      activeSectionId = maybeSectionId as SettingsSectionId
    }
  }

  if (activeSectionId) {
    updateActiveNav(activeSectionId)
  } else if (document.getElementById("workflow-settings")) {
    updateActiveNav("workflow-settings")
  } else {
    updateActiveNav("personal-settings")
  }

  if (hashTargetId) {
    requestAnimationFrame(() => {
      scrollToAnchor(hashTargetId!, "auto")
      if (activeSectionId) {
        updateActiveNav(activeSectionId)
      }

      setTimeout(() => {
        scrollToAnchor(hashTargetId!, "auto")
        if (activeSectionId) {
          updateActiveNav(activeSectionId)
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

    pageLifecycle.signal.addEventListener("abort", () => observer.disconnect(), { once: true })
  })
}
