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

const log = createClientLogger("settings")

export function initSettingsController(): void {
  // ───── Integration card expand/collapse ─────
  window.expandIntegrationCard = (bodyId: string) => {
    const body = document.getElementById(bodyId)
    if (body) body.style.display = "block"
  }

  document.querySelectorAll<HTMLElement>(".integration-card__header").forEach((header) => {
    pageLifecycle.on(header, "click", () => {
      const bodyId = header.dataset.target
      if (!bodyId) return
      const body = document.getElementById(bodyId)
      if (!body) return
      const isOpen = body.style.display !== "none"
      body.style.display = isOpen ? "none" : "block"
      const chevron = header.querySelector<HTMLElement>(".integration-card__chevron")
      if (chevron) chevron.style.transform = isOpen ? "rotate(0deg)" : "rotate(90deg)"
    })
  })

  // ───── n8n mode tabs ─────
  const n8nAutoTab = document.getElementById("n8n-mode-auto")
  if (n8nAutoTab) {
    pageLifecycle.on(n8nAutoTab, "click", () => {
      document.getElementById("n8n-mode-auto")?.classList.add("mode-tab--active")
      document.getElementById("n8n-mode-standalone")?.classList.remove("mode-tab--active")
      const autoContent = document.getElementById("n8n-auto-content")
      const standaloneContent = document.getElementById("n8n-standalone-content")
      if (autoContent) autoContent.style.display = ""
      if (standaloneContent) standaloneContent.style.display = "none"
    })
  }
  const n8nStandaloneTab = document.getElementById("n8n-mode-standalone")
  if (n8nStandaloneTab) {
    pageLifecycle.on(n8nStandaloneTab, "click", () => {
      document.getElementById("n8n-mode-standalone")?.classList.add("mode-tab--active")
      document.getElementById("n8n-mode-auto")?.classList.remove("mode-tab--active")
      const autoContent = document.getElementById("n8n-auto-content")
      const standaloneContent = document.getElementById("n8n-standalone-content")
      if (autoContent) autoContent.style.display = "none"
      if (standaloneContent) standaloneContent.style.display = ""
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
