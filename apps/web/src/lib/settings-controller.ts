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

  const status = document.getElementById("settings-load-status")
  const loading = document.getElementById("settings-loading")
  const error = document.getElementById("settings-load-error")
  const retry = document.getElementById("settings-load-retry")
  const panels = document.getElementById("settings-panels")
  if (!status || !loading || !error || !retry || !panels) return

  async function load(): Promise<void> {
    loading!.hidden = false
    error!.hidden = true
    retry!.hidden = true
    try {
      await loadSettings()
      status!.hidden = true
      panels!.inert = false
      panels!.closest("#settings-shell")?.dispatchEvent(new Event("meitheal:settings-ready"))
    } catch (cause) {
      log.error("Failed to load settings from API", cause)
      error!.hidden = false
      retry!.hidden = false
    } finally {
      loading!.hidden = true
    }
  }

  pageLifecycle.on(retry, "click", () => { void load() })
  void load()
}

async function loadSettings(): Promise<void> {
  const settings = await settingsStore.load()

  // Delegate restore to each controller — wrapped in try/catch per domain
  try { restoreThemeSettings(settings) } catch (e) { log.error("Theme restore error", e) }
  try { restoreSidebarSettings(settings) } catch (e) { log.error("Sidebar restore error", e) }
  try { restoreDataSettings(settings) } catch (e) { log.error("Data restore error", e) }
  try { restoreAISettings(settings) } catch (e) { log.error("AI restore error", e) }
  try { restoreHASettings(settings) } catch (e) { log.error("HA restore error", e) }
  try { restoreN8nSettings(settings) } catch (e) { log.error("n8n restore error", e) }
  try { restoreCalendarTodoSettings(settings) } catch (e) { log.error("Calendar/Todo restore error", e) }
}
