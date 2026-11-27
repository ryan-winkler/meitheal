/**
 * Calendar & Todo sync integration settings controller.
 *
 * Handles: Calendar entity hydration, toggle cards, save, sync,
 * CalDAV test, manual entity add, Todo hydration, save, sync.
 * All HA-ingress-aware via window.__ingress_path.
 */
import { withAsyncButton } from "@lib/async-button"
import { describeManualCalendarPushState, shouldShowManualCalendarPush } from "@lib/calendar-push-policy"
import { pageLifecycle } from "@lib/page-lifecycle"
import { showToast } from "@lib/toast"
import { PartialSettingsSave, saveSettings, showSettingsSaveError, log } from "@lib/settings-utils"
import { settingsWriteHeaders } from "./settings-store"

async function applySyncConfiguration(path: string, setting: string, payload: Record<string, unknown>): Promise<void> {
  try {
    const response = await fetch(path, { // nosemgrep
      method: "POST",
      headers: settingsWriteHeaders(setting),
      body: JSON.stringify(payload),
      signal: pageLifecycle.signal,
    })
    if (!response.ok) throw new Error(`Sync configuration failed: ${response.status}`)
  } catch (cause) {
    throw new PartialSettingsSave("Settings saved before sync configuration failed", { cause })
  }
}

const CAL_SYNC_DIRECTIONS = [
  ["bidirectional", "↔ Bidirectional"],
  ["import", "↓ Import only"],
  ["export", "↑ Export only"],
] as const

interface EntityCardOptions {
  entityId: string
  name: string
  stateLabel: string
  checked: boolean
  toggleClass: "cal-entity-toggle" | "todo-entity-toggle"
  direction?: { selected: string; hidden?: boolean }
}

function createEntityToggleCard(opts: EntityCardOptions): HTMLDivElement {
  const card = document.createElement("div")
  card.className = `cal-toggle-card${opts.checked ? " cal-toggle-card--active" : ""}`
  card.dataset.entity = opts.entityId
  card.style.cursor = "pointer"

  const info = document.createElement("div")
  info.className = "cal-toggle-card__info"
  const nameEl = document.createElement("span")
  nameEl.className = "cal-toggle-card__name"
  nameEl.textContent = opts.name
  const entityEl = document.createElement("span")
  entityEl.className = "cal-toggle-card__entity"
  entityEl.textContent = opts.entityId
  info.append(nameEl, entityEl)

  if (opts.direction) {
    const dirWrap = document.createElement("div")
    dirWrap.className = "cal-toggle-card__direction"
    if (opts.direction.hidden) dirWrap.style.display = "none"
    const dirSelect = document.createElement("select")
    dirSelect.className = "cal-direction-select"
    dirSelect.dataset.entityDir = opts.entityId
    dirSelect.setAttribute("aria-label", `Sync direction for ${opts.name}`)
    for (const [val, label] of CAL_SYNC_DIRECTIONS) {
      const opt = document.createElement("option")
      opt.value = val
      opt.textContent = label
      opt.selected = opts.direction.selected === val
      dirSelect.appendChild(opt)
    }
    dirWrap.appendChild(dirSelect)
    info.appendChild(dirWrap)
  }

  const stateEl = document.createElement("span")
  stateEl.className = "cal-toggle-card__state"
  stateEl.textContent = opts.stateLabel
  info.appendChild(stateEl)

  const toggleLabel = document.createElement("label")
  toggleLabel.className = "toggle-label"
  const cb = document.createElement("input")
  cb.type = "checkbox"
  cb.className = opts.toggleClass
  cb.checked = opts.checked
  cb.value = opts.entityId
  cb.setAttribute("aria-label", `Sync ${opts.name}`)
  const slider = document.createElement("span")
  slider.className = "toggle-slider"
  toggleLabel.append(cb, slider)

  card.append(info, toggleLabel)
  return card
}

export function initCalendarTodoSettings(): void {
  // ───── Calendar manual add ─────
  const calManualBtn = document.getElementById("cal-add-manual")
  if (calManualBtn) {
    pageLifecycle.on(calManualBtn, "click", () => {
    const input = document.getElementById("cal-entity-manual") as HTMLInputElement | null
    const container = document.getElementById("cal-entities-container")
    const entitiesList = document.getElementById("cal-entities-list")
    if (!input || !container) return
    const entityId = input.value.trim()
    if (!entityId || !entityId.startsWith("calendar.")) {
      input.style.borderColor = "var(--red-500, #ef4444)"
      setTimeout(() => { input.style.borderColor = "" }, 1500)
      return
    }
    if (container.querySelector(`[data-entity="${CSS.escape(entityId)}"]`)) { input.value = ""; return }
    if (entitiesList) entitiesList.style.display = "block"
    const card = createEntityToggleCard({
      entityId,
      name: entityId,
      stateLabel: "manually added",
      checked: true,
      toggleClass: "cal-entity-toggle",
      direction: { selected: "bidirectional" },
    })
    const dirSelect = card.querySelector<HTMLSelectElement>(".cal-direction-select")
    dirSelect?.addEventListener("click", (e) => e.stopPropagation(), { signal: pageLifecycle.signal })
    dirSelect?.addEventListener("mousedown", (e) => e.stopPropagation(), { signal: pageLifecycle.signal })
    const entityToggle = card.querySelector<HTMLInputElement>(".cal-entity-toggle")
    entityToggle?.addEventListener("change", () => {
      card.classList.toggle("cal-toggle-card--active", entityToggle.checked)
      updateCalCountBadge()
    }, { signal: pageLifecycle.signal })
    card.addEventListener("click", (e) => {
      const target = e.target as HTMLElement
      if (target.closest(".toggle-label") || target.closest(".cal-direction-select")) return
      if (entityToggle) {
        entityToggle.checked = !entityToggle.checked
        entityToggle.dispatchEvent(new Event("change", { bubbles: true }))
      }
    }, { signal: pageLifecycle.signal })
    container.appendChild(card)
    const emptyState = document.getElementById("cal-no-entities")
    if (emptyState) emptyState.style.display = "none"
    updateCalCountBadge()
    input.value = ""
    })
  }

  // ───── CalDAV Test ─────
  const caldavTestBtn = document.getElementById("caldav-test-btn") as HTMLButtonElement
  if (caldavTestBtn) {
    pageLifecycle.on(caldavTestBtn, "click", withAsyncButton(caldavTestBtn, async () => {
    const url = (document.getElementById("caldav-url") as HTMLInputElement).value
    const username = (document.getElementById("caldav-username") as HTMLInputElement).value
    const password = (document.getElementById("caldav-password") as HTMLInputElement).value
    const resultEl = document.getElementById("caldav-test-result")
    if (!url || !username || !password) {
      if (resultEl) { resultEl.textContent = "URL, username, and password required"; resultEl.style.color = "var(--color-error)" }
      return
    }
    if (resultEl) { resultEl.textContent = ""; resultEl.style.color = "" }
    try {
      const res = await fetch("/api/integrations/calendar/caldav-credentials", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "test", url, username, password }),
        signal: pageLifecycle.signal,
      })
      const data = await res.json()
      if (resultEl) {
        resultEl.textContent = data.ok ? data.message : String(data.message || data.error || "Connection test failed")
        resultEl.style.color = data.ok ? "var(--color-success)" : "var(--color-error)"
      }
    } catch {
      if (resultEl) { resultEl.textContent = "Request failed"; resultEl.style.color = "var(--color-error)" }
    }
    }, { loadingText: "Testing…" }))
  }

  const saveCalBtn = document.getElementById("save-cal") as HTMLButtonElement
  if (saveCalBtn) {
    pageLifecycle.on(saveCalBtn, "click", withAsyncButton(saveCalBtn, async () => {
    const enabledEntities: string[] = []
    document.querySelectorAll<HTMLInputElement>(".cal-entity-toggle:checked").forEach((cb) => enabledEntities.push(cb.value))
    const syncModes: Record<string, string> = {}
    document.querySelectorAll<HTMLSelectElement>(".cal-direction-select").forEach((sel) => {
      const entityId = sel.dataset.entityDir
      if (entityId && enabledEntities.includes(entityId)) syncModes[entityId] = sel.value
    })
    const globalMode = (document.getElementById("cal-sync-direction") as HTMLSelectElement)?.value ?? "bidirectional"
    const caldavUrl = (document.getElementById("caldav-url") as HTMLInputElement).value
    const caldavUsername = (document.getElementById("caldav-username") as HTMLInputElement).value
    const caldavPassword = (document.getElementById("caldav-password") as HTMLInputElement).value
    const writeBack = (document.getElementById("cal-write-back") as HTMLInputElement)?.checked ?? false
    const writeTicketDetails = (document.getElementById("cal-write-ticket-details") as HTMLInputElement)?.checked ?? true
    const manualPushEnabled = (document.getElementById("cal-manual-push") as HTMLInputElement)?.checked ?? true
    const intervalMs = Number((document.getElementById("cal-sync-interval") as HTMLSelectElement)?.value ?? "300000")
    const syncEnabledStr = enabledEntities.length > 0 ? "true" : "false"
    await saveSettings({
      calendar_entities: enabledEntities,
      calendar_entity: enabledEntities[0] ?? "",
      calendar_write_back: writeBack,
      calendar_write_ticket_details: writeTicketDetails,
      calendar_manual_push_enabled: manualPushEnabled,
      calendar_sync_interval_ms: String(intervalMs),
      calendar_sync_mode: globalMode,
      calendar_sync_modes: syncModes,
      ...(caldavUrl && !caldavUsername && !caldavPassword ? { caldav_url: caldavUrl } : {}),
      calendar_sync_enabled: syncEnabledStr,
    })
    const policy = {
      calendar_manual_push_enabled: manualPushEnabled,
      calendar_sync_enabled: syncEnabledStr,
      calendar_sync_mode: globalMode,
      calendar_write_back: writeBack,
      calendar_sync_interval_ms: String(intervalMs),
    }
    window.mSettings = {
      ...(window.mSettings ?? {}),
      ...policy,
      calendarManualPushVisible: shouldShowManualCalendarPush(policy),
    }
    window.dispatchEvent(new Event("meitheal:calendar-push-policy-changed"))
    if (caldavUrl && caldavUsername && caldavPassword) {
      await applySyncConfiguration("/api/integrations/calendar/caldav-credentials", "caldav_url", {
        action: "save", url: caldavUrl, username: caldavUsername, password: caldavPassword,
      })
    }
    await applySyncConfiguration("/api/integrations/calendar/sync", "calendar_sync_enabled", enabledEntities.length > 0
      ? { action: "enable", entity_id: enabledEntities[0], entities: enabledEntities, write_back: writeBack, write_ticket_details: writeTicketDetails, interval_ms: intervalMs, sync_mode: globalMode, sync_modes: syncModes }
      : { action: "disable" })
    const statusEl = document.getElementById("cal-status")
    if (statusEl) {
      statusEl.textContent = enabledEntities.length > 0 ? `${enabledEntities.length} syncing` : "Disabled"
      statusEl.className = enabledEntities.length > 0 ? "badge badge-active" : "badge badge-pending"
    }
    showToast("settings.calendar_saved")
    updateCalCountBadge()
    }, { loadingText: "Saving…", onError: showSettingsSaveError }))
  }

  // ───── Calendar Sync Now ─────
  const testCalBtn = document.getElementById("test-cal") as HTMLButtonElement
  if (testCalBtn) {
    pageLifecycle.on(testCalBtn, "click", withAsyncButton(testCalBtn, async () => {
    const resultEl = document.getElementById("cal-sync-result")
    try {
      const res = await fetch("/api/integrations/calendar/sync", {
        method: "POST", headers: settingsWriteHeaders("calendar_sync_enabled"),
        body: JSON.stringify({ action: "sync" }),
        signal: pageLifecycle.signal,
      })
      const data = (await res.json()) as { ok: boolean; message?: string; created?: number; updated?: number; total?: number }
      if (resultEl) resultEl.textContent = data.message ?? "Sync triggered"
      showToast(data.ok ? (data.message ?? "Calendar sync triggered") : "Calendar sync failed", data.ok ? "success" : "error")
      if (data.ok) {
        const lastSynced = document.getElementById("cal-last-synced")
        if (lastSynced) {
          const evtCount = data.total ?? 0
          lastSynced.textContent = `Last synced: ${new Date().toLocaleTimeString()} — ${evtCount} event${evtCount !== 1 ? "s" : ""}`
          lastSynced.style.color = "var(--text-muted)"
        }
      }
    } catch {
      if (resultEl) resultEl.textContent = "Sync failed"
      showToast("Calendar sync failed", "error")
    }
    setTimeout(() => { if (resultEl) resultEl.textContent = "" }, 5000)
    }, { loadingText: "Syncing…" }))
  }

  // ───── Todo Enable/Disable All ─────
  const todoEnableAllBtn = document.getElementById("todo-enable-all")
  if (todoEnableAllBtn) {
    pageLifecycle.on(todoEnableAllBtn, "click", () => {
    document.querySelectorAll<HTMLInputElement>("#todo-entities-container .todo-entity-toggle").forEach((cb) => {
      if (!cb.checked) { cb.checked = true; cb.closest(".cal-toggle-card")?.classList.add("cal-toggle-card--active") }
    })
    updateTodoCount()
    })
  }
  const todoDisableAllBtn = document.getElementById("todo-disable-all")
  if (todoDisableAllBtn) {
    pageLifecycle.on(todoDisableAllBtn, "click", () => {
    document.querySelectorAll<HTMLInputElement>("#todo-entities-container .todo-entity-toggle").forEach((cb) => {
      if (cb.checked) { cb.checked = false; cb.closest(".cal-toggle-card")?.classList.remove("cal-toggle-card--active") }
    })
    updateTodoCount()
    })
  }

  // ───── Todo manual add ─────
  const todoManualBtn = document.getElementById("todo-add-manual")
  if (todoManualBtn) {
    pageLifecycle.on(todoManualBtn, "click", () => {
    const input = document.getElementById("todo-entity-manual") as HTMLInputElement
    const entityId = input?.value?.trim()
    if (!entityId || !entityId.startsWith("todo.")) { showToast("Enter a valid entity ID (e.g. todo.shopping_list)", "error"); return }
    const container = document.getElementById("todo-entities-container")
    if (!container) return
    if (container.querySelector(`[data-entity="${CSS.escape(entityId)}"]`)) { showToast("Entity already in the list", "error"); return }
    const card = createEntityToggleCard({
      entityId,
      name: entityId,
      stateLabel: "manually added",
      checked: true,
      toggleClass: "todo-entity-toggle",
    })
    const todoToggle = card.querySelector<HTMLInputElement>(".todo-entity-toggle")
    todoToggle?.addEventListener("change", () => {
      card.classList.toggle("cal-toggle-card--active", todoToggle.checked)
      updateTodoCount()
    }, { signal: pageLifecycle.signal })
    card.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest(".toggle-label")) return
      if (todoToggle) {
        todoToggle.checked = !todoToggle.checked
        todoToggle.dispatchEvent(new Event("change", { bubbles: true }))
      }
    }, { signal: pageLifecycle.signal })
    container.appendChild(card)
    const noEntities = document.getElementById("todo-no-entities")
    if (noEntities) noEntities.style.display = "none"
    updateTodoCount()
    input.value = ""
    })
  }

  // ───── Todo toggle label ─────
  const todoEnabledCb = document.getElementById("todo-enabled")
  if (todoEnabledCb) {
    pageLifecycle.on(todoEnabledCb, "change", () => {
    const cb = todoEnabledCb as HTMLInputElement
    const label = document.getElementById("todo-enabled-label")
    if (label) label.textContent = cb.checked ? "On — syncing with HA" : "Off — sync disabled to save power"
    })
  }

  const saveTodoBtn = document.getElementById("save-todo") as HTMLButtonElement
  if (saveTodoBtn) {
    pageLifecycle.on(saveTodoBtn, "click", withAsyncButton(saveTodoBtn, async () => {
    const enabled = (document.getElementById("todo-enabled") as HTMLInputElement).checked
    const enabledEntities = Array.from(document.querySelectorAll<HTMLInputElement>("#todo-entities-container .todo-entity-toggle:checked")).map((cb) => cb.value)
    const direction = (document.getElementById("todo-sync-direction") as HTMLSelectElement).value
    if (enabled && enabledEntities.length === 0) { showToast("Enable at least one todo list, or disable sync", "error"); return }
    await saveSettings({
      todo_entities: enabledEntities,
      todo_entity: enabledEntities[0] || "",
      todo_sync_direction: direction,
      todo_sync_enabled: enabled,
    })
    await applySyncConfiguration("/api/todo/sync", "todo_sync_enabled", enabled && enabledEntities.length > 0
      ? { action: "enable", entity_id: enabledEntities[0], entities: enabledEntities, direction }
      : { action: "disable" })
    const statusEl = document.getElementById("todo-status")
    if (statusEl) {
      statusEl.textContent = enabled ? `${enabledEntities.length} syncing` : "Disabled"
      statusEl.className = enabled ? "badge badge-active" : "badge badge-pending"
    }
    showToast("settings.todo_saved")
    }, { loadingText: "Saving…", onError: showSettingsSaveError }))
  }

  const syncTodoBtn = document.getElementById("sync-todo") as HTMLButtonElement
  if (syncTodoBtn) {
    pageLifecycle.on(syncTodoBtn, "click", withAsyncButton(syncTodoBtn, async () => {
    const resultEl = document.getElementById("todo-sync-result")
    try {
      const enabledTodos = Array.from(document.querySelectorAll<HTMLInputElement>("#todo-entities-container .todo-entity-toggle:checked")).map((cb) => cb.value)
      const entity = enabledTodos[0] || undefined
      const res = await fetch("/api/todo/sync", {
        method: "POST", headers: settingsWriteHeaders("todo_sync_enabled"),
        body: JSON.stringify({ action: "sync", entity_id: entity || undefined }),
        signal: pageLifecycle.signal,
      })
      const data = (await res.json()) as { ok: boolean; synced?: number; errors?: number; message?: string; ha_connected?: boolean }
      const msg = data.message ?? (data.ok ? "Sync triggered" : "Sync failed")
      if (resultEl) resultEl.textContent = msg
      const isOk = data.ok && data.ha_connected !== false
      showToast(msg, isOk ? "success" : "error")
      if (data.ok) {
        const lastSynced = document.getElementById("todo-last-synced")
        if (lastSynced) lastSynced.textContent = `Last synced: ${new Date().toLocaleTimeString()}${data.synced ? ` — ${data.synced} item(s)` : ""}`
      }
    } catch {
      if (resultEl) resultEl.textContent = "Sync failed"
      showToast("Todo sync failed", "error")
    }
    setTimeout(() => { if (resultEl) resultEl.textContent = "" }, 5000)
    }, { loadingText: "Syncing…" }))
  }
}

// ───── Shared helpers ─────
function updateCalCountBadge() {
  const badge = document.getElementById("cal-count-badge")
  const toggles = document.querySelectorAll<HTMLInputElement>(".cal-entity-toggle")
  const total = toggles.length
  const enabled = Array.from(toggles).filter((t) => t.checked).length
  if (badge) {
    badge.textContent = `${enabled} of ${total} enabled`
    badge.style.color = enabled > 0 ? "var(--accent-text)" : "var(--text-muted)"
    badge.style.borderColor = enabled > 0 ? "color-mix(in srgb, var(--accent) 30%, transparent)" : "var(--border)"
  }
}
(window as unknown as Record<string, unknown>).__updateCalCount = updateCalCountBadge

function updateTodoCount() {
  const badge = document.getElementById("todo-count-badge")
  if (!badge) return
  const all = document.querySelectorAll<HTMLInputElement>("#todo-entities-container .todo-entity-toggle")
  const enabled = Array.from(all).filter((cb) => cb.checked).length
  badge.textContent = `${enabled} of ${all.length} enabled`
}
(window as unknown as Record<string, unknown>).__updateTodoCount = updateTodoCount

// ───── Calendar hydration (complete function) ─────
async function hydrateCalendarStatus(s: Record<string, unknown>) {
  const statusEl = document.getElementById("cal-status")
  const autoInfo = document.getElementById("cal-auto-info")
  const autoEntity = document.getElementById("cal-auto-entity")
  const entitiesList = document.getElementById("cal-entities-list")
  const entitiesContainer = document.getElementById("cal-entities-container")
  const lastSynced = document.getElementById("cal-last-synced")

  try {
    const res = await fetch("/api/integrations/calendar/status", { signal: pageLifecycle.signal })
    if (!res.ok) throw new Error("API error")
    const data = (await res.json()) as { ok: boolean; calendars?: { entity_id: string; friendly_name: string; state: string }[]; sync: { active: boolean; entityId: string; lastSyncAt: number | null; eventCount: number } }

    const calendars = data.calendars ?? []
    const sync = data.sync ?? { active: false, entityId: "", lastSyncAt: null, eventCount: 0 }

    if (statusEl) {
      if (sync.active) {
        statusEl.textContent = `${calendars.length} syncing`
        statusEl.className = "badge badge-active"
      } else if (calendars.length > 0) {
        statusEl.textContent = `${calendars.length} found`
        statusEl.className = "badge badge-active"
      } else {
        statusEl.textContent = "No calendars"
        statusEl.className = "badge badge-pending"
      }
    }

    if (sync.lastSyncAt && lastSynced) {
      const ts = new Date(sync.lastSyncAt).toLocaleTimeString()
      const evtCount = sync.eventCount || 0
      lastSynced.textContent = `Last synced: ${ts} — ${evtCount} event${evtCount !== 1 ? "s" : ""}`
      lastSynced.style.color = "var(--text-muted)"
    }

    if (sync.active && autoInfo) {
      autoInfo.style.display = "block"
      if (autoEntity && sync.entityId) autoEntity.textContent = sync.entityId
    }

    if (calendars.length > 0 && entitiesList && entitiesContainer) {
      entitiesList.style.display = "block"
      let savedEntities: string[] = []
      let savedSyncModes: Record<string, string> = {}
      let savedGlobalMode = "bidirectional"
      const raw = s.calendar_entities ?? s.calendar_entity ?? s.cal_entity
      if (Array.isArray(raw)) savedEntities = raw as string[]
      else if (typeof raw === "string") { try { const parsed = JSON.parse(raw); savedEntities = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [] } catch { savedEntities = raw ? [raw] : [] } }
      if (s.calendar_sync_modes) { try { const parsed = typeof s.calendar_sync_modes === "string" ? JSON.parse(s.calendar_sync_modes as string) : s.calendar_sync_modes; if (parsed && typeof parsed === "object") savedSyncModes = parsed as Record<string, string> } catch { /* invalid */ } }
      if (typeof s.calendar_sync_mode === "string") savedGlobalMode = s.calendar_sync_mode

      const dirSelect = document.getElementById("cal-sync-direction") as HTMLSelectElement | null
      if (dirSelect && savedGlobalMode) dirSelect.value = savedGlobalMode

      entitiesContainer.replaceChildren(
        ...calendars.map((c) => {
          const isEnabled = savedEntities.includes(c.entity_id)
          return createEntityToggleCard({
            entityId: c.entity_id,
            name: c.friendly_name,
            stateLabel: c.state === "off" ? "no active event" : c.state,
            checked: isEnabled,
            toggleClass: "cal-entity-toggle",
            direction: { selected: savedSyncModes[c.entity_id] ?? savedGlobalMode, hidden: !isEnabled },
          })
        }),
      )

      // Wire toggle cards
      entitiesContainer.querySelectorAll<HTMLInputElement>(".cal-entity-toggle").forEach((cb) => {
        cb.addEventListener("change", () => {
          const card = cb.closest(".cal-toggle-card")
          if (card) {
            card.classList.toggle("cal-toggle-card--active", cb.checked)
            const dirDiv = card.querySelector<HTMLElement>(".cal-toggle-card__direction")
            if (dirDiv) dirDiv.style.display = cb.checked ? "" : "none"
          }
          updateCalCountBadge()
        })
      })
      entitiesContainer.querySelectorAll<HTMLSelectElement>(".cal-direction-select").forEach((sel) => {
        sel.addEventListener("click", (e) => e.stopPropagation())
        sel.addEventListener("mousedown", (e) => e.stopPropagation())
      })
      entitiesContainer.querySelectorAll<HTMLElement>(".cal-toggle-card").forEach((card) => {
        card.addEventListener("click", (e) => {
          const target = e.target as HTMLElement
          if (target.closest(".toggle-label") || target.closest(".cal-direction-select")) return
          const cb = card.querySelector<HTMLInputElement>(".cal-entity-toggle")
          if (cb) { cb.checked = !cb.checked; cb.dispatchEvent(new Event("change", { bubbles: true })) }
        })
        card.style.cursor = "pointer"
      })

      // Enable/Disable All
      document.getElementById("cal-enable-all")?.addEventListener("click", () => {
        entitiesContainer.querySelectorAll<HTMLInputElement>(".cal-entity-toggle").forEach((cb) => {
          cb.checked = true
          const card = cb.closest(".cal-toggle-card")
          card?.classList.add("cal-toggle-card--active")
          const dirDiv = card?.querySelector<HTMLElement>(".cal-toggle-card__direction")
          if (dirDiv) dirDiv.style.display = ""
        })
        updateCalCountBadge()
      })
      document.getElementById("cal-disable-all")?.addEventListener("click", () => {
        entitiesContainer.querySelectorAll<HTMLInputElement>(".cal-entity-toggle").forEach((cb) => {
          cb.checked = false
          const card = cb.closest(".cal-toggle-card")
          card?.classList.remove("cal-toggle-card--active")
          const dirDiv = card?.querySelector<HTMLElement>(".cal-toggle-card__direction")
          if (dirDiv) dirDiv.style.display = "none"
        })
        updateCalCountBadge()
      })

      // Global direction cascade
      const globalDirSel = document.getElementById("cal-sync-direction") as HTMLSelectElement | null
      if (globalDirSel) {
        let previousGlobal = globalDirSel.value
        globalDirSel.addEventListener("change", () => {
          const newGlobal = globalDirSel.value
          entitiesContainer.querySelectorAll<HTMLSelectElement>(".cal-direction-select").forEach((sel) => {
            if (sel.value === previousGlobal) sel.value = newGlobal
          })
          previousGlobal = newGlobal
        })
      }

      if (savedEntities.length === 0 && calendars.length === 1) {
        const firstToggle = entitiesContainer.querySelector<HTMLInputElement>(".cal-entity-toggle")
        if (firstToggle) { firstToggle.checked = true; firstToggle.closest(".cal-toggle-card")?.classList.add("cal-toggle-card--active") }
      }
      updateCalCountBadge()
    } else {
      if (entitiesList) {
        entitiesList.style.display = "block"
        const emptyState = document.getElementById("cal-no-entities")
        if (emptyState) emptyState.style.display = "flex"
      }
    }
  } catch {
    if (statusEl) { statusEl.textContent = "Unavailable"; statusEl.className = "badge badge-pending" }
  }
}

// ───── Todo hydration ─────
async function hydrateTodoStatus(settings: Record<string, unknown>) {
  const statusEl = document.getElementById("todo-status")
  const autoInfo = document.getElementById("todo-auto-info")
  const autoEntities = document.getElementById("todo-auto-entities")
  const entitiesList = document.getElementById("todo-entities-list")
  const entitiesContainer = document.getElementById("todo-entities-container")
  const noEntities = document.getElementById("todo-no-entities")
  const enabledCb = document.getElementById("todo-enabled") as HTMLInputElement | null
  const enabledLabel = document.getElementById("todo-enabled-label")

  try {
    const res = await fetch("/api/todo", { signal: pageLifecycle.signal })
    if (!res.ok) throw new Error("API error")
    const data = (await res.json()) as { ok: boolean; entities?: { entity_id: string; friendly_name: string; state: string; sync: { active: boolean; direction: string; lastSyncAt: number | null; itemCount: number } | null }[] }
    const entities = data.entities ?? []
    let selection: unknown = settings.todo_entities
    if (typeof selection === "string") {
      try { selection = JSON.parse(selection) } catch { /* legacy single entity ID */ }
    }
    selection ??= settings.todo_entity
    const savedEnabled = Array.isArray(selection) ? selection : typeof selection === "string" ? [selection] : []

    if (entities.length > 0 && autoInfo && autoEntities) {
      autoInfo.style.display = "block"
      const nodes: Node[] = []
      entities.forEach((e, idx) => {
        if (idx > 0) nodes.push(document.createElement("br"))
        const code = document.createElement("code")
        code.style.fontFamily = "'JetBrains Mono', monospace"
        code.style.fontSize = "11px"
        code.textContent = e.entity_id
        nodes.push(document.createTextNode("• "), code, document.createTextNode(` (${e.friendly_name})`))
      })
      autoEntities.replaceChildren(...nodes)
    }

    if (entitiesList && entitiesContainer) {
      entitiesList.style.display = "block"
      if (entities.length === 0) {
        entitiesContainer.replaceChildren()
        if (noEntities) noEntities.style.display = "flex"
      } else {
        if (noEntities) noEntities.style.display = "none"
        const autoSelect = selection == null
        entitiesContainer.replaceChildren(
          ...entities.map((e) =>
            createEntityToggleCard({
              entityId: e.entity_id,
              name: e.friendly_name,
              stateLabel: e.sync?.active ? `${e.state} · syncing${e.sync.itemCount ? ` · ${e.sync.itemCount} items` : ""}` : e.state,
              checked: autoSelect ? e === entities[0] : savedEnabled.includes(e.entity_id),
              toggleClass: "todo-entity-toggle",
            }),
          ),
        )

        entitiesContainer.querySelectorAll<HTMLInputElement>(".todo-entity-toggle").forEach((cb) => {
          cb.addEventListener("change", () => { cb.closest(".cal-toggle-card")?.classList.toggle("cal-toggle-card--active", cb.checked); updateTodoCount() })
        })
        entitiesContainer.querySelectorAll<HTMLElement>(".cal-toggle-card").forEach((card) => {
          card.addEventListener("click", (e) => {
            if ((e.target as HTMLElement).closest(".toggle-label")) return
            const cb = card.querySelector<HTMLInputElement>(".todo-entity-toggle")
            if (cb) { cb.checked = !cb.checked; cb.dispatchEvent(new Event("change", { bubbles: true })) }
          })
        })
        if (autoSelect && settings.todo_sync_enabled !== false && settings.todo_sync_enabled !== "false" && enabledCb && !enabledCb.checked) {
          enabledCb.checked = true
          if (enabledLabel) enabledLabel.textContent = "On — syncing with HA"
        }
      }
      updateTodoCount()
    }
    const anyActive = entities.some((e) => e.sync?.active)
    if (statusEl) {
      if (anyActive) { statusEl.textContent = "Active"; statusEl.className = "badge badge-active" }
      else if (entities.length > 0) { statusEl.textContent = `${entities.length} found`; statusEl.className = "badge badge-active" }
      else { statusEl.textContent = "No lists"; statusEl.className = "badge badge-pending" }
    }
  } catch {
    if (statusEl) { statusEl.textContent = "Unavailable"; statusEl.className = "badge badge-pending" }
  }
}

/** Restore calendar/todo related settings */
export function restoreCalendarTodoSettings(s: Record<string, unknown>): void {
  // CalDAV credentials
  if (s.caldav_url) {
    (document.getElementById("caldav-url") as HTMLInputElement).value = String(s.caldav_url)
    ;(async () => {
      try {
        const credRes = await fetch("/api/integrations/calendar/caldav-credentials", { signal: pageLifecycle.signal })
        if (credRes.ok) {
          const credData = await credRes.json()
          if (credData.configured) {
            const indicator = document.getElementById("caldav-active-indicator")
            if (indicator) indicator.style.display = "block"
            if (credData.username) (document.getElementById("caldav-username") as HTMLInputElement).value = credData.username
          }
        }
      } catch { /* optional */ }
    })()
  }
  if (s.calendar_write_back) {
    const wb = document.getElementById("cal-write-back") as HTMLInputElement | null
    if (wb) wb.checked = s.calendar_write_back === true || s.calendar_write_back === "true"
  }
  const wtd = document.getElementById("cal-write-ticket-details") as HTMLInputElement | null
  if (wtd) {
    wtd.checked = s.calendar_write_ticket_details === undefined
      ? true
      : s.calendar_write_ticket_details !== false && s.calendar_write_ticket_details !== "false"
  }
  if (s.calendar_sync_interval_ms !== undefined && s.calendar_sync_interval_ms !== null) {
    const intervalSel = document.getElementById("cal-sync-interval") as HTMLSelectElement | null
    if (intervalSel) intervalSel.value = String(s.calendar_sync_interval_ms)
  }
  const manualPushEl = document.getElementById("cal-manual-push") as HTMLInputElement | null
  const manualPushHint = document.getElementById("cal-manual-push-hint")
  if (manualPushEl) {
    manualPushEl.checked = s.calendar_manual_push_enabled === undefined
      ? true
      : s.calendar_manual_push_enabled !== false && s.calendar_manual_push_enabled !== "false"
  }
  const refreshManualPushHint = () => {
    if (!manualPushHint) return
    const enabledCount = document.querySelectorAll<HTMLInputElement>(".cal-entity-toggle:checked").length
    const state = describeManualCalendarPushState({
      calendar_manual_push_enabled: manualPushEl?.checked ?? true,
      calendar_sync_enabled: enabledCount > 0 || s.calendar_sync_enabled === "true" || s.calendar_sync_enabled === true ? "true" : "false",
      calendar_sync_mode: (document.getElementById("cal-sync-direction") as HTMLSelectElement | null)?.value ?? String(s.calendar_sync_mode ?? "bidirectional"),
      calendar_write_back: (document.getElementById("cal-write-back") as HTMLInputElement | null)?.checked ?? false,
      calendar_sync_interval_ms: (document.getElementById("cal-sync-interval") as HTMLSelectElement | null)?.value ?? String(s.calendar_sync_interval_ms ?? "300000"),
    })
    manualPushHint.textContent = state.reason
  }
  refreshManualPushHint()
  for (const id of ["cal-manual-push", "cal-sync-direction", "cal-write-back", "cal-sync-interval"]) {
    const el = document.getElementById(id)
    if (el) pageLifecycle.on(el, "change", refreshManualPushHint)
  }

  // Todo entity restore
  if (s.todo_entity) {
    const todoSelect = document.getElementById("todo-entity") as HTMLSelectElement | null
    const todoManual = document.getElementById("todo-entity-manual") as HTMLInputElement | null
    if (todoSelect) todoSelect.value = String(s.todo_entity)
    if (todoManual) todoManual.value = String(s.todo_entity)
  }
  if (s.todo_sync_direction) (document.getElementById("todo-sync-direction") as HTMLSelectElement).value = String(s.todo_sync_direction)
  if (s.todo_sync_enabled === true || s.todo_sync_enabled === "true") {
    (document.getElementById("todo-enabled") as HTMLInputElement).checked = true
    const label = document.getElementById("todo-enabled-label")
    if (label) label.textContent = "On — syncing with HA"
    const el = document.getElementById("todo-status")
    if (el) { el.textContent = "Active"; el.className = "badge badge-active" }
    window.expandIntegrationCard?.("integration-todo-body")
  }
  void hydrateCalendarStatus(s)
  void hydrateTodoStatus(s)

}
