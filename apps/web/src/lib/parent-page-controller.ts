/**
 * Parent Page Controller — generalized hash-routing for parent page shells
 *
 * Extracted from settings-shell-controller.ts and generalized for reuse
 * across Tasks, Progress & Growth, and Planning parent pages.
 *
 * @domain navigation
 * @phase 15 — Hierarchy Architecture Overhaul
 */

import { pageLifecycle } from "@lib/page-lifecycle"
import {
  initUnifiedBarNewTaskButton,
  initUnifiedBarSearchLauncher,
  initUnifiedBarTabOverflow,
  initUnifiedBarTitleSwitcher,
  setUnifiedBarSwitcherActiveState,
} from "@lib/unified-bar-controller"

// ─── Types ─────────────────────────────────────────────────────────

export interface ParentPageControllerConfig {
  /** DOM id of the shell container (e.g. "tasks-shell") */
  shellId: string
  /** DOM id of the UnifiedBar (e.g. "tasks-bar") */
  barId: string
  /** Array of valid section IDs for this page */
  sectionIds: string[]
  /** Default section to activate when no hash is present */
  defaultSectionId: string
  /** Data attribute used on section containers (e.g. "data-parent-section") */
  sectionAttr?: string
}

// ─── Controller ────────────────────────────────────────────────────

export function initParentPageController(config: ParentPageControllerConfig): void {
  const shell = document.getElementById(config.shellId)
  if (!shell) return
  if (shell.dataset.parentPageBooted === "true") return

  shell.dataset.parentPageBooted = "true"

  const sectionAttr = config.sectionAttr ?? "data-parent-section"

  // ─── Section Visibility ────────────────────────────────────────

  function showSection(sectionId: string): void {
    const sections = shell!.querySelectorAll<HTMLElement>(`[${sectionAttr}]`)
    sections.forEach((section) => {
      const isTarget = section.getAttribute(sectionAttr) === sectionId
      section.hidden = !isTarget
      section.classList.toggle("is-active", isTarget)
      section.setAttribute("aria-hidden", isTarget ? "false" : "true")
    })
  }

  function updateActiveTab(sectionId: string): void {
    // Update UnifiedBar tabs
    shell!.querySelectorAll<HTMLElement>("[data-unified-bar-section]")
      .forEach((tab) => {
        const isActive = tab.dataset.unifiedBarSection === sectionId
        tab.classList.toggle("is-active", isActive)
        tab.setAttribute("aria-current", isActive ? "location" : "false")
      })

    setUnifiedBarSwitcherActiveState(config.barId, sectionId)
  }

  function activateSection(sectionId: string, updateHash = true): void {
    if (!config.sectionIds.includes(sectionId)) {
      sectionId = config.defaultSectionId
    }

    showSection(sectionId)
    updateActiveTab(sectionId)

    if (updateHash) {
      const currentHash = window.location.hash.replace("#", "")
      if (currentHash !== sectionId) {
        history.pushState({ section: sectionId, shell: config.shellId }, "", `#${sectionId}`)
      }
    }
  }

  // ─── Section Link Clicks ───────────────────────────────────────

  function initSectionLinks(): void {
    shell!.querySelectorAll<HTMLElement>("[data-unified-bar-section-link]")
      .forEach((link) => {
        pageLifecycle.on(link, "click", (event) => {
          event.preventDefault()
          const targetId = link.getAttribute("href")?.replace("#", "")
          if (targetId) activateSection(targetId)
        })
      })
  }

  // ─── Hash Sync ─────────────────────────────────────────────────

  function syncFromHash(): void {
    const hash = window.location.hash.replace("#", "")
    if (hash && config.sectionIds.includes(hash)) {
      activateSection(hash, false)
    } else {
      activateSection(config.defaultSectionId, !hash)
    }
  }

  // ─── Tab Keyboard Navigation ───────────────────────────────────

  function initTabKeyboardNav(): void {
    const tabContainer = document.getElementById(`${config.barId}-tabs`)
    if (!tabContainer) return

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

  // ─── Back/Forward Navigation ────────────────────────────────────

  function handlePopState(event: PopStateEvent): void {
    // If the popstate event belongs to a different shell, ignore it
    if (event.state?.shell && event.state.shell !== config.shellId) return

    const sectionFromState = event.state?.section
    if (sectionFromState && config.sectionIds.includes(sectionFromState)) {
      activateSection(sectionFromState, false)
      return
    }

    // Fallback: read from hash
    syncFromHash()
  }

  // ─── Init ──────────────────────────────────────────────────────

  initSectionLinks()
  initTabKeyboardNav()

  initUnifiedBarTitleSwitcher({
    barId: config.barId,
    onSelect: (sectionId) => activateSection(sectionId),
  })

  initUnifiedBarSearchLauncher(config.barId)
  initUnifiedBarTabOverflow(config.barId)

  initUnifiedBarNewTaskButton({
    barId: config.barId,
    fallbackMessage: "Task modal not ready — try again",
  })

  pageLifecycle.on(window, "popstate", handlePopState as EventListener)

  // Initial activation
  syncFromHash()
}
