import { pageLifecycle } from "@lib/page-lifecycle"
import {
  SETTINGS_SECTIONS,
  type SettingsSectionId,
} from "@lib/settings-registry"
import { showToast } from "@lib/toast"
import {
  initUnifiedBarNewTaskButton,
  initUnifiedBarSearchLauncher,
  initUnifiedBarTabOverflow,
  initUnifiedBarTitleSwitcher,
  setUnifiedBarSwitcherActiveState,
} from "@lib/unified-bar-controller"
import {
  buildCompanionNavigateUrl,
  buildCompanionXCallbackUrl,
  buildIngressPagePath,
} from "@lib/page-shell-links"

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
    .querySelectorAll<HTMLElement>(
      "[data-settings-nav], [data-settings-summary], [data-unified-bar-section]",
    )
    .forEach((link) => {
      const active =
        link.dataset.settingsNav === sectionId ||
        link.dataset.settingsSummary === sectionId ||
        link.dataset.unifiedBarSection === sectionId

      link.classList.toggle("is-active", active)
      link.setAttribute("aria-current", active ? "location" : "false")
    })

  setUnifiedBarSwitcherActiveState("settings-bar", sectionId)
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
  revealAllSections()
}

function initSectionLinks(): void {
  document
    .querySelectorAll<HTMLElement>("[data-settings-section-link], [data-unified-bar-section-link]")
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
  return buildCompanionNavigateUrl(buildIngressPagePath("/settings", sectionId))
}

function buildCompanionXCallbackHref(sectionId: SettingsSectionId): string {
  return buildCompanionXCallbackUrl(buildIngressPagePath("/settings", sectionId))
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

/** Sticky bar fallback — CSS position:sticky breaks in HA ingress
 * iframes because the parent HA shell controls scrolling, not the addon
 * body. Uses IntersectionObserver on the first content section to detect
 * when the bar should fix. */
/* initStickyTabBar REMOVED — CSS `position: sticky; top: 0` on .unified-bar
 * handles sticky behavior correctly without JS intervention.
 * The old JS used IntersectionObserver + rootMargin: -60px which delayed
 * sticky engagement until you scrolled past the first section.
 * `.main-content` uses `overflow-x: clip` (not `hidden`) so sticky works
 * at the viewport level without creating a nested scroll context. */

/** Title switcher — the page title acts as a dropdown trigger showing ALL
 *  sections. Replaces both the old hamburger and overflow concepts. */
function initTitleSwitcher(): void {
  initUnifiedBarTitleSwitcher({
    barId: "settings-bar",
    onSelect: (sectionId) => {
      clearSearchState()
      scrollToAnchor(sectionId)
    },
  })

  const hash = window.location.hash.replace("#", "")
  if (hash) {
    setUnifiedBarSwitcherActiveState("settings-bar", hash)
  }
}

/** Search launcher — clicking the search button in the UnifiedBar opens
 *  the global SearchHub modal, pre-scoped to the bar's data-search-scope. */
function initSearchLauncher(): void {
  initUnifiedBarSearchLauncher("settings-bar")
}

/** Tab overflow — uses ResizeObserver to show only tabs that fit in the
 *  available space. Hidden tabs are still accessible via the title dropdown. */
function initTabOverflow(): void {
  initUnifiedBarTabOverflow("settings-bar")
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

/** + New Task button — opens the global NewTaskModal.
 *  Uses window.openNewTaskModal() (same pattern as kanban/dashboard controllers).
 *  Includes a retry tick for late-loaded scripts. */
function initNewTaskButton(): void {
  initUnifiedBarNewTaskButton({
    barId: "settings-bar",
    fallbackMessage: "Task modal not ready - try again",
  })
}

export function initSettingsShell(): void {
  const shell = document.getElementById("settings-shell")
  if (!shell) return

  initSectionLinks()
  initIntersectionTracking()
  initCompanionLinks()
  // initStickyTabBar removed — CSS sticky handles this (see above)
  initTitleSwitcher()
  initSearchLauncher()
  initNewTaskButton()
  initTabOverflow()
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

  /* Tab arrow key navigation for quick access tabs */
  const tabContainer = document.getElementById("settings-bar-tabs")
  if (tabContainer) {
    pageLifecycle.on(tabContainer, "keydown", (event) => {
      const e = event as KeyboardEvent
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return

      const visibleTabs = Array.from(
        tabContainer.querySelectorAll<HTMLElement>("[data-unified-bar-tab]:not([data-overflow-hidden])"),
      )
      const currentIndex = visibleTabs.findIndex((t) => t === document.activeElement)
      if (currentIndex === -1) return

      e.preventDefault()
      const direction = e.key === "ArrowRight" ? 1 : -1
      const nextIndex = (currentIndex + direction + visibleTabs.length) % visibleTabs.length
      const nextTab = visibleTabs[nextIndex]
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
