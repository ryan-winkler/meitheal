/**
 * Settings controller — thin orchestrator.
 *
 * All domain logic lives in dedicated controllers:
 *   settings-theme-controller.ts      — theme, locale, timezone, date format
 *   settings-sidebar-controller.ts    — sidebar order, custom links, drag-and-drop
 *   settings-data-controller.ts       — JSON/DB export, import, custom fields, frameworks
 *   settings-ai-controller.ts         — AI provider, agent protocols
 *   settings-danger-controller.ts     — purge tasks, reset settings
 *   settings-integrations-ha-controller.ts   — HA connection test, webhook save/test
 *   settings-integrations-n8n-controller.ts  — n8n (both modes), Node-RED, event bus
 *   settings-integrations-grocy-controller.ts — Grocy save, test, sync, hydration
 *   settings-integrations-sync-controller.ts  — Calendar & Todo sync, CalDAV
 *   settings-utils.ts                 — shared saveSetting, loadAllSettings, sanitizeCSS
 *
 * This file is responsible for:
 *   1. Importing and calling init* from each controller
 *   2. Loading settings from API and delegating restore to each controller
 *   3. Integration card expand/collapse wiring
 *   4. n8n mode tab switching
 */
import { createClientLogger } from "@lib/client-logger"
import { pageLifecycle } from "@lib/page-lifecycle"
import { settingsStore } from "@lib/settings-store"

// Domain controllers
import { initThemeSettings, restoreThemeSettings } from "@lib/settings-theme-controller"
import { initSidebarSettings, restoreSidebarSettings } from "@lib/settings-sidebar-controller"
import { initDataSettings, restoreDataSettings } from "@lib/settings-data-controller"
import { initAISettings, restoreAISettings } from "@lib/settings-ai-controller"
import { initDangerZoneSettings } from "@lib/settings-danger-controller"
import { initHASettings, restoreHASettings } from "@lib/settings-integrations-ha-controller"
import { initN8nSettings, restoreN8nSettings } from "@lib/settings-integrations-n8n-controller"
import { initGrocySettings } from "@lib/settings-integrations-grocy-controller"
import { initCalendarTodoSettings, restoreCalendarTodoSettings } from "@lib/settings-integrations-sync-controller"
import { initRulesSettings } from "@lib/settings-rules-controller"

const log = createClientLogger("settings")

export function initSettingsController(): void {
  function setIntegrationCardExpanded(header: HTMLButtonElement, expanded: boolean): void {
    const bodyId = header.getAttribute("aria-controls")
    const body = bodyId ? document.getElementById(bodyId) : null
    if (!body) return

    if (!expanded && body.contains(document.activeElement)) header.focus()
    body.inert = !expanded
    header.setAttribute("aria-expanded", String(expanded))
  }

  window.expandIntegrationCard = (bodyId: string) => {
    const card = document.getElementById(bodyId)?.closest(".integration-card")
    const header = card?.querySelector<HTMLButtonElement>(".integration-card__header")
    if (header) setIntegrationCardExpanded(header, true)
  }

  document.querySelectorAll<HTMLButtonElement>(".integration-card__header").forEach((header) => {
    pageLifecycle.on(header, "click", () => {
      setIntegrationCardExpanded(header, header.getAttribute("aria-expanded") !== "true")
    })
  })

  const n8nAutoTab = document.getElementById("n8n-mode-auto")
  const n8nStandaloneTab = document.getElementById("n8n-mode-standalone")
  const switchToAuto = () => {
    n8nAutoTab?.classList.add("mode-tab--active")
    n8nStandaloneTab?.classList.remove("mode-tab--active")
    n8nAutoTab?.setAttribute("aria-selected", "true")
    n8nStandaloneTab?.setAttribute("aria-selected", "false")
    const autoContent = document.getElementById("n8n-auto-content")
    const standaloneContent = document.getElementById("n8n-standalone-content")
    if (autoContent) autoContent.style.display = ""
    if (standaloneContent) standaloneContent.style.display = "none"
  }
  const switchToStandalone = () => {
    n8nStandaloneTab?.classList.add("mode-tab--active")
    n8nAutoTab?.classList.remove("mode-tab--active")
    n8nStandaloneTab?.setAttribute("aria-selected", "true")
    n8nAutoTab?.setAttribute("aria-selected", "false")
    const autoContent = document.getElementById("n8n-auto-content")
    const standaloneContent = document.getElementById("n8n-standalone-content")
    if (autoContent) autoContent.style.display = "none"
    if (standaloneContent) standaloneContent.style.display = ""
  }
  if (n8nAutoTab) {
    n8nAutoTab.setAttribute("role", "tab")
    n8nAutoTab.setAttribute("tabindex", "0")
    pageLifecycle.on(n8nAutoTab, "click", switchToAuto)
    pageLifecycle.on(n8nAutoTab, "keydown", (e) => {
      if ((e as KeyboardEvent).key === "Enter" || (e as KeyboardEvent).key === " ") {
        e.preventDefault()
        switchToAuto()
      }
    })
  }
  if (n8nStandaloneTab) {
    n8nStandaloneTab.setAttribute("role", "tab")
    n8nStandaloneTab.setAttribute("tabindex", "0")
    pageLifecycle.on(n8nStandaloneTab, "click", switchToStandalone)
    pageLifecycle.on(n8nStandaloneTab, "keydown", (e) => {
      if ((e as KeyboardEvent).key === "Enter" || (e as KeyboardEvent).key === " ") {
        e.preventDefault()
        switchToStandalone()
      }
    })
  }


  // ───── Init all domain controllers ─────
  initThemeSettings()
  initSidebarSettings()
  initDataSettings()
  initAISettings()
  initDangerZoneSettings()
  initHASettings()
  initN8nSettings()
  initGrocySettings()
  initCalendarTodoSettings()
  initRulesSettings()

  // ───── Load and restore all settings ─────
  loadSettings()
}

async function loadSettings(): Promise<void> {
  let settings: Record<string, unknown> = {}
  try {
    settings = await settingsStore.load()
  } catch (e) {
    log.error("Failed to load settings from API", e)
    // Fall back to localStorage for locale
    const stored = localStorage.getItem("meitheal-locale") || "en"
    const localeEl = document.getElementById("locale-select") as HTMLSelectElement | null
    if (localeEl) localeEl.value = stored
    return
  }

  // Delegate restore to each controller — wrapped in try/catch per domain
  try { restoreThemeSettings(settings) } catch (e) { log.error("Theme restore error", e) }
  try { restoreSidebarSettings(settings) } catch (e) { log.error("Sidebar restore error", e) }
  try { restoreDataSettings(settings) } catch (e) { log.error("Data restore error", e) }
  try { restoreAISettings(settings) } catch (e) { log.error("AI restore error", e) }
  try { restoreHASettings(settings) } catch (e) { log.error("HA restore error", e) }
  try { restoreN8nSettings(settings) } catch (e) { log.error("n8n restore error", e) }
  try { restoreCalendarTodoSettings(settings) } catch (e) { log.error("Calendar/Todo restore error", e) }
}
